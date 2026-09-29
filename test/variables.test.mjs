// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VPKT, parseParams, infoFromParams } from '../celink.mjs';
import { makeEntry, buildFile, parseFile, TYPE } from '../tifiles.mjs';
import { SIM_ERR } from '../sim/calculator.mjs';
import { connect, noViolations, patterned, hex, fromHex, lastCommand, utf8 } from './testkit.mjs';

const hello = () => makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: Uint8Array.of(0xDE, 0x2A, 0x48, 0x49, 0x2A) });


test('info() asks for the parameters OS 5.3 and 5.8 were observed answering, and decodes them', async () => {
  const { sim, link } = await connect();
  const info = await link.info();
  assert.equal(hex(lastCommand(sim, VPKT.PARAM_REQ)),
    '00 15 00 01 00 02 00 04 00 06 00 07 00 08 00 09 00 0A 00 0B 00 48 00 49 00 0C 00 0D 00 0E 00 0F 00 10 00 11 00 1E 00 1F 00 2D 00 37');
  assert.deepEqual(
    [info.productName, info.productNumber, info.osVersion, info.bootVersion, info.hardwareVersion, info.ramFree, info.archiveFree],
    ['TI-84 Plus CE', 0x13, '5.8.5.0074', '5.0.0.0089', 7, 154000, 2372475]);
  assert.deepEqual([info.language, info.subLanguage, info.lcdWidth, info.lcdHeight, info.batteryOk, info.atHomescreen], [9, 1, 320, 240, true, true]);
  noViolations(sim);
});

test('info(): a parameter the calculator refuses is absent', async () => {
  const { link } = await connect({ invalidParams: [0x0037] });
  const info = await link.info();
  assert.equal('atHomescreen' in info, false);
  assert.equal(info.params.has(0x0037), false);
});

test('observed on hardware: the Parameter Data a 5.3 CE sent decodes', () => {
  // As a TI-84 Plus CE on OS 5.3.0.0037 answered libticalcs' own 26 parameters,
  // the 5-byte calculator id (0x0003) replaced by zeros; 0x005D and 0x0023 invalid.
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
  const { params, declared, truncated } = parseParams(observed);
  assert.deepEqual([declared, truncated, params.size], [26, false, 24]);
  assert.equal(params.has(0x005D), false);
  assert.equal(params.has(0x0023), false);
  const info = infoFromParams(params);
  assert.deepEqual(
    [info.productName, info.productNumber, info.osVersion, info.bootVersion, info.hardwareVersion, info.ramFree, info.archiveFree],
    ['TI-84 Plus CE', 0x13, '5.3.0.0037', '5.0.0.0089', 7, 0, 2372475]);
  assert.deepEqual([info.lcdWidth, info.lcdHeight, info.batteryOk, info.language], [320, 240, true, 9]);
  assert.equal('atHomescreen' in info, false, 'not asked for in that request');
});

test('Parameter Data: a cut-short reply keeps the parameters that arrived whole', () => {
  const two = fromHex('00 02 00 0E 00 00 08 00 00 00 00 00 00 10 00 00 11 00 00 08 00 00 00 00 00 24 33 7B');
  const whole = parseParams(two);
  assert.deepEqual([whole.declared, whole.truncated, [...whole.params.keys()]], [2, false, [0x000E, 0x0011]]);
  const cut = parseParams(two.subarray(0, 20));
  assert.deepEqual([cut.declared, cut.truncated, [...cut.params.keys()]], [2, true, [0x000E]]);
  assert.deepEqual(parseParams(new Uint8Array(1)), { params: new Map(), declared: 0, truncated: true });
});

