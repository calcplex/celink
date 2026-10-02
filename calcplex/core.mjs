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

/** True on OS 5.3.0 and later, which start archived programs, assembly included, from prgm. */
export function launchesArchived(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const [major, minor] = version.split('.').map(Number);
  return major === 5 && minor >= 3;
}

/** How to start the assembly program `name`, as one sentence. */
export function startHint(version, name) {
  if (compatibility(version) === 'v21') return `Press prgm, run A, and pick ${name}.`;
  // The home screen line is Asm(prgmNAME, with no closing parenthesis.
  if (needsAsm(version)) return `Start it with Asm(: press 2nd, 0, pick Asm(, press prgm, pick ${name}, and press enter.`;
  return `Press prgm, pick ${name}, and press enter twice.`;
}

// The keypad strip with prgm boxed, a crop of a photo of the calculator,
// at twice the width it is shown.
export const PRGM_KEY = { src: '/images/ce/ce-prgm-key.webp', width: 720, height: 246, alt: 'The prgm key highlighted on the TI-84 Plus CE keypad' };

// The prgm key inside a sentence: the key as printed, with a small "?". A
// mouse resting on it, a click or tap, or Enter opens PRGM_KEY in a box under
// the sentence (mountKeyHelp). `prefix` names the classes, so each page
// styles it in its own stylesheet:
//   <prefix>-keyhelp      the button; aria-expanded="true" while its picture shows
//   <prefix>-keyhelp-q    the "?" inside it
//   <prefix>-keyhelp-pop  the picture's box, one per page, hidden while closed
export function keyHelpHtml(prefix) {
  const p = esc(prefix);
  return `<button type="button" class="${p}-keyhelp" aria-expanded="false" aria-controls="${p}-keyhelp-pop"><kbd>prgm</kbd><span class="${p}-keyhelp-q" aria-hidden="true">?</span></button>`;
}

/** `text` escaped for HTML, with its first "prgm" as keyHelpHtml(prefix). */
export function withKeyHelp(text, prefix) {
  const s = String(text);
  const at = s.search(/\bprgm\b/);
  return at < 0 ? esc(s) : esc(s.slice(0, at)) + keyHelpHtml(prefix) + esc(s.slice(at + 4));
}

// The box: its width, the space it keeps from the viewport's sides and from
// the sentence, and how long a mouse rests before it opens or leaves before
// it closes (ms).
export const KEY_HELP = { width: 340, gutter: 16, gap: 8, openDelay: 150, closeDelay: 250 };

/** The box's width in a viewport `viewWidth` CSS pixels wide. */
export function keyHelpWidth(viewWidth) {
  return Math.max(0, Math.min(KEY_HELP.width, viewWidth - 2 * KEY_HELP.gutter));
}

/**
 * Where the box goes, in viewport pixels (it is position: fixed): under the
 * paragraph or list item that holds the key (`block`), so it never covers the
 * sentence it explains; above that block only when it does not fit under it
 * and does above. Its left edge lines up with the key's, pulled in to keep
 * the gutter on both sides. `key` and `block` are client rects.
 */
export function keyHelpPlace({ key, block, width, height, view }) {
  const { gutter, gap } = KEY_HELP;
  const left = Math.max(gutter, Math.min(key.left, view.width - gutter - width));
  const below = block.bottom + gap;
  const above = block.top - gap - height;
  const top = below + height > view.height - gutter && above >= gutter ? above : below;
  return { left, top };
}

/**
 * Wires every keyHelpHtml(prefix) button on the page to one box holding the
 * picture, added to the end of the body. It opens when a mouse rests on the
 * key (and stays while the mouse moves onto the box), on a click or tap, and
 * on Enter or Space; a click or tap keeps it open until the key is clicked
 * again. Escape, a click outside the key and the box, or focus moving away
 * from a key opened by click closes it. Touch never opens it by hover. The
 * picture loads on the first open. `onOpen` runs once per page load, on the
 * first open. Returns { close, refresh }: call refresh() after repainting
 * anything that may hold the key, so a box whose key was painted away closes
 * and one whose key moved follows it.
 */
