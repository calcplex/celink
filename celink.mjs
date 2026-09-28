// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Portions derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see LIBTICALCS.md in that repository.
//
// Talk to a TI-84 Plus CE over WebUSB: read its parameters, list, send,
// receive and delete variables. No dependencies; works in a browser with
// WebUSB and in Node against any object shaped like a USBDevice.
//
// Layers, bottom up (all protocol numbers are big-endian):
//   raw packet      LLLLLLLL TT data...        (TT 1..5, one per USB transfer)
//   virtual packet  LLLLLLLL TTTT data...      (carried in raw type 3/4 packets)
//   operation       buffer size negotiation, Ping/Set Mode, then one command
//
// Anything this file had to guess is gathered in, and documented inline in,
// `DEFAULT_QUIRKS`.

import { typeName, nameToString, nameToBytes, canonicalName, parseFile, parseAppFile, appNameFromData, TYPE } from './tifiles.mjs';

export const TI_VENDOR_ID = 0x0451;
/** USB product id of the TI-84 Plus CE. Not used as a filter. */
export const CE_PRODUCT_ID = 0xE008;

// Packet numbers and most descriptions from Benjamin Moody's 2006 analysis,
// "The TI-84 Plus USB Protocol: A Partial Analysis". Several constant names
// (VAR_HDR, VAR_CNTS, DIR_REQ, VAR_REQ, RTS, DATA_ACK, EOT) follow libticalcs'
// dusb_vpkt.h, and 0xBB00's name and meaning come from libticalcs (Moody lists
// it as unknown); see LIBTICALCS.md.
export const RAW = Object.freeze({ BUF_REQ: 1, BUF_ALLOC: 2, DATA: 3, DATA_FINAL: 4, ACK: 5 });

export const VPKT = Object.freeze({
  PING: 0x0001, PARAM_REQ: 0x0007, PARAM_DATA: 0x0008, DIR_REQ: 0x0009,
  VAR_HDR: 0x000A, RTS: 0x000B, VAR_REQ: 0x000C, VAR_CNTS: 0x000D, PARAM_SET: 0x000E,
  DEL_VAR: 0x0010, MODE_ACK: 0x0012, DATA_ACK: 0xAA00, DELAY: 0xBB00, EOT: 0xDD00, ERROR: 0xEE00,
});

const VPKT_NAMES = {
  0x0001: 'Ping / Set Mode', 0x0002: 'Begin OS Transfer', 0x0003: 'Ack of OS Transfer',
  0x0005: 'OS Data', 0x0006: 'Ack of EOT', 0x0007: 'Parameter Request', 0x0008: 'Parameter Data',
  0x0009: 'Request Directory Listing', 0x000A: 'Variable Header', 0x000B: 'Request to Send',
  0x000C: 'Request Variable', 0x000D: 'Variable Contents', 0x000E: 'Parameter Set',
  0x0010: 'Delete Variable', 0x0011: 'Unknown 0x0011', 0x0012: 'Ack of Mode Setting',
  0xAA00: 'Ack of Data', 0xBB00: 'Delay Acknowledgement', 0xDD00: 'End of Transmission', 0xEE00: 'Error',
};

export const ATTR = Object.freeze({ SIZE: 0x0001, TYPE: 0x0002, ARCHIVED: 0x0003, VERSION: 0x0008, TYPE_REQ: 0x0011 });

/** Request to Send mode flag: 0x01 is a silent send, which the CE accepts without
 *  asking and which overwrites a variable of the same name and type. (0x02, the
 *  non-silent form, is not supported by the CE for ordinary variables.)
 *  (libticalcs; LIBTICALCS.md 23) */
const SILENT_SEND = 0x01;
/** Delete: the protection mode byte. 0x01 bypasses file protection, so archived
 *  and locked variables can be deleted; 0x00 would honour it. */
const BYPASS_PROTECTION = 0x01;

export const PARAM = Object.freeze({
  PRODUCT_NUMBER: 0x0001, PRODUCT_NAME: 0x0002, HW_VERSION: 0x0004, LANGUAGE: 0x0006,
  SUB_LANGUAGE: 0x0007, DEVICE_TYPE: 0x0008, BOOT_VERSION: 0x0009, OS_LOADED: 0x000A,
  OS_VERSION: 0x000B, RAM_PHYS: 0x000C, RAM_USER: 0x000D, RAM_FREE: 0x000E,
  FLASH_PHYS: 0x000F, FLASH_USER: 0x0010, FLASH_FREE: 0x0011, LCD_WIDTH: 0x001E,
  LCD_HEIGHT: 0x001F, BATTERY_OK: 0x002D, AT_HOMESCREEN: 0x0037,
  OS_BUILD: 0x0048, BOOT_BUILD: 0x0049,
});

/** Parameters read by info(), in one request. 0x0003 (the calculator's unique id) is deliberately not read. */
export const INFO_PARAMS = Object.freeze([
  0x0001, 0x0002, 0x0004, 0x0006, 0x0007, 0x0008, 0x0009, 0x000A, 0x000B, 0x0048, 0x0049,
  0x000C, 0x000D, 0x000E, 0x000F, 0x0010, 0x0011, 0x001E, 0x001F, 0x002D, 0x0037,
]);

/** Every byte this library had to assume. Change them per link: `link.quirks.x = ...`.
 *  CONFIRMED_ON_5_3 below holds the values the first hardware pass used. */
export const DEFAULT_QUIRKS = Object.freeze({
  requestBufferSize: 1024,            // what we offer in the Buffer Size Request
  allocIncludesHeader: true,          // subtract the 5-byte raw header from the allocation (see README)
  maxDataBytes: 1018,                 // the CE's ceiling on data bytes per raw packet, whatever it allocates
  delayCapMicros: 400000,             // longest 0xBB00 delay honoured, in microseconds
  modeId: [0x00, 0x03, 0x00, 0x01, 0x00, 0x00], // "normal operation" mode
  pingValue: 0x000007D0,              // the 4-byte value after the mode id
  // The type word is F0 <owner> 00 <type id>; the owner byte depends on the command.
  typePrefixes: { send: 0xF00F0000, receive: 0xF0070000, delete: 0xF00B0000 },
  learnTypePrefix: false,             // true: every command reuses the prefix list() saw for that type
  rtsAttributes: [0x0002, 0x0003, 0x0008], // attributes Request to Send carries: type, archived, version
  receiveAttributes: [0x0003, 0x0008, 0x0001], // attributes Request Variable asks for: archived, version, size
  negotiateEachOperation: true,       // buffer size + ping before every operation (false: once per connection)
  settleMs: 50,                       // pause after a send before the next operation starts
  readOnePacket: false,               // true: every USB read asks for exactly one 64-byte packet
  zeroLengthAfterFinal: true,         // a zero-length write after a final raw packet whose wire length is a multiple of 64
  emptyFinalOnBoundary: false,        // true: an exactly-full virtual packet ends with an empty type 4 (hung a real CE on a one-packet message)
  // Flash applications (sendApp / receiveApp / deleteApp).
  appSendTypeWord: 0xF00F0024,        // Request to Send attribute 0x0002 for an application
  appReceiveTypeWord: 0xF00F0024,     // Request Variable attribute 0x0011 for an application
  appReceiveAttributes: [0x0003, 0x0008], // what receiveApp asks back: archived, version
  appBatteryCheck: true,              // read parameter 0x002D before an application send; refuse if it says 0
  appBatteryDetail: false,            // also read 0x002E (battery level) and 0x002F (external power) for the message
});

