package core

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Device represents an attached or wirelessly connected Android device
// parsed from `adb devices -l` and enriched with Android version, battery
// percentage, and active scrcpy mirror state.
type Device struct {
	Serial         string `json:"serial"`                   // ADB serial or mDNS endpoint (e.g. adb-..._adb-tls-connect._tcp)
	State          string `json:"state"`                    // ADB device state: "device", "offline", or "unauthorized"
	Transport      string `json:"transport"`                // Connection transport: "usb" or "wireless"
	Model          string `json:"model"`                    // Human-readable model name (falls back to Serial if unavailable)
	Product        string `json:"product"`                  // Build product identifier from `adb devices -l`
	DeviceName     string `json:"deviceName"`               // Device codename from `adb devices -l`
	AndroidVersion string `json:"androidVersion,omitempty"` // ro.build.version.release when State == "device"
	Battery        string `json:"battery,omitempty"`        // Percentage string (e.g. "84%") from dumpsys battery
	Mirroring      bool   `json:"mirroring"`                // True while a tracked scrcpy child process is active
}

// Engine is the shared ADB/scrcpy core used by both the TUI and the WebSocket bridge.
// It satisfies [ADBController] and coordinates child processes safely across goroutines.
type Engine struct {
	ADBPath    string // Resolved path or binary name for the adb CLI
	ScrcpyPath string // Resolved path or binary name for the scrcpy CLI

	mu            sync.RWMutex
	scrcpyProcs   map[string]*ScrcpySession // Keyed by Device.Serial
	activePairing *PairingSession           // Most recent QR pairing session (may be waiting/paired/cancelled)
}

// NewEngine discovers adb and scrcpy binaries and initializes the shared core.
func NewEngine() *Engine {
	adbPath, _ := exec.LookPath("adb")
	if adbPath == "" {
		adbPath = "adb"
	}
	scrcpyPath, _ := exec.LookPath("scrcpy")
	if scrcpyPath == "" {
		scrcpyPath = "scrcpy"
	}
	return &Engine{
		ADBPath:     adbPath,
		ScrcpyPath:  scrcpyPath,
		scrcpyProcs: make(map[string]*ScrcpySession),
	}
}

// StatusSummary returns binary paths and basic tool availability.
func (e *Engine) StatusSummary() map[string]any {
	adbOK := false
	if _, err := exec.LookPath(e.ADBPath); err == nil {
		adbOK = true
	}
	scrcpyOK := false
	if _, err := exec.LookPath(e.ScrcpyPath); err == nil {
		scrcpyOK = true
	}
	return map[string]any{
		"adbPath":    e.ADBPath,
		"adbReady":   adbOK,
		"scrcpyPath": e.ScrcpyPath,
		"scrcpyReady": scrcpyOK,
	}
}

// RunADB executes an adb subcommand with a timeout and returns trimmed combined output.
func (e *Engine) RunADB(ctx context.Context, args ...string) (string, error) {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, e.ADBPath, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

// ListDevices returns all devices seen by `adb devices -l`, enriched with basic metadata.
func (e *Engine) ListDevices(ctx context.Context) ([]Device, error) {
	out, err := e.RunADB(ctx, "devices", "-l")
	if err != nil {
		return nil, fmt.Errorf("adb devices failed: %w (%s)", err, out)
	}

	e.mu.RLock()
	activeMirror := make(map[string]bool, len(e.scrcpyProcs))
	for serial := range e.scrcpyProcs {
		activeMirror[serial] = true
	}
	e.mu.RUnlock()

	var devices []Device
	lines := strings.Split(out, "\n")
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(line, "*") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		d := Device{
			Serial:    fields[0],
			State:     fields[1],
			Transport: "usb",
			Mirroring: activeMirror[fields[0]],
		}
		if strings.Contains(d.Serial, ":") || strings.Contains(d.Serial, "_adb-tls-") {
			d.Transport = "wireless"
		}
		for _, kv := range fields[2:] {
			parts := strings.SplitN(kv, ":", 2)
			if len(parts) != 2 {
				continue
			}
			switch parts[0] {
			case "model":
				d.Model = strings.ReplaceAll(parts[1], "_", " ")
			case "product":
				d.Product = parts[1]
			case "device":
				d.DeviceName = parts[1]
			}
		}
		if d.Model == "" {
			d.Model = d.Serial
		}
		if d.State == "device" {
			propCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			if ver, err := e.RunADB(propCtx, "-s", d.Serial, "shell", "getprop", "ro.build.version.release"); err == nil && ver != "" {
				d.AndroidVersion = ver
			}
			if bat, err := e.RunADB(propCtx, "-s", d.Serial, "shell", "dumpsys", "battery"); err == nil {
				if m := batteryLevelRe.FindStringSubmatch(bat); len(m) == 2 {
					d.Battery = m[1] + "%"
				}
			}
			cancel()
		}
		devices = append(devices, d)
	}
	return devices, nil
}

var batteryLevelRe = regexp.MustCompile(`(?m)^\s*level:\s*(\d+)`)
var ipRouteRe = regexp.MustCompile(`src\s+(\d+\.\d+\.\d+\.\d+)`)

// SwitchToWiFi performs a one-click USB-to-Wi-Fi handoff on port 5555.
func (e *Engine) SwitchToWiFi(ctx context.Context, serial string) (string, error) {
	if _, err := e.RunADB(ctx, "-s", serial, "tcpip", "5555"); err != nil {
		return "", fmt.Errorf("failed to enable tcpip mode: %w", err)
	}
	time.Sleep(800 * time.Millisecond)
	routeOut, err := e.RunADB(ctx, "-s", serial, "shell", "ip", "route")
	if err != nil {
		return "", fmt.Errorf("could not read device IP: %w", err)
	}
	m := ipRouteRe.FindStringSubmatch(routeOut)
	if len(m) < 2 {
		return "", fmt.Errorf("device Wi-Fi IP not found in route table")
	}
	target := m[1] + ":5555"
	out, err := e.RunADB(ctx, "connect", target)
	if err != nil {
		return "", fmt.Errorf("adb connect %s failed: %w (%s)", target, err, out)
	}
	return fmt.Sprintf("Connected wirelessly to %s (%s)", target, out), nil
}

// ConnectWireless connects to a known IP:port over ADB.
func (e *Engine) ConnectWireless(ctx context.Context, addr string) (string, error) {
	return e.RunADB(ctx, "connect", strings.TrimSpace(addr))
}

// Disconnect disconnects a wireless ADB device.
func (e *Engine) Disconnect(ctx context.Context, serial string) (string, error) {
	return e.RunADB(ctx, "disconnect", strings.TrimSpace(serial))
}
