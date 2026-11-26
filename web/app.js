/**
 * @fileoverview ADB Deck Web UI controller (`web/app.js`).
 *
 * Coordinates dual transport modes ("bridge" over WebSocket/REST vs. "webusb"
 * via `window.WebUSBADB`), SyncWeb Dark/Light theme persistence, the Dashboard
 * view, the 4-step wireless pairing wizard, per-device hierarchical APK
 * management, and scrcpy mirror controls.
 *
 * Security & Storage Invariants:
 *   - Bridge auth tokens from `?token=...` are copied into tab-scoped
 *     `sessionStorage` and stripped immediately from `location.search`.
 *   - Dynamic device fields and package names MUST pass through `escapeHtml()`
 *     before interpolation into `innerHTML`.
 */
const TOKEN_STORAGE_KEY = "adb_deck_token";
const BRIDGE_URL_STORAGE_KEY = "adb_deck_bridge_url";
const THEME_STORAGE_KEY = "adb_deck_theme";

const webusb = new window.WebUSBADB();

/**
 * Central client-side UI state synchronized with WebSocket snapshots (`bridge`)
 * or direct browser USB device info (`webusb`).
 */
const state = {
  mode: "bridge", // "bridge" | "webusb"
  theme: "dark",  // "dark" | "light"
  activeTab: "dashboard",
  apkManagerSerial: "",
  wizardStep: 1,
  selectedOem: "pixel",
  manualConnecting: false,
  lastPairingKey: "",
  lastPairingStatus: "",
  devices: [],
  webusbDevice: null,
  selectedSerial: "",
  packages: [],
  pairing: null,
  scrcpy: [],
  ws: null,
  wsReconnectTimer: null,
  bridgeUrl: "",
  token: "",
};

const TAB_META = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Active device & shortcuts.",
  },
  pairing: {
    title: "Pair Device",
    subtitle: "Connect wirelessly over Wi-Fi.",
  },
  devices: {
    title: "Connected Devices",
    subtitle: "Manage attached devices & APKs.",
  },
  scrcpy: {
    title: "Mirror",
    subtitle: "Host screen mirroring.",
  },
};

const WIZARD_TITLES = {
  1: "Choose Phone Type",
  2: "Scan QR Code",
  3: "Connecting",
  4: "Success",
};

const OEM_LABELS = {
  pixel: "Pixel",
  samsung: "Samsung",
  xiaomi: "Xiaomi",
  oneplus: "OnePlus",
};

const OEM_GUIDES = {
  pixel: [
    "Open Settings -> About phone.",
    "Tap Build number 7 times.",
    "Open Settings -> System -> Developer options.",
    "Enable Wireless debugging and tap Pair device with QR code.",
  ],
  samsung: [
    "Open Settings -> About phone -> Software information.",
    "Tap Build number 7 times.",
    "Open Settings -> Developer options.",
    "Enable Wireless debugging and tap Pair device with QR code.",
  ],
  xiaomi: [
    "Open Settings -> About phone and tap OS / MIUI version 7 times.",
    "Open Settings -> Additional settings -> Developer options.",
    "Enable USB debugging and Wireless debugging.",
    "Tap Pair device with QR code.",
  ],
  oneplus: [
    "Open Settings -> About device -> Version.",
    "Tap Build number 7 times.",
    "Open Settings -> System settings -> Developer options.",
    "Enable Wireless debugging and tap Pair device with QR code.",
  ],
};

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
}

// --- Theme Management (SyncWeb Dark <-> SyncWeb Light) ---

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  state.theme = next;
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (_) {}

  const btn = document.getElementById("themeToggleBtn");
  const icon = document.getElementById("themeToggleIcon");
  const label = document.getElementById("themeToggleLabel");
  if (btn && icon && label) {
    const isDark = next === "dark";
    icon.textContent = isDark ? "light_mode" : "dark_mode";
    label.textContent = isDark ? "Light mode" : "Dark mode";
    btn.setAttribute(
      "aria-label",
      isDark
        ? "Switch color theme to light mode (currently dark mode)"
        : "Switch color theme to dark mode (currently light mode)"
    );
    btn.setAttribute("aria-pressed", String(!isDark));
  }
}

function initTheme() {
  let saved = "dark";
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark") saved = raw;
  } catch (_) {}
  applyTheme(saved);
}

// --- Token & Bridge URL Management ---

function getDefaultBridgeUrl() {
  const host = location.hostname;
  if (
    (location.protocol === "http:" || location.protocol === "https:") &&
    (host === "127.0.0.1" || host === "localhost" || host === "::1")
  ) {
    return location.origin;
  }
  return "http://127.0.0.1:8787";
}

function normalizeBridgeUrl(raw) {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  return trimmed || getDefaultBridgeUrl();
}

function updateBridgeEndpointLabel() {
  const el = document.getElementById("bridgeEndpointLabel");
  if (!el) return;
  el.textContent = getBridgeBaseUrl().replace(/^https?:\/\//i, "");
}

function initAuthAndBridgeConfig() {
  const params = new URLSearchParams(location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
    params.delete("token");
    const qs = params.toString();
    const cleanUrl = `${location.pathname}${qs ? "?" + qs : ""}${location.hash}`;
    history.replaceState(null, "", cleanUrl);
  }

  state.token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  state.bridgeUrl = normalizeBridgeUrl(localStorage.getItem(BRIDGE_URL_STORAGE_KEY));
  updateBridgeEndpointLabel();
}

function getBridgeBaseUrl() {
  return state.bridgeUrl || getDefaultBridgeUrl();
}

function buildBridgeWsUrl() {
  const base = getBridgeBaseUrl();
  const wsBase = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const tokenQuery = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  return `${wsBase}/ws${tokenQuery}`;
}

function buildApkPullUrl(serial, pkg) {
  const base = getBridgeBaseUrl();
  const params = new URLSearchParams({ serial, pkg });
  if (state.token) {
    params.set("token", state.token);
  }
  return `${base}/api/apk/pull?${params.toString()}`;
}

function openBridgeModal() {
  document.getElementById("bridgeUrlInput").value = getBridgeBaseUrl();
  document.getElementById("bridgeTokenInput").value = state.token;
  document.getElementById("bridgeTokenInput").type = "password";
  document.getElementById("toggleTokenVisBtn").textContent = "Show";
  document.getElementById("bridgeModal").classList.remove("hidden");
}

function closeBridgeModal() {
  document.getElementById("bridgeModal").classList.add("hidden");
}

function setConnectionBadge(text, variant, iconName, ariaDescription) {
  const badge = document.getElementById("wsBadge");
  if (!badge) return;
  const label = document.getElementById("wsBadgeLabel");
  const icon = document.getElementById("wsBadgeIcon");
  if (label) label.textContent = text;
  if (icon && iconName) {
    icon.textContent = iconName;
    icon.classList.toggle("icon-spin", iconName === "sync");
  }
  badge.className = `header-chip badge ${variant}`;
  badge.setAttribute("aria-label", ariaDescription || text);
}

/**
 * Authenticated HTTP helper targeting the configured local bridge.
 * Automatically prompts for the Bridge Token if the server returns 401.
 * @param {string} path Relative bridge path (e.g. "/api/devices").
 * @param {RequestInit} [opts] Fetch options.
 * @returns {Promise<any>}
 */
async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }

  const url = `${getBridgeBaseUrl()}${path}`;
  const res = await fetch(url, { ...opts, headers });

  if (res.status === 401) {
    if (state.mode === "bridge") {
      setConnectionBadge(
        "Auth Required",
        "badge-danger",
        "lock",
        "Connection status: Authentication required (401). Click to enter your Bridge Token."
      );
    }
    toast("Authentication required (401). Enter your Bridge Token in Settings.");
    openBridgeModal();
    throw new Error("Unauthorized (401) — valid Bridge Token required");
  }

  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    if (!res.ok) {
      throw new Error(`Request failed (${res.status})`);
    }
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// --- WebSocket (Local Bridge Mode) ---

