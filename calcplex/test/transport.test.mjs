// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The installer's transport against the simulated calculator, over the real
// celink protocol code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CETransport } from '../transport.mjs';
import { OFFICIAL, digest, inequalzStatus, installerFailReason, parseVariable, refusalText } from '../core.mjs';
import { CELink, VPKT } from '../../celink.mjs';
import { buildFile, makeEntry, parseFile, TYPE } from '../../tifiles.mjs';
import { SimulatedCalculator } from '../../sim/calculator.mjs';
import { OS, appFile, appSection, noViolations, patched, received } from '../../test/testkit.mjs';

const [V21] = OFFICIAL.v21.files;
const [PPPP, TRIGGER] = OFFICIAL.v3.files;
const probe = new Uint8Array(readFileSync(new URL('../../fixtures/probe.8xp', import.meta.url)));
const PROBE = parseVariable(probe).name;

// arTIfiCE's release files are not in this repository. Stand-ins with the
// same names, types, sizes and storage take their place, and the pins follow.
const standIn = ({ name, type }, size, archived) => buildFile([makeEntry({ name, type, archived, body: new Uint8Array(size - 2).fill(0x3F) })]);
const launcher = standIn(V21, 904, true);
const v3installer = standIn(PPPP, 32770, false);
const v3trigger = standIn(TRIGGER, 285, false);
for (const [spec, bytes] of [[V21, launcher], [PPPP, v3installer], [TRIGGER, v3trigger]]) spec.sha256 = await digest(bytes);

const LINK_DROPS = ['DISCONNECTED', 'USB_ERROR', 'TIMEOUT'];
const small = (name, type) => ({ name, type, data: Uint8Array.of(2, 0, 0, 0) });
/** Times the calculator was asked to take a variable or an app. */
const offered = sim => received(sim, VPKT.RTS);
const deleted = sim => received(sim, VPKT.MODIF_VAR);

/** A transport already connected to a simulated calculator. */
async function connected({ route = 'v21', vars = [], ...simOptions } = {}) {
  const sim = new SimulatedCalculator({ os: OS[route], vars, ...simOptions });
  const t = new CETransport();
  t.link = CELink.fromDevice(sim, { timeout: 500, streamTimeout: 2000 });
  t.device = sim;
  await t.link.open();
  await t.link.ready();
  const calc = await t.link.info();
  t.info = { model: calc.productName, os: calc.osVersion, route };
  return { sim, t };
}

/** The file's variable, as SimulatedCalculator's `vars` takes it. */
function stored(bytes) {
  const { name, type, data, archived, version } = parseFile(bytes).entries[0];
  return { name, type, data, archived, version };
}

/** Let a send finish, then take the calculator off the link, as a restart would. */
function restartAfterAck(sim, t) {
  const send = t.link.send.bind(t.link);
  t.link.send = async (...args) => {
    const r = await send(...args);
    sim.transferIn = async () => ({ status: 'stall', bytesWritten: 0 });
    return r;
  };
}

async function withUsb(usb, fn) {
  Object.defineProperty(globalThis, 'navigator', { value: { usb }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    delete globalThis.navigator;
  }
}

/** WebUSB with nothing granted yet, whose picker grants `sim`. */
function picker(sim) {
  let granted = [];
  const asked = [];
  return { asked, requestDevice: async options => { asked.push(options); granted = [sim]; return sim; }, getDevices: async () => granted };
}

test('connect picks a TI device, opens it and routes off its OS', async () => {
  const sim = new SimulatedCalculator({ os: OS.v3 });
  const usb = picker(sim);
  await withUsb(usb, async () => {
    const t = new CETransport();
    assert.deepEqual(await t.connect(), { model: 'TI-84 Plus CE', os: '5.8.5.0074', route: 'v3', home: true });
    assert.equal(t.device, sim);
    assert.deepEqual(usb.asked[0].filters, [{ vendorId: 0x0451 }]);
  });
  noViolations(sim);
});

test('connect opens the picker even when the page may already use one calculator', async () => {
  const sim = new SimulatedCalculator({ os: OS.v21 });
  const usb = { ...picker(sim), getDevices: async () => [sim] };
  await withUsb(usb, async () => {
    assert.equal((await new CETransport().connect()).route, 'v21');
  });
  assert.equal(usb.asked.length, 1);
});

test('connect gives the link a 300 s budget for each transfer of a Flash write', async () => {
  const sim = new SimulatedCalculator({ os: OS.v3 });
  await withUsb(picker(sim), async () => {
    const t = new CETransport();
    await t.connect();
    const waits = [];
    const setTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      waits.push(ms);
      return setTimeout(fn, ms, ...rest);
    };
    try {
      await t.sendApp(app8ek());
    } finally {
      globalThis.setTimeout = setTimeout;
    }
    assert.ok(waits.includes(300000), `per-transfer waits: ${[...new Set(waits)].join(', ')}`);
  });
  noViolations(sim);
});

