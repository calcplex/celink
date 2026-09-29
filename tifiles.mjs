// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Derived from libtifiles and libticonv (tilibs), Copyright (C) the tilibs authors; see CREDITS.md in the celink repository.
//
// TI-83 Plus family files: variables (.8xp, .8xv, .8xg, ...) and Flash
// applications (.8ek). File numbers are little-endian, unlike the USB protocol.
//
// Variable file:
//   0    8   "**TI83F*"
//   8    3   1A 0A 00
//   11   42  comment, NUL padded
//   53   2   length of the data section
//   55   n   one or more entries
//   55+n 2   checksum: sum of the data section's bytes, low 16 bits
//
// Entry:
//   2  header length: 13, or 11 without the version and flag bytes
//   2  data length
//   1  type
//   8  name, NUL padded
//   1  version                 (13-byte header only)
//   1  flag, 0x80 = archived   (13-byte header only)
//   2  data length, again
//   n  data

export const TYPE = Object.freeze({
  REAL: 0x00, LIST: 0x01, MATRIX: 0x02, EQUATION: 0x03, STRING: 0x04,
  PROGRAM: 0x05, PROTECTED_PROGRAM: 0x06, PICTURE: 0x07, GDB: 0x08,
  NEW_EQUATION: 0x0B, COMPLEX: 0x0C, LIST_0D: 0x0D,
  WINDOW: 0x0F, RCL_WINDOW: 0x10, TABLE_SETUP: 0x11, BACKUP: 0x13,
  APPVAR: 0x15, TEMP_PROGRAM: 0x16, GROUP: 0x17, FRACTION: 0x18, DIRECTORY: 0x19,
  IMAGE: 0x1A, COMPLEX_FRACTION: 0x1B, RADICAL: 0x1C, COMPLEX_RADICAL: 0x1D,
  COMPLEX_PI: 0x1E, COMPLEX_PI_FRACTION: 0x1F, PI: 0x20, PI_FRACTION: 0x21,
  OS: 0x23, FLASH_APP: 0x24, CERTIFICATE: 0x25, ID_LIST: 0x26, GET_CERTIFICATE: 0x27,
  CLOCK: 0x29, LICENSE: 0x3E,
});

const TYPE_NAMES = {
  0x00: 'real', 0x01: 'list', 0x02: 'matrix', 0x03: 'equation', 0x04: 'string',
  0x05: 'program', 0x06: 'protected program', 0x07: 'picture', 0x08: 'graph database',
  0x0B: 'equation', 0x0C: 'complex', 0x0D: 'list',
  0x0F: 'window settings', 0x10: 'saved window', 0x11: 'table setup', 0x13: 'backup',
  0x15: 'app variable', 0x16: 'temporary program', 0x17: 'group', 0x18: 'fraction',
  0x19: 'directory', 0x1A: 'image', 0x1B: 'complex fraction', 0x1C: 'radical',
  0x1D: 'complex radical', 0x1E: 'complex pi', 0x1F: 'complex pi fraction', 0x20: 'pi',
  0x21: 'pi fraction', 0x23: 'operating system', 0x24: 'Flash app', 0x25: 'certificate',
  0x26: 'ID list', 0x27: 'get certificate', 0x29: 'clock', 0x3E: 'license',
};

const LIST_TYPES = [TYPE.LIST, TYPE.LIST_0D];
const EQUATION_TYPES = [TYPE.EQUATION, TYPE.NEW_EQUATION];
/** Variables with fixed names and no name bytes of their own. */
const PERMANENT = { [TYPE.WINDOW]: 'Window', [TYPE.RCL_WINDOW]: 'RclWin', [TYPE.TABLE_SETUP]: 'TblSet' };

const MAGIC = '**TI83F*';
const MAX_FILE = 8 * 1024 * 1024;
const HEADER_SIZE = 55;
const COMMENT_SIZE = 42;

export class TIFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TIFileError';
    this.code = code;
  }
}

export function typeName(id) {
  return TYPE_NAMES[id] ?? `type 0x${hex2(id)}`;
}

export function checksum(bytes) {
  let s = 0;
  for (const x of bytes) s = (s + x) & 0xFFFF;
  return s;
}

