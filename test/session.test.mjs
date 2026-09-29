// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELink, CELinkError, VPKT } from '../celink.mjs';
import { makeEntry, TYPE } from '../tifiles.mjs';
import { SimulatedCalculator } from '../sim/calculator.mjs';
import { connect, noViolations, patterned, hex, written } from './testkit.mjs';

const program = (name, n = 20) => makeEntry({ name, type: TYPE.PROGRAM, body: patterned(n) });
const bufferRequests = sim => written(sim).filter(p => p[4] === 1);
const pings = sim => sim.commands.filter(c => c.type === VPKT.PING);
const openFailure = ({ code, step, cause }) => ({ code, step, cause: cause?.name });

test('request() shows the picker for TI\'s vendor id', async () => {
  const sim = new SimulatedCalculator();
  let asked;
  const link = await CELink.request({ usb: { requestDevice: async options => { asked = options; return sim; } } });
  assert.deepEqual(asked, { filters: [{ vendorId: 0x0451 }] });
  assert.equal(link.device, sim);
});

test('granted() lists only TI devices', async () => {
  const sim = new SimulatedCalculator();
  assert.deepEqual(await CELink.granted({ usb: { getDevices: async () => [sim, { vendorId: 0x1234 }] } }), [sim]);
});

test('a cancelled picker is NO_DEVICE_SELECTED, and a browser without WebUSB is NO_WEBUSB', async () => {
  const cancelled = { requestDevice: async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }); } };
  await assert.rejects(CELink.request({ usb: cancelled }), { code: 'NO_DEVICE_SELECTED' });
  await assert.rejects(CELink.request({ usb: null }), { code: 'NO_WEBUSB' });
});

test('open() claims interface 0 of configuration 1 and takes its bulk endpoints', async () => {
  const { sim, link } = await connect({ endpointIn: 3, endpointOut: 7 });
  assert.equal(sim.configuration.configurationValue, 1);
  assert.equal(sim.claimed, true);
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  assert.ok(written(sim).length > 0);
  await link.close();
  assert.equal(sim.claimed, false);
  assert.equal(sim.opened, false);
  noViolations(sim);
});

test('open() fails with NO_ENDPOINTS on a device without bulk endpoints, and leaves it closed', async () => {
  const sim = new SimulatedCalculator();
  for (const c of sim.configurations) for (const e of c.interfaces[0].alternate.endpoints) e.type = 'interrupt';
  const link = CELink.fromDevice(sim);
  await assert.rejects(link.open(), { code: 'NO_ENDPOINTS' });
  assert.equal(sim.opened, false);
  await assert.rejects(link.info(), { code: 'NOT_OPEN' });
});

test('OPEN_FAILED names the WebUSB step that refused and carries its error as the cause', async () => {
  const refusing = async (method, error) => {
    const sim = new SimulatedCalculator();
    sim[method] = async () => { throw error; };
    return CELink.fromDevice(sim).open().then(() => assert.fail('open() should fail'), e => e);
  };
  const domError = name => Object.assign(new Error('Access denied.'), { name });
  assert.deepEqual(openFailure(await refusing('open', domError('SecurityError'))), { code: 'OPEN_FAILED', step: 'open', cause: 'SecurityError' });
  assert.deepEqual(openFailure(await refusing('selectConfiguration', domError('NetworkError'))), { code: 'OPEN_FAILED', step: 'config', cause: 'NetworkError' });
  assert.deepEqual(openFailure(await refusing('claimInterface', domError('NetworkError'))), { code: 'OPEN_FAILED', step: 'claim', cause: 'NetworkError' });
  assert.deepEqual(openFailure(await refusing('open', 'boom')), { code: 'OPEN_FAILED', step: 'open', cause: undefined }, 'a thrown non-Error');
});

test('observed on hardware: ready() asks for a 1024-byte buffer and pings the normal mode', async () => {
  const { sim } = await connect();
  assert.deepEqual(bufferRequests(sim).map(hex), ['00 00 00 04 01 00 00 04 00']);
  assert.deepEqual(pings(sim).map(c => hex(c.data)), ['00 03 00 01 00 00 00 00 07 D0']);
  noViolations(sim);
});