test('connect reads a 5.3 calculator as the native route', async () => {
  const sim = new SimulatedCalculator({ os: OS.native });
  await withUsb(picker(sim), async () => {
    assert.equal((await new CETransport().connect()).route, 'native');
  });
});

test('connect refuses any model name but the two a TI-84 Plus CE reports', async () => {
  for (const productName of ['TI-84 Plus CE-T', 'TI-84 Plus CE Python']) {
    const sim = new SimulatedCalculator({ os: OS.v3, productName, invalidParams: [0x0002] });
    await withUsb(picker(sim), async () => {
      await assert.rejects(new CETransport().connect(), { code: 'WRONG_MODEL', message: `Detected ${productName}. Connect a TI-84 Plus CE.` });
    });
  }
});

test('connect refuses when two TI calculators are plugged in', async () => {
  const sim = new SimulatedCalculator({ os: OS.v3 });
  await withUsb({ requestDevice: async () => sim, getDevices: async () => [sim, new SimulatedCalculator()] }, async () => {
    await assert.rejects(new CETransport().connect(), /only one TI calculator/);
  });
});

test('the directory lists variables and apps together', async () => {
  const { sim, t } = await connected({ route: 'v3', vars: [
    stored(launcher),
    { name: 'Inequalz', type: TYPE.FLASH_APP, data: new Uint8Array(16), archived: true },
  ] });
  const rows = await t.directory();
  assert.deepEqual(rows.map(r => [r.name, r.type]), [['A', TYPE.PROGRAM], ['Inequalz', TYPE.FLASH_APP]]);
  assert.equal(inequalzStatus(rows), 'present');
  noViolations(sim);
});

test('a calculator that lists no apps at all is missing Inequalz', async () => {
  const { t } = await connected({ route: 'v3', vars: [stored(launcher)] });
  assert.equal(inequalzStatus(await t.directory()), 'missing');
});

test('the v2.1 launcher lands and reads back byte for byte', async () => {
  const { sim, t } = await connected({ route: 'v21' });
  assert.deepEqual(await t.sendVerified(launcher, { official: V21 }), { name: 'A', alreadyPresent: false, verified: true });
  assert.deepEqual(sim.get('A', TYPE.PROGRAM).data, parseFile(launcher).entries[0].data);
  noViolations(sim);
});

test('observed on hardware: every exchange runs after its own ready()', async () => {
  const { sim, t } = await connected({ vars: [small('A', TYPE.APPVAR)] });
  const exchanges = () => [VPKT.DIR_REQ, VPKT.RTS, VPKT.VAR_REQ, VPKT.MODIF_VAR].reduce((n, type) => n + received(sim, type), 0);
  const pings = () => received(sim, VPKT.PING);
  const before = pings();
  await t.sendVerified(launcher, { official: V21 });
  assert.equal(deleted(sim), 1);
  assert.equal(pings() - before, exchanges());
  noViolations(sim);
});

test('each file is stored where its own archived flag says', async () => {
  const v21 = await connected({ route: 'v21' });
  await v21.t.sendVerified(launcher, { official: V21 });
  assert.equal(v21.sim.get('A', TYPE.PROGRAM).archived, true);
  const v3 = await connected({ route: 'v3' });
  await v3.t.sendVerified(v3installer, { official: PPPP });
  assert.equal(v3.sim.get('PPPP', TYPE.PROGRAM).archived, false);
});

test('an ordinary file already on the calculator, identical, is not sent again', async () => {
  const { sim, t } = await connected({ vars: [stored(probe)] });
  assert.deepEqual(await t.sendVerified(probe), { name: PROBE, alreadyPresent: true, verified: true });
  assert.equal(offered(sim), 0);
  noViolations(sim);
});

test('an ordinary file refuses any program or AppVar under its name', async () => {
  for (const type of [TYPE.PROTECTED_PROGRAM, TYPE.APPVAR]) {
    const { sim, t } = await connected({ vars: [small(PROBE, type)] });
    await assert.rejects(t.sendVerified(probe), { code: 'COLLISION' });
    assert.equal(offered(sim), 0);
  }
});