function disconnectWS() {
  clearTimeout(state.wsReconnectTimer);
  state.wsReconnectTimer = null;
  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try {
      old.close();
    } catch (_) {}
  }
}

function connectWS() {
  disconnectWS();
  if (state.mode !== "bridge") return;

  setConnectionBadge(
    "Connecting...",
    "badge-warn",
    "sync",
    "Bridge connection status: Connecting to local ADB bridge. Click to open Settings."
  );

  let ws;
  try {
    ws = new WebSocket(buildBridgeWsUrl());
  } catch (err) {
    setConnectionBadge(
      "Bridge Error",
      "badge-danger",
      "cloud_off",
      "Bridge connection status: Connection error. Click to open Settings."
    );
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    setConnectionBadge(
      "Bridge Live",
      "badge-ok",
      "lan",
      "Bridge connection status: Connected live over WebSocket. Click to open Settings."
    );
  };

  ws.onmessage = (ev) => {
    if (state.ws !== ws || state.mode !== "bridge") return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") {
        state.devices = msg.devices || [];
        state.pairing = msg.pairing || null;
        state.scrcpy = msg.scrcpy || [];
        syncSelectedDevice();
        renderDevices();
        renderPairing();
        renderScrcpySessions();
        renderDashboard();
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.mode !== "bridge") return;
    setConnectionBadge(
      "Reconnecting...",
      "badge-warn",
      "sync",
      "Bridge connection status: Reconnecting to local ADB bridge. Click to open Settings."
    );
    state.wsReconnectTimer = setTimeout(connectWS, 2000);
  };
}

// --- Tab Switching ---

function switchTab(tabName) {
  if (tabName === "apks") {
    openDeviceApkManager(state.selectedSerial);
    return;
  }
  const targetPanel = document.getElementById("tab-" + tabName);
  if (!targetPanel) return;

  state.activeTab = tabName;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p === targetPanel);
  });

  const meta = TAB_META[tabName] || TAB_META.dashboard;
  const titleEl = document.getElementById("pageTitle");
  const subEl = document.getElementById("pageSubtitle");
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.subtitle;

  renderSidebarDeviceTree();
}

// --- Dual Mode Switching (Local Bridge vs WebUSB) ---

function getActiveDevices() {
  if (state.mode === "webusb") {
    return state.webusbDevice ? [state.webusbDevice] : [];
  }
  return state.devices;
}

function updateModeUI() {
  const isWebUsb = state.mode === "webusb";

  document.getElementById("modeBridgeBtn").classList.toggle("active", !isWebUsb);
  document.getElementById("modeWebUsbBtn").classList.toggle("active", isWebUsb);

  const usbBtn = document.getElementById("connectUsbBtn");
  const usbLabel = document.getElementById("connectUsbLabel");
  if (usbBtn) {
    if (webusb.isConnected()) {
      if (usbLabel) usbLabel.textContent = "Disconnect USB";
      usbBtn.className = "btn btn-danger btn-sm btn-block";
    } else {
      if (usbLabel) usbLabel.textContent = "Connect USB (WebUSB)";
      usbBtn.className = "btn btn-cyan btn-sm btn-block";
    }
    usbBtn.classList.toggle("hidden", !isWebUsb && !webusb.isConnected());
  }

  document.getElementById("devicesSubtitle").textContent = isWebUsb
    ? "Direct browser USB connection."
    : "Live USB & wireless devices.";

  document.getElementById("pairingBridgeBanner").classList.toggle("hidden", !isWebUsb);
  document.getElementById("pairingContent").classList.toggle("panel-dimmed", isWebUsb);

  document.getElementById("dropZone").classList.toggle("hidden", isWebUsb);
  document.getElementById("apkWebUsbNote").classList.toggle("hidden", !isWebUsb);

  document.getElementById("scrcpyBridgeBanner").classList.toggle("hidden", !isWebUsb);
  document.getElementById("scrcpyContent").classList.toggle("panel-dimmed", isWebUsb);

  if (isWebUsb) {
    if (!window.WebUSBADB.isSupported()) {
      setConnectionBadge(
        "WebUSB Unsupported",
        "badge-danger",
        "usb_off",
        "WebUSB status: Not supported in this browser. Use Chrome or Edge on HTTPS or localhost."
      );
    } else if (webusb.isConnected()) {
      setConnectionBadge(
        "WebUSB Connected",
        "badge-cyan",
        "usb",
        "WebUSB status: Device connected in browser. Click to disconnect."
      );
    } else {
      setConnectionBadge(
        "WebUSB Ready",
        "badge-warn",
        "usb",
        "WebUSB status: Ready to connect a USB Android device. Click to select device."
      );
    }
  }
}

function setMode(newMode) {
  if (newMode !== "bridge" && newMode !== "webusb") return;
  state.mode = newMode;
  state.packages = [];

  if (newMode === "webusb") {
    disconnectWS();
  } else {
    connectWS();
  }

  updateModeUI();
  syncSelectedDevice();
  renderDevices();
  renderPackages();
  renderDashboard();
}

async function handleConnectWebUsb() {
  if (webusb.isConnected()) {
    await webusb.disconnect();
    state.webusbDevice = null;
    state.packages = [];
    updateModeUI();
    syncSelectedDevice();
    renderDevices();
    renderPackages();
    renderDashboard();
    toast("Disconnected WebUSB device");
    return;
  }

  if (!window.WebUSBADB.isSupported()) {
    setMode("webusb");
    toast("WebUSB requires Chrome or Edge over HTTPS or localhost.");
    return;
  }

  if (state.mode !== "webusb") {
    setMode("webusb");
  }

  try {
    const info = await webusb.connect((statusText) => {
      const shortText = statusText.length > 26 ? "Authorizing USB..." : statusText;
      setConnectionBadge(shortText, "badge-warn", "usb", `WebUSB status: ${statusText}`);
      toast(statusText);
    });
    state.webusbDevice = info;
    state.selectedSerial = info.serial;
    updateModeUI();
    syncSelectedDevice();
    renderDevices();
    renderDashboard();
    toast(`Connected ${info.model} via WebUSB`);
  } catch (err) {
    updateModeUI();
    if (err && err.name === "NotFoundError") {
      toast("No USB device selected.");
    } else {
      toast("WebUSB error: " + (err ? err.message : String(err)));
    }
  }
}

