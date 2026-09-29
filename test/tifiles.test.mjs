// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile, buildFile, makeEntry, typeName, nameToBytes, nameToString, checksum, TYPE } from '../tifiles.mjs';
import { connect, noViolations, patterned, utf8 } from './testkit.mjs';

/** A variable file around a raw data section, the declared length and checksum given or computed. */
function fileOf(section, { declared = section.length, sum = checksum(Uint8Array.from(section)), tail = [] } = {}) {
  const f = new Uint8Array(55 + section.length + 2 + tail.length);
  f.set(utf8('**TI83F*'));
  f.set([0x1A, 0x0A], 8);
  f.set(utf8('fixture'), 11);
  f.set([declared & 0xFF, declared >> 8], 53);
  f.set(section, 55);
  f.set([sum & 0xFF, sum >> 8, ...tail], 55 + section.length);
  return f;
}

/** One entry's bytes; 13-byte header unless `headerLength` says 11. */
function entryBytes({ type = 5, name = 'A', data = [1, 0, 0x41], version = 0, flag = 0, headerLength = 13, length2 = data.length }) {
  const n = new Uint8Array(8);
  n.set(utf8(name));
  const extra = headerLength === 13 ? [version, flag] : [];
  return [headerLength, 0, data.length & 0xFF, data.length >> 8, type, ...n, ...extra, length2 & 0xFF, length2 >> 8, ...data];
}

const codes = r => r.warnings.map(w => w.code);
const padded = bytes => { const b = new Uint8Array(8); b.set(bytes); return b; };

test('typeName knows what a CE lists', () => {
  const names = { 0x00: 'real', 0x01: 'list', 0x05: 'program', 0x06: 'protected program', 0x0D: 'list', 0x0F: 'window settings',
    0x15: 'app variable', 0x17: 'group', 0x1A: 'image', 0x24: 'Flash app', 0x26: 'ID list', 0x3E: 'license', 0x42: 'type 0x42' };
  for (const [id, name] of Object.entries(names)) assert.equal(typeName(+id), name);
});

test('a built program file has the documented layout', () => {
  const e = makeEntry({ name: 'HELLO', type: TYPE.PROGRAM, body: Uint8Array.of(0xDE, 0x2A, 0x48, 0x49, 0x2A) }); // Disp "HI"
  const f = buildFile([e], { comment: 'test' });
  assert.equal(String.fromCharCode(...f.subarray(0, 11)), '**TI83F*\x1A\x0A\x00');
  assert.equal(String.fromCharCode(...f.subarray(11, 16)), 'test\x00');
  const length = f[53] | (f[54] << 8);
  assert.equal(length, 17 + 7);
  assert.equal(f.length, 55 + length + 2);
  assert.deepEqual([...f.subarray(55, 72)], [13, 0, 7, 0, 5, ...utf8('HELLO'), 0, 0, 0, 0, 0, 7, 0]);
  assert.deepEqual([...f.subarray(72, 79)], [5, 0, 0xDE, 0x2A, 0x48, 0x49, 0x2A]);
  const sum = checksum(f.subarray(55, 55 + length));
  assert.deepEqual([...f.subarray(55 + length)], [sum & 0xFF, sum >> 8]);
  assert.equal(checksum(new Uint8Array(300).fill(0xFF)), (300 * 255) & 0xFFFF, 'the checksum wraps at 16 bits');
});

test('parse and build round-trip a program, an archived app variable and a group', () => {
  const entries = [
    makeEntry({ name: 'AθB', type: TYPE.PROGRAM, body: utf8('abc') }),
    makeEntry({ name: 'MYDATA', type: TYPE.APPVAR, body: patterned(3000), archived: true }),
    makeEntry({ name: 'L1', type: TYPE.LIST, data: Uint8Array.of(1, 0, 0, 0x80, 0x10, 0, 0, 0, 0, 0, 0) }),
  ];
  for (const group of [[entries[0]], [entries[1]], entries]) {
    const f = buildFile(group);
    const parsed = parseFile(f);
    assert.equal(parsed.comment, 'Created by celink');
    assert.deepEqual(parsed.entries, group);
    assert.deepEqual(buildFile(parsed.entries), f, 'rebuilt byte for byte');
  }
  assert.deepEqual(parseFile(buildFile(entries)).entries.map(e => e.name), ['AθB', 'MYDATA', 'L₁']);
});

