package core

import (
	"fmt"
	"os/exec"
	"time"
)

// ScrcpyOptions configures a native host scrcpy screen mirroring session.
// Note that scrcpy renders inside a desktop OS window on the host machine
// running adb-deck; it inherits that process's desktop/Window Station.
type ScrcpyOptions struct {
	Serial        string `json:"serial"`            // Target ADB device serial (required)
	MaxSize       int    `json:"maxSize,omitempty"` // Max video dimension in pixels (0 = native resolution)
	BitRate       string `json:"bitRate,omitempty"` // Target video bitrate (e.g. "8M", "16M", "24M")
	StayAwake     bool   `json:"stayAwake"`         // Passes --stay-awake while plugged/connected
	TurnScreenOff bool   `json:"turnScreenOff"`     // Passes --turn-screen-off to keep physical display dark
	AlwaysOnTop   bool   `json:"alwaysOnTop"`       // Passes --always-on-top to the host scrcpy window
	NoAudio       bool   `json:"noAudio"`           // Passes --no-audio to mute audio forwarding
}

// ScrcpySession represents a running native scrcpy child process for a device.
type ScrcpySession struct {
	Serial    string        `json:"serial"`    // Target device serial
	PID       int           `json:"pid"`       // OS process ID of the spawned scrcpy process
	StartedAt time.Time     `json:"startedAt"` // Timestamp when scrcpy started
	Options   ScrcpyOptions `json:"options"`   // Launch options applied to this session

	cmd *exec.Cmd
}

// StartScrcpy launches scrcpy for the target device and tracks the session.
func (e *Engine) StartScrcpy(opts ScrcpyOptions) (*ScrcpySession, error) {
	if opts.Serial == "" {
		return nil, fmt.Errorf("device serial is required")
	}

	e.mu.Lock()
	if existing, ok := e.scrcpyProcs[opts.Serial]; ok {
		e.mu.Unlock()
		return existing, nil
	}
	e.mu.Unlock()

	args := []string{"-s", opts.Serial, "--window-title", "ADB Deck :: " + opts.Serial}
	if opts.MaxSize > 0 {
		args = append(args, fmt.Sprintf("--max-size=%d", opts.MaxSize))
	}
	if opts.BitRate != "" {
		args = append(args, "--video-bit-rate="+opts.BitRate)
	}
	if opts.StayAwake {
		args = append(args, "--stay-awake")
	}
	if opts.TurnScreenOff {
		args = append(args, "--turn-screen-off")
	}
	if opts.AlwaysOnTop {
		args = append(args, "--always-on-top")
	}
	if opts.NoAudio {
		args = append(args, "--no-audio")
	}

	cmd := exec.Command(e.ScrcpyPath, args...)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start scrcpy: %w", err)
	}

	session := &ScrcpySession{
		Serial:    opts.Serial,
		PID:       cmd.Process.Pid,
		StartedAt: time.Now(),
		Options:   opts,
		cmd:       cmd,
	}

	e.mu.Lock()
	e.scrcpyProcs[opts.Serial] = session
	e.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		e.mu.Lock()
		if cur, ok := e.scrcpyProcs[opts.Serial]; ok && cur.PID == session.PID {
			delete(e.scrcpyProcs, opts.Serial)
		}
		e.mu.Unlock()
	}()

	return session, nil
}

// StopScrcpy terminates an active scrcpy session for the given serial.
func (e *Engine) StopScrcpy(serial string) error {
	e.mu.Lock()
	session, ok := e.scrcpyProcs[serial]
	if ok {
		delete(e.scrcpyProcs, serial)
	}
	e.mu.Unlock()

	if !ok || session.cmd == nil || session.cmd.Process == nil {
		return fmt.Errorf("no active scrcpy session for %s", serial)
	}
	return session.cmd.Process.Kill()
}

// ActiveScrcpySessions returns all currently active scrcpy sessions.
func (e *Engine) ActiveScrcpySessions() []ScrcpySession {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]ScrcpySession, 0, len(e.scrcpyProcs))
	for _, s := range e.scrcpyProcs {
		cp := *s
		cp.cmd = nil
		out = append(out, cp)
	}
	return out
}
