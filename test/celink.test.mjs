// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELink, CELinkError, encodeRaw, decodeRaw, encodeVirtual, splitVirtual, joinVirtual,
  parseParamData, infoFromParams, formatVersion, findBulkInterface, hex, VPKT, DEFAULT_QUIRKS, CONFIRMED_ON_5_3,
} from '../celink.mjs';
import { makeEntry, buildFile, parseFile, TYPE } from '../tifiles.mjs';
import { SimulatedCalculator, SIM_ERR } from '../sim/calculator.mjs';

const enc = s => new TextEncoder().encode(s);
const fromHex = s => Uint8Array.from(s.trim().split(/\s+/).map(x => parseInt(x, 16)));

async function connect(simOpts = {}, { capture = true } = {}) {
  const sim = new SimulatedCalculator(simOpts);
  const link = CELink.fromDevice(sim);
  link.capture = capture;
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

// ------------------------------------------------------------------ framing

test('framing: the document\'s example raw packets encode byte for byte', () => {
  assert.equal(hex(encodeRaw(1, [0, 0, 4, 0])), '00 00 00 04 01 00 00 04 00');
  assert.equal(hex(encodeRaw(5, [0xE0, 0x00])), '00 00 00 02 05 E0 00');
  const ping = encodeVirtual(0x0001, fromHex('00 03 00 01 00 00 00 00 07 D0'));
  const raws = splitVirtual(ping, 1024);
  assert.equal(raws.length, 1);
  assert.equal(hex(encodeRaw(raws[0].type, raws[0].data)),
    '00 00 00 10 04 00 00 00 0A 00 01 00 03 00 01 00 00 00 00 07 D0');
  // The same ping split as the document shows: a type 3 then a type 4.
  const two = splitVirtual(ping, 8);
  assert.deepEqual(two.map(r => hex(encodeRaw(r.type, r.data))), [
    '00 00 00 08 03 00 00 00 0A 00 01 00 03',
    '00 00 00 08 04 00 01 00 00 00 00 07 D0',
  ]);
  assert.deepEqual(joinVirtual(two.map(r => r.data)), { type: 1, data: fromHex('00 03 00 01 00 00 00 00 07 D0') });
});

test('framing: 1-byte and 4000-byte payloads round-trip, split and unsplit', () => {
  for (const [n, buf, count] of [[1, 1018, 1], [1, 4, 2], [4000, 1018, 4], [4000, 250, 17], [4000, 5000, 1]]) {
    const data = patterned(n, n + buf);
    const v = encodeVirtual(0x000D, data);
    const raws = splitVirtual(v, buf);
    assert.equal(raws.length, count, `${n} bytes in ${buf}-byte raw packets`);
    raws.forEach((r, i) => {
      assert.equal(r.type, i === raws.length - 1 ? 4 : 3);
      assert.ok(r.data.length <= buf);
      const wire = encodeRaw(r.type, r.data);
      const back = decodeRaw(wire);
      assert.equal(back.length, wire.length);
      assert.deepEqual(back.data, r.data);
    });
    const j = joinVirtual(raws.map(r => r.data));
    assert.equal(j.type, 0x000D);
    assert.deepEqual(j.data, data);
  }
  assert.equal(decodeRaw(fromHex('00 00 00 04 01 00')), null, 'incomplete packet is not decoded');
  assert.throws(() => joinVirtual([fromHex('00 00 00 09 00 0D 01')]), { code: 'PROTOCOL' });
});

test('parameter data: the layout observed on a real CE parses to the right values', () => {
  // Parameter Data as a TI-84 Plus CE (OS 5.3.0.0037) sent it, with the 5-byte
  // calculator id (parameter 0x0003) replaced by zeros.
  const observed = fromHex(`
    00 1A 00 0A 00 00 01 01 00 08 00 00 02 00 73 00 01 00 00 04 00 00 00 13
    00 02 00 00 0D 54 49 2D 38 34 20 50 6C 75 73 20 43 45
    00 03 00 00 05 00 00 00 00 00 00 04 00 00 02 00 07 00 06 00 00 01 09
    00 07 00 00 01 01 00 49 00 00 02 00 59 00 09 00 00 04 00 05 00 00
    00 48 00 00 02 00 25 00 0B 00 00 04 00 05 03 00
    00 0C 00 00 08 00 00 00 00 00 04 00 00 00 0D 00 00 08 00 00 00 00 00 02 70 00
    00 0E 00 00 08 00 00 00 00 00 00 00 00 00 0F 00 00 08 00 00 00 00 00 40 00 00
    00 10 00 00 08 00 00 00 00 00 36 00 00 00 11 00 00 08 00 00 00 00 00 24 33 7B
    00 1E 00 00 02 01 40 00 1F 00 00 02 00 F0 00 1D 00 00 01 10 00 1B 00 00 01 01
    00 2D 00 00 01 01 00 4B 00 00 01 00 00 5D 01 00 23 01`);
  const raw = parseParamData(observed);
  assert.equal(raw.size, 24, '26 requested, 2 invalid');
  assert.ok(!raw.has(0x005D) && !raw.has(0x0023));
  const info = infoFromParams(raw);
  assert.equal(info.productName, 'TI-84 Plus CE');
  assert.equal(info.productNumber, 0x13);
  assert.equal(info.osVersion, '5.3.0.0037');
  assert.equal(info.bootVersion, '5.0.0.0089');
  assert.equal(info.hardwareVersion, 7);
  assert.equal(info.ramFree, 0);
  assert.equal(info.archiveFree, 2372475);
  assert.equal(info.lcdWidth, 320);
  assert.equal(info.lcdHeight, 240);
  assert.equal(info.batteryOk, true);
  assert.equal(info.language, 9);
  assert.equal('atHomescreen' in info, false, 'parameter 0x0037 was not in that request');
});

test('formatVersion: bytes 1-3 of the 4-byte form, build from its own 2-byte parameter', () => {
  assert.equal(formatVersion(fromHex('00 05 08 05')), '5.8.5');
  assert.equal(formatVersion(fromHex('00 05 08 05'), fromHex('00 4A')), '5.8.5.0074');
  // Byte 0 is not part of the major version (LIBTICALCS.md 21).
  assert.equal(formatVersion(fromHex('01 05 08 05'), fromHex('00 4A')), '5.8.5.0074');
  assert.equal(formatVersion(fromHex('00 05 08 05'), fromHex('4A')), '5.8.5', 'a build that is not 2 bytes is left out');
  assert.equal(formatVersion(fromHex('00 05 08 05 00 4A')), undefined);
  assert.equal(formatVersion(fromHex('00 05')), undefined);
});

// ------------------------------------------------------------------ connect

test('request(): filters on TI\'s vendor id only; cancel and missing WebUSB have codes', async () => {
  const sim = new SimulatedCalculator();
  let seen;
  const usb = { requestDevice: async opts => { seen = opts; return sim; }, getDevices: async () => [sim, { vendorId: 0x1234 }] };
  const link = await CELink.request({ usb });
  assert.deepEqual(seen, { filters: [{ vendorId: 0x0451 }] });
  assert.equal(link.productId, 0xE008);
  assert.deepEqual(await CELink.granted({ usb }), [sim]);
  const cancel = { requestDevice: async () => { const e = new Error('none'); e.name = 'NotFoundError'; throw e; } };
  await assert.rejects(CELink.request({ usb: cancel }), { code: 'NO_DEVICE_SELECTED' });
  await assert.rejects(CELink.request({ usb: null }), { code: 'NO_WEBUSB' });
});

test('open(): selects configuration 1, claims the bulk interface, finds endpoints from descriptors', async () => {
  const { sim, link } = await connect({ endpointIn: 3, endpointOut: 7, extraInterfaceFirst: true });
  assert.equal(sim.configuration.configurationValue, 1);
  assert.equal(link.epIn.endpointNumber, 3);
  assert.equal(link.epOut.endpointNumber, 7);
  assert.equal(sim.configuration.interfaces[1].claimed, true);
  assert.equal(sim.configuration.interfaces[0].claimed, false, 'decoy interrupt interface left alone');
  const info = await link.info();
  assert.equal(info.productName, 'TI-84 Plus CE');
  await link.close();
  assert.equal(sim.claimed, false);
  assert.equal(sim.opened, false);
  noViolations(sim);
});

test('open(): a device without bulk endpoints fails cleanly', async () => {
  const sim = new SimulatedCalculator();
  for (const c of sim.configurations) for (const i of c.interfaces) i.alternate.endpoints.forEach(e => { e.type = 'interrupt'; });
  const link = CELink.fromDevice(sim);
  await assert.rejects(link.open(), { code: 'NO_ENDPOINTS' });
  assert.equal(sim.opened, false);
  assert.equal(findBulkInterface(sim), null);
  await assert.rejects(link.info(), { code: 'NOT_OPEN' });
});

// ------------------------------------------------------------------ negotiation

test('buffer negotiation: offer 1024, the allocation counts the header, every operation', async () => {
  // [calculator's maximum, allocation it answers, data bytes per raw packet].
  // 1018 is also a ceiling: the CE allocates more than it takes (LIBTICALCS.md 4).
  for (const [calcMax, alloc, expect] of [[1023, 1023, 1018], [1018, 1018, 1013], [255, 255, 250], [4096, 1024, 1018]]) {
    const { sim, link } = await connect({ bufferSize: calcMax });
    const big = makeEntry({ name: 'BIGONE', type: TYPE.APPVAR, body: patterned(3000) });
    await link.send(big);
    assert.equal(link.allocation, alloc);
    assert.equal(link.bufferSize, expect);
    const outs = link.captureLog.filter(p => p.dir === 'out' && (p.bytes[4] === 3 || p.bytes[4] === 4));
    assert.ok(outs.length > 0);
    assert.ok(outs.every(p => p.bytes.length - 5 <= expect), `no raw packet over ${expect} data bytes`);
    assert.ok(outs.every(p => p.bytes.length <= alloc), `no raw packet over ${alloc} bytes in total`);
    assert.ok(outs.some(p => p.bytes.length - 5 === expect), 'full-size packets are used');
    const ins = link.captureLog.filter(p => p.dir === 'in' && (p.bytes[4] === 3 || p.bytes[4] === 4));
    assert.ok(ins.every(p => p.bytes.length <= alloc));
    noViolations(sim);
  }
  // The 2006 document's rule (size = data bytes only), when both sides use it.
  const { sim: doc, link: dl } = await connect({ bufferSize: 250, allocIncludesHeader: false });
  dl.quirks.allocIncludesHeader = false;
  await dl.send(makeEntry({ name: 'DOC', type: TYPE.APPVAR, body: patterned(1000) }));
  assert.equal(dl.bufferSize, 250);
  assert.ok(dl.captureLog.some(p => p.dir === 'out' && p.bytes.length === 255));
  noViolations(doc);
  const { sim, link } = await connect();
  await link.info(); await link.list(); await link.info();
  const reqs = link.captureLog.filter(p => p.dir === 'out' && p.bytes[4] === 1);
  assert.equal(reqs.length, 3, 'one Buffer Size Request per operation');
  assert.ok(reqs.every(p => hex(p.bytes) === '00 00 00 04 01 00 00 04 00'));
  const pings = sim.commands.filter(c => c.type === VPKT.PING);
  assert.equal(pings.length, 3, 'one ping per operation');
  assert.ok(pings.every(c => hex(c.data) === '00 03 00 01 00 00 00 00 07 D0'));
  assert.equal(hex(link.lastModeAck), '00 00 07 D0');
  noViolations(sim);
});

// ------------------------------------------------------------------ info

test('info(): one parameter request, documented fields decoded, invalid ones absent', async () => {
  const { sim, link } = await connect({ invalidParams: [0x0037] });
  const info = await link.info();
  assert.equal(info.productName, 'TI-84 Plus CE');
  assert.equal(info.productId, 0xE008);
  assert.equal(info.osVersion, '5.8.5.0074');
  assert.equal(info.bootVersion, '5.0.0.0089');
  assert.equal(info.hardwareVersion, 7);
  assert.equal(info.ramFree, 154000);
  assert.equal(info.archiveFree, 2372475);
  assert.equal(info.language, 9);
  assert.equal(info.batteryOk, true);
  assert.equal(info.lcdWidth, 320);
  assert.equal(info.lcdHeight, 240);
  assert.equal('atHomescreen' in info, false);
  assert.ok(info.raw instanceof Map);
  assert.deepEqual([...info.raw.get(0x000B)], [0, 5, 8, 5]);
  assert.equal(info.raw.has(0x0037), false);
  assert.equal(info.raw.has(0x0003), false, 'the calculator id is never requested');
  assert.equal(sim.commands.filter(c => c.type === VPKT.PARAM_REQ).length, 1);
  const { link: l2 } = await connect();
  assert.equal((await l2.info()).atHomescreen, true);
  noViolations(sim);
});

test('info(): an interleaved 0xBB00 packet is waited out', async () => {
  const { sim, link } = await connect({ sendDelayPacket: true });
  const info = await link.info();
  assert.equal(info.osVersion, '5.8.5.0074');
  noViolations(sim);
});

// ------------------------------------------------------------------ list

test('list(): directory listing with size, type and archived attributes', async () => {
  const { sim, link } = await connect({
    vars: [
      { name: 'HELLO', type: 0x05, data: Uint8Array.of(2, 0, 0xDE, 0x2A) },
      { name: 'SAVE', type: 0x15, data: new Uint8Array(1200), archived: true },
      { name: 'L₁', type: 0x01, data: Uint8Array.of(0, 0) },
      { name: 'AθB', type: 0x05, data: Uint8Array.of(0, 0) },
    ],
  });
  const rows = await link.list();
  assert.deepEqual(rows.map(r => [r.name, r.type, r.typeName, r.size, r.archived]), [
    ['HELLO', 5, 'program', 4, false],
    ['SAVE', 0x15, 'app variable', 1200, true],
    ['L₁', 1, 'list', 2, false],
    ['AθB', 5, 'program', 2, false],
  ]);
  assert.equal(rows[0].typeRaw, 0xF0070005);
  const req = sim.commands.find(c => c.type === VPKT.DIR_REQ);
  assert.equal(hex(req.data), '00 00 00 03 00 01 00 02 00 03 00 01 00 01 00 01 01');
  const { sim: empty, link: l2 } = await connect();
  assert.deepEqual(await l2.list(), []);
  noViolations(sim); noViolations(empty);
});

// ------------------------------------------------------------------ send

test('send(): RAM, with the full documented sequence and progress', async () => {
  const { sim, link } = await connect();
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: Uint8Array.of(0xDE, 0x2A, 0x48, 0x49, 0x2A) });
  const progress = [];
  const r = await link.send(e, { onProgress: (s, t) => progress.push([s, t]) });
  assert.deepEqual(r, { name: 'HELLO', bytes: 7 });
  const v = sim.get('HELLO', 0x05);
  assert.deepEqual(v.data, e.data);
  assert.equal(v.archived, false);
  assert.deepEqual(progress.at(-1), [7, 7]);
  assert.deepEqual(sim.commands.map(c => c.type), [VPKT.PING, VPKT.RTS, VPKT.VAR_CNTS, VPKT.EOT]);
  const rts = sim.commands[1].data;
  // Name, NUL, size 7, silent flag, then type (owner 0x0F), archived, version (LIBTICALCS.md 7, 8).
  assert.equal(hex(rts), '00 05 48 45 4C 4C 4F 00 00 00 00 07 01 00 03 00 02 00 04 F0 0F 00 05 00 03 00 01 00 00 08 00 04 00 00 00 00');
  assert.equal(sim.commands[3].data.length, 0, 'End of Transmission is empty');
  assert.equal(sim.ramFree, 154000 - 7 - 9);
  noViolations(sim);
});

