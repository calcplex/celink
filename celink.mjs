// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Derived from libticalcs (tilibs), Copyright (C) the tilibs authors; see CREDITS.md in the celink repository.
//
// A TI-84 Plus CE over WebUSB: its parameters, and listing, sending,
// receiving and deleting variables and Flash applications. It follows
// libticalcs' DUSB code for the CE, and says why wherever it does not. Runs in
// a browser, and in Node against any object shaped like a USBDevice.
//
//   raw packet      u32 size, u8 type, data     one per USB transfer
//   virtual packet  u32 size, u16 type, data    carried in raw packets of type 3 and 4
//
// Protocol numbers are big-endian.

import { TYPE, typeName, nameToBytes, nameToString } from './tifiles.mjs';

export const TI_VENDOR_ID = 0x0451;

const RAW = Object.freeze({ BUF_REQ: 1, BUF_ALLOC: 2, DATA: 3, DATA_LAST: 4, ACK: 5 });

export const VPKT = Object.freeze({
  PING: 0x0001, PARAM_REQ: 0x0007, PARAM_DATA: 0x0008, DIR_REQ: 0x0009, VAR_HDR: 0x000A,
  RTS: 0x000B, VAR_REQ: 0x000C, VAR_CNTS: 0x000D, MODIF_VAR: 0x0010, MODE_ACK: 0x0012,
  DATA_ACK: 0xAA00, DELAY_ACK: 0xBB00, EOT: 0xDD00, ERROR: 0xEE00,
});

const ATTR = Object.freeze({ SIZE: 0x0001, TYPE: 0x0002, ARCHIVED: 0x0003, VERSION: 0x0008, DATATYPE: 0x0011 });

const PARAM = Object.freeze({
  PRODUCT_NUMBER: 0x0001, PRODUCT_NAME: 0x0002, HW_VERSION: 0x0004, LANGUAGE: 0x0006,
  SUB_LANGUAGE: 0x0007, DEVICE_TYPE: 0x0008, BOOT_VERSION: 0x0009, OS_MODE: 0x000A,
  OS_VERSION: 0x000B, PHYS_RAM: 0x000C, USER_RAM: 0x000D, FREE_RAM: 0x000E,
  PHYS_FLASH: 0x000F, USER_FLASH: 0x0010, FREE_FLASH: 0x0011, LCD_WIDTH: 0x001E,
  LCD_HEIGHT: 0x001F, BATTERY_ENOUGH: 0x002D, HOMESCREEN: 0x0037, OS_BUILD: 0x0048,
  BOOT_BUILD: 0x0049,
});

// The ids OS 5.3 and 5.8 have been observed answering. libticalcs' get_version
// also asks for 0x0003, the calculator's unique id, which a web page has no use
// for, and five display and capability ids no 5.8 unit has been asked for (5.3
// answered three and refused two). It does not ask for 0x0037, the home-screen flag.
const INFO_PARAMS = [
  PARAM.PRODUCT_NUMBER, PARAM.PRODUCT_NAME, PARAM.HW_VERSION, PARAM.LANGUAGE, PARAM.SUB_LANGUAGE,
  PARAM.DEVICE_TYPE, PARAM.BOOT_VERSION, PARAM.OS_MODE, PARAM.OS_VERSION, PARAM.OS_BUILD,
  PARAM.BOOT_BUILD, PARAM.PHYS_RAM, PARAM.USER_RAM, PARAM.FREE_RAM, PARAM.PHYS_FLASH,
  PARAM.USER_FLASH, PARAM.FREE_FLASH, PARAM.LCD_WIDTH, PARAM.LCD_HEIGHT, PARAM.BATTERY_ENOUGH,
  PARAM.HOMESCREEN,
];

const REQUEST_SIZE = 1024;
const MAX_RAW_DATA = 1023;
const CE_MAX_DATA = 1018;
const RAW_HEADER = 5;
const VPKT_HEADER = 6;
const USB_PACKET = 64;
const DELAY_CAP_US = 400000;
const MODE_NORMAL = [0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x07, 0xD0]; // { 3, 1, 0, 0, 0x07D0 }
const SILENT = 0x01;
const IGNORE_PROTECTION = 0x01;
const SETTLE_MS = 50;
const CE_PRODUCT_NUMBER = 0x13; // libticalcs gives a received application its model's product number
// A type attribute is F0, an owner byte, 00, the type. libticalcs uses 0x0F on
// the CE, except 0x07 to request a variable and 0x0B to delete one.
const CE_OWNER = 0x0F;
const REQUEST_OWNER = 0x07;
const DELETE_OWNER = 0x0B;

const TIMEOUT_MS = 3000;
const STREAM_TIMEOUT_MS = 15000;
const APP_TIMEOUT_MS = 30000;
const CLEAR_HALT_MS = 500;
// Leftover packets ready() acknowledges or skips before the buffer answer.
const MAX_STALE_PACKETS = 8;

