# ADB Deck — Project Deliverables & Roadmap

This document captures the completed UI/architecture deliverables, technical findings, security trade-offs, and hosted-frontend roadmap established for **ADB Deck**.

## 1. Architecture Overview

ADB Deck is structured as a single repository with two complementary connection paths backed by zero-build static web assets:

- **Go Shared Core (`core/`)**: Wraps `adb` and `scrcpy` binaries (`exec.LookPath`), managing device discovery, Android 11+ mDNS QR pairing, 6-digit code pairing, TCP/IP Wi-Fi handoff, APK management, and `scrcpy` child processes.
- **Local HTTP + WebSocket Bridge (`bridge/`)**: Exposes `core.Engine` over localhost/LAN with token authentication (`crypto/subtle`) and strict `Origin` allowlisting.
- **Terminal UI (`tui/`)**: Interactive Bubble Tea + Lip Gloss terminal client over `core.Engine`.
- **Web Dashboard (`web/`)**: Embedded into the binary via `web/embed.go` and portable as-is to any static HTTPS host. Includes a pure-JS WebUSB ADB client (`web/webusb.js`) for zero-install USB control in Chrome/Edge.

## 2. Completed UI & UX Deliverables

1. **Stitch Design System Integration (`SyncWeb Device Onboarding Flow`)**:
   - Ported both **SyncWeb Dark** (`#121212` / `#2563EB`) and **SyncWeb Light** (`#FAF8FF` / `#004CCD`) palettes into CSS custom properties (`web/style.css`) with a persistent header theme toggle (`#themeToggleBtn` backed by `localStorage`).
   - Integrated Stitch typography (`Afacad Flux`, `Instrument Sans`, `Spline Sans Mono`) and `Material Symbols Outlined` icons without adding any npm/Tailwind build pipeline.
2. **Dashboard & 4-Step Pairing Onboarding Wizard**:
   - Built a live **Dashboard** hero card (active device model, state, battery, Android version, transport, and primary mirror/USB CTA) and Quick Action cards.
   - Automatically hides the **Wireless QR Pairing** quick card on the Dashboard whenever at least one device is connected.
   - Replaced the flat pairing form with a 4-step onboarding wizard (**1. Choose Phone Type** -> **2. Scan QR Code** + expandable manual pairing -> **3. Connecting** progress checklist -> **4. Success**).
3. **Hierarchical Devices & Per-Device APK Manager**:
   - Removed top-level `APK Manager` navigation; nested per-device `#sidebarDeviceTree` entries under `Devices` in the sidebar and `#deviceApkPanel` inside `#tab-devices` with a `Devices / <Model> / APK Manager` breadcrumb.
4. **Header Hover-Reveal Icon Chips & Cognitive-Load Decluttering**:
   - Removed `#quickPairBtn` from the top bar; converted remaining header items (`#themeToggleBtn`, `#wsBadge`) into compact icon-only `.header-chip` buttons that reveal text labels on hover/focus and expose descriptive `aria-label` captions.
   - Reduced visible choices per screen to 3–4 primary controls using progressive disclosure:
     - Moved Connection Mode (`Local Bridge` / `WebUSB`) into the `Settings` modal.
     - Auto-hid the sidebar `Active Device` selector unless 2+ devices are connected.
     - Collapsed OEM setup steps and `scrcpy` flags into `<details>` drawers.
     - Made device cards click-to-select with 3 action buttons; capped APK rows at 3 controls (`Stop`, `Pull`/`Clear`, and `...` overflow menu with `Clear data` & `Uninstall`).

## 3. Technical Diagnostics & Semantics

- **`scrcpy` Mirroring Window Behavior**: `core/scrcpy.go` spawns native `scrcpy` on the host OS (there is no in-browser video canvas). If `adb-deck` is launched from a hidden/isolated service desktop on Windows (`WinSta0\exebox-...`), `scrcpy` runs and streams sockets normally but its window is not visible on the user's desktop (`WinSta0\Default`). Run `adb-deck` from a standard user terminal to see the `scrcpy` window.
- **`Stop Mirror` vs. `Disconnect`**:
  - **Stop Mirror** calls `POST /api/scrcpy/stop` -> `Engine.StopScrcpy(serial)`, killing only the tracked `scrcpy` PID while leaving ADB connected.
  - **Disconnect** calls `POST /api/devices/disconnect` -> `Engine.Disconnect(ctx, serial)` (`adb disconnect <serial>`). Note: `Engine.Disconnect` does not currently pre-kill an active `scrcpy` PID, and Android 11+ mDNS serials (`_adb-tls-connect._tcp`) may auto-reconnect while Wireless Debugging stays enabled on the phone.
- **Helper Binary Discovery**: `core.NewEngine()` locates `adb` and `scrcpy` on `PATH` via `exec.LookPath` (does not auto-download missing binaries).

## 4. Security & Authentication Decisions

- **Local Bridge Tokens over Login Servers**: Keep random 128-bit bearer tokens (`?token=` stripped to tab-scoped `sessionStorage`) + strict `Origin` allowlists instead of building a formal account/login backend for local/LAN usage.
- **When to Revisit Auth**: Only add formal identity/OAuth if introducing internet-relayed remote access, multi-user shared device labs, or cloud-synced user accounts.
- **Recommended Hardening Backlog**:
  - Package `adb-deck`, `adb`, and `scrcpy` in a signed installer (`winget`/MSI/DMG) for zero-setup onboarding.
  - Replace `?token=` query authentication on `/api/apk/pull` downloads with `fetch` + `Authorization: Bearer` blob download or short-lived download nonces.
  - Recommend TLS/Tailscale whenever `--lan` is used on untrusted Wi-Fi.

## 5. Single-Repo Hosted Frontend Roadmap

No repository decoupling is required. `web/` remains in this single Git repository as the shared source of truth for both `go:embed` binaries and static HTTPS hosting:

| Host | Free Tier Highlights | Trade-off |
| :--- | :--- | :--- |
| **GitHub Pages** (`*.github.io`) | Zero extra accounts; native GitHub Actions deploy from `main` | No custom HTTP response headers |
| **Firebase Hosting** (`*.web.app`) | Free SSL, preview channels, `firebase.json` headers | 360 MB/day transfer limit on free Spark tier |
| **Cloudflare Pages** (`*.pages.dev`) | Unlimited free bandwidth, `_headers`, instant Git deploys | Separate Cloudflare account setup |
| **Vercel** (`*.vercel.app`) | Fast Git preview deployments | Hobby plan limited to non-commercial use |

**Pre-Hosting Checklist**:
1. Probe `GET /api/ping` on non-localhost HTTPS origins in `web/app.js` and auto-switch to **WebUSB mode** when no local bridge is running.
2. Echo `Access-Control-Allow-Private-Network: true` in `bridge/server.go` `OPTIONS` preflights when requested (`Access-Control-Request-Private-Network: true`) for Chrome Private/Local Network Access from `https://` origins.
3. Choose final hosted domain (candidates: `adb-deck.web.app`, `adbdeck.web.app`, `usbdeck.web.app`, `pairdeck.web.app`, `droiddeck.web.app`).
