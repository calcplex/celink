// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
//
// Tests for the changes made from the libticalcs comparison (see LIBTICALCS.md).
// Each block names its item number in LIBTICALCS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELink, encodeRaw, encodeVirtual, splitVirtual, hex, infoFromParams, parseParamData } from '../celink.mjs';
import { makeEntry, buildFile, parseFile, checksum, TYPE } from '../tifiles.mjs';
import { SimulatedCalculator } from '../sim/calculator.mjs';

async function connect(simOpts = {}) {
  const sim = new SimulatedCalculator(simOpts);
  const link = CELink.fromDevice(sim);
  link.capture = true;
  link.timeout = 500;
  link.streamTimeout = 1000;
  await link.open();
  return { sim, link };
}

function noViolations(sim) { assert.deepEqual(sim.violations, [], 'simulator saw no protocol violations'); }

function patterned(n, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}

async function freshSim(opts = {}) {
  const s = new SimulatedCalculator(opts);
  await s.open(); await s.selectConfiguration(1); await s.claimInterface(0);
  return s;
}
const rawOut = (s, type, data) => s.transferOut(2, encodeRaw(type, data));
async function rawIn(s) { const r = await s.transferIn(1, 64); return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength); }

const outs = sim => sim.log.filter(p => p.dir === 'out');
const zeroWrites = sim => outs(sim).filter(p => p.bytes.length === 0).length;

// ------------------------------------------------------------------ LIBTICALCS.md 1

test('LIBTICALCS.md 1: a zero-length write ends a final raw packet that fills whole 64-byte USB packets', async () => {
  // [variable size, zero-length writes expected]. 53 is one packet of 6 + 53 + 5 = 64
  // bytes; 1071 is two packets, the last 6 + 1071 - 1018 + 5 = 64 bytes.
  for (const [n, want] of [[52, 0], [53, 1], [54, 0], [117, 1], [1070, 0], [1071, 1], [1072, 0], [2089, 1]]) {
    const { sim, link } = await connect();
    const e = makeEntry({ name: 'EDGE', type: TYPE.APPVAR, data: patterned(n, n) });
    await link.send(e);
    assert.deepEqual(sim.get('EDGE', TYPE.APPVAR).data, e.data, `${n} bytes arrived`);
    assert.equal(zeroWrites(sim), want, `${n} bytes: zero-length writes`);
    const log = outs(sim);
    log.forEach((p, i) => {
      if (p.bytes.length === 0) {
        const prev = log[i - 1].bytes;
        assert.equal(prev[4], 4, 'only after a final (type 4) raw packet');
        assert.equal(prev.length % 64, 0, 'only after one that fills whole USB packets');
      } else if (p.bytes[4] === 4 && p.bytes.length % 64 === 0) {
        assert.equal(log[i + 1]?.bytes.length, 0, 'every such packet gets one');
      }
    });
    noViolations(sim);
  }
  // A multi-packet program whose last packet lands on the boundary, sent as a file.
  const { sim, link } = await connect();
  const prog = makeEntry({ name: 'EDGEPRG', type: TYPE.PROGRAM, body: patterned(1069, 3) });
  assert.equal(prog.data.length, 1071);
  await link.sendFile(buildFile([prog]));
  assert.deepEqual(sim.get('EDGEPRG', TYPE.PROGRAM).data, prog.data);
  assert.equal(zeroWrites(sim), 1);
  noViolations(sim);
});

test('LIBTICALCS.md 1: without the zero-length write the simulator wedges, as the CE does', async () => {
  for (const n of [53, 1071]) {
    const { sim, link } = await connect();
    link.quirks.zeroLengthAfterFinal = false;
    link.streamTimeout = 80;
    await assert.rejects(link.send(makeEntry({ name: 'EDGE', type: TYPE.APPVAR, data: patterned(n) })), { code: 'TIMEOUT' });
    assert.equal(sim.wedged, true, `${n} bytes: wedged`);
    assert.match(sim.violations.join('\n'), /zero-length/);
    assert.equal(link.opened, false);
    await link.open();
    link.timeout = 60;
    await assert.rejects(link.info(), { code: 'TIMEOUT' }, 'still dead after reopening');
    sim.replug();
    await link.open();
    link.timeout = 500;
    assert.equal((await link.info()).productName, 'TI-84 Plus CE', 'a replug brings it back');
  }
});

// ------------------------------------------------------------------ LIBTICALCS.md 5