if (typeof navigator !== "undefined" && navigator.usb) {
  navigator.usb.addEventListener("disconnect", (ev) => {
    if (webusb.device && ev.device === webusb.device) {
      webusb.disconnect();
      state.webusbDevice = null;
      state.packages = [];
      updateModeUI();
      syncSelectedDevice();
      renderDevices();
      renderPackages();
      renderDashboard();
      toast("USB device disconnected");
    }
  });
}

// --- Dashboard Rendering ---

function getSelectedDeviceObject() {
  const devices = getActiveDevices();
  return devices.find((d) => d.serial === state.selectedSerial) || devices[0] || null;
}

function renderDashboard() {
  const hero = document.getElementById("dashboardHeroCard");
  if (!hero) return;

  const dev = getSelectedDeviceObject();
  const isWebUsb = state.mode === "webusb";

  if (!dev) {
    hero.innerHTML = `
      <div class="hero-device-info">
        <div class="hero-icon-box">
          <span class="material-symbols-outlined icon-xl" aria-hidden="true">phonelink_setup</span>
        </div>
        <div>
          <div class="hero-title-row">
            <h2>No device connected</h2>
            <span class="pill-tag pill-tag-neutral">${isWebUsb ? "WebUSB" : "Waiting"}</span>
          </div>
          <p class="muted" style="margin-top:4px;">
            ${
              isWebUsb
                ? "Connect a USB Debugging phone directly in Chrome or Edge."
                : "Plug in via USB or pair wirelessly over Wi-Fi."
            }
          </p>
        </div>
      </div>
      <div class="btn-row">
        ${
          isWebUsb
            ? `<button class="btn btn-primary" type="button" onclick="connectWebUsbDevice()">
                <span class="material-symbols-outlined icon-sm" aria-hidden="true">usb</span>
                <span>Connect USB</span>
              </button>
              <button class="btn btn-secondary" type="button" onclick="switchToBridgeMode()">Use Bridge</button>`
            : `<button class="btn btn-primary" type="button" onclick="openPairingWizard()">
                <span class="material-symbols-outlined icon-sm" aria-hidden="true">qr_code_scanner</span>
                <span>Pair Device</span>
              </button>`
        }
      </div>
    `;
  } else {
    const jsSerial = escapeHtml(JSON.stringify(dev.serial));
    const transportIcon = dev.transport === "wireless" ? "wifi" : "usb";
    const transportLabel =
      dev.transport === "wireless"
        ? "Wi-Fi"
        : dev.transport === "webusb"
          ? "WebUSB"
          : "USB";
    const stateTagClass = dev.state === "device" ? "pill-tag-success" : "pill-tag-primary";
    const stateLabel = dev.state === "device" ? "Connected" : dev.state;

    const primaryCta = isWebUsb
      ? `<button class="btn btn-primary" type="button" onclick="openApksTab()">
          <span class="material-symbols-outlined icon-sm" aria-hidden="true">install_mobile</span>
          <span>Manage APKs</span>
        </button>`
      : `<button class="btn btn-primary" type="button" onclick="quickMirror(${jsSerial})">
          <span class="material-symbols-outlined icon-sm" aria-hidden="true">${dev.mirroring ? "stop_circle" : "cast"}</span>
          <span>${dev.mirroring ? "Stop Mirroring" : "Start Mirroring"}</span>
        </button>`;

    const secondaryCta =
      !isWebUsb && dev.transport === "usb"
        ? `<button class="btn btn-secondary" type="button" onclick="switchToWifi(${jsSerial})">
            <span class="material-symbols-outlined icon-sm" aria-hidden="true">wifi</span>
            <span>Switch to Wi-Fi</span>
          </button>`
        : "";

    hero.innerHTML = `
      <div class="hero-device-info" title="${escapeHtml(dev.serial)}">
        <div class="hero-icon-box">
          <span class="material-symbols-outlined icon-xl" aria-hidden="true">phone_android</span>
        </div>
        <div style="min-width:0;">
          <div class="hero-title-row">
            <h2>${escapeHtml(dev.model || dev.serial)}</h2>
            <span class="pill-tag ${stateTagClass}">${escapeHtml(stateLabel)}</span>
            ${dev.mirroring ? `<span class="pill-tag pill-tag-primary">Mirroring</span>` : ""}
          </div>
          <div class="hero-meta-row">
            ${
              dev.battery
                ? `<span class="hero-meta-item">
                    <span class="material-symbols-outlined icon-filled" style="color:var(--success);" aria-hidden="true">battery_5_bar</span>
                    <span>${escapeHtml(dev.battery)}</span>
                  </span>`
                : ""
            }
            ${
              dev.androidVersion
                ? `<span class="hero-meta-item">
                    <span class="material-symbols-outlined" style="color:var(--primary-text);" aria-hidden="true">android</span>
                    <span>Android ${escapeHtml(dev.androidVersion)}</span>
                  </span>`
                : ""
            }
            <span class="hero-meta-item">
              <span class="material-symbols-outlined" style="color:var(--primary-text);" aria-hidden="true">${transportIcon}</span>
              <span>${transportLabel}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="btn-row">
        ${secondaryCta}
        ${primaryCta}
      </div>
    `;
  }

  // Hide Wireless QR Pairing card on Dashboard whenever a device is already connected
  const pairingCard = document.getElementById("dashPairingCard");
  if (pairingCard) {
    pairingCard.classList.toggle("hidden", Boolean(dev));
  }

  const pairingBadge = document.getElementById("dashPairingBadge");
  if (pairingBadge) {
    if (isWebUsb) {
      pairingBadge.className = "pill-tag pill-tag-neutral";
      pairingBadge.textContent = "Bridge";
    } else if (state.pairing && state.pairing.status === "waiting") {
      pairingBadge.className = "pill-tag pill-tag-primary";
      pairingBadge.textContent = "Listening";
    } else if (state.pairing && state.pairing.status === "paired") {
      pairingBadge.className = "pill-tag pill-tag-success";
      pairingBadge.textContent = "Paired";
    } else {
      pairingBadge.className = "pill-tag pill-tag-primary";
      pairingBadge.textContent = "Ready";
    }
  }

  const scrcpyBadge = document.getElementById("dashScrcpyBadge");
  if (scrcpyBadge) {
    if (state.scrcpy.length > 0) {
      scrcpyBadge.className = "pill-tag pill-tag-success";
      scrcpyBadge.textContent = `${state.scrcpy.length} active`;
    } else {
      scrcpyBadge.className = "pill-tag pill-tag-neutral";
      scrcpyBadge.textContent = isWebUsb ? "Bridge" : "Idle";
    }
  }

  const apkBadge = document.getElementById("dashApkBadge");
  if (apkBadge) {
    if (state.packages.length > 0) {
      apkBadge.className = "pill-tag pill-tag-primary";
      apkBadge.textContent = `${state.packages.length} apps`;
    } else {
      apkBadge.className = "pill-tag pill-tag-neutral";
      apkBadge.textContent = dev ? "Ready" : "No device";
    }
  }
}

