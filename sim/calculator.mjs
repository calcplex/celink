// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
// Portions derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see LIBTICALCS.md.
//
// A simulated TI-84 Plus CE that speaks the documented USB protocol from the
// calculator's side, behind the same USBDevice-shaped interface WebUSB gives
// the library. It is the test oracle, so it is strict: anything Moody's 2006
// analysis says (or reasonably implies) a calculator would not accept is
// recorded in `violations` and answered with a USB stall, or with an error
// virtual packet when the problem is at the command level.
//
// Default values mirror a real CE where one was observed (descriptors, the
// parameter-data layout, a 1023-byte allocation that counts the raw header, and
// what an oversize raw packet does to it); see README.md.

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/** Error codes. The real ones (below 0x7F00) mean what the calculator's do; the
 *  0x7Fxx ones are placeholders for refusals whose real code is not known. */
export const SIM_ERR = Object.freeze({
  PING_TOO_SMALL: 0x001C, PING_TOO_BIG: 0x001D, BAD_PARAM: 0x0022,
  NO_MEMORY: 0x000C, TOO_LARGE: 0x001B, LOCKED: 0x0012, NOT_HOME: 0x0034,
  BATTERY_LOW: 0x002B, BAD_SIGNATURE: 0x002E,
  NO_MODE: 0x7F01, WRONG_MODE: 0x7F02, BAD_PACKET: 0x7F03, NOT_FOUND: 0x7F04,
  UNSUPPORTED: 0x7F06, BAD_NAME: 0x7F07, BAD_MODE: 0x7F08, OUT_OF_ORDER: 0x7F09,
});

const MODES = {
  '000100010000': [0x0001],
  '000200010000': [0x0001, 0x0002, 0x0007],
  '000300010000': [0x0001, 0x0007, 0x0009, 0x000B, 0x000C, 0x000E, 0x0010, 0x0011],
};
const TYPE_PREFIXES = [0xF0030000, 0xF0070000, 0xF00B0000, 0xF00F0000];
const PROGRAM_TYPES = [0x05, 0x06];

