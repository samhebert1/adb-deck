// Package tui provides the interactive Bubble Tea + Lip Gloss terminal user
// interface for ADB Deck, backed by the shared [core.Engine].
//
// # Tabs & Keybindings
//
//   - 1 / 2 / 3 / 4 or Tab: Switch between Devices, QR Pairing, APK Manager, and scrcpy.
//   - Up / Down (or j / k): Move selection cursor in Devices or APK Manager.
//   - r: Refresh device list or installed third-party packages.
//   - p: Start an Android 11+ Wireless Debugging QR pairing session (on QR Pairing tab).
//   - m / s: Start or stop scrcpy mirroring for the selected device.
//   - c: Clear app data for the selected package (on APK Manager tab).
//   - q or Ctrl+C: Quit the TUI.
package tui