/** The CE's bulk endpoints move 64-byte USB packets. A bulk OUT transfer only ends,
 *  on the calculator's side, at a short packet, so a raw packet whose wire length
 *  is a multiple of this needs a zero-length write after it. */
export const USB_PACKET = 64;

/**
 * The command bytes that worked on the first hardware pass (one TI-84 Plus CE, OS
 * 5.3.0.0037), before the libticalcs comparison changed the defaults. Apply them with
 * `Object.assign(link.quirks, cloneQuirks(CONFIRMED_ON_5_3))` to go back to exactly those bytes.
 */
export const CONFIRMED_ON_5_3 = Object.freeze({
  typePrefixes: Object.freeze({ send: 0xF0070000, receive: 0xF0070000, delete: 0xF0070000 }),
  learnTypePrefix: true,
  rtsAttributes: Object.freeze([0x0001, 0x0002, 0x0003]),
  receiveAttributes: Object.freeze([0x0001, 0x0002, 0x0003]),
});

/** A fresh, mutable copy of a quirks object. */
export function cloneQuirks(q = DEFAULT_QUIRKS) {
  const out = {};
  for (const [k, v] of Object.entries(q)) out[k] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...v } : v;
  return out;
}

const FATAL = new Set(['TIMEOUT', 'USB_ERROR', 'DISCONNECTED', 'PROTOCOL']);
/** The ways a link goes quiet when the calculator reboots underneath it. */
const LINK_DROP = new Set(['TIMEOUT', 'USB_ERROR', 'DISCONNECTED']);

export class CELinkError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CELinkError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ------------------------------------------------------------------ bytes

export function u16(n) { return [(n >>> 8) & 0xFF, n & 0xFF]; }
export function u32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function rd16(b, o) { return (b[o] << 8) | b[o + 1]; }
function rd32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function rdUint(b) { let n = 0; for (const x of b) n = n * 256 + x; return n; }

/** Concatenate numbers, arrays of numbers and Uint8Arrays into one Uint8Array. */
export function bytes(...parts) {
  let len = 0;
  for (const p of parts) len += typeof p === 'number' ? 1 : p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    if (typeof p === 'number') out[o++] = p;
    else { out.set(p, o); o += p.length; }
  }
  return out;
}