window.openPairingWizard = () => {
  switchTab("pairing");
  setWizardStep(1);
};

window.openApksTab = () => {
  openDeviceApkManager(state.selectedSerial);
};

// --- Hierarchical Device APK Manager & Sidebar Tree ---

function renderSidebarDeviceTree() {
  const tree = document.getElementById("sidebarDeviceTree");
  if (!tree) return;
  const devices = getActiveDevices();
  if (!devices.length) {
    tree.innerHTML = "";
    tree.classList.add("hidden");
    return;
  }

  tree.classList.remove("hidden");
  tree.innerHTML = devices
    .map((d) => {
      const isOpen = state.activeTab === "devices" && state.apkManagerSerial === d.serial;
      const jsSerial = escapeHtml(JSON.stringify(d.serial));
      return `
        <li class="nav-device-group">
          <div class="nav-device-label" title="${escapeHtml(d.serial)}">
            <span class="material-symbols-outlined" aria-hidden="true">phone_android</span>
            <span>${escapeHtml(d.model || d.serial)}</span>
          </div>
          <button class="nav-child-btn ${isOpen ? "active" : ""}" type="button" onclick="openDeviceApkManager(${jsSerial})">
            <span class="material-symbols-outlined icon-sm" aria-hidden="true">install_mobile</span>
            <span>APK Manager</span>
          </button>
        </li>
      `;
    })
    .join("");
}

function syncDeviceApkPanel() {
  const panel = document.getElementById("deviceApkPanel");
  if (!panel) return;
  const devices = getActiveDevices();
  const target = devices.find((d) => d.serial === state.apkManagerSerial);

  if (!target) {
    state.apkManagerSerial = "";
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  const nameEl = document.getElementById("apkTargetDeviceName");
  const serialEl = document.getElementById("apkTargetDeviceSerial");
  if (nameEl) nameEl.textContent = target.model || target.serial;
  if (serialEl) serialEl.textContent = target.serial;
}

window.openDeviceApkManager = (serial) => {
  const devices = getActiveDevices();
  const target =
    devices.find((d) => d.serial === serial) ||
    devices.find((d) => d.serial === state.selectedSerial) ||
    devices[0];

  if (!target) {
    state.apkManagerSerial = "";
    switchTab("devices");
    syncDeviceApkPanel();
    renderSidebarDeviceTree();
    toast("Connect a device first to open its APK Manager");
    return;
  }

  const changedDevice = state.selectedSerial !== target.serial || state.apkManagerSerial !== target.serial;
  state.selectedSerial = target.serial;
  state.apkManagerSerial = target.serial;
  if (changedDevice) {
    state.packages = [];
  }

  switchTab("devices");
  syncSelectedDevice();
  renderDevices();
  syncDeviceApkPanel();
  renderSidebarDeviceTree();

  const panel = document.getElementById("deviceApkPanel");
  if (panel) {
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (!state.packages.length || changedDevice) {
    loadPackages();
  }
};

function closeDeviceApkManager() {
  state.apkManagerSerial = "";
  syncDeviceApkPanel();
  renderSidebarDeviceTree();
}

// --- Devices Rendering & Actions ---

function syncSelectedDevice() {
  const wrap = document.getElementById("sidebarDeviceWrap");
  const select = document.getElementById("deviceSelect");
  const devices = getActiveDevices();

  if (wrap) {
    wrap.classList.toggle("hidden", devices.length < 2);
  }

  if (!devices.length) {
    state.selectedSerial = "";
    if (select) select.innerHTML = `<option value="">No devices</option>`;
    return;
  }
  if (!devices.some((d) => d.serial === state.selectedSerial)) {
    state.selectedSerial = devices[0].serial;
  }
  if (select) {
    select.innerHTML = devices
      .map(
        (d) =>
          `<option value="${escapeHtml(d.serial)}" ${d.serial === state.selectedSerial ? "selected" : ""}>${escapeHtml(d.model)} (${escapeHtml(d.transport)})</option>`
      )
      .join("");
  }
}

function renderDevices() {
  const grid = document.getElementById("devicesGrid");
  const devices = getActiveDevices();

  renderSidebarDeviceTree();
  syncDeviceApkPanel();

  if (!devices.length) {
    if (state.mode === "webusb") {
      const supported = window.WebUSBADB.isSupported();
      grid.innerHTML = `
        <div class="card">
          <h3>Zero-Install WebUSB</h3>
          <p class="muted" style="margin:6px 0 14px;">
            ${
              supported
                ? "Connect an Android device over USB directly from Chrome or Edge."
                : "WebUSB requires Chrome or Edge over HTTPS or localhost."
            }
          </p>
          <div class="btn-row">
            ${
              supported
                ? `<button class="btn btn-primary btn-sm" type="button" onclick="connectWebUsbDevice()">Connect USB</button>`
                : ""
            }
            <button class="btn btn-secondary btn-sm" type="button" onclick="switchToBridgeMode()">Use Bridge</button>
          </div>
        </div>
      `;
    } else {
      grid.innerHTML = `
        <div class="card">
          <h3>No devices connected</h3>
          <p class="muted" style="margin:6px 0 14px;">Plug in via USB or start wireless QR pairing.</p>
          <div class="btn-row">
            <button class="btn btn-primary btn-sm" type="button" onclick="openPairingWizard()">Pair Device</button>
          </div>
        </div>
      `;
    }
    return;
  }

  grid.innerHTML = devices
    .map((d) => {
      const isSelected = d.serial === state.selectedSerial;
      const isApkOpen = state.apkManagerSerial === d.serial;
      const isWebUsb = d.transport === "webusb";
      const badgeClass =
        d.transport === "wireless" || isWebUsb ? "badge-cyan" : "badge-ok";
      const safeSerial = escapeHtml(d.serial);
      const jsSerial = escapeHtml(JSON.stringify(d.serial));

      const actionsHtml = isWebUsb
        ? `
          <button class="btn ${isApkOpen ? "btn-cyan" : "btn-secondary"} btn-sm" type="button" onclick="openDeviceApkManager(${jsSerial})">
            <span class="material-symbols-outlined icon-sm" aria-hidden="true">install_mobile</span>
            <span>${isApkOpen ? "APKs Open" : "APKs"}</span>
          </button>
          <button class="btn btn-secondary btn-sm" type="button" onclick="refreshWebUsbDevice()">Refresh</button>
          <button class="btn btn-danger btn-sm" type="button" onclick="connectWebUsbDevice()">Disconnect</button>
        `
        : `
          <button class="btn btn-primary btn-sm" type="button" onclick="quickMirror(${jsSerial})">${d.mirroring ? "Stop Mirror" : "Mirror"}</button>
          <button class="btn ${isApkOpen ? "btn-cyan" : "btn-secondary"} btn-sm" type="button" onclick="openDeviceApkManager(${jsSerial})">
            <span class="material-symbols-outlined icon-sm" aria-hidden="true">install_mobile</span>
            <span>${isApkOpen ? "APKs Open" : "APKs"}</span>
          </button>
          ${
            d.transport === "usb"
              ? `<button class="btn btn-secondary btn-sm" type="button" onclick="switchToWifi(${jsSerial})">Wi-Fi</button>`
              : `<button class="btn btn-danger btn-sm" type="button" onclick="disconnectDevice(${jsSerial})">Disconnect</button>`
          }
        `;

      return `
        <div class="device-card ${isSelected ? "selected" : ""}" onclick="handleDeviceCardClick(event, ${jsSerial})">
          <div class="device-card-head">
            <span class="device-card-title">${escapeHtml(d.model || d.serial)}</span>
            <span class="badge ${badgeClass}">${escapeHtml(d.transport.toUpperCase())}</span>
          </div>
          <div class="mono mono-truncate" title="${safeSerial}">${safeSerial}</div>
          <div class="device-meta">
            <span>${escapeHtml(d.state)}</span>
            ${d.androidVersion ? `<span>&middot; Android ${escapeHtml(d.androidVersion)}</span>` : ""}
            ${d.battery ? `<span>&middot; ${escapeHtml(d.battery)}</span>` : ""}
            ${d.mirroring ? `<span style="color:var(--primary-text);font-weight:600;">&middot; Mirroring</span>` : ""}
          </div>
          <div class="btn-row">${actionsHtml}</div>
        </div>
      `;
    })
    .join("");
}

window.handleDeviceCardClick = (event, serial) => {
  if (event.target.closest("button, a")) return;
  if (state.selectedSerial !== serial) {
    window.selectDevice(serial);
  }
};

window.connectWebUsbDevice = handleConnectWebUsb;
window.switchToBridgeMode = () => setMode("bridge");

window.refreshWebUsbDevice = async () => {
  if (!webusb.isConnected()) return;
  try {
    state.webusbDevice = await webusb.getDeviceInfo();
    syncSelectedDevice();
    renderDevices();
    renderDashboard();
    toast("Refreshed WebUSB device info");
  } catch (e) {
    toast("Refresh failed: " + e.message);
  }
};

window.selectDevice = (serial) => {
  state.selectedSerial = serial;
  syncSelectedDevice();
  renderDevices();
  renderDashboard();
  toast(`Selected ${serial}`);
};

window.quickMirror = async (serial) => {
  const dev = state.devices.find((d) => d.serial === serial);
  try {
    if (dev && dev.mirroring) {
      await api("/api/scrcpy/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }),
      });
      toast("Stopped scrcpy mirror");
    } else {
      await api("/api/scrcpy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, maxSize: 1440, bitRate: "16M", stayAwake: true }),
      });
      toast("Launched scrcpy on host");
    }
  } catch (e) {
    toast("scrcpy error: " + e.message);
  }
};

