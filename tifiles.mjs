// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
// Portions derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see LIBTICALCS.md.
//
// TI-83 Plus / TI-84 Plus family variable files (.8xp, .8xv, .8xg, ...).
//
// File layout (all numbers little-endian, unlike the USB protocol):
//   0    8   "**TI83F*"
//   8    3   1A 0A 00
//   11   42  comment, NUL padded
//   53   2   length of the data section
//   55   n   data section: one or more variable entries
//   55+n 2   checksum = sum of the data section bytes, low 16 bits
//
// Variable entry:
//   2  header length (13 with version + flag, 11 without)
//   2  data length
//   1  type id
//   8  name, NUL padded
//   1  version                 (only when header length is 13)
//   1  flag, 0x80 = archived   (only when header length is 13)
//   2  data length (again)
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

const EXTENSIONS = {
  0x05: '8xp', 0x15: '8xv', 0x01: '8xl', 0x07: '8ci', 0x1A: '8ca', 0x17: '8xg', 0x24: '8ek', 0x23: '8eu',
};

/** The usual file extension for a type on the CE, or undefined when not known. */
export function fileExtension(type) { return EXTENSIONS[type]; }

const LIST_TYPES = [0x01, 0x0D];
const EQUATION_TYPES = [0x03, 0x0B];
/** Variables with fixed names and no name bytes of their own (CE spellings). */
const PERMANENT = { 0x0F: 'Window', 0x10: 'RclWindw', 0x11: 'TblSet' };

const MAGIC = '**TI83F*';
const MAX_FILE = 8 * 1024 * 1024;
const HEADER_SIZE = 55;
const COMMENT_SIZE = 42;
const THETA = 'θ'; // name token 0x5B

export class TIFileError extends Error {
  constructor(code, message) { super(message); this.name = 'TIFileError'; this.code = code; }
}

export function typeName(id) {
  return TYPE_NAMES[id] ?? `type 0x${hex2(id)}`;
}

function hex2(n) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TIFileError('BAD_FILE', 'Expected file bytes (Uint8Array or ArrayBuffer).');
}

// ---------------------------------------------------------------- names

// The calculator's own readable names, which are also the names on the wire.
// L, Y, r and the parametric X/Y take subscript digits (U+2080..U+2089): L1 goes
// over USB as 4C E2 82 81. Str, Pic and GDB take plain ASCII digits. A named
// list is the 7 bytes after its 5D token, with nothing in front.
const SUB = d => String.fromCodePoint(0x2080 + d);
const PARAM_T = '\u22BA'; // the parametric-equation t glyph

function tokenName(b, type) {
  const [t, n] = b;
  if (t === 0x5D && LIST_TYPES.includes(type)) {
    if (n <= 0x08) return 'L' + SUB(n + 1);
    if (n === 0x09) return 'L' + SUB(0);
    if (n === 0x40) return 'IDList';
    return asciiName(b.subarray(1, 8));
  }
  if (t === 0x5C && type === TYPE.MATRIX && n <= 9) return '[' + String.fromCharCode(0x41 + n) + ']';
  if (t === 0x5E && EQUATION_TYPES.includes(type)) {
    if (n >= 0x10 && n <= 0x19) return 'Y' + SUB((n - 0x0F) % 10);
    if (n >= 0x20 && n <= 0x2B) return (n % 2 ? 'Y' : 'X') + SUB(((n - 0x20) >> 1) + 1) + PARAM_T;
    if (n >= 0x40 && n <= 0x45) return 'r' + SUB(n - 0x3F);
    if (n >= 0x80 && n <= 0x82) return 'uvw'[n - 0x80];
  }
  if (t === 0xAA && type === TYPE.STRING && n <= 9) return 'Str' + ((n + 1) % 10);
  if (t === 0x60 && type === TYPE.PICTURE && n <= 9) return 'Pic' + ((n + 1) % 10);
  if (t === 0x61 && type === TYPE.GDB && n <= 9) return 'GDB' + ((n + 1) % 10);
  return null;
}