export function hex(b) {
  return Array.from(b, x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

// ------------------------------------------------------------------ framing

export function encodeRaw(type, data = []) {
  return bytes(u32(data.length), type, data);
}

/** Parse one complete raw packet. Returns null if `b` does not yet hold one. */
export function decodeRaw(b) {
  if (b.length < 5) return null;
  const len = rd32(b, 0);
  if (b.length < 5 + len) return null;
  return { type: b[4], data: b.slice(5, 5 + len), length: 5 + len };
}

export function encodeVirtual(vtype, data = []) {
  return bytes(u32(data.length), u16(vtype), data);
}

/**
 * The next raw packet of an encoded virtual packet, starting at `off`, with at
 * most `bufferSize` data bytes. With `emptyFinal`, a virtual packet whose bytes
 * exactly fill its last raw packet sends that packet as type 3 and then an empty
 * type 4, instead of making the full packet the type 4.
 */
export function nextChunk(vbytes, off, bufferSize, emptyFinal = false) {
  const left = vbytes.length - off;
  if (left > bufferSize || (left === bufferSize && emptyFinal)) {
    return { type: RAW.DATA, data: vbytes.subarray(off, off + bufferSize) };
  }
  return { type: RAW.DATA_FINAL, data: vbytes.subarray(off) };
}

/** Split an encoded virtual packet into raw packets of at most `bufferSize` data bytes. */
export function splitVirtual(vbytes, bufferSize, { emptyFinal = false } = {}) {
  const out = [];
  for (let off = 0; ;) {
    const c = nextChunk(vbytes, off, bufferSize, emptyFinal);
    out.push(c);
    off += c.data.length;
    if (c.type === RAW.DATA_FINAL) return out;
  }
}

/** True when a raw packet of `dataLength` data bytes fills whole 64-byte USB packets. */
export function needsZeroLength(dataLength) {
  return (dataLength + 5) % USB_PACKET === 0;
}

/** Join the data of raw type 3/4 packets back into { type, data }. */
export function joinVirtual(chunks) {
  const all = bytes(...chunks);
  if (all.length < 6) throw new CELinkError('PROTOCOL', 'A virtual packet from the calculator was shorter than its 6-byte header.');
  const len = rd32(all, 0);
  if (len !== all.length - 6) {
    throw new CELinkError('PROTOCOL', `A virtual packet from the calculator said it held ${len} bytes but carried ${all.length - 6}.`);
  }
  return { type: rd16(all, 4), data: all.slice(6) };
}

// ------------------------------------------------------------------ packet bodies

function attrOut(id, data) { return bytes(u16(id), u16(data.length), data); }

/** Parse a Variable Header (0x000A): name, one unknown byte, attributes with a valid flag. */
export function parseVarHeader(d) {
  let p = 0;
  const need = n => { if (p + n > d.length) throw new CELinkError('PROTOCOL', 'A Variable Header from the calculator was cut short.'); };
  need(2); const nlen = rd16(d, p); p += 2;
  need(nlen); const nameBytes = d.slice(p, p + nlen); p += nlen;
  need(3); p += 1; const count = rd16(d, p); p += 2;
  const attrs = new Map();
  for (let i = 0; i < count; i++) {
    need(3); const id = rd16(d, p); const vv = d[p + 2]; p += 3;
    if (vv !== 0) continue;
    need(2); const len = rd16(d, p); p += 2;
    need(len); attrs.set(id, d.slice(p, p + len)); p += len;
  }
  return { nameBytes, name: utf8d.decode(nameBytes), attrs };
}

/** Parse Parameter Data (0x0008) into Map<id, Uint8Array>; invalid parameters are left out. */
export function parseParamData(d) {
  const out = new Map();
  if (d.length < 2) return out;
  const count = rd16(d, 0);
  let p = 2;
  for (let i = 0; i < count && p + 3 <= d.length; i++) {
    const id = rd16(d, p); const vv = d[p + 2]; p += 3;
    if (vv !== 0) continue;
    if (p + 2 > d.length) break;
    const len = rd16(d, p); p += 2;
    if (p + len > d.length) break;
    out.set(id, d.slice(p, p + len)); p += len;
  }
  return out;
}

/** major.minor.micro from bytes 1, 2 and 3 of the 4-byte version (byte 0 is not
 *  part of it), plus the build number when its parameter is exactly 2 bytes. */
export function formatVersion(v, build) {
  if (!v || v.length !== 4) return undefined;
  let s = `${v[1]}.${v[2]}.${v[3]}`;
  if (build && build.length === 2) s += '.' + String(rd16(build, 0)).padStart(4, '0');
  return s;
}

export function infoFromParams(raw) {
  const info = {};
  const num = id => (raw.has(id) ? rdUint(raw.get(id)) : undefined);
  const set = (k, v) => { if (v !== undefined) info[k] = v; };
  if (raw.has(0x0002)) info.productName = utf8d.decode(raw.get(0x0002)).replace(/\0+$/, '');
  // The product number is the last byte of parameter 0x0001 (0x13 on the CE).
  if (raw.has(0x0001) && raw.get(0x0001).length) info.productNumber = raw.get(0x0001).at(-1);
  set('osVersion', formatVersion(raw.get(0x000B), raw.get(0x0048)));
  set('bootVersion', formatVersion(raw.get(0x0009), raw.get(0x0049)));
  set('hardwareVersion', num(0x0004));
  set('ramFree', num(0x000E));
  set('archiveFree', num(0x0011));
  set('language', num(0x0006));
  set('subLanguage', num(0x0007));
  if (raw.has(0x0037)) info.atHomescreen = num(0x0037) !== 0;
  if (raw.has(0x002D)) info.batteryOk = num(0x002D) !== 0;
  set('lcdWidth', num(0x001E));
  set('lcdHeight', num(0x001F));
  return info;
}

// ------------------------------------------------------------------ the link

export class CELink {
  /** Ask the browser to let the user pick a calculator. */
  static async request({ usb = globalThis.navigator?.usb } = {}) {
    if (!usb) throw new CELinkError('NO_WEBUSB', 'This browser cannot talk to USB devices. Use Chrome or Edge on a computer.');
    let device;
    try {
      device = await usb.requestDevice({ filters: [{ vendorId: TI_VENDOR_ID }] });
    } catch (e) {
      if (e?.name === 'NotFoundError') throw new CELinkError('NO_DEVICE_SELECTED', 'No calculator was chosen.');
      throw new CELinkError('USB_ERROR', `The browser could not show the device list: ${e?.message ?? e}`);
    }
    return new CELink(device);
  }

  /** Wrap a device the user already granted (from usb.getDevices()). */
  static fromDevice(device) { return new CELink(device); }

  /** Devices from TI this page was already allowed to use. */
  static async granted({ usb = globalThis.navigator?.usb } = {}) {
    if (!usb) return [];
    return (await usb.getDevices()).filter(d => d.vendorId === TI_VENDOR_ID);
  }

  constructor(device) {
    if (!device) throw new CELinkError('NO_DEVICE', 'No USB device was given.');
    this.device = device;
    this.quirks = cloneQuirks();
    this.timeout = 3000;        // ms per USB transfer
    this.streamTimeout = 15000; // ms per transfer while variable data streams (archive writes are slow)
    this.appTimeout = 30000;    // ms per transfer while an application streams and for the answers around it
    this.lastBattery = null;    // what the last battery check read
    this.capture = false;
    this.captureLog = [];
    this.captureOps = [];
    this.bufferSize = null;     // data bytes per raw packet, after the header rule
    this.allocation = null;     // the calculator's raw answer to the Buffer Size Request
    this.opened = false;
    this._poisoned = null;      // a reason set when the link is closed for good (e.g. a reboot on landing)
    this.lastModeAck = null;
    this.lastDelayMs = null;    // the last 0xBB00 wait, for diagnostics
    this._rx = new Uint8Array(0);
    this._lock = Promise.resolve();
    this._prefixes = new Map();
    this._t0 = null;
  }

  get productId() { return this.device.productId; }

  // -------------------------------------------------------------- open / close

  async open() {
    const d = this.device;
    // Which WebUSB call refused, and the DOMException name it refused with,
    // ride on OPEN_FAILED as `step` and `cause`: fixed words a page can bucket
    // (a policy block, a held interface, a busy device) without the message.
    let step = 'open';
    try {
      if (!d.opened) await d.open();
      const pick = findBulkInterface(d);
      if (!pick) throw new CELinkError('NO_ENDPOINTS', 'This USB device does not look like a TI-84 Plus CE (no bulk IN/OUT endpoints were found).');
      step = 'config';
      if (d.configuration?.configurationValue !== pick.configurationValue) await d.selectConfiguration(pick.configurationValue);
      step = 'claim';
      await d.claimInterface(pick.interfaceNumber);
      step = 'alt';
      if (pick.alternateSetting !== 0) await d.selectAlternateInterface(pick.interfaceNumber, pick.alternateSetting);
      this._iface = pick.interfaceNumber;
      this.epIn = pick.epIn;
      this.epOut = pick.epOut;
      this.opened = true;
      this._session = false;
      this._poisoned = null;
      this._rx = new Uint8Array(0);
    } catch (e) {
      await this.close();
      if (e instanceof CELinkError) throw e;
      throw new CELinkError('OPEN_FAILED',
        `Could not open the calculator: ${e?.message ?? e}. If TI Connect CE or another program is running, close it, unplug the calculator, plug it back in and try again.`,
        {step, cause: typeof e?.name === 'string' ? e.name : ''});
    }
    return this;
  }

  async close() {
    const wasOpen = this.opened;
    this.opened = false;
    this.bufferSize = null;
    this._session = false;
    this._sentAt = null;
    if (this._iface != null) {
      try { await this.device.releaseInterface(this._iface); } catch { /* already gone */ }
      this._iface = null;
    }
    try { if (this.device.opened || wasOpen) await this.device.close(); } catch { /* already gone */ }
  }

  // -------------------------------------------------------------- public operations

  info() {
    return this._op('info', async () => {
      await this._begin();
      await this._sendVirtual(VPKT.PARAM_REQ, bytes(u16(INFO_PARAMS.length), ...INFO_PARAMS.map(u16)));
      const v = await this._expect([VPKT.PARAM_DATA]);
      const raw = parseParamData(v.data);
      const info = infoFromParams(raw);
      if (info.productName === undefined && this.device.productName) info.productName = this.device.productName;
      info.productId = this.device.productId;
      info.raw = raw;
      return info;
    });
  }

  list() {
    return this._op('list', async () => {
      await this._begin();
      const ids = [ATTR.SIZE, ATTR.TYPE, ATTR.ARCHIVED];
      await this._sendVirtual(VPKT.DIR_REQ, bytes(u32(ids.length), ...ids.map(u16), [0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01]));
      const rows = [];
      for (;;) {
        const v = await this._expect([VPKT.VAR_HDR, VPKT.EOT, VPKT.DATA_ACK]);
        if (v.type === VPKT.EOT) break;
        if (v.type === VPKT.DATA_ACK) continue;
        const h = parseVarHeader(v.data);
        const t = h.attrs.get(ATTR.TYPE);
        const typeRaw = t && t.length === 4 ? rd32(t, 0) : null;
        const type = typeRaw == null ? null : typeRaw & 0xFF;
        if (typeRaw != null) this._prefixes.set(type, (typeRaw & 0xFFFFFF00) >>> 0);
        const s = h.attrs.get(ATTR.SIZE);
        const a = h.attrs.get(ATTR.ARCHIVED);
        rows.push({
          name: h.name, nameBytes: h.nameBytes, type, typeName: type == null ? 'unknown' : typeName(type),
          size: s ? rdUint(s) : null, archived: a ? a[0] !== 0 : false, typeRaw,
        });
      }
      return rows;
    });
  }

  /** Send one variable entry (from parseFile or makeEntry). */
  send(entry, { archive = false, onProgress, onPhase, rebootOnLanding = false } = {}) {
    if (!entry || !(entry.data instanceof Uint8Array)) {
      return Promise.reject(new CELinkError('BAD_ENTRY', 'send() needs a variable entry with its data (use parseFile or makeEntry).'));
    }
    if (entry.type === TYPE.FLASH_APP) {
      return Promise.reject(new CELinkError('UNSUPPORTED_TYPE', 'This is a Flash application. Send it with sendApp(), the one call that writes an app to Flash.'));
    }
    let name;
    try {
      name = wireName(entry.nameBytes ? nameToString(entry.nameBytes, entry.type) : entry.name, entry.type);
    } catch (e) { return Promise.reject(e); }
    const size = entry.data.length;
    return this._op(`send ${entry.name}`, async () => {
      await this._begin();
      const q = this.quirks;
      const values = {
        [ATTR.SIZE]: u32(size), [ATTR.TYPE]: u32(this._typeWord(entry.type, 'send')),
        [ATTR.ARCHIVED]: [archive ? 1 : 0], [ATTR.VERSION]: [0, 0, 0, (entry.version ?? 0) & 0xFF],
      };
      const attrs = q.rtsAttributes.filter(id => values[id]);
      // The 2-byte name length is a 1-byte folder name length (always 0 here)
      // and a 1-byte name length; the name ends with a NUL; then the size.
      await this._sendVirtual(VPKT.RTS, bytes(
        u16(name.length), name, 0x00, u32(size), SILENT_SEND,
        u16(attrs.length), ...attrs.map(id => attrOut(id, values[id])),
      ));
      await this._expect([VPKT.DATA_ACK]);
      onProgress?.(0, size);
      // Three moments around the landing: the write of the last data packet
      // starting, the whole variable being on the wire, and the calculator
      // acknowledging it. When rebootOnLanding is set, a link that drops from the
      // first of those on is the expected outcome, not an error: a reboot can
      // reject the final transferOut itself (observed on a real CE), so the point
      // of no return is when that write starts, not when it completes.
      let finalWriteStarted = false;
      try {
        await this._sendVirtual(VPKT.VAR_CNTS, entry.data, {
          timeout: this.streamTimeout,
          onChunk: sent => onProgress?.(Math.max(0, Math.min(size, sent - 6)), size),
          onFinalWriteStarted: () => { finalWriteStarted = true; onPhase?.('final-write-started'); },
          onFinalWritten: () => onPhase?.('final-written'),
        });
        await this._expect([VPKT.DATA_ACK], this.streamTimeout);
        await this._sendVirtual(VPKT.EOT, []);
        this._sentAt = performance.now(); // the calculator needs a moment to commit it
        onPhase?.('acknowledged');
        const result = { name: entry.name, bytes: size };
        if (rebootOnLanding) { result.rebooted = false; result.acknowledged = true; }
        return result;
      } catch (e) {
        const code = e instanceof CELinkError ? e.code : usbError(e).code;
        // A drop from the final packet's write onward is the reboot we asked for,
        // including a rejected transferOut. A drop before it is an ordinary
        // failure and throws as it always did.
        if (rebootOnLanding && finalWriteStarted && LINK_DROP.has(code)) {
          await this._poison('The calculator rebooted as the variable landed, so the USB link is closed. Reconnect (open a new link) to keep working.');
          return { name: entry.name, bytes: size, rebooted: true, acknowledged: false };
        }
        throw e;
      }
    });
  }

  /** Send every entry of a .8xp/.8xv/.8xg file, one after another. */
  async sendFile(file, { archive = false, onProgress, onPhase, rebootOnLanding = false } = {}) {
    const parsed = file instanceof Uint8Array || file instanceof ArrayBuffer ? parseFile(file) : file;
    // rebootOnLanding only makes sense for a single variable: with several, the
    // link would drop mid-file and the rest could not be sent.
    if (rebootOnLanding && parsed.entries.length !== 1) {
      throw new CELinkError('BAD_ENTRY', 'rebootOnLanding needs a file with exactly one variable; this file has ' + parsed.entries.length + '.');
    }
    const results = [];
    for (const [i, e] of parsed.entries.entries()) {
      results.push(await this.send(e, { archive, rebootOnLanding, onPhase, onProgress: onProgress && ((s, t) => onProgress(s, t, i, e)) }));
    }
    return results;
  }

  /** Receive a variable. `name` is a string ("HELLO", "L1", "L₁") or the nameBytes of a list() row. */
  receive(name, type) {
    if (type === TYPE.FLASH_APP) return this.receiveApp(name);
    let wire;
    try { wire = wireName(name, type); } catch (e) { return Promise.reject(e); }
    return this._op(`receive ${printable(name)}`, async () => {
      await this._begin();
      const req = this.quirks.receiveAttributes;
      await this._sendVirtual(VPKT.VAR_REQ, bytes(
        u16(wire.length), wire,
        [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF], // name NUL, then 01 FF FF FF FF
        u16(req.length), ...req.map(u16),
        u16(1), attrOut(ATTR.TYPE_REQ, u32(this._typeWord(type, 'receive'))),
        [0x00, 0x00],
      ));
      const hv = await this._expect([VPKT.VAR_HDR]);
      const h = parseVarHeader(hv.data);
      const cv = await this._expect([VPKT.VAR_CNTS], this.streamTimeout);
      // The size in the header is authoritative: anything past it is ignored,
      // and only contents shorter than it are an error.
      let data = cv.data;
      const s = h.attrs.get(ATTR.SIZE);
      if (s) {
        const declared = rdUint(s);
        if (data.length < declared) {
          throw new CELinkError('PROTOCOL', `The calculator said ${h.name} is ${declared} bytes but sent only ${data.length}.`);
        }
        data = data.slice(0, declared);
      }
      const t = h.attrs.get(ATTR.TYPE);
      const gotType = t && t.length === 4 ? t[3] : type;
      const ver = h.attrs.get(ATTR.VERSION);
      const a = h.attrs.get(ATTR.ARCHIVED);
      let nameBytes;
      try { nameBytes = nameToBytes(h.name, gotType); } catch { nameBytes = nameToBytes(h.nameBytes.slice(0, 8), gotType); }
      return {
        name: nameToString(nameBytes, gotType), nameBytes, type: gotType, typeName: typeName(gotType),
        version: ver && ver.length ? ver[ver.length - 1] : 0, archived: a ? a[0] !== 0 : false, data, size: data.length,
      };
    });
  }

  delete(name, type) {
    let wire;
    try { wire = wireName(name, type); } catch (e) { return Promise.reject(e); }
    return this._op(`delete ${printable(name)}`, async () => {
      await this._begin();
      // Delete is "modify variable" with an empty destination: the name and its
      // NUL, the type, the protection mode, then a destination with no folder,
      // no name and no attributes.
      await this._sendVirtual(VPKT.DEL_VAR, bytes(
        u16(wire.length), wire, 0x00,
        u16(1), attrOut(ATTR.TYPE_REQ, u32(this._typeWord(type, 'delete'))),
        BYPASS_PROTECTION, [0x00, 0x00, 0x00, 0x00],
      ));
      await this._expect([VPKT.DATA_ACK]);
      return { name: printable(name), deleted: true };
    });
  }

  // -------------------------------------------------------------- Flash applications

  /**
   * Send a Flash application (.8ek) to the calculator's Flash. This is the only
   * call in the library that writes an application. `app` is the file's bytes,
   * the result of parseFile / parseAppFile, or its entry.
   *
   * The sequence: buffer negotiation and the normal-mode ping; the battery
   * check (parameter 0x002D; refused with LOW_BATTERY if it says 0); a Request
   * to Send with the name, its NUL, the data length, the silent flag and
   * exactly two attributes, type F0 0F 00 24 then archived 01 (no version);
   * 0xAA00; the whole application in one Variable Contents; 0xAA00; End of
   * Transmission, with no reply awaited. The calculator erases and writes Flash
   * during the two waits and may ask for time with delay acknowledgements.
   */
  sendApp(app, { onProgress } = {}) {
    let entry;
    try { entry = appEntry(app); } catch (e) { return Promise.reject(e); }
    const name = entry.nameBytes instanceof Uint8Array ? entry.nameBytes : utf8.encode(entry.name);
    const size = entry.data.length;
    return this._op(`send app ${printable(name)}`, async () => {
      try {
        await this._begin();
        const q = this.quirks;
        if (q.appBatteryCheck) await this._batteryCheck();
        await this._sendVirtual(VPKT.RTS, bytes(
          u16(name.length), name, 0x00, u32(size), SILENT_SEND,
          u16(2), attrOut(ATTR.TYPE, u32(q.appSendTypeWord)), attrOut(ATTR.ARCHIVED, [0x01]),
        ));
        await this._expect([VPKT.DATA_ACK], this.appTimeout);
        onProgress?.(0, size);
        await this._sendVirtual(VPKT.VAR_CNTS, entry.data, {
          timeout: this.appTimeout,
          onChunk: sent => onProgress?.(Math.max(0, Math.min(size, sent - 6)), size),
        });
        await this._expect([VPKT.DATA_ACK], this.appTimeout);
        await this._sendVirtual(VPKT.EOT, []);
        this._sentAt = performance.now();
        return { name: entry.name, bytes: size };
      } catch (e) {
        if (e?.code === 'CALC_ERROR' && APP_ERRORS[e.calcError]) {
          throw new CELinkError('CALC_ERROR', `The calculator refused the app (error 0x${e.calcError.toString(16).padStart(4, '0')}: ${APP_ERRORS[e.calcError]}).`, { calcError: e.calcError });
        }
        throw e;
      }
    });
  }

  /** The installed Flash applications: list() rows of type 0x24. Read-only. */
  async listApps() {
    return (await this.list()).filter(r => r.type === TYPE.FLASH_APP);
  }

  /**
   * Read an installed application back. The entry it returns has
   * `app.hardwareId` set from the calculator's product number, so buildAppFile(entry)
   * writes a .8ek file.
   */
  receiveApp(name) {
    let wire;
    try { wire = wireName(name); } catch (e) { return Promise.reject(e); }
    return this._op(`receive app ${printable(name)}`, async () => {
      await this._begin();
      const q = this.quirks;
      await this._sendVirtual(VPKT.PARAM_REQ, bytes(u16(1), u16(PARAM.PRODUCT_NUMBER)));
      const pid = parseParamData((await this._expect([VPKT.PARAM_DATA])).data).get(PARAM.PRODUCT_NUMBER);
      const req = q.appReceiveAttributes;
      await this._sendVirtual(VPKT.VAR_REQ, bytes(
        u16(wire.length), wire,
        [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF],
        u16(req.length), ...req.map(u16),
        u16(1), attrOut(ATTR.TYPE_REQ, u32(q.appReceiveTypeWord)),
        [0x00, 0x00],
      ));
      const h = parseVarHeader((await this._expect([VPKT.VAR_HDR])).data);
      const data = (await this._expect([VPKT.VAR_CNTS], this.appTimeout)).data;
      const ver = h.attrs.get(ATTR.VERSION);
      const a = h.attrs.get(ATTR.ARCHIVED);
      const embedded = appNameFromData(data);
      return {
        name: h.name, nameBytes: h.nameBytes, type: TYPE.FLASH_APP, typeName: typeName(TYPE.FLASH_APP),
        version: ver && ver.length ? ver[ver.length - 1] : 0, archived: a ? a[0] !== 0 : true,
        data, size: data.length,
        app: {
          headerName: h.name, embeddedName: embedded ? latin1(embedded) : null,
          hardwareId: pid && pid.length ? pid[pid.length - 1] : undefined,
        },
      };
    });
  }

  /** Delete an installed application (the ordinary delete, type 0x24). */
  deleteApp(name) { return this.delete(name, TYPE.FLASH_APP); }

  /** Before writing Flash: refuse when the calculator says its battery is not good enough. */
  async _batteryCheck() {
    const ids = [PARAM.BATTERY_OK, ...(this.quirks.appBatteryDetail ? [0x002E, 0x002F] : [])];
    await this._sendVirtual(VPKT.PARAM_REQ, bytes(u16(ids.length), ...ids.map(u16)));
    const raw = parseParamData((await this._expect([VPKT.PARAM_DATA])).data);
    const num = id => (raw.has(id) ? rdUint(raw.get(id)) : undefined);
    this.lastBattery = { ok: num(0x002D) === undefined ? undefined : num(0x002D) !== 0, level: num(0x002E), external: num(0x002F) === undefined ? undefined : num(0x002F) !== 0 };
    if (this.lastBattery.ok !== false) return; // good, or not reported: the calculator refuses with 0x002B if it must
    const extra = [];
    if (this.lastBattery.level !== undefined) extra.push(`it reports ${this.lastBattery.level}%`);
    if (this.lastBattery.external) extra.push('it is on external power');
    throw new CELinkError('LOW_BATTERY', `The calculator's battery is too low to write an app to Flash${extra.length ? ` (${extra.join(', ')})` : ''}. Charge it or change the batteries, then try again. Nothing was sent.`);
  }

  // -------------------------------------------------------------- capture

  exportCapture() {
    const state = { out: true, in: true };
    const packets = this.captureLog.map(p => ({ dir: p.dir, t: p.t, hex: hex(p.bytes), note: describeRaw(p.bytes, state, p.dir) }));
    return JSON.stringify({
      format: 'celink-capture/1',
      created: new Date().toISOString(),
      device: { vendorId: hex4(this.device.vendorId), productId: hex4(this.device.productId), productName: this.device.productName ?? null },
      endpoints: this.epIn ? { in: this.epIn.endpointNumber, out: this.epOut.endpointNumber, packetSize: this.epIn.packetSize } : null,
      allocation: this.allocation,
      bufferSize: this.bufferSize,
      quirks: this.quirks,
      ops: this.captureOps,
      packets,
    }, null, 1);
  }

  _log(dir, b) {
    if (!this.capture) return;
    if (this._t0 == null) this._t0 = performance.now();
    this.captureLog.push({ dir, t: Math.round((performance.now() - this._t0) * 10) / 10, bytes: b.slice() });
  }

  // -------------------------------------------------------------- operation plumbing

  /** Close the link and refuse every later call with a clear reason until open() is called again. */
  async _poison(reason) {
    this._poisoned = reason;
    await this.close();
  }

  _op(label, fn) {
    const run = async () => {
      if (this._poisoned) throw new CELinkError('LINK_CLOSED', this._poisoned);
      if (!this.opened) throw new CELinkError('NOT_OPEN', 'The calculator is not connected. Call open() first.');
      if (this.capture) {
        if (this._t0 == null) this._t0 = performance.now();
        this.captureOps.push({ t: Math.round((performance.now() - this._t0) * 10) / 10, op: label });
      }
      try {
        return await fn();
      } catch (e) {
        const err = e instanceof CELinkError ? e : usbError(e);
        if (FATAL.has(err.code)) {
          if (err.code !== 'DISCONNECTED') await this._clearHalts();
          await this.close();
        }
        throw err;
      }
    };
    const p = this._lock.then(run, run);
    this._lock = p.catch(() => {});
    return p;
  }

  /** First recovery step after a stuck transfer: clear a halt on both endpoints. Best effort. */
  async _clearHalts() {
    const d = this.device;
    if (typeof d.clearHalt !== 'function' || !this.epOut) return;
    for (const [dir, ep] of [['out', this.epOut.endpointNumber], ['in', this.epIn.endpointNumber]]) {
      try { await this._timed(d.clearHalt(dir, ep), 500, 'clearing the endpoint'); } catch { /* the close that follows is the real recovery */ }
    }
  }

  /** The 4-byte type attribute for `command` ('send', 'receive' or 'delete'). */
  _typeWord(type, command) {
    if (!Number.isInteger(type) || type < 0 || type > 0xFF) throw new CELinkError('BAD_ENTRY', `Unknown variable type ${type}.`);
    const q = this.quirks;
    const prefix = (q.learnTypePrefix && this._prefixes.get(type)) || q.typePrefixes[command];
    return ((prefix & 0xFFFFFF00) | type) >>> 0;
  }

  /**
   * Every operation starts here: a pause if a send has only just ended, then the
   * buffer size negotiation and Ping / Set Mode. Those two run before every
   * operation by default: the first hardware pass did that and it worked, and it
   * also clears anything an earlier exchange left behind. With
   * `negotiateEachOperation: false` they run once per connection, as they would
   * for a host that keeps the session's allocation and mode.
   */
  async _begin() {
    const q = this.quirks;
    if (this._sentAt != null) {
      const wait = q.settleMs - (performance.now() - this._sentAt);
      this._sentAt = null;
      if (wait > 0) await sleep(wait);
    }
    if (!q.negotiateEachOperation && this._session) return;
    this._session = false;
    this.bufferSize = null;
    await this._writeRaw(RAW.BUF_REQ, u32(q.requestBufferSize));
    for (let i = 0; ; i++) {
      const r = await this._readRaw();
      if (r.type === RAW.BUF_ALLOC && r.data.length === 4) {
        this._setAllocation(rd32(r.data, 0));
        break;
      }
      // Leftovers from an earlier exchange: acknowledge data, skip acks, then retry.
      if (i < 8 && (r.type === RAW.DATA || r.type === RAW.DATA_FINAL)) { await this._writeRaw(RAW.ACK, [0xE0, 0x00]); continue; }
      if (i < 8 && r.type === RAW.ACK) continue;
      throw new CELinkError('PROTOCOL', `Expected a buffer size answer from the calculator, got raw packet type ${r.type}.`);
    }
    await this._sendVirtual(VPKT.PING, bytes(q.modeId, u32(q.pingValue)));
    const ack = await this._expect([VPKT.MODE_ACK]);
    this.lastModeAck = ack.data;
    this._session = true;
  }

  /**
   * Turn a buffer size from the calculator into data bytes per raw packet. On
   * the CE an allocation of 1023 means 1018 data bytes: a 1023-data-byte packet
   * was never acknowledged and wedged the link, and the CE's own packets are
   * 1018 + 5. The CE allocates more than it supports, so 1018 is also a hard
   * ceiling whichever rule is in force.
   */
  _setAllocation(alloc) {
    const q = this.quirks;
    const data = Math.min(q.requestBufferSize - (q.allocIncludesHeader ? 5 : 0), alloc - (q.allocIncludesHeader ? 5 : 0), q.maxDataBytes);
    if (data < 8) throw new CELinkError('PROTOCOL', `The calculator offered an unusable buffer size (${alloc}).`);
    this.allocation = alloc;
    this.bufferSize = data;
  }

  async _sendVirtual(vtype, data, { timeout = this.timeout, onChunk, onFinalWriteStarted, onFinalWritten } = {}) {
    const v = encodeVirtual(vtype, data);
    const q = this.quirks;
    for (let off = 0; ;) {
      // bufferSize is read per packet: the calculator may change it mid-stream.
      const chunk = nextChunk(v, off, this.bufferSize, q.emptyFinalOnBoundary);
      const final = chunk.type === RAW.DATA_FINAL;
      // The point of no return for a reboot-on-landing send: the write of the
      // last data packet is about to start. A calculator that reboots as it
      // lands can make this very transferOut reject even though every USB packet
      // was taken, so from here a link drop is the landing, not a failure.
      if (final) onFinalWriteStarted?.();
      await this._writeRaw(chunk.type, chunk.data, timeout);
      // Without this the CE waits forever for the end of the transfer and the
      // link stays dead until the calculator is unplugged. Only the final packet
      // needs it: the CE's own acknowledgement ends a type 3 exchange.
      if (final && q.zeroLengthAfterFinal && needsZeroLength(chunk.data.length)) {
        await this._writeZeroLength(timeout);
      }
      // The whole payload is now on the wire. A calculator that reboots as the
      // variable lands may never acknowledge from here on.
      if (final) onFinalWritten?.();
      await this._readAck(timeout);
      off += chunk.data.length;
      onChunk?.(off);
      if (final) return;
    }
  }

  /**
   * Read the calculator's acknowledgement of the raw packet just sent. The
   * calculator may instead reopen the buffer size negotiation: it sends its own
   * Buffer Size Request, we answer with an allocation of that same size and use
   * it from the next packet on, and the acknowledgement follows.
   */
  async _readAck(timeout = this.timeout) {
    for (;;) {
      const r = await this._readRaw(timeout);
      if (r.type === RAW.BUF_REQ && r.data.length === 4) {
        const size = rd32(r.data, 0);
        await this._writeRaw(RAW.BUF_ALLOC, u32(size), timeout);
        this._setAllocation(size);
        continue;
      }
      if (r.type === RAW.ACK && (r.data.length === 2 || r.data.length === 4) && r.data[0] === 0xE0 && r.data[1] === 0x00) return;
      throw new CELinkError('PROTOCOL', `The calculator did not acknowledge a packet (got raw type ${r.type}: ${hex(r.data.subarray(0, 8))}).`);
    }
  }

  async _readVirtual(timeout = this.timeout) {
    const chunks = [];
    let total = 0;
    let want = null;
    for (;;) {
      const r = await this._readRaw(timeout);
      if (r.type !== RAW.DATA && r.type !== RAW.DATA_FINAL) {
        throw new CELinkError('PROTOCOL', `Expected data from the calculator, got raw packet type ${r.type}.`);
      }
      await this._writeRaw(RAW.ACK, [0xE0, 0x00], timeout);
      chunks.push(r.data);
      total += r.data.length;
      if (want == null && total >= 4) { const h = bytes(...chunks); want = rd32(h, 0) + 6; }
      if (want != null && total > want) throw new CELinkError('PROTOCOL', 'The calculator sent more data than its packet header announced.');
      if (r.type === RAW.DATA_FINAL) return joinVirtual(chunks);
    }
  }

  /**
   * Read virtual packets until one of `types` arrives. 0xEE00 becomes CALC_ERROR.
   * 0xBB00 is the calculator asking the host to wait before reading on: its first
   * 4 bytes are the delay in microseconds (big-endian), capped at 400 ms; with
   * fewer than 4 bytes the wait is 100 ms.
   */
  async _expect(types, timeout = this.timeout) {
    for (;;) {
      const v = await this._readVirtual(timeout);
      if (v.type === VPKT.DELAY) {
        const ms = delayMs(v.data, this.quirks.delayCapMicros);
        this.lastDelayMs = ms;
        await sleep(ms);
        continue;
      }
      if (v.type === VPKT.ERROR) {
        const code = v.data.length >= 2 ? rd16(v.data, 0) : -1;
        const what = CALC_ERRORS[code] ?? 'an error code this library does not know; please report it';
        throw new CELinkError('CALC_ERROR', `The calculator refused the request (error 0x${code.toString(16).padStart(4, '0')}: ${what}).`, { calcError: code });
      }
      if (types.includes(v.type)) return v;
      throw new CELinkError('PROTOCOL', `Expected ${types.map(vname).join(' or ')} from the calculator, got ${vname(v.type)}.`);
    }
  }

  // -------------------------------------------------------------- raw packets over USB

  async _writeRaw(type, data, timeout = this.timeout) {
    if ((type === RAW.DATA || type === RAW.DATA_FINAL) && data.length > this.bufferSize) {
      throw new CELinkError('PROTOCOL', 'Internal error: a raw packet is larger than the negotiated buffer.');
    }
    const pkt = encodeRaw(type, data);
    this._log('out', pkt);
    const r = await this._timed(this.device.transferOut(this.epOut.endpointNumber, pkt), timeout, 'sending');
    if (r.status !== 'ok' || (r.bytesWritten != null && r.bytesWritten !== pkt.length)) {
      throw new CELinkError('USB_ERROR', `The calculator did not take a packet (USB status "${r.status}", ${r.bytesWritten ?? 0} of ${pkt.length} bytes).`);
    }
  }

  async _writeZeroLength(timeout = this.timeout) {
    const empty = new Uint8Array(0);
    this._log('out', empty);
    const r = await this._timed(this.device.transferOut(this.epOut.endpointNumber, empty), timeout, 'ending a transfer');
    if (r.status !== 'ok') throw new CELinkError('USB_ERROR', `The calculator did not take the zero-length end of a transfer (USB status "${r.status}").`);
  }

  async _readRaw(timeout = this.timeout) {
    for (;;) {
      const r = decodeRaw(this._rx);
      if (r) {
        const pkt = this._rx.slice(0, r.length);
        this._rx = this._rx.slice(r.length);
        this._log('in', pkt);
        return r;
      }
      // Always ask for whole USB packets: a read shorter than the packet the
      // calculator sends is babble. Once the header is in, ask for the rest of the
      // raw packet rounded up to whole packets (it ends on a short packet, or
      // exactly on the boundary); whatever arrives past it is kept for next time.
      const pkt = this.epIn.packetSize || USB_PACKET;
      let want = pkt;
      if (this._rx.length >= 5 && !this.quirks.readOnePacket) {
        const len = rd32(this._rx, 0);
        if (len > 0x10000) throw new CELinkError('PROTOCOL', `The calculator sent a raw packet header claiming ${len} bytes; the link is out of step.`);
        want = Math.max(pkt, Math.ceil((5 + len - this._rx.length) / pkt) * pkt);
      }
      const res = await this._timed(this.device.transferIn(this.epIn.endpointNumber, want), timeout, 'waiting for the calculator');
      if (res.status !== 'ok') throw new CELinkError('USB_ERROR', `Reading from the calculator failed (USB status "${res.status}").`);
      const dv = res.data;
      if (!dv || dv.byteLength === 0) continue;
      this._rx = bytes(this._rx, new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    }
  }

  async _timed(promise, ms, what) {
    let timer;
    promise.catch(() => {}); // a transfer abandoned by a timeout rejects later, on close
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CELinkError('TIMEOUT',
        `The calculator stopped answering (${what}, no reply in ${ms} ms). Check the cable, make sure the calculator is on and at the home screen, then connect again.`)), ms);
    });
    try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
  }
}

