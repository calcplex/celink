// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The games-page engine: C libraries, multi-file games, zips, the space
// check and the jailbreak check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import {
  sendGame, collectEntries, planInstall, checkSpace, library, unpackZip, crc32, gameEntries,
  jailbreakTools, jailbreakState, inspect, identify, fixSizeWord, pickCalculator,
} from '../gamesend.mjs';
import { refusedAt } from '../core.mjs';
import { CELink, VPKT } from '../../celink.mjs';
import { buildFile, makeEntry, TYPE } from '../../tifiles.mjs';
import { SimulatedCalculator } from '../../sim/calculator.mjs';
import { OS, received } from '../../test/testkit.mjs';

const SNAKE = new Uint8Array(readFileSync(new URL('../../fixtures/SnakeCE.8xg', import.meta.url)));

async function open({ os = 'v21', vars = [], ...simOptions } = {}) {
  const sim = new SimulatedCalculator({ os: OS[os], vars, ...simOptions });
  const link = CELink.fromDevice(sim, { timeout: 500, streamTimeout: 4000 });
  await link.open();
  return { sim, link };
}
const offered = sim => received(sim, VPKT.RTS);
const requested = sim => received(sim, VPKT.VAR_REQ); // a read-back
const deleted = sim => received(sim, VPKT.MODIF_VAR);
const sendOrder = sim => sim.commands.filter(c => c.type === VPKT.RTS).map(c => new TextDecoder().decode(c.data.subarray(2, 2 + c.data[1])));
const onCalc = ({ name, type, data, archived, version }) => ({ name, type, data, archived, version });
const entry = (bytes, name) => gameEntries(bytes).find(e => e.name === name);
const appvar = (name, n) => makeEntry({ name, type: TYPE.APPVAR, body: new Uint8Array(n) });
const program = (name, n) => makeEntry({ name, type: TYPE.PROTECTED_PROGRAM, body: new Uint8Array(n) });

// C games shaped as the CE toolchain packs them: LibLoad and four libraries as
// archived AppVars, then an assembly program. Only the bytes gamesend.mjs
// reads are real; the rest is filler.
const LIBRARIES = [['LibLoad', 41, 1500], ['GRAPHX', 14, 5000], ['FONTLIBC', 2, 1500], ['KEYPADC', 2, 200], ['FILEIOC', 8, 1200]];
/** `size` bytes that start with `head`. */
const filled = (size, head) => {
  const b = new Uint8Array(size).fill(0x5A);
  b.set(head);
  return b;
};
const libraryEntry = ([name, version, size]) => makeEntry({
  name, type: TYPE.APPVAR, archived: true, body: filled(size, [...(name === 'LibLoad' ? [0xBF, 0xFE] : [0xC0, 0xC1]), version]),
});
const cProgram = (name, size, archived = false) => makeEntry({ name, type: TYPE.PROTECTED_PROGRAM, archived, body: filled(size, [0xEF, 0x7B]) });
const cGame = (name, size, archived) => buildFile([...LIBRARIES.map(libraryEntry), cProgram(name, size, archived)]);
const PUZZLE = cGame('PUZZLE', 30000);
const PUZZLE_ORDER = ['LibLoad', 'GRAPHX', 'FONTLIBC', 'KEYPADC', 'FILEIOC', 'PUZZLE'];
// Archived, so it takes no RAM to store, but 20 KB to run.
const RACER = cGame('RACER', 20000, true);

/** A library with another version byte, and one byte longer unless `grow` is false. */
function libVersion(e, version, { grow = true } = {}) {
  const body = [...e.data.subarray(2)];
  body[2] = version;
  if (grow) body.push(0);
  return { name: e.name, type: e.type, archived: true, version: 0, data: Uint8Array.from([body.length & 0xFF, body.length >> 8, ...body]) };
}

/** Make `link.send` fail for the variable called `name`. */
function failSendOf(link, name) {
  const send = link.send.bind(link);
  link.send = (e, options) => (e.name === name ? Promise.reject(Object.assign(new Error('cable pulled'), { code: 'BOOM' })) : send(e, options));
}

test('library(): the version byte of every C library, and nothing else', () => {
  const versions = Object.fromEntries(gameEntries(PUZZLE).filter(library).map(e => [e.name, library(e).version]));
  assert.deepEqual(versions, { LibLoad: 41, GRAPHX: 14, FONTLIBC: 2, KEYPADC: 2, FILEIOC: 8 });
  assert.equal(library(entry(PUZZLE, 'LibLoad')).loader, true);
  assert.equal(library(entry(PUZZLE, 'GRAPHX')).loader, false);
  assert.equal(library(entry(PUZZLE, 'PUZZLE')), null);
  assert.equal(library(appvar('SAVE', 3)), null);
});

