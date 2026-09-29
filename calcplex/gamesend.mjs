// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// Sending a game to a TI-84 Plus CE: every file of it, every time, libraries
// first, after a space check, with each variable read back. The pages own the
// words on screen; this module owns what goes over the cable.
import { NAMED, compatibility, digest, isCE, refusal } from './core.mjs';
import { CELink } from '../celink.mjs';
import { parseFile, TYPE } from '../tifiles.mjs';

export const PROGRAMS = [TYPE.PROGRAM, TYPE.PROTECTED_PROGRAM];
const SIZE_WORD = [...PROGRAMS, TYPE.APPVAR, TYPE.TEMP_PROGRAM];
const NOT_VARIABLES = [TYPE.FLASH_APP, TYPE.OS, TYPE.CERTIFICATE, TYPE.LICENSE];

const clash = (row, e) => row.name === e.name && (row.type === e.type || (NAMED.includes(row.type) && NAMED.includes(e.type)));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const kb = n => Math.ceil(n / 1024);
const brokenCopy = name => `${name} didn't arrive intact. Click Send again to retry.`;

/** An assembly or C program: 0xEF 0x7B right after the size word. */
export function isAssembly(entry) {
  const d = entry.data;
  return PROGRAMS.includes(entry.type) && d.length >= 4 && d[2] === 0xEF && d[3] === 0x7B;
}

/**
 * A CE C library's version, or null: an AppVar opening (after the size word)
 * with C0 C1, or BF FE for LibLoad, then its version byte.
 */
export function library(entry) {
  const d = entry?.data;
  if (!d || entry.type !== TYPE.APPVAR || d.length < 5) return null;
  if (d[2] === 0xC0 && d[3] === 0xC1) return { version: d[4], loader: false };
  if (d[2] === 0xBF && d[3] === 0xFE) return { version: d[4], loader: true };
  return null;
}

/**
 * The calculator believes a variable's size word over the length it was
 * sent, so a variable whose size word exceeds its data is zero-padded to the
 * declared size, and reads back as it was sent.
 */
export function fixSizeWord(e) {
  const d = e.data;
  if (!SIZE_WORD.includes(e.type) || d.length < 2) return e;
  const declared = (d[0] | (d[1] << 8)) + 2;
  if (declared <= d.length) return e;
  const data = new Uint8Array(declared);
  data.set(d);
  return { ...e, data };
}

/** A file's variables. A Flash app or an OS never goes through a game button. */
export function gameEntries(bytes) {
  const { entries } = parseFile(bytes);
  if (entries.some(e => NOT_VARIABLES.includes(e.type))) throw refusal('BAD_FILE', 'This file is not a program or a variable.');
  return entries.map(fixSizeWord);
}

/**
 * Every variable of every file, once, in sending order: LibLoad, the other
 * libraries, data, then programs, so a send that stops half way never leaves
 * a program without what it needs. A library bundled twice keeps the newer
 * copy; two different variables under one name is a broken package.
 */
