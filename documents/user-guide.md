# ADB Deck — User Onboarding Guide

Welcome to **ADB Deck**. You can use ADB Deck in two ways:

1. **Local Bridge Mode (Recommended on your own computer)**: Full feature set—USB & Wi-Fi ADB, live mDNS QR pairing, APK install/pull, and hardware-accelerated `scrcpy` screen mirroring.
2. **WebUSB Zero-Install Mode**: Connect a USB Android phone directly in Chrome or Microsoft Edge with no helper binary installed (supports device info, package listing, Clear Data, Force Stop, and Uninstall).

---

## Step 1: Prepare Your Android Phone (One-Time Setup)

1. Open **Settings** on your phone:
   - **Google Pixel / Stock Android**: `Settings` -> `About phone` -> tap **Build number** 7 times -> go back to `Settings` -> `System` -> `Developer options`.
   - **Samsung Galaxy (One UI)**: `Settings` -> `About phone` -> `Software information` -> tap **Build number** 7 times -> go back to `Settings` -> `Developer options`.
   - **Xiaomi (HyperOS / MIUI)**: `Settings` -> `About phone` -> tap **OS version** (or **MIUI version**) 7 times -> `Settings` -> `Additional settings` -> `Developer options`. (Also enable *USB debugging (Security settings)* if using `scrcpy` touch input.)
   - **OnePlus (OxygenOS)**: `Settings` -> `About device` -> `Version` -> tap **Build number** 7 times -> `Settings` -> `System settings` -> `Developer options`.
2. Inside **Developer options**, enable:
   - **USB debugging** (for USB cable or WebUSB connections)
   - **Wireless debugging** (for Android 11+ Wi-Fi QR pairing)

> **Tip:** Add the **Wireless Debugging** tile to your Quick Settings panel so you can toggle it in one swipe later.

---

## Step 2: Launch ADB Deck

### Option A: Local Bridge (Web Dashboard)

Make sure `adb` (and `scrcpy` for mirroring) are installed and on your `PATH`, then start ADB Deck from your terminal:

```powershell
.\adb-deck.exe
```

Open the printed authenticated URL in your browser (for example, `http://127.0.0.1:8787/?token=...`).

### Option B: Terminal UI (TUI)

```powershell
.\adb-deck.exe --tui
```

Keys: `[1-4]` or `[Tab]` switch tabs, `[↑/↓]` select items, `[r]` refresh, `[p]` start QR pairing, `[m]`/`[s]` start/stop `scrcpy`, `[q]` quit.

### Option C: WebUSB Zero-Install (Browser Only)

1. Open ADB Deck in **Google Chrome** or **Microsoft Edge** (over `localhost` or `https://`).
2. Click the **Settings** button in the bottom-left sidebar (or the top-right status chip).
3. Switch **Connection Mode** to **WebUSB (Zero-Install)** and click **Connect USB (WebUSB)**.
4. Plug in your phone via USB, select it in the browser prompt, and tap **Allow USB debugging** on your phone screen.

---

## Step 3: Pair Wirelessly via QR Code (Local Bridge)

1. Click **Pair Device** in the left sidebar.
2. **Step 1 — Choose Phone Type**: Pick your phone brand (expand **Setup steps** if you need a reminder). Click **Continue**.
3. **Step 2 — Scan QR Code**: On your phone, go to `Developer options` -> `Wireless debugging` -> **Pair device with QR code** and scan the QR code on screen.
   - Prefer numbers? Click **Enter code manually**, choose *Pair device with pairing code* on your phone, and enter the `IP:Port` and 6-digit code.
4. **Step 3 & 4 — Connecting & Done**: ADB Deck detects your phone over local Wi-Fi mDNS, completes pairing, and shows the **Open Dashboard** button.

---

## Step 4: Mirror Screen & Manage APKs

- **Mirror Screen**: Click **Start Mirroring** on the **Dashboard** (or open **Mirror** in the sidebar to set `1440p`/`1080p`/`720p`, bitrate, or **Advanced options** like Stay Awake and Screen Off). `scrcpy` opens in a native window on your host computer.
- **Manage APKs**: Click **Devices** in the sidebar, then select **APK Manager** under your device (either in the left sidebar tree or on the device card):
  - **Install**: Drag and drop an `.apk` file onto the upload bar or click **browse file** (Local Bridge mode).
  - **Per-app actions**: Click **Stop**, **Pull**, or the **`⋯`** menu for **Clear data** and **Uninstall**.