export function mountKeyHelp(prefix, { onOpen = () => {}, doc = globalThis.document, win = globalThis.window } = {}) {
  const cls = `${prefix}-keyhelp`;
  let pop = doc.getElementById(`${cls}-pop`);
  // A second call on the same page hands back the first one's controls.
  if (pop?.keyHelp) return pop.keyHelp;
  if (!pop) {
    pop = doc.createElement('div');
    pop.id = `${cls}-pop`;
    pop.className = `${cls}-pop`;
    pop.hidden = true;
    pop.style.position = 'fixed';
    const pic = doc.createElement('img');
    pic.setAttribute('alt', PRGM_KEY.alt);
    pic.setAttribute('width', String(PRGM_KEY.width));
    pic.setAttribute('height', String(PRGM_KEY.height));
    pic.setAttribute('decoding', 'async');
    const x = doc.createElement('button');
    x.setAttribute('type', 'button');
    x.className = `${cls}-x`;
    x.setAttribute('aria-label', 'Close');
    x.textContent = '×';
    pop.append(pic, x);
    doc.body.append(pop);
  }
  const img = pop.querySelector('img');
  let key = null, pinned = false, opened = false, openTimer = 0, closeTimer = 0;
  const keyOf = t => t?.closest?.(`.${cls}`) ?? null;
  const inPop = t => !!t && pop.contains(t);
  const stopTimers = () => { win.clearTimeout(openTimer); win.clearTimeout(closeTimer); };

  function place() {
    if (!key) return;
    const view = { width: doc.documentElement.clientWidth, height: win.innerHeight };
    const width = keyHelpWidth(view.width);
    pop.style.width = `${width}px`;
    const block = key.closest('p, li') || key;
    const { left, top } = keyHelpPlace({ key: key.getBoundingClientRect(), block: block.getBoundingClientRect(), width, height: pop.offsetHeight, view });
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function open(k, pin) {
    stopTimers();
    if (!k.isConnected) return;
    if (key && key !== k) key.setAttribute('aria-expanded', 'false');
    if (!key) {
      win.addEventListener('scroll', place, { passive: true, capture: true });
      win.addEventListener('resize', place);
    }
    key = k;
    pinned = pin;
    if (!img.getAttribute('src')) img.setAttribute('src', PRGM_KEY.src);
    k.setAttribute('aria-expanded', 'true');
    pop.hidden = false;
    place();
    if (!opened) {
      opened = true;
      onOpen();
    }
  }
  function close() {
    stopTimers();
    if (!key) return;
    key.setAttribute('aria-expanded', 'false');
    key = null;
    pinned = false;
    pop.hidden = true;
    win.removeEventListener('scroll', place, { capture: true });
    win.removeEventListener('resize', place);
  }

  doc.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const k = keyOf(e.target);
    if (k === key || (key && inPop(e.target))) win.clearTimeout(closeTimer);
    if (k && k !== key) {
      win.clearTimeout(openTimer);
      openTimer = win.setTimeout(() => open(k, false), KEY_HELP.openDelay);
    }
  });
  doc.addEventListener('pointerout', e => {
    if (e.pointerType !== 'mouse') return;
    const from = keyOf(e.target) || (inPop(e.target) ? pop : null);
    const to = e.relatedTarget;
    if (!from || (to && (from.contains(to) || inPop(to) || (key && key.contains(to))))) return;
    win.clearTimeout(openTimer);
    if (key && !pinned) closeTimer = win.setTimeout(close, KEY_HELP.closeDelay);
  });
  doc.addEventListener('click', e => {
    if (key && inPop(e.target) && e.target.closest?.(`.${cls}-x`)) {
      const k = key;
      close();
      k.focus?.();
      return;
    }
    const k = keyOf(e.target);
    if (k) {
      if (k === key && pinned) close();
      else open(k, true);
    } else if (key && !inPop(e.target)) {
      close();
    }
  });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  doc.addEventListener('focusout', e => {
    const to = e.relatedTarget;
    if (key && pinned && e.target === key && to && !inPop(to) && keyOf(to) !== key) close();
  });
  pop.keyHelp = {
    close,
    refresh() {
      if (key && !key.isConnected) close();
      else place();
    },
  };
  return pop.keyHelp;
}

// "Game didn't start?" under a Sent message: what each route may have gone
// wrong, as [id, label]. The ids are the analytics vocabulary.
export const START_CHOICES = {
  v3: [['invalid', 'It says ERROR: INVALID'], ['not_listed', "I can't find it in prgm"], ['other', 'Something else']],
  v21: [['error', 'It shows an error'], ['no_a', "I can't find A in prgm"], ['other', 'Something else']],
  native: [['error', 'It shows an error'], ['not_listed', "I can't find it in prgm"], ['other', 'Something else']],
};