test('LIBTICALCS.md 5: a virtual packet that exactly fills its last raw packet makes that packet the type 4', async () => {
  // Hardware, OS 5.3.0.0037: the full packet as the type 4 round-trips
  // 1012 and 2030 bytes; a full type 3 then an empty type 4 hangs the link every time.
  const v = encodeVirtual(0x000D, patterned(1012));
  assert.deepEqual(splitVirtual(v, 1018).map(r => [r.type, r.data.length]), [[4, 1018]]);
  assert.deepEqual(splitVirtual(v, 1018, { emptyFinal: true }).map(r => [r.type, r.data.length]), [[3, 1018], [4, 0]]);
  for (const n of [1012, 2030]) {
    const { sim, link } = await connect();
    // `n` includes the appvar's own size word, so 6 + n fills 1018-byte packets exactly.
    const e = makeEntry({ name: 'FULL', type: TYPE.APPVAR, body: patterned(n - 2, 5) });
    assert.equal(e.data.length, n);
    await link.send(e);
    assert.deepEqual(sim.get('FULL', TYPE.APPVAR).data, e.data);
    // The contents' raw packets are the ones before the End of Transmission.
    const data = outs(sim).filter(p => p.bytes[4] === 3 || p.bytes[4] === 4).slice(0, -1);
    assert.equal(data.at(-1).bytes[4], 4, `${n}: the last raw packet is the type 4`);
    assert.equal(data.at(-1).bytes.length, 1023, 'and it is full');
    assert.ok(!data.some(p => p.bytes.length === 5), 'no empty packet');
    noViolations(sim);
  }
  // The other framing, one quirk away, is what hung the real CE; the simulator wedges on it.
  const { sim, link } = await connect();
  link.quirks.emptyFinalOnBoundary = true;
  link.timeout = 300;
  await assert.rejects(link.send(makeEntry({ name: 'FULL2', type: TYPE.APPVAR, body: patterned(1010, 6) })));
  assert.ok(sim.wedged, 'the empty type 4 wedged the link');
  assert.match(sim.violations.join('\n'), /empty type 4 ended a virtual packet/);
  // The calculator may end its own packets either way; the reader takes both.
  const r = await connect({ emptyFinalOnBoundary: true, vars: [{ name: 'BACK', type: 0x15, data: patterned(1012, 8) }] });
  const got = await r.link.receive('BACK', TYPE.APPVAR);
  assert.deepEqual(got.data, patterned(1012, 8));
  assert.ok(r.sim.log.some(p => p.dir === 'in' && hex(p.bytes) === '00 00 00 00 04'), 'an empty type 4 came in');
  noViolations(r.sim);
});

test('simulator: empty data packets and stray zero-length writes are violations', async () => {
  let s = await freshSim();
  await rawOut(s, 1, [0, 0, 4, 0]); await rawIn(s);
  assert.equal((await rawOut(s, 3, [])).status, 'stall');
  assert.match(s.violations[0], /empty data raw packet/);
  s = await freshSim();
  await rawOut(s, 1, [0, 0, 4, 0]); await rawIn(s);
  assert.equal((await rawOut(s, 4, [])).status, 'stall', 'an empty type 4 with nothing before it');
  s = await freshSim();
  await s.transferOut(2, new Uint8Array(0));
  assert.match(s.violations[0], /zero-length write arrived when no transfer needed ending/);
});

// ------------------------------------------------------------------ LIBTICALCS.md 2

test('LIBTICALCS.md 2: a Delay Acknowledgement is waited out before the next read', async () => {
  // Delays before the mode acknowledgement, the parameter data and both data
  // acknowledgements of a send, as the calculator would before slow work.
  const { sim, link } = await connect({ delays: { 0x0012: 30000, 0x0008: 40000, 0xAA00: 25000 } });
  let t0 = performance.now();
  const info = await link.info();
  assert.equal(info.productName, 'TI-84 Plus CE');
  assert.ok(performance.now() - t0 >= 68, 'waited 30 + 40 ms');
  assert.equal(link.lastDelayMs, 40);
  t0 = performance.now();
  await link.send(makeEntry({ name: 'SLOW', type: TYPE.APPVAR, body: patterned(3000) }), { archive: true });
  assert.ok(performance.now() - t0 >= 78, 'waited 30 + 25 + 25 ms');
  const delays = sim.log.filter(p => p.dir === 'in' && p.bytes[4] === 4 && p.bytes[9] === 0xBB && p.bytes[10] === 0x00);
  assert.equal(delays.length, 5);
  noViolations(sim);
});