function asciiName(b) {
  let s = '';
  for (const c of b) {
    if (c === 0) break;
    if (c === 0x5B) s += THETA;
    else if (c >= 0x20 && c < 0x7F && c !== 0x7B && c !== 0x7D) s += String.fromCharCode(c);
    else s += `{${hex2(c)}}`;
  }
  return s;
}

/** Readable name for an 8-byte on-calculator name; the same text goes on the wire. */
export function nameToString(nameBytes, type) {
  if (PERMANENT[type]) return PERMANENT[type];
  const b = toBytes(nameBytes);
  return tokenName(b, type) ?? asciiName(b);
}

/** The reverse of nameToString: a readable name to 8 NUL-padded bytes. */
export function nameToBytes(name, type) {
  if (name instanceof Uint8Array) return padName(name);
  name = String(name);
  const out = [];
  let m;
  const isList = LIST_TYPES.includes(type);
  const isEquation = EQUATION_TYPES.includes(type);
  // Built-in names are accepted with subscript or plain digits (L₁ or L1), and the
  // parametric t as ⊺ or T.
  const plain = name.replace(/[₀-₉]/gu, d => String(d.codePointAt(0) - 0x2080)).replace(/\u22BA/gu, 'T');
  const nth = d => (+d + 9) % 10; // 1..9, 0 -> 0..8, 9
  if ((m = /^L(\d)$/.exec(plain)) && isList) out.push(0x5D, nth(m[1]));
  else if (plain === 'IDList' && isList) out.push(0x5D, 0x40);
  else if ((m = /^\[([A-J])\]$/.exec(name)) && type === TYPE.MATRIX) out.push(0x5C, m[1].charCodeAt(0) - 0x41);
  else if ((m = /^Y(\d)$/.exec(plain)) && isEquation) out.push(0x5E, 0x10 + nth(m[1]));
  else if ((m = /^([XY])([1-6])T$/.exec(plain)) && isEquation) out.push(0x5E, 0x20 + 2 * (+m[2] - 1) + (m[1] === 'Y' ? 1 : 0));
  else if ((m = /^r([1-6])$/.exec(plain)) && isEquation) out.push(0x5E, 0x40 + +m[1] - 1);
  else if ((m = /^[uvw]$/.exec(name)) && isEquation) out.push(0x5E, 0x80 + 'uvw'.indexOf(name));
  else if ((m = /^Str(\d)$/.exec(name)) && type === TYPE.STRING) out.push(0xAA, nth(m[1]));
  else if ((m = /^Pic(\d)$/.exec(name)) && type === TYPE.PICTURE) out.push(0x60, nth(m[1]));
  else if ((m = /^GDB(\d)$/.exec(name)) && type === TYPE.GDB) out.push(0x61, nth(m[1]));
  else {
    // Any other list is a named list: the 5D token, then up to 7 characters. A
    // leading ⌊ (how the calculator displays one) is accepted and dropped.
    let rest = name;
    if (isList) {
      if (rest.startsWith('⌊')) rest = rest.slice(1);
      out.push(0x5D);
    }
    for (let i = 0; i < rest.length; i++) {
      const esc = /^\{([0-9A-Fa-f]{2})\}/.exec(rest.slice(i));
      if (esc) { out.push(parseInt(esc[1], 16)); i += 3; continue; }
      const ch = rest[i];
      if (ch === THETA) { out.push(0x5B); continue; }
      const c = ch.charCodeAt(0);
      if (c < 0x20 || c >= 0x7F) throw new TIFileError('BAD_NAME', `Character "${ch}" cannot be used in a variable name.`);
      out.push(c);
    }
    if (isList && (out.length < 2 || out.length > 8)) throw new TIFileError('BAD_NAME', `List name "${name}" must be 1 to 7 characters.`);
  }
  if (out.length === 0 || out.length > 8) throw new TIFileError('BAD_NAME', `Variable name "${name}" must be 1 to 8 characters.`);
  return padName(Uint8Array.from(out));
}

/** The name as the calculator spells it, for a name typed as "L1", "⌊ABC" or "Y1". */
export function canonicalName(name, type) {
  try { return nameToString(nameToBytes(name, type), type); } catch { return String(name); }
}

function padName(b) {
  if (b.length > 8) throw new TIFileError('BAD_NAME', 'Variable name is longer than 8 bytes.');
  const out = new Uint8Array(8);
  out.set(b);
  return out;
}

