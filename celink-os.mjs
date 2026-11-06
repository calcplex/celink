// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see CREDITS.md in the celink repository.
//
// Sending TI's operating system to a TI-84 Plus CE: reading an .8eu file
// (parseOSFile) and libticalcs' send_os_834pce over WebUSB (sendOS). It is
// its own module so that pages which never send an OS do not carry it. It
// uses celink.mjs's framing helpers and drives the USBDevice itself, the way
// CELink does: one raw packet per transfer, whole-packet reads, every data
// packet acknowledged.
//
// Protocol numbers are big-endian, except the address in each OS Data packet,
// which is little-endian. File numbers are little-endian.

import {
  CALC_ERRORS, CELinkError, EVO_PRODUCT_ID, LINK_LOST, decodeRaw, encodeRaw, encodeVirtual, formatCode,
  infoFromParams, joinVirtual, needsZeroLength, parseParams,
} from './celink.mjs';
import { APP_MAGIC, APP_MAX_DATA, TIFileError } from './tifiles.mjs';

// ---------------------------------------------------------------- the file

// An operating system file (.8eu) is one **TIFL** section, as an application
// file is (tifiles.mjs), with data type 0x23 and hardware id 0x13 (the
// TI-84 Plus CE family). Its data is the OS as TI signed it:
//   80 0F, u32 BE n   the signed header and body, n bytes
//     80 xx ...       header fields, each a 2-byte id whose low nibble is the
//                     length (0xD, 0xE, 0xF: a 1-, 2- or 4-byte length follows)
//                     0x8010 signing key id (13 00 on the CE)
//                     0x80D0 the version (patch, minor, major), then the
//                            lowest version the calculator may take after it
//                     0x8030 build, little-endian
//   02 3x ..., 02 4x ...  TI's signature fields after the body
// The OS also names itself in its text: "BASE Code a.b.c.bbbb".

const SECTION_HEADER = 78;
const OS_TYPE = 0x23;
const OS_DEVICE_TYPE = 0x73;
const CE_HARDWARE_ID = 0x13;
const CE_KEY_ID = [0x13, 0x00];
const MIN_SIGNATURE = 128;
// libticalcs sends as the OS header the data up to the first FF FF FF FF.
const MAX_OS_HEADER = 1024;

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TIFileError('BAD_FILE', 'Expected file bytes (Uint8Array or ArrayBuffer).');
}
function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function readLe32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function readBe32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
/** Bytes as Latin-1 text, NULs included. */
function latin1(b, start = 0, end = b.length) {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 8192)));
  return s;
}

/** One field at `p`: { id (length nibble masked), start of the contents, length }, or null past the end. */
function osField(d, p) {
  if (p + 2 > d.length) return null;
  const raw = (d[p] << 8) | d[p + 1];
  const nibble = raw & 0x0F;
  const width = { 0x0D: 1, 0x0E: 2, 0x0F: 4 }[nibble] ?? 0;
  if (p + 2 + width > d.length) return null;
  let length = width ? 0 : nibble;
  for (let i = 0; i < width; i++) length = length * 256 + d[p + 2 + i];
  return { id: raw & 0xFFF0, start: p + 2 + width, length };
}

function versionTriple(b, o) { return `${b[o + 2]}.${b[o + 1]}.${b[o]}`; }

/**
 * Parse a TI-84 Plus CE operating system file (.8eu). Returns { os } with
 * { version ('5.4.0.0034'), base ('5.4.0'), build, minimum (the lowest OS the
 * calculator may take after this one, 'a.b.c', or null), name, revision,
 * keyId, signatures: [{ id, length }], data (what is sent), size, header
 * (what goes in the OS Header packet) }.
 *
 * Refuses (TIFileError code):
 *   BAD_FILE     not a TI Flash file, cut short, or damaged
 *   NOT_AN_OS    a Flash file that holds no operating system (an application)
 *   WRONG_MODEL  an OS for another calculator (device type, hardware id or key)
 *   NOT_SIGNED   no TI signature after the OS
 *   BAD_VERSION  no version, or the header and the OS's own text disagree
 * The signature itself is checked by the calculator, never here: the bytes
 * are sent exactly as they are in the file.
 */