function u16(n) { return [(n >>> 8) & 0xFF, n & 0xFF]; }
function u32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function u64(n) { const hi = Math.floor(n / 2 ** 32); return [...u32(hi), ...u32(n >>> 0)]; }
function rd16(b, o) { return (b[o] << 8) | b[o + 1]; }
function rd32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function cat(...parts) {
  const len = parts.reduce((n, p) => n + (typeof p === 'number' ? 1 : p.length), 0);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { if (typeof p === 'number') out[o++] = p; else { out.set(p, o); o += p.length; } }
  return out;
}
function hexs(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
function domError(name, message) { const e = new Error(message); e.name = name; return e; }

/** Reads one field after another from a packet body; throws 'short' past the end. */
function reader(d) {
  let p = 0;
  const take = n => { if (p + n > d.length) throw new Error('short'); const s = d.subarray(p, p + n); p += n; return s; };
  return {
    u8: () => take(1)[0], u16: () => rd16(take(2), 0), u32: () => rd32(take(4), 0), take,
    get left() { return d.length - p; },
  };
}

/** The name field (0x8140, length nibble masked) in an application image's header, or null. */
function appHeaderName(d) {
  for (let p = 6; p + 2 <= d.length;) {
    const id = rd16(d, p); p += 2;
    const n = id & 0x0F;
    let len = n;
    if (n === 0x0D) { len = d[p]; p += 1; } else if (n === 0x0E) { len = rd16(d, p); p += 2; } else if (n === 0x0F) { len = rd32(d, p); p += 4; }
    if (p + len > d.length) return null;
    if ((id & 0xFFF0) === 0x8140) return d.subarray(p, p + len);
    p += len;
  }
  return null;
}

function parseName(r) { return utf8d.decode(r.take(r.u16())); }
function parseAttrs(r) {
  const m = new Map();
  const n = r.u16();
  for (let i = 0; i < n; i++) { const id = r.u16(); m.set(id, r.take(r.u16()).slice()); }
  return m;
}

export class SimulatedCalculator {
  constructor({
    bufferSize = 1023,          // the allocation this calculator answers with
    allocIncludesHeader = true, // the allocation counts the 5-byte raw header, as on the real CE
    packetSize = 64,
    productId = 0xE008,
    productName = 'TI-84 Plus CE',
    os = { major: 5, minor: 8, micro: 5, build: 74 },
    boot = { major: 5, minor: 0, micro: 0, build: 89 },
    ramFree = 154000,
    archiveFree = 2372475,
    vars = [],
    invalidParams = [0x0023, 0x005D],
    endpointIn = 1,
    endpointOut = 2,
    extraInterfaceFirst = false,
    configurations = 3,
    sendDelayPacket = false,      // shorthand for delays: { 0x0008: 120000 }
    delays = {},                  // { replyType: microseconds or payload bytes }: send 0xBB00 before that reply
    emptyFinalOnBoundary = false, // end our own boundary-sized virtual packets with an empty type 4
    dataCap = 1018,               // most data bytes per raw packet the CE takes, whatever it allocated
    renegotiate = null,           // { afterPackets, size }: send our own Buffer Size Request mid-stream
    battery = { ok: true, level: 100, external: false }, // parameters 0x002D, 0x002E, 0x002F
    eraseDelayMicros = 20000,     // per 64 KB of an application: a Delay Acknowledgement while Flash is erased
    writeDelayMicros = 30000,     // one Delay Acknowledgement while an application is written
  } = {}) {
    // ---- USBDevice surface
    this.vendorId = 0x0451;
    this.productId = productId;
    this.productName = productName;
    this.manufacturerName = 'Texas Instruments Inc.';
    this.serialNumber = undefined;
    this.deviceVersionMajor = 2; this.deviceVersionMinor = 2; this.deviceVersionSubminor = 0;
    this.usbVersionMajor = 2; this.usbVersionMinor = 0; this.usbVersionSubminor = 0;
    this.opened = false;
    this.configuration = null;
    this.configurations = [];
    for (let c = 1; c <= configurations; c++) {
      const bulk = {
        interfaceNumber: extraInterfaceFirst ? 1 : 0, claimed: false,
        alternate: {
          alternateSetting: 0, interfaceClass: 0xFF, interfaceSubclass: 1, interfaceProtocol: 0,
          endpoints: [
            { endpointNumber: endpointIn, direction: 'in', type: 'bulk', packetSize },
            { endpointNumber: endpointOut, direction: 'out', type: 'bulk', packetSize },
          ],
        },
      };
      bulk.alternates = [bulk.alternate];
      const interfaces = [bulk];
      if (extraInterfaceFirst) {
        const decoy = { interfaceNumber: 0, claimed: false, alternate: { alternateSetting: 0, interfaceClass: 3, endpoints: [{ endpointNumber: 5, direction: 'in', type: 'interrupt', packetSize: 8 }] } };
        decoy.alternates = [decoy.alternate];
        interfaces.unshift(decoy);
      }
      this.configurations.push({ configurationValue: c, configurationName: null, interfaces });
    }

    // ---- calculator state
    this.maxBuffer = bufferSize;
    this.allocIncludesHeader = allocIncludesHeader;
    this.wedged = false;       // set by an oversize raw packet; only replug() clears it
    this.packetSize = packetSize;
    this.os = os; this.boot = boot;
    this.ramFree = ramFree; this.archiveFree = archiveFree;
    this.invalidParams = new Set(invalidParams);
    this.delays = new Map(Object.entries(delays).map(([k, v]) => [+k, v]));
    if (sendDelayPacket && !this.delays.has(0x0008)) this.delays.set(0x0008, 120000);
    this.dataCap = dataCap;
    this.renegotiate = renegotiate;
    this.battery = { ...battery };
    this.eraseDelayMicros = eraseDelayMicros;
    this.writeDelayMicros = writeDelayMicros;
    this._hostDataCount = 0;
    this.emptyFinalOnBoundary = emptyFinalOnBoundary;
    this.vars = new Map();
    for (const v of vars) this._store(v.name, v.type, v.data, !!v.archived, v.version ?? 0);
    this.padContents = 0;     // test hook: extra bytes after a variable's contents on receive

    // ---- test hooks
    this.violations = [];     // strictness failures, as plain sentences
    this.log = [];            // every raw packet: { dir: 'out' (host->calc) | 'in', bytes }
    this.freeze = false;      // stop answering (simulates a hung or unplugged calculator)
    this.disconnected = false; // reads and writes reject (simulates the calculator gone from the bus)
    this._rejectThisWrite = false; // the transferOut in progress rejects after taking the packet
    this._reboot = null;      // { key, early, mode }: drop the link as a named variable lands
    this.errorOn = new Map(); // vtype -> error code to answer with
    this.commands = [];       // virtual packets received: { type, data }
    this.clearedHalts = [];   // clearHalt() calls: [direction, endpoint]
    this.settleMs = 50;       // how long after a send the calculator needs before the next operation

    this._resetLink();
  }

  /**
   * Test hook: reboot as a variable lands. `mode` 'silent' goes quiet (the host
   * times out); 'disconnect' drops off the bus (reads and writes reject);
   * 'reject-write' rejects the OUT transfer that carried the final packet (every
   * USB packet was taken) and then leaves the bus. With
   * `early`, the drop happens one contents packet before the last, to prove a
   * failure before the final write is not treated as a landing.
   */
  rebootWhenLands(name, type, { early = false, mode = 'silent' } = {}) {
    this._reboot = { key: `${type}:${name}`, early, mode };
  }

  _dropLink(mode) {
    if (mode === 'reject-write') {
      // The reboot rejects the very transfer that carried the final packet, the
      // way a real CE did on OS 5.8.x: every USB packet was taken, but the OUT
      // transfer never reports complete. The calculator is off the bus after it.
      this.disconnected = true;
      this._rejectThisWrite = true;
    } else if (mode === 'disconnect') {
      this.disconnected = true;
      const w = this._waiters.splice(0);
      for (const x of w) x.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    } else {
      this.freeze = true;
    }
  }

  // ================================================================ USBDevice methods

  async open() { this.opened = true; }
  /** Test helper: unplug and plug back in, which is the only thing that clears a wedge. */
  replug() { this.wedged = false; this.freeze = false; this.disconnected = false; this._rejectThisWrite = false; this._reboot = null; this._heldFinal = null; this._resetLink(); }
  async close() {
    this.opened = false;
    if (this._heldFinal) {
      // The host gave up waiting for an acknowledgement that could never come.
      this.wedged = true;
      this._violation('The host closed the device while the calculator was still waiting for the zero-length end of a transfer; the calculator stops answering.');
      this._heldFinal = null;
    }
    for (const c of this.configurations) for (const i of c.interfaces) i.claimed = false;
    const w = this._waiters.splice(0);
    for (const x of w) x.reject(domError('AbortError', 'The transfer was cancelled because the device was closed.'));
    this._resetLink();
  }
  async selectConfiguration(value) {
    this._needOpen();
    const c = this.configurations.find(x => x.configurationValue === value);
    if (!c) throw domError('NotFoundError', `No configuration ${value}.`);
    this.configuration = c;
  }
  async claimInterface(n) {
    this._needOpen();
    const i = this.configuration?.interfaces.find(x => x.interfaceNumber === n);
    if (!i) throw domError('NotFoundError', `No interface ${n} in the current configuration.`);
    i.claimed = true;
  }
  async releaseInterface(n) {
    this._needOpen();
    const i = this.configuration?.interfaces.find(x => x.interfaceNumber === n);
    if (!i) throw domError('NotFoundError', `No interface ${n}.`);
    i.claimed = false;
  }
  async selectAlternateInterface() { this._needOpen(); }
  async clearHalt(dir, ep) { this._needOpen(); this.clearedHalts.push([dir, ep]); }

  get claimed() { return !!this.configuration?.interfaces.some(i => i.claimed && i.alternate.endpoints.some(e => e.type === 'bulk')); }

  transferOut(ep, data) {
    try { this._needEndpoint(ep, 'out'); } catch (e) { return Promise.reject(e); }
    const b = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    this.log.push({ dir: 'out', bytes: b });
    if (this.disconnected) return Promise.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    if (this.freeze || this.wedged) return Promise.resolve({ status: 'ok', bytesWritten: b.length });
    if (b.length === 0) {
      this._zeroLength(); // a final packet that filled whole USB packets lands here
      if (this._rejectThisWrite) { this._rejectThisWrite = false; return Promise.reject(domError('NotFoundError', 'The transfer did not complete: the calculator reset.')); }
      return Promise.resolve({ status: 'ok', bytesWritten: 0 });
    }
    if (this._heldFinal) {
      // The CE is still inside the previous bulk transfer: these bytes run on
      // into it, the raw framing is lost, and the link is dead until replugged.
      this.wedged = true;
      this._heldFinal = null;
      this._violation('A new transfer was sent after a final raw packet that filled whole 64-byte USB packets, without the zero-length write that ends it; the calculator stops answering.');
      return Promise.resolve({ status: 'ok', bytesWritten: b.length });
    }
    const ok = this._hostRaw(b);
    if (this._rejectThisWrite) {
      // Set by a reboot rule while this very packet was processed: the packets
      // landed, but the transfer rejects instead of reporting complete.
      this._rejectThisWrite = false;
      return Promise.reject(domError('NotFoundError', 'The transfer did not complete: the calculator reset.'));
    }
    return Promise.resolve(ok ? { status: 'ok', bytesWritten: b.length } : { status: 'stall', bytesWritten: 0 });
  }

  transferIn(ep, length) {
    try { this._needEndpoint(ep, 'in'); } catch (e) { return Promise.reject(e); }
    if (this.disconnected) return Promise.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    if (length % this.packetSize !== 0) this._violation(`transferIn(${length}) asks for part of a ${this.packetSize}-byte USB packet; reads must be whole packets.`);
    if (this._delayUntil != null) {
      // The host acknowledged a Delay Acknowledgement; its next read must wait
      // that long (capped at 400 ms). 2 ms of slack for timer granularity.
      const early = this._delayUntil - performance.now();
      this._delayUntil = null;
      if (early > 2) this._violation(`The host read again ${Math.round(early)} ms before the delay the calculator asked for was over.`);
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ length, resolve, reject });
      this._serve();
    });
  }

  // ================================================================ strictness helpers

  _needOpen() { if (!this.opened) throw domError('InvalidStateError', 'The device is not open.'); }
  _needEndpoint(ep, dir) {
    this._needOpen();
    const i = this.configuration?.interfaces.find(x => x.alternate.endpoints.some(e => e.endpointNumber === ep && e.direction === dir));
    if (!i) throw domError('NotFoundError', `No ${dir} endpoint ${ep} in the current configuration.`);
    if (!i.claimed) throw domError('InvalidStateError', 'The interface is not claimed.');
    const e = i.alternate.endpoints.find(x => x.endpointNumber === ep && x.direction === dir);
    if (e.type !== 'bulk') throw domError('InvalidAccessError', 'Not a bulk endpoint.');
  }
  _violation(msg) { this.violations.push(msg); return false; }

  _resetLink() {
    this._waiters = this._waiters ?? [];
    this._heldFinal = null;    // a final raw packet waiting for its zero-length write
    this._delayUntil = null;   // when the host may read again after a Delay Acknowledgement
    this._sentAt = null;       // when the last send's End of Transmission arrived
    this._awaitingAlloc = null; // our own Buffer Size Request, waiting for the host's allocation
    this.negotiated = null;   // allocation agreed for the current operation
    this.maxData = null;      // data bytes allowed per raw packet under that allocation
    this.mode = null;         // mode id set by the ping, as hex
    this.phase = 'idle';      // idle | wait-contents | wait-eot
    this._pending = null;     // variable being received by the calculator
    this._rxChunks = [];      // host -> calc raw data for the virtual packet being assembled
    this._queue = [];         // calc -> host raw packets not yet released
    this._current = null;     // { bytes, off, needsAck, endsOp } being read by the host
    this._awaitingAck = null; // raw packet the host has read and must acknowledge
  }

  // The negotiated size and the mode last for the session (until the device is
  // closed or replugged); a host may still negotiate and ping again at any time.
  _endOperation() {
    this.phase = 'idle';
    this._pending = null;
  }

  // ================================================================ raw layer

  _hostRaw(b) {
    if (b.length < 5) return this._violation('A transfer shorter than a raw packet header was sent.');
    const len = rd32(b, 0);
    if (len !== b.length - 5) return this._violation(`One USB transfer must carry exactly one raw packet (header says ${len} data bytes, transfer has ${b.length - 5}).`);
    const type = b[4];
    const data = b.subarray(5);
    if (type !== 5 && this._current?.needsAck) return this._violation('A new packet was sent while the calculator was still sending one.');
    if (type !== 5 && this._awaitingAck) return this._violation(`Raw packet type ${type} was sent before acknowledging the calculator's last packet.`);
    if (type !== 5 && this._ackUnread()) return this._violation(`Raw packet type ${type} was sent before reading the calculator's acknowledgement.`);
    if (type !== 2 && this._awaitingAlloc) return this._violation(`Raw packet type ${type} was sent before answering the calculator's Buffer Size Request.`);
    if (type !== 5 && this._sentAt != null) {
      const since = performance.now() - this._sentAt;
      this._sentAt = null;
      // 2 ms of slack for timer granularity.
      if (since < this.settleMs - 2) this._violation(`The next operation started ${Math.round(since)} ms after a send ended; the calculator needs ${this.settleMs} ms to commit a variable.`);
    }

    switch (type) {
      case 1: {
        if (len !== 4) return this._violation('A Buffer Size Request must hold 4 bytes.');
        const want = rd32(data, 0);
        this._endOperation();
        this.negotiated = Math.min(want, this.maxBuffer);
        this.maxData = Math.min(this.negotiated - (this.allocIncludesHeader ? 5 : 0), this.dataCap);
        this._queueRaw(2, u32(this.negotiated));
        return true;
      }
      case 2: {
        const w = this._awaitingAlloc;
        if (!w) return this._violation('Raw packet type 2 is not one a host may send unless the calculator asked for a buffer size.');
        if (len !== 4 || rd32(data, 0) !== w.size) return this._violation(`The host answered the calculator's Buffer Size Request for ${w.size} with ${len === 4 ? rd32(data, 0) : 'a malformed allocation'}.`);
        this._awaitingAlloc = null;
        this.negotiated = w.size;
        this.maxData = Math.min(w.size - (this.allocIncludesHeader ? 5 : 0), this.dataCap);
        w.then();
        return true;
      }
      case 3: case 4: {
        if (this.negotiated == null) return this._violation('Data was sent before the buffer size was negotiated.');
        if (len > this.maxData) {
          // What the real CE did: no acknowledgement, and no answer to anything until replugged.
          this.wedged = true;
          this._violation(`A raw packet of ${len} data bytes (${len + 5} total) exceeds the allocation of ${this.negotiated}${this.allocIncludesHeader ? ' (header included)' : ''}; the calculator stops answering.`);
          return true;
        }
        if (len === 0) {
          const have = this._rxChunks.reduce((n, c) => n + c.length, 0);
          const whole = this._rxChunks.length && have >= 6 && rd32(cat(...this._rxChunks), 0) + 6 === have;
          if (type === 3 || !whole) return this._violation('An empty data raw packet was sent that does not end a complete virtual packet.');
          // Ending an exactly-full virtual packet with an empty type 4 is what the
          // real CE (OS 5.3) never acknowledges: the link stops
          // answering until replugged. The last full raw packet must be the type 4.
          this.wedged = true;
          this._violation('An empty type 4 ended a virtual packet that exactly filled its raw packets; the calculator stops answering.');
          return true;
        }
        if (type === 4 && (len + 5) % this.packetSize === 0) {
          // Fills whole USB packets: the calculator's side of the bulk transfer is
          // not over until a zero-length write arrives.
          this._heldFinal = data.slice();
          return true;
        }
        return this._acceptData(type, data);
      }
      case 5: {
        if (!this._awaitingAck) return this._violation('An acknowledgement was sent when none was due.');
        if (len !== 2 || data[0] !== 0xE0 || data[1] !== 0x00) return this._violation('An acknowledgement must hold E0 00.');
        const acked = this._awaitingAck;
        this._awaitingAck = null;
        if (acked.delayMs != null) this._delayUntil = performance.now() + acked.delayMs;
        if (acked.endsOp) this._endOperation();
        this._release();
        return true;
      }
      default:
        return this._violation(`Raw packet type ${type} is not one a host may send.`);
    }
  }

  /** A host data packet that is complete on the USB side: acknowledge it, and act on a finished virtual packet. */
  _acceptData(type, data) {
    this._rxChunks.push(data.slice());
    this._hostDataCount++;
    // "Reboot when this variable lands": drop the link on the final contents
    // packet (or one before it), the way an OS that reboots on a magic variable
    // would, so no acknowledgement follows.
    if (this._reboot && this.phase === 'wait-contents' && this._pending
        && `${this._pending.type}:${this._pending.name}` === this._reboot.key) {
      this._contentsSeen = (this._contentsSeen ?? 0) + 1;
      const trigger = this._reboot.early ? this._contentsTotal - 1 : this._contentsTotal;
      if (this._contentsSeen >= trigger) { this._dropLink(this._reboot.mode); return true; }
    }
    const finish = () => {
      this._queueRaw(5, [0xE0, 0x00]);
      if (type !== 4) return;
      const all = cat(...this._rxChunks);
      this._rxChunks = [];
      if (all.length < 6 || rd32(all, 0) !== all.length - 6) {
        this._queueError(SIM_ERR.BAD_PACKET);
        this._violation('A virtual packet\'s length field does not match the data sent.');
        return;
      }
      this._virtual(rd16(all, 4), all.subarray(6));
    };
    const r = this.renegotiate;
    if (r && this._hostDataCount === r.afterPackets) {
      // Reopen the negotiation instead of acknowledging; the acknowledgement
      // follows once the host has answered with an allocation.
      this._awaitingAlloc = { size: r.size, then: finish };
      this._queueRaw(1, u32(r.size));
      return true;
    }
    finish();
    return true;
  }

  _zeroLength() {
    if (!this._heldFinal) { this._violation('A zero-length write arrived when no transfer needed ending.'); return; }
    const data = this._heldFinal;
    this._heldFinal = null;
    this._acceptData(4, data);
  }

  _ackUnread() {
    return (this._current && !this._current.needsAck) || this._queue.some(p => !p.needsAck);
  }

  _queueRaw(type, data, endsOp = false, delayMs = null) {
    this._queue.push({ bytes: cat(u32(data.length), type, data), off: 0, needsAck: type === 3 || type === 4, endsOp, delayMs });
    this._release();
  }

  _queueVirtual(vtype, data, { endsOp = false } = {}) {
    if (this.freeze) return;
    let delayMs = null;
    if (vtype === 0xBB00) {
      delayMs = data.length >= 4 ? Math.min(rd32(data, 0), 400000) / 1000 : 100;
    } else if (this.delays.has(vtype)) {
      const d = this.delays.get(vtype);
      this._queueVirtual(0xBB00, typeof d === 'number' ? u32(d) : d);
    }
    const v = cat(u32(data.length), u16(vtype), data);
    const size = this.maxData ?? 250;
    for (let off = 0; ;) {
      const left = v.length - off;
      const more = left > size || (left === size && this.emptyFinalOnBoundary);
      const n = more ? size : left;
      this._queueRaw(more ? 3 : 4, v.subarray(off, off + n), !more && endsOp, more ? null : delayMs);
      off += n;
      if (!more) break;
    }
  }

  _queueError(code) { this._queueVirtual(0xEE00, u16(code), { endsOp: true }); }

  _release() {
    this._promote();
    this._serve();
  }

  _promote() {
    if (!this._current && !this._awaitingAck && this._queue.length) {
      this._current = this._queue.shift();
      this.log.push({ dir: 'in', bytes: this._current.bytes });
    }
  }

  // Deliver bytes to pending transferIn calls one USB packet (at most packetSize
  // bytes) at a time. A transfer ends on a short packet or when its length is
  // reached. No zero-length packet follows a raw packet that ends on a full USB
  // packet, so a transfer asking for more than is left keeps waiting.
  _serve() {
    while (this._waiters.length && this._current) {
      const w = this._waiters[0];
      w.buf ??= [];
      w.got ??= 0;
      const c = this._current;
      const chunk = Math.min(this.packetSize, c.bytes.length - c.off);
      if (chunk > w.length - w.got) {
        this._waiters.shift();
        this._violation(`transferIn(${w.length}) had room for ${w.length - w.got} more bytes but the next USB packet is ${chunk}: babble.`);
        w.resolve({ status: 'babble', data: new DataView(new ArrayBuffer(0)) });
        continue;
      }
      w.buf.push(c.bytes.subarray(c.off, c.off + chunk));
      c.off += chunk;
      w.got += chunk;
      if (c.off === c.bytes.length) {
        this._current = null;
        if (c.needsAck) this._awaitingAck = c;
      }
      if (chunk < this.packetSize || w.got === w.length) {
        this._waiters.shift();
        const data = cat(...w.buf);
        w.resolve({ status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) });
      }
      this._promote();
    }
  }

  // ================================================================ virtual packets

  _virtual(type, d) {
    this.commands.push({ type, data: d.slice() });
    if (this.freeze) return;
    try {
      if (this.errorOn.has(type)) return this._queueError(this.errorOn.get(type));
      if (type === 0x0001) return this._ping(d);
      if (this.mode == null) { this._violation(`Command 0x${type.toString(16)} was sent before the mode ping.`); return this._queueError(SIM_ERR.NO_MODE); }
      if (this.phase === 'wait-contents') return type === 0x000D ? this._contents(d) : this._outOfOrder(type);
      if (this.phase === 'wait-eot') return type === 0xDD00 ? this._eot() : this._outOfOrder(type);
      if (!MODES[this.mode].includes(type)) { this._violation(`Command 0x${type.toString(16)} is not accepted in mode ${this.mode}.`); return this._queueError(SIM_ERR.WRONG_MODE); }
      switch (type) {
        case 0x0007: return this._paramRequest(d);
        case 0x0009: return this._dirList(d);
        case 0x000B: return this._rts(d);
        case 0x000C: return this._varRequest(d);
        case 0x000E: return this._queueError(SIM_ERR.BAD_PARAM);
        case 0x0010: return this._delete(d);
        default: return this._queueError(SIM_ERR.UNSUPPORTED);
      }
    } catch (e) {
      if (e.message !== 'short') throw e;
      this._violation(`Command 0x${type.toString(16)} was cut short.`);
      this._queueError(SIM_ERR.BAD_PACKET);
    }
  }

  _outOfOrder(type) {
    this._violation(`Command 0x${type.toString(16)} arrived while a send was in progress (${this.phase}).`);
    this._queueError(SIM_ERR.OUT_OF_ORDER);
  }

  _ping(d) {
    if (d.length !== 10) { this._violation('A ping must hold 10 bytes.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const mode = hexs(d.subarray(0, 6));
    const value = rd32(d, 6);
    if (value < 2000) return this._queueError(SIM_ERR.PING_TOO_SMALL);
    if (value > 131071) return this._queueError(SIM_ERR.PING_TOO_BIG);
    if (!MODES[mode]) return this._queueError(SIM_ERR.BAD_MODE);
    this.mode = mode;
    this._queueVirtual(0x0012, u32(value));
  }

  _paramRequest(d) {
    const r = reader(d);
    const n = r.u16();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(r.u16());
    if (r.left !== 0) { this._violation('Parameter Request has trailing bytes.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const values = this.params();
    const out = [u16(ids.length)];
    for (const id of ids) {
      const v = this.invalidParams.has(id) ? undefined : values[id];
      if (v === undefined) out.push([...u16(id), 1]);
      else out.push([...u16(id), 0, ...u16(v.length), ...v]);
    }
    this._queueVirtual(0x0008, cat(...out), { endsOp: true });
  }

  /** Parameter values; layout as observed on a real CE (see README). */
  params() {
    const ver = v => [...u16(v.major), v.minor, v.micro];
    return {
      0x0001: u32(0x13), 0x0002: [...utf8.encode('TI-84 Plus CE')], 0x0004: u16(7),
      0x0006: [9], 0x0007: [1], 0x0008: u16(0x0073), 0x0009: ver(this.boot), 0x000A: [1],
      0x000B: ver(this.os), 0x0048: u16(this.os.build), 0x0049: u16(this.boot.build),
      0x000C: u64(0x40000), 0x000D: u64(0x27000), 0x000E: u64(this.ramFree),
      0x000F: u64(0x400000), 0x0010: u64(0x360000), 0x0011: u64(this.archiveFree),
      0x001B: [1], 0x001D: [0x10], 0x001E: u16(320), 0x001F: u16(240),
      0x002D: [this.battery.ok ? 1 : 0], 0x002E: [this.battery.level], 0x002F: [this.battery.external ? 1 : 0],
      0x0037: [1], 0x004B: [0],
    };
  }

  _typeFrom(attrs, id) {
    const t = attrs.get(id);
    if (!t || t.length !== 4) return null;
    const word = rd32(t, 0);
    if (!TYPE_PREFIXES.includes((word & 0xFFFFFF00) >>> 0)) return null;
    return word & 0xFF;
  }

  _dirList(d) {
    const r = reader(d);
    const n = r.u32();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(r.u16());
    const tail = r.take(r.left);
    if (hexs(tail) !== '00010001000101') { this._violation(`Directory request tail is ${hexs(tail)}, expected 00010001000101.`); return this._queueError(SIM_ERR.BAD_PACKET); }
    const vars = [...this.vars.values()];
    vars.forEach(v => this._queueVirtual(0x000A, this._header(v, ids)));
    this._queueVirtual(0xDD00, [], { endsOp: true });
  }

  _header(v, ids) {
    const name = utf8.encode(v.name);
    const parts = [u16(name.length), name, 0x00, u16(ids.length)];
    for (const id of ids) {
      const val = id === 0x0001 ? u32(v.data.length) : id === 0x0002 ? u32((0xF0070000 | v.type) >>> 0)
        : id === 0x0003 ? [v.archived ? 1 : 0] : id === 0x0008 ? u32(v.version ?? 0) : null;
      parts.push(val ? [...u16(id), 0, ...u16(val.length), ...val] : [...u16(id), 1]);
    }
    return cat(...parts);
  }

  _rts(d) {
    const r = reader(d);
    const name = parseName(r);
    const mid = r.take(6);
    const attrs = parseAttrs(r);
    if (r.left !== 0) { this._violation('Request to Send has trailing bytes.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    // After the name: its NUL, the 4-byte size, the mode flag (01 silent, 02 not).
    const type = this._typeFrom(attrs, 0x0002);
    if (type == null) { this._violation('Request to Send is missing a valid type (0x0002) attribute.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const size = rd32(mid, 1);
    if (mid[0] !== 0x00 || (mid[5] !== 0x01 && mid[5] !== 0x02)) {
      this._violation(`Request to Send bytes after the name are ${hexs(mid)}.`);
      return this._queueError(SIM_ERR.BAD_PACKET);
    }
    if (type === 0x24) return this._rtsApp(name, size, mid, attrs);
    const sizeAttr = attrs.get(0x0001);
    if (sizeAttr && (sizeAttr.length !== 4 || rd32(sizeAttr, 0) !== size)) {
      this._violation('Request to Send carries a size attribute (0x0001) that disagrees with its size field.');
      return this._queueError(SIM_ERR.BAD_PACKET);
    }
    // The CE declares the non-silent variable send unsupported (libticalcs;
    // LIBTICALCS.md 23).
    if (mid[5] === 0x02) return this._queueError(SIM_ERR.UNSUPPORTED);
    const verAttr = attrs.get(0x0008);
    if (verAttr && verAttr.length !== 4) { this._violation('Request to Send has a version attribute (0x0008) that is not 4 bytes.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const version = verAttr ? verAttr[3] : 0;
    const archived = attrs.get(0x0003)?.[0] === 1;
    if (!this._wireNameOk(name, type) || !this._validName(name, type)) return this._queueError(SIM_ERR.BAD_NAME);
    const old = this.vars.get(`${type}:${name}`);
    const freeRam = this.ramFree + (old && !old.archived ? old.data.length + 9 : 0);
    const freeArc = this.archiveFree + (old && old.archived ? old.data.length + 17 : 0);
    if (archived ? size + 17 > freeArc : size + 9 > freeRam) return this._queueError(SIM_ERR.NO_MEMORY);
    this._pending = { name, type, size, archived, version };
    this.phase = 'wait-contents';
    // How many raw packets the contents will arrive in (used by the reboot rule).
    this._contentsTotal = Math.max(1, Math.ceil((6 + size) / (this.maxData ?? 250)));
    this._contentsSeen = 0;
    this._queueVirtual(0xAA00, [0x01]);
  }

  /**
   * A Flash application: exactly two attributes, type F0 0F 00 24 then archived
   * 01, the silent flag, no version. The battery and free Flash are checked here;
   * then the calculator erases (one delay per 64 KB) and acknowledges.
   */
  _rtsApp(name, size, mid, attrs) {
    const got = [...attrs.entries()].map(([id, v]) => `${id.toString(16).padStart(4, '0')}=${hexs(v)}`).join(' ');
    if (got !== '0002=f00f0024 0003=01') {
      this._violation(`An application's Request to Send must carry exactly 0002=f00f0024 then 0003=01; it carried ${got}.`);
      return this._queueError(SIM_ERR.BAD_PACKET);
    }
    if (mid[5] !== 0x01) { this._violation('An application must be sent silently (flag 01).'); return this._queueError(SIM_ERR.BAD_PACKET); }
    if (!this.battery.ok) return this._queueError(SIM_ERR.BATTERY_LOW);
    if (!this._validName(name, 0x24)) return this._queueError(SIM_ERR.BAD_NAME);
    const old = this.vars.get(`36:${name}`);
    if (size + 17 > this.archiveFree + (old ? old.data.length + 17 : 0)) return this._queueError(SIM_ERR.NO_MEMORY);
    this._pending = { name, type: 0x24, size, archived: true, version: 0, app: true };
    this.phase = 'wait-contents';
    if (this.eraseDelayMicros) for (let i = 0; i < Math.ceil(size / 65536); i++) this._queueVirtual(0xBB00, u32(this.eraseDelayMicros));
    this._queueVirtual(0xAA00, [0x01]);
  }

  _contents(d) {
    const p = this._pending;
    if (d.length !== p.size) { this._violation(`Variable Contents is ${d.length} bytes, the Request to Send said ${p.size}.`); return this._queueError(SIM_ERR.BAD_PACKET); }
    if (p.app) {
      // What a signature check would catch first: not an application image, or no name in its header.
      if (d[0] !== 0x81 || d[1] !== 0x0F || !appHeaderName(d)) return this._queueError(SIM_ERR.BAD_SIGNATURE);
      if (this.writeDelayMicros) this._queueVirtual(0xBB00, u32(this.writeDelayMicros));
    }
    this._store(p.name, p.type, d.slice(), p.archived, p.version);
    this.phase = 'wait-eot';
    this._queueVirtual(0xAA00, [0x01]);
  }

  _eot() {
    // No reply to the host's End of Transmission.
    this._endOperation();
    this._sentAt = performance.now();
  }

  _varRequest(d) {
    const r = reader(d);
    const name = parseName(r);
    const mid = r.take(6);
    if (hexs(mid) !== '0001ffffffff') { this._violation(`Request Variable bytes after the name are ${hexs(mid)}, expected 0001ffffffff.`); return this._queueError(SIM_ERR.BAD_PACKET); }
    const n = r.u16();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(r.u16());
    const attrs = parseAttrs(r);
    const tail = r.take(r.left);
    if (hexs(tail) !== '0000') { this._violation(`Request Variable tail is ${hexs(tail)}, expected 0000.`); return this._queueError(SIM_ERR.BAD_PACKET); }
    if (attrs.has(0x0002) && !attrs.has(0x0011)) { this._violation('Request Variable gave the type as attribute 0x0002; the document says 0x0011.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const type = this._typeFrom(attrs, 0x0011);
    if (type == null) { this._violation('Request Variable has no valid type attribute 0x0011.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    if (type === 0x24 && hexs(attrs.get(0x0011)) !== 'f00f0024') {
      this._violation(`Requesting an application takes type F0 0F 00 24; this asked with ${hexs(attrs.get(0x0011))}.`);
      return this._queueError(SIM_ERR.NOT_FOUND);
    }
    if (!this._wireNameOk(name, type)) return this._queueError(SIM_ERR.NOT_FOUND);
    const v = this.vars.get(`${type}:${name}`);
    if (!v) return this._queueError(SIM_ERR.NOT_FOUND);
    this._queueVirtual(0x000A, this._header(v, ids));
    this._queueVirtual(0x000D, this.padContents ? cat(v.data, new Uint8Array(this.padContents)) : v.data, { endsOp: true });
  }

  _delete(d) {
    const r = reader(d);
    const name = parseName(r);
    if (r.u8() !== 0x00) { this._violation('Delete Variable: expected 00 after the name.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    const attrs = parseAttrs(r);
    const tail = r.take(r.left);
    if (hexs(tail) !== '0100000000') { this._violation(`Delete Variable tail is ${hexs(tail)}, expected 0100000000.`); return this._queueError(SIM_ERR.BAD_PACKET); }
    const type = this._typeFrom(attrs, 0x0011) ?? this._typeFrom(attrs, 0x0002);
    if (type == null) { this._violation('Delete Variable has no valid type attribute.'); return this._queueError(SIM_ERR.BAD_PACKET); }
    if (!this._wireNameOk(name, type)) return this._queueError(SIM_ERR.NOT_FOUND);
    const key = `${type}:${name}`;
    const v = this.vars.get(key);
    if (!v) return this._queueError(SIM_ERR.NOT_FOUND);
    this._free(v);
    this.vars.delete(key);
    this._queueVirtual(0xAA00, [0x01], { endsOp: true });
  }

  // ================================================================ variable store

  /**
   * Built-in lists and equations are named with subscript digits on the wire
   * (L₁, Y₁, r₁, X₁⊺); a named list has no ⌊ in front. A host that sends "L1" in
   * ASCII is addressing a variable that cannot exist.
   */
  _wireNameOk(name, type) {
    if ([0x01, 0x0D].includes(type)) {
      if (/^L[0-9]$/.test(name)) return this._violation(`List name "${name}" uses an ASCII digit; the built-in lists are L followed by a subscript digit.`);
      if (name.startsWith('⌊')) return this._violation(`List name "${name}" starts with ⌊, which is not part of a named list's name.`);
    }
    if ([0x03, 0x0B].includes(type) && /^([Yr][0-9]|[XY][1-6]T)$/.test(name)) {
      return this._violation(`Equation name "${name}" uses an ASCII digit; built-in equations use subscript digits.`);
    }
    return true;
  }

  _validName(name, type) {
    const chars = [...name];
    if (chars.length < 1 || chars.length > 8) return false;
    if (PROGRAM_TYPES.includes(type)) return /^[A-Zθ][A-Z0-9θ]*$/u.test(name);
    return true;
  }

  _store(name, type, data, archived, version = 0) {
    const key = `${type}:${name}`;
    const old = this.vars.get(key);
    if (old) this._free(old); // a silent send overwrites without asking
    if (archived) this.archiveFree -= data.length + 17; else this.ramFree -= data.length + 9;
    this.vars.set(key, { name, type, data, archived, version });
  }

  _free(v) {
    if (v.archived) this.archiveFree += v.data.length + 17; else this.ramFree += v.data.length + 9;
  }

  /** Test helper: the stored variable, or undefined. */
  get(name, type) { return this.vars.get(`${type}:${name}`); }
}
