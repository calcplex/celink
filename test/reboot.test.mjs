// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// send(entry, { rebootOnLanding: true }): a variable that makes the calculator
// restart as it lands, so the link drops before the acknowledgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEntry, buildFile, parseFile, TYPE } from '../tifiles.mjs';
import { connect, noViolations, patterned, written } from './testkit.mjs';

const TIMEOUTS = { timeout: 300, streamTimeout: 300 };
// 2502 bytes of data: three raw packets (1018, 1018, 472), no zero-length write.
const rebooter = () => makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(2500) });
// 1071 bytes of data: two raw packets, the last 64 bytes on the wire, then a zero-length write.
const rebooterOnBoundary = () => makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(1069) });
const landed = e => ({ name: 'REBOOT', bytes: e.data.length, rebooted: true });
const linkDrop = err => ['TIMEOUT', 'USB_ERROR', 'DISCONNECTED'].includes(err.code);

async function landing(mode, options) {
  const { sim, link } = await connect({}, TIMEOUTS);
  sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode, ...options });
  return { sim, link };
}

test('a drop after the last contents packet resolves rebooted, and closes the link until the next open()', async () => {
  for (const mode of ['silent', 'disconnect']) {
    const { sim, link } = await landing(mode);
    assert.deepEqual(await link.send(rebooter(), { rebootOnLanding: true }), landed(rebooter()), mode);
    assert.ok(written(sim).some(p => p[4] === 4 && p.length === 477), `${mode}: the last contents packet went out`);
    assert.equal(link.opened, false);
    await assert.rejects(link.info(), { code: 'LINK_CLOSED', message: /Open the link again/ });
    await assert.rejects(link.list(), { code: 'LINK_CLOSED' });
    sim.replug();
    await link.open();
    await link.ready();
    assert.equal((await link.info()).productName, 'TI-84 Plus CE', `${mode}: usable after open()`);
    noViolations(sim);
  }
});

test('observed on hardware: a rejected write of the last contents packet is the landing', async () => {
  const oneWrite = makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(285) });
  for (const e of [oneWrite, rebooter(), rebooterOnBoundary()]) {
    const { sim, link } = await landing('reject-write');
    assert.deepEqual(await link.send(e, { rebootOnLanding: true }), landed(e), `${e.data.length} bytes`);
    await assert.rejects(link.info(), { code: 'LINK_CLOSED' });
    sim.replug();
    await link.open();
    await link.ready();
    assert.equal((await link.info()).productName, 'TI-84 Plus CE');
    noViolations(sim);
  }
});

test('a drop at the zero-length write after a boundary packet is the landing too', async () => {
  const e = rebooterOnBoundary();
  const { sim, link } = await landing('disconnect');
  assert.deepEqual(await link.send(e, { rebootOnLanding: true }), landed(e));
  assert.ok(written(sim).at(-1).length === 0, 'the zero-length write was the last thing sent');
  noViolations(sim);
});

test('a drop before the last contents packet is an ordinary failure', async () => {
  for (const mode of ['silent', 'disconnect', 'reject-write']) {
    const { link } = await landing(mode, { early: true });
    await assert.rejects(link.send(rebooter(), { rebootOnLanding: true }), linkDrop, mode);
    assert.equal(link.opened, false);
    await assert.rejects(link.info(), { code: 'NOT_OPEN' }, `${mode}: closed as after any lost link`);
  }
});

test('a landing acknowledged as usual resolves rebooted: false and leaves the link open', async () => {
  const { sim, link } = await connect({}, TIMEOUTS);
  assert.deepEqual(await link.send(rebooter(), { rebootOnLanding: true }), { ...landed(rebooter()), rebooted: false });
  assert.deepEqual((await link.receive('REBOOT', TYPE.APPVAR)).data, rebooter().data);
  noViolations(sim);
});

test('without rebootOnLanding a landing restart is a lost link', async () => {
  const { link } = await landing('silent');
  await assert.rejects(link.send(rebooter()), { code: 'TIMEOUT' });
  await assert.rejects(link.info(), { code: 'NOT_OPEN' });
});

test('sendFile() takes rebootOnLanding for a one-variable file only', async () => {
  const { sim, link } = await landing('disconnect');
  assert.deepEqual(await link.sendFile(parseFile(buildFile([rebooter()])), { rebootOnLanding: true }), [landed(rebooter())]);
  sim.replug();
  await link.open();
  const two = parseFile(buildFile(['A', 'B'].map(name => makeEntry({ name, type: TYPE.APPVAR, body: patterned(20) }))));
  await assert.rejects(link.sendFile(two, { rebootOnLanding: true }), { code: 'BAD_ENTRY', message: /exactly one variable/ });
  assert.equal(link.opened, true, 'refused before anything was sent');
});
