/**
 * Zero-dependency Browser WebUSB ADB client for ADB Deck.
 * Implements ADB USB transport framing (24-byte header, CNXN, AUTH RSA-2048,
 * OPEN/OKAY/WRTE/CLSE) and high-level device & package helpers.
 */
(function (global) {
  "use strict";

  const A_SYNC = 0x434e5953;
  const A_CNXN = 0x4e584e43;
  const A_OPEN = 0x4e45504f;
  const A_OKAY = 0x59414b4f;
  const A_CLSE = 0x45534c43;
  const A_WRTE = 0x45545257;
  const A_AUTH = 0x48545541;

  const A_VERSION = 0x01000000;
  const MAX_PAYLOAD = 256 * 1024;

  const AUTH_TOKEN = 1;
  const AUTH_SIGNATURE = 2;
  const AUTH_RSAPUBLICKEY = 3;

  const ADB_CLASS = 0xff;
  const ADB_SUBCLASS = 0x42;
  const ADB_PROTOCOL = 0x01;

  const RSA_STORAGE_KEY = "adb_deck_webusb_rsa_jwk";
  const SAFE_PKG_RE = /^[a-zA-Z0-9._-]+$/;

  // ASN.1 DigestInfo prefix for SHA-1 (used by Android adbd RSASSA-PKCS1-v1_5)
  const SHA1_DIGEST_INFO_PREFIX = new Uint8Array([
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e,
    0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
  ]);

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder("utf-8", { fatal: false });

  // --- Base64URL & BigInt Math Helpers for ADB RSA-2048 ---

  function base64UrlToBytes(b64url) {
    const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function bytesToBigIntBE(bytes) {
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return BigInt(hex);
  }

  function bigIntToBytesBE(val, length) {
    const out = new Uint8Array(length);
    let v = val;
    for (let i = length - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  function modPow(base, exp, mod) {
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) {
        result = (result * b) % mod;
      }
      e >>= 1n;
      b = (b * b) % mod;
    }
    return result;
  }

  function modInverse(a, m) {
    let m0 = m;
    let x0 = 0n;
    let x1 = 1n;
    let aa = ((a % m) + m) % m;
    while (aa > 1n) {
      const q = aa / m;
      let t = m;
      m = aa % m;
      aa = t;
      t = x0;
      x0 = x1 - q * x0;
      x1 = t;
    }
    if (x1 < 0n) x1 += m0;
    return x1;
  }

  async function getOrCreateRsaJwk() {
    try {
      const cached = localStorage.getItem(RSA_STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.n && parsed.e && parsed.d) {
          return parsed;
        }
      }
    } catch (_) {
      // Ignore storage read errors and generate a fresh keypair
    }

    if (!global.crypto || !global.crypto.subtle) {
      throw new Error("WebCrypto API (crypto.subtle) requires HTTPS or localhost.");
    }

    const keyPair = await global.crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-1",
      },
      true,
      ["sign", "verify"]
    );

    const jwk = await global.crypto.subtle.exportKey("jwk", keyPair.privateKey);
    try {
      localStorage.setItem(RSA_STORAGE_KEY, JSON.stringify(jwk));
    } catch (_) {
      // Persist best-effort
    }
    return jwk;
  }

  /**
   * Encode an RSA-2048 public key into Android ADB's 524-byte RSAPublicKey struct,
   * base64-encoded with the " adb-deck@web\0" suffix.
   */
  function encodeAdbPublicKey(jwk) {
    const nBytes = base64UrlToBytes(jwk.n);
    const eBytes = base64UrlToBytes(jwk.e);
    const n = bytesToBigIntBE(nBytes);
    const e = Number(bytesToBigIntBE(eBytes));

    const numWords = 64; // 2048 / 32
    const r32 = 1n << 32n;
    const n0 = n & 0xffffffffn;
    const n0inv = Number((r32 - modInverse(n0, r32)) & 0xffffffffn);

    // R = 2^2048, rr = R^2 mod n
    const r = 1n << 2048n;
    const rr = (r * r) % n;

    const buf = new ArrayBuffer(524);
    const view = new DataView(buf);
    view.setUint32(0, numWords, true);
    view.setUint32(4, n0inv >>> 0, true);

    let tmpN = n;
    for (let i = 0; i < numWords; i++) {
      view.setUint32(8 + i * 4, Number(tmpN & 0xffffffffn) >>> 0, true);
      tmpN >>= 32n;
    }

    let tmpRR = rr;
    for (let i = 0; i < numWords; i++) {
      view.setUint32(8 + 256 + i * 4, Number(tmpRR & 0xffffffffn) >>> 0, true);
      tmpRR >>= 32n;
    }

    view.setUint32(520, e >>> 0, true);

    const b64 = bytesToBase64(new Uint8Array(buf));
    return textEncoder.encode(`${b64} adb-deck@web\0`);
  }

  /**
   * Sign a 20-byte ADB AUTH token directly with PKCS#1 v1.5 + SHA-1 DigestInfo
   * (without double-hashing, matching Android adbd expectations).
   */
  function signAdbToken(token, jwk) {
    const keySize = 256; // 2048 bits
    const tLen = SHA1_DIGEST_INFO_PREFIX.length + token.length;
    const psLen = keySize - tLen - 3;
    if (psLen < 8) {
      throw new Error("Invalid ADB AUTH token length");
    }

    const em = new Uint8Array(keySize);
    em[0] = 0x00;
    em[1] = 0x01;
    em.fill(0xff, 2, 2 + psLen);
    em[2 + psLen] = 0x00;
    em.set(SHA1_DIGEST_INFO_PREFIX, 3 + psLen);
    em.set(token, 3 + psLen + SHA1_DIGEST_INFO_PREFIX.length);

    const m = bytesToBigIntBE(em);
    let sig;

    if (jwk.p && jwk.q && jwk.dp && jwk.dq && jwk.qi) {
      // Fast Chinese Remainder Theorem (CRT) modular exponentiation
      const p = bytesToBigIntBE(base64UrlToBytes(jwk.p));
      const q = bytesToBigIntBE(base64UrlToBytes(jwk.q));
      const dp = bytesToBigIntBE(base64UrlToBytes(jwk.dp));
      const dq = bytesToBigIntBE(base64UrlToBytes(jwk.dq));
      const qi = bytesToBigIntBE(base64UrlToBytes(jwk.qi));

      const s1 = modPow(m, dp, p);
      const s2 = modPow(m, dq, q);
      let h = ((s1 - s2) % p + p) % p;
      h = (h * qi) % p;
      sig = s2 + h * q;
    } else {
      const n = bytesToBigIntBE(base64UrlToBytes(jwk.n));
      const d = bytesToBigIntBE(base64UrlToBytes(jwk.d));
      sig = modPow(m, d, n);
    }

    return bigIntToBytesBE(sig, keySize);
  }

  function adbChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum = (sum + data[i]) >>> 0;
    }
    return sum;
  }

  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  /**
   * Browser-native Android Debug Bridge (ADB) client built on WebUSB + WebCrypto.
   * Serializes ADB stream requests over a sequential promise queue (`_queue`) so
   * concurrent UI calls never interleave bulk USB packets.
   */
  class WebUSBADB {
    constructor() {
      this.device = null;
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;
      this.epOutPacketSize = 512;
      this.maxPayload = MAX_PAYLOAD;
      this.connected = false;
      this.banner = "";
      this.nextLocalId = 1;
      this._queue = Promise.resolve();
      this._deviceInfo = null;
    }

    static isSupported() {
      return Boolean(typeof navigator !== "undefined" && navigator.usb);
    }

    isSupported() {
      return WebUSBADB.isSupported();
    }

    isConnected() {
      return Boolean(this.device && this.device.opened && this.connected);
    }

    _enqueue(task) {
      const run = this._queue.then(task, task);
      this._queue = run.catch(() => {});
      return run;
    }

    async _sendPacket(command, arg0, arg1, payload) {
      const data =
        payload instanceof Uint8Array
          ? payload
          : typeof payload === "string"
          ? textEncoder.encode(payload)
          : new Uint8Array(0);

      const header = new ArrayBuffer(24);
      const view = new DataView(header);
      view.setUint32(0, command >>> 0, true);
      view.setUint32(4, arg0 >>> 0, true);
      view.setUint32(8, arg1 >>> 0, true);
      view.setUint32(12, data.length >>> 0, true);
      view.setUint32(16, adbChecksum(data) >>> 0, true);
      view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);

      const hdrRes = await this.device.transferOut(this.epOut, header);
      if (hdrRes.status !== "ok") {
        throw new Error(`USB transferOut header failed: ${hdrRes.status}`);
      }

      if (data.length > 0) {
        const dataRes = await this.device.transferOut(this.epOut, data);
        if (dataRes.status !== "ok") {
          throw new Error(`USB transferOut payload failed: ${dataRes.status}`);
        }
        if (this.epOutPacketSize > 0 && data.length % this.epOutPacketSize === 0) {
          await this.device.transferOut(this.epOut, new Uint8Array(0));
        }
      }
    }

    async _readExact(length) {
      const chunks = [];
      let received = 0;
      while (received < length) {
        const res = await this.device.transferIn(this.epIn, length - received);
        if (res.status !== "ok") {
          throw new Error(`USB transferIn failed: ${res.status}`);
        }
        if (!res.data || res.data.byteLength === 0) {
          continue;
        }
        const slice = new Uint8Array(
          res.data.buffer,
          res.data.byteOffset,
          res.data.byteLength
        );
        chunks.push(new Uint8Array(slice));
        received += slice.byteLength;
      }
      return chunks.length === 1 ? chunks[0] : concatChunks(chunks);
    }

    async _readPacket() {
      const hdrBytes = await this._readExact(24);
      const view = new DataView(
        hdrBytes.buffer,
        hdrBytes.byteOffset,
        hdrBytes.byteLength
      );
      const command = view.getUint32(0, true);
      const arg0 = view.getUint32(4, true);
      const arg1 = view.getUint32(8, true);
      const dataLength = view.getUint32(12, true);
      const dataCrc32 = view.getUint32(16, true);
      const magic = view.getUint32(20, true);

      if (magic !== ((command ^ 0xffffffff) >>> 0)) {
        throw new Error("Invalid ADB packet magic received over WebUSB");
      }

      const data =
        dataLength > 0 ? await this._readExact(dataLength) : new Uint8Array(0);
      return { command, arg0, arg1, dataLength, dataCrc32, data };
    }

    /**
     * Prompts the user to select an ADB-capable USB device, claims the bulk
     * interface, completes the RSA-2048 ADB AUTH handshake, and returns device metadata.
     * @param {(status: string) => void} [onStatus] Optional progress callback.
     * @returns {Promise<{serial: string, model: string, androidVersion: string, battery: string, transport: "webusb", state: "device"}>}
     */
    async connect(onStatus) {
      if (!WebUSBADB.isSupported()) {
        throw new Error(
          "WebUSB is not supported in this browser. Use Chrome or Edge over HTTPS or localhost."
        );
      }

      const notify = typeof onStatus === "function" ? onStatus : () => {};

      // Clean up any prior session first
      if (this.device) {
        await this.disconnect();
      }

      const device = await navigator.usb.requestDevice({
        filters: [
          {
            classCode: ADB_CLASS,
            subclassCode: ADB_SUBCLASS,
            protocolCode: ADB_PROTOCOL,
          },
        ],
      });

      this.device = device;
      notify("Opening USB device...");
      await device.open();

      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }

      // Locate the ADB interface & bulk endpoints
      let adbIface = null;
      let adbAlt = null;
      for (const iface of device.configuration.interfaces) {
        for (const alt of iface.alternates) {
          if (
            alt.interfaceClass === ADB_CLASS &&
            alt.interfaceSubclass === ADB_SUBCLASS &&
            alt.interfaceProtocol === ADB_PROTOCOL
          ) {
            adbIface = iface;
            adbAlt = alt;
            break;
          }
        }
        if (adbIface) break;
      }

      if (!adbIface || !adbAlt) {
        await this.disconnect();
        throw new Error(
          "Selected USB device does not expose an ADB interface. Ensure USB Debugging is enabled."
        );
      }

      const epIn = adbAlt.endpoints.find(
        (ep) => ep.direction === "in" && ep.type === "bulk"
      );
      const epOut = adbAlt.endpoints.find(
        (ep) => ep.direction === "out" && ep.type === "bulk"
      );
      if (!epIn || !epOut) {
        await this.disconnect();
        throw new Error("ADB bulk IN/OUT endpoints not found on USB interface.");
      }

      this.interfaceNumber = adbIface.interfaceNumber;
      this.epIn = epIn.endpointNumber;
      this.epOut = epOut.endpointNumber;
      this.epOutPacketSize = epOut.packetSize || 512;

      try {
        await device.claimInterface(this.interfaceNumber);
      } catch (err) {
        await this.disconnect();
        throw new Error(
          "Could not claim USB interface. Close local adb server (`adb kill-server`) if it is holding the phone."
        );
      }

      if (adbAlt.alternateSetting !== 0) {
        await device.selectAlternateInterface(
          this.interfaceNumber,
          adbAlt.alternateSetting
        );
      }

      // ADB CNXN + AUTH handshake
      notify("Performing ADB handshake...");
      const jwk = await getOrCreateRsaJwk();
      await this._sendPacket(A_CNXN, A_VERSION, MAX_PAYLOAD, "host::adb-deck\0");

      let signatureTried = false;
      let publicKeySent = false;

      while (true) {
        const pkt = await this._readPacket();

        if (pkt.command === A_CNXN) {
          this.maxPayload = Math.min(MAX_PAYLOAD, pkt.arg1 || MAX_PAYLOAD);
          this.banner = textDecoder.decode(pkt.data).replace(/\0+$/, "");
          this.connected = true;
          break;
        }

        if (pkt.command === A_AUTH && pkt.arg0 === AUTH_TOKEN) {
          if (!signatureTried) {
            signatureTried = true;
            notify("Signing ADB challenge...");
            const sig = signAdbToken(pkt.data, jwk);
            await this._sendPacket(A_AUTH, AUTH_SIGNATURE, 0, sig);
          } else if (!publicKeySent) {
            publicKeySent = true;
            notify("Check your phone and tap 'Allow USB debugging'...");
            const pubKey = encodeAdbPublicKey(jwk);
            await this._sendPacket(A_AUTH, AUTH_RSAPUBLICKEY, 0, pubKey);
          } else {
            await this.disconnect();
            throw new Error("ADB authentication was rejected by the device.");
          }
          continue;
        }

        if (pkt.command === A_CLSE) {
          continue;
        }

        if (pkt.command === A_SYNC) {
          continue;
        }
      }

      notify("Connected! Reading device info...");
      this._deviceInfo = await this.getDeviceInfo();
      return this._deviceInfo;
    }

    async disconnect() {
      this.connected = false;
      this._deviceInfo = null;
      const dev = this.device;
      const ifaceNum = this.interfaceNumber;
      this.device = null;
      this.interfaceNumber = null;
      this.epIn = null;
      this.epOut = null;

      if (dev) {
        try {
          if (ifaceNum !== null && dev.opened) {
            await dev.releaseInterface(ifaceNum);
          }
        } catch (_) {}
        try {
          if (dev.opened) {
            await dev.close();
          }
        } catch (_) {}
      }
    }

    /**
     * Executes an Android shell command (`shell:<cmd>`) over the active WebUSB ADB connection.
     * @param {string} cmd Shell command string.
     * @returns {Promise<string>} Decoded UTF-8 command output.
     */
    shell(cmd) {
      if (!this.isConnected()) {
        return Promise.reject(new Error("No WebUSB device connected"));
      }

      return this._enqueue(async () => {
        if (!this.isConnected()) {
          throw new Error("WebUSB device disconnected");
        }

        const localId = this.nextLocalId++;
        let remoteId = 0;
        const chunks = [];

        await this._sendPacket(A_OPEN, localId, 0, `shell:${cmd}\0`);

        while (true) {
          const pkt = await this._readPacket();

          if (pkt.command === A_OKAY && pkt.arg1 === localId) {
            remoteId = pkt.arg0;
            continue;
          }

          if (pkt.command === A_WRTE && pkt.arg1 === localId) {
            remoteId = pkt.arg0;
            if (pkt.data.length > 0) {
              chunks.push(pkt.data);
            }
            await this._sendPacket(A_OKAY, localId, remoteId);
            continue;
          }

          if (pkt.command === A_CLSE && pkt.arg1 === localId) {
            remoteId = pkt.arg0;
            try {
              await this._sendPacket(A_CLSE, localId, remoteId);
            } catch (_) {}
            break;
          }

          // Ignore stray packets from previously closed streams
          if (pkt.command === A_WRTE) {
            try {
              await this._sendPacket(A_OKAY, pkt.arg1, pkt.arg0);
            } catch (_) {}
          }
        }

        return textDecoder.decode(concatChunks(chunks));
      });
    }

    _parseBannerModel() {
      const m = /ro\.product\.model=([^;]+)/.exec(this.banner || "");
      return m ? m[1].trim() : "";
    }

    /**
     * Queries serial, model, Android version, and battery level over WebUSB shell.
     * @returns {Promise<{serial: string, model: string, androidVersion: string, battery: string, transport: "webusb", state: "device"}>}
     */
    async getDeviceInfo() {
      const out = await this.shell(
        'echo "SERIAL=$(getprop ro.serialno)"; echo "MODEL=$(getprop ro.product.model)"; echo "ANDROID=$(getprop ro.build.version.release)"; dumpsys battery | grep -m 1 level'
      );

      let serial = (this.device && this.device.serialNumber) || "webusb-device";
      let model =
        this._parseBannerModel() ||
        (this.device && this.device.productName) ||
        "Android Device";
      let androidVersion = "";
      let battery = "";

      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("SERIAL=")) {
          const v = line.slice(7).trim();
          if (v) serial = v;
        } else if (line.startsWith("MODEL=")) {
          const v = line.slice(6).trim();
          if (v) model = v;
        } else if (line.startsWith("ANDROID=")) {
          const v = line.slice(8).trim();
          if (v) androidVersion = v;
        } else {
          const bm = /level:\s*(\d+)/i.exec(line);
          if (bm) battery = `${bm[1]}%`;
        }
      }

      this._deviceInfo = {
        serial,
        model,
        androidVersion,
        battery,
        transport: "webusb",
        state: "device",
      };
      return this._deviceInfo;
    }

    /**
     * Lists installed packages using `pm list packages -f`.
     * @param {boolean} [includeSystem=false] Include system/product/vendor packages.
     * @returns {Promise<Array<{package: string, apkPath: string, isSystem: boolean}>>}
     */
    async listPackages(includeSystem = false) {
      const cmd = includeSystem ? "pm list packages -f" : "pm list packages -f -3";
      const out = await this.shell(cmd);
      const packages = [];

      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("package:")) continue;
        const body = line.slice("package:".length);
        const eqIdx = body.lastIndexOf("=");
        if (eqIdx === -1) continue;
        const apkPath = body.slice(0, eqIdx).trim();
        const pkg = body.slice(eqIdx + 1).trim();
        if (!pkg) continue;
        const isSystem = includeSystem
          ? /^\/(system|product|vendor|system_ext|apex)\b/.test(apkPath)
          : false;
        packages.push({ package: pkg, apkPath, isSystem });
      }

      packages.sort((a, b) => a.package.localeCompare(b.package));
      return packages;
    }

    /**
     * Runs a package lifecycle action ("clear" | "force-stop" | "uninstall")
     * after validating the package name against SAFE_PKG_RE.
     * @param {string} pkg Valid Android package identifier.
     * @param {"clear"|"force-stop"|"uninstall"} action Package operation.
     * @returns {Promise<{ok: true, output: string}>}
     */
    async apkAction(pkg, action) {
      if (!SAFE_PKG_RE.test(pkg)) {
        throw new Error(`Invalid package name: ${pkg}`);
      }
      let cmd;
      if (action === "clear") {
        cmd = `pm clear ${pkg}`;
      } else if (action === "force-stop") {
        cmd = `am force-stop ${pkg}`;
      } else if (action === "uninstall") {
        cmd = `pm uninstall ${pkg}`;
      } else {
        throw new Error(`Unsupported APK action: ${action}`);
      }

      const output = (await this.shell(cmd)).trim();
      return { ok: true, output: output || "done" };
    }
  }

  global.WebUSBADB = WebUSBADB;
})(typeof window !== "undefined" ? window : globalThis);