test('send(): archive sets the archived attribute; big variables stream in full raw packets', async () => {
  const { sim, link } = await connect();
  const body = patterned(60000, 7);
  const e = makeEntry({ name: 'BIGDATA', type: TYPE.APPVAR, body });
  let calls = 0; let last = -1; let monotonic = true;
  await link.send(e, { archive: true, onProgress: s => { calls++; if (s < last) monotonic = false; last = s; } });
  const v = sim.get('BIGDATA', 0x15);
  assert.equal(v.archived, true);
  assert.deepEqual(v.data, e.data);
  assert.ok(calls >= Math.ceil(60002 / 1018));
  assert.ok(monotonic);
  assert.equal(last, 60002);
  const rts = sim.commands.find(c => c.type === VPKT.RTS).data;
  assert.equal(hex(rts.subarray(-13, -8)), '00 03 00 01 01', 'archived attribute = 1');
  noViolations(sim);
});

test('send(): a multi-packet send stays within the allocation, header included', async () => {
  // The hardware failure: the real CE allocated 1023 and never acknowledged a
  // 1028-byte raw packet (1023 data bytes). The simulator now behaves the same.
  const { sim, link } = await connect();
  const body = patterned(5000, 11);
  const e = makeEntry({ name: 'BIG5K', type: TYPE.APPVAR, body });
  await link.send(e);
  assert.equal(link.allocation, 1023);
  assert.equal(link.bufferSize, 1018);
  const data = link.captureLog.filter(p => p.dir === 'out' && (p.bytes[4] === 3 || p.bytes[4] === 4));
  assert.ok(data.length >= 5);
  assert.ok(data.every(p => p.bytes.length <= 1023));
  assert.equal(data.filter(p => p.bytes.length === 1023).length, 4, 'four full 1018 + 5 packets, then the rest');
  assert.deepEqual(sim.get('BIG5K', 0x15).data, e.data);
  const back = await link.receive('BIG5K', TYPE.APPVAR);
  assert.deepEqual(back.data, e.data, 'incoming raw packets of 1018 + 5 reassemble');
  const incoming = link.captureLog.filter(p => p.dir === 'in' && (p.bytes[4] === 3 || p.bytes[4] === 4));
  assert.equal(incoming.filter(p => p.bytes.length === 1023).length, 4, 'the calculator side also sends 1018 + 5');
  noViolations(sim);

  // The same send with the document's rule and no 1018 ceiling reproduces the
  // hardware failure. (With the ceiling, the document's rule is safe: LIBTICALCS.md 4.)
  const { sim: s2, link: l2 } = await connect();
  l2.quirks.allocIncludesHeader = false;
  l2.quirks.maxDataBytes = 4096;
  l2.streamTimeout = 80;
  await assert.rejects(l2.send(e), { code: 'TIMEOUT' });
  assert.equal(s2.wedged, true);
  assert.match(s2.violations[0], /1023 data bytes \(1028 total\)/);
  assert.equal(l2.opened, false);
  assert.equal(s2.claimed, false);
});

