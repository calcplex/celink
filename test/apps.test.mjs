// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// Flash applications (.8ek): parsing, sending, receiving, deleting, listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VPKT } from '../celink.mjs';
import { parseFile, parseAppFile, buildAppFile, buildFile, appNameFromData, makeEntry, TYPE, APP_MAX_DATA } from '../tifiles.mjs';
import { SIM_ERR } from '../sim/calculator.mjs';
import { connect, noViolations, patterned, hex, be16, be32, utf8, lastCommand, written, rawHost, appField, appImage, appSection, appFile } from './testkit.mjs';

const TIMEOUTS = { timeout: 1000, streamTimeout: 2000 };

const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'number' ? [p] : [...p])));
const codes = r => r.warnings.map(w => w.code);
// Built by hand, so the calculator can be shown an image parseAppFile would refuse.
const unchecked = data => ({ entries: [{ name: 'APP', type: TYPE.FLASH_APP, data }] });

test('app file: one section, the embedded name wins over the header name', () => {
  const data = appImage('MYAPP', 3000);
  const r = parseFile(appSection({ data, name: 'HDRNAME' }));
  assert.deepEqual(codes(r), []);
  const e = r.entries[0];
  assert.deepEqual([e.type, e.name, hex(e.nameBytes), e.archived, e.size], [TYPE.FLASH_APP, 'MYAPP', '4D 59 41 50 50', true, 3000]);
  assert.deepEqual(e.data, data);
  assert.deepEqual([e.app.headerName, e.app.embeddedName, e.app.hardwareId], ['HDRNAME', 'MYAPP', 0x13]);
  assert.deepEqual(e.app.revision, [1, 2]);
  assert.deepEqual(r.sections.map(s => s.dataTypeName), ['application']);
});

test('app file: the name is at most 8 bytes, read through the calculator\'s character set, as libtifiles reads it', async () => {
  const long = parseFile(appSection({ data: appImage('LONGNAME9', 400), name: 'HDR' })).entries[0];
  assert.deepEqual([long.name, hex(long.nameBytes), long.app.embeddedName], ['LONGNAME', '4C 4F 4E 47 4E 41 4D 45', 'LONGNAME9']);
  const theta = parseFile(appSection({ data: appImage('A[B', 400), name: 'HDR' }));
  assert.equal(theta.entries[0].name, 'AθB');
  const { sim, link } = await connect({}, TIMEOUTS);
  await link.sendApp(theta);
  assert.match(hex(lastCommand(sim, VPKT.RTS)), /^00 04 41 CE B8 42 00 /, 'the Request to Send spells it in UTF-8');
  noViolations(sim);
});

test('app file: chained sections, license first, the application is the one picked', () => {
  const license = bytes(0x80, 0x0F, be32(10), patterned(10));
  const data = appImage('CHAINED', 5000);
  const r = parseAppFile(bytes(appSection({ dataType: 0x3E, data: license, name: 'LICENSE' }), appSection({ data, name: 'CHAINED' })));
  assert.deepEqual(r.sections.map(s => [s.dataTypeName, s.headerName, s.dataLength]), [['license', 'LICENSE', 16], ['application', 'CHAINED', 5000]]);
  assert.equal(r.sections[1].offset, 78 + 16);
  assert.equal(r.entries[0].name, 'CHAINED');
  assert.deepEqual(r.entries[0].data, data);
  assert.deepEqual(codes(r), []);
});

test('app name: the four length forms, and ids compared with the low nibble masked', () => {
  const data = bytes(0x81, 0x0F, be32(0),
    appField(0x801D, patterned(3)),     // one length byte
    appField(0x802E, patterned(300)),   // two length bytes
    appField(0x803F, patterned(5)),     // four length bytes
    appField(0x8104, patterned(4)),     // the nibble is the length
    appField(0x814E, utf8('LONGFORM')), // the name, with a two-byte length
  );
  assert.equal(new TextDecoder().decode(appNameFromData(data)), 'LONGFORM');
  assert.equal(appNameFromData(bytes(0x81, 0x0F, be32(0), appField(0x8103, [1, 2, 3]))), null, 'no name field');
  assert.equal(appNameFromData(Uint8Array.of(0x81, 0x0E, 0, 0, 0, 0, 0x81, 0x41, 0x41)), null, 'not an application header');
  assert.equal(appNameFromData(bytes(0x81, 0x0F, be32(0), [0x81, 0x4D, 200, 1, 2])), null, 'a field running past the end');
});

test('app file: no embedded name falls back to the header name, with a warning', () => {
  const r = parseFile(appSection({ data: appImage('X', 400, { withName: false }), name: 'FROMHDR' }));
  assert.deepEqual(codes(r), ['NO_EMBEDDED_NAME']);
  assert.equal(r.entries[0].name, 'FROMHDR');
  assert.equal(r.entries[0].app.embeddedName, null);
});

