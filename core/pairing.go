package core

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// MDNSService represents a discovered ADB mDNS endpoint returned by `adb mdns services`.
type MDNSService struct {
	Name    string `json:"name"`    // Instance name (e.g. studio-XXXXXXXX or adb-<serial>-...)
	Type    string `json:"type"`    // Service type: _adb-tls-pairing._tcp or _adb-tls-connect._tcp
	Address string `json:"address"` // Advertised IP:port endpoint
}

// PairingSession tracks an active Android 11+ QR Wireless Debugging pairing flow.
// QR payloads follow Android's `WIFI:T:ADB;S:<serviceName>;P:<password>;;` format.
type PairingSession struct {
	ServiceName  string    `json:"serviceName"`          // Ephemeral mDNS pairing service name
	Password     string    `json:"password"`             // Ephemeral 8-character pairing PIN
	Payload      string    `json:"payload"`              // Raw QR payload string
	QRText       string    `json:"qrText"`               // ASCII/UTF-8 QR block rendering for TUI display
	QRPNGDataURL string    `json:"qrPngDataUrl"`         // Base64 PNG data URI for web dashboard display
	Status       string    `json:"status"`               // Lifecycle state: "waiting", "paired", "error", or "cancelled"
	Message      string    `json:"message"`              // Human-readable status or error message
	PairedAddr   string    `json:"pairedAddr,omitempty"` // Paired IP:port once Status == "paired"
	CreatedAt    time.Time `json:"createdAt"`            // Session creation timestamp

	cancel context.CancelFunc
}

func randomAlphaNum(n int) string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, n)
	for i := range b {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[idx.Int64()]
	}
	return string(b)
}

// DiscoverMDNS lists active `_adb-tls-pairing._tcp` and `_adb-tls-connect._tcp` services.
func (e *Engine) DiscoverMDNS(ctx context.Context) ([]MDNSService, error) {
	out, err := e.RunADB(ctx, "mdns", "services")
	if err != nil {
		return nil, err
	}
	var services []MDNSService
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "List of") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 3 {
			services = append(services, MDNSService{
				Name:    fields[0],
				Type:    fields[1],
				Address: fields[2],
			})
		}
	}
	return services, nil
}

// StartQRPairing creates a fresh Android 11+ Wireless Debugging QR session and
// watches mDNS in the background to auto-pair the moment the user scans it.
func (e *Engine) StartQRPairing(parentCtx context.Context) (*PairingSession, error) {
	serviceName := "studio-" + randomAlphaNum(8)
	password := randomAlphaNum(8)
	payload := fmt.Sprintf("WIFI:T:ADB;S:%s;P:%s;;", serviceName, password)

	qr, err := qrcode.New(payload, qrcode.Medium)
	if err != nil {
		return nil, fmt.Errorf("failed to generate QR code: %w", err)
	}
	pngBytes, err := qr.PNG(280)
	if err != nil {
		return nil, fmt.Errorf("failed to encode QR PNG: %w", err)
	}

	ctx, cancel := context.WithTimeout(parentCtx, 3*time.Minute)
	session := &PairingSession{
		ServiceName:  serviceName,
		Password:     password,
		Payload:      payload,
		QRText:       qr.ToSmallString(false),
		QRPNGDataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes),
		Status:       "waiting",
		Message:      "On your phone: Developer options -> Wireless debugging -> Pair device with QR code",
		CreatedAt:    time.Now(),
		cancel:       cancel,
	}

	e.mu.Lock()
	if e.activePairing != nil && e.activePairing.cancel != nil {
		e.activePairing.cancel()
	}
	e.activePairing = session
	e.mu.Unlock()

	go e.watchQRPairing(ctx, session)
	return session, nil
}

func (e *Engine) watchQRPairing(ctx context.Context, session *PairingSession) {
	ticker := time.NewTicker(1200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			e.mu.Lock()
			if session.Status == "waiting" {
				session.Status = "cancelled"
				session.Message = "Pairing session timed out. Generate a fresh QR code to try again."
			}
			e.mu.Unlock()
			return
		case <-ticker.C:
			services, err := e.DiscoverMDNS(ctx)
			if err != nil {
				continue
			}
			for _, svc := range services {
				if strings.Contains(svc.Type, "_adb-tls-pairing") && svc.Name == session.ServiceName {
					out, pairErr := e.RunADB(ctx, "pair", svc.Address, session.Password)
					e.mu.Lock()
					if pairErr != nil {
						session.Status = "error"
						session.Message = fmt.Sprintf("Pairing failed (%s): %s", svc.Address, out)
					} else {
						session.Status = "paired"
						session.PairedAddr = svc.Address
						session.Message = fmt.Sprintf("Paired with %s! %s", svc.Address, out)
					}
					e.mu.Unlock()
					return
				}
			}
		}
	}
}

// GetPairingSession returns a snapshot of the active QR pairing session, if any.
func (e *Engine) GetPairingSession() *PairingSession {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.activePairing == nil {
		return nil
	}
	cp := *e.activePairing
	cp.cancel = nil
	return &cp
}

// PairWithCode pairs directly using a phone's IP:port and 6-digit pairing code.
func (e *Engine) PairWithCode(ctx context.Context, hostPort, code string) (string, error) {
	out, err := e.RunADB(ctx, "pair", strings.TrimSpace(hostPort), strings.TrimSpace(code))
	if err != nil {
		return out, fmt.Errorf("adb pair failed: %w (%s)", err, out)
	}
	return out, nil
}
