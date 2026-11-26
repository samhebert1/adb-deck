# ADB Deck — Onboarding FAQ & Troubleshooting Sequences

Use these step-by-step diagnostic sequences whenever onboarding, pairing, WebUSB, or mirroring gets stuck.

---

## Q1: No devices show up after plugging in a USB cable

**Follow this sequence:**
1. **Check USB cable & mode**: Some USB cables are charge-only. Try a known data cable and switch Android's USB notification from *Charging only* to *File Transfer (MTP)*.
2. **Verify USB debugging is enabled**: `Developer options` -> `USB debugging` must be **ON**.
3. **Check for the RSA prompt on your phone**: Unlock the phone screen and look for *"Allow USB debugging?"*. Check *Always allow from this computer* and tap **Allow**.
4. **Verify ADB sees the device**:
   - In Local Bridge mode, run `adb devices -l` in your terminal:
     - If it says `unauthorized`, revoke USB debugging authorizations in Developer Options and replug.
     - If `adb` is not recognized, install Android Platform Tools and add it to your `PATH`.

---

## Q2: Chrome WebUSB fails to connect ("Unable to claim interface" / `SecurityError` / `NotFoundError`)

**Follow this sequence:**
1. **Check browser & origin**: WebUSB only works in Chromium browsers (**Chrome**, **Edge**) over **`https://`** or **`http://localhost`** / **`http://127.0.0.1`**. Firefox and Safari are not supported.
2. **Release conflicting local `adb.exe` lock (Most common on Windows/macOS)**:
   - Only one process can claim the USB ADB interface at a time. If `adb` is already running in the background on your PC, WebUSB will fail with *"Unable to claim interface"*.
   - Run `adb kill-server` in a terminal, then click **Connect USB (WebUSB)** again—or switch **Connection Mode** to **Local Bridge**.
3. **Confirm device authorization**: When WebUSB connects for the first time, look at your phone screen and tap **Allow** on the RSA key prompt.

---

## Q3: Wireless QR pairing times out or never detects my phone

**Follow this sequence:**
1. **Confirm same Wi-Fi & AP isolation**: Your computer and phone must be on the same Wi-Fi subnet without router "Client / AP Isolation" (often enabled on guest or cafe Wi-Fi).
2. **Keep the phone screen open on the scanner**: Android stops broadcasting its `_adb-tls-pairing._tcp` mDNS service the moment you back out of the QR scanner screen.
3. **Verify Windows Firewall allows ADB mDNS**: Allow `adb.exe` on Private networks in Windows Defender Firewall so UDP port `5353` (mDNS) traffic isn't blocked.
4. **Use the 6-digit manual fallback**:
   - On your phone under `Wireless debugging`, tap **Pair device with pairing code**.
   - In ADB Deck Step 2 (`Scan QR Code`), click **Enter code manually** and enter the shown `IP:Port` and 6-digit code.
5. **Already paired over USB?** Plug in briefly via USB and click **Wi-Fi** on the device card (`Switch to Wi-Fi`) for one-click TCP/IP wireless handoff on port `5555`.

---

## Q4: I clicked "Start Mirroring" and it says Mirroring/Active, but no window appears

**Follow this sequence:**
1. **Understand where `scrcpy` renders**: `adb-deck` launches native `scrcpy` on the **host computer** (`Win32`/`macOS`/`Linux` window)—there is no video stream inside the browser tab.
2. **Check `scrcpy` availability**: Open **Settings** or visit `/api/status` (`scrcpyReady: true`), or run `scrcpy --version` in your terminal to ensure `scrcpy` is on your `PATH`.
3. **Check which desktop session launched `adb-deck`**:
   - If you started `adb-deck` from an automated background service, IDE sandbox, or SSH session on Windows, `scrcpy.exe` inherits that hidden desktop (`WinSta0\...`) instead of your visible Windows desktop (`WinSta0\Default`).
   - Stop the background process and run `.\adb-deck.exe` directly from your own Windows Terminal / PowerShell window.
4. **Check phone lock screen / Xiaomi input locks**: Unlock your phone screen. On Xiaomi/HyperOS, enable *USB debugging (Security settings)* if video shows but clicks don't register.

---

## Q5: Top-right badge says "Auth Required" or "Reconnecting..."

**Follow this sequence:**
1. **Ensure the helper is running**: Make sure `.\adb-deck.exe` is still running in your terminal.
2. **Re-paste the Bridge Token**:
   - Look at your terminal startup logs for `Local URL: http://127.0.0.1:8787/?token=<token>` or `Auth Token: <token>`.
   - Click the top-right status chip (or **Settings** in the sidebar footer), paste the **Bridge Token**, and click **Save**.
3. **Using a hosted frontend URL?** Start the local bridge with `--allowed-origins`:
   ```powershell
   .\adb-deck.exe --allowed-origins https://your-hosted-domain.web.app
   ```

---

## Q6: Why did a wireless device reconnect after I clicked "Disconnect"?

- **Disconnect** runs `adb disconnect <serial>`, which closes the current ADB transport.
- For Android 11+ mDNS wireless connections (`_adb-tls-connect._tcp`), Android's local mDNS daemon may automatically reconnect as long as **Wireless debugging** stays toggled **ON** on the phone.
- To keep a device disconnected, toggle **Wireless debugging OFF** on the phone (using the Quick Settings tile or Developer Options).

---

## Q7: Can I browse living Go API/code documentation locally?

Yes. Go includes a built-in living HTML documentation server powered directly by package and symbol doc comments:

```powershell
go doc -http=:6060
```

Or inspect a single package/symbol in your terminal:

```powershell
go doc ./core
go doc ./bridge.Server
```