test('the launcher sends over program A of either kind', async () => {
  for (const type of [TYPE.PROGRAM, TYPE.PROTECTED_PROGRAM]) {
    const { sim, t } = await connected({ vars: [small('A', type)] });
    assert.equal((await t.sendVerified(launcher, { official: V21 })).verified, true);
    noViolations(sim);
  }
});

test('the launcher deletes an AppVar or group named A first', async () => {
  for (const type of [TYPE.APPVAR, TYPE.GROUP]) {
    const { t } = await connected({ vars: [small('A', type)] });
    await t.sendVerified(launcher, { official: V21 });
    assert.deepEqual((await t.directory()).filter(e => e.name === 'A').map(e => e.type), [TYPE.PROGRAM]);
  }
});

test('math values named A never block the launcher and are left alone', async () => {
  const math = [
    { name: 'A', type: TYPE.REAL, data: new Uint8Array(9) },
    { name: 'A', type: TYPE.COMPLEX, data: new Uint8Array(18) },
    { name: 'A', type: TYPE.LIST, data: Uint8Array.of(1, 0, ...new Uint8Array(9)) },
  ];
  for (const v of math) {
    const { sim, t } = await connected({ vars: [v] });
    await t.precheck(OFFICIAL.v21.files);
    assert.equal((await t.sendVerified(launcher, { official: V21 })).verified, true);
    assert.equal(deleted(sim), 0);
  }
});

test('an official file is checked against its route and pin before the calculator is asked anything', async () => {
  const tampered = patched(launcher, b => { b[73] ^= 1; });
  const v21 = await connected({ route: 'v21' });
  const v3 = await connected({ route: 'v3' });
  for (const { t } of [v21, v3]) t.directory = () => assert.fail('the calculator was listed');
  await assert.rejects(v21.t.sendVerified(tampered, { official: V21 }), { code: 'BAD_HASH', message: /verified arTIfiCE/ });
  await assert.rejects(v21.t.sendVerified(v3installer, { official: PPPP }), { code: 'WRONG_ROUTE' });
  await assert.rejects(v3.t.sendVerified(launcher, { official: V21 }), { code: 'WRONG_ROUTE' });
  await assert.rejects(v21.t.sendVerified(new Uint8Array(80)), { code: 'BAD_FILE' });
  assert.equal(offered(v21.sim) + offered(v3.sim), 0);
});

test('a read-back that differs is NOT_VERIFIED', async () => {
  const { t } = await connected();
  t.receive = async () => launcher;
  await assert.rejects(t.sendVerified(probe), { code: 'NOT_VERIFIED' });
});

test('a trigger that restarts the calculator as it lands is reported as the reboot', async () => {
  for (const mode of ['silent', 'disconnect']) {
    const { sim, t } = await connected({ route: 'v3' });
    sim.rebootWhenLands('INEQUVAR', TYPE.APPVAR, { mode });
    t.receive = () => assert.fail('nothing to read back after a restart');
    const r = await t.sendVerified(v3trigger, { official: TRIGGER, skipDirectory: true });
    assert.deepEqual(r, { name: 'INEQUVAR', alreadyPresent: false, verified: false, rebooted: true }, mode);
    assert.equal(t.poisoned, true);
    await assert.rejects(t.directory(), /Reconnect by unplugging/);
    noViolations(sim);
  }
});

test('observed on hardware on 5.8.5: a trigger acknowledged and then restarted is the reboot too', async () => {
  const { sim, t } = await connected({ route: 'v3' });
  restartAfterAck(sim, t);
  const r = await t.sendVerified(v3trigger, { official: TRIGGER, skipDirectory: true });
  assert.deepEqual(r, { name: 'INEQUVAR', alreadyPresent: false, verified: false, rebooted: true });
  assert.equal(t.poisoned, true);
});

test('a trigger the calculator simply keeps is read back like any other file', async () => {
  const { sim, t } = await connected({ route: 'v3' });
  const r = await t.sendVerified(v3trigger, { official: TRIGGER, skipDirectory: true });
  assert.deepEqual(r, { name: 'INEQUVAR', alreadyPresent: false, verified: true });
  assert.equal(t.poisoned, false);
  noViolations(sim);
});