test('LIBTICALCS.md 2: the delay is capped at 400 ms, and a short payload means 100 ms', async () => {
  const { sim, link } = await connect({ delays: { 0x0008: 0x7FFFFFFF } });
  let t0 = performance.now();
  await link.info();
  const long = performance.now() - t0;
  assert.ok(long >= 398 && long < 900, `capped wait took ${long} ms`);
  noViolations(sim);
  const { sim: s2, link: l2 } = await connect({ delays: { 0x0008: Uint8Array.of(1) } });
  t0 = performance.now();
  await l2.info();
  assert.ok(performance.now() - t0 >= 98);
  assert.equal(l2.lastDelayMs, 100);
  noViolations(s2);
});

test('LIBTICALCS.md 2: the simulator flags a host that reads straight after a delay', async () => {
  const { sim, link } = await connect({ delays: { 0x0008: 60000 } });
  link.quirks.delayCapMicros = 0; // a host that ignores the delay
  await link.info();
  assert.match(sim.violations.join('\n'), /before the delay the calculator asked for was over/);
});

// ------------------------------------------------------------------ LIBTICALCS.md 3

test('LIBTICALCS.md 3: a Buffer Size Request in place of an acknowledgement is answered and used', async () => {
  // The host's data packets in this session: 1 the ping, 2 the Request to Send,
  // 3 the first contents packet. After that one the calculator asks for 250.
  const { sim, link } = await connect({ renegotiate: { afterPackets: 3, size: 250 } });
  const e = makeEntry({ name: 'RENEG', type: TYPE.APPVAR, body: patterned(4000, 4) });
  await link.send(e);
  assert.deepEqual(sim.get('RENEG', TYPE.APPVAR).data, e.data);
  assert.equal(link.allocation, 250);
  assert.equal(link.bufferSize, 245);
  const log = outs(sim);
  const alloc = log.findIndex(p => p.bytes[4] === 2);
  assert.equal(hex(log[alloc].bytes), '00 00 00 04 02 00 00 00 FA', 'the host echoed 250');
  assert.equal(log[alloc - 1].bytes.length, 1023, 'the packet before it was full size');
  assert.ok(log.slice(alloc + 1).filter(p => p.bytes[4] === 3 || p.bytes[4] === 4).every(p => p.bytes.length <= 250));
  noViolations(sim);
});

test('LIBTICALCS.md 3: acknowledgements with a 4-byte data field are accepted', async () => {
  const { sim, link } = await connect();
  const orig = sim._queueRaw.bind(sim);
  sim._queueRaw = (type, data, ...rest) => orig(type, type === 5 ? [0xE0, 0x00, 0x00, 0x00] : data, ...rest);
  await link.send(makeEntry({ name: 'ACK4', type: TYPE.APPVAR, body: patterned(10) }));
  assert.equal(sim.get('ACK4', TYPE.APPVAR).data.length, 12);
});

// ------------------------------------------------------------------ LIBTICALCS.md 4

test('LIBTICALCS.md 4: whatever the CE allocates, no raw packet carries more than 1018 data bytes', async () => {
  const { sim, link } = await connect({ bufferSize: 2048 });
  link.quirks.requestBufferSize = 2048;
  const e = makeEntry({ name: 'CAP', type: TYPE.APPVAR, body: patterned(5000, 2) });
  await link.send(e);
  assert.equal(link.allocation, 2048);
  assert.equal(link.bufferSize, 1018);
  assert.deepEqual(sim.get('CAP', TYPE.APPVAR).data, e.data);
  noViolations(sim);
  // The data-bytes rule (allocIncludesHeader false) is now safe on the default offer.
  const { sim: s2, link: l2 } = await connect();
  l2.quirks.allocIncludesHeader = false;
  await l2.send(e);
  assert.equal(l2.allocation, 1023);
  assert.equal(l2.bufferSize, 1018);
  noViolations(s2);
});

// ------------------------------------------------------------------ LIBTICALCS.md 7, 13: version

const cmd = (sim, t) => sim.commands.filter(c => c.type === t).at(-1).data;