export function parseOSFile(input) {
  const b = toBytes(input);
  if (b.length < SECTION_HEADER || latin1(b, 0, 8) !== APP_MAGIC) {
    throw new TIFileError('BAD_FILE', 'This is not a calculator operating system file (it does not start with **TIFL**).');
  }
  const h = b.subarray(0, SECTION_HEADER);
  const deviceType = h[48];
  const dataType = h[49];
  const hardwareId = h[73];
  const length = readLe32(h, 74);
  if (dataType !== OS_TYPE) throw new TIFileError('NOT_AN_OS', 'This file holds no operating system.');
  if (deviceType !== OS_DEVICE_TYPE || hardwareId !== CE_HARDWARE_ID) {
    throw new TIFileError('WRONG_MODEL', `This operating system is not for the TI-84 Plus CE (device type 0x${hex2(deviceType)}, hardware id 0x${hex2(hardwareId)}).`);
  }
  if (length > APP_MAX_DATA) throw new TIFileError('BAD_FILE', `The file claims ${length} bytes, more than any operating system can be.`);
  if (SECTION_HEADER + length > b.length) throw new TIFileError('BAD_FILE', 'The operating system is cut short. The file is truncated or damaged.');
  if (SECTION_HEADER + length < b.length) {
    throw new TIFileError('BAD_FILE', `${b.length - SECTION_HEADER - length} bytes follow the operating system. An operating system file holds one section.`);
  }
  const d = b.slice(SECTION_HEADER);
  if (d.length < 6 || d[0] !== 0x80 || d[1] !== 0x0F) throw new TIFileError('BAD_FILE', 'The operating system does not start with its signed header (80 0F).');
  const bodyEnd = 6 + readBe32(d, 2);
  if (bodyEnd > d.length) throw new TIFileError('BAD_FILE', 'The operating system says it is longer than the file. The file is cut short.');

  const fields = new Map();
  for (let p = 6; p < Math.min(bodyEnd, 6 + 0x40) && d[p] === 0x80;) {
    const f = osField(d, p);
    if (!f || f.start + f.length > bodyEnd) throw new TIFileError('BAD_FILE', 'The operating system\'s header is damaged.');
    fields.set(f.id, d.subarray(f.start, f.start + f.length));
    p = f.start + f.length;
  }
  const key = fields.get(0x8010);
  if (key?.length !== 2 || key[0] !== CE_KEY_ID[0] || key[1] !== CE_KEY_ID[1]) {
    throw new TIFileError('WRONG_MODEL', 'This operating system is not signed with the TI-84 Plus CE key.');
  }

  const signatures = [];
  for (let q = bodyEnd; q < d.length;) {
    const f = osField(d, q);
    if (!f || f.start + f.length > d.length) throw new TIFileError('BAD_FILE', 'The fields after the operating system are damaged.');
    signatures.push({ id: f.id, length: f.length });
    q = f.start + f.length;
  }
  if (!signatures.some(s => (s.id >> 8) === 0x02 && s.length >= MIN_SIGNATURE)) {
    throw new TIFileError('NOT_SIGNED', 'This operating system carries no TI signature.');
  }

  const v = fields.get(0x80D0);
  const build = fields.get(0x8030);
  if (!v || v.length < 3 || build?.length !== 2) throw new TIFileError('BAD_VERSION', 'The operating system\'s header has no version.');
  const base = versionTriple(v, 0);
  const number = build[0] | (build[1] << 8);
  const version = `${base}.${String(number).padStart(4, '0')}`;
  const text = /BASE Code (\d+\.\d+\.\d+\.\d{4})/.exec(latin1(d, 0, bodyEnd));
  if (!text) throw new TIFileError('BAD_VERSION', 'The operating system does not name its version.');
  if (text[1] !== version) throw new TIFileError('BAD_VERSION', `The operating system's header says ${version} but its own text says ${text[1]}.`);

  const limit = Math.min(d.length, MAX_OS_HEADER);
  let header = 0;
  while (header + 4 <= limit && !(d[header] === 0xFF && d[header + 1] === 0xFF && d[header + 2] === 0xFF && d[header + 3] === 0xFF)) header++;
  if (header === 0 || header + 4 > limit) throw new TIFileError('BAD_FILE', 'The operating system\'s header has no end marker (FF FF FF FF).');

  return {
    os: {
      version, base, build: number, minimum: v.length >= 6 ? versionTriple(v, 3) : null,
      name: latin1(h, 17, 17 + Math.min(h[16], 8)).replace(/\0.*$/, ''), revision: [h[8], h[9]],
      keyId: 0x0013, signatures, data: d, size: d.length, header: d.subarray(0, header),
    },
  };
}