test('the link dropping before the trigger\'s last packet is a failure', async () => {
  // A small buffer, so the 285-byte trigger takes several packets.
  const { sim, t } = await connected({ route: 'v3', allocation: 128 });
  sim.rebootWhenLands('INEQUVAR', TYPE.APPVAR, { early: true, mode: 'disconnect' });
  await assert.rejects(t.sendVerified(v3trigger, { official: TRIGGER, skipDirectory: true }), err => LINK_DROPS.includes(err.code));
  assert.equal(t.poisoned, true);
});

test('any other file that loses the link after it lands is a failure', async () => {
  const { sim, t } = await connected();
  restartAfterAck(sim, t);
  await assert.rejects(t.sendVerified(probe), { code: 'USB_ERROR' });
  assert.equal(t.poisoned, true);
});

test('precheck clears the way for a half-finished v3 install without sending', async () => {
  const { sim, t } = await connected({ route: 'v3', vars: [
    small('PPPP', TYPE.PROGRAM),
    small('PPPP', TYPE.APPVAR),
    small('INEQUVAR', TYPE.APPVAR),
  ] });
  await t.precheck(OFFICIAL.v3.files);
  assert.equal(offered(sim), 0);
  // PPPP's program is left for its send to overwrite; the trigger's own name is cleared too.
  assert.deepEqual((await t.directory()).map(e => `${e.name}:${e.type}`), [`PPPP:${TYPE.PROGRAM}`]);
  noViolations(sim);
});

test('precheck refuses a clash for a file that does not replace', async () => {
  const { sim, t } = await connected({ vars: [small(PROBE, TYPE.PROGRAM)] });
  await assert.rejects(t.precheck([{ name: PROBE, type: TYPE.PROGRAM }]), { code: 'COLLISION', names: [PROBE], message: /already exists on the calculator/ });
  assert.equal(offered(sim) + deleted(sim), 0);
});

test('precheck names every file it refuses', async () => {
  const { t } = await connected({ vars: [small('ONE', TYPE.PROGRAM), small('TWO', TYPE.APPVAR)] });
  const files = [{ name: 'ONE', type: TYPE.PROGRAM }, { name: 'TWO', type: TYPE.APPVAR }];
  await assert.rejects(t.precheck(files), { code: 'COLLISION', names: ['ONE', 'TWO'], message: /^ONE and TWO already exist on the calculator/ });
});

const app8ek = () => appFile('Inequalz', 2048);
const os8ek = () => appSection({ name: 'OS', dataType: TYPE.OS, data: new Uint8Array(8) });

test('sendApp writes the app, and the calculator then lists it', async () => {
  const { sim, t } = await connected({ route: 'v3' });
  assert.deepEqual(await t.sendApp(app8ek()), { name: 'Inequalz', sent: true });
  assert.equal(inequalzStatus(await t.directory()), 'present');
  noViolations(sim);
});

test('sendApp refuses an operating system, a variable file, and an unidentified calculator', async () => {
  const { sim, t } = await connected({ route: 'v3' });
  await assert.rejects(t.sendApp(os8ek()), /operating system/);
  await assert.rejects(t.sendApp(probe), /\.8ek/);
  t.info = null;
  await assert.rejects(t.sendApp(app8ek()), /Connect and read the OS first/);
  assert.equal(offered(sim), 0);
});

test('a low battery refuses the app with the calculator\'s 0x002B, and the link survives', async () => {
  const { sim, t } = await connected({ route: 'v3', lowBattery: true });
  await assert.rejects(t.sendApp(app8ek()), { code: 'CALC_ERROR', calcError: 0x002B });
  assert.equal(sim.get('Inequalz', TYPE.FLASH_APP), undefined);
  assert.equal(t.poisoned, false);
});

test('a refused mode ping just before the app reads as the app\'s refusal', async () => {
  const { sim, t } = await connected({ route: 'v3' });
  await t.directory();
  sim.refuse = { step: 'mode', code: 0x002B, times: 1 };
  const err = await t.sendApp(app8ek()).catch(e => e);
  assert.equal(err.code, 'CALC_ERROR');
  assert.equal(err.op, 'ready');
  assert.equal(refusalText(err), 'The calculator refused the app (error 0x002b: the battery is too low to write Flash. Charge the calculator and try again).');
  assert.equal(installerFailReason(err), 'calc_error_43');
  assert.equal(offered(sim), 0);
});

test('a calculator that stops answering poisons the transport for good', async () => {
  const { sim, t } = await connected();
  sim.disconnected = true;
  await assert.rejects(t.directory(), err => LINK_DROPS.includes(err.code));
  assert.equal(t.poisoned, true);
  await assert.rejects(t.sendVerified(launcher, { official: V21 }), /Reconnect by unplugging/);
});