// A calculator whose games start from a shell app (jailbreakState 'shell'):
// no choice mentions prgm, A or a hook, since the student starts games from
// inside the shell.
export const SHELL_CHOICES = [['error', 'It shows an error'], ['other', 'Something else']];

/**
 * Whether a Sent message offers "Game didn't start?": an assembly game on a
 * games page that can start as it is ('none'), with the tool the page found
 * ('found') or from a shell ('shell'). A 'missing' message already says it
 * won't start.
 */
export function startHelpShown(page, asm, state) {
  return page !== 'math' && !!asm && (state === 'found' || state === 'none' || state === 'shell');
}

// ce_start_report's choice for the first open of the math page's "Can't
// find it?", apart from `open` (a games panel's "Game didn't start?"), so a
// read by route never mixes the two panels.
export const FIND_HELP_OPEN = 'find_open';

/**
 * Whether the math page's Sent message offers "Can't find it?": on OS 5.3
 * and later, where its programs arrive archived and show in prgm with a *.
 * Below 5.3 they stay in RAM and the list shows them as sent.
 */
export function findHelpShown(page, os) {
  return page === 'math' && launchesArchived(os);
}

/**
 * The choices for a route. With the OS version: below 5.3 there is no
 * Python edition, whose TI-Basic-first menu is the only answer to "I can't
 * find it in prgm", so that choice is left out. With `jb` 'shell', the
 * shell's two choices, on the routes a shell works on.
 */
export function startHelpChoices(route, os, jb) {
  if (jb === 'shell') return route === 'v21' || route === 'v3' ? SHELL_CHOICES : [];
  const list = Object.hasOwn(START_CHOICES, route) ? START_CHOICES[route] : [];
  return os && needsAsm(os) ? list.filter(([id]) => id !== 'not_listed') : list;
}

// An answer part the page turns into a button that sends the game again, so
// the fix an answer names is one click away whatever the card's own main
// button says at the time. One shared, frozen part: pages compare by identity.
export const SEND_AGAIN = Object.freeze({ button: 'send', text: 'Send again' });

const MEMORY_FIX = "If the error says MEMORY, delete or archive a few programs you don't need (2nd, +, 2: Mem Management).";
// Every send carries the game's libraries, so a LibLoad error is not named:
// a fresh send is the generic fix. Memory errors belong to "It shows an
// error", so Something else does not repeat them where that choice exists.
const RESEND = ['Try sending it again. ', SEND_AGAIN];
const INSTALLER_LINK = { link: 'installer', text: 'jailbreak installer' };
const FOLLOW_INSTALLER = ['Open the ', INSTALLER_LINK, ' and follow its steps for your calculator.'];
const PYTHON_EDITION = 'On a Python edition, choose TI-Basic first';
// The prgm list is sorted A to Z with the * ignored, and an archived program
// shows with a * before its name; these pages archive every program on 5.3
// and later, the versions that offer "I can't find it in prgm" and the math
// page's "Can't find it?".
const IN_THE_LIST = name => `The list is in alphabetical order, so scroll down to find it. It shows as *${name}.`;
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