test('info() takes a reply with fewer parameters than asked for, where libticalcs fails, and counts it', async () => {
  const { sim, link } = await connect();
  const short = fromHex('00 02 00 02 00 00 0D 54 49 2D 38 34 20 50 6C 75 73 20 43 45 00 0B 00 00 04 00 05 08 05');
  sim.intercept = type => type === VPKT.PARAM_REQ && (sim.queueVirtual(VPKT.PARAM_DATA, short), true);
  const seen = [];
  link.onAnomaly = (kind, detail) => seen.push([kind, detail]);
  const info = await link.info();
  assert.deepEqual([info.productName, info.osVersion], ['TI-84 Plus CE', '5.8.5']);
  assert.deepEqual(seen, [['shortParams', '2 of 21 parameters declared']]);
  assert.equal(link.anomalies.shortParams, 1);
  assert.equal(link.opened, true);
});

test('info() falls back to the USB product name when the calculator does not give its own', async () => {
  const { link } = await connect({ invalidParams: [0x0002], productName: 'TI-84 Plus CE' });
  const info = await link.info();
  assert.equal(info.params.has(0x0002), false);
  assert.equal(info.productName, 'TI-84 Plus CE');
  assert.equal(link.anomalies.shortParams, 0);
});

test('a parameter is used only at the size libticalcs expects', () => {
  const params = new Map([
    [0x000B, fromHex('00 05 08 05')], [0x0048, fromHex('4A')],  // a 1-byte build is ignored
    [0x0009, fromHex('00 05')],                                  // a 2-byte version is ignored
    [0x000E, fromHex('00 00 10 00')],                            // free RAM is 8 bytes
    [0x0001, fromHex('00 00 00 13')], [0x002D, fromHex('00 01')],
  ]);
  const info = infoFromParams(params);
  assert.equal(info.osVersion, '5.8.5');
  assert.equal(info.productNumber, 0x13);
  for (const absent of ['bootVersion', 'ramFree', 'batteryOk']) assert.equal(absent in info, false, absent);
});


test('observed on hardware: list() requests size, type and archived', async () => {
  const { sim, link } = await connect();
  await link.list();
  assert.equal(hex(lastCommand(sim, VPKT.DIR_REQ)), '00 00 00 03 00 01 00 02 00 03 00 01 00 01 00 01 01');
});

test('list() reads every variable\'s name, type, size and archived flag', async () => {
  const { sim, link } = await connect({
    vars: [
      { name: 'HELLO', type: TYPE.PROGRAM, data: Uint8Array.of(2, 0, 0xDE, 0x2A) },
      { name: 'SAVE', type: TYPE.APPVAR, data: new Uint8Array(1200), archived: true },
      { name: 'L₁', type: TYPE.LIST, data: Uint8Array.of(0, 0) },
      { name: 'AθB', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) },
    ],
  });
  assert.deepEqual(await link.list(), [
    { name: 'HELLO', type: 5, typeName: 'program', size: 4, archived: false },
    { name: 'SAVE', type: 0x15, typeName: 'app variable', size: 1200, archived: true },
    { name: 'L₁', type: 1, typeName: 'list', size: 2, archived: false },
    { name: 'AθB', type: 5, typeName: 'program', size: 2, archived: false },
  ]);
  noViolations(sim);
});

test('list() skips a data acknowledgement among the Variable Headers, where libticalcs fails, and counts it', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'A', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) }] });
  sim.intercept = type => { if (type === VPKT.DIR_REQ) sim.queueVirtual(VPKT.DATA_ACK, [0x01]); };
  assert.deepEqual((await link.list()).map(r => r.name), ['A']);
  assert.equal(link.anomalies.listingAck, 1);
  sim.intercept = type => { if (type === VPKT.DIR_REQ) sim.queueVirtual(VPKT.PING, []); };
  await link.ready();
  await assert.rejects(link.list(), { code: 'PROTOCOL', message: /Expected VAR_HDR or EOT or DATA_ACK .* got PING/ });
});