test('quirks: CONFIRMED_ON_5_3 puts back the exact command bytes of the first hardware pass', async () => {
  const { sim, link } = await connect();
  Object.assign(link.quirks, CONFIRMED_ON_5_3);
  await link.list(); // learns the prefix 0xF0070000, as that pass did
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: Uint8Array.of(0xDE, 0x2A, 0x48, 0x49, 0x2A) });
  await link.send(e);
  await link.receive('HELLO', TYPE.PROGRAM);
  await link.delete('HELLO', TYPE.PROGRAM);
  const cmd = t => hex(sim.commands.find(c => c.type === t).data);
  assert.equal(cmd(VPKT.RTS), '00 05 48 45 4C 4C 4F 00 00 00 00 07 01 00 03 00 01 00 04 00 00 00 07 00 02 00 04 F0 07 00 05 00 03 00 01 00');
  assert.equal(cmd(VPKT.VAR_REQ), '00 05 48 45 4C 4C 4F 00 01 FF FF FF FF 00 03 00 01 00 02 00 03 00 01 00 11 00 04 F0 07 00 05 00 00');
  assert.equal(cmd(VPKT.DEL_VAR), '00 05 48 45 4C 4C 4F 00 00 01 00 11 00 04 F0 07 00 05 01 00 00 00 00');
  assert.deepEqual(DEFAULT_QUIRKS.rtsAttributes, [2, 3, 8]);
  noViolations(sim);
});