test('fixSizeWord(): pads a variable to the size it declares, and only then', () => {
  const short = { name: 'LEVELS', type: TYPE.APPVAR, data: Uint8Array.of(3, 0, 7, 8) };
  assert.deepEqual(fixSizeWord(short).data, Uint8Array.of(3, 0, 7, 8, 0));
  const long = { ...short, data: Uint8Array.of(1, 0, 7, 8) };
  assert.equal(fixSizeWord(long), long);
  const real = { name: 'A', type: TYPE.REAL, data: Uint8Array.of(9, 0) };
  assert.equal(fixSizeWord(real), real);
});

test('collectEntries(): LibLoad, then libraries, then data, then the program', async () => {
  const files = [
    ['game/RACER.8xp', buildFile([cProgram('RACER', 100)])],
    ['game/levels.8xg', buildFile([appvar('LEVELS', 50), appvar('TILES', 50)])],
    ['game/libs.8xg', buildFile([...LIBRARIES].reverse().map(libraryEntry))],
  ];
  const names = collectEntries(await unpackZip(zip(files))).map(e => e.name);
  assert.deepEqual(names, ['LibLoad', 'FILEIOC', 'KEYPADC', 'FONTLIBC', 'GRAPHX', 'LEVELS', 'TILES', 'RACER']);
});

test('collectEntries(): a library in two files is sent once, the newer copy', () => {
  const newer = buildFile([libVersion(entry(PUZZLE, 'GRAPHX'), 15)]);
  const out = collectEntries([PUZZLE, newer, PUZZLE]);
  assert.deepEqual(out.filter(e => e.name === 'GRAPHX').map(e => library(e).version), [15]);
  assert.equal(out.length, gameEntries(PUZZLE).length);
});

test('collectEntries(): two different variables under one name is a broken package', () => {
  const a = buildFile([makeEntry({ name: 'LEVELS', type: TYPE.APPVAR, body: Uint8Array.of(1) })]);
  const b = buildFile([makeEntry({ name: 'LEVELS', type: TYPE.APPVAR, body: Uint8Array.of(2) })]);
  assert.throws(() => collectEntries([a, b]), err => err.code === 'BAD_FILE' && /LEVELS/.test(err.message));
  assert.equal(collectEntries([a, a]).length, 1);
});

test('planInstall(): everything under a game file\'s name is replaced, libraries included', () => {
  const todo = collectEntries([PUZZLE]);
  const row = (name, type, size, archived = true) => ({ name, type, size, archived });
  const plan = planInstall(todo, { rows: [
    row('GRAPHX', TYPE.APPVAR, entry(PUZZLE, 'GRAPHX').data.length),
    row('FONTLIBC', TYPE.APPVAR, 9999),
    row('KEYPADC', TYPE.PROGRAM, 50, false),
    row('PUZZLE', TYPE.REAL, 9, false),
  ] });
  const reasons = Object.fromEntries(plan.steps.map(s => [s.entry.name, s.reason]));
  assert.deepEqual(reasons, { LibLoad: 'new', GRAPHX: 'replace', FONTLIBC: 'replace', KEYPADC: 'replace', FILEIOC: 'new', PUZZLE: 'new' });
});

test('checkSpace(): archive and RAM are counted before anything moves', () => {
  const todo = collectEntries([PUZZLE]);
  const libs = todo.filter(library).reduce((n, e) => n + e.data.length, 0);
  const plan = (options, rows = []) => planInstall(todo, { rows, ...options });
  assert.throws(() => checkSpace(plan({ archiveFree: libs - 1000, ramFree: 150000 })), err => err.code === 'NO_ARCHIVE_SPACE' && err.needKB > 0);
  assert.throws(() => checkSpace(plan({ archiveFree: 3e6, ramFree: 20000 })), { code: 'NO_RAM_SPACE' });
  checkSpace(plan({ archiveFree: 3e6, ramFree: 150000 }));
  checkSpace(plan({})); // unknown free space is not a refusal
  // The old RAM copy of the game is deleted first, which makes room for the new one.
  const game = todo.at(-1);
  const oldCopy = [{ name: game.name, type: game.type, size: game.data.length, archived: false }];
  checkSpace(plan({ archiveFree: 3e6, ramFree: 1000 }, oldCopy));
  assert.throws(() => checkSpace(plan({ archiveFree: 3e6, ramFree: 1000 })), { code: 'NO_RAM_SPACE' });
});

