// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// send(..., { rebootOnLanding: true }): a variable that makes the calculator
// reboot the moment it lands, so the link drops before the acknowledgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELink, CELinkError } from '../celink.mjs';
import { makeEntry, buildFile, TYPE } from '../tifiles.mjs';
import { SimulatedCalculator } from '../sim/calculator.mjs';

async function connect(simOpts = {}) {
  const sim = new SimulatedCalculator(simOpts);
  const link = CELink.fromDevice(sim);
  link.capture = true;
  link.timeout = 300;
  link.streamTimeout = 300;
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
// 2500-byte body -> 2502-byte data -> 2508-byte virtual -> three raw packets
// (1018, 1018, 472), the last not a 64-multiple, so no zero-length write.
const rebooter = () => makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(2500) });

// case 1 -----------------------------------------------------------------

test('rebootOnLanding: a drop after the final packet resolves rebooted, and poisons the link', async () => {
  for (const mode of ['silent', 'disconnect']) {
    const { sim, link } = await connect();
    sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode });
    const phases = [];
    const r = await link.send(rebooter(), { rebootOnLanding: true, onPhase: p => phases.push(p) });
    assert.deepEqual(r, { name: 'REBOOT', bytes: 2502, rebooted: true, acknowledged: false }, mode);
    assert.deepEqual(phases, ['final-write-started', 'final-written'], `${mode}: the boundary was reached but never acknowledged`);
    // The whole payload did go out: the last contents packet was written.
    assert.ok(sim.log.some(p => p.dir === 'out' && p.bytes[4] === 4), `${mode}: a final data packet was sent`);
    // The link is closed and every later call says so.
    assert.equal(link.opened, false, `${mode}: link closed`);
    await assert.rejects(link.info(), err => err instanceof CELinkError && err.code === 'LINK_CLOSED' && /reconnect/i.test(err.message), `${mode}: later calls throw LINK_CLOSED`);
    await assert.rejects(link.list(), { code: 'LINK_CLOSED' });
    // Reconnecting clears it.
    sim.replug();
    await link.open();
    assert.equal((await link.info()).productName, 'TI-84 Plus CE', `${mode}: usable again after reconnect`);
    noViolations(sim);
  }
});

// case 2 -----------------------------------------------------------------

test('rebootOnLanding: a drop before the final packet throws, as always', async () => {
  for (const mode of ['silent', 'disconnect']) {
    const { sim, link } = await connect();
    sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { early: true, mode });
    const phases = [];
    await assert.rejects(
      link.send(rebooter(), { rebootOnLanding: true, onPhase: p => phases.push(p) }),
      err => err instanceof CELinkError && (err.code === 'TIMEOUT' || err.code === 'USB_ERROR' || err.code === 'DISCONNECTED'),
      `${mode}: an early drop is an ordinary failure`,
    );
    assert.deepEqual(phases, [], `${mode}: the final packet's write never started`);
    assert.equal(link.opened, false);
    // A fatal error closes the link the ordinary way (NOT_OPEN, not LINK_CLOSED).
    await assert.rejects(link.info(), { code: 'NOT_OPEN' }, `${mode}: not poisoned as a reboot`);
  }
});

// case 3 -----------------------------------------------------------------

test('rebootOnLanding: a normal acknowledgement resolves rebooted:false, send unchanged', async () => {
  const { sim, link } = await connect();
  const phases = [];
  const r = await link.send(rebooter(), { rebootOnLanding: true, onPhase: p => phases.push(p) });
  assert.deepEqual(r, { name: 'REBOOT', bytes: 2502, rebooted: false, acknowledged: true });
  assert.deepEqual(phases, ['final-write-started', 'final-written', 'acknowledged']);
  // The read-back still works and the variable is really there.
  assert.deepEqual(sim.get('REBOOT', TYPE.APPVAR).data, rebooter().data);
  const back = await link.receive('REBOOT', TYPE.APPVAR);
  assert.deepEqual(back.data, rebooter().data);
  assert.equal(link.opened, true);
  noViolations(sim);
});

// case 4 -----------------------------------------------------------------

test('without the option a landing reboot is an error, and the plain result has no reboot fields', async () => {
  const { sim, link } = await connect();
  sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode: 'silent' });
  await assert.rejects(link.send(rebooter()), { code: 'TIMEOUT' }, 'unchanged: a drop is just a timeout');
  assert.equal(link.opened, false);
  await assert.rejects(link.info(), { code: 'NOT_OPEN' });
  // And a normal send without the option keeps its old two-field result.
  const { sim: s2, link: l2 } = await connect();
  const r = await l2.send(makeEntry({ name: 'OK', type: TYPE.APPVAR, body: patterned(50) }));
  assert.deepEqual(r, { name: 'OK', bytes: 52 });
  assert.equal('rebooted' in r, false);
  noViolations(s2);
});

// sendFile ---------------------------------------------------------------

