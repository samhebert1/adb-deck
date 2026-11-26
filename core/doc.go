// Package core implements the shared Android Debug Bridge (ADB) and scrcpy
// engine consumed by both the HTTP/WebSocket bridge (package bridge) and the
// Bubble Tea terminal interface (package tui).
//
// # Architecture & Concurrency Invariants
//
// All device operations flow through [Engine], which satisfies [ADBController].
// [Engine] shells out to the `adb` and `scrcpy` binaries discovered on PATH at
// initialization time via [NewEngine].
//
// Thread-safety rules for contributors and automated agents:
//   - Engine.mu protects activePairing and scrcpyProcs.
//   - Never hold Engine.mu across blocking subprocess calls (RunADB or cmd.Wait).
//   - Return shallow copies from GetPairingSession and ActiveScrcpySessions so
//     callers never race on internal cancellation or process handles.
//
// # Subsystems
//
//   - Device discovery & Wi-Fi handoff: ListDevices, SwitchToWiFi, ConnectWireless, Disconnect.
//   - Wireless pairing (Android 11+): StartQRPairing, GetPairingSession, PairWithCode, DiscoverMDNS.
//   - Package management: ListPackages, InstallAPK, UninstallPackage, ClearPackageData, ForceStopPackage, PullAPK.
//   - Screen mirroring: StartScrcpy, StopScrcpy, ActiveScrcpySessions.
package core

import "context"

// ADBController defines the capability contract implemented by [Engine].
// Consumers such as HTTP handlers, tests, or future remote relays can rely on
// this interface when inspecting or mocking core engine behavior.
type ADBController interface {
	StatusSummary() map[string]any
	RunADB(ctx context.Context, args ...string) (string, error)

	ListDevices(ctx context.Context) ([]Device, error)
	SwitchToWiFi(ctx context.Context, serial string) (string, error)
	ConnectWireless(ctx context.Context, addr string) (string, error)
	Disconnect(ctx context.Context, serial string) (string, error)

	DiscoverMDNS(ctx context.Context) ([]MDNSService, error)
	StartQRPairing(parentCtx context.Context) (*PairingSession, error)
	GetPairingSession() *PairingSession
	PairWithCode(ctx context.Context, hostPort, code string) (string, error)

	ListPackages(ctx context.Context, serial string, includeSystem bool) ([]PackageInfo, error)
	InstallAPK(ctx context.Context, serial, localAPKPath string, replace bool) (string, error)
	UninstallPackage(ctx context.Context, serial, pkg string) (string, error)
	ClearPackageData(ctx context.Context, serial, pkg string) (string, error)
	ForceStopPackage(ctx context.Context, serial, pkg string) (string, error)
	PullAPK(ctx context.Context, serial, pkg, destDir string) (string, error)

	StartScrcpy(opts ScrcpyOptions) (*ScrcpySession, error)
	StopScrcpy(serial string) error
	ActiveScrcpySessions() []ScrcpySession
}

var _ ADBController = (*Engine)(nil)