// ---------------------------------------------------------------- entries

/**
 * Make a variable entry. For programs and app variables pass `body` (the tokens,
 * or the app variable's bytes) and the 2-byte little-endian length prefix is
 * added for you; or pass `data` to give the variable's full data untouched.
 */
export function makeEntry({ name, type, body, data, version = 0, archived = false }) {
  if (data == null) {
    if (body == null) throw new TIFileError('BAD_ENTRY', 'makeEntry needs `body` or `data`.');
    const b = toBytes(body);
    if (b.length > 0xFFFF - 2) throw new TIFileError('TOO_LARGE', 'Variable body is larger than 65,533 bytes.');
    data = new Uint8Array(b.length + 2);
    data[0] = b.length & 0xFF; data[1] = b.length >> 8;
    data.set(b, 2);
  }
  data = toBytes(data);
  const nameBytes = nameToBytes(name, type);
  return {
    name: nameToString(nameBytes, type), nameBytes, type, typeName: typeName(type),
    version, archived: !!archived, data, size: data.length,
  };
}

// ---------------------------------------------------------------- parse / build

/**
 * Parse a variable file. Follows libtifiles (LIBTICALCS.md 15): a checksum
 * that does not match, a declared data-section length that disagrees with the
 * entries, and bytes after the checksum all become `warnings` on the result
 * rather than errors. It refuses a file that is not a variable file, one whose
 * declared data section or an entry runs past the end of the file, an entry
 * whose two length copies disagree, a file with no entries, and anything of
 * 8 MB or more.
 *
 * Returns { comment, entries, warnings: [{ code, message }] }.
 */
export function parseFile(input) {
  const b = toBytes(input);
  if (b.length >= MAX_FILE) throw new TIFileError('BAD_FILE', 'The file is 8 MB or larger, which no variable file is.');
  const sig = String.fromCharCode(...b.subarray(0, 8));
  if (sig === APP_MAGIC) return parseAppFile(b);
  if (sig !== MAGIC) throw new TIFileError('BAD_FILE', 'Not a TI-83 Plus/TI-84 Plus variable file (the header does not start with **TI83F*).');
  if (b.length < HEADER_SIZE + 2) throw new TIFileError('BAD_FILE', 'The file is too short to be a variable file.');
  if (b[8] !== 0x1A || b[9] !== 0x0A) throw new TIFileError('BAD_FILE', 'The file header signature is damaged.');
  const comment = latin1(b.subarray(11, 11 + COMMENT_SIZE));
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const len = u16le(b, 53);
  if (HEADER_SIZE + len > b.length) {
    throw new TIFileError('BAD_FILE', `The file says its data section is ${len} bytes, but the file is only ${b.length} bytes. It is truncated or damaged.`);
  }

  // Walk the entries up to the declared length. Follows libtifiles
  // (LIBTICALCS.md 15): files exist whose declared length is wrong and which
  // TI's software still sends, so an entry is bounded by the end of the file,
  // not by the declared section.
  const entries = [];
  const end = HEADER_SIZE + len;
  let p = HEADER_SIZE;
  while (p < end) {
    if (p + 2 > b.length) throw new TIFileError('BAD_FILE', 'A variable entry is cut short.');
    const hlen = u16le(b, p);
    // 13 is the header with version and flag; anything else is read as the 11-byte form.
    const hasVersion = hlen === 13;
    if (hlen !== 11 && hlen !== 13) warn('HEADER_LENGTH', `A variable header says it is ${hlen} bytes; it was read as the 11-byte form.`);
    const hl = hasVersion ? 13 : 11;
    const h = p + 2;
    if (h + hl + 2 > b.length) throw new TIFileError('BAD_FILE', 'A variable header is cut short.');
    const dlen = u16le(b, h);
    const type = b[h + 2];
    const nameBytes = b.slice(h + 3, h + 11);
    let version = 0;
    let archived = false;
    if (hasVersion) {
      // One little-endian word: the low byte is the version, the high bit means
      // archived. Some older tools wrote an archived variable as 0x0080 (the
      // flag in the version byte); that value means archived, version 0.
      const word = b[h + 11] | (b[h + 12] << 8);
      if (word === 0x0080) archived = true;
      else { version = word & 0xFF; archived = (word & 0x8000) !== 0; }
    }
    const dlen2 = u16le(b, h + hl);
    if (dlen !== dlen2) throw new TIFileError('BAD_FILE', 'The two copies of a variable\'s length disagree.');
    const d = h + hl + 2;
    if (d + dlen > b.length) throw new TIFileError('BAD_FILE', 'A variable\'s data runs past the end of the file.');
    // Older tools wrote TI-84 Plus C pictures (0x55BB bytes) with version 0; they are version 10.
    if (type === TYPE.PICTURE && dlen === 0x55BB && version === 0) version = 10;
    const data = b.slice(d, d + dlen);
    entries.push({
      name: nameToString(nameBytes, type), nameBytes, type, typeName: typeName(type),
      version, archived, data, size: dlen,
    });
    p = d + dlen;
  }
  if (entries.length === 0) throw new TIFileError('BAD_FILE', 'The file contains no variables.');

  const sectionLen = p - HEADER_SIZE;
  if (sectionLen !== len) warn('DECLARED_LENGTH', `The file says its data section is ${len} bytes, but its variables fill ${sectionLen}.`);
  if (p + 2 > b.length) {
    warn('NO_CHECKSUM', 'The file ends before its checksum.');
  } else {
    const stored = u16le(b, p);
    const computed = checksum(b.subarray(HEADER_SIZE, p));
    if (stored !== computed) warn('BAD_CHECKSUM', `The checksum does not match (the file says 0x${stored.toString(16)}, its contents add up to 0x${computed.toString(16)}). The variables were read anyway.`);
    if (p + 2 < b.length) warn('TRAILING_BYTES', `${b.length - p - 2} bytes after the checksum were ignored.`);
  }
  return { comment, entries, warnings };
}