function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function readLe16(b, o) { return b[o] | (b[o + 1] << 8); }
function readLe32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TIFileError('BAD_FILE', 'Expected file bytes (Uint8Array or ArrayBuffer).');
}

function latin1(b) {
  let s = '';
  for (const c of b) {
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// A name goes over USB as the calculator's own spelling in UTF-8, built the
// way libticonv builds it: the 8 raw bytes are detokenized, then read through
// the TI-83 Plus character set. So list token 5D 00 goes as "L₁", and a named
// list goes without the ⌊ the calculator displays.

/** libticonv's ti83p_charset: TI character code to text. */
const CHARSET = [
  '\u0000', 'η', 'u', 'v', 'w', '▶', '↑', '↓',
  '∫', '×', '°', '¸', '·', '⊺', '³', 'F',
  '√', '´', '²', '∠', '°', 'ʳ', '⊺', '≤',
  '≠', '≥', '−', '𭖤', '→', '?', '↑', '↓',
  ' ', '!', '"', '#', '⁴', '%', '&', '\'',
  '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', ':', ';', '<', '=', '>', '?',
  '@', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
  'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'X', 'Y', 'Z', 'θ', '\\', ']', '^', '_',
  '`', 'a', 'b', 'c', 'd', 'e', 'f', 'g',
  'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w',
  'x', 'y', 'z', '{', '|', '}', '~', '=',
  '₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇',
  '₈', '₉', 'Á', 'À', 'Â', 'Ä', 'á', 'à',
  'â', 'ä', 'É', 'È', 'Ê', 'Ë', 'é', 'è',
  'ê', 'ë', 'Í', 'Ì', 'Î', 'Ï', 'í', 'ì',
  'î', 'ï', 'Ó', 'Ò', 'Ô', 'Ö', 'ó', 'ò',
  'ô', 'ö', 'Ú', 'Ù', 'Û', 'Ü', 'ú', 'ù',
  'û', 'ü', 'Ç', 'ç', 'Ñ', 'ñ', '\'', '`',
  '¨', '¿', '¡', 'α', 'β', 'γ', 'Δ', 'δ',
  'ε', '[', 'λ', 'μ', 'π', 'ρ', 'Σ', 'σ',
  'τ', 'ϕ', 'Ω', 'x̅', 'y̅', '¤', '…', '◀',
  '◾', '?', '−', '²', '°', '³', '\n', '𭒊',
  '?', 'χ', 'F', 'ℯ', 'L', 'N', '_', '→',
  '_', '_', '_', '_', '_', '_', '_', '_',
  '_', '_', '_', '_', '_', '_', '_', '_',
  '_', '_', '$', '_', 'ß', '_', '_', '_',
  '_', '_', '_', '_', '_', '_', '_', '_',
];

// Text to character code. Several codes share a glyph; like libticonv, a
// character that is its own code wins, then the lowest code.
const FROM_CHARSET = new Map();
CHARSET.forEach((c, i) => { if (i && c === String.fromCharCode(i)) FROM_CHARSET.set(c, i); });
CHARSET.forEach((c, i) => { if (i && !FROM_CHARSET.has(c)) FROM_CHARSET.set(c, i); });

const OVERLINE = '̅';
const PARAM_T = 0x0D; // ⊺, the parametric-equation T

function fromCharset(codes) {
  let s = '';
  for (const c of codes) {
    if (c === 0) break;
    s += CHARSET[c];
  }
  return s;
}

function toCharset(text) {
  const chars = [...text];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    if (chars[i + 1] === OVERLINE) c += chars[++i]; // x̄ and ȳ are one character code
    const code = FROM_CHARSET.get(c);
    // libticonv writes '?' instead, which would name a different variable.
    if (code === undefined) throw new TIFileError('BAD_NAME', `"${c}" is not a character the calculator has.`);
    out.push(code);
  }
  return out;
}

const codesOf = s => [...s].map(c => c.charCodeAt(0));
/** Token numbering runs 1..9 then 0: token 0 is L₁, token 9 is L₀. */
const tokenDigit = n => (n === 9 ? 0 : n + 1);
const subscript = d => 0x80 + d;