test('LIBTICALCS.md 7: Request to Send carries type, archived and version, and no size attribute', async () => {
  const { sim, link } = await connect();
  const pic = makeEntry({ name: 'Pic1', type: TYPE.PICTURE, data: patterned(40), version: 10 });
  await link.send(pic);
  const rts = cmd(sim, 0x000B);
  // name "Pic1" (4), NUL, size 40, silent, 3 attributes
  assert.equal(hex(rts.subarray(0, 15)), '00 04 50 69 63 31 00 00 00 00 28 01 00 03 00');
  const ids = [];
  for (let p = 14; p < rts.length;) { const id = (rts[p] << 8) | rts[p + 1]; const len = (rts[p + 2] << 8) | rts[p + 3]; ids.push([id, hex(rts.subarray(p + 4, p + 4 + len))]); p += 4 + len; }
  assert.deepEqual(ids, [[2, 'F0 0F 00 07'], [3, '00'], [8, '00 00 00 0A']]);
  assert.equal(sim.get('Pic1', TYPE.PICTURE).version, 10, 'the calculator stored version 10');
  noViolations(sim);
});

test('LIBTICALCS.md 13: receive asks for the version and returns it, and the file keeps it', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'Pic2', type: TYPE.PICTURE, data: patterned(30), version: 12 }] });
  const got = await link.receive('Pic2', TYPE.PICTURE);
  assert.equal(got.version, 12);
  const file = buildFile([got]);
  assert.equal(file[55 + 13], 12, 'version byte in the file entry');
  const req = cmd(sim, 0x000C);
  assert.equal(hex(req.subarray(12, 20)), '00 03 00 03 00 08 00 01', 'asks for archived, version, size');
  noViolations(sim);
});

// ------------------------------------------------------------------ LIBTICALCS.md 8

test('LIBTICALCS.md 8: the type owner byte is 0x0F to send, 0x07 to receive, 0x0B to delete', async () => {
  const { sim, link } = await connect();
  await link.send(makeEntry({ name: 'OWNER', type: TYPE.APPVAR, body: patterned(4) }));
  await link.receive('OWNER', TYPE.APPVAR);
  await link.delete('OWNER', TYPE.APPVAR);
  assert.match(hex(cmd(sim, 0x000B)), /00 02 00 04 F0 0F 00 15/);
  assert.match(hex(cmd(sim, 0x000C)), /00 11 00 04 F0 07 00 15/);
  assert.match(hex(cmd(sim, 0x0010)), /00 11 00 04 F0 0B 00 15/);
  noViolations(sim);
  // One quirk puts back the first hardware pass's rule: the listing's prefix everywhere.
  link.quirks.learnTypePrefix = true;
  await link.send(makeEntry({ name: 'OWNER2', type: TYPE.APPVAR, body: patterned(4) }));
  await link.list();
  await link.delete('OWNER2', TYPE.APPVAR);
  assert.match(hex(cmd(sim, 0x0010)), /00 11 00 04 F0 07 00 15/);
  noViolations(sim);
});

// ------------------------------------------------------------------ LIBTICALCS.md 14

test('LIBTICALCS.md 14: receive trims contents longer than the declared size, refuses shorter ones', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'PAD', type: 0x15, data: patterned(100) }] });
  sim.padContents = 7;
  const got = await link.receive('PAD', TYPE.APPVAR);
  assert.deepEqual(got.data, patterned(100));
  assert.equal(got.size, 100);
  noViolations(sim);
  sim.padContents = 0;
  const orig = sim._header.bind(sim);
  sim._header = (v, ids) => orig({ ...v, data: new Uint8Array(v.data.length + 5) }, ids);
  await assert.rejects(link.receive('PAD', TYPE.APPVAR), { code: 'PROTOCOL', message: /105 bytes but sent only 100/ });
});

// ------------------------------------------------------------------ LIBTICALCS.md 23

test('LIBTICALCS.md 23: a silent send overwrites a variable of the same name', async () => {
  const { sim, link } = await connect();
  await link.send(makeEntry({ name: 'OVER', type: TYPE.PROGRAM, body: patterned(50, 1) }));
  const second = makeEntry({ name: 'OVER', type: TYPE.PROGRAM, body: patterned(80, 2) });
  await link.send(second);
  assert.deepEqual(sim.get('OVER', TYPE.PROGRAM).data, second.data);
  assert.equal(cmd(sim, 0x000B)[11], 0x01, 'mode flag 01, silent');
  assert.equal(sim.ramFree, 154000 - second.data.length - 9, 'the old copy was freed');
  await link.delete('OVER', TYPE.PROGRAM);
  await link.send(second);
  assert.deepEqual(sim.get('OVER', TYPE.PROGRAM).data, second.data, 'delete, then send again');
  noViolations(sim);
});

