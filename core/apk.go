package core

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PackageInfo represents an installed Android package on a device,
// parsed from `adb shell pm list packages -f`.
type PackageInfo struct {
	Package  string `json:"package"`  // Android application ID (e.g. com.example.app)
	APKPath  string `json:"apkPath"`  // On-device APK filesystem path
	IsSystem bool   `json:"isSystem"` // True when APKPath resides under /system, /product, /vendor, or /system_ext
}

// ListPackages lists installed packages on the target device.
func (e *Engine) ListPackages(ctx context.Context, serial string, includeSystem bool) ([]PackageInfo, error) {
	args := []string{"-s", serial, "shell", "pm", "list", "packages", "-f"}
	if !includeSystem {
		args = append(args, "-3")
	}
	out, err := e.RunADB(ctx, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list packages: %w (%s)", err, out)
	}

	var pkgs []PackageInfo
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "package:") {
			continue
		}
		rest := strings.TrimPrefix(line, "package:")
		idx := strings.LastIndex(rest, "=")
		if idx <= 0 {
			continue
		}
		apkPath := rest[:idx]
		pkgName := rest[idx+1:]
		isSys := strings.HasPrefix(apkPath, "/system/") ||
			strings.HasPrefix(apkPath, "/product/") ||
			strings.HasPrefix(apkPath, "/vendor/") ||
			strings.HasPrefix(apkPath, "/system_ext/")
		pkgs = append(pkgs, PackageInfo{
			Package:  pkgName,
			APKPath:  apkPath,
			IsSystem: isSys,
		})
	}
	sort.Slice(pkgs, func(i, j int) bool {
		return pkgs[i].Package < pkgs[j].Package
	})
	return pkgs, nil
}

// InstallAPK installs a local APK file onto the device.
func (e *Engine) InstallAPK(ctx context.Context, serial, localAPKPath string, replace bool) (string, error) {
	installCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := []string{"-s", serial, "install"}
	if replace {
		args = append(args, "-r")
	}
	args = append(args, localAPKPath)
	out, err := e.RunADB(installCtx, args...)
	if err != nil {
		return out, fmt.Errorf("install failed: %w (%s)", err, out)
	}
	return out, nil
}

// UninstallPackage removes a package from the device.
func (e *Engine) UninstallPackage(ctx context.Context, serial, pkg string) (string, error) {
	return e.RunADB(ctx, "-s", serial, "uninstall", pkg)
}

// ClearPackageData clears app data and cache for a package.
func (e *Engine) ClearPackageData(ctx context.Context, serial, pkg string) (string, error) {
	return e.RunADB(ctx, "-s", serial, "shell", "pm", "clear", pkg)
}

// ForceStopPackage force-stops a running package.
func (e *Engine) ForceStopPackage(ctx context.Context, serial, pkg string) (string, error) {
	return e.RunADB(ctx, "-s", serial, "shell", "am", "force-stop", pkg)
}

// PullAPK pulls a package's base APK from the device to destDir and returns the saved path.
func (e *Engine) PullAPK(ctx context.Context, serial, pkg, destDir string) (string, error) {
	out, err := e.RunADB(ctx, "-s", serial, "shell", "pm", "path", pkg)
	if err != nil {
		return "", fmt.Errorf("pm path failed: %w", err)
	}
	var remotePath string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "package:") {
			remotePath = strings.TrimPrefix(line, "package:")
			break
		}
	}
	if remotePath == "" {
		return "", fmt.Errorf("no APK path found for %s", pkg)
	}
	destFile := filepath.Join(destDir, pkg+".apk")
	pullCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if pullOut, err := e.RunADB(pullCtx, "-s", serial, "pull", remotePath, destFile); err != nil {
		return "", fmt.Errorf("adb pull failed: %w (%s)", err, pullOut)
	}
	return destFile, nil
}