function equationName(n) {
  if (n >= 0x10 && n <= 0x19) return [0x59, subscript(tokenDigit(n - 0x10))];
  if (n >= 0x20 && n <= 0x2B) return [n & 1 ? 0x59 : 0x58, subscript(((n - 0x20) >> 1) + 1), PARAM_T];
  if (n >= 0x40 && n <= 0x45) return [0x72, subscript(n - 0x40 + 1)];
  if (n >= 0x80 && n <= 0x82) return codesOf('uvw'[n - 0x80]);
  return codesOf('?');
}

// libticonv reads a token whatever the type, so an app variable named "abc"
// would go out as GDB99. Here a token names only a variable of its own type.
const TOKEN_TYPES = {
  0x3C: [TYPE.IMAGE], 0x5C: [TYPE.MATRIX], 0x5D: LIST_TYPES, 0x5E: EQUATION_TYPES,
  0x60: [TYPE.PICTURE], 0x61: [TYPE.GDB], 0xAA: [TYPE.STRING],
};

/** libticonv's detokenize_varname: raw name bytes to TI character codes. */
function detokenize(b, type) {
  const [token, n] = b;
  if (!TOKEN_TYPES[token]?.includes(type)) return [...b];
  switch (token) {
    case 0x3C: return codesOf(`Image${tokenDigit(n)}`);
    case 0x5C: return [0xC1, n <= 9 ? 0x41 + n : 0x3F, 0x5D];
    case 0x5D:
      if (n <= 9) return [0x4C, subscript(tokenDigit(n))];
      if (n === 0x40) return codesOf('IDList');
      return [...b.subarray(1, 8)];
    case 0x5E: return equationName(n);
    case 0x60: return codesOf(`Pic${tokenDigit(n)}`);
    case 0x61: return codesOf(`GDB${tokenDigit(n)}`);
    case 0xAA: return codesOf(`Str${tokenDigit(n)}`);
  }
}

/** The calculator's spelling of an 8-byte raw name; the same text goes on the wire. */
export function nameToString(nameBytes, type) {
  return PERMANENT[type] ?? fromCharset(detokenize(toBytes(nameBytes), type));
}

/**
 * The raw 8-byte name for a readable one. Built-in names are accepted with
 * subscript or plain digits (L₁ or L1, X₁⊺ or X1T); a named list may keep its ⌊.
 */
export function nameToBytes(name, type) {
  const text = String(name);
  const plain = text.replace(/[₀-₉]/gu, d => String(d.codePointAt(0) - 0x2080)).replace(/⊺/gu, 'T');
  const token = builtInToken(plain, type);
  if (token) return padName(token);
  const list = LIST_TYPES.includes(type);
  const codes = toCharset(list ? text.replace(/^⌊/u, '') : text);
  if (list && (codes.length < 1 || codes.length > 7)) throw new TIFileError('BAD_NAME', `List name "${text}" must be 1 to 7 characters.`);
  if (codes.length < 1 || codes.length > 8) throw new TIFileError('BAD_NAME', `Variable name "${text}" must be 1 to 8 characters.`);
  return padName(list ? [0x5D, ...codes] : codes);
}

function builtInToken(name, type) {
  const token = (re, t) => { const m = re.exec(name); return m && t(m); };
  const nth = d => (+d + 9) % 10; // the inverse of tokenDigit
  if (LIST_TYPES.includes(type)) {
    if (name === 'IDList') return [0x5D, 0x40];
    return token(/^L(\d)$/, m => [0x5D, nth(m[1])]);
  }
  if (EQUATION_TYPES.includes(type)) {
    return token(/^Y(\d)$/, m => [0x5E, 0x10 + nth(m[1])])
      ?? token(/^([XY])([1-6])T$/, m => [0x5E, 0x20 + 2 * (m[2] - 1) + (m[1] === 'Y' ? 1 : 0)])
      ?? token(/^r([1-6])$/, m => [0x5E, 0x40 + (m[1] - 1)])
      ?? token(/^([uvw])$/, m => [0x5E, 0x80 + 'uvw'.indexOf(m[1])]);
  }
  switch (type) {
    case TYPE.MATRIX: return token(/^\[([A-J])\]$/, m => [0x5C, m[1].charCodeAt(0) - 0x41]);
    case TYPE.STRING: return token(/^Str(\d)$/, m => [0xAA, nth(m[1])]);
    case TYPE.PICTURE: return token(/^Pic(\d)$/, m => [0x60, nth(m[1])]);
    case TYPE.GDB: return token(/^GDB(\d)$/, m => [0x61, nth(m[1])]);
    case TYPE.IMAGE: return token(/^Image(\d)$/, m => [0x3C, nth(m[1])]);
    default: return null;
  }
}