// ------------------------------------------------------------------ LIBTICALCS.md 10, 11, 12: names and types

test('LIBTICALCS.md 10: L1 goes on the wire as L and a subscript one, from a typed name or a file', async () => {
  const list = Uint8Array.of(1, 0, 0, 0x80, 0x10, 0, 0, 0, 0, 0, 0);
  const { sim, link } = await connect({ vars: [{ name: 'L₁', type: TYPE.LIST, data: list }] });
  const got = await link.receive('L1', TYPE.LIST);
  assert.deepEqual(got.data, list);
  assert.equal(got.name, 'L₁');
  assert.deepEqual([...got.nameBytes.subarray(0, 2)], [0x5D, 0x00]);
  const req = cmd(sim, 0x000C);
  assert.equal(hex(req.subarray(0, 6)), '00 04 4C E2 82 81', 'name length 4, then L and U+2081 in UTF-8');
  // An .8xl file's entry carries the token 5D 01; it is sent as L₂.
  const file = buildFile([makeEntry({ name: 'L2', type: TYPE.LIST, data: list })]);
  await link.sendFile(file);
  assert.equal(hex(cmd(sim, 0x000B).subarray(0, 6)), '00 04 4C E2 82 82');
  assert.deepEqual(sim.get('L₂', TYPE.LIST).data, list);
  await link.delete('L₂', TYPE.LIST);
  assert.equal(sim.get('L₂', TYPE.LIST), undefined);
  noViolations(sim);
});

test('LIBTICALCS.md 10: the simulator refuses built-in names spelled with ASCII digits', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'L₁', type: TYPE.LIST, data: Uint8Array.of(0, 0) }] });
  await assert.rejects(link.receive(new TextEncoder().encode('L1'), TYPE.LIST), { code: 'CALC_ERROR' });
  assert.match(sim.violations[0], /ASCII digit/);
});

test('LIBTICALCS.md 10: the built-in name table', async () => {
  const { nameToBytes, nameToString } = await import('../tifiles.mjs');
  const rows = [
    // [type, token bytes, calculator spelling, other accepted spellings]
    [TYPE.LIST, [0x5D, 0x00], 'L₁', ['L1']], [TYPE.LIST, [0x5D, 0x08], 'L₉', ['L9']],
    [TYPE.LIST, [0x5D, 0x09], 'L₀', ['L0']], [TYPE.LIST, [0x5D, 0x40], 'IDList', []],
    [TYPE.LIST, [0x5D, 0x41, 0x42, 0x43], 'ABC', ['⌊ABC']],
    [TYPE.LIST, [0x5D, 0x5B, 0x41], 'θA', ['⌊θA']],
    [TYPE.LIST_0D, [0x5D, 0x02], 'L₃', ['L3']],
    [TYPE.EQUATION, [0x5E, 0x10], 'Y₁', ['Y1']], [TYPE.EQUATION, [0x5E, 0x18], 'Y₉', ['Y9']],
    [TYPE.EQUATION, [0x5E, 0x19], 'Y₀', ['Y0']],
    [TYPE.EQUATION, [0x5E, 0x20], 'X₁⊺', ['X1T']], [TYPE.EQUATION, [0x5E, 0x21], 'Y₁⊺', ['Y1T']],
    [TYPE.EQUATION, [0x5E, 0x2A], 'X₆⊺', ['X6T']], [TYPE.EQUATION, [0x5E, 0x2B], 'Y₆⊺', ['Y6T']],
    [TYPE.EQUATION, [0x5E, 0x40], 'r₁', ['r1']], [TYPE.EQUATION, [0x5E, 0x45], 'r₆', ['r6']],
    [TYPE.EQUATION, [0x5E, 0x80], 'u', []], [TYPE.EQUATION, [0x5E, 0x81], 'v', []], [TYPE.EQUATION, [0x5E, 0x82], 'w', []],
    [TYPE.MATRIX, [0x5C, 0x09], '[J]', []],
    [TYPE.STRING, [0xAA, 0x00], 'Str1', []], [TYPE.STRING, [0xAA, 0x09], 'Str0', []],
    [TYPE.PICTURE, [0x60, 0x00], 'Pic1', []], [TYPE.GDB, [0x61, 0x09], 'GDB0', []],
  ];
  for (const [type, bytes, spelled, others] of rows) {
    for (const typed of [spelled, ...others]) {
      const b = nameToBytes(typed, type);
      assert.deepEqual([...b.subarray(0, bytes.length)], bytes, `${typed} -> bytes`);
      assert.ok(b.subarray(bytes.length).every(x => x === 0), `${typed}: NUL padded`);
    }
    const padded = new Uint8Array(8); padded.set(bytes);
    assert.equal(nameToString(padded, type), spelled, `bytes -> ${spelled}`);
  }
  assert.equal(nameToString(new Uint8Array(8), TYPE.WINDOW), 'Window');
  assert.equal(nameToString(new Uint8Array(8), TYPE.RCL_WINDOW), 'RclWindw');
  assert.equal(nameToString(new Uint8Array(8), TYPE.TABLE_SETUP), 'TblSet');
  assert.throws(() => nameToBytes('ABCDEFGH', TYPE.LIST), { code: 'BAD_NAME' }, 'a named list holds 7 characters');
});