test('buildFile refuses an empty list and contents past 65,535 bytes', () => {
  const big = makeEntry({ name: 'BIG', type: TYPE.APPVAR, data: new Uint8Array(40000) });
  assert.throws(() => buildFile([big, big]), { code: 'TOO_LARGE' });
  assert.throws(() => buildFile([]), { code: 'BAD_ENTRY' });
});

test('a wrong checksum is a warning and the variables still come out', () => {
  const section = [...entryBytes({ name: 'ONE' }), ...entryBytes({ name: 'TWO', data: [2, 0, 0x42, 0x43] })];
  const r = parseFile(fileOf(section, { sum: 0x1234 }));
  assert.deepEqual(codes(r), ['BAD_CHECKSUM']);
  assert.deepEqual(r.entries.map(e => [e.name, [...e.data]]), [['ONE', [1, 0, 0x41]], ['TWO', [2, 0, 0x42, 0x43]]]);
});

test('a file that ends before its checksum is a warning and the variables still come out', () => {
  const f = fileOf(entryBytes({ name: 'ONE' }));
  for (const cut of [1, 2]) {
    const r = parseFile(f.subarray(0, f.length - cut));
    assert.deepEqual(codes(r), ['NO_CHECKSUM'], `${cut} byte(s) cut`);
    assert.deepEqual([...r.entries[0].data], [1, 0, 0x41]);
  }
});

test('the signature is matched in any case, and the three bytes after it are not checked', () => {
  const f = fileOf(entryBytes({ name: 'ANY' }));
  f.set(utf8('**ti83f*'));
  f.set([0x00, 0x00, 0x13], 8);
  assert.deepEqual(codes(parseFile(f)), []);
  assert.equal(parseFile(f).entries[0].name, 'ANY');
});

test('a declared length that disagrees with the entries, and bytes after the checksum, are warnings', () => {
  const section = entryBytes({ name: 'SHORT', data: [3, 0, 1, 2, 3] });
  const short = parseFile(fileOf(section, { declared: section.length - 4 }));
  assert.deepEqual(codes(short), ['DECLARED_LENGTH']);
  assert.deepEqual([...short.entries[0].data], [3, 0, 1, 2, 3], 'the entry is bounded by the file, not the declared length');
  assert.deepEqual(codes(parseFile(fileOf(section, { tail: [0xAA, 0xBB, 0xCC] }))), ['TRAILING_BYTES']);
});

test('the two copies of an entry\'s length may disagree: the first is used, with a warning', () => {
  const r = parseFile(fileOf(entryBytes({ name: 'TWICE', data: [1, 0, 0x41], length2: 9 })));
  assert.deepEqual(codes(r), ['LENGTH_MISMATCH']);
  assert.deepEqual([...r.entries[0].data], [1, 0, 0x41]);
});

test('11-byte headers parse, entry by entry, and an unknown header length is read as one', () => {
  const eleven = entryBytes({ name: 'OLD', headerLength: 11, data: [2, 0, 0xAB, 0xCD] });
  const mixed = parseFile(fileOf([...eleven, ...entryBytes({ name: 'NEW', version: 5 })]));
  assert.deepEqual(codes(mixed), []);
  assert.deepEqual(mixed.entries.map(e => [e.name, e.version, e.archived]), [['OLD', 0, false], ['NEW', 5, false]]);
  eleven[0] = 12;
  const odd = parseFile(fileOf(eleven));
  assert.deepEqual(codes(odd), ['HEADER_LENGTH']);
  assert.deepEqual([...odd.entries[0].data], [2, 0, 0xAB, 0xCD]);
});