window.switchToWifi = async (serial) => {
  try {
    const res = await api("/api/devices/wifi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial }),
    });
    toast(res.message || "Switched to Wi-Fi");
  } catch (e) {
    toast("Wi-Fi handoff failed: " + e.message);
  }
};

window.disconnectDevice = async (serial) => {
  try {
    await api("/api/devices/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial }),
    });
    toast("Disconnected " + serial);
  } catch (e) {
    toast("Disconnect error: " + e.message);
  }
};

// --- Pairing Onboarding Wizard & OEM Guide ---

function setTaskState(id, status, stateText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("done", "active", "error");
  const icon = el.querySelector(".material-symbols-outlined");
  const label = el.querySelector(".task-state-label");

  if (status === "done") {
    el.classList.add("done");
    if (icon) {
      icon.classList.remove("icon-spin");
      icon.textContent = "check_circle";
    }
    if (label) label.textContent = stateText || "Done";
  } else if (status === "active") {
    el.classList.add("active");
    if (icon) {
      icon.classList.add("icon-spin");
      icon.textContent = "progress_activity";
    }
    if (label) label.textContent = stateText || "In progress";
  } else if (status === "error") {
    el.classList.add("error");
    if (icon) {
      icon.classList.remove("icon-spin");
      icon.textContent = "error";
    }
    if (label) label.textContent = stateText || "Failed";
  } else {
    if (icon) {
      icon.classList.remove("icon-spin");
      icon.textContent = "radio_button_unchecked";
    }
    if (label) label.textContent = stateText || "Waiting";
  }
}

function updateConnectingUI() {
  const heading = document.getElementById("connectingHeading");
  const subtitle = document.getElementById("connectingSubtitle");
  const pctEl = document.getElementById("connectingProgressPct");
  const barEl = document.getElementById("connectingProgressBar");
  const emblem = document.getElementById("connectingEmblem");
  const emblemIcon = document.getElementById("connectingEmblemIcon");
  if (!heading || !barEl) return;

  const progressTrack = barEl.parentElement;
  let pct = 15;

  if (state.manualConnecting) {
    pct = 68;
    heading.textContent = "Connecting";
    subtitle.textContent = "Completing wireless ADB handshake...";
    emblem.className = "emblem-circle emblem-primary";
    emblemIcon.textContent = "sync";
    emblemIcon.classList.add("icon-spin");
    setTaskState("connectTask1", "done", "Done");
    setTaskState("connectTask2", "done", "Done");
    setTaskState("connectTask3", "active", "In progress");
    setTaskState("connectTask4", "waiting", "Waiting");
  } else if (state.pairing && state.pairing.status === "paired") {
    pct = 100;
    heading.textContent = "Paired";
    subtitle.textContent = state.pairing.message || "Wireless ADB connected.";
    emblem.className = "emblem-circle emblem-success";
    emblemIcon.textContent = "check_circle";
    emblemIcon.classList.remove("icon-spin");
    setTaskState("connectTask1", "done", "Done");
    setTaskState("connectTask2", "done", "Done");
    setTaskState("connectTask3", "done", "Done");
    setTaskState("connectTask4", "done", "Done");
  } else if (state.pairing && state.pairing.status === "error") {
    pct = 40;
    heading.textContent = "Pairing failed";
    subtitle.textContent = state.pairing.message || "Could not pair device.";
    emblem.className = "emblem-circle emblem-error";
    emblemIcon.textContent = "error";
    emblemIcon.classList.remove("icon-spin");
    setTaskState("connectTask1", "done", "Done");
    setTaskState("connectTask2", "error", "Failed");
    setTaskState("connectTask3", "waiting", "Waiting");
    setTaskState("connectTask4", "waiting", "Waiting");
  } else if (state.pairing && state.pairing.status === "waiting") {
    pct = 35;
    heading.textContent = "Waiting for scan";
    subtitle.textContent = "Scan the QR code with your phone.";
    emblem.className = "emblem-circle emblem-primary";
    emblemIcon.textContent = "sync";
    emblemIcon.classList.add("icon-spin");
    setTaskState("connectTask1", "active", "Listening");
    setTaskState("connectTask2", "waiting", "Waiting");
    setTaskState("connectTask3", "waiting", "Waiting");
    setTaskState("connectTask4", "waiting", "Waiting");
  } else {
    pct = 10;
    heading.textContent = "Ready";
    subtitle.textContent = "Generate a QR code to start.";
    emblem.className = "emblem-circle emblem-primary";
    emblemIcon.textContent = "sync";
    emblemIcon.classList.remove("icon-spin");
    setTaskState("connectTask1", "waiting", "Waiting");
    setTaskState("connectTask2", "waiting", "Waiting");
    setTaskState("connectTask3", "waiting", "Waiting");
    setTaskState("connectTask4", "waiting", "Waiting");
  }

  pctEl.textContent = `${pct}%`;
  barEl.style.width = `${pct}%`;
  if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(pct));
}