test('LIBTICALCS.md 11: a named list goes on the wire without the ⌊ the calculator displays', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'SCORE', type: TYPE.LIST, data: Uint8Array.of(0, 0) }] });
  await link.receive('⌊SCORE', TYPE.LIST);
  assert.equal(hex(cmd(sim, 0x000C).subarray(0, 7)), '00 05 53 43 4F 52 45');
  await link.delete('SCORE', TYPE.LIST);
  assert.equal(sim.get('SCORE', TYPE.LIST), undefined);
  noViolations(sim);
  // What the old spelling did, straight to the simulator: refused.
  await assert.rejects(link.receive(new TextEncoder().encode('⌊SCORE'), TYPE.LIST), { code: 'CALC_ERROR' });
  assert.match(sim.violations[0], /starts with ⌊/);
});

test('LIBTICALCS.md 12: the type table covers what a CE lists; 0x0D is a list', async () => {
  const { typeName, fileExtension } = await import('../tifiles.mjs');
  assert.equal(typeName(0x0D), 'list');
  assert.equal(typeName(0x1A), 'image');
  assert.equal(typeName(0x0F), 'window settings');
  assert.equal(typeName(0x26), 'ID list');
  assert.equal(typeName(0x3E), 'license');
  assert.equal(fileExtension(TYPE.IMAGE), '8ca');
  assert.equal(fileExtension(TYPE.PICTURE), '8ci');
  assert.equal(fileExtension(TYPE.LIST), '8xl');
  assert.equal(fileExtension(0x42), undefined);
});

// ------------------------------------------------------------------ LIBTICALCS.md 9

test('LIBTICALCS.md 9: 50 ms between the entries of a group, and after any send', async () => {
  const { sim, link } = await connect();
  const file = buildFile([1, 2, 3].map(n => makeEntry({ name: 'G' + n, type: TYPE.APPVAR, body: patterned(200 * n, n) })));
  const t0 = performance.now();
  await link.sendFile(file);
  assert.ok(performance.now() - t0 >= 98, 'two pauses between three entries');
  await link.receive('G3', TYPE.APPVAR);
  noViolations(sim);
  // Without the pause the simulator objects.
  const { sim: s2, link: l2 } = await connect();
  l2.quirks.settleMs = 0;
  await l2.sendFile(file);
  assert.match(s2.violations.join('\n'), /needs 50 ms to commit a variable/);
});

// ------------------------------------------------------------------ LIBTICALCS.md 16

test('LIBTICALCS.md 16: negotiation and the ping can run once per connection instead of per operation', async () => {
  const { sim, link } = await connect();
  link.quirks.negotiateEachOperation = false;
  await link.info(); await link.list();
  await link.send(makeEntry({ name: 'ONCE', type: TYPE.APPVAR, body: patterned(3000) }));
  await link.receive('ONCE', TYPE.APPVAR); await link.delete('ONCE', TYPE.APPVAR);
  assert.equal(outs(sim).filter(p => p.bytes[4] === 1).length, 1, 'one Buffer Size Request');
  assert.equal(sim.commands.filter(c => c.type === 0x0001).length, 1, 'one ping');
  noViolations(sim);
  // A new connection negotiates again.
  await link.close(); await link.open();
  await link.info();
  assert.equal(outs(sim).filter(p => p.bytes[4] === 1).length, 2);
  noViolations(sim);
});

// ------------------------------------------------------------------ LIBTICALCS.md 17