test('checkSpace(): RAM is a running balance, so a later delete cannot pay for an earlier send', () => {
  // 5 KB free. The new 12 KB LEVELS goes first; the 8 KB GAME it could use is deleted after.
  const todo = collectEntries([buildFile([appvar('LEVELS', 12000), program('GAME', 500)])]);
  const rows = [
    { name: 'LEVELS', type: TYPE.APPVAR, size: 3002, archived: false },
    { name: 'GAME', type: TYPE.PROTECTED_PROGRAM, size: 8002, archived: false },
  ];
  assert.throws(() => checkSpace(planInstall(todo, { rows, ramFree: 5000, archiveFree: 3e6 })), err => err.code === 'NO_RAM_SPACE' && err.needKB >= 4);
});

test('a fresh calculator: libraries first, program last, every variable read back', async () => {
  const { sim, link } = await open();
  const progress = [], steps = [];
  const r = await sendGame(link, [PUZZLE], { onProgress: (done, total) => progress.push([done, total]), onStep: step => steps.push(step) });
  assert.deepEqual(sendOrder(sim), PUZZLE_ORDER);
  assert.deepEqual(r.sent, PUZZLE_ORDER);
  assert.deepEqual(r.replaced, []);
  for (const e of gameEntries(PUZZLE)) {
    const v = sim.get(e.name, e.type);
    assert.deepEqual(v.data, e.data, e.name);
    assert.equal(v.archived, e.archived, `${e.name} is stored where its file says`);
  }
  assert.equal(requested(sim), 6);
  assert.deepEqual(progress.at(-1), [r.bytes, r.bytes]);
  assert.ok(steps.includes('send') && steps.includes('verify'));
  assert.deepEqual(sim.violations, []);
});

test('observed on hardware: every exchange of a connect and a Send follows its own ready()', async () => {
  const { sim, link } = await open({ vars: [{ name: 'PUZZLE', type: TYPE.PROTECTED_PROGRAM, data: Uint8Array.of(0, 0) }] });
  const exchanges = () => [VPKT.PARAM_REQ, VPKT.DIR_REQ, VPKT.RTS, VPKT.VAR_REQ, VPKT.MODIF_VAR].reduce((n, type) => n + received(sim, type), 0);
  const pings = () => received(sim, VPKT.PING);
  assert.equal(pings(), 0, 'open() sends nothing');
  await inspect(link);
  assert.equal(pings(), exchanges());
  await sendGame(link, [PUZZLE]);
  assert.equal(deleted(sim), 1);
  assert.equal(pings(), exchanges());
  assert.deepEqual(sim.violations, []);
});

test('a second game sends its libraries again, over the first game\'s', async () => {
  const { sim, link } = await open();
  await sendGame(link, [PUZZLE]);
  const r = await sendGame(link, [RACER]);
  assert.deepEqual(r.sent, ['LibLoad', 'GRAPHX', 'FONTLIBC', 'KEYPADC', 'FILEIOC', 'RACER']);
  assert.deepEqual(r.replaced, ['LibLoad', 'GRAPHX', 'FONTLIBC', 'KEYPADC', 'FILEIOC']);
  assert.ok(sim.get('PUZZLE', TYPE.PROTECTED_PROGRAM));
});

test('a newer library on the calculator is overwritten with the game\'s own copy', async () => {
  const graphx = entry(PUZZLE, 'GRAPHX');
  const { sim, link } = await open({ vars: [libVersion(graphx, 15)] });
  const r = await sendGame(link, [PUZZLE]);
  assert.ok(r.replaced.includes('GRAPHX'));
  assert.deepEqual(sim.get('GRAPHX', TYPE.APPVAR).data, graphx.data);
  assert.equal(requested(sim), 6, 'the only reads are the six read-backs');
});

test('no archive space: refused with nothing deleted or sent', async () => {
  const { sim, link } = await open({ vars: [onCalc(entry(PUZZLE, 'PUZZLE'))], archiveFree: 5000 });
  await assert.rejects(sendGame(link, [PUZZLE]), err => err.code === 'NO_ARCHIVE_SPACE' && /KB of archive/.test(err.message));
  assert.equal(offered(sim) + deleted(sim), 0);
});