function padName(b) {
  if (b.length > 8) throw new TIFileError('BAD_NAME', 'A variable name is at most 8 bytes.');
  const out = new Uint8Array(8);
  out.set(b);
  return out;
}

/**
 * A variable entry. For a program or an app variable pass `body` and the
 * 2-byte little-endian size word is added; pass `data` to give the variable's
 * data exactly.
 */
export function makeEntry({ name, type, body, data, version = 0, archived = false }) {
  if (data == null) {
    if (body == null) throw new TIFileError('BAD_ENTRY', 'makeEntry needs `body` or `data`.');
    const b = toBytes(body);
    if (b.length > 0xFFFF - 2) throw new TIFileError('TOO_LARGE', 'A variable body is at most 65,533 bytes.');
    data = new Uint8Array(b.length + 2);
    data[0] = b.length & 0xFF;
    data[1] = b.length >> 8;
    data.set(b, 2);
  }
  data = toBytes(data);
  const nameBytes = nameToBytes(name, type);
  return {
    name: nameToString(nameBytes, type), nameBytes, type, typeName: typeName(type),
    version, archived: !!archived, data, size: data.length,
  };
}

/**
 * Parse a variable file, or a Flash application file (see parseAppFile).
 * Like libtifiles, it reads what TI's software reads: a wrong checksum, a
 * declared section length that disagrees with the entries, disagreeing copies
 * of an entry's length and bytes after the checksum are `warnings`, not errors.
 * A file that ends before its checksum is a warning too (NO_CHECKSUM), where
 * libtifiles refuses it.
 *
 * Returns { comment, entries, warnings: [{ code, message }] }.
 */
export function parseFile(input) {
  const b = toBytes(input);
  if (b.length >= MAX_FILE) throw new TIFileError('BAD_FILE', 'The file is 8 MB or larger, which no variable file is.');
  const sig = latin1(b.subarray(0, 8));
  if (sig === APP_MAGIC) return parseAppFile(b);
  if (sig.toUpperCase() !== MAGIC) throw new TIFileError('BAD_FILE', 'Not a TI-83 Plus/TI-84 Plus variable file (the header does not start with **TI83F*).');
  if (b.length < HEADER_SIZE + 2) throw new TIFileError('BAD_FILE', 'The file is too short to be a variable file.');
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const declared = readLe16(b, 53);
  if (HEADER_SIZE + declared > b.length) {
    throw new TIFileError('BAD_FILE', `The file says its data section is ${declared} bytes, but the file is only ${b.length} bytes. It is truncated or damaged.`);
  }

  // Entries run to the declared length, each bounded by the end of the file
  // rather than by the declared section: TI's software sends files whose
  // declared length is wrong.
  const entries = [];
  let p = HEADER_SIZE;
  while (p < HEADER_SIZE + declared) {
    const { entry, next } = readEntry(b, p, warn);
    entries.push(entry);
    p = next;
  }
  if (entries.length === 0) throw new TIFileError('BAD_FILE', 'The file contains no variables.');

  if (p - HEADER_SIZE !== declared) warn('DECLARED_LENGTH', `The file says its data section is ${declared} bytes, but its variables fill ${p - HEADER_SIZE}.`);
  if (p + 2 > b.length) {
    warn('NO_CHECKSUM', 'The file ends before its checksum.');
  } else {
    const stored = readLe16(b, p);
    const computed = checksum(b.subarray(HEADER_SIZE, p));
    if (stored !== computed) warn('BAD_CHECKSUM', `The checksum does not match (the file says 0x${stored.toString(16)}, its contents add up to 0x${computed.toString(16)}).`);
    if (p + 2 < b.length) warn('TRAILING_BYTES', `${b.length - p - 2} bytes after the checksum were ignored.`);
  }
  return { comment: latin1(b.subarray(11, 11 + COMMENT_SIZE)), entries, warnings };
}

