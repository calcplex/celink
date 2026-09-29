// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The simulated calculator is the oracle the other tests trust, so its own
// strictness is tested here, packet by packet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVirtual } from '../celink.mjs';
import { makeEntry, TYPE } from '../tifiles.mjs';
import { connect, noViolations, hex, fromHex, be16, be32, utf8, rawHost } from './testkit.mjs';

const ACK = '00 00 00 02 05 E0 00';
const PARAM_REQ = 0x0007;
const silent = async (sim, ms = 50) => Promise.race([
  sim.transferIn(1, 64).then(() => 'answered', () => 'closed'),
  new Promise(resolve => setTimeout(() => resolve('silent'), ms)),
]);

test('observed on hardware: at an allocation of 1023, a 1023-data-byte packet wedges the calculator until it is replugged', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  assert.equal(hex(await host.read()), '00 00 00 04 02 00 00 03 FF');
  assert.equal((await host.write(3, new Uint8Array(1023))).status, 'ok', 'the transfer itself goes through');
  assert.match(host.sim.violations[0], /1023 data bytes \(1028 in all\) exceeds the allocation of 1023/);
  assert.equal(await silent(host.sim), 'silent');
  await host.sim.close();
  await host.sim.open();
  assert.equal(host.sim.wedged, true, 'closing and reopening does not clear it');
  host.sim.replug();
  assert.equal(host.sim.wedged, false);

  const fits = await rawHost();
  await fits.write(1, [0, 0, 4, 0]);
  await fits.read();
  await fits.write(3, new Uint8Array(1018));
  assert.equal(hex(await fits.read()), ACK, '1018 data bytes are taken');
});

test('the simulator counts the raw header against a smaller allocation too, which is inferred', async () => {
  const host = await rawHost({ allocation: 100 });
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  await host.write(3, new Uint8Array(96));
  assert.match(host.sim.violations[0], /96 data bytes \(101 in all\) exceeds the allocation of 100/);
});

test('modelled on libticalcs\' workaround_send: a final packet of whole USB packets with no zero-length write after it wedges the calculator', async () => {
  const host = await rawHost();
  await host.ready();
  await host.write(4, encodeVirtual(PARAM_REQ, new Uint8Array(53))); // 64 bytes on the wire
  assert.equal(await silent(host.sim), 'silent', 'the calculator waits for the end of the transfer');
  await host.write(1, [0, 0, 4, 0]);
  assert.equal(host.sim.wedged, true);
  assert.match(host.sim.violations[0], /without the zero-length write/);
});

test('observed on hardware: a full data packet then an empty type 4 wedges the calculator', async () => {
  const host = await rawHost();
  await host.ready();
  const v = encodeVirtual(PARAM_REQ, new Uint8Array(1012));
  await host.write(3, v);
  assert.equal(hex(await host.read()), ACK);
  await host.write(4, []);
  assert.equal(host.sim.wedged, true);
  assert.match(host.sim.violations[0], /empty type 4 followed a single full data packet/);
});

test('libticalcs\' empty type 4 after several full packets is flagged, since no CE has been sent one, and then read', async () => {
  const host = await rawHost();
  await host.ready();
  const ids = Array.from({ length: 1014 }, () => be16(0x0001)).flat(); // 2 + 2 * 1014 = 2030 bytes: two full packets
  const v = encodeVirtual(PARAM_REQ, [...be16(1014), ...ids]);
  await host.write(3, v.subarray(0, 1018));
  await host.read();
  await host.write(3, v.subarray(1018));
  await host.read();
  await host.write(4, []);
  assert.equal(hex(await host.read()), ACK, 'acknowledged');
  assert.equal(host.sim.wedged, false);
  assert.match(host.sim.violations[0], /never tried on a CE/);
});

test('empty data packets that end nothing, and stray zero-length writes, are violations', async () => {
  let host = await rawHost();
  await host.ready();
  assert.equal((await host.write(3, [])).status, 'stall');
  assert.equal((await host.write(4, [])).status, 'stall');
  assert.match(host.sim.violations.join('\n'), /empty data raw packet/);
  host = await rawHost();
  await host.sim.transferOut(2, new Uint8Array(0));
  assert.match(host.sim.violations[0], /zero-length write arrived when no transfer needed ending/);
});

test('data before the buffer size is negotiated is a violation', async () => {
  const host = await rawHost();
  assert.equal((await host.write(4, encodeVirtual(PARAM_REQ, be16(0)))).status, 'stall');
  assert.match(host.sim.violations[0], /before the buffer size was negotiated/);
});