test('app file: what is refused, and what is only a warning', () => {
  const data = appImage('A', 200);
  assert.throws(() => parseFile(appSection({ dataType: 0x23, data: bytes(0x80, 0x0F, be32(4), [1, 2, 3, 4]) })), { code: 'UNSUPPORTED_TYPE', message: /does not send operating systems/ });
  assert.throws(() => parseFile(appSection({ data, hardwareId: 0 })), { code: 'UNSUPPORTED_TYPE', message: /monochrome/ });
  assert.throws(() => parseFile(appSection({ data, deviceType: 0x98 })), { code: 'BAD_FILE', message: /another calculator/ });
  assert.throws(() => parseFile(appSection({ data, dataType: 0x55 })), { code: 'BAD_FILE', message: /data type/ });
  assert.throws(() => parseFile(appSection({ data: appImage('A', 200, { first: 0x80 }) })), { code: 'BAD_FILE', message: /0x81/ });
  assert.throws(() => parseFile(appSection({ dataType: 0x3E, data: patterned(20) })), { code: 'BAD_FILE', message: /no application/ });
  assert.throws(() => parseFile(appSection({ data }).subarray(0, 150)), { code: 'BAD_FILE', message: /truncated/ });
  assert.throws(() => parseFile(appSection({ data }).subarray(0, 60)), { code: 'BAD_FILE', message: /cut short/ });
  const huge = appSection({ data });
  new DataView(huge.buffer).setUint32(74, APP_MAX_DATA + 1, true);
  assert.throws(() => parseFile(huge), { code: 'BAD_FILE', message: /more than any application/ });
  assert.deepEqual(codes(parseFile(bytes(appSection({ data }), [1, 2, 3]))), ['TRAILING_BYTES']);
  assert.deepEqual(codes(parseFile(appSection({ data, deviceType: 0x74 }))), ['OTHER_MODEL']);
  assert.deepEqual(codes(parseFile(bytes(appSection({ data }), appSection({ data })))), ['SEVERAL_APPS']);
});

test('app file: buildAppFile writes what parseAppFile reads', () => {
  const r = parseFile(appFile('ROUND', 1000));
  const again = parseAppFile(buildAppFile(r.entries[0]));
  assert.deepEqual(again.entries[0].data, r.entries[0].data);
  assert.equal(again.entries[0].name, 'ROUND');
  assert.deepEqual(again.sections[0].dateBytes, [0x22, 0x09, 0x20, 0x26]);
  assert.equal(parseAppFile(buildAppFile(r.entries[0], { hardwareId: 0x0F })).sections[0].hardwareId, 0x0F);
  assert.throws(() => buildAppFile(makeEntry({ name: 'V', type: TYPE.APPVAR, body: Uint8Array.of(1) })), { code: 'BAD_ENTRY' });
});

test('app file: buildFile leaves an application to buildAppFile', () => {
  assert.throws(() => buildFile(parseFile(appFile('ROUND', 1000)).entries), { code: 'BAD_ENTRY', message: /buildAppFile/ });
});

test('sendApp: Request to Send with type and archived only, the whole app as one Variable Contents, then EOT', async () => {
  // A delay before each acknowledgement, as a calculator erasing and writing Flash may ask for.
  const { sim, link } = await connect({ delays: { [VPKT.DATA_ACK]: 20000 } }, TIMEOUTS);
  const file = appFile('SENDME', 70000);
  const progress = [];
  assert.deepEqual(await link.sendApp(parseAppFile(file), { onProgress: (sent, total) => progress.push([sent, total]) }), { name: 'SENDME', bytes: 70000 });
  assert.deepEqual(sim.commands.map(c => c.type), [VPKT.PING, VPKT.RTS, VPKT.VAR_CNTS, VPKT.EOT], 'no battery read');
  // No folder, name, NUL, length 70000, silent, two attributes: type F0 0F 00 24, archived 01.
  assert.equal(hex(lastCommand(sim, VPKT.RTS)), '00 06 53 45 4E 44 4D 45 00 00 01 11 70 01 00 02 00 02 00 04 F0 0F 00 24 00 03 00 01 01');
  assert.equal(lastCommand(sim, VPKT.VAR_CNTS).length, 70000);
  const stored = sim.get('SENDME', TYPE.FLASH_APP);
  assert.equal(stored.archived, true);
  assert.deepEqual(stored.data, parseFile(file).entries[0].data);
  assert.deepEqual(progress.at(-1), [70000, 70000]);
  assert.ok(progress.length > 60, 'progress per raw packet');
  noViolations(sim);
});

test('sendApp: a 200 KB app whose last raw packet is 64 bytes gets the zero-length write', async () => {
  const size = 1018 * 200 + 53; // the last packet holds 59 data bytes, 64 on the wire
  const { sim, link } = await connect({}, TIMEOUTS);
  await link.sendApp(parseAppFile(appFile('BIGAPP', size)));
  assert.equal(sim.get('BIGAPP', TYPE.FLASH_APP).data.length, size);
  const out = written(sim);
  const zlp = out.findIndex(p => p.length === 0);
  assert.equal(out[zlp - 1].length, 64);
  assert.equal(out.filter(p => p.length === 0).length, 1);
  noViolations(sim);
});