test('send(): a group file\'s three entries go one after another', async () => {
  const { sim, link } = await connect();
  const file = buildFile([
    makeEntry({ name: 'GAME', type: TYPE.PROGRAM, body: enc('main') }),
    makeEntry({ name: 'GAMEDAT', type: TYPE.APPVAR, body: patterned(2500) }),
    makeEntry({ name: 'GAMELVL', type: TYPE.APPVAR, body: patterned(900, 3) }),
  ]);
  const seen = [];
  const results = await link.sendFile(file, { onProgress: (s, t, i) => seen.push(i) });
  assert.deepEqual(results.map(r => r.name), ['GAME', 'GAMEDAT', 'GAMELVL']);
  const { entries } = parseFile(file);
  for (const e of entries) assert.deepEqual(sim.get(e.name, e.type).data, e.data);
  assert.deepEqual([...new Set(seen)], [0, 1, 2]);
  assert.equal(link.captureLog.filter(p => p.dir === 'out' && p.bytes[4] === 1).length, 3, 'one operation per entry');
  noViolations(sim);
});

test('send(): Flash apps are refused before anything is sent', async () => {
  const { sim, link } = await connect();
  const app = { name: 'APP', type: TYPE.FLASH_APP, data: new Uint8Array(10) };
  await assert.rejects(link.send(app), { code: 'UNSUPPORTED_TYPE' });
  await assert.rejects(link.send({ name: 'X', type: 5 }), { code: 'BAD_ENTRY' });
  assert.equal(sim.log.length, 0);
  assert.equal(link.opened, true);
});

