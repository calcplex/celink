// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// What the tests share: a link open on a simulated calculator, a host that
// drives the simulator packet by packet, file builders and byte helpers.
import assert from 'node:assert/strict';
import { CELink, encodeRaw, encodeVirtual } from '../celink.mjs';
import { checksum } from '../tifiles.mjs';
import { SimulatedCalculator } from '../sim/calculator.mjs';

/** OS versions for the simulator, one for each install route and past them. */
export const OS = {
  early: { major: 5, minor: 0, micro: 0, build: 89 },
  native: { major: 5, minor: 3, micro: 0, build: 37 },
  v21: { major: 5, minor: 8, micro: 4, build: 58 },
  v3: { major: 5, minor: 8, micro: 5, build: 74 },
  unsupported: { major: 5, minor: 8, micro: 6, build: 10 },
};

export async function connect(simOptions = {}, linkOptions = {}) {
  const sim = new SimulatedCalculator(simOptions);
  const link = CELink.fromDevice(sim, { timeout: 500, streamTimeout: 1000, ...linkOptions });
  await link.open();
  await link.ready();
  return { sim, link };
}

export function noViolations(sim) {
  assert.deepEqual(sim.violations, [], 'the simulator saw no protocol violations');
}

/** Deterministic bytes that are not all alike. */
export function patterned(n, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

export const hex = b => Array.from(b, x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
export const fromHex = s => Uint8Array.from(s.trim().split(/\s+/).map(x => parseInt(x, 16)));
export const be16 = n => [(n >>> 8) & 0xFF, n & 0xFF];
export const be32 = n => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
export const utf8 = s => new TextEncoder().encode(s);

/** Raw packets the host wrote, zero-length writes included. */
export const written = sim => sim.log.filter(p => p.dir === 'out').map(p => p.bytes);
/** The data raw packets (types 3 and 4) in one direction. */
export const dataPackets = (sim, dir) => sim.log.filter(p => p.dir === dir && (p.bytes[4] === 3 || p.bytes[4] === 4)).map(p => p.bytes);
/** The body of the last virtual packet of `type` the calculator received. */
export const lastCommand = (sim, type) => sim.commands.filter(c => c.type === type).at(-1).data;
/** How many virtual packets of `type` the calculator received. */
export const received = (sim, type) => sim.commands.filter(c => c.type === type).length;

/** A copy of a variable file with `patch` applied and its checksum made right again. */
export function patched(bytes, patch) {
  const b = bytes.slice();
  patch(b);
  new DataView(b.buffer).setUint16(b.length - 2, checksum(b.subarray(55, b.length - 2)), true);
  return b;
}

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'number' ? [p] : [...p])));

/** An application header field: a 2-byte id whose low nibble gives the length form, the length bytes, the contents. */
export function appField(id, contents) {
  const form = id & 0x0F;
  const length = form === 0x0D ? [contents.length] : form === 0x0E ? be16(contents.length) : form === 0x0F ? be32(contents.length) : [];
  if (form < 0x0D) assert.equal(form, contents.length, 'a nibble-length field must match its contents');
  return bytesOf(be16(id), length, contents);
}

/** An application image of exactly `size` bytes: 81 0F, its length, a few fields, the name, filler. */
export function appImage(name, size, { first = 0x81, withName = true } = {}) {
  const fields = bytesOf(appField(0x8012, [0x13, 0x0F]), appField(0x802D, utf8('5.0.0.0089')), withName ? appField(0x8140 | name.length, utf8(name)) : []);
  const head = bytesOf(first, 0x0F, be32(size - 6), fields);
  const out = new Uint8Array(size);
  out.set(head);
  out.set(patterned(size - head.length, size).map(x => x & 0x7F), head.length);
  return out;
}

/** One .8ek section: a **TIFL** header and `data`. */
export function appSection({ dataType = 0x24, data, name = 'APP', hardwareId = 0x13, deviceType = 0x73 }) {
  const h = new Uint8Array(78);
  h.set(utf8('**TIFL**'));
  h.set([1, 2, 0, 0, 0x22, 0x09, 0x20, 0x26, name.length], 8);
  h.set(utf8(name), 17);
  h[48] = deviceType;
  h[49] = dataType;
  h[73] = hardwareId;
  new DataView(h.buffer).setUint32(74, data.length, true);
  return bytesOf(h, data);
}

/** A .8ek holding one application of `size` bytes. */
export const appFile = (name, size) => appSection({ data: appImage(name, size), name });

/** A host that drives a simulated calculator one raw packet at a time. */
export async function rawHost(options) {
  const sim = new SimulatedCalculator(options);
  await sim.open();
  await sim.selectConfiguration(1);
  await sim.claimInterface(0);
  const host = {
    sim,
    write: (type, data = []) => sim.transferOut(2, encodeRaw(type, data)),
    async read() {
      const r = await sim.transferIn(1, 2048);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    },
    /** One virtual packet in one raw packet, then the calculator's raw acknowledgement. */
    async post(type, data) {
      await host.write(4, encodeVirtual(type, data));
      return host.read();
    },
    /** post(), then read and acknowledge the reply. */
    async command(type, data) {
      await host.post(type, data);
      const reply = await host.read();
      await host.write(5, [0xE0, 0x00]);
      return reply;
    },
    /** A 1024-byte buffer request and the normal-mode ping, as ready() does. */
    async ready() {
      await host.write(1, [0x00, 0x00, 0x04, 0x00]);
      await host.read();
      return host.command(0x0001, fromHex('00 03 00 01 00 00 00 00 07 D0'));
    },
  };
  return host;
}