test('sendApp: send() and sendFile() leave applications to sendApp()', async () => {
  const { sim, link } = await connect({}, TIMEOUTS);
  const before = sim.log.length;
  const file = parseFile(appFile('NOPE', 300));
  await assert.rejects(link.send(file.entries[0]), { code: 'UNSUPPORTED_TYPE', message: /sendApp/ });
  await assert.rejects(link.sendFile(file), { code: 'UNSUPPORTED_TYPE', message: /sendApp/ });
  assert.equal(sim.log.length, before, 'nothing reached the calculator');
});

test('sendApp: anything but an application is refused before anything is sent', async () => {
  const { sim, link } = await connect({}, TIMEOUTS);
  const before = sim.log.length;
  await assert.rejects(link.sendApp(parseFile(buildFile([makeEntry({ name: 'V', type: TYPE.APPVAR, body: Uint8Array.of(1) })]))), { code: 'BAD_ENTRY' });
  await assert.rejects(link.sendApp(appFile('RAW', 300)), { code: 'BAD_ENTRY' }, 'a file\'s bytes, not yet parsed');
  assert.equal(sim.log.length, before);
});

test('sendApp: the calculator\'s own refusals come back as CALC_ERROR, the link left open', async () => {
  const cases = [
    [{ lowBattery: true }, appImage('BAT', 500), SIM_ERR.BATTERY_LOW, 'rts', /battery low/],
    [{ archiveFree: 400 }, appImage('FULL', 500), SIM_ERR.NO_MEMORY, 'rts', /out of memory/],
    [{}, appImage('BADSIG', 500, { first: 0x80 }), SIM_ERR.BAD_SIGNATURE, 'contents', /signature does not match/],
    [{}, appImage('NONAME', 500, { withName: false }), SIM_ERR.BAD_SIGNATURE, 'contents', /signature does not match/],
  ];
  for (const [simOptions, data, calcError, step, text] of cases) {
    const { sim, link } = await connect(simOptions, TIMEOUTS);
    await assert.rejects(link.sendApp(unchecked(data)), err => {
      assert.deepEqual([err.code, err.calcError, err.op, err.step], ['CALC_ERROR', calcError, 'sendApp', step]);
      assert.match(err.message, text);
      return true;
    });
    assert.equal(link.opened, true);
    assert.deepEqual(await link.listApps(), []);
    noViolations(sim);
  }
});

test('simulator: an application\'s Request to Send carries exactly the type and archived attributes', async () => {
  const host = await rawHost();
  await host.ready();
  const rts = bytes(0x00, 3, utf8('ABC'), 0x00, be32(300), 0x01, be16(3),
    be16(2), be16(4), be32(0xF00F0024), be16(3), be16(1), 0x01, be16(8), be16(4), be32(0));
  assert.match(hex(await host.command(VPKT.RTS, rts)), /EE 00 7F 03$/);
  assert.match(host.sim.violations[0], /exactly 0002=f00f0024 then 0003=01; it carried 0002=f00f0024 0003=01 0008=00000000/);
});

test('an installed application lists, reads back and deletes', async () => {
  const data = appImage('GOTIT', 9000);
  const { sim, link } = await connect({ vars: [
    { name: 'GOTIT', type: TYPE.FLASH_APP, data, archived: true },
    { name: 'PROG', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) },
  ] }, TIMEOUTS);
  assert.deepEqual((await link.listApps()).map(a => [a.name, a.type]), [['GOTIT', 0x24]]);
  const got = await link.receive('GOTIT', TYPE.FLASH_APP);
  assert.deepEqual(got.data, data);
  assert.equal(got.archived, true);
  assert.equal(got.app.hardwareId, 0x13, 'the CE family\'s product number, as libticalcs gives it');
  // Asks for archived and version; the type as 0x0011 with owner 0x0F.
  assert.equal(hex(lastCommand(sim, VPKT.VAR_REQ)), '00 05 47 4F 54 49 54 00 01 FF FF FF FF 00 02 00 03 00 08 00 01 00 11 00 04 F0 0F 00 24 00 00');
  const back = parseAppFile(buildAppFile(got));
  assert.equal(back.sections[0].hardwareId, 0x13);
  assert.deepEqual(back.entries[0].data, data);
  await link.deleteApp('GOTIT');
  assert.match(hex(lastCommand(sim, VPKT.MODIF_VAR)), /00 11 00 04 F0 0B 00 24 01 00 00 00 00$/);
  assert.deepEqual(await link.listApps(), []);
  noViolations(sim);
});

test('simulator: an application is requested with owner 0x0F', async () => {
  const host = await rawHost({ vars: [{ name: 'APP', type: TYPE.FLASH_APP, data: appImage('APP', 300), archived: true }] });
  await host.ready();
  const request = bytes(0x00, 3, utf8('APP'), 0x00, [0x01, 0xFF, 0xFF, 0xFF, 0xFF], be16(0), be16(1), be16(0x11), be16(4), [0xF0, 0x07, 0x00, 0x24], [0, 0]);
  assert.match(hex(await host.command(VPKT.VAR_REQ, request)), /EE 00 7F 04$/);
  assert.match(host.sim.violations[0], /F0 0F 00 24/);
});
