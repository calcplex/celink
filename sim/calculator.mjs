// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Portions derived from libticalcs (tilibs), Copyright (C) the tilibs authors; see CREDITS.md in the celink repository.
//
// A simulated TI-84 Plus CE behind the USBDevice interface WebUSB gives the
// library. It is the test oracle, so it is strict. It does what a CE was
// observed doing on hardware; where hardware is silent it expects what
// libticalcs sends. Anything else is recorded in `violations` and answered
// with a USB stall, or with an error packet when the problem is at the
// command level. Its byte helpers are its own on purpose, so that a bug in
// the library's cannot hide in both.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Error codes. 0x0001 and those below 0x7F00 mean what the calculator's do;
 * 0x7Fxx stand for refusals whose real code is not known.
 */
export const SIM_ERR = Object.freeze({
  NO_MODE: 0x0001, // seen on hardware; that the host had not pinged the mode is inferred
  READ_REFUSED: 0x0006, NO_MEMORY: 0x000C, PING_TOO_SMALL: 0x001C, PING_TOO_BIG: 0x001D, BATTERY_LOW: 0x002B, BAD_SIGNATURE: 0x002E,
  PROGRAM_RUNNING: 0x0036,
  WRONG_MODE: 0x7F02, BAD_PACKET: 0x7F03, NOT_FOUND: 0x7F04, UNSUPPORTED: 0x7F06,
  BAD_NAME: 0x7F07, BAD_MODE: 0x7F08, OUT_OF_ORDER: 0x7F09,
});

const MODES = {
  '000100010000': [0x0001],
  '000200010000': [0x0001, 0x0002, 0x0007],
  '000300010000': [0x0001, 0x0007, 0x0009, 0x000B, 0x000C, 0x000E, 0x0010, 0x0011],
};
/** The command each reply step answers, for `refuse`. */
const STEPS = { 0x0001: 'mode', 0x0007: 'params', 0x0009: 'dir', 0x000B: 'rts', 0x000D: 'contents', 0x000C: 'request', 0x0010: 'delete' };
// The owner bytes a type attribute may carry.
const TYPE_PREFIXES = [0xF0030000, 0xF0070000, 0xF00B0000, 0xF00F0000];
const PROGRAM_TYPES = [0x05, 0x06];
const LIST_TYPES = [0x01, 0x0D];
const EQUATION_TYPES = [0x03, 0x0B];
const FLASH_APP = 0x24;
const MAX_DATA = 1018; // data bytes per raw packet the CE takes, whatever it allocates
const SETTLE_MS = 50;  // after a variable's End of Transmission, before the next command

function be16(n) { return [(n >>> 8) & 0xFF, n & 0xFF]; }
function be32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function be64(n) { return [...be32(Math.floor(n / 2 ** 32)), ...be32(n >>> 0)]; }
function readBe16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readBe32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + (typeof p === 'number' ? 1 : p.length), 0));
  let o = 0;
  for (const p of parts) {
    if (typeof p === 'number') out[o++] = p;
    else { out.set(p, o); o += p.length; }
  }
  return out;
}
function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
function domError(name, message) { return Object.assign(new Error(message), { name }); }

/** Reads one field after another from a packet body; throws 'short' past the end. */
function reader(d) {
  let p = 0;
  const take = n => {
    if (p + n > d.length) throw new Error('short');
    p += n;
    return d.subarray(p - n, p);
  };
  return { u8: () => take(1)[0], u16: () => readBe16(take(2), 0), u32: () => readBe32(take(4), 0), take, get left() { return d.length - p; } };
}

/** The name field (0x8140, length nibble masked) of an application image's header, or null. */
function appHeaderName(d) {
  for (let p = 6; p + 2 <= d.length;) {
    const id = readBe16(d, p);
    p += 2;
    let len = id & 0x0F;
    if (len === 0x0D) { len = d[p]; p += 1; } else if (len === 0x0E) { len = readBe16(d, p); p += 2; } else if (len === 0x0F) { len = readBe32(d, p); p += 4; }
    if (p + len > d.length) return null;
    if ((id & 0xFFF0) === 0x8140) return d.subarray(p, p + len);
    p += len;
  }
  return null;
}

function parseAttrs(r) {
  const m = new Map();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u16();
    m.set(id, r.take(r.u16()).slice());
  }
  return m;
}