/** Compares two versions a.b.c[.dddd] part by part: negative, 0 or positive. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- the link

const RAW = Object.freeze({ BUF_REQ: 1, BUF_ALLOC: 2, DATA: 3, DATA_LAST: 4, ACK: 5 });
const VPKT = Object.freeze({
  PING: 0x0001, OS_BEGIN: 0x0002, OS_ACK: 0x0003, OS_HEADER: 0x0004, OS_DATA: 0x0005, EOT_ACK: 0x0006,
  PARAM_REQ: 0x0007, PARAM_DATA: 0x0008, MODE_ACK: 0x0012,
  DATA_ACK: 0xAA00, DELAY_ACK: 0xBB00, EOT: 0xDD00, ERROR: 0xEE00,
});
const MODE_NORMAL = [0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x07, 0xD0]; // { 3, 1, 0, 0, 0x07D0 }
const MODE_BASIC = [0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0F, 0xA0];  // { 2, 1, 0, 0, 0x0FA0 }
// The parameters read before an OS goes out: product, OS and boot versions, battery.
const OS_PARAMS = [0x0001, 0x000B, 0x0048, 0x0009, 0x0049, 0x002D];
const CE_PRODUCT_NUMBER = 0x13;
const REQUEST_SIZE = 1024;
const MAX_RAW_DATA = 1023;
const CE_MAX_DATA = 1018;
const RAW_HEADER = 5;
const DELAY_CAP_US = 400000;
// Where each OS Data packet says its chunk goes: this plus the offset, little-endian.
const OS_ADDRESS = 0x30000;
// libticalcs waits this long between its End of Transmission and the acknowledgement.
const OS_EOT_PAUSE_MS = 500;
const LINK_DROPS = ['TIMEOUT', 'USB_ERROR', 'DISCONNECTED'];

/** The calculator's answer to the normal-mode ping while it waits for an OS (libticalcs: "using basic mode while being in boot mode"). */
export const BOOT_MODE_REFUSAL = 0x0009;
/**
 * The calculator's answer to an OS header it will not install, observed with
 * TI's boot code 5.1.5 in an emulator for an OS older than the calculator
 * allows. It keeps its OS. libticalcs has no description for it.
 */
export const OS_REFUSED = 0x0019;

function be32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function le32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
const protocolError = message => new CELinkError('PROTOCOL', message);

function calcError(data, step) {
  if (data.length < 2) return protocolError('An error packet from the calculator was shorter than its 2-byte code.');
  const code = (data[0] << 8) | data[1];
  if (code === OS_REFUSED && step === 'header') {
    return new CELinkError('OS_REFUSED', `The calculator refused this operating system (error ${formatCode(code)}). It keeps its OS.`, { calcError: code, op: 'sendOS', step });
  }
  const meaning = CALC_ERRORS[code];
  return new CELinkError('CALC_ERROR', `The calculator refused the request (error ${formatCode(code)}${meaning ? `: ${meaning}` : ', not a known code'}).`,
    { calcError: code, op: 'sendOS', step });
}

/** One OS transfer over a USBDevice: celink's framing, for the OS commands. */
class OSLink {
  rx = new Uint8Array(0);
  bufferSize = null;

  constructor(device, { timeout, onPacket }) {
    this.device = device;
    this.timeout = timeout;
    this.onPacket = onPacket;
  }

  async open() {
    const d = this.device;
    if (d.productId === EVO_PRODUCT_ID) throw new CELinkError('TI84_EVO', 'This is a TI-84 Evo. It does not take TI-84 Plus CE files.');
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
    this.in = endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
    this.out = endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
    if (!this.in || !this.out) {
      await this.close();
      throw new CELinkError('NO_ENDPOINTS', 'This USB device does not look like a TI-84 Plus CE (no bulk IN/OUT endpoints were found).');
    }
  }

