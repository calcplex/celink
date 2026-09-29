// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
// Portions derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see CREDITS.md in the celink repository.
//
// What the CalcPlex pages share: the install route for each CE OS version,
// the pinned arTIfiCE release files, the strict file checks that stand in
// front of the cable, the error wording and the analytics vocabulary.
import { CALC_ERRORS, LINK_LOST } from '../celink.mjs';
import { APP_MAGIC, TYPE, checksum } from '../tifiles.mjs';

/** An Error with a stable `code` for analytics; its message is written for the student. */
export function refusal(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Programs, AppVars and groups share one table of names. Math values live
// apart: the real A that `5→A` leaves behind never blocks program A.
export const NAMED = [TYPE.PROGRAM, TYPE.PROTECTED_PROGRAM, TYPE.APPVAR, TYPE.TEMP_PROGRAM, TYPE.GROUP];

export const TICONNECT_URL = 'https://education.ti.com/en/products/computer-software/ti-connect-ce-sw';

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The install route for a CE OS version:
 *   'native'       5.4 and earlier, assembly runs as it is
 *   'v21'          5.5 to 5.8.4, arTIfiCE v2.1 (one file, program A)
 *   'v3'           5.8.5, arTIfiCE v3 (two files and an app that stays)
 *   'unsupported'  newer than any published jailbreak
 *   'unknown'      not a CE version at all
 */
export function compatibility(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return 'unknown';
  const [major, minor, micro] = version.split('.').map(Number);
  if (major !== 5) return 'unknown';
  if (minor <= 4) return 'native';
  if (minor < 8 || (minor === 8 && micro <= 4)) return 'v21';
  if (minor === 8 && micro === 5) return 'v3';
  return 'unsupported';
}

// How the installer names each route. A reason never suggests changing the OS.
export const ROUTES = {
  native: {
    label: 'No jailbreak needed',
    heading: 'No jailbreak needed',
    reason: 'Assembly programs already run on this version, so there is nothing to install.',
  },
  v21: {
    label: 'arTIfiCE v2.1',
    heading: 'This calculator needs arTIfiCE v2.1',
    reason: 'arTIfiCE v2.1 covers 5.5 through 5.8.4. It is one file and it becomes program A.',
  },
  v3: {
    label: 'arTIfiCE v3',
    heading: 'This calculator needs arTIfiCE v3',
    reason: 'arTIfiCE v3 is the version that covers 5.8.5. It is two files and an app that stays on the calculator.',
  },
  unsupported: {
    label: 'No jailbreak yet',
    heading: 'arTIfiCE does not cover this version yet',
    reason: 'No published jailbreak covers this version yet.',
  },
  unknown: {
    label: 'Version not recognised',
    heading: 'The version could not be read',
    reason: 'This version was not recognised, so no route was picked and nothing will be sent.',
  },
};

/** True on OS 5.2 and earlier, where an assembly program starts through Asm(. */
export function needsAsm(version) {
  return compatibility(version) === 'native' && Number(version.split('.')[1]) < 3;
}

/** How to start the assembly program `name`, as one sentence. */
export function startHint(version, name) {
  if (compatibility(version) === 'v21') return `Press prgm, run A, and pick ${name}.`;
  // The home screen line is Asm(prgmNAME, with no closing parenthesis.
  if (needsAsm(version)) return `Start it with Asm(: press 2nd, 0, pick Asm(, press prgm, pick ${name}, and press enter.`;
  return `Press prgm, pick ${name}, and press enter twice.`;
}

/**
 * The author's release assets, pinned by SHA-256 (github.com/YvanTT/arTIfiCE/releases).
 * `replaces`: sent under its own name, replacing whatever variable holds it.
 * `expectReboot`: the calculator restarts as it lands, so there is no read-back.
 */
export const OFFICIAL = {
  v21: {
    label: 'arTIfiCE v2.1', tag: 'v2.1', files: [
      { file: 'arTIfiCE_v2.1.8xp', sha256: '46e2cd27a93bad402de8811d01d77f52b0419fb09a9162957703ffe0ef756caa', name: 'A', type: TYPE.PROGRAM, replaces: true },
    ],
  },
  v3: {
    label: 'arTIfiCE v3', tag: 'v3', files: [
      { file: 'arTIfiCE.8xp', sha256: '98cbadab42f34d63542d3648f97ff4ad20527ff39c35df12bbc00842454d262b', name: 'PPPP', type: TYPE.PROGRAM, replaces: true },
      { file: 'INEQUVAR.8xv', sha256: 'cc47cdda6fef69590a5377c095443e1cda911454ef68c173f0de5d17be2a0000', name: 'INEQUVAR', type: TYPE.APPVAR, replaces: true, expectReboot: true },
    ],
  },
};
export const HOSTED_BASE = '/downloads/ce/artifice/';

export function officialFiles(route) {
  return OFFICIAL[route]?.files ?? [];
}

/** The official file of `route` these bytes are, or null. */
export async function identifyOfficial(route, bytes) {
  const hash = await digest(bytes);
  return officialFiles(route).find(f => f.sha256 === hash) ?? null;
}

/** This site's copy of an official file, refused unless it matches its pin. */
export async function fetchOfficial(spec, fetcher = globalThis.fetch) {
  const response = await fetcher(HOSTED_BASE + spec.file);
  if (!response?.ok) throw refusal('FETCH', `${spec.file} could not be downloaded from this site.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await digest(bytes) !== spec.sha256) throw refusal('BAD_HASH', `${spec.file} did not match the author's published release and was discarded.`);
  return bytes;
}

const VARIABLE_MAGIC = '**TI83F*\x1a\x0a';
const textOf = (b, from, to) => new TextDecoder().decode(b.subarray(from, to));
const beforeNul = b => (b.indexOf(0) < 0 ? b : b.subarray(0, b.indexOf(0)));

/**
 * The one program or AppVar in a .8xp/.8xv file, refusing anything else: a
 * group, a damaged file, a name outside A-Z and 0-9. This is stricter than
 * tifiles.parseFile on purpose; it decides what may reach the calculator.
 */
export function parseVariable(input) {
  const b = new Uint8Array(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 74 || textOf(b, 0, 10) !== VARIABLE_MAGIC || ![0, 0x13].includes(b[10])) {
    throw refusal('BAD_FILE', 'Choose a TI-84 Plus CE .8xp or .8xv file.');
  }
  const section = v.getUint16(53, true);
  const header = v.getUint16(55, true);
  const size = v.getUint16(57, true);
  if (header !== 13 || 55 + section + 2 !== b.length || section !== 2 + header + 2 + size || v.getUint16(70, true) !== size) {
    throw refusal('BAD_FILE', 'Choose a file containing one variable. The file is invalid or contains a group.');
  }
  const type = b[59];
  if (![TYPE.PROGRAM, TYPE.PROTECTED_PROGRAM, TYPE.APPVAR].includes(type)) {
    throw refusal('BAD_FILE', 'Only programs and AppVars are supported.');
  }
  const name = new TextDecoder().decode(beforeNul(b.subarray(60, 68)));
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(name)) {
    throw refusal('BAD_FILE', 'Only names beginning with A–Z and containing A–Z or 0–9 are supported.');
  }
  if (v.getUint16(b.length - 2, true) !== checksum(b.subarray(55, b.length - 2))) throw refusal('BAD_FILE', 'The file checksum is invalid. Download it again.');
  return { name, type, payload: b.slice(72, 72 + size), bytes: b };
}

export function sameVariable(a, b) {
  const x = parseVariable(a);
  const y = parseVariable(b);
  return x.name === y.name && x.type === y.type && x.payload.length === y.payload.length
    && x.payload.every((byte, i) => byte === y.payload[i]);
}

/**
 * A Flash application file (.8ek): 78-byte **TIFL** headers, each followed by
 * its data (name at 17, device type at 48, data type at 49, length at 74).
 * Refuses the whole file if any entry is an operating system, whatever the
 * entry order, and refuses a truncated file.
 */
export function parseFlashApp(input) {
  const b = new Uint8Array(input);
  const notApp = () => refusal('BAD_APP', 'Choose the .8ek application file you downloaded from TI.');
  const entries = [];
  for (let at = 0; at + 78 <= b.length && textOf(b, at, at + 8) === APP_MAGIC;) {
    const length = new DataView(b.buffer, b.byteOffset).getUint32(at + 74, true);
    const name = new TextDecoder().decode(beforeNul(b.subarray(at + 17, at + 25))).replace(/\s+$/, '');
    entries.push({ device: b[at + 48], data: b[at + 49], length, name });
    if (length > b.length - (at + 78)) throw refusal('BAD_APP', 'That file is incomplete. Download it again from TI. Nothing was sent.');
    at += 78 + length;
  }
  if (!entries.length) throw notApp();
  if (entries.some(e => e.data === TYPE.OS)) {
    throw refusal('BAD_APP', 'That is a calculator operating system, not an application. Nothing was sent. This page never sends an OS.');
  }
  if (entries.some(e => e.device !== 0x73)) throw refusal('BAD_APP', 'That file is not for the TI-84 Plus CE family. Nothing was sent.');
  if (entries.at(-1).data !== TYPE.FLASH_APP) throw refusal('BAD_APP', 'That file is not a calculator application. Nothing was sent.');
  const named = entries.filter(e => e.data === TYPE.FLASH_APP && e.name).at(-1);
  return { name: named?.name ?? '', entries };
}

/** A TI-84 Plus CE by the start of the product name it reports: TI-84 Plus CE, TI-84+CE, TI-84 Plus CE-T. */
export function isCE(productName) {
  return /^TI-84 ?\+ ?CE|^TI-84 Plus CE/.test(productName);
}

/**
 * The installer's model and version gate: { model, os, route }. Stricter
 * than isCE: only the two names a TI-84 Plus CE reports, with or without
 * " USB", since a route is chosen for exactly that model.
 */
export function checkCalculator(model, os) {
  if (!/^TI-84(?:\+| Plus )CE(?: USB)?$/.test(model)) {
    throw refusal('WRONG_MODEL', `Detected ${model || 'an unknown model'}. Connect a TI-84 Plus CE.`);
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(os)) throw refusal('NO_OS_VERSION', 'Could not read an exact OS version. No files will be sent.');
  return { model, os, route: compatibility(os) };
}

// arTIfiCE v3 installs through TI's Inequality Graphing app, so the installer
// reads the app list before asking for a RAM reset.
export const INEQUALZ_URL = 'https://education.ti.com/en/software/details/en/8C7FB96338F9469BB9D970AFC034EC39/inequality-graphing-app';

/** Whether list() rows show Inequalz: 'present', 'missing', or 'unknown' when there is no listing. */
export function inequalzStatus(rows) {
  if (!Array.isArray(rows)) return 'unknown';
  return rows.some(r => r.type === TYPE.FLASH_APP && /^inequal/i.test(r.name.trim())) ? 'present' : 'missing';
}

// userAgentData's platform when the browser gives one, else the userAgent.
function platformHint(nav) {
  return nav.userAgentData?.platform || null;
}

// On Windows, WebUSB reaches a CE only through the driver TI Connect CE installs.
export function isWindows(nav) {
  const hint = platformHint(nav);
  return hint ? hint === 'Windows' : /Windows|Win32|Win64|WOW64/i.test(nav.userAgent);
}

// Chrome OS has no TI Connect CE, so failure text there must not mention it.
export function isChromeOS(nav) {
  const hint = platformHint(nav);
  return hint ? hint === 'Chrome OS' || hint === 'Chromium OS' : /\bCrOS\b/.test(nav.userAgent);
}

// Every analytics parameter below is a fixed vocabulary, never the browser's
// or the library's text: GA4 folds a high-cardinality value into "(other)".

export const PREVIEW_HOST = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

/** Send a GA4 event; a localhost preview logs it instead, so test runs are not counted. */
export function track(event, params) {
  try {
    if (PREVIEW_HOST) console.info('[not sent: preview]', event, params);
    else if (typeof window.gtag === 'function') window.gtag('event', event, params);
  } catch { /* analytics never breaks the page */ }
}

/** ce_connect_fail, with where the connect died when the error says. */
export function trackConnectFail(err, extra = {}) {
  const detail = openDetail(err);
  track('ce_connect_fail', { reason: failReason(err), ...(detail && { open_detail: detail }), ...extra });
}

// The site's analytics name the OS and model parameters evo_os and evo_hw on
// every calculator's pages.
export function calcParams({ os, model }) {
  return { evo_os: os, evo_hw: model };
}

const LINK_DEAD = [...LINK_LOST, 'LINK_CLOSED'];
const FILE_CODES = ['BAD_FILE', 'BAD_ENTRY', 'BAD_NAME', 'UNSUPPORTED_TYPE'];
// "Busy" and "go to the home screen": wait and retry, no need to reconnect.
const CALC_BUSY = [0x0011, 0x0034];

// Plain words for the calculator's refusals. celink's own messages keep
// libticalcs' technical wording.
const REFUSAL_TEXT = {
  0x0004: 'invalid argument or name',
  0x0006: 'a variable or app cannot be deleted from the archive',
  0x0008: 'transmission error',
  0x0009: 'the calculator is in boot mode',
  0x000C: 'the calculator is out of memory. Delete or archive something and try again',
  0x000D: 'invalid name',
  0x000E: 'invalid name',
  0x0011: 'the calculator is busy',
  0x0012: 'a variable with that name is locked and cannot be replaced',
  0x001B: 'the variable is too large for the calculator',
  0x001C: 'the ping value was too small',
  0x001D: 'the ping value was too large',
  0x0021: 'wrong size for that parameter',
  0x0022: 'unknown parameter',
  0x0023: 'that parameter is read-only',
  0x0027: 'bad modify request',
  0x0029: 'remote-control problem',
  0x002B: 'the battery is low. Charge the calculator and try again',
  0x002C: 'the Flash app was rejected',
  0x002D: 'the Flash app was rejected',
  0x002E: 'the Flash app was rejected: its signature does not match',
  0x002F: 'the Flash app was rejected',
  0x0030: 'the Flash app was rejected',
  0x0034: 'the calculator is busy. Go to the home screen and try again',
};
// The codes whose meaning is clearer when it was an app being written.
const APP_REFUSAL_TEXT = {
  0x0006: 'an older copy of this app is on the calculator and could not be removed',
  0x000C: 'there is not enough free archive memory for this app. Delete or move something out of the archive and try again',
  0x0011: 'the calculator is busy. Go to the home screen and try again',
  0x001B: 'the app is too large for this calculator',
  0x002B: 'the battery is too low to write Flash. Charge the calculator and try again',
  0x002C: 'the calculator rejected the app',
  0x002D: 'the calculator rejected the app',
  0x002E: 'the calculator rejected the app because its signature does not match. The file may be damaged, changed, or not made for this calculator',
  0x002F: 'the calculator rejected the app',
  0x0030: 'the calculator rejected the app',
  0x0034: 'the calculator is busy. Go to the home screen and try again',
};

/**
 * What to show for a CALC_ERROR; undefined for any other error. A refusal of
 * the ready() just before an app send reads in the app's terms too.
 */
export function refusalText(err) {
  if (err?.code !== 'CALC_ERROR') return undefined;
  const code = `0x${err.calcError.toString(16).padStart(4, '0')}`;
  const app = (err.op === 'sendApp' || err.readying === 'sendApp') && APP_REFUSAL_TEXT[err.calcError];
  if (app) return `The calculator refused the app (error ${code}: ${app}).`;
  const what = REFUSAL_TEXT[err.calcError] ?? 'an error code this library does not know; please report it';
  return `The calculator refused the request (error ${code}: ${what}).`;
}

/** True when the link is gone and a new one must be opened. */
export function linkDead(err) {
  return LINK_DEAD.includes(err?.code);
}

/** True for a calculator refusal code the library has no description for. */
export function unknownRefusal(err) {
  return err?.code === 'CALC_ERROR' && !Object.hasOwn(CALC_ERRORS, err.calcError);
}

// The pages' own error codes that have a reason of their own.
const PAGE_REASONS = new Map([
  ['NO_ARCHIVE_SPACE', 'no_space'],
  ['NO_RAM_SPACE', 'no_ram'],
  ['NO_JAILBREAK', 'no_jailbreak'],
  ['READBACK', 'readback_mismatch'],
  ['NOT_VERIFIED', 'readback_mismatch'],
  ['FETCH', 'fetch_failed'],
  ['BAD_HASH', 'bad_hash'],
  ['COLLISION', 'collision'],
  ['WRONG_ROUTE', 'wrong_route'],
  ['WRONG_MODEL', 'wrong_model'],
]);

/** The `reason` an analytics event gives any error. */
export function failReason(err) {
  return linkReason(err) ?? PAGE_REASONS.get(err?.code) ?? 'other';
}

// Where the installer's reasons have always differed from the games pages':
// a low battery on the app send is low_battery, and a refusal naming several
// files, or a Send Snake space, jailbreak or read-back refusal, is other.
const LOW_BATTERY = 0x002B;
const INSTALLER_OTHER = ['NO_ARCHIVE_SPACE', 'NO_RAM_SPACE', 'NO_JAILBREAK', 'READBACK'];

/** The `reason` the installer's analytics give any error. */
export function installerFailReason(err) {
  if (err?.code === 'CALC_ERROR' && err.calcError === LOW_BATTERY && err.op === 'sendApp') return 'low_battery';
  if (INSTALLER_OTHER.includes(err?.code) || (err?.code === 'COLLISION' && err.names?.length > 1)) return 'other';
  return failReason(err);
}

/** The `reason` for an error from the cable or a file, or undefined. */
export function linkReason(err) {
  const code = err?.code;
  if (code === 'NO_DEVICE_SELECTED' || err?.name === 'NotFoundError') return 'no_device';
  if (code === 'NO_WEBUSB' || code === 'OTHER_MODEL') return 'unsupported';
  if (code === 'OPEN_FAILED') return 'open_failed';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'CALC_ERROR') return CALC_BUSY.includes(err.calcError) ? 'calc_busy' : `calc_error_${err.calcError}`;
  if (linkDead(err)) return 'link_lost';
  if (FILE_CODES.includes(code)) return 'bad_file';
  return undefined;
}

const OPEN_STEPS = ['open', 'config', 'claim'];
const OPEN_CAUSES = { SecurityError: 'security', NetworkError: 'network', InvalidStateError: 'state', NotFoundError: 'notfound', AbortError: 'abort' };

/**
 * ce_connect_fail's `open_detail`: where a connect died. OPEN_FAILED gives
 * `<step>_<cause>` (a Chromebook policy block reads open_security, a held
 * interface claim_network); a TIMEOUT means the calculator never answered.
 */
export function openDetail(err) {
  if (err?.code === 'TIMEOUT') return 'no_reply';
  if (err?.code !== 'OPEN_FAILED') return undefined;
  const step = OPEN_STEPS.includes(err.step) ? err.step : 'other';
  const cause = Object.hasOwn(OPEN_CAUSES, err.cause?.name) ? OPEN_CAUSES[err.cause.name] : 'other';
  return `${step}_${cause}`;
}