export class SimulatedCalculator {
  constructor({
    allocation = 1023,          // the buffer size this calculator allocates, raw header included
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
    delays = {},                // { replyType: delay }: Delay Acknowledgements before that reply; a delay
                                // is microseconds or raw payload bytes, and an array sends several in a row
    renegotiate = null,         // { afterPackets, size }: ask for a new buffer size mid-stream
    lowBattery = false,         // refuse an application send with 0x002B
    refuse = null,              // { step, code, times }: answer that step with an error (steps in STEPS)
    running = false,            // a program running on the calculator; settable at any time
    leftovers = [],             // raw packets { type, data } sent before the answer to the next Buffer Size
                                // Request, as an earlier exchange might leave; never observed on hardware
  } = {}) {
    // The USBDevice surface, as observed on a CE.
    this.vendorId = 0x0451;
    this.productId = productId;
    this.productName = productName;
    this.manufacturerName = 'Texas Instruments Inc.';
    this.serialNumber = undefined;
    this.deviceVersionMajor = 2; this.deviceVersionMinor = 2; this.deviceVersionSubminor = 0;
    this.opened = false;
    this.configuration = null;
    this.configurations = [1, 2, 3].map(configurationValue => {
      const alternate = {
        alternateSetting: 0, interfaceClass: 0xFF, interfaceSubclass: 1, interfaceProtocol: 0,
        endpoints: [
          { endpointNumber: endpointIn, direction: 'in', type: 'bulk', packetSize },
          { endpointNumber: endpointOut, direction: 'out', type: 'bulk', packetSize },
        ],
      };
      return { configurationValue, configurationName: null, interfaces: [{ interfaceNumber: 0, claimed: false, alternate, alternates: [alternate] }] };
    });

    this.allocation = allocation;
    this.packetSize = packetSize;
    this.os = os;
    this.boot = boot;
    this.ramFree = ramFree;
    this.archiveFree = archiveFree;
    this.invalidParams = new Set(invalidParams);
    this.delays = new Map(Object.entries(delays).map(([k, v]) => [+k, [].concat(v)]));
    this.renegotiate = renegotiate;
    this.lowBattery = lowBattery;
    this.refuse = refuse && { times: Infinity, ...refuse };
    this.running = running;
    this.leftovers = [...leftovers];
    this.vars = new Map();
    for (const v of vars) this._store(v.name, v.type, v.data, !!v.archived, v.version ?? 0);

    this.violations = [];       // strictness failures, as sentences
    this.clearedHalts = [];     // clearHalt() calls: [direction, endpointNumber]
    this.log = [];              // every raw packet: { dir: 'out' (host to calculator) | 'in', bytes }
    this.commands = [];         // virtual packets received: { type, data }
    this.wedged = false;        // after an oversize packet; only replug() clears it
    this.freeze = false;        // stops answering, as a hung calculator
    this.disconnected = false;  // reads and writes reject, as a calculator gone from the bus
    this.padContents = 0;       // extra bytes after a variable's contents on receive
    this.overstateSize = 0;     // bytes a Variable Header's size claims beyond the contents
    this.ackBytes = [0xE0, 0x00]; // the calculator's raw acknowledgement
    // (type, data) => true to take a command over; it may queue its own reply
    // with queueRaw or queueVirtual.
    this.intercept = null;
    this._hostDataCount = 0;
    this._rejectThisWrite = false;
    this._reboot = null;
    this._waiters = [];
    this._resetLink();
  }

  /**
   * Restart as the named variable lands. `mode` 'silent' goes quiet (the host
   * times out); 'disconnect' leaves the bus (transfers reject); 'reject-write'
   * rejects the OUT transfer that carried the final packet although every USB
   * packet was taken, then leaves the bus. With `early` the restart comes one
   * contents packet before the last.
   */
  rebootWhenLands(name, type, { early = false, mode = 'silent' } = {}) {
    this._reboot = { key: `${type}:${name}`, early, mode };
  }

  /** Unplug and plug back in: the only thing that clears a wedge. */
  replug() {
    Object.assign(this, { wedged: false, freeze: false, disconnected: false, _rejectThisWrite: false, _reboot: null });
    this._resetLink();
  }

  get(name, type) { return this.vars.get(`${type}:${name}`); }


  async open() { this.opened = true; }

  async close() {
    this.opened = false;
    if (this._heldFinal) {
      this.wedged = true;
      this._violation('The host closed the device while the calculator waited for the zero-length end of a transfer; the calculator stops answering.');
    }
    for (const c of this.configurations) for (const i of c.interfaces) i.claimed = false;
    for (const w of this._waiters.splice(0)) w.reject(domError('AbortError', 'The transfer was cancelled because the device was closed.'));
    this._resetLink();
  }

  async selectConfiguration(value) {
    this._needOpen();
    const c = this.configurations.find(x => x.configurationValue === value);
    if (!c) throw domError('NotFoundError', `No configuration ${value}.`);
    this.configuration = c;
  }