// ------------------------------------------------------------------ helpers

/** What the calculator's 0xEE00 error codes mean. The codes (all 24, in this
 *  order) and their meanings follow libticalcs: src/dusb_cmd.cc (usb_errors[])
 *  and src/error.cc. */
export const CALC_ERRORS = {
  0x0004: 'invalid argument or name',
  0x0006: 'a variable or app cannot be deleted from the archive',
  0x0008: 'transmission error',
  0x0009: 'the calculator is in boot mode',
  0x000C: 'the calculator is out of memory. Delete or archive something and try again',
  0x000D: 'invalid name',
  0x000E: 'invalid name',
  0x0011: 'the calculator is busy',
  0x0012: 'a variable with that name is locked and cannot be replaced',
  0x001B: 'the variable is too large for the calculator',
  0x001C: 'the ping value was too small',
  0x001D: 'the ping value was too large',
  0x0021: 'wrong size for that parameter',
  0x0022: 'unknown parameter',
  0x0023: 'that parameter is read-only',
  0x0027: 'bad modify request',
  0x0029: 'remote-control problem',
  0x002B: 'the battery is low. Charge the calculator and try again',
  0x002C: 'the Flash app was rejected',
  0x002D: 'the Flash app was rejected',
  0x002E: 'the Flash app was rejected: its signature does not match',
  0x002F: 'the Flash app was rejected',
  0x0030: 'the Flash app was rejected',
  0x0034: 'the calculator is busy. Go to the home screen and try again',
};