export function collectEntries(files) {
  const out = [];
  for (const bytes of files) {
    for (const e of gameEntries(bytes)) {
      const i = out.findIndex(o => clash(o, e));
      if (i < 0) {
        out.push(e);
        continue;
      }
      const [had, got] = [library(out[i]), library(e)];
      if (had && got) {
        if (got.version > had.version) out[i] = e;
      } else if (out[i].type !== e.type || !same(out[i].data, e.data)) {
        throw refusal('BAD_FILE', `This game's files contain two different variables named ${e.name}.`);
      }
    }
  }
  const rank = e => {
    const lib = library(e);
    if (lib) return lib.loader ? 0 : 1;
    return PROGRAMS.includes(e.type) ? 3 : 2;
  };
  return out.map((e, i) => [e, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([e]) => e);
}

/**
 * The calculator to use: the one this page was already allowed if there is
 * exactly one, else the browser's picker. A second picker in one click fails
 * like a cancel, so this prompts at most once.
 */
export async function pickCalculator({ usb = globalThis.navigator?.usb } = {}) {
  const granted = await CELink.granted({ usb });
  if (granted.length === 1) return CELink.fromDevice(granted[0]);
  return CELink.request({ usb });
}

/**
 * `link` with ready() run before each exchange, as it was on every hardware
 * run. That a CE keeps one allocation and mode through a whole job is not
 * verified. A refusal from ready() names the exchange it was readying in
 * `readying`, so an app send's refusal reads in the app's terms.
 */
export function readyEach(link) {
  const readied = op => async (...args) => {
    try {
      await link.ready();
    } catch (err) {
      if (err?.code === 'CALC_ERROR') err.readying = op;
      throw err;
    }
    return link[op](...args);
  };
  return {
    info: readied('info'), list: readied('list'), send: readied('send'),
    sendApp: readied('sendApp'), receive: readied('receive'), delete: readied('delete'),
  };
}

/** { model, os, route, ramFree, archiveFree }, refusing anything but a CE. */
export async function identify(link) {
  const info = await link.info();
  if (!isCE(info.productName)) {
    throw refusal('OTHER_MODEL', `This is a ${info.productName || 'calculator this page does not know'}. These files are for the TI-84 Plus CE.`);
  }
  return {
    model: info.productName, os: info.osVersion, route: compatibility(info.osVersion),
    ramFree: info.ramFree, archiveFree: info.archiveFree,
  };
}

// The variable inside arTIfiCE_v2.1.8xp: its data length and SHA-256.
const ARTIFICE_A = { size: 904, sha256: 'a3d6b61efdc4352b945e78d67278a1975854d4f81070c8235e0abfcf21fcfd12' };
// Each name as the tool itself installs it.
const TOOLS = [
  { name: 'A', types: PROGRAMS, size: ARTIFICE_A.size, tool: 'arTIfiCE' },
  { name: 'AsmHook2', types: [TYPE.FLASH_APP], tool: 'AsmHook2' },
  { name: 'Cesium', types: [TYPE.FLASH_APP], tool: 'Cesium' },
  { name: 'CESIUM', types: PROGRAMS, tool: 'Cesium installer' },
];

/**
 * The jailbreak tools a listing shows, as fixed labels. A hint, never a gate:
 * A is a common program name and AsmHook2's hook is lost on a RAM reset.
 */
export function jailbreakTools(rows) {
  return TOOLS
    .filter(t => rows.some(r => r.name === t.name && t.types.includes(r.type) && (!t.size || r.size === t.size)))
    .map(t => t.tool);
}

/** The calculator and its jailbreak tools. A prgmA counts only if it reads back as arTIfiCE. */
export async function inspect(openLink) {
  const link = readyEach(openLink);
  const calc = await identify(link);
  const rows = await link.list();
  let tools = jailbreakTools(rows);
  if (tools.includes('arTIfiCE')) {
    const a = rows.find(r => r.name === 'A' && r.size === ARTIFICE_A.size);
    let real = false;
    try {
      real = await digest((await link.receive('A', a.type)).data) === ARTIFICE_A.sha256;
    } catch { /* unreadable: not counted */ }
    if (!real) tools = tools.filter(t => t !== 'arTIfiCE');
  }
  return { ...calc, tools };
}

/**
 * What to say before an assembly game goes: 'none' (runs as it is), 'found'
 * (a tool is there), 'missing' (suggest the installer) or 'blocked' (no
 * jailbreak exists, and sendGame refuses).
 */
export function jailbreakState(route, tools) {
  if (route === 'native') return 'none';
  if (route === 'v21' || route === 'v3') return tools.length ? 'found' : 'missing';
  return 'blocked';
}

// A variable's cost: its data, its name and the calculator's own header. On
// the generous side, so a refusal means the send really would run out.
const cost = (e, archived) => e.data.length + e.name.length + (archived ? 20 : 9);

/**
 * With no I/O: what to delete and send, and whether it fits. `rows` is the
 * calculator's listing; `archive: 'all'` archives every variable.
 */
export function planInstall(entries, { rows, ramFree = null, archiveFree = null, archive = 'file' }) {
  const steps = entries.map(e => {
    const remove = rows.filter(r => clash(r, e));
    return { entry: e, archived: archive === 'all' || !!e.archived, remove, reason: remove.length ? 'replace' : 'new' };
  });
  // RAM freed by a delete is back at once, but the delete runs only just
  // before its own file, so RAM is a running balance in send order. Freed
  // archive may not come back until a garbage collection, so it is not counted.
  let ramNeed = 0, arcNeed = 0, ramBack = 0, balance = ramFree ?? 0, low = balance;
  for (const s of steps) {
    for (const r of s.remove) {
      if (r.archived || r.size == null) continue;
      const freed = r.size + r.name.length + 9;
      ramBack += freed;
      balance += freed;
    }
    if (s.archived) arcNeed += cost(s.entry, true);
    else {
      const c = cost(s.entry, false);
      ramNeed += c;
      balance -= c;
      low = Math.min(low, balance);
    }
  }
  const space = { ramNeed, arcNeed, ramBack, ramFree, archiveFree, ramShort: ramFree == null ? 0 : Math.max(0, -low) };
  // An assembly program is copied to RAM to run, even when it is archived.
  const warnings = [];
  const biggest = Math.max(0, ...entries.filter(isAssembly).map(e => e.data.length));
  if (ramFree != null && biggest && balance < biggest + 1024) {
    warnings.push({ code: 'LOW_RAM_TO_RUN', needKB: kb(biggest + 1024), freeKB: Math.max(0, Math.floor(balance / 1024)) });
  }
  return { steps, space, warnings };
}

/** Refuse a plan that does not fit, naming how much to free. */
export function checkSpace({ space }) {
  const { ramNeed, arcNeed, ramFree, archiveFree, ramShort } = space;
  if (archiveFree != null && arcNeed > archiveFree) {
    throw refusal('NO_ARCHIVE_SPACE', `Not enough room on the calculator: this game needs ${kb(arcNeed)} KB of archive and there's ${Math.floor(archiveFree / 1024)} KB free. Delete a few programs you don't need (2nd, +, 2: Mem Management), then try again.`, { needKB: kb(arcNeed - archiveFree) });
  }
  if (ramShort > 0) {
    throw refusal('NO_RAM_SPACE', `Not enough RAM on the calculator: this game needs ${kb(ramNeed)} KB and there's ${Math.floor(ramFree / 1024)} KB free. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management), then try again.`, { needKB: kb(ramShort) });
  }
}

// A single read of the free-memory parameters has come back wrong (0 bytes
// free on a calculator with plenty, observed on hardware), so a refusal asks
// the calculator once more. Returns the plan and whether it took a second read.
async function planThatFits(link, todo, calc, archive) {
  const plan = async ({ ramFree, archiveFree }) => planInstall(todo, { rows: await link.list(), ramFree, archiveFree, archive });
  const first = await plan(calc);
  try {
    checkSpace(first);
    return { plan: first, rechecked: false };
  } catch (err) {
    if (err.code !== 'NO_RAM_SPACE' && err.code !== 'NO_ARCHIVE_SPACE') throw err;
  }
  const second = await plan(await link.info());
  checkSpace(second);
  return { plan: second, rechecked: true };
}

/**
 * Send a game over an open link. `files` is the bytes of each of its files.
 *   onProgress(done, total)  bytes across every variable
 *   onStep(step, name)       'delete', 'send' or 'verify'
 *   verify                   'full' reads each variable back; 'size' lists once at the end
 *   archive                  'file' stores each variable where its file says; 'all' archives all
 * Resolves { os, route, asm, sent, replaced, warnings, bytes, rechecked }. A
 * failure part way carries `partial`, the names already on the calculator,
 * and `removed`, names deleted whose new copy never landed.
 */
export async function sendGame(openLink, files, { onProgress = null, onStep = null, verify = 'full', archive = 'file' } = {}) {
  const todo = collectEntries(files);
  const link = readyEach(openLink);
  const calc = await identify(link);
  const asm = todo.some(isAssembly);
  if (asm && (calc.route === 'unsupported' || calc.route === 'unknown')) {
    throw refusal('NO_JAILBREAK', `There's no jailbreak for OS ${calc.os} yet, so this game can't run on it. Nothing was sent.`);
  }
  const { plan, rechecked } = await planThatFits(link, todo, calc, archive);
  const total = plan.steps.reduce((n, s) => n + s.entry.data.length, 0);
  let before = 0;
  const sent = [], replaced = [], removed = new Set();
  try {
    for (const s of plan.steps) {
      const e = s.entry;
      for (const r of s.remove) {
        onStep?.('delete', r.name);
        await link.delete(r.name, r.type);
        removed.add(r.name);
      }
      onStep?.('send', e.name);
      await link.send(e, { archive: s.archived, onProgress: onProgress ? done => onProgress(before + done, total) : undefined });
      before += e.data.length;
      removed.delete(e.name);
      sent.push(e.name);
      if (verify === 'full') {
        onStep?.('verify', e.name);
        await readBack(link, e);
      }
      if (s.reason === 'replace') replaced.push(e.name);
    }
    if (verify === 'size' && plan.steps.length) {
      onStep?.('verify', null);
      await checkSizes(link, plan.steps.map(s => s.entry));
    }
  } catch (err) {
    err.partial = sent.slice();
    err.removed = [...removed];
    throw err;
  }
  return { os: calc.os, route: calc.route, asm, sent, replaced, warnings: plan.warnings, bytes: total, rechecked };
}

async function readBack(link, e) {
  const back = await link.receive(e.name, e.type);
  if (same(back.data, e.data)) return;
  const at = back.data.findIndex((x, i) => x !== e.data[i]);
  throw refusal('READBACK', brokenCopy(e.name), {
    variable: e.name, sentBytes: e.data.length, backBytes: back.data.length,
    firstDiff: at < 0 ? Math.min(back.data.length, e.data.length) : at,
  });
}

async function checkSizes(link, entries) {
  const rows = await link.list();
  for (const e of entries) {
    const r = rows.find(row => row.name === e.name && row.type === e.type);
    if (!r || (r.size != null && r.size !== e.data.length)) throw refusal('READBACK', brokenCopy(e.name), { variable: e.name });
  }
}

const CALC_FILE = /\.8x[pvg]$/i;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * The bytes of each .8xp/.8xv/.8xg file in a games page's .zip, so Send sends
 * what Download gives. `include` picks entries by path. Stored and deflated
 * entries only, CRC-checked; no ZIP64.
 */
export async function unpackZip(bytes, { include = null } = {}) {
  try {
    return await readZip(bytes, include);
  } catch (err) {
    // A read past the end, or a deflate stream that will not inflate.
    if (err instanceof RangeError || err instanceof TypeError) throw refusal('BAD_FILE', 'The game download is damaged. Try again in a moment.');
    throw err;
  }
}

async function readZip(bytes, include) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unreadable = () => refusal('BAD_FILE', 'The game download is not a readable zip.');
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xFFFF); p--) {
    if (dv.getUint32(p, true) === EOCD) {
      end = p;
      break;
    }
  }
  if (end < 0) throw unreadable();
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  if (count === 0xFFFF || p === 0xFFFFFFFF) throw refusal('BAD_FILE', 'The game download is packed in a way this page cannot read.');
  const found = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CENTRAL) throw unreadable();
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const packed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    if (!CALC_FILE.test(path) || /(^|\/)__MACOSX\//.test(path)) continue;
    if (include && !include.includes(path)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = await inflate(bytes.subarray(start, start + packed), method, path);
    if (data.length !== size || crc32(data) !== crc) throw refusal('BAD_FILE', `${path} in the game download is damaged. Try again in a moment.`);
    found.set(path, data);
  }
  for (const want of include ?? []) {
    if (!found.has(want)) throw refusal('BAD_FILE', `The game download is missing ${want}.`);
  }
  if (!found.size) throw refusal('BAD_FILE', 'The game download has no calculator files in it.');
  return [...found.values()];
}

async function inflate(raw, method, path) {
  if (method === 0) return raw.slice();
  if (method !== 8) throw refusal('BAD_FILE', `${path} is packed in a way this page cannot read.`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable;
export function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
