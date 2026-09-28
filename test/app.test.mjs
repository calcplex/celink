// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
//
// Flash applications (.8ek): parsing, sending, receiving, deleting, listing.
// Built from the libticalcs comparison, LIBTICALCS.md A; see README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELink, bytes, u16, u32, hex, VPKT } from '../celink.mjs';
import { parseFile, parseAppFile, buildAppFile, buildFile, appNameFromData, makeEntry, TYPE, APP_MAX_DATA } from '../tifiles.mjs';
import { SimulatedCalculator, SIM_ERR } from '../sim/calculator.mjs';

const enc = s => new TextEncoder().encode(s);

async function connect(simOpts = {}) {
  const sim = new SimulatedCalculator(simOpts);
  const link = CELink.fromDevice(sim);
  link.capture = true;
  link.timeout = 1000;
  link.streamTimeout = 2000;
  link.appTimeout = 2000;
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

/** A field: 2-byte id (low nibble = length form), length bytes, contents. */
function field(id, contents) {
  const n = id & 0x0F;
  const len = contents.length;
  const lb = n === 0x0D ? [len] : n === 0x0E ? u16(len) : n === 0x0F ? u32(len) : [];
  if (n < 0x0D) assert.equal(n, len, 'a nibble-length field must match its contents');
  return bytes(u16(id), lb, contents);
}
/** An application image of exactly `size` bytes: 81 0F <length>, a few fields, the name, filler. */
function appImage(name, size, { first = 0x81, withName = true } = {}) {
  const fields = bytes(
    field(0x8012, [0x13, 0x0F]),
    field(0x802D, enc('5.0.0.0089')),
    withName ? field(0x8140 | name.length, enc(name)) : [],
  );
  const head = bytes(first, 0x0F, u32(size - 6), fields);
  assert.ok(head.length <= size);
  const out = new Uint8Array(size);
  out.set(head);
  out.set(patterned(size - head.length, size).map(x => x & 0x7F), head.length); // filler
  return out;
}
/** One **TIFL** section. */
function section({ dataType = 0x24, data, name = 'APP', hardwareId = 0x13, deviceType = 0x73 }) {
  const h = new Uint8Array(78);
  h.set(enc('**TIFL**'));
  h[8] = 1; h[9] = 2; h[12] = 0x22; h[13] = 0x09; h[14] = 0x20; h[15] = 0x26;
  h[16] = name.length; h.set(enc(name), 17);
  h[48] = deviceType; h[49] = dataType; h[73] = hardwareId;
  h[74] = data.length & 0xFF; h[75] = (data.length >> 8) & 0xFF; h[76] = (data.length >> 16) & 0xFF; h[77] = data.length >>> 24;
  return bytes(h, data);
}
const codes = r => r.warnings.map(w => w.code);

// ------------------------------------------------------------------ parsing

test('app file: one section, the embedded name wins over the header name', () => {
  const data = appImage('MYAPP', 3000);
  const r = parseFile(section({ data, name: 'HDRNAME' }));
  assert.deepEqual(codes(r), []);
  const e = r.entries[0];
  assert.equal(e.type, TYPE.FLASH_APP);
  assert.equal(e.name, 'MYAPP');
  assert.equal(hex(e.nameBytes), '4D 59 41 50 50');
  assert.equal(e.archived, true);
  assert.equal(e.size, 3000);
  assert.deepEqual(e.data, data);
  assert.equal(e.app.headerName, 'HDRNAME');
  assert.equal(e.app.embeddedName, 'MYAPP');
  assert.equal(e.app.hardwareId, 0x13);
  assert.deepEqual(e.app.revision, [1, 2]);
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].dataTypeName, 'application');
});

test('app file: chained sections, license first, the application is the one picked', () => {
  const license = bytes(0x80, 0x0F, u32(10), patterned(10));
  const data = appImage('CHAINED', 5000);
  const r = parseAppFile(bytes(section({ dataType: 0x3E, data: license, name: 'LICENSE' }), section({ data, name: 'CHAINED' })));
  assert.deepEqual(r.sections.map(s => [s.dataTypeName, s.headerName, s.dataLength]), [['license', 'LICENSE', 16], ['application', 'CHAINED', 5000]]);
  assert.equal(r.sections[1].offset, 78 + 16);
  assert.equal(r.entries[0].name, 'CHAINED');
  assert.deepEqual(r.entries[0].data, data);
  assert.deepEqual(codes(r), []);
});

