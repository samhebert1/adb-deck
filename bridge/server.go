package bridge

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"adb-deck/core"

	"github.com/gorilla/websocket"
)

// Version is the bridge protocol/server version reported by /api/ping.
const Version = "0.2.0"

// SecurityConfig controls bearer token authentication and Origin allowlist enforcement.
type SecurityConfig struct {
	AuthToken      string   // Empty disables bearer auth (only when --no-auth is explicitly set)
	AllowedOrigins []string // Additional allowed CORS / WebSocket origins (e.g. https://adbdeck.web.app)
}

// Server is the WebSocket + HTTP bridge that connects browser clients to the shared ADB core.
type Server struct {
	Engine         *core.Engine // Shared ADB/scrcpy engine backing REST and WebSocket endpoints
	WebFS          fs.FS        // Static web UI filesystem (embedded web.Assets or os.DirFS)
	Host           string       // Bind interface address (e.g. 127.0.0.1 or 0.0.0.0)
	Port           int          // TCP listen port
	AuthToken      string       // Required bearer/query token when non-empty
	AllowedOrigins []string     // Normalized extra allowed origins

	upgrader websocket.Upgrader
	mu       sync.Mutex
	clients  map[*websocket.Conn]bool
}

// NewServer creates a new bridge server wrapping the shared ADB engine.
func NewServer(engine *core.Engine, webFS fs.FS, host string, port int, sec SecurityConfig) *Server {
	origins := make([]string, 0, len(sec.AllowedOrigins))
	for _, o := range sec.AllowedOrigins {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	s := &Server{
		Engine:         engine,
		WebFS:          webFS,
		Host:           host,
		Port:           port,
		AuthToken:      sec.AuthToken,
		AllowedOrigins: origins,
		clients:        make(map[*websocket.Conn]bool),
	}
	s.upgrader = websocket.Upgrader{
		CheckOrigin: s.checkOrigin,
	}
	return s
}

// LocalIPs returns non-loopback IPv4 addresses for LAN access display.
func LocalIPs() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil || v4[0] == 169 && v4[1] == 254 {
				continue
			}
			ips = append(ips, v4.String())
		}
	}
	return ips
}

// Handler builds and returns the configured HTTP handler with origin and auth middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// WebSocket live hub (Origin + token auth)
	mux.HandleFunc("/ws", s.withAuth(s.handleWS))

	// Unauthenticated discovery endpoint (still enforces Origin allowlist)
	mux.HandleFunc("/api/ping", s.withOriginCheck(s.handlePing))

	// Authenticated REST API routes
	mux.HandleFunc("/api/status", s.withAuth(s.handleStatus))
	mux.HandleFunc("/api/devices", s.withAuth(s.handleDevices))
	mux.HandleFunc("/api/devices/wifi", s.withAuth(s.handleSwitchWiFi))
	mux.HandleFunc("/api/devices/connect", s.withAuth(s.handleConnect))
	mux.HandleFunc("/api/devices/disconnect", s.withAuth(s.handleDisconnect))
	mux.HandleFunc("/api/pairing/qr", s.withAuth(s.handleStartQR))
	mux.HandleFunc("/api/pairing/status", s.withAuth(s.handlePairingStatus))
	mux.HandleFunc("/api/pairing/code", s.withAuth(s.handlePairCode))
	mux.HandleFunc("/api/mdns", s.withAuth(s.handleMDNS))
	mux.HandleFunc("/api/apk/list", s.withAuth(s.handleAPKList))
	mux.HandleFunc("/api/apk/install", s.withAuth(s.handleAPKInstall))
	mux.HandleFunc("/api/apk/action", s.withAuth(s.handleAPKAction))
	mux.HandleFunc("/api/apk/pull", s.withAuth(s.handleAPKPull))
	mux.HandleFunc("/api/scrcpy/start", s.withAuth(s.handleScrcpyStart))
	mux.HandleFunc("/api/scrcpy/stop", s.withAuth(s.handleScrcpyStop))
	mux.HandleFunc("/api/scrcpy/sessions", s.withAuth(s.handleScrcpySessions))

	// Static Web UI (public so the frontend loads and can read ?token= or prompt)
	if s.WebFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.WebFS)))
	}

	return mux
}