test('send(): calculator errors reject with CALC_ERROR and the link stays usable', async () => {
  const { sim, link } = await connect({ ramFree: 100 });
  const e = makeEntry({ name: 'TOOBIG', type: TYPE.APPVAR, body: new Uint8Array(500) });
  await assert.rejects(link.send(e), err => {
    assert.ok(err instanceof CELinkError);
    assert.equal(err.code, 'CALC_ERROR');
    assert.equal(err.calcError, SIM_ERR.NO_MEMORY);
    assert.match(err.message, /refused/);
    return true;
  });
  assert.equal(link.opened, true);
  await assert.rejects(link.send(makeEntry({ name: '1BAD', type: TYPE.PROGRAM, body: enc('x') })), { code: 'CALC_ERROR', calcError: SIM_ERR.BAD_NAME });
  sim.errorOn.set(VPKT.RTS, 0x0012);
  await assert.rejects(link.send(makeEntry({ name: 'OK', type: TYPE.PROGRAM, body: enc('x') })), { code: 'CALC_ERROR', calcError: 0x0012 });
  sim.errorOn.clear();
  const info = await link.info();
  assert.equal(info.productName, 'TI-84 Plus CE');
  noViolations(sim);
});

test('send(): two calls at once are run one after the other', async () => {
  const { sim, link } = await connect();
  const a = makeEntry({ name: 'AAA', type: TYPE.APPVAR, body: patterned(3000, 1) });
  const b = makeEntry({ name: 'BBB', type: TYPE.APPVAR, body: patterned(3000, 2) });
  await Promise.all([link.send(a), link.send(b), link.list()]);
  assert.deepEqual(sim.get('AAA', 0x15).data, a.data);
  assert.deepEqual(sim.get('BBB', 0x15).data, b.data);
  noViolations(sim);
});