test('LIBTICALCS.md 17: every USB read asks for whole 64-byte packets', async () => {
  for (const one of [false, true]) {
    const { sim, link } = await connect({ vars: [{ name: 'BIG', type: 0x15, data: patterned(5000, 3) }] });
    link.quirks.readOnePacket = one;
    const sizes = [];
    const orig = sim.transferIn.bind(sim);
    sim.transferIn = (ep, n) => { sizes.push(n); return orig(ep, n); };
    const got = await link.receive('BIG', TYPE.APPVAR);
    assert.deepEqual(got.data, patterned(5000, 3));
    assert.ok(sizes.every(n => n % 64 === 0), `whole packets (${[...new Set(sizes)].join(', ')})`);
    if (one) assert.ok(sizes.every(n => n === 64));
    else assert.ok(sizes.includes(960), 'the rest of a 1023-byte packet is asked for as 15 packets');
    noViolations(sim);
  }
});

// ------------------------------------------------------------------ LIBTICALCS.md 19

test('LIBTICALCS.md 19: calculator error codes have sentences, unknown ones say so', async () => {
  const { sim, link } = await connect();
  const e = makeEntry({ name: 'ERR', type: TYPE.PROGRAM, body: patterned(4) });
  for (const [code, text] of [[0x000C, /out of memory/], [0x0012, /locked/], [0x001B, /too large/], [0x0034, /home screen/], [0x002E, /signature does not match/], [0x002B, /battery is low/]]) {
    sim.errorOn.set(0x000B, code);
    await assert.rejects(link.send(e), err => err.code === 'CALC_ERROR' && err.calcError === code && text.test(err.message));
  }
  sim.errorOn.set(0x000B, 0x0001);
  await assert.rejects(link.send(e), { message: /0x0001: an error code this library does not know/ });
  assert.equal(link.opened, true, 'refusals leave the link usable');
});

// ------------------------------------------------------------------ LIBTICALCS.md 20

test('LIBTICALCS.md 20: a stuck transfer clears the halt on both endpoints before closing', async () => {
  const { sim, link } = await connect();
  link.timeout = 60;
  sim.freeze = true;
  await assert.rejects(link.info(), { code: 'TIMEOUT' });
  assert.deepEqual(sim.clearedHalts, [['out', 2], ['in', 1]]);
  assert.equal(link.opened, false);
  // A refusal is not a stuck transfer: no halt clearing.
  sim.freeze = false;
  await link.open();
  link.timeout = 500;
  sim.errorOn.set(0x0007, 0x0011);
  await assert.rejects(link.info(), { code: 'CALC_ERROR' });
  assert.equal(sim.clearedHalts.length, 2);
});

// ------------------------------------------------------------------ LIBTICALCS.md 21

test('LIBTICALCS.md 21: the product number is the last byte of parameter 0x0001', () => {
  const data = Uint8Array.of(0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x13);
  assert.equal(infoFromParams(parseParamData(data)).productNumber, 0x13);
});

// ------------------------------------------------------------------ LIBTICALCS.md 15 and LIBTICALCS.md B: files

/** A variable file from raw entry bytes, with the declared length and checksum given or computed. */
function fileOf(section, { declared = section.length, sum, tail = [] } = {}) {
  const f = new Uint8Array(55 + section.length + 2 + tail.length);
  f.set(new TextEncoder().encode('**TI83F*')); f[8] = 0x1A; f[9] = 0x0A;
  f.set(new TextEncoder().encode('fixture'), 11);
  f[53] = declared & 0xFF; f[54] = declared >> 8;
  f.set(section, 55);
  const s = sum ?? checksum(Uint8Array.from(section));
  f[55 + section.length] = s & 0xFF; f[56 + section.length] = s >> 8;
  f.set(tail, 57 + section.length);
  return f;
}
/** One 13-byte-header entry. */
function entryBytes({ type = 5, name = 'A', data = [1, 0, 0x41], ver = 0, flag = 0, hlen = 13 }) {
  const n = new Uint8Array(8); n.set(new TextEncoder().encode(name));
  const extra = hlen === 13 ? [ver, flag] : [];
  return [hlen, 0, data.length & 0xFF, data.length >> 8, type, ...n, ...extra, data.length & 0xFF, data.length >> 8, ...data];
}
const codes = r => r.warnings.map(w => w.code);