export class CELinkError extends Error {
  constructor(code, message, { cause, ...details } = {}) {
    super(message, { cause });
    this.name = 'CELinkError';
    this.code = code;
    Object.assign(this, details);
  }
}

// libticalcs keeps its handle open after these. Here the link closes: a WebUSB
// transfer that timed out cannot be cancelled and would swallow the next reply,
// and after a reply out of protocol the calculator may still be partway through
// an exchange whose remaining packets nothing would drain.
export const LINK_LOST = Object.freeze(['TIMEOUT', 'USB_ERROR', 'DISCONNECTED', 'PROTOCOL']);
// How a calculator restarting under the link looks from here.
const LINK_DROPS = ['TIMEOUT', 'USB_ERROR', 'DISCONNECTED'];

/** The calculator's error codes (0xEE00 packets), in libticalcs' words, its guesses marked. */
export const CALC_ERRORS = Object.freeze({
  0x0004: 'invalid argument or name',
  0x0006: 'cannot delete var/app from archive',
  0x0008: 'transmission error',
  0x0009: 'using basic mode while being in boot mode',
  0x000C: 'out of memory',
  0x000D: 'invalid name',
  0x000E: 'invalid name',
  0x0011: 'busy?',
  0x0012: 'can\'t overwrite, variable is locked',
  0x001B: 'variable too large',
  0x001C: 'mode token too small',
  0x001D: 'mode token too large',
  0x0021: 'wrong size for parameter',
  0x0022: 'invalid parameter ID',
  0x0023: 'read-only parameter',
  0x0027: 'wrong modify request?',
  0x0029: 'remote control?',
  0x002B: 'battery low',
  0x002C: 'FLASH application rejected (e.g. TI-68k FL_addCert 6)',
  0x002D: 'FLASH application rejected (e.g. TI-68k FL_addCert 7)',
  0x002E: 'FLASH application rejected (signature does not match)',
  0x002F: 'FLASH application rejected (e.g. TI-68k FL_addCert 9)',
  0x0030: 'FLASH application rejected (e.g. TI-68k FL_addCert A)',
  0x0034: 'hand-held is busy (set your calculator to HOME screen)',
});

const protocolError = message => new CELinkError('PROTOCOL', message);