  async claimInterface(n) { this._interface(n).claimed = true; }
  async clearHalt(direction, endpointNumber) { this._needOpen(); this.clearedHalts.push([direction, endpointNumber]); }
  async releaseInterface(n) { this._interface(n).claimed = false; }

  get claimed() { return !!this.configuration?.interfaces.some(i => i.claimed); }

  transferOut(ep, data) {
    try { this._needEndpoint(ep, 'out'); } catch (e) { return Promise.reject(e); }
    const b = data.slice();
    this.log.push({ dir: 'out', bytes: b });
    if (this.disconnected) return Promise.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    if (this.freeze || this.wedged) return Promise.resolve({ status: 'ok', bytesWritten: b.length });
    let ok;
    if (b.length === 0) {
      ok = this._zeroLength();
    } else if (this._heldFinal) {
      // The CE is still inside the previous bulk transfer: these bytes run on
      // into it, the framing is lost, and the link is dead until replugged.
      this.wedged = true;
      this._heldFinal = null;
      this._violation('A new transfer followed a final raw packet that filled whole 64-byte USB packets, without the zero-length write that ends it; the calculator stops answering.');
      ok = true;
    } else {
      ok = this._hostRaw(b);
    }
    if (this._rejectThisWrite) {
      this._rejectThisWrite = false;
      return Promise.reject(domError('NotFoundError', 'The transfer did not complete: the calculator restarted.'));
    }
    return Promise.resolve(ok ? { status: 'ok', bytesWritten: b.length } : { status: 'stall', bytesWritten: 0 });
  }