function updateSuccessUI(overrideDeviceLabel) {
  const textEl = document.getElementById("successDeviceText");
  const countPill = document.getElementById("successDeviceCountPill");
  const devices = getActiveDevices();
  const targetLabel =
    overrideDeviceLabel ||
    (state.pairing && state.pairing.pairedAddr) ||
    (devices[0] ? `${devices[0].model}` : "Your device");

  if (textEl) {
    textEl.textContent = `${targetLabel} is paired over Wi-Fi.`;
  }
  if (countPill) {
    const count = Math.max(1, devices.length);
    countPill.textContent = `${count} Linked`;
  }
}

function setWizardStep(step) {
  const s = Math.max(1, Math.min(4, Number(step) || 1));
  state.wizardStep = s;

  for (let i = 1; i <= 4; i++) {
    const panel = document.getElementById(`wizardStep${i}`);
    if (panel) panel.classList.toggle("active", i === s);
  }

  document.querySelectorAll("[data-step-bar]").forEach((bar) => {
    const idx = Number(bar.dataset.stepBar);
    bar.classList.toggle("done", idx <= s);
  });

  document.querySelectorAll("[data-step-target]").forEach((btn) => {
    const idx = Number(btn.dataset.stepTarget);
    btn.classList.toggle("active", idx === s);
    btn.classList.toggle("done", idx < s);
  });

  const titleEl = document.getElementById("wizardStepTitle");
  const pillEl = document.getElementById("wizardStepPill");
  if (titleEl) titleEl.textContent = WIZARD_TITLES[s] || "Pair Device";
  if (pillEl) pillEl.textContent = `Step ${s} of 4`;

  if (s === 3) updateConnectingUI();
  if (s === 4) updateSuccessUI();
}

async function startQrPairing() {
  if (state.mode !== "bridge") {
    toast("Switch to Local Bridge mode to generate a wireless pairing QR code.");
    return;
  }
  try {
    const res = await api("/api/pairing/qr", { method: "POST" });
    state.pairing = res.session;
    state.lastPairingKey = res.session ? res.session.serviceName : "";
    state.lastPairingStatus = res.session ? res.session.status : "";
    renderPairing();
    renderDashboard();
    toast("Live QR pairing started");
  } catch (e) {
    toast("QR failed: " + e.message);
  }
}

function renderPairing() {
  const img = document.getElementById("qrImage");
  const placeholder = document.getElementById("qrPlaceholder");
  const status = document.getElementById("qrStatus");
  const codePill = document.getElementById("qrCodePill");

  if (!state.pairing) {
    img.classList.add("hidden");
    placeholder.classList.remove("hidden");
    if (codePill) {
      codePill.textContent = "Not started";
      codePill.className = "badge badge-warn";
    }
    if (status) {
      status.textContent = "Ready to start mDNS pairing.";
    }
    if (state.wizardStep === 3) updateConnectingUI();
    return;
  }

  img.src = state.pairing.qrPngDataUrl;
  img.classList.remove("hidden");
  placeholder.classList.add("hidden");
  status.textContent = `${state.pairing.message}`;

  if (codePill) {
    if (state.pairing.status === "paired") {
      codePill.textContent = state.pairing.pairedAddr || "Paired";
      codePill.className = "badge badge-ok";
    } else if (state.pairing.status === "error") {
      codePill.textContent = "Error";
      codePill.className = "badge badge-danger";
    } else if (state.pairing.status === "waiting") {
      codePill.textContent = state.pairing.password ? `PIN ${state.pairing.password}` : "Listening";
      codePill.className = "badge badge-cyan";
    } else {
      codePill.textContent = state.pairing.status.toUpperCase();
      codePill.className = "badge badge-warn";
    }
  }

  const sessionKey = state.pairing.serviceName || "";
  const prevStatus = state.lastPairingKey === sessionKey ? state.lastPairingStatus : "";
  state.lastPairingKey = sessionKey;
  state.lastPairingStatus = state.pairing.status;

  if (prevStatus === "waiting" && state.pairing.status === "paired") {
    updateConnectingUI();
    if (state.activeTab === "pairing") {
      setWizardStep(3);
      setTimeout(() => {
        if (state.activeTab === "pairing" && state.pairing && state.pairing.status === "paired") {
          setWizardStep(4);
        }
      }, 650);
    }
    toast(`Paired wirelessly: ${state.pairing.pairedAddr || "device connected"}`);
  } else if (state.wizardStep === 3) {
    updateConnectingUI();
  } else if (state.wizardStep === 4) {
    updateSuccessUI();
  }
}

function renderOEM(oem) {
  state.selectedOem = OEM_GUIDES[oem] ? oem : "pixel";
  document.querySelectorAll(".oem-option").forEach((opt) => {
    opt.setAttribute("aria-checked", String(opt.dataset.oem === state.selectedOem));
  });
  const guideName = document.getElementById("oemGuideName");
  if (guideName) {
    guideName.textContent = OEM_LABELS[state.selectedOem] || "Pixel";
  }
  const list = document.getElementById("oemSteps");
  if (list) {
    list.innerHTML = OEM_GUIDES[state.selectedOem]
      .map((s) => `<li>${escapeHtml(s)}</li>`)
      .join("");
  }
}

// --- APK Manager (Bridge + WebUSB) ---