test('app name: the four length forms, and ids compared with the low nibble masked', () => {
  const data = bytes(0x81, 0x0F, u32(0),
    field(0x801D, patterned(3)),     // one length byte
    field(0x802E, patterned(300)),   // two length bytes
    field(0x803F, patterned(5)),     // four length bytes
    field(0x8104, patterned(4)),     // the nibble is the length
    field(0x814E, enc('LONGFORM')),  // the name, written with a two-byte length
  );
  assert.equal(new TextDecoder().decode(appNameFromData(data)), 'LONGFORM');
  assert.equal(appNameFromData(bytes(0x81, 0x0F, u32(0), field(0x8103, [1, 2, 3]))), null, 'no name field');
  assert.equal(appNameFromData(Uint8Array.of(0x81, 0x0E, 0, 0, 0, 0, 0x81, 0x41, 0x41)), null, 'not an application header');
  assert.equal(appNameFromData(bytes(0x81, 0x0F, u32(0), [0x81, 0x4D, 200, 1, 2])), null, 'a field running past the end');
});

test('app file: no embedded name falls back to the header name, with a warning', () => {
  const r = parseFile(section({ data: appImage('X', 400, { withName: false }), name: 'FROMHDR' }));
  assert.deepEqual(codes(r), ['NO_EMBEDDED_NAME']);
  assert.equal(r.entries[0].name, 'FROMHDR');
  assert.equal(r.entries[0].app.embeddedName, null);
});

test('app file: what is refused, and what is only a warning', () => {
  const data = appImage('A', 200);
  assert.throws(() => parseFile(section({ dataType: 0x23, data: bytes(0x80, 0x0F, u32(4), [1, 2, 3, 4]) })), { code: 'UNSUPPORTED_TYPE', message: /does not send operating systems/ });
  assert.throws(() => parseFile(section({ data, hardwareId: 0 })), { code: 'UNSUPPORTED_TYPE', message: /monochrome/ });
  assert.throws(() => parseFile(section({ data, deviceType: 0x98 })), { code: 'BAD_FILE', message: /another calculator/ });
  assert.throws(() => parseFile(section({ data, dataType: 0x55 })), { code: 'BAD_FILE', message: /data type/ });
  assert.throws(() => parseFile(section({ data: appImage('A', 200, { first: 0x80 }) })), { code: 'BAD_FILE', message: /0x81/ });
  assert.throws(() => parseFile(section({ dataType: 0x3E, data: patterned(20) })), { code: 'BAD_FILE', message: /no application/ });
  assert.throws(() => parseFile(section({ data }).subarray(0, 150)), { code: 'BAD_FILE', message: /truncated/ });
  assert.throws(() => parseFile(section({ data }).subarray(0, 60)), { code: 'BAD_FILE', message: /cut short/ });
  const huge = section({ data }); huge[74] = 0x01; huge[75] = 0xC0; huge[76] = 0x3F; huge[77] = 0x00; // 4 MB - 16 KB + 1
  assert.equal(0x3FC001, APP_MAX_DATA + 1);
  assert.throws(() => parseFile(huge), { code: 'BAD_FILE', message: /more than any application/ });
  assert.deepEqual(codes(parseFile(bytes(section({ data }), [1, 2, 3]))), ['TRAILING_BYTES']);
  assert.deepEqual(codes(parseFile(section({ data, deviceType: 0x74 }))), ['OTHER_MODEL']);
  assert.deepEqual(codes(parseFile(bytes(section({ data }), section({ data })))), ['SEVERAL_APPS']);
});

test('app file: buildAppFile writes what parseAppFile reads; buildFile refuses an app', () => {
  const r = parseFile(section({ data: appImage('ROUND', 1000), name: 'ROUND' }));
  const again = parseAppFile(buildAppFile(r.entries[0]));
  assert.deepEqual(again.entries[0].data, r.entries[0].data);
  assert.equal(again.entries[0].name, 'ROUND');
  assert.deepEqual(again.sections[0].dateBytes, [0x22, 0x09, 0x20, 0x26]);
  assert.equal(parseAppFile(buildAppFile(r.entries[0], { hardwareId: 0x0F })).sections[0].hardwareId, 0x0F);
  assert.throws(() => buildFile(r.entries), { code: 'BAD_ENTRY', message: /buildAppFile/ });
  assert.throws(() => buildAppFile(makeEntry({ name: 'V', type: TYPE.APPVAR, body: Uint8Array.of(1) })), { code: 'BAD_ENTRY' });
});

// ------------------------------------------------------------------ sending