function calcError(data, op, step) {
  if (data.length < 2) return protocolError('An error packet from the calculator was shorter than its 2-byte code.');
  const code = readBe16(data, 0);
  const meaning = CALC_ERRORS[code];
  return new CELinkError('CALC_ERROR',
    `The calculator refused the request (error ${formatCode(code)}${meaning ? `: ${meaning}` : ', not a known code'}).`,
    { calcError: code, op, step });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function be16(n) { return [(n >>> 8) & 0xFF, n & 0xFF]; }
function be32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function readBe16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readBe32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function uint(b) { return b.reduce((n, x) => n * 256 + x, 0); }

/** A calculator error code or packet type as it is written: 0x000C. */
export function formatCode(n) { return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`; }

/** Numbers, arrays of numbers and Uint8Arrays, joined into one Uint8Array. */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + (typeof p === 'number' ? 1 : p.length), 0));
  let o = 0;
  for (const p of parts) {
    if (typeof p === 'number') out[o++] = p;
    else {
      out.set(p, o);
      o += p.length;
    }
  }
  return out;
}

/** Reads fields in order from a packet body; running past the end is a PROTOCOL error. */
function reader(d, what) {
  let p = 0;
  const take = n => {
    if (p + n > d.length) throw protocolError(`${what} from the calculator was cut short.`);
    p += n;
    return d.subarray(p - n, p);
  };
  return { take, u8: () => take(1)[0], u16: () => readBe16(take(2), 0) };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function encodeRaw(type, data = []) {
  return concat(be32(data.length), type, data);
}

/** The first complete raw packet in `b`, or null when `b` does not hold one yet. */
export function decodeRaw(b) {
  if (b.length < RAW_HEADER) return null;
  const size = readBe32(b, 0);
  if (b.length < RAW_HEADER + size) return null;
  return { type: b[4], data: b.slice(RAW_HEADER, RAW_HEADER + size), length: RAW_HEADER + size };
}

export function encodeVirtual(type, data = []) {
  return concat(be32(data.length), be16(type), data);
}

// Contents that exactly fill several raw packets end on the full last packet
// (2030 bytes observed on hardware). libticalcs sends an empty type 4 after it,
// which has never been tried on a CE.
function rawPacketAt(v, offset, size) {
  const last = v.length - offset <= size;
  return { type: last ? RAW.DATA_LAST : RAW.DATA, data: v.subarray(offset, last ? v.length : offset + size) };
}

// For the CE a bulk OUT transfer ends only at a short USB packet, so a final
// raw packet that fills whole packets needs a zero-length write after it
// (libticalcs' workaround_send; the round trip with it was observed on hardware).
export function needsZeroLength(dataLength) {
  return (dataLength + RAW_HEADER) % USB_PACKET === 0;
}

/** The data of raw packets of type 3 and 4, back into { type, data }. */
export function joinVirtual(chunks) {
  if (chunks[0].length < VPKT_HEADER) throw protocolError('A virtual packet from the calculator began with a raw packet shorter than its 6-byte header.');
  const all = concat(...chunks);
  const size = readBe32(all, 0);
  if (size !== all.length - VPKT_HEADER) {
    throw protocolError(`A virtual packet from the calculator declared ${size} bytes but carried ${all.length - VPKT_HEADER}.`);
  }
  return { type: readBe16(all, 4), data: all.slice(VPKT_HEADER) };
}

/** An empty folder, then the name, NUL-terminated. */
function nameField(name) {
  const wire = encoder.encode(name);
  return concat(0x00, wire.length, wire, 0x00);
}
function attribute(id, data) { return concat(be16(id), be16(data.length), data); }
function typeWord(owner, type) { return [0xF0, owner, 0x00, type]; }

const DIR_REQUEST = concat(be32(3), be16(ATTR.SIZE), be16(ATTR.TYPE), be16(ATTR.ARCHIVED), [0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01]);

function paramRequest(ids) {
  return concat(be16(ids.length), ...ids.map(be16));
}

function varRequest(name, type, owner, attributes) {
  return concat(nameField(name), [0x01, 0xFF, 0xFF, 0xFF, 0xFF], be16(attributes.length), ...attributes.map(be16),
    be16(1), attribute(ATTR.DATATYPE, typeWord(owner, type)), [0x00, 0x00]);
}

/** Modify Variable with no destination: a delete. */
function deleteRequest(name, type) {
  return concat(nameField(name), be16(1), attribute(ATTR.DATATYPE, typeWord(DELETE_OWNER, type)),
    IGNORE_PROTECTION, 0x00, 0x00, be16(0));
}

/**
 * Parameter Data (0x0008): { params: Map<id, value>, declared, truncated }.
 * Parameters the calculator refused are absent. A reply cut short keeps the
 * parameters that arrived whole. libticalcs refuses a reply whose count is
 * not the count asked for.
 */
export function parseParams(d) {
  const params = new Map();
  const declared = d.length >= 2 ? readBe16(d, 0) : 0;
  let p = 2;
  for (let i = 0; i < declared; i++) {
    if (p + 3 > d.length) return { params, declared, truncated: true };
    const id = readBe16(d, p);
    const valid = d[p + 2] === 0;
    p += 3;
    if (!valid) continue;
    if (p + 2 > d.length) return { params, declared, truncated: true };
    const length = readBe16(d, p);
    p += 2;
    if (p + length > d.length) return { params, declared, truncated: true };
    params.set(id, d.slice(p, p + length));
    p += length;
  }
  return { params, declared, truncated: d.length < 2 };
}

/** Variable Header (0x000A): { name, attrs: Map<id, value> }; invalid attributes are absent. */
function parseVarHeader(d) {
  const r = reader(d, 'A Variable Header');
  const folderLength = r.u8();
  if (folderLength) r.take(folderLength + 1);
  const nameLength = r.u8();
  const name = nameLength ? decoder.decode(r.take(nameLength + 1).subarray(0, nameLength)) : '';
  const attrs = new Map();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u16();
    if (r.u8() === 0) attrs.set(id, r.take(r.u16()).slice());
  }
  return { name, attrs };
}

// A parameter or attribute is used only at its expected size, as libticalcs
// uses parameters.
function sized(values, id, size) {
  const v = values.get(id);
  return v?.length === size ? v : undefined;
}
function flagOf(values, id) {
  const v = sized(values, id, 1);
  return v && v[0] !== 0;
}
function numberOf(values, id, size) {
  const v = sized(values, id, size);
  return v && uint(v);
}

/** The parameters info() reads, decoded. `params` keeps every value as it came. */
export function infoFromParams(params) {
  const name = params.get(PARAM.PRODUCT_NAME);
  const fields = {
    productName: name && decoder.decode(name.subarray(0, name.includes(0) ? name.indexOf(0) : name.length)),
    productNumber: sized(params, PARAM.PRODUCT_NUMBER, 4)?.[3],
    osVersion: versionString(params.get(PARAM.OS_VERSION), sized(params, PARAM.OS_BUILD, 2)),
    bootVersion: versionString(params.get(PARAM.BOOT_VERSION), sized(params, PARAM.BOOT_BUILD, 2)),
    hardwareVersion: numberOf(params, PARAM.HW_VERSION, 2),
    language: numberOf(params, PARAM.LANGUAGE, 1),
    subLanguage: numberOf(params, PARAM.SUB_LANGUAGE, 1),
    ramFree: numberOf(params, PARAM.FREE_RAM, 8),
    archiveFree: numberOf(params, PARAM.FREE_FLASH, 8),
    lcdWidth: numberOf(params, PARAM.LCD_WIDTH, 2),
    lcdHeight: numberOf(params, PARAM.LCD_HEIGHT, 2),
    batteryOk: flagOf(params, PARAM.BATTERY_ENOUGH),
    atHomescreen: flagOf(params, PARAM.HOMESCREEN),
  };
  const info = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  info.params = params;
  return info;
}

// Bytes 1-3 of the version, then the build number. Without a build libticalcs
// writes a.bb; every CE sends one, and a.b.c keeps versions comparable.
function versionString(v, build) {
  if (v?.length !== 4) return undefined;
  const base = `${v[1]}.${v[2]}.${v[3]}`;
  return build ? `${base}.${String(readBe16(build, 0)).padStart(4, '0')}` : base;
}

// Attributes are read by id. libticalcs reads them by position, which misreads
// a row when the calculator marks one invalid.
function listRow({ name, attrs }) {
  const type = sized(attrs, ATTR.TYPE, 4)?.[3] ?? null;
  return {
    name, type, typeName: type === null ? 'unknown' : typeName(type),
    size: numberOf(attrs, ATTR.SIZE, 4) ?? null, archived: flagOf(attrs, ATTR.ARCHIVED) ?? false,
  };
}

function storage(attrs) {
  return { archived: flagOf(attrs, ATTR.ARCHIVED) ?? false, version: sized(attrs, ATTR.VERSION, 4)?.[3] ?? 0 };
}

// The header's size is authoritative. Contents shorter than it are refused,
// where libticalcs would copy past the end of what arrived.
function trimToSize(contents, attrs) {
  const want = numberOf(attrs, ATTR.SIZE, 4);
  if (want === undefined) return contents;
  if (contents.length < want) throw protocolError(`The calculator declared ${want} bytes but sent ${contents.length}.`);
  return contents.slice(0, want);
}

/** A name as typed or listed: its raw bytes, and the calculator's spelling that goes on the wire. */
function calculatorName(name, type) {
  if (!Number.isInteger(type) || type < 0 || type > 0xFF) throw new CELinkError('BAD_ENTRY', `Unknown variable type ${type}.`);
  const nameBytes = nameToBytes(name, type);
  return { nameBytes, spelled: nameToString(nameBytes, type) };
}

function spelledName(entry) {
  return entry.nameBytes ? nameToString(entry.nameBytes, entry.type) : calculatorName(entry.name, entry.type).spelled;
}

/** onProgress(contents bytes sent, size), from the bytes of the virtual packet written so far. */
function contentsProgress(onProgress, size) {
  return written => onProgress?.(Math.min(size, Math.max(0, written - VPKT_HEADER)), size);
}

function vpktName(type) {
  return Object.keys(VPKT).find(k => VPKT[k] === type) ?? formatCode(type);
}

// What the link tolerates that libticalcs does not, each counted in
// link.anomalies. Whether a CE ever causes the first three is not known:
//   stalePacket    a leftover data or acknowledgement packet before ready()'s
//                  buffer answer, acknowledged or skipped (libticalcs fails)
//   listingAck     a data acknowledgement inside a directory listing, skipped
//                  (libticalcs fails)
//   shortParams    a Parameter Data reply with fewer parameters than asked
//                  for, or cut short (libticalcs fails)
//   haltsCleared   both endpoints cleared before closing on a lost link
//                  (libticalcs never clears a halt after an error)
export const ANOMALIES = Object.freeze(['stalePacket', 'listingAck', 'shortParams', 'haltsCleared']);

export class CELink {
  /** Ask the browser to let the user pick a calculator; `options` are fromDevice's. */
  static async request({ usb = globalThis.navigator?.usb, ...options } = {}) {
    if (!usb) throw new CELinkError('NO_WEBUSB', 'This browser cannot talk to USB devices. Use Chrome or Edge on a computer.');
    let device;
    try {
      device = await usb.requestDevice({ filters: [{ vendorId: TI_VENDOR_ID }] });
    } catch (e) {
      if (e?.name === 'NotFoundError') throw new CELinkError('NO_DEVICE_SELECTED', 'No calculator was chosen.');
      throw new CELinkError('USB_ERROR', `The browser could not show the device list: ${e?.message ?? e}`);
    }
    return CELink.fromDevice(device, options);
  }

  /** TI devices this page was already allowed to use. */
  static async granted({ usb = globalThis.navigator?.usb } = {}) {
    if (!usb) return [];
    return (await usb.getDevices()).filter(d => d.vendorId === TI_VENDOR_ID);
  }

  /**
   * A link over a USBDevice. Timeouts are per USB transfer: `timeout` for
   * commands, `streamTimeout` for variable contents, which the calculator may
   * take a while to archive, and `appTimeout` for a Flash application, which it
   * erases and writes before each acknowledgement. They are longer than
   * libticables' 1.5 s because here a timeout closes the link (see LINK_LOST).
   */
  static fromDevice(device, options) {
    return new CELink(device, options);
  }

  opened = false;
  /** Called with ('out' | 'in', bytes) for every raw packet and zero-length write. */
  onPacket = null;
  /**
   * Counts of what the link let pass where libticalcs would fail, and of the
   * halt clearing it does before closing on a lost link (see ANOMALIES).
   * `onAnomaly(kind, detail)` is called for each one as it happens.
   */
  anomalies = Object.fromEntries(ANOMALIES.map(k => [k, 0]));
  onAnomaly = null;

  #timeout;
  #streamTimeout;
  #appTimeout;
  #in = null;
  #out = null;
  #rx = new Uint8Array(0);
  #bufferSize = null;
  #queue = Promise.resolve();
  #op = null;
  #closedReason = null;

  constructor(device, { timeout = TIMEOUT_MS, streamTimeout = STREAM_TIMEOUT_MS, appTimeout = APP_TIMEOUT_MS } = {}) {
    if (!device) throw new CELinkError('NO_DEVICE', 'No USB device was given.');
    this.device = device;
    this.#timeout = timeout;
    this.#streamTimeout = streamTimeout;
    this.#appTimeout = appTimeout;
  }

  /** Data bytes per raw packet under the negotiated allocation; null until ready. */
  get bufferSize() { return this.#bufferSize; }

  /**
   * Claim interface 0 of configuration 1; call ready() before the first
   * operation. Throws OPEN_FAILED with `step` (open, config, claim) and the
   * WebUSB error as `cause` when WebUSB refuses, leaving the link closed.
   */
  async open() {
    const d = this.device;
    let step = 'open';
    try {
      if (!d.opened) await d.open();
      step = 'config';
      if (d.configuration?.configurationValue !== 1) await d.selectConfiguration(1);
      step = 'claim';
      await d.claimInterface(0);
    } catch (e) {
      await this.close();
      throw new CELinkError('OPEN_FAILED', `Could not open the calculator (${step}): ${e?.message ?? e}`, { step, cause: e });
    }
    const endpoints = d.configuration.interfaces.find(i => i.interfaceNumber === 0)
      ?.alternates.find(a => a.alternateSetting === 0)?.endpoints ?? [];
    this.#in = endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
    this.#out = endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
    if (!this.#in || !this.#out) {
      await this.close();
      throw new CELinkError('NO_ENDPOINTS', 'This USB device does not look like a TI-84 Plus CE (no bulk IN/OUT endpoints were found).');
    }
    this.opened = true;
    this.#closedReason = null;
    this.#rx = new Uint8Array(0);
    return this;
  }

  async close() {
    this.opened = false;
    this.#bufferSize = null;
    try { await this.device.releaseInterface(0); } catch { /* not claimed, or already gone */ }
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  /**
   * libticalcs' is_ready: negotiate the raw packet size, then set the normal
   * mode. Operations never run it themselves.
   */
  ready() {
    return this.#run('ready', async () => {
      await this.#writeRaw(RAW.BUF_REQ, be32(REQUEST_SIZE));
      for (let stale = 0; ; stale++) {
        const r = await this.#readRaw();
        if (r.type === RAW.BUF_ALLOC && r.data.length === 4) {
          this.#allocate(readBe32(r.data, 0));
          break;
        }
        const leftover = r.type === RAW.DATA || r.type === RAW.DATA_LAST || r.type === RAW.ACK;
        if (!leftover || stale === MAX_STALE_PACKETS) {
          throw protocolError(`Expected a buffer size allocation from the calculator, got raw packet type ${r.type}.`);
        }
        if (r.type !== RAW.ACK) await this.#writeRaw(RAW.ACK, [0xE0, 0x00]);
        this.#anomaly('stalePacket', `raw packet type ${r.type} before the buffer size allocation`);
      }
      await this.#sendVirtual(VPKT.PING, MODE_NORMAL);
      await this.#expect([VPKT.MODE_ACK], 'mode');
    });
  }

  /** Model, versions and free memory; see infoFromParams. */
  info() {
    return this.#run('info', async () => {
      await this.#sendVirtual(VPKT.PARAM_REQ, paramRequest(INFO_PARAMS));
      const reply = await this.#expect([VPKT.PARAM_DATA], 'params');
      const { params, declared, truncated } = parseParams(reply.data);
      if (declared !== INFO_PARAMS.length || truncated) {
        this.#anomaly('shortParams', `${declared} of ${INFO_PARAMS.length} parameters declared${truncated ? ', reply cut short' : ''}`);
      }
      const info = infoFromParams(params);
      // Without parameter 0x0002 the model is the name the USB device gives.
      if (info.productName === undefined && this.device.productName) info.productName = this.device.productName;
      return info;
    });
  }

  /** Every variable and application: [{ name, type, typeName, size, archived }]. */
  list() {
    return this.#run('list', async () => {
      await this.#sendVirtual(VPKT.DIR_REQ, DIR_REQUEST);
      const rows = [];
      for (;;) {
        const v = await this.#expect([VPKT.VAR_HDR, VPKT.EOT, VPKT.DATA_ACK], 'dir');
        if (v.type === VPKT.EOT) return rows;
        if (v.type === VPKT.DATA_ACK) {
          this.#anomaly('listingAck', 'a data acknowledgement inside the listing');
          continue;
        }
        rows.push(listRow(parseVarHeader(v.data)));
      }
    });
  }

  /**
   * Send a variable entry (from parseFile or makeEntry), silently replacing
   * one of the same name and type. Resolves { name, bytes, rebooted }.
   *
   * `rebootOnLanding` is for a variable that makes the calculator restart as
   * it lands. From the moment the write of the last contents packet starts, a
   * dropped link is that restart, not a failure: observed on hardware, the
   * restart can reject that very write although every USB packet was taken.
   * The send then resolves with `rebooted: true`, and the link stays closed
   * until the next open().
   */
  async send(entry, { archive = !!entry?.archived, onProgress, rebootOnLanding = false } = {}) {
    if (!(entry?.data instanceof Uint8Array)) throw new CELinkError('BAD_ENTRY', 'send() needs a variable entry with its data (from parseFile or makeEntry).');
    if (entry.type === TYPE.FLASH_APP) throw new CELinkError('UNSUPPORTED_TYPE', 'This is a Flash application: send it with sendApp().');
    const size = entry.data.length;
    const rts = concat(nameField(spelledName(entry)), be32(size), SILENT, be16(3),
      attribute(ATTR.TYPE, typeWord(CE_OWNER, entry.type)),
      attribute(ATTR.ARCHIVED, [archive ? 1 : 0]),
      attribute(ATTR.VERSION, [0, 0, 0, entry.version ?? 0]));
    return this.#run('send', async () => {
      await this.#sendVirtual(VPKT.RTS, rts);
      await this.#expect([VPKT.DATA_ACK], 'rts');
      onProgress?.(0, size);
      let landing = false;
      try {
        await this.#sendVirtual(VPKT.VAR_CNTS, entry.data, {
          timeout: this.#streamTimeout,
          onProgress: contentsProgress(onProgress, size),
          onLastPacket: () => { landing = true; },
        });
        await this.#expect([VPKT.DATA_ACK], 'contents', this.#streamTimeout);
        await this.#sendVirtual(VPKT.EOT);
      } catch (e) {
        if (!(rebootOnLanding && landing && LINK_DROPS.includes(e.code))) throw e;
        await this.close();
        this.#closedReason = 'The calculator restarted as the variable landed. Open the link again to go on.';
        return { name: entry.name, bytes: size, rebooted: true };
      }
      await sleep(SETTLE_MS); // libticalcs pauses after every variable, commented "needed"
      return { name: entry.name, bytes: size, rebooted: false };
    });
  }

  /** Send every entry of a .8xp/.8xv/.8xg file, as parseFile returned it, in order. */
  async sendFile(file, { onProgress, ...options } = {}) {
    if (!Array.isArray(file?.entries)) throw new CELinkError('BAD_ENTRY', 'sendFile() needs a file as parseFile returns it.');
    const { entries } = file;
    if (options.rebootOnLanding && entries.length !== 1) {
      throw new CELinkError('BAD_ENTRY', `rebootOnLanding needs a file with exactly one variable; this one has ${entries.length}.`);
    }
    const results = [];
    for (const [i, e] of entries.entries()) {
      results.push(await this.send(e, { ...options, onProgress: onProgress && ((sent, total) => onProgress(sent, total, i, e)) }));
    }
    return results;
  }

  /** Read a variable back, as an entry buildFile can write. `name` as typed ("L1") or listed ("L₁"). */
  async receive(name, type) {
    if (type === TYPE.FLASH_APP) return this.receiveApp(name);
    const { nameBytes, spelled } = calculatorName(name, type);
    const request = varRequest(spelled, type, REQUEST_OWNER, [ATTR.ARCHIVED, ATTR.VERSION, ATTR.SIZE]);
    return this.#run('receive', async () => {
      await this.#sendVirtual(VPKT.VAR_REQ, request);
      const { attrs } = parseVarHeader((await this.#expect([VPKT.VAR_HDR], 'request')).data);
      const contents = await this.#expect([VPKT.VAR_CNTS], 'contents', this.#streamTimeout);
      const data = trimToSize(contents.data, attrs);
      return { name: spelled, nameBytes, type, typeName: typeName(type), ...storage(attrs), data, size: data.length };
    });
  }

  async delete(name, type) {
    const { spelled } = calculatorName(name, type);
    return this.#run('delete', async () => {
      await this.#sendVirtual(VPKT.MODIF_VAR, deleteRequest(spelled, type));
      await this.#expect([VPKT.DATA_ACK], 'delete');
    });
  }

  /** Write the Flash application of a .8ek file, as parseAppFile returned it. */
  async sendApp(file, { onProgress } = {}) {
    const entry = file?.entries?.[0];
    if (entry?.type !== TYPE.FLASH_APP || !entry.data?.length) throw new CELinkError('BAD_ENTRY', 'sendApp() needs a Flash application, as parseAppFile returns it.');
    const size = entry.data.length;
    const timeout = this.#appTimeout;
    const rts = concat(nameField(spelledName(entry)), be32(size), SILENT, be16(2),
      attribute(ATTR.TYPE, typeWord(CE_OWNER, TYPE.FLASH_APP)), attribute(ATTR.ARCHIVED, [1]));
    return this.#run('sendApp', async () => {
      await this.#sendVirtual(VPKT.RTS, rts);
      await this.#expect([VPKT.DATA_ACK], 'rts', timeout);
      onProgress?.(0, size);
      await this.#sendVirtual(VPKT.VAR_CNTS, entry.data, {
        timeout,
        onProgress: contentsProgress(onProgress, size),
      });
      await this.#expect([VPKT.DATA_ACK], 'contents', timeout);
      await this.#sendVirtual(VPKT.EOT);
      await sleep(SETTLE_MS); // libticalcs does not pause here; no app send has run on hardware without it
      return { name: entry.name, bytes: size };
    });
  }

  /** Read an installed application back, as an entry buildAppFile can write. */
  async receiveApp(name) {
    const { nameBytes, spelled } = calculatorName(name, TYPE.FLASH_APP);
    const request = varRequest(spelled, TYPE.FLASH_APP, CE_OWNER, [ATTR.ARCHIVED, ATTR.VERSION]);
    return this.#run('receiveApp', async () => {
      await this.#sendVirtual(VPKT.VAR_REQ, request);
      const { attrs } = parseVarHeader((await this.#expect([VPKT.VAR_HDR], 'request')).data);
      const { data } = await this.#expect([VPKT.VAR_CNTS], 'contents', this.#appTimeout);
      return {
        name: spelled, nameBytes, type: TYPE.FLASH_APP, typeName: typeName(TYPE.FLASH_APP),
        ...storage(attrs), data, size: data.length, app: { hardwareId: CE_PRODUCT_NUMBER },
      };
    });
  }

  /** The installed applications: list() rows of type 0x24. */
  async listApps() {
    return (await this.list()).filter(r => r.type === TYPE.FLASH_APP);
  }

  deleteApp(name) {
    return this.delete(name, TYPE.FLASH_APP);
  }

  // One operation at a time: a call made while another runs waits its turn.
  #run(op, fn) {
    const run = async () => {
      if (this.#closedReason) throw new CELinkError('LINK_CLOSED', this.#closedReason);
      if (!this.opened) throw new CELinkError('NOT_OPEN', 'The calculator is not connected. Call open() first.');
      if (op !== 'ready' && this.#bufferSize === null) throw new CELinkError('NOT_READY', 'The link is not ready. Call ready() first.');
      this.#op = op;
      try {
        return await fn();
      } catch (e) {
        if (LINK_LOST.includes(e?.code)) {
          if (e.code !== 'DISCONNECTED') await this.#clearHalts();
          await this.close();
        }
        throw e;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  // Best effort: the close that follows is the real recovery.
  async #clearHalts() {
    if (typeof this.device.clearHalt !== 'function' || !this.#out) return;
    for (const [direction, endpoint] of [['out', this.#out], ['in', this.#in]]) {
      try {
        await this.#transfer(this.device.clearHalt(direction, endpoint.endpointNumber), CLEAR_HALT_MS, 'clearing the endpoint');
      } catch { /* already gone */ }
    }
    this.#anomaly('haltsCleared', 'both endpoints, before closing the link');
  }

  #anomaly(kind, detail) {
    this.anomalies[kind]++;
    try { this.onAnomaly?.(kind, detail); } catch { /* a listener never breaks the link */ }
  }

  // A CE allocating 1023 takes 1018 data bytes a packet, and a larger packet
  // wedged it until replugged (observed on hardware). Leaving room for the
  // 5-byte raw header at any allocation keeps to that; libticalcs caps at 1018.
  #allocate(size) {
    const data = Math.min(size - RAW_HEADER, CE_MAX_DATA);
    if (data <= VPKT_HEADER) throw protocolError(`The calculator allocated an unusable buffer of ${size} bytes.`);
    this.#bufferSize = data;
  }

  async #sendVirtual(type, data = [], { timeout = this.#timeout, onProgress, onLastPacket } = {}) {
    const v = encodeVirtual(type, data);
    for (let offset = 0; offset < v.length;) {
      // Split packet by packet: the calculator may ask for a new size in between.
      const packet = rawPacketAt(v, offset, this.#bufferSize);
      const last = packet.type === RAW.DATA_LAST;
      if (last) onLastPacket?.();
      await this.#writeRaw(packet.type, packet.data, timeout);
      if (last && needsZeroLength(packet.data.length)) await this.#write(new Uint8Array(0), timeout, 'ending a transfer');
      await this.#readAck(timeout);
      offset += packet.data.length;
      onProgress?.(offset);
    }
  }

  async #readAck(timeout) {
    let r = await this.#readRaw(timeout);
    if (r.type === RAW.BUF_REQ && r.data.length === 4) {
      // Allocated as asked, as libticalcs does; #allocate still caps the data per packet.
      const size = readBe32(r.data, 0);
      await this.#writeRaw(RAW.BUF_ALLOC, be32(size), timeout);
      this.#allocate(size);
      r = await this.#readRaw(timeout);
    }
    // libticalcs accepts 2 or 4 bytes and rejects only when both bytes are wrong; here both must be E0 00.
    const ok = r.type === RAW.ACK && (r.data.length === 2 || r.data.length === 4) && r.data[0] === 0xE0 && r.data[1] === 0x00;
    if (!ok) throw protocolError(`The calculator did not acknowledge a packet (it sent raw packet type ${r.type}).`);
  }

  async #readVirtual(timeout) {
    const chunks = [];
    for (;;) {
      const r = await this.#readRaw(timeout);
      if (r.type !== RAW.DATA && r.type !== RAW.DATA_LAST) throw protocolError(`Expected data from the calculator, got raw packet type ${r.type}.`);
      await this.#writeRaw(RAW.ACK, [0xE0, 0x00], timeout);
      chunks.push(r.data);
      if (r.type === RAW.DATA_LAST) return joinVirtual(chunks);
    }
  }

  /** Read virtual packets until one of `types`. `step` names the reply in a CALC_ERROR. */
  async #expect(types, step, timeout = this.#timeout) {
    const deadline = performance.now() + timeout;
    for (;;) {
      const v = await this.#readVirtual(timeout);
      if (v.type === VPKT.DELAY_ACK) {
        // libticalcs reads 4 bytes whatever arrived; a shorter delay gets the longest wait it could.
        const us = v.data.length >= 4 ? Math.min(readBe32(v.data, 0), DELAY_CAP_US) : DELAY_CAP_US;
        await sleep(Math.floor(us / 1000));
        // libticalcs takes one delay per reply. Later ones are waited out too,
        // since refusing them could only lose a send; the deadline bounds them.
        if (performance.now() > deadline) throw new CELinkError('TIMEOUT', `The calculator kept asking for more time (${step}).`);
        continue;
      }
      if (v.type === VPKT.ERROR) throw calcError(v.data, this.#op, step);
      if (!types.includes(v.type)) {
        throw protocolError(`Expected ${types.map(vpktName).join(' or ')} from the calculator (${step}), got ${vpktName(v.type)}.`);
      }
      return v;
    }
  }

  #writeRaw(type, data, timeout = this.#timeout) {
    return this.#write(encodeRaw(type, data), timeout, 'sending');
  }

  async #write(bytes, timeout, what) {
    this.onPacket?.('out', bytes);
    const r = await this.#transfer(this.device.transferOut(this.#out.endpointNumber, bytes), timeout, what);
    if (r.status !== 'ok' || (r.bytesWritten ?? bytes.length) !== bytes.length) {
      throw new CELinkError('USB_ERROR', `The calculator did not take a packet (USB status "${r.status}", ${r.bytesWritten ?? 0} of ${bytes.length} bytes).`);
    }
  }

  async #readRaw(timeout = this.#timeout) {
    for (;;) {
      if (this.#rx.length >= RAW_HEADER && readBe32(this.#rx, 0) > MAX_RAW_DATA) {
        throw protocolError(`The calculator sent a raw packet header of ${readBe32(this.#rx, 0)} bytes; the most is ${MAX_RAW_DATA}.`);
      }
      const r = decodeRaw(this.#rx);
      if (r) {
        this.onPacket?.('in', this.#rx.slice(0, r.length));
        this.#rx = this.#rx.slice(r.length);
        return r;
      }
      // Reads ask for whole USB packets: one until the header is in, then the
      // rest of the raw packet rounded up. libticalcs reads one packet at a
      // time; whole-packet reads are what ran on hardware.
      const packet = this.#in.packetSize;
      const missing = this.#rx.length >= RAW_HEADER ? RAW_HEADER + readBe32(this.#rx, 0) - this.#rx.length : 0;
      const length = Math.max(packet, Math.ceil(missing / packet) * packet);
      const res = await this.#transfer(this.device.transferIn(this.#in.endpointNumber, length), timeout, 'waiting for the calculator');
      if (res.status !== 'ok') throw new CELinkError('USB_ERROR', `Reading from the calculator failed (USB status "${res.status}").`);
      if (res.data?.byteLength) this.#rx = concat(this.#rx, new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
    }
  }

  async #transfer(transfer, ms, what) {
    let timer;
    transfer.catch(() => {}); // a transfer abandoned by a timeout rejects later, on close
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CELinkError('TIMEOUT', `The calculator did not answer within ${ms} ms (${what}).`, { ms, during: what })), ms);
    });
    try {
      return await Promise.race([transfer, timeout]);
    } catch (e) {
      if (e instanceof CELinkError) throw e;
      if (e?.name === 'NotFoundError') throw new CELinkError('DISCONNECTED', 'The calculator was unplugged or turned off.');
      throw new CELinkError('USB_ERROR', `USB transfer failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