// ------------------------------------------------------------------ receive

test('receive(): Request Variable with the type as attribute 0x0011, round trip to a file', async () => {
  const { sim, link } = await connect();
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: patterned(4000, 9) });
  await link.send(e);
  const got = await link.receive('HELLO', TYPE.PROGRAM);
  assert.equal(got.name, 'HELLO');
  assert.equal(got.type, 5);
  assert.equal(got.typeName, 'program');
  assert.equal(got.archived, false);
  assert.deepEqual(got.nameBytes, e.nameBytes);
  assert.deepEqual(got.data, e.data);
  assert.deepEqual(parseFile(buildFile([got])).entries[0].data, e.data);
  const req = sim.commands.find(c => c.type === VPKT.VAR_REQ).data;
  // Asks back archived, version and size; the type goes as 0x0011 with owner 0x07 (LIBTICALCS.md 8, 13).
  assert.equal(hex(req), '00 05 48 45 4C 4C 4F 00 01 FF FF FF FF 00 03 00 03 00 08 00 01 00 01 00 11 00 04 F0 07 00 05 00 00');
  noViolations(sim);
});

test('receive(): archived, tokenised names, θ, and names taken from list()', async () => {
  const { sim, link } = await connect({
    vars: [
      { name: 'L₁', type: 0x01, data: Uint8Array.of(1, 0, 0, 0x80, 0x10, 0, 0, 0, 0, 0, 0) },
      { name: 'AθB', type: 0x05, data: Uint8Array.of(1, 0, 0x41) },
      { name: 'ARCH', type: 0x15, data: patterned(2000), archived: true },
    ],
  });
  const l1 = await link.receive('L1', TYPE.LIST);
  assert.deepEqual([...l1.nameBytes.subarray(0, 2)], [0x5D, 0x00]);
  const theta = await link.receive('AθB', TYPE.PROGRAM);
  assert.equal(theta.nameBytes[1], 0x5B);
  const rows = await link.list();
  const arch = rows.find(r => r.name === 'ARCH');
  const got = await link.receive(arch.nameBytes, arch.type);
  assert.equal(got.archived, true);
  assert.deepEqual(got.data, sim.get('ARCH', 0x15).data);
  await assert.rejects(link.receive('NOPE', TYPE.PROGRAM), { code: 'CALC_ERROR', calcError: SIM_ERR.NOT_FOUND });
  await assert.rejects(link.receive('', TYPE.PROGRAM), { code: 'BAD_NAME' });
  noViolations(sim);
});

// ------------------------------------------------------------------ delete

test('delete(): removes the variable, answers 0xAA00; missing ones are a calculator error', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'OLD', type: 0x05, data: Uint8Array.of(0, 0) }] });
  const r = await link.delete('OLD', TYPE.PROGRAM);
  assert.deepEqual(r, { name: 'OLD', deleted: true });
  assert.equal(sim.get('OLD', 0x05), undefined);
  const del = sim.commands.find(c => c.type === VPKT.DEL_VAR).data;
  // Owner byte 0x0B for deletes (LIBTICALCS.md 8); 01 = bypass protection, then an empty destination.
  assert.equal(hex(del), '00 03 4F 4C 44 00 00 01 00 11 00 04 F0 0B 00 05 01 00 00 00 00');
  await assert.rejects(link.delete('OLD', TYPE.PROGRAM), { code: 'CALC_ERROR', calcError: SIM_ERR.NOT_FOUND });
  assert.deepEqual(await link.list(), []);
  noViolations(sim);
});

