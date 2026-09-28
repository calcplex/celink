// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFile, buildFile, makeEntry, typeName, nameToBytes, nameToString, checksum, TYPE,
} from '../tifiles.mjs';

const enc = s => new TextEncoder().encode(s);

test('typeName knows the common ids and falls back to hex', () => {
  assert.equal(typeName(0x05), 'program');
  assert.equal(typeName(0x06), 'protected program');
  assert.equal(typeName(0x15), 'app variable');
  assert.equal(typeName(0x00), 'real');
  assert.equal(typeName(0x01), 'list');
  assert.equal(typeName(0x02), 'matrix');
  assert.equal(typeName(0x03), 'equation');
  assert.equal(typeName(0x04), 'string');
  assert.equal(typeName(0x0C), 'complex');
  assert.equal(typeName(0x0D), 'list');
  assert.equal(typeName(0x1A), 'image');
  assert.equal(typeName(0x17), 'group');
  assert.equal(typeName(0x24), 'Flash app');
  assert.equal(typeName(0x42), 'type 0x42');
});

test('a built program file has the exact documented layout', () => {
  // "HELLO" with tokens Disp "HI"  ->  DE 2A 48 49 2A
  const tokens = Uint8Array.of(0xDE, 0x2A, 0x48, 0x49, 0x2A);
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: tokens });
  const f = buildFile([e], { comment: 'test' });
  assert.equal(String.fromCharCode(...f.subarray(0, 8)), '**TI83F*');
  assert.deepEqual([...f.subarray(8, 11)], [0x1A, 0x0A, 0x00]);
  assert.equal(String.fromCharCode(...f.subarray(11, 15)), 'test');
  assert.equal(f[15], 0);
  const secLen = f[53] | (f[54] << 8);
  assert.equal(secLen, 17 + 7);
  assert.equal(f.length, 55 + secLen + 2);
  const s = f.subarray(55);
  assert.deepEqual([...s.subarray(0, 5)], [13, 0, 7, 0, 0x05]);
  assert.equal(String.fromCharCode(...s.subarray(5, 10)), 'HELLO');
  assert.deepEqual([...s.subarray(10, 13)], [0, 0, 0]);
  assert.deepEqual([...s.subarray(13, 17)], [0, 0, 7, 0]);
  assert.deepEqual([...s.subarray(17, 24)], [5, 0, 0xDE, 0x2A, 0x48, 0x49, 0x2A]);
  const sum = [...f.subarray(55, 55 + secLen)].reduce((a, x) => a + x, 0) & 0xFFFF;
  assert.deepEqual([...f.subarray(55 + secLen)], [sum & 0xFF, sum >> 8]);
  assert.equal(checksum(Uint8Array.of(0xFF, 0xFF, 0xFF)), 0x02FD);
  assert.equal(checksum(new Uint8Array(300).fill(0xFF)), (300 * 255) & 0xFFFF, 'wraps at 16 bits');
});

test('parse/build round trip: program, app variable, archived flag', () => {
  const prog = makeEntry({ name: 'AθB', type: TYPE.PROGRAM, body: enc('abc') });
  const appv = makeEntry({ name: 'MYDATA', type: TYPE.APPVAR, body: new Uint8Array(3000).map((_, i) => i & 0xFF), archived: true, version: 0 });
  for (const e of [prog, appv]) {
    const f = buildFile([e]);
    const { comment, entries } = parseFile(f);
    assert.equal(comment, 'Created by celink');
    assert.equal(entries.length, 1);
    const r = entries[0];
    assert.equal(r.name, e.name);
    assert.deepEqual(r.nameBytes, e.nameBytes);
    assert.equal(r.type, e.type);
    assert.equal(r.typeName, e.typeName);
    assert.equal(r.archived, e.archived);
    assert.equal(r.size, e.data.length);
    assert.deepEqual(r.data, e.data);
    assert.deepEqual(buildFile(entries), f, 'rebuild is byte-identical');
  }
  assert.equal(parseFile(buildFile([prog])).entries[0].nameBytes[1], 0x5B, 'θ is token 0x5B');
});

test('a group file with three entries parses all of them in order', () => {
  const a = makeEntry({ name: 'GAME', type: TYPE.PROGRAM, body: enc('main') });
  const b = makeEntry({ name: 'GAMEDAT', type: TYPE.APPVAR, body: new Uint8Array(500).fill(7) });
  const c = makeEntry({ name: 'L1', type: TYPE.LIST, data: Uint8Array.of(1, 0, 0, 0x80, 0x10, 0, 0, 0, 0, 0, 0) });
  const f = buildFile([a, b, c], { comment: 'group' });
  const { entries } = parseFile(f);
  assert.deepEqual(entries.map(e => e.name), ['GAME', 'GAMEDAT', 'L₁']);
  assert.deepEqual(entries.map(e => e.type), [0x05, 0x15, 0x01]);
  assert.deepEqual([...entries[2].nameBytes.subarray(0, 2)], [0x5D, 0x00]);
  assert.deepEqual(buildFile(entries, { comment: 'group' }), f);
});