  async close() {
    try { await this.device.releaseInterface(0); } catch { /* not claimed, or already gone */ }
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  // libticalcs' dusb_cmd_s_mode_set: negotiate the raw packet size, then ping the mode.
  async setMode(mode) {
    await this.writeRaw(RAW.BUF_REQ, be32(REQUEST_SIZE));
    const r = await this.readRaw();
    if (r.type !== RAW.BUF_ALLOC || r.data.length !== 4) throw protocolError(`Expected a buffer size allocation from the calculator, got raw packet type ${r.type}.`);
    this.allocate(readBe32(r.data, 0));
    await this.sendVirtual(VPKT.PING, mode);
    await this.expect([VPKT.MODE_ACK], 'mode');
  }

  // As CELink: a CE allocating 1023 takes 1018 data bytes a packet.
  allocate(size) {
    const data = Math.min(size - RAW_HEADER, CE_MAX_DATA);
    if (data <= 6) throw protocolError(`The calculator allocated an unusable buffer of ${size} bytes.`);
    this.bufferSize = data;
  }

  async sendVirtual(type, data = new Uint8Array(0), timeout = this.timeout) {
    const v = encodeVirtual(type, data);
    for (let offset = 0; offset < v.length;) {
      const last = v.length - offset <= this.bufferSize;
      const chunk = v.subarray(offset, last ? v.length : offset + this.bufferSize);
      await this.writeRaw(last ? RAW.DATA_LAST : RAW.DATA, chunk, timeout);
      if (last && needsZeroLength(chunk.length)) await this.write(new Uint8Array(0), timeout, 'ending a transfer');
      await this.readAck(timeout);
      offset += chunk.length;
    }
  }

  async readAck(timeout) {
    let r = await this.readRaw(timeout);
    if (r.type === RAW.BUF_REQ && r.data.length === 4) {
      const size = readBe32(r.data, 0);
      await this.writeRaw(RAW.BUF_ALLOC, be32(size), timeout);
      this.allocate(size);
      r = await this.readRaw(timeout);
    }
    const ok = r.type === RAW.ACK && (r.data.length === 2 || r.data.length === 4) && r.data[0] === 0xE0 && r.data[1] === 0x00;
    if (!ok) throw protocolError(`The calculator did not acknowledge a packet (it sent raw packet type ${r.type}).`);
  }

  async readVirtual(timeout) {
    const chunks = [];
    for (;;) {
      const r = await this.readRaw(timeout);
      if (r.type !== RAW.DATA && r.type !== RAW.DATA_LAST) throw protocolError(`Expected data from the calculator, got raw packet type ${r.type}.`);
      await this.writeRaw(RAW.ACK, [0xE0, 0x00], timeout);
      chunks.push(r.data);
      if (r.type === RAW.DATA_LAST) return joinVirtual(chunks);
    }
  }

  /** Virtual packets until one of `types`; a delay asked for is waited out, and the reply may then take `busyTimeout`. */
  async expect(types, step, timeout = this.timeout, busyTimeout = timeout) {
    let wait = timeout;
    let deadline = performance.now() + timeout;
    let delayed = false;
    for (;;) {
      const v = await this.readVirtual(wait);
      if (v.type === VPKT.DELAY_ACK) {
        const us = v.data.length >= 4 ? Math.min(readBe32(v.data, 0), DELAY_CAP_US) : DELAY_CAP_US;
        await sleep(Math.floor(us / 1000));
        if (!delayed) {
          delayed = true;
          wait = Math.max(timeout, busyTimeout);
          deadline = Math.max(deadline, performance.now() + wait);
        }
        if (performance.now() > deadline) throw new CELinkError('TIMEOUT', `The calculator kept asking for more time (${step}).`);
        continue;
      }
      if (v.type === VPKT.ERROR) throw calcError(v.data, step);
      if (!types.includes(v.type)) throw protocolError(`Expected 0x${types[0].toString(16)} from the calculator (${step}), got ${formatCode(v.type)}.`);
      return v;
    }
  }

  writeRaw(type, data, timeout = this.timeout) {
    return this.write(encodeRaw(type, data), timeout, 'sending');
  }

  async write(bytes, timeout, what) {
    this.onPacket?.('out', bytes);
    const r = await this.transfer(this.device.transferOut(this.out.endpointNumber, bytes), timeout, what);
    if (r.status !== 'ok' || (r.bytesWritten ?? bytes.length) !== bytes.length) {
      throw new CELinkError('USB_ERROR', `The calculator did not take a packet (USB status "${r.status}", ${r.bytesWritten ?? 0} of ${bytes.length} bytes).`);
    }
  }

  async readRaw(timeout = this.timeout) {
    for (;;) {
      if (this.rx.length >= RAW_HEADER && readBe32(this.rx, 0) > MAX_RAW_DATA) {
        throw protocolError(`The calculator sent a raw packet header of ${readBe32(this.rx, 0)} bytes; the most is ${MAX_RAW_DATA}.`);
      }
      const r = decodeRaw(this.rx);
      if (r) {
        this.onPacket?.('in', this.rx.slice(0, r.length));
        this.rx = this.rx.slice(r.length);
        return r;
      }
      const packet = this.in.packetSize;
      const missing = this.rx.length >= RAW_HEADER ? RAW_HEADER + readBe32(this.rx, 0) - this.rx.length : 0;
      const length = Math.max(packet, Math.ceil(missing / packet) * packet);
      const res = await this.transfer(this.device.transferIn(this.in.endpointNumber, length), timeout, 'waiting for the calculator');
      if (res.status !== 'ok') throw new CELinkError('USB_ERROR', `Reading from the calculator failed (USB status "${res.status}").`);
      if (res.data?.byteLength) this.rx = concat(this.rx, new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
    }
  }

  async transfer(transfer, ms, what) {
    let timer;
    transfer.catch(() => {});
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

// The data bytes per OS Data packet, address included, from an Acknowledgement of OS Transfer.
function osChunk(v) {
  if (v.data.length < 4) throw protocolError('An acknowledgement of the OS transfer from the calculator was shorter than 4 bytes.');
  const n = readBe32(v.data, 0);
  if (n <= 4 || n > 0x10000) throw protocolError(`The calculator asked for OS chunks of ${n} bytes.`);
  return n;
}

/**
 * Install TI's operating system on a TI-84 Plus CE from the bytes of an .8eu
 * file. `device` is the calculator's USBDevice, not open by anyone else (close
 * a CELink on it first); it is opened here and closed again before this
 * returns or throws. The file is checked first (parseOSFile: a TI-signed OS
 * for the TI-84 Plus CE) and sent byte for byte; the calculator checks the
 * signature itself.
 *
 * `version` and `below` are required, each a.b.c. Nothing is sent unless the
 * file is OS `version`, and the calculator is a TI-84 Plus CE (product 0x13)
 * whose OS is older than `below` and whose battery is not reported low. A
 * calculator waiting for an OS (an earlier send stopped part way) has none to
 * compare: it refuses the normal mode with BOOT_MODE_REFUSAL, and gets the OS
 * as libticalcs sends one, with no questions.
 * Refusals are CELinkError: BAD_ENTRY, OS_FILE (`fileCode` is parseOSFile's
 * code), OS_VERSION, NOT_A_CE, OS_UNKNOWN, OS_TOO_NEW, BATTERY_LOW, and the
 * open errors (TI84_EVO, OPEN_FAILED, NO_ENDPOINTS).
 *
 * The send is libticalcs' send_os_834pce: the buffer size and the basic mode
 * (2 1 0 0, 0x0FA0), Begin OS Transfer with the size, the OS header (the data
 * up to the first FF FF FF FF), then the whole OS in chunks of the size the
 * calculator gives in its acknowledgement less 4, each after its address,
 * then End of Transmission. The calculator then checks the OS and restarts.
 * Before that, the calculator is pinged in the normal mode and its parameters
 * read, which libticalcs does not do.
 *
 * Resolves { version, bytes, confirmed, info }. `confirmed` is false when the
 * link dropped after the End of Transmission instead of acknowledging it.
 * Neither says the OS was accepted: a calculator that finds the signature
 * wrong after the transfer waits for an OS instead of restarting with it.
 * Reconnect and read the version to know.
 *
 * An error carries `osStage` ('check', 'mode', 'begin', 'header', 'data',
 * 'eot') and `osBytes`, the OS bytes acknowledged. Through 'header' the
 * calculator keeps its OS: one it will not take (older than it allows) is
 * refused at the header with OS_REFUSED. From 'data' on, the old OS is gone
 * and the calculator waits for an OS: send it again.
 *
 * Options: onProgress(sent, total), onStage(stage), onPacket(dir, bytes),
 * timeout (3000 ms a transfer), osTimeout (30000 ms, for the OS packets and
 * their acknowledgements, which wait on Flash writes), busyTimeout (180000 ms,
 * a reply after the calculator asked for a delay).
 */
export async function sendOS(device, bytes, {
  version, below, onProgress, onStage, onPacket, timeout = 3000, osTimeout = 30000, busyTimeout = 180000,
} = {}) {
  if (!device || typeof device.transferOut !== 'function') throw new CELinkError('NO_DEVICE', 'sendOS() needs the calculator\'s USB device.');
  if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) throw new CELinkError('BAD_ENTRY', 'sendOS() needs the bytes of an .8eu file.');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^\d+\.\d+\.\d+$/.test(below ?? '')) {
    throw new CELinkError('BAD_ENTRY', 'sendOS() needs `version` and `below`, each a.b.c: the OS version it may send, and the OS the calculator must be older than.');
  }
  const refuse = (code, message, details) => new CELinkError(code, message, { osStage: 'check', osBytes: 0, ...details });
  let os;
  try {
    ({ os } = parseOSFile(bytes));
  } catch (e) {
    throw refuse('OS_FILE', `This file cannot be sent as an operating system: ${e.message}`, { cause: e, fileCode: e.code });
  }
  if (os.base !== version) throw refuse('OS_VERSION', `This file is OS ${os.version}; only OS ${version} may be sent.`);

  const link = new OSLink(device, { timeout, onPacket });
  const { data } = os;
  const size = data.length;
  let stage = 'check';
  let acked = 0;
  const enter = s => { stage = s; onStage?.(s); };
  try {
    enter('check');
    await link.open();
    const info = await check(link, below, refuse);
    enter('mode');
    await link.setMode(MODE_BASIC);
    enter('begin');
    await link.sendVirtual(VPKT.OS_BEGIN, new Uint8Array([0, 0, 0, 0, 0, 0, 0, ...be32(size)]));
    let chunk = osChunk(await link.expect([VPKT.OS_ACK], 'begin', osTimeout, busyTimeout));
    enter('header');
    await link.sendVirtual(VPKT.OS_HEADER, os.header, osTimeout);
    chunk = osChunk(await link.expect([VPKT.OS_ACK], 'header', osTimeout, busyTimeout));
    enter('data');
    onProgress?.(0, size);
    // libticalcs sends an empty last chunk when the size divides evenly;
    // here the last chunk is never empty.
    for (let offset = 0; offset < size;) {
      const n = Math.min(chunk - 4, size - offset);
      await link.sendVirtual(VPKT.OS_DATA, concat(le32(OS_ADDRESS + offset), data.subarray(offset, offset + n)), osTimeout);
      await link.expect([VPKT.DATA_ACK], 'data', osTimeout, busyTimeout);
      offset += n;
      acked = offset;
      onProgress?.(offset, size);
    }
    enter('eot');
    let confirmed = true;
    try {
      await link.sendVirtual(VPKT.EOT, new Uint8Array(0), osTimeout);
      await sleep(OS_EOT_PAUSE_MS);
      await link.expect([VPKT.EOT_ACK], 'eot', osTimeout, busyTimeout);
    } catch (e) {
      if (!LINK_DROPS.includes(e.code)) throw e;
      confirmed = false;
    }
    return { version: os.version, bytes: size, confirmed, info };
  } catch (e) {
    if (e instanceof CELinkError) {
      e.osStage ??= stage;
      e.osBytes ??= acked;
      e.lost ??= LINK_LOST.includes(e.code);
    }
    throw e;
  } finally {
    // The calculator has left the mode set here: it restarts with the new OS,
    // waits for one, or stays as it was.
    await link.close();
  }
}

// Before an OS goes out: { waitingForOS: true }, or the info of a calculator
// that passed the checks.
async function check(link, below, refuse) {
  try {
    await link.setMode(MODE_NORMAL);
  } catch (e) {
    if (e.code === 'CALC_ERROR' && e.calcError === BOOT_MODE_REFUSAL) return { waitingForOS: true };
    throw e;
  }
  await link.sendVirtual(VPKT.PARAM_REQ, new Uint8Array([0, OS_PARAMS.length, ...OS_PARAMS.flatMap(id => [id >> 8, id & 0xFF])]));
  const info = infoFromParams(parseParams((await link.expect([VPKT.PARAM_DATA], 'params')).data).params);
  if (info.productNumber !== undefined && info.productNumber !== CE_PRODUCT_NUMBER) {
    throw refuse('NOT_A_CE', `This calculator is not a TI-84 Plus CE (product 0x${info.productNumber.toString(16)}).`, { info });
  }
  if (!info.osVersion) throw refuse('OS_UNKNOWN', 'The calculator did not report its OS version.', { info });
  if (compareVersions(info.osVersion, below) >= 0) {
    throw refuse('OS_TOO_NEW', `The calculator has OS ${info.osVersion}; an OS is sent only to a calculator older than ${below}.`, { info });
  }
  if (info.batteryOk === false) throw refuse('BATTERY_LOW', 'The calculator reports a low battery.', { info });
  return info;
}