test('ready() acknowledges or skips leftover packets before the buffer answer, where libticalcs fails, and counts them', async () => {
  const leftovers = [{ type: 4, data: [0, 0, 0, 1, 0xAA, 0x00, 0x01] }, { type: 5, data: [0xE0, 0x00] }];
  const { sim, link } = await connect({ leftovers });
  const seen = [];
  link.onAnomaly = kind => seen.push(kind);
  assert.equal(link.anomalies.stalePacket, 2, 'counted during connect');
  assert.equal(written(sim).filter(p => p[4] === 5).length >= 1, true, 'the data packet was acknowledged');
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  sim.leftovers = Array.from({ length: 9 }, () => ({ type: 5, data: [0xE0, 0x00] }));
  await assert.rejects(link.ready(), { code: 'PROTOCOL', message: /got raw packet type 5/ });
  assert.equal(seen.filter(k => k === 'stalePacket').length, 8, 'eight skipped, the ninth refused');
  noViolations(sim);
});

test('one ready() serves every operation until the link closes', async () => {
  const { sim, link } = await connect();
  await link.info();
  await link.list();
  await link.send(program('ONCE'));
  await link.receive('ONCE', TYPE.PROGRAM);
  await link.delete('ONCE', TYPE.PROGRAM);
  assert.equal(bufferRequests(sim).length, 1, 'libticalcs negotiates in is_ready only');
  assert.equal(pings(sim).length, 1);
  await link.ready();
  assert.equal(pings(sim).length, 2, 'ready() does it again');
  await link.close();
  await link.open();
  assert.equal(pings(sim).length, 2, 'open() only claims the interface');
  await assert.rejects(link.info(), { code: 'NOT_READY' });
  await link.ready();
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  noViolations(sim);
});

test('a CALC_ERROR names the operation and the reply that carried it, and leaves the link open', async () => {
  const cases = [
    ['mode', 'ready', link => link.ready()],
    ['params', 'info', link => link.info()],
    ['dir', 'list', link => link.list()],
    ['rts', 'send', link => link.send(program('NEW'))],
    ['contents', 'send', link => link.send(program('NEW'))],
    ['request', 'receive', link => link.receive('OLD', TYPE.PROGRAM)],
    ['contents', 'receive', link => link.receive('OLD', TYPE.PROGRAM)],
    ['delete', 'delete', link => link.delete('OLD', TYPE.PROGRAM)],
  ];
  for (const [step, op, run] of cases) {
    const { sim, link } = await connect({ vars: [{ name: 'OLD', type: TYPE.PROGRAM, data: Uint8Array.of(0, 0) }] });
    sim.refuse = { step, code: 0x0036, times: 1 };
    await assert.rejects(run(link), err => {
      assert.ok(err instanceof CELinkError);
      assert.deepEqual([err.code, err.calcError, err.op, err.step], ['CALC_ERROR', 0x0036, op, step]);
      return true;
    });
    assert.equal(link.opened, true, `${op} ${step}: still open`);
    await link.ready();
    assert.equal((await link.list()).length, 1, `${op} ${step}: and usable`);
    noViolations(sim);
  }
});

test('calculator errors read as libticalcs describes them', async () => {
  const { sim, link } = await connect();
  for (const [code, text] of [[0x000C, 'error 0x000C: out of memory'], [0x0012, 'locked'], [0x0034, 'set your calculator to HOME screen'], [0x002E, 'signature does not match']]) {
    sim.refuse = { step: 'rts', code, times: 1 };
    await assert.rejects(link.send(program('ERR')), err => err.calcError === code && err.message.includes(text), text);
  }
});

test('a calculator error libticalcs does not list says it is not a known code', async () => {
  const { sim, link } = await connect();
  sim.refuse = { step: 'rts', code: 0x0036, times: 1 };
  await assert.rejects(link.send(program('ERR')), { message: 'The calculator refused the request (error 0x0036, not a known code).' });
});

