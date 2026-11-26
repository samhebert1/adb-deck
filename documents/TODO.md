# ADB Deck — Central Deliverables & Milestone Tracker

Central tracking record for completed deliverables and upcoming milestones across **ADB Deck**. Pair this file with [deliverables.md](deliverables.md) for detailed architectural context and [AGENTS.md](../AGENTS.md) for contributor/agent rules.

---

## Completed Deliverables

- [x] **Core ADB & scrcpy Engine (`core/`)**: Device listing, USB-to-Wi-Fi handoff (`tcpip 5555`), Android 11+ mDNS QR pairing, 6-digit pairing, APK install/pull/clear/stop/uninstall, and `scrcpy` process management.
- [x] **Secured HTTP + WebSocket Bridge (`bridge/`)**: Localhost-first server with 128-bit random bearer token (`crypto/subtle`), strict `Origin` allowlist, `/api/ping` discovery, and 2.5s `/ws` state snapshots (`bridge/server_test.go`).
- [x] **Zero-Install WebUSB ADB Client (`web/webusb.js`)**: Pure browser ADB wire protocol (`CNXN`, `AUTH` RSA-2048 via WebCrypto, `OPEN/OKAY/WRTE/CLSE`, `shell:` commands).
- [x] **Stitch Dual-Theme UI Integration (`web/`)**:
  - [x] Ported **SyncWeb Dark** (`#121212` / `#2563EB`) and **SyncWeb Light** (`#FAF8FF` / `#004CCD`) CSS tokens with persistent `#themeToggleBtn`.
  - [x] Built **Dashboard** hero card and Quick Action cards (auto-hiding `Wireless QR Pairing` when a device is connected).
  - [x] Implemented 4-step **Pair Device** onboarding wizard (`Choose Phone Type` -> `Scan QR Code` + manual fallback -> `Connecting` -> `Success`).
  - [x] Nested **APK Manager** hierarchically under **Devices** (`#sidebarDeviceTree` + `#deviceApkPanel` breadcrumb).
  - [x] Converted header items (`#themeToggleBtn`, `#wsBadge`) into icon-only hover/focus-reveal chips with descriptive `aria-label` attributes.
  - [x] Decluttered views to <= 3–4 primary controls using `<details>` disclosures, Settings modal mode switching, and `...` per-row overflow menus.
- [x] **Documentation & Repository Structure**:
  - [x] Root agent & contributor guide ([AGENTS.md](../AGENTS.md))
  - [x] User onboarding guide ([user-guide.md](user-guide.md)) and troubleshooting FAQ ([faq.md](faq.md))
  - [x] Project deliverables summary ([deliverables.md](deliverables.md)) and milestone tracker ([TODO.md](TODO.md))
  - [x] Package `doc.go` contracts (`core.ADBController`), inline Go/JS docs, `.gitignore`, and GitHub Actions CI ([ci.yml](../.github/workflows/ci.yml)).

---

## Future Milestones & Backlog

### Phase 1 — Public GitHub & Reliability Polish
- [ ] Add an open-source `LICENSE` file (e.g., MIT or Apache-2.0) and push `main` to GitHub.
- [ ] Update `Engine.Disconnect` in `core/adb.go` to optionally call `Engine.StopScrcpy(serial)` before running `adb disconnect` so orphaned mirror processes close immediately.
- [ ] Replace `?token=` query parameter on `/api/apk/pull` downloads with `fetch` + `Authorization: Bearer` blob download (or short-lived download nonces) so tokens never appear in download URLs.
- [ ] Add unit tests for `core/` command parsers (`ListDevices`, `ListPackages`, `DiscoverMDNS`) using mocked command runners.

### Phase 2 — Seamless Hosted Frontend (`web/` on HTTPS Domain)
- [ ] Pick final public domain name (candidates: `adb-deck.web.app`, `adbdeck.web.app`, `usbdeck.web.app`, `pairdeck.web.app`) or deploy from `main` via GitHub Actions to **GitHub Pages** / **Firebase Hosting** / **Cloudflare Pages** without splitting the repo.
- [ ] Add external-origin startup detection in `web/app.js`: probe `GET /api/ping` when loaded from a non-localhost `https://` origin and auto-switch to **WebUSB mode** if no local bridge is running.
- [ ] Support Chrome Private/Local Network Access (`Access-Control-Allow-Private-Network: true`) on `OPTIONS` preflights in `bridge/server.go` for hosted `https://` -> `http://127.0.0.1:8787` bridge calls.
- [ ] Implement WebUSB `sync:` protocol in `web/webusb.js` so binary `.apk` install and pull also work in zero-install mode.

### Phase 3 — Helper Packaging & Companion Experience
- [ ] Bundle `adb-deck`, `adb`, and `scrcpy` into signed platform installers (`winget` / MSI on Windows, Homebrew / `.dmg` on macOS).
- [ ] Evaluate optional in-browser `scrcpy` video/WebCodecs canvas streaming over WebSocket/WebUSB as an alternative to the native host `scrcpy` window.
- [ ] Add local TLS / Tailscale setup docs for secure `--lan` wireless usage on shared networks.
