// Command adb-deck runs the ADB Deck local HTTP/WebSocket bridge and embedded
// web dashboard, or launches the interactive terminal UI when --tui is passed.
//
// Usage:
//
//	adb-deck [--host 127.0.0.1] [--lan] [--port 8787] [--token ...] [--no-auth]
//	         [--allowed-origins ...] [--web-dir ./web] [--tui]
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"adb-deck/bridge"
	"adb-deck/core"
	"adb-deck/tui"
	"adb-deck/web"
)

func generateAuthToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("Failed to generate random auth token: %v", err)
	}
	return hex.EncodeToString(b)
}

func parseAllowedOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	return origins
}

func main() {
	modeTUI := flag.Bool("tui", false, "Launch the interactive Bubble Tea terminal UI")
	host := flag.String("host", "127.0.0.1", "Bind host for the WebSocket bridge & web dashboard")
	lan := flag.Bool("lan", false, "Bind to 0.0.0.0 for LAN access (overrides --host)")
	port := flag.Int("port", 8787, "Port for the WebSocket bridge & web dashboard")
	token := flag.String("token", "", "Auth token for API & WebSocket access (auto-generated if empty unless --no-auth)")
	noAuth := flag.Bool("no-auth", false, "Disable token authentication (not recommended)")
	allowedOrigins := flag.String("allowed-origins", "", "Comma-separated extra allowed origins (e.g. https://adbdeck.example.com)")
	webDir := flag.String("web-dir", "", "Optional local directory to serve web assets live from disk")
	flag.Parse()

	engine := core.NewEngine()

	if *modeTUI {
		if err := tui.Run(engine); err != nil {
			log.Fatalf("TUI error: %v", err)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var webFS fs.FS = web.Assets
	if *webDir != "" {
		webFS = os.DirFS(*webDir)
		log.Printf("Serving live web assets from disk: %s", *webDir)
	}

	bindHost := *host
	if *lan {
		bindHost = "0.0.0.0"
	}

	authToken := strings.TrimSpace(*token)
	if *noAuth {
		authToken = ""
	} else if authToken == "" {
		authToken = generateAuthToken()
	}

	sec := bridge.SecurityConfig{
		AuthToken:      authToken,
		AllowedOrigins: parseAllowedOrigins(*allowedOrigins),
	}

	srv := bridge.NewServer(engine, webFS, bindHost, *port, sec)
	if err := srv.Start(ctx); err != nil {
		log.Fatalf("Bridge server error: %v", err)
	}
}