test('a timeout clears both endpoints\' halts, closes the link, and it opens again', async () => {
  const { sim, link } = await connect({}, { timeout: 60 });
  sim.freeze = true;
  const t0 = Date.now();
  await assert.rejects(link.info(), { code: 'TIMEOUT', message: /did not answer within 60 ms/, ms: 60, during: 'waiting for the calculator' });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(sim.clearedHalts, [['out', 2], ['in', 1]]);
  assert.equal(link.anomalies.haltsCleared, 1);
  assert.equal(link.opened, false);
  assert.equal(sim.claimed, false);
  await assert.rejects(link.list(), { code: 'NOT_OPEN' });
  sim.freeze = false;
  await link.open();
  await link.ready();
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
});

test('a calculator that goes quiet while contents stream times out on the stream timeout', async () => {
  const { sim, link } = await connect({}, { streamTimeout: 80 });
  sim.intercept = type => type === VPKT.VAR_CNTS && (sim.freeze = true);
  await assert.rejects(link.send(makeEntry({ name: 'HANG', type: TYPE.APPVAR, body: patterned(5000) })), { code: 'TIMEOUT', message: /80 ms/ });
  assert.equal(link.opened, false);
});

test('a USB stall closes the link', async () => {
  const { sim, link } = await connect();
  sim.transferOut = async () => ({ status: 'stall', bytesWritten: 0 });
  await assert.rejects(link.info(), { code: 'USB_ERROR' });
  assert.equal(sim.clearedHalts.length, 2);
  assert.equal(link.opened, false);
});

test('halts are not cleared after a refusal, or when the calculator is gone', async () => {
  const { sim, link } = await connect();
  sim.refuse = { step: 'params', code: 0x0011, times: 1 };
  await assert.rejects(link.info(), { code: 'CALC_ERROR' });
  sim.disconnected = true;
  await link.ready().catch(() => {});
  await assert.rejects(link.ready(), { code: 'NOT_OPEN' });
  assert.deepEqual(sim.clearedHalts, []);
  assert.equal(link.anomalies.haltsCleared, 0);
});

test('an error thrown outside the USB layer passes through and leaves the link open', async () => {
  const { link } = await connect();
  const failing = () => { throw new TypeError('a page bug'); };
  await assert.rejects(link.send(program('CB'), { onProgress: failing }), TypeError);
  assert.equal(link.opened, true);
  await link.ready();
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
});

test('calls made together run one after another', async () => {
  const { sim, link } = await connect();
  const a = makeEntry({ name: 'AAA', type: TYPE.APPVAR, body: patterned(3000, 1) });
  const b = makeEntry({ name: 'BBB', type: TYPE.APPVAR, body: patterned(3000, 2) });
  await Promise.all([link.send(a), link.send(b), link.list()]);
  assert.deepEqual(sim.get('AAA', TYPE.APPVAR).data, a.data);
  assert.deepEqual(sim.get('BBB', TYPE.APPVAR).data, b.data);
  noViolations(sim);
});

// The simulator flags a read made before a delay is over, so these tests need
// no clock of their own.
test('a delay acknowledgement is waited out before the next read', async () => {
  const { sim, link } = await connect({ delays: { 0x0008: 40000, 0xAA00: 25000 } });
  await link.info();
  await link.send(makeEntry({ name: 'SLOW', type: TYPE.APPVAR, body: patterned(3000) }));
  noViolations(sim);
});

test('a delay is capped at 400 ms', { timeout: 5000 }, async () => {
  const { sim, link } = await connect({ delays: { 0x0008: 0x7FFFFFFF } });
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  noViolations(sim);
});

test('a delay shorter than 4 bytes waits the 400 ms cap', async () => {
  const { link } = await connect({ delays: { 0x0008: Uint8Array.of(1) } });
  const t0 = performance.now();
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  assert.ok(performance.now() - t0 >= 398);
});

test('several delays before one reply are all waited out, where libticalcs takes one', async () => {
  const { sim, link } = await connect({ delays: { 0x0008: [20000, 20000, 20000] } });
  assert.equal((await link.info()).productName, 'TI-84 Plus CE');
  noViolations(sim);
});

test('the reply\'s timeout bounds a run of delays', async () => {
  const { link: bounded } = await connect({ delays: { 0x0008: Array(20).fill(100000) } }, { timeout: 300 });
  await assert.rejects(bounded.info(), { code: 'TIMEOUT', message: /kept asking for more time/ });
});