function readEntry(b, p, warn) {
  if (p + 2 > b.length) throw new TIFileError('BAD_FILE', 'A variable entry is cut short.');
  const headerLength = readLe16(b, p);
  // A 13-byte header carries the version and flag. libtifiles reads every
  // later entry as 13 bytes once one is; a file that mixes both forms is
  // read per entry here instead, which does not misparse it.
  const hasVersion = headerLength === 13;
  if (headerLength !== 11 && headerLength !== 13) warn('HEADER_LENGTH', `A variable header says it is ${headerLength} bytes; it was read as the 11-byte form.`);
  const h = p + 2;
  const hl = hasVersion ? 13 : 11;
  if (h + hl + 2 > b.length) throw new TIFileError('BAD_FILE', 'A variable header is cut short.');
  const length = readLe16(b, h);
  const type = b[h + 2];
  const nameBytes = b.slice(h + 3, h + 11);
  let version = 0;
  let archived = false;
  if (hasVersion) {
    // The low byte is the version and bit 15 means archived. Older tools
    // wrote an archived variable as 0x0080; that word is archived, version 0.
    const word = readLe16(b, h + 11);
    if (word === 0x0080) archived = true;
    else {
      version = word & 0xFF;
      archived = (word & 0x8000) !== 0;
    }
  }
  if (readLe16(b, h + hl) !== length) warn('LENGTH_MISMATCH', `The two copies of ${nameToString(nameBytes, type)}'s length disagree; the first was used.`);
  const d = h + hl + 2;
  if (d + length > b.length) throw new TIFileError('BAD_FILE', 'A variable\'s data runs past the end of the file.');
  // Older tools wrote TI-84 Plus C pictures (0x55BB bytes) as version 0; they are version 10.
  if (type === TYPE.PICTURE && length === 0x55BB && version === 0) version = 10;
  const data = b.slice(d, d + length);
  return {
    entry: { name: nameToString(nameBytes, type), nameBytes, type, typeName: typeName(type), version, archived, data, size: length },
    next: d + length,
  };
}