  transferIn(ep, length) {
    try { this._needEndpoint(ep, 'in'); } catch (e) { return Promise.reject(e); }
    if (this.disconnected) return Promise.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    if (length % this.packetSize !== 0) this._violation(`transferIn(${length}) asks for part of a ${this.packetSize}-byte USB packet; reads must be whole packets.`);
    if (this._delayUntil != null) {
      // 2 ms of slack for timer granularity.
      const early = this._delayUntil - performance.now();
      this._delayUntil = null;
      if (early > 2) this._violation(`The host read again ${Math.round(early)} ms before the delay the calculator asked for was over.`);
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ length, resolve, reject, parts: [], got: 0 });
      this._serve();
    });
  }


  _needOpen() { if (!this.opened) throw domError('InvalidStateError', 'The device is not open.'); }

  _interface(n) {
    this._needOpen();
    const i = this.configuration?.interfaces.find(x => x.interfaceNumber === n);
    if (!i) throw domError('NotFoundError', `No interface ${n} in the current configuration.`);
    return i;
  }

  _needEndpoint(ep, dir) {
    this._needOpen();
    const i = this.configuration?.interfaces.find(x => x.alternate.endpoints.some(e => e.endpointNumber === ep && e.direction === dir));
    if (!i) throw domError('NotFoundError', `No ${dir} endpoint ${ep} in the current configuration.`);
    if (!i.claimed) throw domError('InvalidStateError', 'The interface is not claimed.');
  }

  _violation(message) {
    this.violations.push(message);
    return false;
  }

  // The allocation and the mode last until the device is closed or replugged.
  _resetLink() {
    this._heldFinal = null;     // a final raw packet waiting for its zero-length write
    this._delayUntil = null;    // when the host may read again after a Delay Acknowledgement
    this._sentAt = null;        // when the last variable's End of Transmission arrived
    this._awaitingAlloc = null; // our own Buffer Size Request, waiting for the host's answer
    this.negotiated = null;     // the allocation agreed
    this.maxData = null;        // data bytes per raw packet under it
    this.mode = null;           // the mode set by the ping, as hex
    this.phase = 'idle';        // idle | wait-contents | wait-eot
    this._pending = null;       // the variable being received from the host
    this._rxChunks = [];        // host raw data for the virtual packet being assembled
    this._queue = [];           // our raw packets not yet read by the host
    this._current = null;       // the raw packet being read: { bytes, off, needsAck, delayMs }
    this._awaitingAck = null;   // the raw packet the host has read and must acknowledge
  }

  _refusal(step) {
    const r = this.refuse;
    if (!r || r.step !== step) return null;
    if (--r.times <= 0) this.refuse = null;
    return r.code;
  }

  // A program running on the calculator (observed on hardware, a TI-Basic
  // program at Input and a shell alike): the Request to Send and the delete
  // are refused with 0x0036, whether or not the variable exists, while the
  // mode, the parameters and the listing still answer. A variable request was
  // answered 0x0006, but only for a name that was not there, so the
  // simulator refuses every read with it.
  _runningRefusal(step) {
    if (!this.running) return null;
    if (step === 'rts' || step === 'delete') return SIM_ERR.PROGRAM_RUNNING;
    if (step === 'request') return SIM_ERR.READ_REFUSED;
    return null;
  }

  _hostRaw(b) {
    if (b.length < 5) return this._violation('A transfer shorter than a raw packet header was sent.');
    const len = readBe32(b, 0);
    if (len !== b.length - 5) return this._violation(`One USB transfer must carry exactly one raw packet (header says ${len} data bytes, transfer has ${b.length - 5}).`);
    const type = b[4];
    const data = b.subarray(5);
    if (type !== 5) {
      if (this._current?.needsAck) return this._violation('A new packet was sent while the calculator was still sending one.');
      if (this._awaitingAck) return this._violation(`Raw packet type ${type} was sent before acknowledging the calculator's last packet.`);
      if (this._ackUnread()) return this._violation(`Raw packet type ${type} was sent before reading the calculator's acknowledgement.`);
      if (this._sentAt != null) {
        const since = performance.now() - this._sentAt;
        this._sentAt = null;
        // 2 ms of slack for timer granularity.
        if (since < SETTLE_MS - 2) this._violation(`The next command started ${Math.round(since)} ms after a variable's End of Transmission; libticalcs waits ${SETTLE_MS} ms, "needed".`);
      }
    }
    if (type !== 2 && this._awaitingAlloc) return this._violation(`Raw packet type ${type} was sent before answering the calculator's Buffer Size Request.`);

    switch (type) {
      case 1: {
        if (len !== 4) return this._violation('A Buffer Size Request must hold 4 bytes.');
        this.phase = 'idle';
        this._pending = null;
        this._allocate(Math.min(readBe32(data, 0), this.allocation));
        for (const p of this.leftovers.splice(0)) this.queueRaw(p.type, p.data);
        this.queueRaw(2, be32(this.negotiated));
        return true;
      }
      case 2: {
        const asked = this._awaitingAlloc;
        if (!asked) return this._violation('A host may send raw packet type 2 only to answer the calculator\'s Buffer Size Request.');
        if (len !== 4 || readBe32(data, 0) !== asked.size) return this._violation(`The host answered the calculator's Buffer Size Request for ${asked.size} with ${len === 4 ? readBe32(data, 0) : 'a malformed allocation'}.`);
        this._awaitingAlloc = null;
        this._allocate(asked.size);
        asked.then();
        return true;
      }
      case 3: case 4: {
        if (this.negotiated == null) return this._violation('Data was sent before the buffer size was negotiated.');
        if (len > this.maxData) {
          // Observed on hardware past 1018 at an allocation of 1023: no
          // acknowledgement, and no answer to anything until replugged.
          this.wedged = true;
          this._violation(`A raw packet of ${len} data bytes (${len + 5} in all) exceeds the allocation of ${this.negotiated}, header included; the calculator stops answering.`);
          return true;
        }
        if (len === 0) return this._emptyData(type);
        if (type === 4 && (len + 5) % this.packetSize === 0) {
          // It fills whole USB packets, so the calculator's side of the bulk
          // transfer is not over until a zero-length write arrives.
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
        this._release();
        return true;
      }
      default:
        return this._violation(`Raw packet type ${type} is not one a host may send.`);
    }
  }

  // At 1023 the header counts (observed on hardware). That it counts at
  // smaller allocations too is inferred; no CE has been seen allocating one.
  _allocate(size) {
    this.negotiated = size;
    this.maxData = Math.min(size - 5, MAX_DATA);
  }

  _emptyData(type) {
    const have = this._rxChunks.reduce((n, c) => n + c.length, 0);
    const complete = have >= 6 && readBe32(concat(...this._rxChunks), 0) + 6 === have;
    if (type === 3 || !complete) return this._violation('An empty data raw packet was sent that does not end a complete virtual packet.');
    if (this._rxChunks.length === 1) {
      // Observed on hardware: a full type 3 then an empty type 4 hangs the CE until replugged.
      this.wedged = true;
      this._violation('An empty type 4 followed a single full data packet; the calculator stops answering.');
      return true;
    }
    this._violation('An empty type 4 ended a multi-packet virtual packet: libticalcs\' framing for an exact fill, never tried on a CE.');
    return this._acceptData(4, new Uint8Array(0));
  }

  /** A host data packet complete on the USB side: acknowledge it, and act on a finished virtual packet. */
  _acceptData(type, data) {
    this._rxChunks.push(data.slice());
    this._hostDataCount++;
    if (this._reboot && this.phase === 'wait-contents' && `${this._pending.type}:${this._pending.name}` === this._reboot.key) {
      this._contentsSeen++;
      if (this._contentsSeen >= this._contentsTotal - (this._reboot.early ? 1 : 0)) {
        this._dropLink(this._reboot.mode);
        return true;
      }
    }
    const finish = () => {
      this.queueRaw(5, this.ackBytes);
      if (type !== 4) return;
      const all = concat(...this._rxChunks);
      this._rxChunks = [];
      if (all.length < 6 || readBe32(all, 0) !== all.length - 6) {
        this._violation('A virtual packet\'s length field does not match the data sent.');
        return this._queueError(SIM_ERR.BAD_PACKET);
      }
      this._virtual(readBe16(all, 4), all.subarray(6));
    };
    const r = this.renegotiate;
    if (r && this._hostDataCount === r.afterPackets) {
      // Reopen the negotiation instead of acknowledging; the acknowledgement
      // follows once the host has answered.
      this._awaitingAlloc = { size: r.size, then: finish };
      this.queueRaw(1, be32(r.size));
      return true;
    }
    finish();
    return true;
  }

  _dropLink(mode) {
    if (mode === 'reject-write') {
      this.disconnected = true;
      this._rejectThisWrite = true;
    } else if (mode === 'disconnect') {
      this.disconnected = true;
      for (const w of this._waiters.splice(0)) w.reject(domError('NotFoundError', 'The calculator was reset or unplugged.'));
    } else {
      this.freeze = true;
    }
  }

  _zeroLength() {
    if (!this._heldFinal) return this._violation('A zero-length write arrived when no transfer needed ending.');
    const data = this._heldFinal;
    this._heldFinal = null;
    return this._acceptData(4, data);
  }

  _ackUnread() {
    return (this._current && !this._current.needsAck) || this._queue.some(p => !p.needsAck);
  }

  /** Queue a raw packet for the host to read. */
  queueRaw(type, data, delayMs = null) {
    this._queue.push({ bytes: concat(be32(data.length), type, data), off: 0, needsAck: type === 3 || type === 4, delayMs });
    this._release();
  }

  /** Queue a virtual packet for the host, after any delays set for its type. */
  queueVirtual(vtype, data) {
    if (this.freeze) return;
    for (const d of this.delays.get(vtype) ?? []) this._queueDelay(d);
    this._queueFramed(vtype, data);
  }

  /** A Delay Acknowledgement: `d` is microseconds, or the raw payload. */
  _queueDelay(d) {
    const payload = typeof d === 'number' ? be32(d) : d;
    this._queueFramed(0xBB00, payload, payload.length >= 4 ? Math.min(readBe32(payload, 0), 400000) / 1000 : null);
  }

  _queueFramed(vtype, data, delayMs = null) {
    const v = concat(be32(data.length), be16(vtype), data);
    const size = this.maxData ?? 250;
    for (let off = 0; off < v.length; off += size) {
      const last = v.length - off <= size;
      this.queueRaw(last ? 4 : 3, v.subarray(off, last ? v.length : off + size), last ? delayMs : null);
    }
  }

  _queueError(code) {
    this.phase = 'idle';
    this._pending = null;
    this._queueFramed(0xEE00, be16(code));
  }

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

  // Deliver bytes to waiting transferIn calls one USB packet at a time. A
  // transfer ends on a short packet or when its length is reached; no
  // zero-length packet follows a raw packet that ends on a packet boundary.
  _serve() {
    while (this._waiters.length && this._current) {
      const w = this._waiters[0];
      const c = this._current;
      const chunk = Math.min(this.packetSize, c.bytes.length - c.off);
      if (chunk > w.length - w.got) {
        this._waiters.shift();
        this._violation(`transferIn(${w.length}) had room for ${w.length - w.got} more bytes but the next USB packet is ${chunk}: babble.`);
        w.resolve({ status: 'babble', data: new DataView(new ArrayBuffer(0)) });
        continue;
      }
      w.parts.push(c.bytes.subarray(c.off, c.off + chunk));
      c.off += chunk;
      w.got += chunk;
      if (c.off === c.bytes.length) {
        this._current = null;
        if (c.needsAck) this._awaitingAck = c;
      }
      if (chunk < this.packetSize || w.got === w.length) {
        this._waiters.shift();
        const data = concat(...w.parts);
        w.resolve({ status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) });
      }
      this._promote();
    }
  }


  _virtual(type, d) {
    this.commands.push({ type, data: d.slice() });
    if (this.freeze || this.intercept?.(type, d)) return;
    try {
      const refused = STEPS[type] !== 'contents' && (this._refusal(STEPS[type]) || this._runningRefusal(STEPS[type]));
      if (refused) return this._queueError(refused);
      if (type === 0x0001) return this._ping(d);
      if (this.mode == null) {
        this._violation(`Command 0x${type.toString(16)} was sent before the mode ping.`);
        return this._queueError(SIM_ERR.NO_MODE);
      }
      if (this.phase === 'wait-contents') return type === 0x000D ? this._contents(d) : this._outOfOrder(type);
      if (this.phase === 'wait-eot') return type === 0xDD00 ? this._eot() : this._outOfOrder(type);
      if (!MODES[this.mode].includes(type)) {
        this._violation(`Command 0x${type.toString(16)} is not accepted in mode ${this.mode}.`);
        return this._queueError(SIM_ERR.WRONG_MODE);
      }
      switch (type) {
        case 0x0007: return this._paramRequest(d);
        case 0x0009: return this._dirList(d);
        case 0x000B: return this._rts(d);
        case 0x000C: return this._varRequest(d);
        case 0x0010: return this._delete(d);
        default: return this._queueError(SIM_ERR.UNSUPPORTED);
      }
    } catch (e) {
      if (e.message !== 'short') throw e;
      this._violation(`Command 0x${type.toString(16)} was cut short.`);
      this._queueError(SIM_ERR.BAD_PACKET);
    }
  }

  _bad(message) {
    this._violation(message);
    this._queueError(SIM_ERR.BAD_PACKET);
  }

  _outOfOrder(type) {
    this._violation(`Command 0x${type.toString(16)} arrived while a send was in progress (${this.phase}).`);
    this._queueError(SIM_ERR.OUT_OF_ORDER);
  }

  /** An empty folder, then a NUL-terminated name, as libticalcs writes them. */
  _name(r, what) {
    const folder = r.u8();
    if (folder !== 0) this._violation(`${what} names folder "${decoder.decode(r.take(folder))}"; the CE has none.`);
    const name = decoder.decode(r.take(r.u8()));
    if (r.u8() !== 0x00) this._violation(`${what}: the name is not NUL-terminated.`);
    return name;
  }

  _ping(d) {
    if (d.length !== 10) return this._bad('A ping must hold 10 bytes.');
    const mode = hex(d.subarray(0, 6));
    const value = readBe32(d, 6);
    if (value < 2000) return this._queueError(SIM_ERR.PING_TOO_SMALL);
    if (value > 131071) return this._queueError(SIM_ERR.PING_TOO_BIG);
    if (!MODES[mode]) return this._queueError(SIM_ERR.BAD_MODE);
    this.mode = mode;
    this.queueVirtual(0x0012, be32(value));
  }

  _paramRequest(d) {
    const r = reader(d);
    const ids = Array.from({ length: r.u16() }, () => r.u16());
    if (r.left !== 0) return this._bad('Parameter Request has trailing bytes.');
    const values = this.params();
    const out = [be16(ids.length)];
    for (const id of ids) {
      const v = this.invalidParams.has(id) ? undefined : values[id];
      out.push(v === undefined ? [...be16(id), 1] : [...be16(id), 0, ...be16(v.length), ...v]);
    }
    this.queueVirtual(0x0008, concat(...out));
  }

  /** Parameter values, in the layout observed on a CE. */
  params() {
    const ver = v => [...be16(v.major), v.minor, v.micro];
    return {
      0x0001: be32(0x13), 0x0002: [...encoder.encode(this.productName)], 0x0004: be16(7),
      0x0006: [9], 0x0007: [1], 0x0008: be16(0x0073), 0x0009: ver(this.boot), 0x000A: [1],
      0x000B: ver(this.os), 0x0048: be16(this.os.build), 0x0049: be16(this.boot.build),
      0x000C: be64(0x40000), 0x000D: be64(0x27000), 0x000E: be64(this.ramFree),
      0x000F: be64(0x400000), 0x0010: be64(0x360000), 0x0011: be64(this.archiveFree),
      0x001B: [1], 0x001D: [0x10], 0x001E: be16(320), 0x001F: be16(240),
      0x002D: [this.lowBattery ? 0 : 1], 0x0037: [1], 0x004B: [0],
    };
  }

  _typeFrom(attrs, id) {
    const t = attrs.get(id);
    if (t?.length !== 4) return null;
    const word = readBe32(t, 0);
    return TYPE_PREFIXES.includes((word & 0xFFFFFF00) >>> 0) ? word & 0xFF : null;
  }

  _dirList(d) {
    const r = reader(d);
    const ids = Array.from({ length: r.u32() }, () => r.u16());
    const tail = hex(r.take(r.left));
    if (tail !== '00010001000101') return this._bad(`Directory request tail is ${tail}, expected 00010001000101.`);
    for (const v of this.vars.values()) this.queueVirtual(0x000A, this._header(v, ids));
    this.queueVirtual(0xDD00, []);
  }

  _header(v, ids) {
    const name = encoder.encode(v.name);
    const parts = [0x00, name.length, name, 0x00, be16(ids.length)];
    for (const id of ids) {
      const val = { 0x0001: be32(v.data.length + this.overstateSize), 0x0002: be32((0xF0070000 | v.type) >>> 0), 0x0003: [v.archived ? 1 : 0], 0x0008: be32(v.version) }[id];
      parts.push(val ? [...be16(id), 0, ...be16(val.length), ...val] : [...be16(id), 1]);
    }
    return concat(...parts);
  }

  _rts(d) {
    const r = reader(d);
    const name = this._name(r, 'Request to Send');
    const size = r.u32();
    const flag = r.u8();
    const attrs = parseAttrs(r);
    if (r.left !== 0) return this._bad('Request to Send has trailing bytes.');
    const type = this._typeFrom(attrs, 0x0002);
    if (type == null) return this._bad('Request to Send is missing a valid type (0x0002) attribute.');
    if (flag !== 0x01 && flag !== 0x02) return this._bad(`Request to Send has mode flag ${flag}.`);
    if (type === FLASH_APP) return this._rtsApp(name, size, flag, attrs);
    const sizeAttr = attrs.get(0x0001);
    if (sizeAttr && (sizeAttr.length !== 4 || readBe32(sizeAttr, 0) !== size)) return this._bad('Request to Send carries a size attribute (0x0001) that disagrees with its size field.');
    // libticalcs never sends flag 02 to a CE (its backup send is a no-op there); treated as unsupported.
    if (flag === 0x02) return this._queueError(SIM_ERR.UNSUPPORTED);
    const version = attrs.get(0x0008);
    if (version && version.length !== 4) return this._bad('Request to Send has a version attribute (0x0008) that is not 4 bytes.');
    const archived = attrs.get(0x0003)?.[0] === 1;
    if (!this._wireNameOk(name, type) || !this._validName(name, type)) return this._queueError(SIM_ERR.BAD_NAME);
    const old = this.get(name, type);
    const freeRam = this.ramFree + (old && !old.archived ? old.data.length + 9 : 0);
    const freeArchive = this.archiveFree + (old?.archived ? old.data.length + 17 : 0);
    if (archived ? size + 17 > freeArchive : size + 9 > freeRam) return this._queueError(SIM_ERR.NO_MEMORY);
    this._expectContents({ name, type, size, archived, version: version ? version[3] : 0 });
    this.queueVirtual(0xAA00, [0x01]);
  }

  /**
   * An application: exactly two attributes, type F0 0F 00 24 then archived 01,
   * and the silent flag. The calculator erases, then acknowledges.
   */
  _rtsApp(name, size, flag, attrs) {
    const got = [...attrs].map(([id, v]) => `${id.toString(16).padStart(4, '0')}=${hex(v)}`).join(' ');
    if (got !== '0002=f00f0024 0003=01') return this._bad(`An application's Request to Send must carry exactly 0002=f00f0024 then 0003=01; it carried ${got}.`);
    if (flag !== 0x01) return this._bad('An application must be sent silently (flag 01).');
    if (this.lowBattery) return this._queueError(SIM_ERR.BATTERY_LOW);
    if (!this._validName(name, FLASH_APP)) return this._queueError(SIM_ERR.BAD_NAME);
    const old = this.get(name, FLASH_APP);
    if (size + 17 > this.archiveFree + (old ? old.data.length + 17 : 0)) return this._queueError(SIM_ERR.NO_MEMORY);
    this._expectContents({ name, type: FLASH_APP, size, archived: true, version: 0 });
    this.queueVirtual(0xAA00, [0x01]);
  }

  _expectContents(pending) {
    this._pending = pending;
    this.phase = 'wait-contents';
    this._contentsTotal = Math.max(1, Math.ceil((6 + pending.size) / this.maxData));
    this._contentsSeen = 0;
  }

  _contents(d) {
    const p = this._pending;
    const refused = this._refusal('contents');
    if (refused) return this._queueError(refused);
    if (d.length !== p.size) return this._bad(`Variable Contents is ${d.length} bytes; the Request to Send said ${p.size}.`);
    if (p.type === FLASH_APP) {
      // What a signature check would catch first: not an application image, or no name in its header.
      if (d[0] !== 0x81 || d[1] !== 0x0F || !appHeaderName(d)) return this._queueError(SIM_ERR.BAD_SIGNATURE);
    }
    this._store(p.name, p.type, d.slice(), p.archived, p.version);
    this.phase = 'wait-eot';
    this.queueVirtual(0xAA00, [0x01]);
  }

  _eot() {
    // No reply to the host's End of Transmission.
    if (this._pending.type !== FLASH_APP) this._sentAt = performance.now();
    this.phase = 'idle';
    this._pending = null;
  }

  _varRequest(d) {
    const r = reader(d);
    const name = this._name(r, 'Request Variable');
    const mid = hex(r.take(5));
    if (mid !== '01ffffffff') return this._bad(`Request Variable bytes after the name are ${mid}, expected 01ffffffff.`);
    const ids = Array.from({ length: r.u16() }, () => r.u16());
    const attrs = parseAttrs(r);
    const tail = hex(r.take(r.left));
    if (tail !== '0000') return this._bad(`Request Variable tail is ${tail}, expected 0000.`);
    const type = this._typeFrom(attrs, 0x0011);
    if (type == null) return this._bad('Request Variable has no valid type attribute 0x0011.');
    if (type === FLASH_APP && hex(attrs.get(0x0011)) !== 'f00f0024') {
      this._violation(`Requesting an application takes type F0 0F 00 24; this asked with ${hex(attrs.get(0x0011))}.`);
      return this._queueError(SIM_ERR.NOT_FOUND);
    }
    if (!this._wireNameOk(name, type)) return this._queueError(SIM_ERR.NOT_FOUND);
    const v = this.get(name, type);
    if (!v) return this._queueError(SIM_ERR.NOT_FOUND);
    this.queueVirtual(0x000A, this._header(v, ids));
    const refused = this._refusal('contents');
    if (refused) return this._queueError(refused);
    this.queueVirtual(0x000D, concat(v.data, new Uint8Array(this.padContents)));
  }

  _delete(d) {
    const r = reader(d);
    const name = this._name(r, 'Modify Variable');
    const attrs = parseAttrs(r);
    const tail = hex(r.take(r.left));
    if (tail !== '0100000000') return this._bad(`Modify Variable tail is ${tail}, expected 0100000000 (ignore protection, no destination).`);
    const type = this._typeFrom(attrs, 0x0011);
    if (type == null) return this._bad('Modify Variable has no valid type attribute 0x0011.');
    if (!this._wireNameOk(name, type)) return this._queueError(SIM_ERR.NOT_FOUND);
    const v = this.get(name, type);
    if (!v) return this._queueError(SIM_ERR.NOT_FOUND);
    this._free(v);
    this.vars.delete(`${type}:${name}`);
    this.queueVirtual(0xAA00, [0x01]);
  }


  /**
   * Built-in lists and equations are named with subscript digits on the wire
   * (L₁, Y₁, r₁, X₁⊺), and a named list has no ⌊ in front. A host that sends
   * "L1" in ASCII addresses a variable that cannot exist.
   */
  _wireNameOk(name, type) {
    if (LIST_TYPES.includes(type)) {
      if (/^L[0-9]$/.test(name)) return this._violation(`List name "${name}" uses an ASCII digit; the built-in lists are L and a subscript digit.`);
      if (name.startsWith('⌊')) return this._violation(`List name "${name}" starts with ⌊, which is not part of a named list's name.`);
    }
    if (EQUATION_TYPES.includes(type) && /^([Yr][0-9]|[XY][1-6]T)$/.test(name)) {
      return this._violation(`Equation name "${name}" uses an ASCII digit; built-in equations use subscript digits.`);
    }
    return true;
  }

  _validName(name, type) {
    const chars = [...name];
    if (chars.length < 1 || chars.length > 8) return false;
    return !PROGRAM_TYPES.includes(type) || /^[A-Zθ][A-Z0-9θ]*$/u.test(name);
  }

  _store(name, type, data, archived, version = 0) {
    const old = this.get(name, type);
    if (old) this._free(old); // a silent send replaces without asking
    if (archived) this.archiveFree -= data.length + 17;
    else this.ramFree -= data.length + 9;
    this.vars.set(`${type}:${name}`, { name, type, data, archived, version });
  }

  _free(v) {
    if (v.archived) this.archiveFree += v.data.length + 17;
    else this.ramFree += v.data.length + 9;
  }
}