test('LIBTICALCS.md 15: a wrong checksum is a warning, and the variables still come out', () => {
  const sec = [...entryBytes({ name: 'ONE' }), ...entryBytes({ name: 'TWO', data: [2, 0, 0x42, 0x43] })];
  const r = parseFile(fileOf(sec, { sum: 0x1234 }));
  assert.deepEqual(codes(r), ['BAD_CHECKSUM']);
  assert.match(r.warnings[0].message, /read anyway/);
  assert.deepEqual(r.entries.map(e => e.name), ['ONE', 'TWO']);
  assert.deepEqual([...r.entries[1].data], [2, 0, 0x42, 0x43]);
});

test('LIBTICALCS.md 15: a declared length that disagrees with the entries is a warning', () => {
  const sec = entryBytes({ name: 'SHORT', data: [3, 0, 1, 2, 3] });
  // Declared 4 bytes short: the entry is still read whole, bounded by the file.
  const small = parseFile(fileOf(sec, { declared: sec.length - 4 }));
  assert.deepEqual(codes(small), ['DECLARED_LENGTH']);
  assert.deepEqual([...small.entries[0].data], [3, 0, 1, 2, 3]);
  // Bytes after the checksum are ignored.
  const trailing = parseFile(fileOf(sec, { tail: [0xAA, 0xBB, 0xCC] }));
  assert.deepEqual(codes(trailing), ['TRAILING_BYTES']);
  assert.equal(trailing.entries.length, 1);
});

test('LIBTICALCS.md 15: genuinely malformed files are still refused', () => {
  const sec = entryBytes({ name: 'X', data: [1, 0, 0x41] });
  assert.throws(() => parseFile(fileOf(sec, { declared: sec.length + 10 })), { code: 'BAD_FILE', message: /only/ }, 'declared section past the end');
  const cut = fileOf(sec).subarray(0, 55 + sec.length - 1);
  assert.throws(() => parseFile(cut), { code: 'BAD_FILE' }, 'data past the end');
  const disagree = [...sec]; disagree[15] = 9;
  assert.throws(() => parseFile(fileOf(disagree)), { code: 'BAD_FILE', message: /two copies/ });
  assert.throws(() => parseFile(fileOf([], { declared: 0 })), { code: 'BAD_FILE', message: /no variables/ });
  const huge = new Uint8Array(8 * 1024 * 1024); huge.set(fileOf(sec));
  assert.throws(() => parseFile(huge), { code: 'BAD_FILE', message: /8 MB/ });
});

test('LIBTICALCS.md 15: an unknown header length is read as the 11-byte form, with a warning', () => {
  const eleven = entryBytes({ name: 'OLD', hlen: 11, data: [2, 0, 0xAB, 0xCD] });
  eleven[0] = 12;
  const r = parseFile(fileOf(eleven));
  assert.deepEqual(codes(r), ['HEADER_LENGTH']);
  assert.equal(r.entries[0].name, 'OLD');
  assert.deepEqual([...r.entries[0].data], [2, 0, 0xAB, 0xCD]);
});

test('LIBTICALCS.md 24: the legacy 0x0080 archived word, and version 10 for 0x55BB-byte pictures', () => {
  const legacy = parseFile(fileOf(entryBytes({ name: 'ARC', ver: 0x80, flag: 0x00 }))).entries[0];
  assert.equal(legacy.archived, true);
  assert.equal(legacy.version, 0);
  const normal = parseFile(fileOf(entryBytes({ name: 'ARC', ver: 0x05, flag: 0x80 }))).entries[0];
  assert.equal(normal.archived, true);
  assert.equal(normal.version, 5);
  const picData = new Array(0x55BB).fill(0);
  const pic = parseFile(fileOf(entryBytes({ type: 0x07, name: '\x60\x00', data: picData }))).entries[0];
  assert.equal(pic.version, 10);
  assert.equal(pic.name, 'Pic1');
  const other = parseFile(fileOf(entryBytes({ type: 0x07, name: '\x60\x00', data: picData.slice(1) }))).entries[0];
  assert.equal(other.version, 0, 'only that exact size');
});

test('LIBTICALCS.md 15: a file with a wrong checksum sends normally', async () => {
  const { sim, link } = await connect();
  const f = buildFile([makeEntry({ name: 'SUMBAD', type: TYPE.PROGRAM, body: patterned(300) })]);
  f[f.length - 1] ^= 0xFF;
  const parsed = parseFile(f);
  assert.deepEqual(codes(parsed), ['BAD_CHECKSUM']);
  await link.sendFile(f);
  assert.deepEqual(sim.get('SUMBAD', TYPE.PROGRAM).data, parsed.entries[0].data);
  noViolations(sim);
});
