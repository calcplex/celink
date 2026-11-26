// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// Exit test mode on a TI-84 Plus CE. TI's own way to bring a CE out of
// Press-to-Test is to send it a file from a computer (TI Connect CE) or from
// another calculator. This does exactly that over WebUSB: it sends one empty
// AppVar under a name the calculator does not already have, then deletes that
// AppVar again. It lists the names on the calculator to pick a free one;
// nothing else is changed or removed, and nothing here can turn test mode on.
//
// transport() is the CE side of the exit page's panel (exit-panel.mjs): how a
// calculator is found (the one this site was allowed, else the browser's
// device list, timed and with the CE pages' connect help on a failed or
// closed list) and the exit itself. The panel owns the button, the words both
// calculators share, the counting and the feedback box.
import { CELink, EVO_PRODUCT_ID } from '../celink.mjs';
import { TYPE, makeEntry } from '../tifiles.mjs';
import { isWindows, isChromeOS } from './core.mjs';
import * as SC from './sendconnect.mjs';

export const BASE_NAME = 'EXITTEST';

/** A name for the AppVar that no variable on the calculator has yet. */
export function freeName(rows) {
  const taken = new Set((rows ?? []).map(r => String(r.name).toUpperCase()));
  if (!taken.has(BASE_NAME)) return BASE_NAME;
  for (let i = 1; i <= 9; i++) {
    const n = `EXITTES${i}`;
    if (!taken.has(n)) return n;
  }
  return null;
}

/**
 * The whole exit, on a link that is not open yet. Resolves
 * { name, deleted } or throws the link's error (a CELinkError).
 */
export async function exitTestMode(link, { log = null } = {}) {
  await link.open();
  try {
    await link.ready();
    const rows = await link.list();
    const name = freeName(rows);
    if (!name) throw Object.assign(new Error('Every name this tool can use is taken.'), { code: 'NAME_TAKEN' });
    const entry = makeEntry({ name, type: TYPE.APPVAR, body: new Uint8Array(0) });
    await link.send(entry, { archive: false });
    log?.('sent', name);
    let deleted = false;
    try {
      await link.delete(name, TYPE.APPVAR);
      deleted = true;
      log?.('deleted', name);
    } catch (e) {
      log?.('delete failed', e?.code ?? e?.message);
    }
    return { name, deleted };
  } finally {
    await link.close();
  }
}

/** The analytics reason bucket for a failure. */
export function reasonOf(err) {
  switch (err?.code) {
    case 'NO_DEVICE_SELECTED': return 'no_device';
    case 'TI84_EVO': return 'evo';
    case 'OPEN_FAILED': return 'open_failed';
    case 'NO_WEBUSB': return 'browser';
    case 'NAME_TAKEN': return 'name_taken';
    case 'TIMEOUT': case 'USB_ERROR': case 'DISCONNECTED': case 'PROTOCOL': return 'link';
    default: return 'other';
  }
}

// The CE's own lines. The connect help (an empty or closed list, a refused
// open, a calculator another program holds) is the CE pages' (sendconnect.mjs).
export const WORDS = {
  done: 'Done. Test mode is off.',
  open: "Couldn't open the CE. Close anything else using it (TI Connect CE or another tab), unplug it, plug it back in, then try again.",
  link: 'The CE stopped answering. Unplug it, plug it back in, then try again.',
  elsewhere: 'Use a different computer.',
  browser: 'This tool needs <strong>Chrome</strong> or <strong>Edge</strong> on a computer. This browser can\'t connect to a CE.',
  mobile: 'Exiting test mode needs a <strong>computer</strong> (Windows, Mac, or Chromebook) running <strong>Chrome</strong> or <strong>Edge</strong>. Phones and tablets can\'t connect to the calculator.',
};

function mobileNav(nav) {
  const ua = nav?.userAgentData;
  if (ua && typeof ua.mobile === 'boolean') return ua.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');
}

/**
 * The CE transport for exit-panel.mjs. `usb` stands in for navigator.usb
 * (tests), `nav` for navigator (tests: a Windows computer).
 */
export function transport({ usb, nav = globalThis.navigator } = {}) {
  const realUsb = () => (usb !== undefined ? usb : nav?.usb);
  const win = () => isWindows(nav ?? {});
  const cros = () => isChromeOS(nav ?? {});
  const ctx = () => ({ where: 'game', page: 'exit', win: win(), cros: cros(), installerTab: false, setup: {} });
  let device = null;

  return {
    model: 'ce',
    name: 'TI-84 Plus CE',
    short: 'CE',
    words: WORDS,
    other: { name: 'TI-84 Evo', short: 'Evo', href: '/exit-test-mode/' },
    // WebUSB lists every TI calculator, so an Evo can be picked here.
    listShowsOther: true,
    countsExit: false,
    // A phone first (as the Evo's): an iPhone has no WebUSB and gets the phone line.
    support() {
      if (mobileNav(nav)) return 'mobile';
      if (!realUsb()) return 'browser';
      return '';
    },
    unsupportedHtml(kind) { return kind === 'mobile' ? WORDS.mobile : WORDS.browser; },
    hintHtml: () => SC.hintHtml({}),
    watch(cb) {
      const u = realUsb();
      if (u?.addEventListener) {
        u.addEventListener('connect', cb);
        u.addEventListener('disconnect', cb);
      }
    },
    /** A CE this site was allowed, plugged in now (no device list needed). */
    async present() {
      try {
        const list = await CELink.granted({ usb: realUsb() });
        device = list.find(d => d.productId !== EVO_PRODUCT_ID) ?? null;
      } catch { device = null; }
      return !!device;
    },
    /** The browser's device list, timed; resolves once a CE is picked. */
    async pick() {
      const link = await CELink.request({ usb: SC.timedUsb(usb) });
      if (link.device.productId === EVO_PRODUCT_ID) {
        throw Object.assign(new Error('TI-84 Evo picked'), { code: 'TI84_EVO' });
      }
      device = link.device;
    },
    pickerParams: () => SC.pickerParams(),
    async exit() {
      await exitTestMode(CELink.fromDevice(device));
    },
    reason: reasonOf,
    // a closed list: the CE pages' connect help, never an error line
    isCancel: err => reasonOf(err) === 'no_device',
    isWrong: err => reasonOf(err) === 'evo',
    /**
     * The CE pages' fix for a failed connect, or the CE's own line. A
     * Chromebook that refused the open twice gets the CE pages' first two
     * sentences (it blocks USB devices); their next step offers a game's
     * file, so here the next step is another computer.
     */
    failHtml(err) {
      SC.noteFail(err, { cros: cros() });
      const c = ctx();
      if (SC.failKind(err, c) === 'chromeos_blocked') {
        const cause = /<p>([\s\S]*?)<\/p>/.exec(SC.failPanel(err, c) ?? '');
        return cause ? `${cause[1]} ${WORDS.elsewhere}` : WORDS.open;
      }
      const fix = SC.failPanel(err, c);
      if (fix) return fix;
      switch (reasonOf(err)) {
        case 'no_device': return null;
        case 'open_failed': return WORDS.open;
        default: return WORDS.link;
      }
    },
    doneHtml: WORDS.done,
  };
}