/** Sentences for the codes an application send can meet, in the app's terms. */
export const APP_ERRORS = {
  0x0006: 'an older copy of this app is on the calculator and could not be removed',
  0x000C: 'there is not enough free archive memory for this app. Delete or move something out of the archive and try again',
  0x0011: 'the calculator is busy. Go to the home screen and try again',
  0x001B: 'the app is too large for this calculator',
  0x002B: 'the battery is too low to write Flash. Charge the calculator and try again',
  0x002C: 'the calculator rejected the app',
  0x002D: 'the calculator rejected the app',
  0x002E: 'the calculator rejected the app because its signature does not match. The file may be damaged, changed, or not made for this calculator',
  0x002F: 'the calculator rejected the app',
  0x0030: 'the calculator rejected the app',
  0x0034: 'the calculator is busy. Go to the home screen and try again',
};

/** An application entry from file bytes, a parse result or an entry. */
function appEntry(app) {
  let e = app;
  if (app instanceof Uint8Array || app instanceof ArrayBuffer) e = parseAppFile(app).entries[0];
  else if (app && Array.isArray(app.entries)) e = app.entries[0];
  if (!e || e.type !== TYPE.FLASH_APP || !(e.data instanceof Uint8Array) || e.data.length === 0) {
    throw new CELinkError('BAD_ENTRY', 'sendApp() needs a Flash application: the .8ek file\'s bytes, or what parseFile returned for it.');
  }
  if (!e.name && !e.nameBytes) throw new CELinkError('BAD_NAME', 'The application has no name.');
  return e;
}