test('sendFile: rebootOnLanding works for a one-variable file and is refused for more', async () => {
  const { sim, link } = await connect();
  sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode: 'disconnect' });
  const file = buildFile([rebooter()]);
  const [r] = await link.sendFile(file, { rebootOnLanding: true });
  assert.deepEqual(r, { name: 'REBOOT', bytes: 2502, rebooted: true, acknowledged: false });
  assert.equal(link.opened, false);
  sim.replug(); await link.open();
  const two = buildFile([makeEntry({ name: 'A', type: TYPE.APPVAR, body: patterned(20) }), makeEntry({ name: 'B', type: TYPE.APPVAR, body: patterned(20) })]);
  await assert.rejects(link.sendFile(two, { rebootOnLanding: true }), { code: 'BAD_ENTRY', message: /exactly one variable/ });
  assert.equal(link.opened, true, 'the refusal is before anything is sent');
});

// a multi-packet reboot whose final packet lands on a 64-multiple ------------

test('rebootOnLanding: a final packet on a 64-byte multiple (zero-length write) still lands', async () => {
  // 6 + size = 1018 + k, last data = k, wire = k + 5. Want k + 5 = 64 -> k = 59 -> size = 1018 + 59 - 6 = 1071 -> body 1069.
  const e = makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(1069) });
  assert.equal(e.data.length, 1071);
  const { sim, link } = await connect();
  sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode: 'silent' });
  const r = await link.send(e, { rebootOnLanding: true });
  assert.deepEqual(r, { name: 'REBOOT', bytes: 1071, rebooted: true, acknowledged: false });
  // The zero-length write went out before the link went quiet.
  assert.ok(sim.log.some(p => p.dir === 'out' && p.bytes.length === 0), 'the zero-length write was sent');
  await assert.rejects(link.info(), { code: 'LINK_CLOSED' });
  noViolations(sim);
});

// reject-write: the reboot rejects the final packet's own transferOut ----------

test('rebootOnLanding: a rejected final OUT transfer is the landing, not a failure', async () => {
  // The hardware case: an app variable that goes out as one raw packet, with no
  // zero-length write. Here a 285-byte body, 287 bytes with its size word
  // (6 + 287 = 293 <= 1018). The reboot rejects that transferOut even though
  // every USB packet was taken.
  const single = makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(285) });
  assert.equal(single.data.length, 287);
  for (const e of [single, rebooter()]) { // one packet, then three
    const { sim, link } = await connect();
    sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode: 'reject-write' });
    const phases = [];
    const r = await link.send(e, { rebootOnLanding: true, onPhase: p => phases.push(p) });
    assert.deepEqual(r, { name: 'REBOOT', bytes: e.data.length, rebooted: true, acknowledged: false });
    // The write started but never completed, so no final-written phase.
    assert.deepEqual(phases, ['final-write-started'], `${e.data.length} bytes: the write started but did not complete`);
    assert.equal(link.opened, false);
    await assert.rejects(link.info(), { code: 'LINK_CLOSED' });
    sim.replug(); await link.open();
    assert.equal((await link.info()).productName, 'TI-84 Plus CE');
    noViolations(sim);
  }
});

test('rebootOnLanding: reject-write before the final packet still throws', async () => {
  // early + reject-write drops on the second-to-last packet's write: the final
  // write never starts, so it is an ordinary failure.
  const { sim, link } = await connect();
  sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { early: true, mode: 'reject-write' });
  const phases = [];
  await assert.rejects(
    link.send(rebooter(), { rebootOnLanding: true, onPhase: p => phases.push(p) }),
    err => err instanceof CELinkError && (err.code === 'USB_ERROR' || err.code === 'DISCONNECTED' || err.code === 'TIMEOUT'),
  );
  assert.deepEqual(phases, []);
  assert.equal(link.opened, false);
  await assert.rejects(link.info(), { code: 'NOT_OPEN' }, 'not poisoned as a reboot');
});

test('rebootOnLanding: a final packet on a 64-byte multiple, drop on either write', async () => {
  // 1071-byte variable: two packets, the last 59 data bytes -> 64 on the wire,
  // so a zero-length write follows. reject-write drops the final data write;
  // disconnect lets that write finish and drops the zero-length write instead.
  const e = makeEntry({ name: 'REBOOT', type: TYPE.APPVAR, body: patterned(1069) });
  assert.equal(e.data.length, 1071);
  for (const mode of ['reject-write', 'disconnect']) {
    const { sim, link } = await connect();
    sim.rebootWhenLands('REBOOT', TYPE.APPVAR, { mode });
    const phases = [];
    const r = await link.send(e, { rebootOnLanding: true, onPhase: p => phases.push(p) });
    assert.deepEqual(r, { name: 'REBOOT', bytes: 1071, rebooted: true, acknowledged: false }, mode);
    assert.ok(phases[0] === 'final-write-started', `${mode}: the final write started`);
    // reject-write dies on the data write (no final-written); disconnect dies on
    // the zero-length write (final-written did fire).
    assert.equal(phases.includes('final-written'), mode === 'disconnect', mode);
    assert.equal(link.opened, false);
    await assert.rejects(link.info(), { code: 'LINK_CLOSED' });
    noViolations(sim);
  }
});
