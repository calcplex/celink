// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRaw, decodeRaw, joinVirtual, needsZeroLength, VPKT } from '../celink.mjs';
import { makeEntry, buildFile, parseFile, TYPE } from '../tifiles.mjs';
import { connect, noViolations, patterned, hex, fromHex, be32, written, dataPackets } from './testkit.mjs';

/** [type, data bytes] of each data raw packet the host wrote. */
const shape = packets => packets.map(p => [p[4], p.length - 5]);
/** The data raw packets that carried the host's Variable Contents of `n` bytes. */
function contentsPackets(sim, n) {
  const out = dataPackets(sim, 'out');
  const header = hex([...be32(n), 0x00, 0x0D]);
  const first = out.findIndex(p => hex(p.subarray(5, 11)) === header);
  return out.slice(first, out.findIndex((p, i) => i >= first && p[4] === 4) + 1);
}

test('a raw packet is a 4-byte size, a type and the data', () => {
  assert.equal(hex(encodeRaw(1, [0, 0, 4, 0])), '00 00 00 04 01 00 00 04 00');
  assert.equal(hex(encodeRaw(5, [0xE0, 0x00])), '00 00 00 02 05 E0 00');
  assert.deepEqual(decodeRaw(fromHex('00 00 00 02 05 E0 00 99')), { type: 5, data: fromHex('E0 00'), length: 7 });
  assert.equal(decodeRaw(fromHex('00 00 00 04 01 00')), null, 'an incomplete packet');
});

test('observed on hardware: the mode ping goes as one type 4 raw packet', async () => {
  const { sim } = await connect();
  assert.deepEqual(dataPackets(sim, 'out').map(hex), ['00 00 00 10 04 00 00 00 0A 00 01 00 03 00 01 00 00 00 00 07 D0']);
});

test('a virtual packet larger than the allocation continues in type 3 packets and ends in a type 4', async () => {
  const { sim } = await connect({ allocation: 13 });
  assert.deepEqual(dataPackets(sim, 'out').map(hex), [
    '00 00 00 08 03 00 00 00 0A 00 01 00 03',
    '00 00 00 08 04 00 01 00 00 00 00 07 D0',
  ]);
  noViolations(sim);
});

test('contents split at the allocation arrive whole', async () => {
  for (const [allocation, n] of [[1023, 4000], [255, 4000], [13, 40]]) {
    const { sim, link } = await connect({ allocation });
    const e = makeEntry({ name: 'SPLIT', type: TYPE.APPVAR, body: patterned(n, allocation) });
    await link.send(e);
    const packets = contentsPackets(sim, e.data.length);
    assert.ok(packets.slice(0, -1).every(p => p[4] === 3 && p.length === allocation), `${allocation}: full type 3 packets`);
    assert.equal(packets.at(-1)[4], 4, `${allocation}: then a type 4`);
    assert.deepEqual(sim.get('SPLIT', TYPE.APPVAR).data, e.data);
    noViolations(sim);
  }
});

test('a virtual packet from the calculator joins from its raw packets', () => {
  assert.deepEqual(joinVirtual([fromHex('00 00 00 02 00 0D'), fromHex('01 02')]), { type: VPKT.VAR_CNTS, data: fromHex('01 02') });
});

test('a virtual packet whose size field disagrees with its bytes is a protocol error', () => {
  assert.throws(() => joinVirtual([fromHex('00 00 00 09 00 0D 01')]), { code: 'PROTOCOL', message: /declared 9 bytes but carried 1/ });
});

test('a virtual packet whose first raw packet is shorter than its header is a protocol error', () => {
  assert.throws(() => joinVirtual([fromHex('00 00 00')]), { code: 'PROTOCOL', message: /6-byte header/ });
  assert.throws(() => joinVirtual([fromHex('00 00 00'), fromHex('01 00 0D 01')]), { code: 'PROTOCOL', message: /6-byte header/ }, 'a header split across raw packets');
});

test('observed on hardware: an exact fill ends on its full last packet, at 1012 and 2030 bytes', async () => {
  for (const [n, packets] of [[1012, [[4, 1018]]], [2030, [[3, 1018], [4, 1018]]]]) {
    const { sim, link } = await connect();
    // n counts the app variable's own size word, so 6 + n fills 1018-byte packets exactly.
    const e = makeEntry({ name: 'FULL', type: TYPE.APPVAR, body: patterned(n - 2, 5) });
    await link.send(e);
    assert.deepEqual(sim.get('FULL', TYPE.APPVAR).data, e.data);
    assert.deepEqual(shape(contentsPackets(sim, n)), packets, `${n}: no empty packet after the last full one`);
    noViolations(sim);
  }
});