test('observed on hardware: send() writes the Request to Send, the contents, then an empty End of Transmission', async () => {
  const { sim, link } = await connect();
  const progress = [];
  assert.deepEqual(await link.send(hello(), { onProgress: (sent, total) => progress.push([sent, total]) }), { name: 'HELLO', bytes: 7, rebooted: false });
  assert.deepEqual(sim.commands.map(c => c.type), [VPKT.PING, VPKT.RTS, VPKT.VAR_CNTS, VPKT.EOT]);
  // No folder, the name and its NUL, size 7, silent; then type (F0 0F 00 05), archived 0, version 0.
  assert.equal(hex(lastCommand(sim, VPKT.RTS)), '00 05 48 45 4C 4C 4F 00 00 00 00 07 01 00 03 00 02 00 04 F0 0F 00 05 00 03 00 01 00 00 08 00 04 00 00 00 00');
  assert.deepEqual(lastCommand(sim, VPKT.VAR_CNTS), hello().data, 'the contents carry the size word');
  assert.equal(lastCommand(sim, VPKT.EOT).length, 0);
  assert.deepEqual(progress, [[0, 7], [7, 7]]);
  assert.deepEqual(sim.get('HELLO', TYPE.PROGRAM).data, hello().data);
  noViolations(sim);
});

test('observed on hardware: archive puts a variable in the archive', async () => {
  const { sim, link } = await connect();
  await link.send(makeEntry({ name: 'ARCH', type: TYPE.APPVAR, body: patterned(8) }), { archive: true });
  assert.equal(sim.get('ARCH', TYPE.APPVAR).archived, true);
  assert.equal(hex(lastCommand(sim, VPKT.RTS).subarray(-13, -8)), '00 03 00 01 01');
  noViolations(sim);
});

test('observed on hardware: a big variable streams in full packets, with progress for each', async () => {
  const { sim, link } = await connect();
  const e = makeEntry({ name: 'BIGDATA', type: TYPE.APPVAR, body: patterned(60000, 7) });
  const progress = [];
  await link.send(e, { onProgress: sent => progress.push(sent) });
  assert.deepEqual(sim.get('BIGDATA', TYPE.APPVAR).data, e.data);
  assert.ok(progress.length >= Math.ceil(60002 / 1018));
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.equal(progress.at(-1), 60002);
  noViolations(sim);
});

test('send() puts a variable where its entry says unless told otherwise', async () => {
  const { sim, link } = await connect();
  await link.send(makeEntry({ name: 'ARCH', type: TYPE.APPVAR, body: patterned(8), archived: true }));
  await link.send(makeEntry({ name: 'RAM', type: TYPE.APPVAR, body: patterned(8), archived: true }), { archive: false });
  assert.equal(sim.get('ARCH', TYPE.APPVAR).archived, true);
  assert.equal(sim.get('RAM', TYPE.APPVAR).archived, false);
  noViolations(sim);
});

test('observed on hardware: the version goes in the Request to Send and comes back from receive()', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'Pic2', type: TYPE.PICTURE, data: patterned(30), version: 12 }] });
  await link.send(makeEntry({ name: 'Pic1', type: TYPE.PICTURE, data: patterned(40), version: 10 }));
  assert.match(hex(lastCommand(sim, VPKT.RTS)), /00 08 00 04 00 00 00 0A$/);
  assert.equal(sim.get('Pic1', TYPE.PICTURE).version, 10);
  const back = await link.receive('Pic2', TYPE.PICTURE);
  assert.equal(back.version, 12);
  assert.equal(buildFile([back])[55 + 13], 12, 'and the file keeps it');
  noViolations(sim);
});

test('observed on hardware: a send replaces a variable of the same name without asking', async () => {
  const { sim, link } = await connect();
  await link.send(makeEntry({ name: 'OVER', type: TYPE.PROGRAM, body: patterned(50, 1) }));
  const second = makeEntry({ name: 'OVER', type: TYPE.PROGRAM, body: patterned(80, 2) });
  await link.send(second);
  assert.deepEqual(sim.get('OVER', TYPE.PROGRAM).data, second.data);
  assert.equal(sim.ramFree, 154000 - second.data.length - 9, 'the old copy was freed');
  await link.delete('OVER', TYPE.PROGRAM);
  await link.send(second);
  assert.deepEqual(sim.get('OVER', TYPE.PROGRAM).data, second.data, 'and it sends again after a delete');
  noViolations(sim);
});

