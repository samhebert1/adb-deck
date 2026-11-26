// Package bridge exposes [core.Engine] over a secured local HTTP and
// WebSocket server that also serves the embedded static web UI.
//
// # Security Model
//
//   - Origin allowlist: Every /api/* and /ws request carrying an Origin header is
//     validated against same-host, loopback origins (localhost / 127.0.0.1), LAN
//     IPs when Host is "0.0.0.0", and explicit AllowedOrigins entries. Disallowed
//     origins receive HTTP 403 Forbidden. Access-Control-Allow-Origin echoes the
//     validated origin and never uses "*".
//   - Bearer token authentication: When AuthToken is non-empty, all /api/*
//     routes (except GET /api/ping) and /ws require either
//     "Authorization: Bearer <token>" or "?token=<token>", verified via
//     crypto/subtle.ConstantTimeCompare.
//   - Public static assets: Root "/" serves Server.WebFS without auth so the web
//     UI can load, save "?token=" into sessionStorage, and strip it from the URL.
//
// # Real-Time WebSocket Protocol (/ws)
//
// Connected clients immediately receive a JSON snapshot and subsequent updates
// every 2.5 seconds containing:
//
//	{
//	  "type": "snapshot",
//	  "timestamp": "2026-11-26T00:00:00Z",
//	  "devices": [...],
//	  "pairing": { ... } | null,
//	  "scrcpy": [...]
//	}
//
// # REST Endpoints
//
//   - GET  /api/ping              Unauthenticated discovery & auth status
//   - GET  /api/status            Tool readiness (adb/scrcpy paths) & LAN IPs
//   - GET  /api/devices           List attached USB & wireless devices
//   - POST /api/devices/wifi      Switch USB device to TCP/IP Wi-Fi (port 5555)
//   - POST /api/devices/connect   Connect wireless ADB IP:port
//   - POST /api/devices/disconnect Disconnect wireless ADB serial
//   - POST /api/pairing/qr        Start Android 11+ mDNS QR pairing session
//   - GET  /api/pairing/status    Fetch current QR pairing session state
//   - POST /api/pairing/code      Pair using IP:port + 6-digit code
//   - GET  /api/mdns              Discover active ADB mDNS services
//   - GET  /api/apk/list          List packages (?serial=...&system=true|false)
//   - POST /api/apk/install       Install multipart APK upload
//   - POST /api/apk/action        Run uninstall | clear | force-stop on package
//   - GET  /api/apk/pull          Download base APK (?serial=...&pkg=...)
//   - POST /api/scrcpy/start      Launch host scrcpy mirror process
//   - POST /api/scrcpy/stop       Terminate host scrcpy mirror process
//   - GET  /api/scrcpy/sessions   List active scrcpy sessions
package bridge
