// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The installer's Send Snake button: sendGame with one file, against the simulated CE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sendGame, gameEntries, isAssembly } from '../gamesend.mjs';
import { CELink, VPKT } from '../../celink.mjs';
import { buildAppFile, parseFile, TYPE } from '../../tifiles.mjs';
import { SimulatedCalculator } from '../../sim/calculator.mjs';
import { OS, received } from '../../test/testkit.mjs';

const read = name => new Uint8Array(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
const SNAKE = read('SnakeCE.8xg');
const BASIC = read('probe.8xp');
const APP = buildAppFile({ type: TYPE.FLASH_APP, name: 'APP', data: Uint8Array.of(0x81, 0x0F, 0, 0, 0, 0) }, { hardwareId: 0x13 });
const snake = gameEntries(SNAKE)[0];
const offered = sim => received(sim, VPKT.RTS);
const deleted = sim => received(sim, VPKT.MODIF_VAR);

async function open({ os = 'native', vars = [] } = {}) {
  const sim = new SimulatedCalculator({ os: OS[os], vars });
  const link = CELink.fromDevice(sim, { timeout: 500, streamTimeout: 2000 });
  await link.open();
  return { sim, link };
}

function stored(bytes, patch = d => d) {
  const { name, type, data, archived, version } = parseFile(bytes).entries[0];
  return { name, type, data: patch(data.slice()), archived, version };
}

test('Snake is the pinned build: one assembly program named SNAKE, no libraries', () => {
  assert.equal(createHash('sha256').update(SNAKE).digest('hex'), '72daeecd410e2eca8b9e6a0d7fa4f2f4ebc725b2c2c52cbc3c69088ee6405ea4');
  assert.equal(gameEntries(SNAKE).length, 1);
  assert.equal(snake.name, 'SNAKE');
  assert.equal(snake.type, TYPE.PROTECTED_PROGRAM);
  assert.ok(isAssembly(snake));
  assert.ok(!isAssembly(gameEntries(BASIC)[0]));
});

test('a Flash app never goes through a game button', () => {
  assert.throws(() => gameEntries(APP), { code: 'BAD_FILE' });
});

for (const os of ['early', 'native', 'v21', 'v3']) {
  test(`Snake goes to an empty ${os} calculator and reads back`, async () => {
    const { sim, link } = await open({ os });
    const seen = [];
    const r = await sendGame(link, [SNAKE], { onProgress: (done, total) => seen.push([done, total]) });
    assert.deepEqual(r.sent, ['SNAKE']);
    assert.deepEqual(r.replaced, []);
    assert.equal(r.route, os === 'early' ? 'native' : os);
    assert.equal(r.asm, true);
    assert.deepEqual(sim.get('SNAKE', TYPE.PROTECTED_PROGRAM).data, snake.data);
    assert.deepEqual(seen.at(-1), [snake.data.length, snake.data.length]);
    assert.ok(!sim.get('SNAKECE', TYPE.PROTECTED_PROGRAM), 'the name inside the file, not the file name');
    assert.deepEqual(sim.violations, []);
  });
}

test('an OS no jailbreak covers gets no assembly game, and nothing is sent', async () => {
  const { sim, link } = await open({ os: 'unsupported' });
  await assert.rejects(sendGame(link, [SNAKE]), err => err.code === 'NO_JAILBREAK' && /5\.8\.6/.test(err.message));
  assert.equal(offered(sim), 0);
});

test('TI-Basic still goes to an OS no jailbreak covers', async () => {
  const { sim, link } = await open({ os: 'unsupported' });
  const r = await sendGame(link, [BASIC]);
  assert.equal(r.asm, false);
  assert.deepEqual(r.sent, ['LINKTEST']);
  assert.equal(offered(sim), 1);
});

test('the same Snake already there is sent again, as a replacement', async () => {
  const { sim, link } = await open({ vars: [stored(SNAKE)] });
  const r = await sendGame(link, [SNAKE]);
  assert.deepEqual(r.replaced, ['SNAKE']);
  assert.equal(offered(sim), 1);
});

test('a different SNAKE of any named type is replaced without asking', async () => {
  const flipped = stored(SNAKE, d => { d[d.length - 1] ^= 0xFF; return d; });
  const others = [TYPE.PROGRAM, TYPE.APPVAR].map(type => ({ name: 'SNAKE', type, data: Uint8Array.of(1, 0, 0x31), archived: false, version: 0 }));
  for (const old of [flipped, ...others]) {
    const { sim, link } = await open({ vars: [old] });
    const r = await sendGame(link, [SNAKE]);
    assert.deepEqual(r.replaced, ['SNAKE']);
    assert.equal(deleted(sim), 1);
    assert.deepEqual(sim.get('SNAKE', TYPE.PROTECTED_PROGRAM).data, snake.data);
    if (old.type !== TYPE.PROTECTED_PROGRAM) assert.equal(sim.get('SNAKE', old.type), undefined);
  }
});

test('another calculator model is refused before anything is listed', async () => {
  const { sim, link } = await open();
  link.info = async () => ({ productName: 'TI-84 Plus', osVersion: '2.55.0' });
  await assert.rejects(sendGame(link, [SNAKE]), { code: 'OTHER_MODEL' });
  assert.equal(offered(sim), 0);
});