// Sentences, each a string or an array of parts, joined by spaces into one
// list of parts with neighbouring strings merged.
function sentences(...list) {
  const out = [];
  list.forEach((s, i) => {
    for (const part of [...(i ? [' '] : []), ...[].concat(s)]) {
      if (typeof part === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += part;
      else out.push(part);
    }
  });
  return out;
}

/**
 * "I can't find it in prgm", for a program `name` sent archived: the list's
 * order and the *, then the Python edition's menu, then a fresh send. The
 * games' choice and the math page's "Can't find it?" say this one answer.
 */
export function findHelpAnswer(name) {
  return sentences(IN_THE_LIST(name), `${PYTHON_EDITION}, then pick ${name}.`, ['Still not there? ', SEND_AGAIN]);
}

/**
 * The answer to one "Game didn't start?" choice: a list of parts, each a
 * string, { link: 'installer', text } for the page to turn into a link to
 * the jailbreak installer, or SEND_AGAIN for its button. [] for a route or
 * choice with no answer. `jb` 'shell' answers SHELL_CHOICES.
 */
export function startHelpAnswer(route, choice, { os, name, jb, shell: shellName }) {
  const reopenHook = `Press apps and open AsmHook2, then start ${name} again from prgm.`;
  const notListed = () => findHelpAnswer(name);
  const shell = {
    error: () => sentences(`Start ${name} from ${shellName || 'your shell'}, not from prgm.`, MEMORY_FIX),
    other: () => sentences(RESEND),
  };
  const answers = jb === 'shell' ? {
    // The installer's v21 route sends arTIfiCE and Snake and resets nothing.
    v21: { ...shell, other: () => sentences(RESEND, ['Still stuck? ', ...FOLLOW_INSTALLER]) },
    // Its v3 route clears RAM first, which a calculator with a working shell must never be sent into.
    v3: shell,
  } : {
    v3: {
      invalid: () => sentences(reopenHook),
      not_listed: notListed,
      // The installer resets RAM on this route, so it comes last.
      other: () => sentences(reopenHook, MEMORY_FIX, ['Still stuck? ', ...FOLLOW_INSTALLER]),
    },
    v21: {
      error: () => sentences(`Games start from arTIfiCE on this calculator: ${lowerFirst(startHint(os, name))}`, MEMORY_FIX),
      no_a: () => sentences(`${PYTHON_EDITION}.`, ['Still no A? ', ...FOLLOW_INSTALLER]),
      other: () => sentences(RESEND, ['Still stuck? ', ...FOLLOW_INSTALLER]),
    },
    native: {
      error: () => sentences(startHint(os, name), MEMORY_FIX),
      not_listed: notListed,
      // No jailbreak on this route, so never the installer.
      other: () => sentences(RESEND),
    },
  };
  const answer = Object.hasOwn(answers, route) && Object.hasOwn(answers[route], choice) ? answers[route][choice] : null;
  return answer ? answer() : [];
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
// Beyond the reasons and calcParams:
//   choice       ce_jb_prompt, how the jailbreak prompt closed: installer | send_anyway | cancel;
//                ce_start_report, what "Game didn't start?" got: open | invalid | error | no_a |
//                not_listed | other (START_CHOICES, SHELL_CHOICES), and find_open, the first
//                open of the math page's "Can't find it?" (FIND_HELP_OPEN; it has no choices);
//                open and not_listed are always a games page's;
//                ce_delete_reason, the reason picked after a delete (DELETE_REASONS)
//   jb           ce_calc_info, jailbreakState at connect: none | found | shell | missing | blocked;
//                ce_start_report: found | shell | none, and none at all with find_open
//   connected    ce_download, a calculator connected at the click: 1 | 0
//   screen       ce_step, the installer screen reached, once per screen per page load;
//                files_v21_snake / files_v21_only are the clicks on Send arTIfiCE and Snake /
//                Send only arTIfiCE, counted before the send
//   outcome      ce_delete: deleted | nothing (none of the game's files was there) | failed |
//                not_ours (the math page: a program by that name is there, but its content is
//                no version the page served, so nothing was deleted)
//   freed_kb     ce_delete, deleted only: KB of the game's or program's own files removed,
//                rounded up
//   last_reason  ce_delete and ce_delete_reason for a delete offered by the list of games
//                under a send refused for space: that refusal's reason (no_space | no_ram |
//                calc_error_12)
//   page         ce_key_help, the first time a page shows the prgm key's picture: hub | game |
//                math | installer; ce_delete and ce_delete_reason: hub | game | math

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
  track('ce_connect_fail', { reason: failReason(err), ...(detail && { open_detail: detail }), ...refusedAt(err), ...extra });
}

/**
 * `at` for a calculator refusal: the operation and the reply that carried it,
 * e.g. `send_rts`, or `ready_mode_before_send` when the ready step before a
 * send was refused. Nothing for any other error. Where a refusal happens
 * tells causes apart: 0x0036 at send_rts or delete_delete is a program
 * running on the calculator.
 */
export function refusedAt(err) {
  if (err?.code !== 'CALC_ERROR' || !err.op || !err.step) return {};
  return { at: `${err.op}_${err.step}${err.readying ? `_before_${err.readying}` : ''}` };
}

// The site's analytics name the OS and model parameters evo_os and evo_hw on
// every calculator's pages. `home` is 1 when the calculator was on its home
// screen at connect.
export function calcParams({ os, model, home }) {
  return { evo_os: os, evo_hw: model, ...(home === undefined ? {} : { home: home ? 1 : 0 }) };
}

/**
 * sendGame's `archive` mode for a page. Every page (hub, game pages, the
 * installer, the math page) puts programs in archive where the OS starts
 * archived programs, and below that keeps each file's own flag. `page` stays
 * an argument so a page can differ again.
 */
export function archiveMode(page) {
  return 'programs';
}

/** ce_jb_prompt's `choice`: either button by its name, and any other close (Escape, a click outside) as cancel. */
export function jbPromptChoice(closedWith) {
  return closedWith === 'installer' || closedWith === 'send_anyway' ? closedWith : 'cancel';
}

// A download's name as the site gives it: the file name without its folder
// or extension, e.g. "SnakeCE" for /downloads/ce/SnakeCE.8xg.
export const downloadName = file => file.split('/').pop().replace(/\.[^.]+$/, '');
const DOWNLOAD_FILE = /\.(8xg|8xp|8xv|zip)$/i;

/** ce_download's parameters for a click on `file` (a decoded path), or null when it is not a calculator file. */
export function downloadParams(file, page, connected) {
  return DOWNLOAD_FILE.test(file) ? { game: downloadName(file), page, connected: connected ? 1 : 0 } : null;
}

/** The installer's ce_step: the function it returns sends the event the first time each screen shows. */
export function stepTracker(send = track) {
  const seen = new Set();
  return (screen, route) => {
    if (seen.has(screen)) return;
    seen.add(screen);
    send('ce_step', { screen, ...(route && { route }) });
  };
}

/** ce_start_report: the function it returns sends each game's choice once per page load. */
export function startReporter(send = track) {
  const seen = new Set();
  return ({ choice, page, route, jb, game, os }) => {
    const key = `${game}:${choice}`;
    if (seen.has(key)) return;
    seen.add(key);
    // A panel without a jailbreak state (the math page's) sends no jb.
    send('ce_start_report', { choice, page, route, ...(jb === undefined ? {} : { jb }), game, evo_os: os });
  };
}

/**
 * ce_delete's parameters: freed_kb for a delete, reason and at for a
 * failure, last_reason (the send refusal's reason) for a delete offered by
 * the out-of-space list.
 */
export function deleteParams({ game, page, route, outcome, bytes = 0, err, lastReason }) {
  const params = { game, page, route, outcome };
  if (outcome === 'deleted') params.freed_kb = Math.ceil(bytes / 1024);
  if (outcome === 'failed') Object.assign(params, { reason: failReason(err) }, refusedAt(err));
  if (lastReason) params.last_reason = lastReason;
  return params;
}

// The line under a finished delete, as [id, label]; the ids are the
// analytics vocabulary.
export const DELETE_REASONS = [['didnt_work', "It didn't work"], ['didnt_like', "Didn't like it"], ['done', 'Done with it'], ['need_space', 'Need space']];

/** ce_delete_reason's parameters, or null for a choice outside DELETE_REASONS. */
export function deleteReasonParams({ game, page, choice, lastReason }) {
  if (!DELETE_REASONS.some(([id]) => id === choice)) return null;
  return { game, page, choice, ...(lastReason && { last_reason: lastReason }) };
}

/**
 * ce_delete_reason for one finished delete: the function it returns sends
 * the first choice in DELETE_REASONS and ignores every later call. True
 * when it sent.
 */
export function deleteReasonReporter({ game, page, lastReason }, send = track) {
  let sent = false;
  return choice => {
    const params = sent ? null : deleteReasonParams({ game, page, choice, lastReason });
    if (!params) return false;
    sent = true;
    send('ce_delete_reason', params);
    return true;
  };
}

/**
 * What a shown out-of-space list does when the page's calculator or its
 * listing changes. `refusedBy` is the calculator that refused the send and
 * `rows` the listing the list was drawn from. 'wait' with no calculator
 * (its Deletes wait for the cable), 'drop' for any other calculator (the
 * same one plugged in again cannot be told apart, and its listing answers
 * another refusal), 'redraw' when the listing changed, else 'keep'.
 */
export function spaceListChange({ refusedBy, calc, rows }) {
  if (!calc) return 'wait';
  if (calc !== refusedBy) return 'drop';
  return calc.rows === rows ? 'keep' : 'redraw';
}

/**
 * Whether a card's game is on the calculator, kept in step with the listing.
 * `rowsNow()` is the listing to check, or null when there is none (no
 * calculator, or Delete off); `check(rows)` resolves whether the game is in
 * `rows`; `repaint()` runs when a new answer changes what the card shows.
 * `ownedNow()` (optional) is anything else the check reads, such as the
 * programs known to be the site's own, kept as a new array whenever it
 * changes: a new one is checked again like a new listing, even when the
 * listing could not be taken again.
 * The function this returns reads the answer: false until the check for the
 * current listing resolves; a new listing resets it to false and checks
 * again; an answer for an older listing, or a failed check, changes nothing.
 */
export function presenceTracker({ rowsNow, ownedNow = () => null, check, repaint }) {
  let checked = null, checkedOwned = null, round = 0, here = false;
  return () => {
    const rows = rowsNow();
    const owned = rows ? ownedNow() : null;
    if (rows !== checked || owned !== checkedOwned) {
      checked = rows;
      checkedOwned = owned;
      const mine = ++round;
      here = false;
      if (rows) {
        new Promise(resolve => resolve(check(rows))).then(answer => {
          if (mine !== round || !!answer === here) return;
          here = !!answer;
          repaint();
        }, () => { /* no answer: the card keeps Send */ });
      }
    }
    return here;
  };
}

// The calculator's own answer when a variable does not fit.
const OUT_OF_MEMORY = 0x000C;

/**
 * Which memory a refused send ran out of: 'archive' or 'ram' from the space
 * check before anything moves, 'any' when the calculator itself refused for
 * memory part way. null for any other error.
 */
export function outOfSpace(err) {
  if (err?.code === 'NO_ARCHIVE_SPACE') return 'archive';
  if (err?.code === 'NO_RAM_SPACE') return 'ram';
  if (err?.code === 'CALC_ERROR' && err.calcError === OUT_OF_MEMORY) return 'any';
  return null;
}

/**
 * Transfers that go in order and are retried as a whole: `run()` resumes at
 * the step that failed, so a step that finished is never sent twice. `next`
 * is the index `run()` starts at.
 */
export function resumable(steps) {
  let next = 0;
  return {
    get next() { return next; },
    async run() {
      while (next < steps.length) {
        await steps[next]();
        next++;
      }
    },
  };
}

const LINK_DEAD = [...LINK_LOST, 'LINK_CLOSED'];
const FILE_CODES = ['BAD_FILE', 'BAD_ENTRY', 'BAD_NAME', 'UNSUPPORTED_TYPE'];
// "Busy" and "go to the home screen": wait and retry, no need to reconnect.
const CALC_BUSY = [0x0011, 0x0034];

// Refused while a program runs on the calculator, a shell such as arTIfiCE
// included. The link survives it, so the same button works once the program
// is quit. Its reason stays calc_error_54.
export const PROGRAM_RUNNING = 0x0036;
export function programRunning(err) {
  return err?.code === 'CALC_ERROR' && err.calcError === PROGRAM_RUNNING;
}
// The key that leaves the arTIfiCE shell.
export const LEAVE_SHELL_KEY = 'mode'; // observed on hardware: clear does nothing in the arTIfiCE v2.1 shell, mode returns to the home screen
export const RUNNING_TEXT = "Your calculator is running a program, so it can't take files. Quit the program and go back to the home screen, then try again.";

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
  0x0036: 'a program is running on the calculator',
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
  0x0036: 'a program is running on the calculator',
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

// The calculator's own out-of-memory refusal part way through a send, in the
// words the space check before a send uses.
export const OUT_OF_MEMORY_TEXT = "Your calculator ran out of memory. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management), then try again.";

/**
 * What a CE download page shows for a failed connect or send. `own` maps a
 * reason to the page's own sentence. Other errors get the refusal or the
 * library's message, which says "game"; the math page's things are
 * programs. The page's own sentences say "game" only where they mean one.
 * A send that stopped part way asks for Send again, unless it stopped for
 * memory: that sentence already says to free some and try again. A read the
 * calculator refused the way it does while a program runs (`runningRead`,
 * set by deleteGame's check before a delete) reads as a running program too.
 * A broken read-back's own words already ask for Send again, so they get no
 * second ask.
 */
export function pageErrorText(err, { page, own = {} } = {}) {
  const reason = failReason(err);
  let text = programRunning(err) || err?.runningRead ? RUNNING_TEXT : Object.hasOwn(own, reason) ? own[reason] : outOfSpace(err) === 'any' ? OUT_OF_MEMORY_TEXT : '';
  if (!text) {
    const engine = refusalText(err) || err?.message || String(err);
    text = page === 'math' ? engine.replace(/\bgame\b/g, 'program') : engine;
  }
  if (asksSendAgain(err) && err?.code !== 'READBACK') text += ' Press Send again to finish.';
  return text;
}

/**
 * Whether pageErrorText's words for `err` ask for another send: a broken
 * read-back ("Click Send again to retry.") or a send that stopped part way
 * for anything but memory. The page puts a Send again button beside them.
 */
export function asksSendAgain(err) {
  return err?.code === 'READBACK' || (!!(err?.partial?.length || err?.removed?.length) && !outOfSpace(err));
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
