# ADB Deck

Unified Go ADB control suite with a local WebSocket/HTTP bridge, zero-install browser WebUSB client, and interactive Bubble Tea terminal UI.

```text
adb-deck/
├── main.go                 # CLI entry point (HTTP/WS bridge by default, or --tui)
├── core/                   # Shared ADB & scrcpy engine (core.ADBController)
├── bridge/                 # Secured HTTP + WebSocket server (bearer auth & Origin allowlist)
├── tui/                    # Interactive Bubble Tea + Lip Gloss terminal UI
├── web/                    # Zero-build SyncWeb Dark/Light dashboard (embedded via go:embed)
├── documents/              # User guide, troubleshooting FAQ, deliverables, and milestone tracker
└── AGENTS.md               # Agent & developer architecture guide
```

---

## Features

- **Dual Connection Modes**:
  - **Local Bridge**: Full ADB over USB and Wi-Fi, Android 11+ live mDNS QR pairing, 6-digit manual pairing, `.apk` install/pull/clear/stop/uninstall, and hardware-accelerated `scrcpy` mirroring.
  - **WebUSB (Zero-Install)**: Connect USB Debugging devices straight from **Chrome** or **Edge** (`web/webusb.js`) with zero local binary installation.
- **Calm, Themeable Web UI**: Dual **SyncWeb Dark** and **SyncWeb Light** themes (`#themeToggleBtn`), live device **Dashboard**, 4-step **Pair Device** onboarding wizard, and per-device **APK Manager** nested under **Devices**.
- **Terminal UI (`--tui`)**: Fast keyboard-driven Bubble Tea workspace sharing the same `core.Engine`.
- **Secure Localhost Defaults**: Binds to `127.0.0.1:8787`, generates a 32-character random hex bearer token on startup, compares tokens in constant time (`crypto/subtle`), and enforces a strict `Origin` allowlist.

---

## Quick Start

### Prerequisites

- **Go 1.26+** (to build or run from source)
- **Android Platform Tools (`adb`)** and **`scrcpy`** on your `PATH` for Local Bridge / TUI mode *(not required for WebUSB-only browser usage)*

### Hosted Static UI (GitHub Pages)

The static dashboard is published from [web/](web/) via [pages.yml](.github/workflows/pages.yml) at:

- **Hosted Dashboard**: `https://samhebert1.github.io/adb-deck/`

When opened remotely with no local helper running, ADB Deck probes `/api/ping` and automatically switches to **WebUSB (Zero-Install)** mode in Chrome or Edge. To also enable Local Bridge (`scrcpy`, mDNS QR pairing, `.apk` install/pull) from the hosted UI, start your local bridge with:

```powershell
.\adb-deck.exe --allowed-origins https://samhebert1.github.io
```

### Run the Web Dashboard & Bridge (Local)

```powershell
go run .
# or run the compiled binary:
.\adb-deck.exe
```

Open the authenticated URL printed in the terminal (`http://127.0.0.1:8787/?token=<token>`).

### Run the Terminal UI (TUI)

```powershell
go run . --tui
# or:
.\adb-deck.exe --tui
```

---

## CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--host` | `127.0.0.1` | Bind host for the HTTP/WebSocket bridge & web dashboard |
| `--lan` | `false` | Bind to `0.0.0.0` for LAN access (overrides `--host`) |
| `--port` | `8787` | Port for the HTTP/WebSocket bridge & web dashboard |
| `--token` | *(auto)* | Static bearer token (random 32-char hex generated if omitted) |
| `--no-auth` | `false` | Disable token authentication (explicit opt-in; not recommended) |
| `--allowed-origins` | `""` | Comma-separated extra CORS/WebSocket origins (e.g. `https://adbdeck.web.app`) |
| `--web-dir` | `""` | Serve web assets live from disk during frontend development |
| `--tui` | `false` | Launch the interactive Bubble Tea terminal UI |

```powershell
# Expose on LAN with an auto-generated token
.\adb-deck.exe --lan --port 8787

# Allow a hosted HTTPS frontend origin with a fixed token
.\adb-deck.exe --token my-secret-token --allowed-origins https://adbdeck.web.app

# Iterate live on web/ assets without recompiling
go run . --web-dir ./web --port 8789
```

---

## Documentation & Help

- **User Onboarding Guide**: [documents/user-guide.md](documents/user-guide.md) — Step-by-step setup for Local Bridge, WebUSB, OEM Developer Options, QR pairing, and mirroring.
- **Troubleshooting & FAQ**: [documents/faq.md](documents/faq.md) — Diagnostic sequences for USB detection, WebUSB interface locks, mDNS QR timeouts, `scrcpy` windows, and auth tokens.
- **Agent & Developer Guide**: [AGENTS.md](AGENTS.md) — Module boundaries, `core.ADBController` contract, HTTP/WS API schemas, and frontend invariants.
- **Project Deliverables & Tracker**: [documents/deliverables.md](documents/deliverables.md) and [documents/TODO.md](documents/TODO.md).

### Living Code Documentation (Go HTTP Server)

Browse live, auto-generated HTML documentation straight from Go package and symbol comments:

```powershell
go doc -http=:6060
```

Or inspect packages in the terminal:

```powershell
go doc ./core
go doc ./bridge
go doc ./tui
```

---

## Security Model

- **Localhost by default**: Binds to `127.0.0.1` unless `--lan` or `--host 0.0.0.0` is passed.
- **Token authentication**: All `/api/*` endpoints (except `GET /api/ping`) and `/ws` require `Authorization: Bearer <token>` or `?token=<token>` verified via `crypto/subtle.ConstantTimeCompare`. Static files remain public so the dashboard can extract `?token=` into `sessionStorage` and clean the address bar immediately.
- **Origin allowlist**: Requests with a disallowed `Origin` header receive `403 Forbidden` on both `/api/*` and `/ws`; `Access-Control-Allow-Origin` echoes only validated origins (never `*`).

---

## Development & Verification

```powershell
go vet ./...
go test -count=1 ./...
go build -o adb-deck.exe .
```