// ------------------------------------------------------------------ timeouts

test('timeouts: a silent calculator gives TIMEOUT and the interface is released', async () => {
  const { sim, link } = await connect();
  link.timeout = 60;
  sim.freeze = true;
  const t0 = Date.now();
  await assert.rejects(link.info(), err => {
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /stopped answering/);
    return true;
  });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(link.opened, false);
  assert.equal(sim.claimed, false);
  assert.equal(sim.opened, false);
  await assert.rejects(link.list(), { code: 'NOT_OPEN' });
  // It can be opened again.
  sim.freeze = false;
  await link.open();
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
});

test('timeouts: a calculator that goes silent mid-stream times out too', async () => {
  const { sim, link } = await connect();
  link.streamTimeout = 80;
  const orig = sim._contents.bind(sim);
  sim._contents = () => { sim.freeze = true; };
  await assert.rejects(link.send(makeEntry({ name: 'HANG', type: TYPE.APPVAR, body: patterned(5000) })), { code: 'TIMEOUT' });
  sim._contents = orig;
  assert.equal(link.opened, false);
  assert.equal(sim.claimed, false);
});

test('a USB stall is fatal and closes the link', async () => {
  const { sim, link } = await connect();
  sim.transferOut = async () => ({ status: 'stall', bytesWritten: 0 });
  await assert.rejects(link.info(), { code: 'USB_ERROR' });
  assert.equal(link.opened, false);
});

// ------------------------------------------------------------------ capture

test('capture: every raw packet in both directions, in order, exported as hex JSON', async () => {
  const { sim, link } = await connect();
  await link.info();
  await link.send(makeEntry({ name: 'CAP', type: TYPE.APPVAR, body: patterned(2500) }));
  await link.receive('CAP', TYPE.APPVAR);
  await link.delete('CAP', TYPE.APPVAR);
  assert.equal(link.captureLog.length, sim.log.length);
  link.captureLog.forEach((p, i) => {
    assert.equal(p.dir, sim.log[i].dir, `packet ${i} direction`);
    assert.deepEqual(p.bytes, sim.log[i].bytes, `packet ${i} bytes`);
    assert.equal(typeof p.t, 'number');
    if (i) assert.ok(p.t >= link.captureLog[i - 1].t);
  });
  const j = JSON.parse(link.exportCapture());
  assert.equal(j.format, 'celink-capture/1');
  assert.equal(j.device.productId, '0xE008');
  assert.equal(j.packets.length, link.captureLog.length);
  assert.equal(j.packets[0].hex, '00 00 00 04 01 00 00 04 00');
  assert.match(j.packets[0].note, /buffer size request/);
  assert.ok(j.packets.some(p => /virtual 0x000B \(Request to Send\)/.test(p.note)));
  assert.ok(j.packets.some(p => /continuation/.test(p.note)));
  assert.deepEqual(j.ops.map(o => o.op), ['info', 'send CAP', 'receive CAP', 'delete CAP']);
  const { link: quiet } = await connect({}, { capture: false });
  await quiet.info();
  assert.equal(quiet.captureLog.length, 0);
});

// ------------------------------------------------------------------ the simulator itself