test('send() waits 50 ms after each variable, as libticalcs does', async () => {
  const { sim, link } = await connect();
  const file = buildFile([1, 2, 3].map(n => makeEntry({ name: `G${n}`, type: TYPE.APPVAR, body: patterned(200 * n, n) })));
  await link.sendFile(parseFile(file));
  await link.info();
  noViolations(sim); // the simulator flags a command sooner than 50 ms after a variable
});

test('send() refuses a Flash application or an entry without data before anything is sent', async () => {
  const { sim, link } = await connect();
  const before = sim.log.length;
  await assert.rejects(link.send({ name: 'APP', type: TYPE.FLASH_APP, data: new Uint8Array(10) }), { code: 'UNSUPPORTED_TYPE' });
  await assert.rejects(link.send({ name: 'X', type: TYPE.PROGRAM }), { code: 'BAD_ENTRY' });
  assert.equal(sim.log.length, before);
  assert.equal(link.opened, true);
});

test('sendFile() sends a group\'s variables in order and stops at the first refusal', async () => {
  const { sim, link } = await connect();
  const group = [
    makeEntry({ name: 'GAME', type: TYPE.PROGRAM, body: utf8('main') }),
    makeEntry({ name: 'GAMEDAT', type: TYPE.APPVAR, body: patterned(2500) }),
    makeEntry({ name: 'GAMELVL', type: TYPE.APPVAR, body: patterned(900, 3) }),
  ];
  const seen = [];
  const results = await link.sendFile(parseFile(buildFile(group)), { onProgress: (sent, total, i) => seen.push(i) });
  assert.deepEqual(results.map(r => r.name), ['GAME', 'GAMEDAT', 'GAMELVL']);
  for (const e of parseFile(buildFile(group)).entries) assert.deepEqual(sim.get(e.name, e.type).data, e.data);
  assert.deepEqual([...new Set(seen)], [0, 1, 2]);
  const broken = [group[0], makeEntry({ name: 'bad', type: TYPE.PROGRAM, body: utf8('x') }), makeEntry({ name: 'LAST', type: TYPE.PROGRAM, body: utf8('x') })];
  await assert.rejects(link.sendFile(parseFile(buildFile(broken))), { code: 'CALC_ERROR', calcError: SIM_ERR.BAD_NAME });
  assert.equal(sim.get('LAST', TYPE.PROGRAM), undefined);
  noViolations(sim);
});


test('observed on hardware: receive() requests archived, version and size, with the type as 0x0011', async () => {
  const { sim, link } = await connect();
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: patterned(4000, 9) });
  await link.send(e);
  const got = await link.receive('HELLO', TYPE.PROGRAM);
  assert.equal(hex(lastCommand(sim, VPKT.VAR_REQ)), '00 05 48 45 4C 4C 4F 00 01 FF FF FF FF 00 03 00 03 00 08 00 01 00 01 00 11 00 04 F0 07 00 05 00 00');
  assert.deepEqual([got.name, got.type, got.typeName, got.archived, got.version], ['HELLO', 5, 'program', false, 0]);
  assert.deepEqual(got.nameBytes, e.nameBytes);
  assert.deepEqual(got.data, e.data);
  assert.deepEqual(parseFile(buildFile([got])).entries[0].data, e.data);
  noViolations(sim);
});

test('receive() trims contents longer than the declared size', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'PAD', type: TYPE.APPVAR, data: patterned(100) }] });
  sim.padContents = 7;
  assert.deepEqual((await link.receive('PAD', TYPE.APPVAR)).data, patterned(100));
});

test('receive() refuses contents shorter than the declared size', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'PAD', type: TYPE.APPVAR, data: patterned(100) }] });
  sim.overstateSize = 5;
  await assert.rejects(link.receive('PAD', TYPE.APPVAR), { code: 'PROTOCOL', message: /declared 105 bytes but sent 100/ });
});