// Start launches the HTTP + WebSocket bridge and blocks until the server exits.
func (s *Server) Start(ctx context.Context) error {
	// Start periodic state broadcaster for connected WebSocket clients
	go s.broadcastLoop(ctx)

	addr := fmt.Sprintf("%s:%d", s.Host, s.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("ADB Deck Bridge listening on http://%s", addr)
	if s.AuthToken != "" {
		log.Printf("Auth Token: %s", s.AuthToken)
		if s.Host == "0.0.0.0" {
			log.Printf("Local URL:  http://127.0.0.1:%d/?token=%s", s.Port, s.AuthToken)
			for _, ip := range LocalIPs() {
				log.Printf("LAN URL:    http://%s:%d/?token=%s", ip, s.Port, s.AuthToken)
			}
		} else {
			log.Printf("Local URL:  http://%s:%d/?token=%s", s.Host, s.Port, s.AuthToken)
		}
	} else {
		log.Printf("WARNING: Token authentication is disabled (--no-auth)")
		if s.Host == "0.0.0.0" {
			log.Printf("Local URL:  http://127.0.0.1:%d/", s.Port)
			for _, ip := range LocalIPs() {
				log.Printf("LAN URL:    http://%s:%d/", ip, s.Port)
			}
		} else {
			log.Printf("Local URL:  http://%s:%d/", s.Host, s.Port)
		}
	}
	if len(s.AllowedOrigins) > 0 {
		log.Printf("Allowed Origins: %s", strings.Join(s.AllowedOrigins, ", "))
	}

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func normalizeOrigin(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if u, err := url.Parse(trimmed); err == nil && u.Scheme != "" && u.Host != "" {
		return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
	}
	return strings.ToLower(trimmed)
}

func (s *Server) isOriginAllowed(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	// Same-origin requests (Origin host matches request Host)
	if r != nil && r.Host != "" && strings.EqualFold(u.Host, r.Host) {
		return true
	}

	norm := strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)

	// Built-in loopback origins for this bridge port
	if norm == fmt.Sprintf("http://localhost:%d", s.Port) ||
		norm == fmt.Sprintf("http://127.0.0.1:%d", s.Port) {
		return true
	}

	// LAN IP origins when bound to 0.0.0.0
	if s.Host == "0.0.0.0" {
		for _, ip := range LocalIPs() {
			if norm == fmt.Sprintf("http://%s:%d", ip, s.Port) {
				return true
			}
		}
	}

	// Explicitly configured custom origins
	for _, allowed := range s.AllowedOrigins {
		if norm == normalizeOrigin(allowed) {
			return true
		}
	}
	return false
}

func (s *Server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	return s.isOriginAllowed(origin, r)
}

func (s *Server) isAuthorized(r *http.Request) bool {
	if s.AuthToken == "" {
		return true
	}
	token := ""
	if auth := r.Header.Get("Authorization"); len(auth) >= 7 && strings.EqualFold(auth[:7], "Bearer ") {
		token = strings.TrimSpace(auth[7:])
	}
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.AuthToken)) == 1
}