async function loadPackages() {
  const sys = document.getElementById("showSystemToggle").checked;

  if (state.mode === "webusb") {
    if (!webusb.isConnected()) {
      toast("Connect a USB device via WebUSB first");
      return;
    }
    try {
      toast("Loading packages over WebUSB...");
      state.packages = await webusb.listPackages(sys);
      renderPackages();
      renderDashboard();
    } catch (e) {
      toast("WebUSB package list failed: " + e.message);
    }
    return;
  }

  if (!state.selectedSerial) {
    toast("Select a connected device first");
    return;
  }
  try {
    const res = await api(
      `/api/apk/list?serial=${encodeURIComponent(state.selectedSerial)}&system=${sys}`
    );
    state.packages = res.packages || [];
    renderPackages();
    renderDashboard();
  } catch (e) {
    toast("Failed to load packages: " + e.message);
  }
}

function renderPackages() {
  const query = document.getElementById("apkSearch").value.trim().toLowerCase();
  const filtered = state.packages.filter((p) =>
    p.package.toLowerCase().includes(query)
  );
  document.getElementById("apkCount").textContent = `${filtered.length}`;
  const list = document.getElementById("apkList");
  if (!filtered.length) {
    list.innerHTML = `<div class="apk-row muted">No packages loaded. Click Reload.</div>`;
    return;
  }

  const isWebUsb = state.mode === "webusb";
  list.innerHTML = filtered
    .slice(0, 200)
    .map((p) => {
      const safePkg = escapeHtml(p.package);
      const jsPkg = escapeHtml(JSON.stringify(p.package));
      const secondaryBtn = isWebUsb
        ? `<button class="btn btn-secondary btn-sm" type="button" onclick="apkAction(${jsPkg},'clear')">Clear Data</button>`
        : `<a class="btn btn-secondary btn-sm" href="${escapeHtml(buildApkPullUrl(state.selectedSerial, p.package))}">Pull</a>`;
      const extraMenuItems = isWebUsb
        ? `<button class="row-menu-item row-menu-danger" type="button" onclick="apkAction(${jsPkg},'uninstall')">Uninstall</button>`
        : `<button class="row-menu-item" type="button" onclick="apkAction(${jsPkg},'clear')">Clear data</button>
           <button class="row-menu-item row-menu-danger" type="button" onclick="apkAction(${jsPkg},'uninstall')">Uninstall</button>`;
      return `
      <div class="apk-row">
        <span class="apk-name">${safePkg}</span>
        <div class="btn-row" style="flex-wrap:nowrap;">
          <button class="btn btn-secondary btn-sm" type="button" onclick="apkAction(${jsPkg},'force-stop')">Stop</button>
          ${secondaryBtn}
          <details class="row-menu">
            <summary class="btn btn-secondary btn-sm row-menu-trigger" aria-label="More actions for ${safePkg}">
              <span class="material-symbols-outlined icon-sm" aria-hidden="true">more_horiz</span>
            </summary>
            <div class="row-menu-pop">
              ${extraMenuItems}
            </div>
          </details>
        </div>
      </div>`;
    })
    .join("");
}

window.apkAction = async (pkg, action) => {
  document.querySelectorAll(".row-menu[open]").forEach((m) => m.removeAttribute("open"));
  if (action === "uninstall" && !confirm(`Uninstall ${pkg}?`)) return;

  if (state.mode === "webusb") {
    try {
      const res = await webusb.apkAction(pkg, action);
      toast(`${action} ${pkg}: ${res.output || "done"}`);
      if (action === "uninstall") loadPackages();
    } catch (e) {
      toast("WebUSB APK action failed: " + e.message);
    }
    return;
  }

  try {
    const res = await api("/api/apk/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: state.selectedSerial, package: pkg, action }),
    });
    toast(`${action} ${pkg}: ${res.output || "done"}`);
    if (action === "uninstall") loadPackages();
  } catch (e) {
    toast("APK action failed: " + e.message);
  }
};

async function installAPKFile(file) {
  if (state.mode === "webusb") {
    toast("APK install requires Local Bridge mode.");
    return;
  }
  if (!state.selectedSerial) {
    toast("Select a connected device first");
    return;
  }
  toast(`Installing ${file.name}...`);
  const form = new FormData();
  form.append("serial", state.selectedSerial);
  form.append("apk", file);
  try {
    const res = await api("/api/apk/install", { method: "POST", body: form });
    toast(`Installed ${file.name}: ${res.output}`);
    loadPackages();
  } catch (e) {
    toast("Install failed: " + e.message);
  }
}

function renderScrcpySessions() {
  const el = document.getElementById("scrcpySessions");
  const stopBtn = document.getElementById("stopScrcpyBtn");
  const isSelectedActive = state.scrcpy.some((s) => s.serial === state.selectedSerial);
  if (stopBtn) stopBtn.disabled = !isSelectedActive;

  if (!el) return;
  if (!state.scrcpy.length) {
    el.textContent = "Idle";
    el.className = "pill-tag pill-tag-neutral";
    return;
  }
  el.className = "pill-tag pill-tag-success";
  el.textContent =
    "Active · " +
    state.scrcpy.map((s) => `PID ${s.pid}`).join(", ");
}

// --- Wire up UI events ---

document.addEventListener("click", (e) => {
  const openMenu = e.target.closest(".row-menu");
  document.querySelectorAll(".row-menu[open]").forEach((m) => {
    if (m !== openMenu) m.removeAttribute("open");
  });
});

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("themeToggleBtn").addEventListener("click", () => {
  applyTheme(state.theme === "dark" ? "light" : "dark");
});

document.getElementById("wsBadge").addEventListener("click", () => {
  if (state.mode === "webusb") {
    handleConnectWebUsb();
  } else {
    openBridgeModal();
  }
});

document.getElementById("closeDeviceApkBtn").addEventListener("click", closeDeviceApkManager);

document.getElementById("dashOpenPairingBtn").addEventListener("click", () => switchTab("pairing"));
document.getElementById("dashOpenScrcpyBtn").addEventListener("click", () => switchTab("scrcpy"));
document.getElementById("dashOpenApksBtn").addEventListener("click", () => {
  openDeviceApkManager(state.selectedSerial);
});

// Wizard navigation & OEM radio options
document.querySelectorAll(".oem-option").forEach((opt) => {
  const pick = () => renderOEM(opt.dataset.oem);
  opt.addEventListener("click", pick);
  opt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  });
});

document.querySelectorAll("[data-step-target]").forEach((btn) => {
  btn.addEventListener("click", () => setWizardStep(Number(btn.dataset.stepTarget)));
});

document.getElementById("wizardCloseBtn").addEventListener("click", () => switchTab("dashboard"));
document.getElementById("wizardToQrBtn").addEventListener("click", () => {
  setWizardStep(2);
  if (state.mode === "bridge" && (!state.pairing || state.pairing.status !== "waiting")) {
    startQrPairing();
  }
});
document.getElementById("wizardBackToOemBtn").addEventListener("click", () => setWizardStep(1));
document.getElementById("wizardBackToQrBtn").addEventListener("click", () => setWizardStep(2));
document.getElementById("wizardPairAnotherBtn").addEventListener("click", () => setWizardStep(1));
document.getElementById("wizardOpenDashboardBtn").addEventListener("click", () => switchTab("dashboard"));