test('observed on hardware: delete() sends Modify Variable with no destination', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'OLD', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) }] });
  assert.equal(await link.delete('OLD', TYPE.PROGRAM), undefined);
  assert.equal(sim.get('OLD', TYPE.PROGRAM), undefined);
  // Type F0 0B 00 05, ignore protection, no destination folder, name or attributes.
  assert.equal(hex(lastCommand(sim, VPKT.MODIF_VAR)), '00 03 4F 4C 44 00 00 01 00 11 00 04 F0 0B 00 05 01 00 00 00 00');
  await assert.rejects(link.delete('OLD', TYPE.PROGRAM), { code: 'CALC_ERROR', calcError: SIM_ERR.NOT_FOUND, op: 'delete' });
  noViolations(sim);
});

test('names must be names: an empty one, or a type that is not a number, fails before anything is sent', async () => {
  const { sim, link } = await connect();
  const before = sim.log.length;
  await assert.rejects(link.receive('', TYPE.PROGRAM), { code: 'BAD_NAME' });
  await assert.rejects(link.delete('A'), { code: 'BAD_ENTRY' });
  assert.equal(sim.log.length, before);
});


test('observed on hardware: L1 goes on the wire as L₁, typed either way or from a file', async () => {
  const list = Uint8Array.of(1, 0, 0, 0x80, 0x10, 0, 0, 0, 0, 0, 0);
  const { sim, link } = await connect({ vars: [{ name: 'L₁', type: TYPE.LIST, data: list }] });
  const got = await link.receive('L1', TYPE.LIST);
  assert.equal(hex(lastCommand(sim, VPKT.VAR_REQ).subarray(0, 7)), '00 04 4C E2 82 81 00');
  assert.deepEqual([got.name, hex(got.nameBytes.subarray(0, 2))], ['L₁', '5D 00']);
  await link.sendFile(parseFile(buildFile([makeEntry({ name: 'L2', type: TYPE.LIST, data: list })])));
  assert.equal(hex(lastCommand(sim, VPKT.RTS).subarray(0, 7)), '00 04 4C E2 82 82 00');
  await link.delete('L₂', TYPE.LIST);
  assert.equal(sim.get('L₂', TYPE.LIST), undefined);
  noViolations(sim);
});

test('a named list goes without its ⌊, and θ as θ', async () => {
  const { sim, link } = await connect({
    vars: [{ name: 'SCORE', type: TYPE.LIST, data: Uint8Array.of(0, 0) }, { name: 'AθB', type: TYPE.PROGRAM, data: Uint8Array.of(1, 0, 0x41) }],
  });
  await link.receive('⌊SCORE', TYPE.LIST);
  assert.equal(hex(lastCommand(sim, VPKT.VAR_REQ).subarray(0, 8)), '00 05 53 43 4F 52 45 00');
  await link.delete('SCORE', TYPE.LIST);
  assert.equal(sim.get('SCORE', TYPE.LIST), undefined);
  assert.equal((await link.receive('AθB', TYPE.PROGRAM)).nameBytes[1], 0x5B);
  noViolations(sim);
});

test('a list() row\'s name receives and deletes that variable', async () => {
  const { sim, link } = await connect({
    vars: [
      { name: 'ARCH', type: TYPE.APPVAR, data: patterned(2000), archived: true },
      { name: 'abc', type: TYPE.APPVAR, data: Uint8Array.of(1, 0, 7) },
      { name: 'L₃', type: TYPE.LIST, data: Uint8Array.of(0, 0) },
    ],
  });
  for (const row of await link.list()) {
    const got = await link.receive(row.name, row.type);
    assert.deepEqual(got.data, sim.get(row.name, row.type).data, row.name);
    assert.equal(got.archived, row.archived);
    await link.delete(row.name, row.type);
  }
  assert.deepEqual(await link.list(), []);
  noViolations(sim);
});