const entryOf = options => parseFile(fileOf(entryBytes(options))).entries[0];

test('the archived word 0x0080, from older tools, means archived at version 0', () => {
  const flags = options => { const e = entryOf(options); return [e.archived, e.version]; };
  assert.deepEqual(flags({ version: 0x80, flag: 0x00 }), [true, 0]);
  assert.deepEqual(flags({ version: 0x05, flag: 0x80 }), [true, 5]);
});

test('a 0x55BB-byte picture written as version 0 is version 10', () => {
  const picture = new Array(0x55BB).fill(0);
  const pic1 = entryOf({ type: TYPE.PICTURE, name: '\x60\x00', data: picture });
  assert.deepEqual([pic1.name, pic1.version], ['Pic1', 10]);
  assert.equal(entryOf({ type: TYPE.PICTURE, name: '\x60\x00', data: picture.slice(1) }).version, 0, 'only at that exact size');
});

test('damaged files are refused with BAD_FILE', () => {
  const section = entryBytes({ name: 'X' });
  assert.throws(() => parseFile(fileOf(section, { declared: section.length + 10 })), { code: 'BAD_FILE', message: /only/ }, 'declared past the end');
  assert.throws(() => parseFile(fileOf(section).subarray(0, 55 + section.length - 1)), { code: 'BAD_FILE' }, 'data past the end');
  assert.throws(() => parseFile(fileOf([], { declared: 0 })), { code: 'BAD_FILE', message: /no variables/ });
  const huge = new Uint8Array(8 * 1024 * 1024);
  huge.set(fileOf(section));
  assert.throws(() => parseFile(huge), { code: 'BAD_FILE', message: /8 MB/ });
  const magic = fileOf(section);
  magic[2] = 0x58;
  assert.throws(() => parseFile(magic), { code: 'BAD_FILE' });
  assert.throws(() => parseFile(new Uint8Array(10)), { code: 'BAD_FILE' });
});

// The pages show these sentences as they are, for example when a school filter
// serves an HTML page in place of a download.
test('the two refusals a bad download meets most keep their wording', () => {
  const section = entryBytes({ name: 'X' });
  assert.throws(() => parseFile(utf8('<!doctype html><html><body>Blocked</body></html>')), {
    message: 'Not a TI-83 Plus/TI-84 Plus variable file (the header does not start with **TI83F*).',
  });
  const cut = fileOf(section, { declared: section.length + 10 });
  assert.throws(() => parseFile(cut), {
    message: `The file says its data section is ${section.length + 10} bytes, but the file is only ${cut.length} bytes. It is truncated or damaged.`,
  });
});

test('a file with a wrong checksum still sends', async () => {
  const { sim, link } = await connect();
  const f = buildFile([makeEntry({ name: 'SUMBAD', type: TYPE.PROGRAM, body: patterned(300) })]);
  f[f.length - 1] ^= 0xFF;
  const parsed = parseFile(f);
  assert.deepEqual(codes(parsed), ['BAD_CHECKSUM']);
  await link.sendFile(parsed);
  assert.deepEqual(sim.get('SUMBAD', TYPE.PROGRAM).data, parsed.entries[0].data);
  noViolations(sim);
});