// A CE answered 0x0001 on hardware; that its host had not pinged is inferred.
test('a command before the mode ping is refused with 0x0001', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  assert.equal(hex(await host.command(PARAM_REQ, [0, 1, 0, 2])), '00 00 00 08 04 00 00 00 02 EE 00 00 01');
  assert.match(host.sim.violations[0], /before the mode ping/);
});

test('a normal-mode ping is answered with 0x0012', async () => {
  const host = await rawHost();
  assert.equal(hex(await host.ready()), '00 00 00 0A 04 00 00 00 04 00 12 00 00 07 D0');
});

test('basic mode refuses a listing', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  await host.command(0x0001, fromHex('00 02 00 01 00 00 00 00 07 D0'));
  assert.match(hex(await host.command(0x0009, fromHex('00 00 00 01 00 01 00 01 00 01 00 01 01'))), /EE 00 7F 02$/);
  assert.match(host.sim.violations[0], /not accepted in mode 000200010000/);
});

test('a ping value below 2000 is refused with 0x001C', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  assert.match(hex(await host.command(0x0001, fromHex('00 03 00 01 00 00 00 00 00 01'))), /EE 00 00 1C$/);
});

test('a packet sent before acknowledging the calculator\'s is a violation', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  await host.post(0x0001, fromHex('00 03 00 01 00 00 00 00 07 D0'));
  await host.read();
  assert.equal((await host.write(4, encodeVirtual(PARAM_REQ, [0, 1, 0, 2]))).status, 'stall');
  assert.match(host.sim.violations[0], /before acknowledging/);
});

test('reads must be whole USB packets: a shorter one is babble', async () => {
  const host = await rawHost();
  await host.write(1, [0, 0, 4, 0]);
  assert.equal((await host.sim.transferIn(1, 4)).status, 'babble');
  assert.match(host.sim.violations.join('\n'), /part of a 64-byte USB packet/);
});

test('the calculator sends whole USB packets and no zero-length packet after a boundary', async () => {
  const { sim, link } = await connect({ vars: [{ name: 'Z', type: TYPE.APPVAR, data: new Uint8Array(64 * 3 - 11) }] });
  assert.equal((await link.receive('Z', TYPE.APPVAR)).data.length, 64 * 3 - 11, 'a contents packet of exactly 3 USB packets');
  noViolations(sim);
});

test('a host that reads again before a delay is over is flagged', async () => {
  const host = await rawHost({ delays: { 0x0012: 60000 } });
  await host.write(1, [0, 0, 4, 0]);
  await host.read();
  const delay = await host.command(0x0001, fromHex('00 03 00 01 00 00 00 00 07 D0'));
  assert.match(hex(delay), /BB 00 00 00 EA 60$/);
  await host.read();
  assert.match(host.sim.violations[0], /before the delay the calculator asked for was over/);
});

test('a command sooner than 50 ms after a variable\'s End of Transmission is flagged', async () => {
  const host = await rawHost();
  await host.ready();
  const e = makeEntry({ name: 'A', type: TYPE.APPVAR, body: Uint8Array.of(1) });
  await host.command(0x000B, [0x00, 1, ...utf8('A'), 0x00, ...be32(3), 0x01, ...be16(1), ...be16(2), ...be16(4), 0xF0, 0x0F, 0x00, 0x15]);
  await host.command(0x000D, e.data);
  await host.post(0xDD00, []);
  await host.write(1, [0, 0, 4, 0]);
  assert.match(host.sim.violations[0], /started \d+ ms after a variable's End of Transmission/);
});

test('built-in names spelled with ASCII digits, or a named list with its ⌊, address nothing', async () => {
  const host = await rawHost({ vars: [{ name: 'L₁', type: TYPE.LIST, data: Uint8Array.of(0, 0) }] });
  await host.ready();
  const request = name => [0x00, utf8(name).length, ...utf8(name), 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, ...be16(0), ...be16(1), ...be16(0x11), ...be16(4), 0xF0, 0x07, 0x00, 0x01, 0x00, 0x00];
  assert.match(hex(await host.command(0x000C, request('L1'))), /EE 00 7F 04$/);
  assert.match(hex(await host.command(0x000C, request('⌊ABC'))), /EE 00 7F 04$/);
  assert.match(host.sim.violations[0], /ASCII digit/);
  assert.match(host.sim.violations[1], /starts with ⌊/);
});