export function buildFile(entries, { comment = 'Created by celink' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TIFileError('BAD_ENTRY', 'buildFile needs at least one entry.');
  if (entries.some(e => e.type === TYPE.FLASH_APP)) throw new TIFileError('BAD_ENTRY', 'A Flash application goes in its own file: use buildAppFile.');
  const parts = entries.map(e => {
    const data = toBytes(e.data);
    if (data.length > 0xFFFF) throw new TIFileError('TOO_LARGE', `Variable ${e.name} is larger than 65,535 bytes.`);
    const out = new Uint8Array(17 + data.length);
    out[0] = 13;
    out[2] = out[15] = data.length & 0xFF;
    out[3] = out[16] = data.length >> 8;
    out[4] = e.type;
    out.set(e.nameBytes ? padName(toBytes(e.nameBytes)) : nameToBytes(e.name, e.type), 5);
    out[13] = e.version ?? 0;
    out[14] = e.archived ? 0x80 : 0x00;
    out.set(data, 17);
    return out;
  });
  const length = parts.reduce((n, x) => n + x.length, 0);
  if (length > 0xFFFF) throw new TIFileError('TOO_LARGE', 'The variables together are larger than one file can hold (65,535 bytes).');
  const file = new Uint8Array(HEADER_SIZE + length + 2);
  file.set(codesOf(MAGIC));
  file.set([0x1A, 0x0A, 0x00], 8);
  file.set(codesOf(String(comment).slice(0, COMMENT_SIZE)).map(c => c & 0xFF), 11);
  file[53] = length & 0xFF;
  file[54] = length >> 8;
  let p = HEADER_SIZE;
  for (const x of parts) {
    file.set(x, p);
    p += x.length;
  }
  const sum = checksum(file.subarray(HEADER_SIZE, p));
  file[p] = sum & 0xFF;
  file[p + 1] = sum >> 8;
  return file;
}

// An application file (.8ek) is one or more sections back to back, each a
// 78-byte header and its data:
//   0   8  "**TIFL**"
//   8   2  revision, major then minor
//   10  1  flags                     11  1  object type
//   12  4  date (BCD day, month, year)
//   16  1  name length               17  8  name
//   48  1  device type (0x73; 0x74 for the TI-73)
//   49  1  data type (0x23 OS, 0x24 application, 0x25 certificate, 0x3E license)
//   73  1  hardware id (0: Intel HEX pages; otherwise flat data)
//   74  4  data length               78  n  data
// A .8ek often carries a license section beside the application.

export const APP_MAGIC = '**TIFL**';
const APP_HEADER = 78;
/** libtifiles' limit on the data length a section may declare. */
export const APP_MAX_DATA = 4 * 1024 * 1024 - 16 * 1024;
const DATA_TYPES = { 0x23: 'operating system', 0x24: 'application', 0x25: 'certificate', 0x3E: 'license' };

/**
 * The name an application carries in its own signed header, or null. The
 * header is a chain of fields from offset 6: a 2-byte big-endian id whose low
 * nibble gives the length (0xD, 0xE, 0xF: a 1-, 2- or 4-byte length follows;
 * otherwise the nibble is the length), then the contents. The name is field
 * (data[0] << 8) + 0x40, compared with the low nibble masked off.
 */
export function appNameFromData(data) {
  const d = toBytes(data);
  if (d.length < 6 || (d[0] & 0xF0) !== 0x80 || d[1] !== 0x0F) return null;
  const want = ((d[0] << 8) + 0x40) & 0xFFF0;
  for (let p = 6; p + 2 <= d.length;) {
    const id = (d[p] << 8) | d[p + 1];
    p += 2;
    const size = id & 0x0F;
    const width = { 0x0D: 1, 0x0E: 2, 0x0F: 4 }[size] ?? 0;
    if (p + width > d.length) return null;
    let len = width ? 0 : size;
    for (let i = 0; i < width; i++) len = len * 256 + d[p + i];
    p += width;
    if (p + len > d.length) return null;
    if ((id & 0xFFF0) === want) return d.slice(p, p + len);
    p += len;
  }
  return null;
}

/**
 * Parse a Flash application file (.8ek); parseFile calls it for any file that
 * starts with **TIFL**. Returns the parseFile shape with the application as
 * the one entry, plus `sections`, every section in the file. The entry's
 * `app` holds { headerName, embeddedName, hardwareId, deviceType, revision,
 * flags, objectType, dateBytes }.
 *
 * Refuses anything malformed, an operating system, a file with no
 * application, and an application for the monochrome models (hardware id 0).
 */
export function parseAppFile(input) {
  const b = toBytes(input);
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const sections = [];
  for (let p = 0; ;) {
    const sec = readSection(b, p);
    sections.push(sec);
    p = sec.offset + APP_HEADER + sec.dataLength;
    if (latin1(b.subarray(p, p + 8)) === APP_MAGIC) continue;
    if (p < b.length) warn('TRAILING_BYTES', `${b.length - p} bytes after the last section were ignored.`);
    break;
  }

  const apps = sections.filter(s => s.dataType === TYPE.FLASH_APP);
  const app = apps[0];
  if (!app) {
    if (sections.some(s => s.dataType === TYPE.OS)) throw new TIFileError('UNSUPPORTED_TYPE', 'This is an operating system file. This library does not send operating systems.');
    throw new TIFileError('BAD_FILE', 'This file holds no application (only a license or certificate).');
  }
  if (app.hardwareId === 0) {
    throw new TIFileError('UNSUPPORTED_TYPE', 'This application is for the older monochrome calculators (its data is Intel HEX pages). It cannot be sent to a TI-84 Plus CE.');
  }
  if (app.data.length === 0 || app.data[0] !== 0x81) {
    throw new TIFileError('BAD_FILE', 'The application data does not start the way an application must (0x81). The file is damaged or not an application.');
  }
  if (app.deviceType === 0x74) warn('OTHER_MODEL', 'This application is marked for the TI-73, not the TI-84 Plus family.');
  if (apps.length > 1) warn('SEVERAL_APPS', 'The file holds more than one application section; the first is used.');

  const embedded = appNameFromData(app.data);
  if (!embedded?.length) warn('NO_EMBEDDED_NAME', 'The application\'s own header has no name field; the file header\'s name is used.');
  // Like libtifiles, the name is at most 8 bytes.
  const nameBytes = (embedded?.length ? embedded : app.headerNameBytes).slice(0, 8);
  if (nameBytes.length === 0) throw new TIFileError('BAD_FILE', 'The application has no name.');
  const entry = {
    name: nameToString(nameBytes, TYPE.FLASH_APP), nameBytes, type: TYPE.FLASH_APP, typeName: typeName(TYPE.FLASH_APP),
    version: 0, archived: true, data: app.data, size: app.data.length,
    app: {
      headerName: app.headerName, embeddedName: embedded ? latin1(embedded) : null,
      hardwareId: app.hardwareId, deviceType: app.deviceType, revision: app.revision,
      flags: app.flags, objectType: app.objectType, dateBytes: app.dateBytes,
    },
  };
  return {
    comment: '', entries: [entry], warnings,
    sections: sections.map(({ data, headerNameBytes, ...rest }) => rest),
  };
}

function readSection(b, p) {
  if (p + APP_HEADER > b.length) throw new TIFileError('BAD_FILE', 'The application file is cut short inside a section header.');
  if (latin1(b.subarray(p, p + 8)) !== APP_MAGIC) throw new TIFileError('BAD_FILE', 'Not a Flash application file (a section does not start with **TIFL**).');
  const h = b.subarray(p, p + APP_HEADER);
  const nameLength = Math.min(h[16], 8);
  const sec = {
    offset: p,
    revision: [h[8], h[9]], flags: h[10], objectType: h[11],
    dateBytes: [h[12], h[13], h[14], h[15]],
    headerName: latin1(h.subarray(17, 17 + nameLength)),
    headerNameBytes: h.slice(17, 17 + nameLength),
    deviceType: h[48], dataType: h[49], hardwareId: h[73],
    dataLength: readLe32(h, 74),
  };
  sec.dataTypeName = DATA_TYPES[sec.dataType] ?? `0x${hex2(sec.dataType)}`;
  if (sec.deviceType !== 0x73 && sec.deviceType !== 0x74) {
    throw new TIFileError('BAD_FILE', `This application file is for another calculator (device type 0x${hex2(sec.deviceType)}).`);
  }
  if (!DATA_TYPES[sec.dataType]) throw new TIFileError('BAD_FILE', `Unknown section data type 0x${hex2(sec.dataType)} in the application file.`);
  if (sec.dataLength > APP_MAX_DATA) throw new TIFileError('BAD_FILE', `A section claims ${sec.dataLength} bytes, more than any application can be.`);
  const d = p + APP_HEADER;
  if (d + sec.dataLength > b.length) throw new TIFileError('BAD_FILE', `A section says it holds ${sec.dataLength} bytes but the file ends first. It is truncated or damaged.`);
  sec.data = b.slice(d, d + sec.dataLength);
  return sec;
}

/**
 * Write an application entry (from receiveApp or parseAppFile) as a
 * one-section .8ek file. Revision, flags, object type and date come from the
 * entry when it has them and are zero otherwise.
 */
export function buildAppFile(entry, { hardwareId } = {}) {
  if (entry?.type !== TYPE.FLASH_APP) throw new TIFileError('BAD_ENTRY', 'buildAppFile needs a Flash application entry (type 0x24).');
  const data = toBytes(entry.data);
  if (data.length > APP_MAX_DATA) throw new TIFileError('TOO_LARGE', 'The application is larger than an application can be.');
  const info = entry.app ?? {};
  const hw = hardwareId ?? info.hardwareId;
  if (!hw) throw new TIFileError('BAD_ENTRY', 'buildAppFile needs a non-zero hardware id.');
  const name = toBytes(entry.nameBytes ?? new TextEncoder().encode(entry.name)).subarray(0, 8);
  const f = new Uint8Array(APP_HEADER + data.length);
  f.set(codesOf(APP_MAGIC));
  f.set(info.revision ?? [0, 0], 8);
  f[10] = info.flags ?? 0;
  f[11] = info.objectType ?? 0;
  f.set(info.dateBytes ?? [0, 0, 0, 0], 12);
  f[16] = name.length;
  f.set(name, 17);
  f[48] = 0x73;
  f[49] = TYPE.FLASH_APP;
  f[73] = hw;
  new DataView(f.buffer).setUint32(74, data.length, true);
  f.set(data, APP_HEADER);
  return f;
}