function latin1(b) { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; }

/** Pick configuration 1 when it has a bulk IN + OUT pair, else the first one that does. */
export function findBulkInterface(device) {
  const configs = [...(device.configurations ?? [])];
  configs.sort((a, b) => (a.configurationValue === 1 ? -1 : 0) - (b.configurationValue === 1 ? -1 : 0));
  for (const c of configs) {
    for (const i of c.interfaces ?? []) {
      for (const alt of i.alternates ?? [i.alternate]) {
        if (!alt) continue;
        const eps = alt.endpoints ?? [];
        const epIn = eps.find(e => e.type === 'bulk' && e.direction === 'in');
        const epOut = eps.find(e => e.type === 'bulk' && e.direction === 'out');
        if (epIn && epOut) {
          return { configurationValue: c.configurationValue, interfaceNumber: i.interfaceNumber, alternateSetting: alt.alternateSetting ?? 0, epIn, epOut };
        }
      }
    }
  }
  return null;
}

/**
 * Names go over the wire as the calculator's own readable name in UTF-8: "HELLO",
 * "AθB", and for built-ins the subscript spelling, so "L1" is sent as "L₁"
 * (4C E2 82 81) and a named list without its ⌊. Byte arrays (a list() row's
 * nameBytes) pass through untouched.
 */