test('sendApp: the exact sequence, one Variable Contents, delays during the Flash erase and write', async () => {
  const { sim, link } = await connect();
  const file = section({ data: appImage('SENDME', 70000), name: 'SENDME' });
  const progress = [];
  const t0 = performance.now();
  const r = await link.sendApp(file, { onProgress: (s, t) => progress.push([s, t]) });
  assert.deepEqual(r, { name: 'SENDME', bytes: 70000 });
  assert.ok(performance.now() - t0 >= 68, 'two 20 ms erase delays and a 30 ms write delay were waited out');
  assert.deepEqual(sim.commands.map(c => c.type), [VPKT.PING, VPKT.PARAM_REQ, VPKT.RTS, VPKT.VAR_CNTS, VPKT.EOT]);
  assert.equal(hex(sim.commands[0].data), '00 03 00 01 00 00 00 00 07 D0', 'the normal-mode ping, nothing else');
  assert.equal(hex(sim.commands[1].data), '00 01 00 2D', 'the battery check reads 0x002D');
  // folder 00, name length 6, name, NUL, length 70000, silent, two attributes: type F0 0F 00 24, archived 01.
  assert.equal(hex(sim.commands[2].data),
    '00 06 53 45 4E 44 4D 45 00 00 01 11 70 01 00 02 00 02 00 04 F0 0F 00 24 00 03 00 01 01');
  assert.equal(sim.commands[3].data.length, 70000);
  const stored = sim.get('SENDME', TYPE.FLASH_APP);
  assert.equal(stored.archived, true);
  assert.deepEqual(stored.data, parseFile(file).entries[0].data);
  const delays = sim.log.filter(p => p.dir === 'in' && p.bytes[4] === 4 && p.bytes[9] === 0xBB && p.bytes[10] === 0x00);
  assert.equal(delays.length, 3);
  assert.deepEqual(progress.at(-1), [70000, 70000]);
  assert.ok(progress.length > 60, 'progress per raw packet');
  noViolations(sim);
});

test('sendApp: a 200 KB app whose last raw packet is 64 bytes gets the zero-length write', async () => {
  const size = 1018 * 200 + 53; // 6 + size leaves 59 data bytes, 64 on the wire, in the last packet
  const { sim, link } = await connect();
  await link.sendApp(section({ data: appImage('BIGAPP', size), name: 'BIGAPP' }));
  assert.equal(sim.get('BIGAPP', TYPE.FLASH_APP).data.length, size);
  const out = sim.log.filter(p => p.dir === 'out');
  const zlp = out.findIndex(p => p.bytes.length === 0);
  assert.ok(zlp > 0);
  assert.equal(out[zlp - 1].bytes.length, 64);
  assert.equal(out.filter(p => p.bytes.length === 0).length, 1);
  assert.ok(out.filter(p => p.bytes[4] === 3).length >= 200, 'hundreds of raw packets');
  noViolations(sim);
});

test('sendApp: send() and sendFile() leave apps to sendApp()', async () => {
  const { sim, link } = await connect();
  const file = section({ data: appImage('NOPE', 300), name: 'NOPE' });
  await assert.rejects(link.send(parseFile(file).entries[0]), { code: 'UNSUPPORTED_TYPE', message: /sendApp/ });
  await assert.rejects(link.sendFile(file), { code: 'UNSUPPORTED_TYPE', message: /sendApp/ });
  await assert.rejects(link.sendApp(buildFile([makeEntry({ name: 'V', type: TYPE.APPVAR, body: Uint8Array.of(1) })])), { code: 'BAD_FILE' });
  await assert.rejects(link.sendApp({ name: 'X', type: TYPE.PROGRAM, data: new Uint8Array(3) }), { code: 'BAD_ENTRY' });
  assert.equal(sim.log.length, 0, 'nothing reached the calculator');
});

test('sendApp: a low battery is refused before anything is sent', async () => {
  const { sim, link } = await connect({ battery: { ok: false, level: 12, external: false } });
  await assert.rejects(link.sendApp(section({ data: appImage('LOW', 300), name: 'LOW' })), { code: 'LOW_BATTERY', message: /too low.*Nothing was sent/ });
  assert.ok(!sim.commands.some(c => c.type === VPKT.RTS), 'no Request to Send');
  assert.equal(link.opened, true, 'the link stays usable');
  link.quirks.appBatteryDetail = true;
  await assert.rejects(link.sendApp(section({ data: appImage('LOW', 300), name: 'LOW' })), { message: /reports 12%/ });
  assert.equal(hex(sim.commands.at(-1).data), '00 03 00 2D 00 2E 00 2F');
  sim.battery.external = true;
  await assert.rejects(link.sendApp(section({ data: appImage('LOW', 300), name: 'LOW' })), { message: /external power/ });
  noViolations(sim);
});