test('little RAM left to run the game: sent, with a warning', async () => {
  const { link } = await open({ ramFree: 15000 });
  const r = await sendGame(link, [RACER]);
  assert.ok(r.sent.includes('RACER'));
  assert.equal(r.warnings[0].code, 'LOW_RAM_TO_RUN');
});

test('archive: all puts every variable in archive, so a RAM-starved calculator takes the game', async () => {
  const { sim, link } = await open({ ramFree: 15000 });
  await assert.rejects(sendGame(link, [PUZZLE]), { code: 'NO_RAM_SPACE' });
  const r = await sendGame(link, [PUZZLE], { archive: 'all' });
  assert.equal(r.sent.length, 6);
  for (const e of gameEntries(PUZZLE)) assert.equal(sim.get(e.name, e.type).archived, true, e.name);
});

test('verify: size lists once instead of reading every variable back', async () => {
  const { sim, link } = await open();
  assert.equal((await sendGame(link, [PUZZLE], { verify: 'size' })).sent.length, 6);
  assert.equal(requested(sim), 0);
});

test('a space refusal reads the calculator again first, since one read has come back as 0 bytes free', async () => {
  const { sim, link } = await open({ ramFree: 2e5 });
  const info = link.info.bind(link);
  let reads = 0;
  link.info = async () => {
    const i = await info();
    return ++reads === 1 ? { ...i, ramFree: 0 } : i;
  };
  const r = await sendGame(link, [PUZZLE]);
  assert.equal(r.sent.length, 6);
  assert.equal(r.rechecked, true);
  assert.equal(reads, 2);
  assert.deepEqual(sim.violations, []);
});

test('a calculator that really is full is refused after the second read', async () => {
  const { link } = await open({ ramFree: 15000 });
  const info = link.info.bind(link);
  let reads = 0;
  link.info = async () => { reads++; return info(); };
  await assert.rejects(sendGame(link, [PUZZLE]), { code: 'NO_RAM_SPACE' });
  assert.equal(reads, 2);
});

test('an assembly game on an OS no jailbreak covers is refused before anything is listed', async () => {
  const { sim, link } = await open({ os: 'unsupported' });
  await assert.rejects(sendGame(link, [PUZZLE]), { code: 'NO_JAILBREAK' });
  assert.equal(offered(sim), 0);
  assert.equal(received(sim, VPKT.DIR_REQ), 0);
});

test('a failure part way says what is already on the calculator', async () => {
  const { link } = await open();
  failSendOf(link, 'PUZZLE');
  await assert.rejects(sendGame(link, [PUZZLE]), err => err.code === 'BOOM' && err.partial.join() === 'LibLoad,GRAPHX,FONTLIBC,KEYPADC,FILEIOC');
});

test('a library deleted to make way and then lost is reported as removed', async () => {
  const { link } = await open({ vars: [libVersion(entry(PUZZLE, 'GRAPHX'), 11)] });
  failSendOf(link, 'GRAPHX');
  await assert.rejects(sendGame(link, [PUZZLE]), err => err.code === 'BOOM' && err.removed.join() === 'GRAPHX' && err.partial.join() === 'LibLoad');
});

test('a variable that fails its read-back is still listed in partial', async () => {
  const { link } = await open();
  const receive = link.receive.bind(link);
  link.receive = async (name, type) => {
    const v = await receive(name, type);
    if (name === 'GRAPHX') {
      v.data = v.data.slice();
      v.data[9] ^= 1;
    }
    return v;
  };
  await assert.rejects(sendGame(link, [PUZZLE]), err => err.code === 'READBACK' && err.partial.join() === 'LibLoad,GRAPHX' && err.removed.length === 0);
});

test('jailbreakTools(): only the checked names, programs and apps by type', () => {
  const row = (name, type, size) => ({ name, type, size });
  assert.deepEqual(jailbreakTools([row('A', TYPE.PROGRAM, 904), row('AsmHook2', TYPE.FLASH_APP)]), ['arTIfiCE', 'AsmHook2']);
  assert.deepEqual(jailbreakTools([row('A', TYPE.PROGRAM, 2)]), [], 'an empty prgmA is not arTIfiCE');
  assert.deepEqual(jailbreakTools([row('Cesium', TYPE.FLASH_APP), row('CESIUM', TYPE.PROTECTED_PROGRAM)]), ['Cesium', 'Cesium installer']);
  assert.deepEqual(jailbreakTools([row('A', TYPE.REAL), row('AsmHook2', TYPE.APPVAR), row('PUZZLE', TYPE.PROTECTED_PROGRAM)]), []);
});