func (s *Server) withOriginCheck(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !s.isOriginAllowed(origin, r) {
				writeErr(w, http.StatusForbidden, "origin not allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
				w.Header().Add("Vary", "Access-Control-Request-Private-Network")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return s.withOriginCheck(func(w http.ResponseWriter, r *http.Request) {
		if !s.isAuthorized(r) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	})
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"authRequired": s.AuthToken != "",
		"version":      Version,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.clients[conn] = true
	s.mu.Unlock()

	// Send immediate snapshot
	s.sendSnapshot(r.Context(), conn)

	defer func() {
		s.mu.Lock()
		delete(s.clients, conn)
		s.mu.Unlock()
		_ = conn.Close()
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (s *Server) broadcastLoop(ctx context.Context) {
	ticker := time.NewTicker(2500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			count := len(s.clients)
			s.mu.Unlock()
			if count == 0 {
				continue
			}
			payload := s.buildSnapshot(ctx)
			data, err := json.Marshal(payload)
			if err != nil {
				continue
			}
			s.mu.Lock()
			for c := range s.clients {
				_ = c.SetWriteDeadline(time.Now().Add(3 * time.Second))
				if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
					_ = c.Close()
					delete(s.clients, c)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) buildSnapshot(ctx context.Context) map[string]any {
	devices, _ := s.Engine.ListDevices(ctx)
	if devices == nil {
		devices = []core.Device{}
	}
	return map[string]any{
		"type":      "snapshot",
		"timestamp": time.Now().Format(time.RFC3339),
		"devices":   devices,
		"pairing":   s.Engine.GetPairingSession(),
		"scrcpy":    s.Engine.ActiveScrcpySessions(),
	}
}

func (s *Server) sendSnapshot(ctx context.Context, conn *websocket.Conn) {
	data, err := json.Marshal(s.buildSnapshot(ctx))
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	summary := s.Engine.StatusSummary()
	summary["host"] = s.Host
	summary["port"] = s.Port
	summary["lanIps"] = LocalIPs()
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.Engine.ListDevices(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if devices == nil {
		devices = []core.Device{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "devices": devices})
}

func (s *Server) handleSwitchWiFi(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Serial string `json:"serial"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Serial == "" {
		writeErr(w, http.StatusBadRequest, "serial is required")
		return
	}
	msg, err := s.Engine.SwitchToWiFi(r.Context(), body.Serial)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Address string `json:"address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Address == "" {
		writeErr(w, http.StatusBadRequest, "address is required")
		return
	}
	out, err := s.Engine.ConnectWireless(r.Context(), body.Address)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Serial string `json:"serial"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Serial == "" {
		writeErr(w, http.StatusBadRequest, "serial is required")
		return
	}
	out, err := s.Engine.Disconnect(r.Context(), body.Serial)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleStartQR(w http.ResponseWriter, r *http.Request) {
	session, err := s.Engine.StartQRPairing(context.Background())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": session})
}

func (s *Server) handlePairingStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": s.Engine.GetPairingSession()})
}

func (s *Server) handlePairCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Address string `json:"address"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Address == "" || body.Code == "" {
		writeErr(w, http.StatusBadRequest, "address and code are required")
		return
	}
	out, err := s.Engine.PairWithCode(r.Context(), body.Address, body.Code)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleMDNS(w http.ResponseWriter, r *http.Request) {
	services, err := s.Engine.DiscoverMDNS(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if services == nil {
		services = []core.MDNSService{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "services": services})
}

func (s *Server) handleAPKList(w http.ResponseWriter, r *http.Request) {
	serial := r.URL.Query().Get("serial")
	if serial == "" {
		writeErr(w, http.StatusBadRequest, "serial query param is required")
		return
	}
	includeSystem := r.URL.Query().Get("system") == "true"
	pkgs, err := s.Engine.ListPackages(r.Context(), serial, includeSystem)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if pkgs == nil {
		pkgs = []core.PackageInfo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "packages": pkgs})
}

func (s *Server) handleAPKInstall(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(512 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "failed to parse multipart form: "+err.Error())
		return
	}
	serial := r.FormValue("serial")
	if serial == "" {
		writeErr(w, http.StatusBadRequest, "serial is required")
		return
	}
	file, header, err := r.FormFile("apk")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "apk file is required")
		return
	}
	defer file.Close()

	tmpDir, err := os.MkdirTemp("", "adb-deck-apk-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	dstPath := filepath.Join(tmpDir, filepath.Base(header.Filename))
	dst, err := os.Create(dstPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		_ = dst.Close()
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = dst.Close()

	out, err := s.Engine.InstallAPK(r.Context(), serial, dstPath, true)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleAPKAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Serial  string `json:"serial"`
		Package string `json:"package"`
		Action  string `json:"action"` // uninstall, clear, force-stop
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Serial == "" || body.Package == "" {
		writeErr(w, http.StatusBadRequest, "serial, package, and action are required")
		return
	}
	var (
		out string
		err error
	)
	switch body.Action {
	case "uninstall":
		out, err = s.Engine.UninstallPackage(r.Context(), body.Serial, body.Package)
	case "clear":
		out, err = s.Engine.ClearPackageData(r.Context(), body.Serial, body.Package)
	case "force-stop":
		out, err = s.Engine.ForceStopPackage(r.Context(), body.Serial, body.Package)
	default:
		writeErr(w, http.StatusBadRequest, "unknown action: "+body.Action)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
}

func (s *Server) handleAPKPull(w http.ResponseWriter, r *http.Request) {
	serial := r.URL.Query().Get("serial")
	pkg := r.URL.Query().Get("pkg")
	if serial == "" || pkg == "" {
		writeErr(w, http.StatusBadRequest, "serial and pkg query params are required")
		return
	}
	tmpDir, err := os.MkdirTemp("", "adb-deck-pull-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	apkFile, err := s.Engine.PullAPK(r.Context(), serial, pkg, tmpDir)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", pkg+".apk"))
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	http.ServeFile(w, r, apkFile)
}

func (s *Server) handleScrcpyStart(w http.ResponseWriter, r *http.Request) {
	var opts core.ScrcpyOptions
	if err := json.NewDecoder(r.Body).Decode(&opts); err != nil || opts.Serial == "" {
		writeErr(w, http.StatusBadRequest, "serial is required")
		return
	}
	session, err := s.Engine.StartScrcpy(opts)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": session})
}

func (s *Server) handleScrcpyStop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Serial string `json:"serial"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Serial == "" {
		writeErr(w, http.StatusBadRequest, "serial is required")
		return
	}
	if err := s.Engine.StopScrcpy(body.Serial); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleScrcpySessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions": s.Engine.ActiveScrcpySessions()})
}