test('11-byte (no version/flag) entry headers parse', () => {
  // Hand-built old-style section: hdr 11, len 4, type 5, name "OLD", len 4, data.
  const sec = [11, 0, 4, 0, 5, 0x4F, 0x4C, 0x44, 0, 0, 0, 0, 0, 4, 0, 2, 0, 0xAB, 0xCD];
  const f = new Uint8Array(55 + sec.length + 2);
  f.set(enc('**TI83F*')); f[8] = 0x1A; f[9] = 0x0A;
  f[53] = sec.length; f.set(sec, 55);
  const s = checksum(Uint8Array.from(sec));
  f[55 + sec.length] = s & 0xFF; f[56 + sec.length] = s >> 8;
  const { entries } = parseFile(f);
  assert.equal(entries[0].name, 'OLD');
  assert.equal(entries[0].version, 0);
  assert.equal(entries[0].archived, false);
  assert.deepEqual([...entries[0].data], [2, 0, 0xAB, 0xCD]);
});

test('parseFile refuses real damage with a stable code, and warns about what TI software tolerates', () => {
  const f = buildFile([makeEntry({ name: 'X', type: TYPE.PROGRAM, body: enc('1') })]);
  assert.deepEqual(parseFile(f).warnings, []);
  const bad = f.slice(); bad[60] ^= 0xFF;
  assert.deepEqual(parseFile(bad).warnings.map(w => w.code), ['BAD_CHECKSUM']);
  assert.deepEqual(parseFile(f.subarray(0, f.length - 1)).warnings.map(w => w.code), ['NO_CHECKSUM']);
  assert.throws(() => parseFile(f.subarray(0, f.length - 3)), { code: 'BAD_FILE' }, 'data cut short');
  const junk = new Uint8Array(f.length + 1); junk.set(f);
  assert.deepEqual(parseFile(junk).warnings.map(w => w.code), ['TRAILING_BYTES']);
  const magic = f.slice(); magic[2] = 0x58;
  assert.throws(() => parseFile(magic), { code: 'BAD_FILE' });
  const flash = f.slice(); flash.set(enc('**TIFL**'));
  assert.throws(() => parseFile(flash), { code: 'BAD_FILE' }, 'a variable file with an application signature is read as a damaged application file');
  assert.throws(() => parseFile(new Uint8Array(10)), { code: 'BAD_FILE' });
});

test('names: tokens, θ, escapes, limits', () => {
  // [typed, type, bytes, the calculator's spelling]
  const cases = [
    ['L1', TYPE.LIST, [0x5D, 0x00], 'L₁'], ['L6', TYPE.LIST, [0x5D, 0x05], 'L₆'],
    ['[A]', TYPE.MATRIX, [0x5C, 0x00], '[A]'], ['Y1', TYPE.EQUATION, [0x5E, 0x10], 'Y₁'],
    ['Y0', TYPE.EQUATION, [0x5E, 0x19], 'Y₀'], ['Str1', TYPE.STRING, [0xAA, 0x00], 'Str1'],
    ['Str0', TYPE.STRING, [0xAA, 0x09], 'Str0'], ['θ', TYPE.REAL, [0x5B], 'θ'],
    ['⌊ABC', TYPE.LIST, [0x5D, 0x41, 0x42, 0x43], 'ABC'], ['A{7B}', TYPE.PROGRAM, [0x41, 0x7B], 'A{7B}'],
  ];
  for (const [s, t, bytes, spelled] of cases) {
    const b = nameToBytes(s, t);
    assert.equal(b.length, 8);
    assert.deepEqual([...b.subarray(0, bytes.length)], bytes, s);
    assert.equal(nameToString(b, t), spelled);
  }
  assert.deepEqual([...nameToBytes('L₁', TYPE.LIST).subarray(0, 2)], [0x5D, 0x00], 'subscript form');
  assert.deepEqual([...nameToBytes('Y₀', TYPE.EQUATION).subarray(0, 2)], [0x5E, 0x19]);
  assert.throws(() => nameToBytes('TOOLONGNAME', TYPE.PROGRAM), { code: 'BAD_NAME' });
  assert.throws(() => nameToBytes('', TYPE.PROGRAM), { code: 'BAD_NAME' });
  assert.throws(() => nameToBytes('ÄB', TYPE.PROGRAM), { code: 'BAD_NAME' });
});

test('buildFile refuses oversize contents', () => {
  const big = makeEntry({ name: 'BIG', type: TYPE.APPVAR, data: new Uint8Array(40000) });
  assert.throws(() => buildFile([big, big]), { code: 'TOO_LARGE' });
  assert.throws(() => buildFile([]), { code: 'BAD_ENTRY' });
});
