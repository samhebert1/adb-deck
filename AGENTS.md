# ADB Deck — Agent & Developer Architecture Guide

This guide gives human contributors and AI coding agents a fast, accurate map of **ADB Deck**—its package boundaries, interfaces, API/WebSocket contracts, state invariants, and verification commands.

## Repository Layout

```text
adb-deck/
├── main.go                     # CLI entry point (--serve default or --tui, flags, token setup)
├── core/                       # Shared ADB & scrcpy engine (single source of truth)
│   ├── doc.go                  # Package docs & ADBController interface contract
│   ├── adb.go                  # Engine, adb subprocess runner, Device discovery, TCP/IP Wi-Fi handoff
│   ├── pairing.go              # Android 11+ mDNS QR pairing watcher & 6-digit pairing
│   ├── apk.go                  # Package listing, install, pull, clear data, force-stop, uninstall
│   └── scrcpy.go               # scrcpy child-process lifecycle & active session registry
├── bridge/                     # HTTP + WebSocket server exposing core.Engine to browsers
│   ├── doc.go                  # REST + WebSocket protocol overview & security invariants
│   ├── server.go               # Mux routes, Origin allowlist, constant-time bearer auth, WS hub
│   └── server_test.go          # Auth, Origin allowlist, and WebSocket upgrade tests
├── tui/                        # Terminal UI built with Bubble Tea + Lip Gloss
│   ├── doc.go                  # Package docs & keyboard navigation overview
│   └── app.go                  # Tea Model/Update/View consuming core.Engine
├── web/                        # Zero-build static dashboard embedded into binary via go:embed
│   ├── embed.go                # //go:embed index.html style.css app.js webusb.js
│   ├── index.html              # Sidebar shell, Dashboard, 4-step Pair wizard, Devices + APKs, Mirror, Settings
│   ├── style.css               # SyncWeb Dark + Light theme tokens, disclosures, hover chips, row menus
│   ├── app.js                  # Bridge WS/REST client, mode switcher, Dashboard/Wizard/APK UI controller
│   └── webusb.js               # Zero-dependency WebUSB ADB wire-protocol client (CNXN/AUTH/OPEN/WRTE)
├── documents/                  # Project documentation, user help, FAQ, and deliverables
│   ├── user-guide.md           # Step-by-step onboarding guide for end users
│   ├── faq.md                  # Onboarding troubleshooting sequences & FAQ
│   └── deliverables.md         # Architecture decisions, completed deliverables, hosting roadmap
└── .github/workflows/ci.yml    # Automated Go test, vet, and build CI checks
```

## Architecture & Module Contracts

1. **Dependency Direction**:
   - `main` -> `core`, `bridge`, `tui`, `web`
   - `bridge` -> `core`
   - `tui` -> `core`
   - `core` must NEVER import `bridge`, `tui`, or `web`.
   - `web` communicates with `bridge` over REST (`/api/*`) + WebSocket (`/ws`) in **Local Bridge** mode, OR directly with USB-attached Android devices via Chrome/Edge `navigator.usb` in **WebUSB** mode (`web/webusb.js`).

2. **Core Engine Contract (`core.ADBController`)**:
   - `*core.Engine` implements `core.ADBController`.
   - All subprocess invocations pass through `Engine.RunADB` (with context timeouts) or `Engine.StartScrcpy` / `Engine.StopScrcpy`.
   - Concurrency invariant: `Engine.mu` guards `scrcpyProcs` (`map[string]*ScrcpySession`) and `activePairing` (`*PairingSession`). Never hold `Engine.mu` across blocking `exec.Command` calls (`RunADB`, `StartScrcpy` start, `cmd.Wait`). Always snapshot structs (`GetPairingSession`, `ActiveScrcpySessions`) before returning to callers.

3. **Bridge Security & API Contract (`bridge.Server`)**:
   - **Localhost default**: `main.go` defaults `--host` to `127.0.0.1` (unless `--lan` sets `0.0.0.0`).
   - **Token auth**: `main.go` generates a 32-char random hex token unless `--token` or `--no-auth` is passed. `Server.withAuth` enforces constant-time token comparison (`Authorization: Bearer <token>` or `?token=<token>`) on `/ws` and every `/api/*` route except `GET /api/ping`.
   - **Origin allowlist**: `Server.withOriginCheck` and `upgrader.CheckOrigin` enforce strict origin checks (`localhost:<port>`, `127.0.0.1:<port>`, LAN IPs when `--lan`, and `--allowed-origins`) and echo the validated `Origin` (never `*`).
   - **WebSocket snapshot schema (`/ws`)**: Broadcasts every `2.5s` and immediately upon connection:
     ```json
     {
       "type": "snapshot",
       "timestamp": "RFC3339",
       "devices": [],
       "pairing": null,
       "scrcpy": []
     }
     ```
   - **REST endpoints**:
     - `GET /api/ping` (unauthenticated discovery)
     - `GET /api/status`
     - `GET /api/devices`, `POST /api/devices/wifi`, `POST /api/devices/connect`, `POST /api/devices/disconnect`
     - `POST /api/pairing/qr`, `GET /api/pairing/status`, `POST /api/pairing/code`, `GET /api/mdns`
     - `GET /api/apk/list`, `POST /api/apk/install`, `POST /api/apk/action`, `GET /api/apk/pull`
     - `POST /api/scrcpy/start`, `POST /api/scrcpy/stop`, `GET /api/scrcpy/sessions`

4. **Frontend Conventions (`web/`)**:
   - **Zero-build constraint**: Keep `web/` pure static HTML/CSS/JS so `web/embed.go` embeds it directly into the Go binary and any static host (`GitHub Pages`, `Firebase Hosting`, `Cloudflare Pages`) can serve `web/` unchanged.
   - **Theme tokens**: Both `[data-theme="dark"]` (default) and `[data-theme="light"]` tokens live in `web/style.css`; keep QR frames `#FFFFFF` in both themes for camera scannability.
   - **XSS safety**: Always escape dynamic device names, serials, and package IDs via `escapeHtml(...)` before inserting into `innerHTML`.
   - **Progressive disclosure**: Keep each view focused on 3–4 primary actions; tuck secondary flags/actions inside `<details class="disclosure">`, `.row-menu`, or the `Settings` modal.

## Common Developer Commands

```powershell
# Run tests and static analysis
go vet ./...
go test -count=1 ./...

# Validate frontend JS syntax (if Node is installed)
node --check web/app.js
node --check web/webusb.js

# Iterate live on web/ without rebuilding Go binary
go run . --web-dir ./web --port 8789

# Rebuild single-binary executable (with embedded web/)
go build -o adb-deck.exe .

# Browse living HTML documentation for all Go packages
go doc -http=:6060
```

## Guardrails for Modifying Agents

- Always update `bridge/server_test.go` when changing auth, origin checks, or REST routes.
- Preserve all DOM IDs referenced in `web/app.js` when editing `web/index.html`, or update both atomically.
- Never log or persist auth tokens in `localStorage` (`app.js` uses `sessionStorage` and strips `?token=` from `location.search` immediately).
- When running `adb-deck` on Windows from headless automation shells, note that `scrcpy.exe` inherits the server process's Window Station/Desktop (`WinSta0\Default` vs. isolated runner desktops).