test('observed on hardware: a final packet filling whole USB packets is followed by a zero-length write (53 and 1071 bytes)', async () => {
  assert.equal(needsZeroLength(59), true, '53 bytes of contents: 6 + 53 + 5 = 64');
  assert.equal(needsZeroLength(1018), false);
  // [variable size, zero-length writes]: 1071 is two packets, the last 6 + 1071 - 1018 + 5 = 64 bytes.
  for (const [n, zlp] of [[52, 0], [53, 1], [54, 0], [117, 1], [1070, 0], [1071, 1], [1072, 0], [2089, 1]]) {
    const { sim, link } = await connect();
    const e = makeEntry({ name: 'EDGE', type: TYPE.APPVAR, data: patterned(n, n) });
    await link.send(e);
    assert.deepEqual(sim.get('EDGE', TYPE.APPVAR).data, e.data, `${n} bytes arrived`);
    const out = written(sim);
    assert.equal(out.filter(p => p.length === 0).length, zlp, `${n} bytes`);
    out.forEach((p, i) => {
      if (p.length === 0) assert.ok(out[i - 1][4] === 4 && out[i - 1].length % 64 === 0, 'only after a final packet of whole USB packets');
    });
    noViolations(sim);
  }
  const { sim, link } = await connect();
  const program = makeEntry({ name: 'EDGEPRG', type: TYPE.PROGRAM, body: patterned(1069, 3) });
  await link.sendFile(parseFile(buildFile([program])));
  assert.deepEqual(sim.get('EDGEPRG', TYPE.PROGRAM).data, program.data);
  assert.equal(written(sim).filter(p => p.length === 0).length, 1);
  noViolations(sim);
});

async function sendsWithin(allocation, perPacket) {
  const { sim, link } = await connect({ allocation });
  assert.equal(link.bufferSize, perPacket);
  const e = makeEntry({ name: 'BIG', type: TYPE.APPVAR, body: patterned(5000, 11) });
  await link.send(e);
  const out = dataPackets(sim, 'out');
  assert.ok(out.every(p => p.length - 5 <= perPacket), `${allocation}: no packet over ${perPacket} data bytes`);
  assert.ok(out.some(p => p.length - 5 === perPacket), `${allocation}: full packets are used`);
  assert.deepEqual((await link.receive('BIG', TYPE.APPVAR)).data, e.data);
  assert.ok(dataPackets(sim, 'in').every(p => p.length - 5 <= perPacket), `${allocation}: the calculator keeps to it too`);
  noViolations(sim);
}

test('observed on hardware: an allocation of 1023 means 1018 data bytes a packet', async () => {
  await sendsWithin(1023, 1018);
});

test('a smaller allocation also counts the header, which libticalcs does not', async () => {
  // Never observed below 1023: celink leans small, since an oversize packet
  // wedges the calculator and a short one costs nothing.
  for (const [allocation, perPacket] of [[1018, 1013], [255, 250]]) await sendsWithin(allocation, perPacket);
});

test('a larger allocation is capped at 1018 data bytes a packet', async () => {
  await sendsWithin(4096, 1018);
});

test('a buffer size request in place of an acknowledgement is answered and used', async () => {
  // The host's data packets: 1 the ping, 2 the Request to Send, 3 the first
  // contents packet. After that one the calculator asks for 250.
  const { sim, link } = await connect({ renegotiate: { afterPackets: 3, size: 250 } });
  const e = makeEntry({ name: 'RENEG', type: TYPE.APPVAR, body: patterned(4000, 4) });
  await link.send(e);
  assert.deepEqual(sim.get('RENEG', TYPE.APPVAR).data, e.data);
  assert.equal(link.bufferSize, 245);
  const out = written(sim);
  const answer = out.findIndex(p => p[4] === 2);
  assert.equal(hex(out[answer]), '00 00 00 04 02 00 00 00 FA', 'the host answered 250');
  assert.equal(out[answer - 1].length, 1023, 'the packet before it was full size');
  assert.ok(out.slice(answer + 1).every(p => p.length <= 250));
  noViolations(sim);
});

test('a buffer size request above 1024 is answered with the size asked for, and packets stay at 1018', async () => {
  const { sim, link } = await connect({ renegotiate: { afterPackets: 3, size: 2048 } });
  const e = makeEntry({ name: 'RENEG', type: TYPE.APPVAR, body: patterned(4000, 5) });
  await link.send(e);
  assert.deepEqual(sim.get('RENEG', TYPE.APPVAR).data, e.data);
  assert.equal(link.bufferSize, 1018);
  const out = written(sim);
  const answer = out.findIndex(p => p[4] === 2);
  assert.equal(hex(out[answer]), '00 00 00 04 02 00 00 08 00', 'the host answered 2048');
  assert.ok(out.slice(answer + 1).every(p => p.length <= 1023));
  noViolations(sim);
});

test('an acknowledgement must be E0 00, in 2 or 4 bytes, or it is a protocol error', async () => {
  for (const [ack, ok] of [[[0xE0, 0x00, 0x00, 0x00], true], [[0xE0, 0x01], false], [[0x00, 0x00], false]]) {
    const { sim, link } = await connect();
    sim.ackBytes = ack;
    const sending = link.send(makeEntry({ name: 'ACK', type: TYPE.APPVAR, body: patterned(10) }));
    if (ok) assert.equal((await sending).bytes, 12, hex(ack));
    else await assert.rejects(sending, { code: 'PROTOCOL', message: /did not acknowledge/ }, hex(ack));
  }
});

test('a raw packet from the calculator larger than 1023 bytes is a protocol error and closes the link', async () => {
  const { sim, link } = await connect();
  sim.intercept = type => type === VPKT.PARAM_REQ && (sim.queueRaw(4, new Uint8Array(1024)), true);
  await assert.rejects(link.info(), { code: 'PROTOCOL', message: /1024 bytes; the most is 1023/ });
  assert.equal(link.opened, false);
});