test('simulator is strict: oversize packets, missing acks, no ping, wrong mode', async () => {
  const raw = async (sim, type, data) => sim.transferOut(2, encodeRaw(type, data));
  const read = async sim => { const r = await sim.transferIn(1, 2048); return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength); };
  const vsend = async (sim, vtype, data) => { await raw(sim, 4, encodeVirtual(vtype, data)); return read(sim); };
  const fresh = async () => { const s = new SimulatedCalculator({ bufferSize: 100 }); await s.open(); await s.selectConfiguration(1); await s.claimInterface(0); return s; };

  // Oversize raw packet: 96 data bytes is 101 in total, over an allocation of 100.
  // Like the real CE: no acknowledgement, then silence until replugged.
  let s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]);
  assert.equal(hex(await read(s)), '00 00 00 04 02 00 00 00 64');
  assert.equal((await raw(s, 3, new Uint8Array(96))).status, 'ok');
  assert.match(s.violations[0], /96 data bytes \(101 total\) exceeds the allocation of 100 \(header included\)/);
  assert.equal(s.wedged, true);
  const silent = await Promise.race([s.transferIn(1, 64).then(() => 'answered', () => 'closed'), new Promise(r => setTimeout(() => r('silent'), 50))]);
  assert.equal(silent, 'silent');
  await raw(s, 1, [0, 0, 4, 0]);
  assert.equal(s.log.at(-1).dir, 'out', 'still silent after a new Buffer Size Request');
  await s.close(); await s.open();
  assert.equal(s.wedged, true, 'closing and reopening does not clear it');
  s.replug();
  assert.equal(s.wedged, false);
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]); await read(s);
  assert.equal((await raw(s, 3, new Uint8Array(95))).status, 'ok', '95 + 5 = 100 fits');
  assert.equal(hex(await read(s)), '00 00 00 02 05 E0 00');

  // Data before negotiation.
  s = await fresh();
  assert.equal((await raw(s, 4, encodeVirtual(1, new Uint8Array(10)))).status, 'stall');
  assert.match(s.violations[0], /before the buffer size was negotiated/);

  // Command before the ping.
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]); await read(s);
  assert.equal(hex(await vsend(s, 0x0007, [0, 1, 0, 2])), '00 00 00 02 05 E0 00');
  const err = await read(s);
  assert.equal(hex(err), '00 00 00 08 04 00 00 00 02 EE 00 7F 01');
  assert.match(s.violations[0], /before the mode ping/);

  // Next packet before acknowledging the calculator's.
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]); await read(s);
  await vsend(s, 0x0001, fromHex('00 03 00 01 00 00 00 00 07 D0'));
  assert.equal(hex(await read(s)), '00 00 00 0A 04 00 00 00 04 00 12 00 00 07 D0');
  assert.equal((await raw(s, 4, encodeVirtual(0x0007, [0, 1, 0, 2]))).status, 'stall');
  assert.match(s.violations[0], /before acknowledging/);

  // Wrong mode: basic mode refuses a directory listing.
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]); await read(s);
  await vsend(s, 0x0001, fromHex('00 02 00 01 00 00 00 00 07 D0'));
  await read(s); await raw(s, 5, [0xE0, 0]);
  await vsend(s, 0x0009, fromHex('00 00 00 01 00 01 00 01 00 01 00 01 01'));
  assert.equal(hex(await read(s)), '00 00 00 08 04 00 00 00 02 EE 00 7F 02');
  assert.match(s.violations[0], /not accepted in mode 000200010000/);

  // Ping value out of range: the documented error codes.
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]); await read(s);
  await vsend(s, 0x0001, fromHex('00 03 00 01 00 00 00 00 00 01'));
  assert.equal(hex(await read(s)), '00 00 00 08 04 00 00 00 02 EE 00 00 1C');

  // A read smaller than a USB packet is babble.
  s = await fresh();
  await raw(s, 1, [0, 0, 4, 0]);
  assert.equal((await s.transferIn(1, 4)).status, 'babble');
});

test('simulator: raw packets are delivered in 64-byte USB packets with no zero-length packet', async () => {
  const s = new SimulatedCalculator({ vars: [{ name: 'Z', type: 0x15, data: new Uint8Array(64 * 3 - 11) }] });
  const link = CELink.fromDevice(s);
  link.timeout = 300;
  await link.open();
  const got = await link.receive('Z', TYPE.APPVAR);
  assert.equal(got.data.length, 64 * 3 - 11, 'contents raw packet is exactly 3 full USB packets');
  noViolations(s);
});

test('OPEN_FAILED names the WebUSB step that refused and the DOMException name, never more', async () => {
  const domError = (name, message) => Object.assign(new Error(message), { name });
  const refuse = (method, name) => async () => {
    const sim = new SimulatedCalculator();
    sim[method] = async () => { throw domError(name, 'Access denied.'); };
    const link = CELink.fromDevice(sim);
    const err = await link.open().then(() => null, e => e);
    assert.ok(err instanceof CELinkError);
    return err;
  };
  let e = await refuse('open', 'SecurityError')();
  assert.equal(e.code, 'OPEN_FAILED'); assert.equal(e.step, 'open'); assert.equal(e.cause, 'SecurityError');
  e = await refuse('claimInterface', 'NetworkError')();
  assert.equal(e.step, 'claim'); assert.equal(e.cause, 'NetworkError');
  // a thrown non-Error has no name: cause is empty, not the thrown value
  const sim = new SimulatedCalculator();
  sim.open = async () => { throw 'boom'; };
  e = await CELink.fromDevice(sim).open().then(() => null, x => x);
  assert.equal(e.step, 'open'); assert.equal(e.cause, '');
});
