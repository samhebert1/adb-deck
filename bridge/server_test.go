package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"adb-deck/core"

	"github.com/gorilla/websocket"
)

func newTestServer(token string, allowedOrigins []string) *Server {
	webFS := fstest.MapFS{
		"index.html": {Data: []byte("<html>ok</html>")},
	}
	return NewServer(core.NewEngine(), webFS, "127.0.0.1", 8787, SecurityConfig{
		AuthToken:      token,
		AllowedOrigins: allowedOrigins,
	})
}

func TestPingUnauthenticated(t *testing.T) {
	srv := newTestServer("secret-token-1234", nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/ping")
	if err != nil {
		t.Fatalf("GET /api/ping failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var body struct {
		OK           bool   `json:"ok"`
		AuthRequired bool   `json:"authRequired"`
		Version      string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode /api/ping response: %v", err)
	}
	if !body.OK || !body.AuthRequired || body.Version != Version {
		t.Fatalf("unexpected ping payload: %+v", body)
	}
}

func TestDevicesRequiresAuth(t *testing.T) {
	srv := newTestServer("secret-token-1234", nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Missing token -> 401
	resp, err := http.Get(ts.URL + "/api/devices")
	if err != nil {
		t.Fatalf("GET /api/devices failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	// Wrong Bearer token -> 401
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/devices", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/devices with wrong bearer failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong bearer token, got %d", resp.StatusCode)
	}

	// Wrong query token -> 401
	resp, err = http.Get(ts.URL + "/api/devices?token=wrong-token")
	if err != nil {
		t.Fatalf("GET /api/devices with wrong query token failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong query token, got %d", resp.StatusCode)
	}
}

func TestStatusWithValidAuth(t *testing.T) {
	const token = "valid-secret-token-abcdef"
	srv := newTestServer(token, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Valid Authorization: Bearer <token>
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/status with Bearer failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with Bearer token, got %d", resp.StatusCode)
	}

	// Valid ?token=<token>
	resp, err = http.Get(ts.URL + "/api/status?token=" + token)
	if err != nil {
		t.Fatalf("GET /api/status with query token failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with query token, got %d", resp.StatusCode)
	}
}

func TestDisallowedOriginRejected(t *testing.T) {
	const token = "valid-secret-token-abcdef"
	srv := newTestServer(token, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Disallowed Origin on /api/status -> 403
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/status with evil origin failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed origin on /api/status, got %d", resp.StatusCode)
	}

	// Disallowed Origin on /ws -> upgrade fails with 403
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?token=" + token
	hdr := http.Header{"Origin": []string{"https://evil.example"}}
	conn, wsResp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("expected WebSocket upgrade to fail for disallowed origin")
	}
	if wsResp == nil || wsResp.StatusCode != http.StatusForbidden {
		status := 0
		if wsResp != nil {
			status = wsResp.StatusCode
		}
		t.Fatalf("expected 403 on disallowed /ws upgrade, got %d (err=%v)", status, err)
	}
}

func TestAllowedCustomOrigin(t *testing.T) {
	const token = "valid-secret-token-abcdef"
	const customOrigin = "https://adbdeck.example.com"
	srv := newTestServer(token, []string{customOrigin})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", customOrigin)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/status with custom origin failed: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for allowed custom origin, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != customOrigin {
		t.Fatalf("expected Access-Control-Allow-Origin=%q, got %q", customOrigin, got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("expected Access-Control-Allow-Headers to include Authorization, got %q", got)
	}
}

func TestPrivateNetworkAccessPreflight(t *testing.T) {
	const allowedOrigin = "https://samhebert1.github.io"
	srv := newTestServer("valid-secret-token-abcdef", []string{allowedOrigin})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Allowed origin PNA preflight -> 204 with Access-Control-Allow-Private-Network: true
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/ping", nil)
	req.Header.Set("Origin", allowedOrigin)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("OPTIONS /api/ping for allowed origin failed: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for allowed PNA preflight, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowedOrigin {
		t.Fatalf("expected Access-Control-Allow-Origin=%q, got %q", allowedOrigin, got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("expected Access-Control-Allow-Private-Network=true, got %q", got)
	}

	// Disallowed origin PNA preflight -> 403 without private network allow header
	badReq, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/ping", nil)
	badReq.Header.Set("Origin", "https://evil.example")
	badReq.Header.Set("Access-Control-Request-Method", http.MethodGet)
	badReq.Header.Set("Access-Control-Request-Private-Network", "true")
	badResp, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatalf("OPTIONS /api/ping for disallowed origin failed: %v", err)
	}
	badResp.Body.Close()

	if badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed PNA preflight, got %d", badResp.StatusCode)
	}
	if got := badResp.Header.Get("Access-Control-Allow-Private-Network"); got != "" {
		t.Fatalf("expected empty Access-Control-Allow-Private-Network on 403, got %q", got)
	}
}