document.getElementById("toggleManualPairBtn").addEventListener("click", () => {
  const panel = document.getElementById("manualPairPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    document.getElementById("pairAddr").focus();
  }
});

document.getElementById("modeBridgeBtn").addEventListener("click", () => setMode("bridge"));
document.getElementById("modeWebUsbBtn").addEventListener("click", () => setMode("webusb"));
document.getElementById("connectUsbBtn").addEventListener("click", handleConnectWebUsb);
document.querySelectorAll(".switch-to-bridge-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode("bridge"));
});

// Settings modal events
document.getElementById("bridgeSettingsBtn").addEventListener("click", openBridgeModal);
document.getElementById("closeBridgeModalBtn").addEventListener("click", closeBridgeModal);
document.getElementById("cancelBridgeModalBtn").addEventListener("click", closeBridgeModal);
document.getElementById("bridgeModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeBridgeModal();
});
document.getElementById("toggleTokenVisBtn").addEventListener("click", () => {
  const inp = document.getElementById("bridgeTokenInput");
  const btn = document.getElementById("toggleTokenVisBtn");
  if (inp.type === "password") {
    inp.type = "text";
    btn.textContent = "Hide";
  } else {
    inp.type = "password";
    btn.textContent = "Show";
  }
});
document.getElementById("clearBridgeTokenBtn").addEventListener("click", () => {
  state.token = "";
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  document.getElementById("bridgeTokenInput").value = "";
  toast("Bridge token cleared");
});
document.getElementById("saveBridgeSettingsBtn").addEventListener("click", () => {
  const rawUrl = document.getElementById("bridgeUrlInput").value;
  const rawToken = document.getElementById("bridgeTokenInput").value.trim();

  state.bridgeUrl = normalizeBridgeUrl(rawUrl);
  localStorage.setItem(BRIDGE_URL_STORAGE_KEY, state.bridgeUrl);
  updateBridgeEndpointLabel();

  state.token = rawToken;
  if (rawToken) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, rawToken);
  } else {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  closeBridgeModal();
  if (state.mode === "bridge") {
    connectWS();
  }
  toast("Settings saved");
});

document.getElementById("deviceSelect").addEventListener("change", (e) => {
  state.selectedSerial = e.target.value;
  if (state.apkManagerSerial && state.selectedSerial) {
    state.apkManagerSerial = state.selectedSerial;
    state.packages = [];
    loadPackages();
  }
  renderDevices();
  renderDashboard();
});

document.getElementById("refreshDevicesBtn").addEventListener("click", async () => {
  if (state.mode === "webusb") {
    if (!webusb.isConnected()) {
      toast("No WebUSB device connected");
      return;
    }
    await window.refreshWebUsbDevice();
    return;
  }

  try {
    const res = await api("/api/devices");
    state.devices = res.devices || [];
    syncSelectedDevice();
    renderDevices();
    renderDashboard();
    toast("Devices refreshed");
  } catch (e) {
    toast(e.message);
  }
});

document.getElementById("startQrBtn").addEventListener("click", startQrPairing);

document.getElementById("pairCodeBtn").addEventListener("click", async () => {
  const address = document.getElementById("pairAddr").value.trim();
  const code = document.getElementById("pairCode").value.trim();
  if (!address || !code) {
    toast("Enter both pairing IP:Port and 6-digit code");
    return;
  }
  state.manualConnecting = true;
  setWizardStep(3);
  try {
    const res = await api("/api/pairing/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, code }),
    });
    state.manualConnecting = false;
    updateSuccessUI(address);
    setWizardStep(4);
    toast(res.output || "Paired!");
  } catch (e) {
    state.manualConnecting = false;
    setWizardStep(2);
    document.getElementById("manualPairPanel").classList.remove("hidden");
    toast(e.message);
  }
});

document.getElementById("connectBtn").addEventListener("click", async () => {
  const address = document.getElementById("connectAddr").value.trim();
  if (!address) {
    toast("Enter a wireless device IP:Port to connect");
    return;
  }
  state.manualConnecting = true;
  setWizardStep(3);
  try {
    const res = await api("/api/devices/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    state.manualConnecting = false;
    updateSuccessUI(address);
    setWizardStep(4);
    toast(res.output || "Connected!");
  } catch (e) {
    state.manualConnecting = false;
    setWizardStep(2);
    document.getElementById("manualPairPanel").classList.remove("hidden");
    toast(e.message);
  }
});

document.getElementById("loadApksBtn").addEventListener("click", loadPackages);
document.getElementById("showSystemToggle").addEventListener("change", loadPackages);
document.getElementById("apkSearch").addEventListener("input", renderPackages);

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("apkFileInput");
document.getElementById("pickApkBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) installAPKFile(fileInput.files[0]);
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) installAPKFile(e.dataTransfer.files[0]);
});

document.getElementById("startScrcpyBtn").addEventListener("click", async () => {
  if (!state.selectedSerial) return toast("Select a device first");
  try {
    await api("/api/scrcpy/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serial: state.selectedSerial,
        maxSize: parseInt(document.getElementById("scrcpyMaxSize").value, 10),
        bitRate: document.getElementById("scrcpyBitRate").value,
        stayAwake: document.getElementById("scrcpyStayAwake").checked,
        turnScreenOff: document.getElementById("scrcpyScreenOff").checked,
        alwaysOnTop: document.getElementById("scrcpyAlwaysOnTop").checked,
        noAudio: document.getElementById("scrcpyNoAudio").checked,
      }),
    });
    toast("Launched scrcpy mirror");
  } catch (e) {
    toast("scrcpy failed: " + e.message);
  }
});

document.getElementById("stopScrcpyBtn").addEventListener("click", async () => {
  if (!state.selectedSerial) return;
  try {
    await api("/api/scrcpy/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: state.selectedSerial }),
    });
    toast("Stopped scrcpy mirror");
  } catch (e) {
    toast(e.message);
  }
});

function isLocalHostOrigin() {
  const h = location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "";
}

/**
 * Selects Local Bridge or zero-install WebUSB on startup.
 * On external HTTPS origins (e.g. GitHub Pages) without an explicit bridge token,
 * probes `/api/ping` briefly and falls back cleanly to WebUSB if no helper runs locally.
 */
async function initConnectionMode() {
  if (isLocalHostOrigin() || Boolean(state.token)) {
    connectWS();
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch(`${getBridgeBaseUrl()}/api/ping`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok) {
        connectWS();
        return;
      }
    }
  } catch (_) {
    // No local bridge detected from external origin; fall back to WebUSB.
  } finally {
    clearTimeout(timer);
  }

  setMode("webusb");
}

// Initialize
initTheme();
initAuthAndBridgeConfig();
renderOEM("pixel");
setWizardStep(1);
updateModeUI();
syncSelectedDevice();
renderDevices();
renderScrcpySessions();
renderDashboard();
initConnectionMode();