test('jailbreakState(): none, found, missing or blocked', () => {
  assert.equal(jailbreakState('native', []), 'none');
  assert.equal(jailbreakState('v21', []), 'missing');
  assert.equal(jailbreakState('v3', ['AsmHook2']), 'found');
  assert.equal(jailbreakState('unsupported', ['Cesium']), 'blocked');
});

test('inspect(): an empty or look-alike prgmA is not arTIfiCE', async () => {
  // The release's A is not in this repository; a program of its size stands in.
  const lookAlike = makeEntry({ name: 'A', type: TYPE.PROGRAM, body: new Uint8Array(902) }).data;
  for (const data of [Uint8Array.of(0, 0), lookAlike]) {
    const { sim, link } = await open({ vars: [{ name: 'A', type: TYPE.PROGRAM, data, archived: false, version: 0 }] });
    const i = await inspect(link);
    assert.equal(i.route, 'v21');
    assert.deepEqual(i.tools, []);
    assert.equal(requested(sim), data === lookAlike ? 1 : 0, 'only a prgmA of the right size is read back');
    assert.equal(offered(sim), 0);
  }
});

function zip(files, { method = 8, corrupt = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = new TextEncoder().encode(path);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(corrupt ? (crc ^ 1) >>> 0 : crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

test('unpackZip(): stored and deflated, calculator files only, CRC-checked', async () => {
  const readme = Uint8Array.of(1, 2, 3);
  for (const method of [0, 8]) {
    const files = await unpackZip(zip([['SnakeCE.8xg', SNAKE], ['README.md', readme], ['__MACOSX/._SnakeCE.8xg', readme]], { method }));
    assert.deepEqual(files, [SNAKE]);
  }
});

test('unpackZip(): include picks files by path', async () => {
  const y = Uint8Array.of(4, 5, 6);
  assert.deepEqual(await unpackZip(zip([['a/X.8xp', SNAKE], ['b/Y.8xv', y]]), { include: ['b/Y.8xv'] }), [y]);
});

test('unpackZip(): anything damaged or missing is BAD_FILE, never a TypeError', async () => {
  const good = zip([['SnakeCE.8xg', SNAKE]]);
  const badDeflate = good.slice();
  for (const i of [40, 41, 45]) badDeflate[i] ^= 0xFF;
  const refused = [
    zip([['SnakeCE.8xg', SNAKE]], { corrupt: true }),
    zip([['README.md', Uint8Array.of(1)]]),
    Uint8Array.of(1, 2, 3),
    badDeflate,
    good.slice(0, good.length - 30),
  ];
  for (const bytes of refused) await assert.rejects(unpackZip(bytes), { code: 'BAD_FILE' });
  await assert.rejects(unpackZip(zip([['a/X.8xp', SNAKE]]), { include: ['a/Z.8xp'] }), /missing a\/Z\.8xp/);
});

test('pickCalculator reuses the one granted calculator and prompts otherwise', async () => {
  const sim = new SimulatedCalculator();
  let prompts = 0;
  const usb = granted => ({ getDevices: async () => granted, requestDevice: async () => { prompts++; return sim; } });
  assert.equal((await pickCalculator({ usb: usb([sim]) })).device, sim);
  assert.equal(prompts, 0);
  assert.equal((await pickCalculator({ usb: usb([]) })).device, sim);
  assert.equal(prompts, 1);
  await pickCalculator({ usb: usb([sim, new SimulatedCalculator()]) });
  assert.equal(prompts, 2);
});

test('a refused send says where: the Request to Send, or the ready step before an exchange', async () => {
  const rts = await open({ refuse: { step: 'rts', code: 0x0036 } });
  const atRts = await sendGame(rts.link, [SNAKE]).catch(e => e);
  assert.equal(atRts.code, 'CALC_ERROR');
  assert.deepEqual(refusedAt(atRts), { at: 'send_rts' });
  const mode = await open({ refuse: { step: 'mode', code: 0x0036, times: 1 } });
  const atMode = await sendGame(mode.link, [SNAKE]).catch(e => e);
  assert.equal(atMode.code, 'CALC_ERROR');
  assert.match(refusedAt(atMode).at, /^ready_mode_before_[a-z]+$/);
});

test('identify reports whether the calculator is on its home screen', async () => {
  const { link } = await open();
  await link.ready();
  assert.equal(typeof (await identify(link)).home, 'boolean');
});