export function buildFile(entries, { comment = 'Created by celink' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TIFileError('BAD_ENTRY', 'buildFile needs at least one entry.');
  if (entries.some(e => e.type === TYPE.FLASH_APP)) throw new TIFileError('BAD_ENTRY', 'A Flash application goes in its own file: use buildAppFile.');
  const parts = entries.map(e => {
    const data = toBytes(e.data);
    if (data.length > 0xFFFF) throw new TIFileError('TOO_LARGE', `Variable ${e.name} is larger than 65,535 bytes.`);
    const nb = e.nameBytes ? padName(toBytes(e.nameBytes)) : nameToBytes(e.name, e.type);
    const out = new Uint8Array(17 + data.length);
    out[0] = 13; out[1] = 0;
    out[2] = data.length & 0xFF; out[3] = data.length >> 8;
    out[4] = e.type;
    out.set(nb, 5);
    out[13] = e.version ?? 0;
    out[14] = e.archived ? 0x80 : 0x00;
    out[15] = out[2]; out[16] = out[3];
    out.set(data, 17);
    return out;
  });
  const len = parts.reduce((n, x) => n + x.length, 0);
  if (len > 0xFFFF) throw new TIFileError('TOO_LARGE', 'The variables together are larger than one file can hold (65,535 bytes).');
  const file = new Uint8Array(HEADER_SIZE + len + 2);
  for (let i = 0; i < 8; i++) file[i] = MAGIC.charCodeAt(i);
  file[8] = 0x1A; file[9] = 0x0A; file[10] = 0x00;
  const c = String(comment);
  for (let i = 0; i < Math.min(c.length, COMMENT_SIZE); i++) file[11 + i] = c.charCodeAt(i) & 0xFF;
  file[53] = len & 0xFF; file[54] = len >> 8;
  let p = HEADER_SIZE;
  for (const x of parts) { file.set(x, p); p += x.length; }
  const sum = checksum(file.subarray(HEADER_SIZE, HEADER_SIZE + len));
  file[p] = sum & 0xFF; file[p + 1] = sum >> 8;
  return file;
}

export function checksum(bytes) {
  let s = 0;
  for (const x of bytes) s = (s + x) & 0xFFFF;
  return s;
}

function latin1(b) {
  let s = '';
  for (const c of b) { if (c === 0) break; s += String.fromCharCode(c); }
  return s;
}

// ---------------------------------------------------------------- Flash applications
//
// An application file (.8ek) is one or more sections chained back to back, each
// a fixed 78-byte header and its data (numbers little-endian, like a variable
// file):
//   0   8  "**TIFL**"
//   8   1  revision, major           9   1  revision, minor
//   10  1  flags                     11  1  object type
//   12  1  day (BCD)                 13  1  month (BCD)
//   14  2  year (BCD)                16  1  name length
//   17  8  name                      25  23 (not used)
//   48  1  device type (0x73 for this family, 0x74 for the TI-73)
//   49  1  data type (0x23 OS, 0x24 application, 0x25 certificate, 0x3E license)
//   50  23 (not used)                73  1  hardware id (0: Intel HEX pages; else flat binary)
//   74  4  data length               78  n  data
// A real .8ek often carries a license or certificate section beside the
// application; the application is the section whose data type is 0x24.

const APP_MAGIC = '**TIFL**';
const APP_HEADER = 78;
/** Largest data length a section may declare: 4 MB less 16 KB. */
export const APP_MAX_DATA = 4 * 1024 * 1024 - 16 * 1024;
const DATA_TYPES = { 0x23: 'operating system', 0x24: 'application', 0x25: 'certificate', 0x3E: 'license' };

/**
 * The name an application carries inside its own signed header, or null.
 * The header is a chain of fields from offset 6 of the data: a 2-byte
 * big-endian id whose low nibble says how the length is stored (0xD: one
 * length byte follows, 0xE: two, 0xF: four, anything else: the nibble is the
 * length), then the contents. Ids are compared with the low nibble masked
 * off; the name is the field (data[0] << 8) + 0x40, so 0x8140 for an app.
 */
export function appNameFromData(data) {
  const d = toBytes(data);
  if (d.length < 6 || (d[0] & 0xF0) !== 0x80 || d[1] !== 0x0F) return null;
  const want = ((d[0] << 8) + 0x40) & 0xFFF0;
  for (let p = 6; p + 2 <= d.length;) {
    const id = (d[p] << 8) | d[p + 1];
    p += 2;
    const nib = id & 0x0F;
    let len;
    if (nib === 0x0D) { if (p + 1 > d.length) return null; len = d[p]; p += 1; }
    else if (nib === 0x0E) { if (p + 2 > d.length) return null; len = (d[p] << 8) | d[p + 1]; p += 2; }
    else if (nib === 0x0F) { if (p + 4 > d.length) return null; len = ((d[p] << 24) >>> 0) + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]); p += 4; }
    else len = nib;
    if (p + len > d.length) return null;
    if ((id & 0xFFF0) === want) return d.slice(p, p + len);
    p += len;
  }
  return null;
}