test('built-in names detokenize as libticonv spells them, and typed names tokenize back', () => {
  const rows = [
    // [type, token bytes, the calculator's spelling, other accepted spellings]
    [TYPE.LIST, [0x5D, 0x00], 'L₁', ['L1']], [TYPE.LIST, [0x5D, 0x08], 'L₉', ['L9']], [TYPE.LIST, [0x5D, 0x09], 'L₀', ['L0']],
    [TYPE.LIST, [0x5D, 0x40], 'IDList', []], [TYPE.LIST, [0x5D, 0x41, 0x42, 0x43], 'ABC', ['⌊ABC']],
    [TYPE.LIST, [0x5D, 0x5B, 0x41], 'θA', ['⌊θA']], [TYPE.LIST_0D, [0x5D, 0x02], 'L₃', ['L3']],
    [TYPE.EQUATION, [0x5E, 0x10], 'Y₁', ['Y1']], [TYPE.EQUATION, [0x5E, 0x19], 'Y₀', ['Y0']],
    [TYPE.EQUATION, [0x5E, 0x20], 'X₁⊺', ['X1T']], [TYPE.EQUATION, [0x5E, 0x2B], 'Y₆⊺', ['Y6T']],
    [TYPE.EQUATION, [0x5E, 0x40], 'r₁', ['r1']], [TYPE.EQUATION, [0x5E, 0x45], 'r₆', ['r6']],
    [TYPE.EQUATION, [0x5E, 0x80], 'u', []], [TYPE.EQUATION, [0x5E, 0x82], 'w', []],
    [TYPE.MATRIX, [0x5C, 0x00], '[A]', []], [TYPE.MATRIX, [0x5C, 0x09], '[J]', []],
    [TYPE.STRING, [0xAA, 0x00], 'Str1', []], [TYPE.STRING, [0xAA, 0x09], 'Str0', []],
    [TYPE.PICTURE, [0x60, 0x00], 'Pic1', []], [TYPE.GDB, [0x61, 0x09], 'GDB0', []],
    [TYPE.IMAGE, [0x3C, 0x00], 'Image1', []], [TYPE.IMAGE, [0x3C, 0x09], 'Image0', []],
    [TYPE.REAL, [0x5B], 'θ', []], [TYPE.PROGRAM, [0x41, 0x5B, 0x42], 'AθB', []],
  ];
  for (const [type, bytes, spelled, others] of rows) {
    assert.equal(nameToString(padded(bytes), type), spelled, `${bytes} -> ${spelled}`);
    for (const typed of [spelled, ...others]) assert.deepEqual(nameToBytes(typed, type), padded(bytes), `${typed} -> bytes`);
  }
  assert.deepEqual([TYPE.WINDOW, TYPE.RCL_WINDOW, TYPE.TABLE_SETUP].map(t => nameToString(new Uint8Array(8), t)), ['Window', 'RclWin', 'TblSet']);
});

test('a token names only a variable of its own type, where libticonv reads one whatever the type', () => {
  for (const [name, type] of [['<A', TYPE.PROGRAM], ['abc', TYPE.APPVAR], ['aVar', TYPE.APPVAR], ['`x', TYPE.APPVAR], ['a1', TYPE.FLASH_APP], ['^Z', TYPE.PROGRAM]]) {
    assert.equal(nameToString(nameToBytes(name, type), type), name);
  }
});

test('names read through the TI-83 Plus character set, both ways', () => {
  assert.equal(nameToString(padded([0x41, 0x80, 0x89, 0x8D, 0xBB, 0x24]), TYPE.PROGRAM), 'A₀₉Äα⁴');
  assert.deepEqual(nameToBytes('A₀₉Äα⁴', TYPE.PROGRAM), padded([0x41, 0x80, 0x89, 0x8D, 0xBB, 0x24]));
  assert.deepEqual(nameToBytes('x\u0305?u', TYPE.PROGRAM), padded([0xCB, 0x3F, 0x75]), 'a character that is its own code wins');
  assert.equal(nameToString(padded([0x41, 0x00, 0x42]), TYPE.PROGRAM), 'A', 'a name ends at its first NUL');
});

test('a name the calculator cannot hold is BAD_NAME', () => {
  assert.throws(() => nameToBytes('TOOLONGNAME', TYPE.PROGRAM), { code: 'BAD_NAME' });
  assert.throws(() => nameToBytes('', TYPE.PROGRAM), { code: 'BAD_NAME' });
  assert.throws(() => nameToBytes('A€', TYPE.PROGRAM), { code: 'BAD_NAME', message: /"€"/ });
  assert.throws(() => nameToBytes('ABCDEFGH', TYPE.LIST), { code: 'BAD_NAME' }, 'a named list holds 7 characters');
});