export function wireName(name, type) {
  if (name instanceof Uint8Array) {
    if (name.length === 0) throw new CELinkError('BAD_NAME', 'A variable name cannot be empty.');
    return name;
  }
  if (typeof name !== 'string' || name.length === 0) throw new CELinkError('BAD_NAME', 'A variable name must be a non-empty string.');
  return utf8.encode(type == null ? name : canonicalName(name, type));
}

/** Milliseconds a Delay Acknowledgement asks for. */
export function delayMs(data, capMicros = 400000) {
  if (!data || data.length < 4) return 100;
  return Math.min(rd32(data, 0), capMicros) / 1000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function printable(name) { return name instanceof Uint8Array ? utf8d.decode(name) : String(name); }
function hex4(n) { return n == null ? null : '0x' + n.toString(16).toUpperCase().padStart(4, '0'); }
function vname(t) { return `0x${t.toString(16).toUpperCase().padStart(4, '0')} (${VPKT_NAMES[t] ?? 'unknown'})`; }

function usbError(e) {
  if (e?.name === 'NotFoundError') return new CELinkError('DISCONNECTED', 'The calculator was unplugged or turned off.');
  return new CELinkError('USB_ERROR', `USB transfer failed: ${e?.message ?? e}`);
}

const RAW_NAMES = { 1: 'buffer size request', 2: 'buffer size allocation', 3: 'data, continues', 4: 'data, final', 5: 'acknowledgement' };

/** One-line description of a captured raw packet. `state` is { out: true, in: true } at the start of a log. */
export function describeRaw(b, state, dir) {
  if (b.length === 0) return 'zero-length write (ends a transfer that filled whole USB packets)';
  const r = decodeRaw(b);
  if (!r) return 'incomplete raw packet';
  let s = `raw ${r.type} (${RAW_NAMES[r.type] ?? 'unknown'}), ${r.data.length} bytes`;
  if (r.type === 1 || r.type === 2) s += `: ${rd32(r.data, 0)}`;
  if (r.type === 3 || r.type === 4) {
    if (state[dir] && r.data.length >= 6) s += ` | virtual ${vname(rd16(r.data, 4))}, ${rd32(r.data, 0)} bytes`;
    else if (!state[dir]) s += ' | continuation';
    state[dir] = r.type === 4;
  }
  return s;
}