/**
 * Parse a Flash application file (.8ek). parseFile calls this for any file
 * that starts with **TIFL**. Returns the same shape as parseFile, with the
 * application as the one entry:
 *   { comment: '', entries: [app], warnings, sections }
 * where app is an entry of type 0x24 plus `app.app` = { headerName,
 * embeddedName, hardwareId, deviceType, revision, flags, objectType,
 * dateBytes }, and `sections` lists every section in the file.
 *
 * Refused: anything that is not a well-formed application file, an OS file
 * (this library does not send operating systems), a file with no
 * application section, and a monochrome (Intel HEX, hardware id 0) app.
 */
export function parseAppFile(input) {
  const b = toBytes(input);
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const sections = [];
  let p = 0;
  for (;;) {
    if (p + APP_HEADER > b.length) throw new TIFileError('BAD_FILE', 'The application file is cut short inside a section header.');
    if (String.fromCharCode(...b.subarray(p, p + 8)) !== APP_MAGIC) throw new TIFileError('BAD_FILE', 'Not a Flash application file (a section does not start with **TIFL**).');
    const h = b.subarray(p, p + APP_HEADER);
    const nameLen = Math.min(h[16], 8);
    const sec = {
      offset: p,
      revision: [h[8], h[9]], flags: h[10], objectType: h[11],
      dateBytes: [h[12], h[13], h[14], h[15]],
      headerName: latin1(h.subarray(17, 17 + nameLen)),
      headerNameBytes: h.slice(17, 17 + nameLen),
      deviceType: h[48], dataType: h[49], hardwareId: h[73],
      dataLength: (h[74] | (h[75] << 8) | (h[76] << 16) | (h[77] << 24)) >>> 0,
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
    sections.push(sec);
    p = d + sec.dataLength;
    if (p + 8 <= b.length && String.fromCharCode(...b.subarray(p, p + 8)) === APP_MAGIC) continue;
    if (p < b.length) warn('TRAILING_BYTES', `${b.length - p} bytes after the last section were ignored.`);
    break;
  }

  const app = sections.find(x => x.dataType === 0x24);
  if (!app) {
    if (sections.some(x => x.dataType === 0x23)) {
      throw new TIFileError('UNSUPPORTED_TYPE', 'This is an operating system file. This library does not send operating systems.');
    }
    throw new TIFileError('BAD_FILE', 'This file holds no application (only a license or certificate).');
  }
  if (app.hardwareId === 0) {
    throw new TIFileError('UNSUPPORTED_TYPE', 'This application is for the older monochrome calculators (its data is Intel HEX pages). It cannot be sent to a TI-84 Plus CE.');
  }
  if (app.data.length === 0 || app.data[0] !== 0x81) {
    throw new TIFileError('BAD_FILE', 'The application data does not start the way an application must (0x81). The file is damaged or not an application.');
  }
  if (app.deviceType === 0x74) warn('OTHER_MODEL', 'This application is marked for the TI-73, not the TI-84 Plus family.');
  if (sections.filter(x => x.dataType === 0x24).length > 1) warn('SEVERAL_APPS', 'The file holds more than one application section; the first is used.');

  const embedded = appNameFromData(app.data);
  let nameBytes = embedded;
  if (!embedded || embedded.length === 0) {
    warn('NO_EMBEDDED_NAME', 'The application\'s own header has no name field; the file header\'s name is used.');
    nameBytes = app.headerNameBytes;
  }
  if (nameBytes.length === 0) throw new TIFileError('BAD_FILE', 'The application has no name.');
  const entry = {
    name: latin1(nameBytes), nameBytes, type: TYPE.FLASH_APP, typeName: typeName(TYPE.FLASH_APP),
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

/**
 * Write an application entry (from receive or parseAppFile) as a one-section
 * .8ek file. `hardwareId` defaults to the entry's; a received app gets the
 * calculator's product number. Revision, flags, object type and date are copied
 * from the entry when it has them and are zero otherwise.
 */
export function buildAppFile(entry, { hardwareId } = {}) {
  if (!entry || entry.type !== TYPE.FLASH_APP) throw new TIFileError('BAD_ENTRY', 'buildAppFile needs a Flash application entry (type 0x24).');
  const data = toBytes(entry.data);
  if (data.length > APP_MAX_DATA) throw new TIFileError('TOO_LARGE', 'The application is larger than an application can be.');
  const info = entry.app ?? {};
  const hw = hardwareId ?? info.hardwareId;
  if (!hw) throw new TIFileError('BAD_ENTRY', 'buildAppFile needs a non-zero hardware id.');
  const name = toBytes(entry.nameBytes ?? new TextEncoder().encode(entry.name)).subarray(0, 8);
  const f = new Uint8Array(APP_HEADER + data.length);
  for (let i = 0; i < 8; i++) f[i] = APP_MAGIC.charCodeAt(i);
  const [maj = 0, min = 0] = info.revision ?? [];
  f[8] = maj; f[9] = min;
  f[10] = info.flags ?? 0; f[11] = info.objectType ?? 0;
  (info.dateBytes ?? [0, 0, 0, 0]).forEach((x, i) => { f[12 + i] = x; });
  f[16] = name.length;
  f.set(name, 17);
  f[48] = 0x73; f[49] = TYPE.FLASH_APP; f[73] = hw;
  f[74] = data.length & 0xFF; f[75] = (data.length >> 8) & 0xFF; f[76] = (data.length >> 16) & 0xFF; f[77] = (data.length >>> 24) & 0xFF;
  f.set(data, APP_HEADER);
  return f;
}