test('sendApp: the calculator\'s own refusals read as sentences', async () => {
  const file = name => section({ data: appImage(name, 500), name });
  // Battery low at the calculator (the pre-check turned off).
  let { sim, link } = await connect({ battery: { ok: false, level: 5, external: false } });
  link.quirks.appBatteryCheck = false;
  await assert.rejects(link.sendApp(file('BAT')), e => e.calcError === SIM_ERR.BATTERY_LOW && /battery is too low to write Flash/.test(e.message));
  // Not enough Flash.
  ({ sim, link } = await connect({ archiveFree: 400 }));
  await assert.rejects(link.sendApp(file('FULL')), e => e.calcError === 0x000C && /not enough free archive memory/.test(e.message));
  // A signature the calculator cannot accept: not an application image, or no name in its header.
  ({ sim, link } = await connect());
  const bad = { name: 'BADSIG', type: TYPE.FLASH_APP, data: appImage('BADSIG', 500, { first: 0x80 }) };
  await assert.rejects(link.sendApp(bad), e => e.calcError === 0x002E && /signature does not match/.test(e.message));
  const noname = { name: 'NONAME', type: TYPE.FLASH_APP, data: appImage('NONAME', 500, { withName: false }) };
  await assert.rejects(link.sendApp(noname), e => e.calcError === 0x002E);
  assert.equal(sim.get('BADSIG', TYPE.FLASH_APP), undefined);
  assert.equal(link.opened, true);
  noViolations(sim);
});

test('simulator: an application Request to Send with the wrong attributes is refused', async () => {
  const { sim, link } = await connect();
  link.quirks.appSendTypeWord = 0xF0070024;
  await assert.rejects(link.sendApp(section({ data: appImage('WRONG', 300), name: 'WRONG' })), { code: 'CALC_ERROR' });
  assert.match(sim.violations[0], /exactly 0002=f00f0024 then 0003=01; it carried 0002=f0070024 0003=01/);
  // With a version attribute, as an ordinary variable would carry.
  const { sim: s2, link: l2 } = await connect();
  const rts = bytes(u16(3), enc('ABC'), 0x00, u32(300), 0x01, u16(3),
    u16(2), u16(4), u32(0xF00F0024), u16(3), u16(1), 0x01, u16(8), u16(4), u32(0));
  await assert.rejects(l2._op('raw', async () => { await l2._begin(); await l2._sendVirtual(VPKT.RTS, rts); await l2._expect([VPKT.DATA_ACK]); }), { code: 'CALC_ERROR' });
  assert.match(s2.violations[0], /0008=00000000/);
});

// ------------------------------------------------------------------ receive, delete, list

test('receiveApp, listApps, deleteApp', async () => {
  const data = appImage('GOTIT', 9000);
  const { sim, link } = await connect({ vars: [
    { name: 'GOTIT', type: TYPE.FLASH_APP, data, archived: true },
    { name: 'PROG', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) },
  ] });
  assert.deepEqual((await link.listApps()).map(a => [a.name, a.type]), [['GOTIT', 0x24]]);
  const got = await link.receive('GOTIT', TYPE.FLASH_APP);
  assert.deepEqual(got.data, data);
  assert.equal(got.app.hardwareId, 0x13, 'from the product number');
  assert.equal(got.app.embeddedName, 'GOTIT');
  const req = sim.commands.filter(c => c.type === VPKT.VAR_REQ).at(-1).data;
  assert.equal(hex(req), '00 05 47 4F 54 49 54 00 01 FF FF FF FF 00 02 00 03 00 08 00 01 00 11 00 04 F0 0F 00 24 00 00');
  const file = buildAppFile(got);
  const back = parseAppFile(file);
  assert.equal(back.sections[0].hardwareId, 0x13);
  assert.deepEqual(back.entries[0].data, data);
  await link.deleteApp('GOTIT');
  assert.match(hex(sim.commands.at(-1).data), /00 11 00 04 F0 0B 00 24 01 00 00 00 00$/);
  assert.deepEqual(await link.listApps(), []);
  noViolations(sim);
  // The simulator refuses an application request with the variable owner byte.
  link.quirks.appReceiveTypeWord = 0xF0070024;
  await assert.rejects(link.receiveApp('GOTIT'), { code: 'CALC_ERROR' });
  assert.match(sim.violations[0], /F0 0F 00 24/);
});
