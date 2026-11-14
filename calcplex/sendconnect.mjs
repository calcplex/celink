// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// Connect help for "Send to calculator" on the TI-84 Plus CE download pages
// (ce-send.mjs), second version:
//   - before the first device list: one line on what to click in it, and
//     one on the cable (hintHtml);
//   - how long the device list stayed open, and whether a calculator this
//     site was allowed was plugged in when it closed with nothing picked
//     (timedUsb, pickerParams), on ce_connect_fail and ce_calc_info;
//   - a failed connect's fix inside the card (failPanel): on Windows an empty
//     or closed list leads with installing TI Connect CE, whose driver puts
//     the calculator in the list; an open refused for security with updating
//     it; a calculator another program holds says so first; a Chromebook that
//     refused the open twice is told once that it blocks USB devices and is
//     offered the file; a TI-84 Evo picked on a game page that has an Evo
//     version links that version.
// On localhost, ?usb=empty, claim, security or evo makes the device list
// behave that way (previewUsb), so each panel can be seen without a calculator.
import { CELink, EVO_PRODUCT_ID, TI_VENDOR_ID } from '../celink.mjs';
import { PREVIEW_HOST, TICONNECT_URL, esc, failReason, openDetail } from './core.mjs';

// The words, by the site's voice: data-ce-voice="quick" on the script tag
// for the quick one, the plain one otherwise.
const WORDS = {
  plain: {
    hint: ['In the list that opens, click your calculator, then Connect.', 'Use the cable that came with your calculator. Some cables only charge.'],
    again: 'Connect again',
    winNoDevice: {
      lead: 'Install TI Connect CE, then connect again.',
      why: 'On Windows, your calculator only shows up in the list once TI Connect CE is installed.',
      steps: [
        link => `${link('Download TI Connect CE from TI')} and run the installer. Already have it? Update it to the latest version.`,
        () => "If TI Connect CE opens, close it. This page can't reach the calculator while it's open.",
        () => 'Unplug the calculator, plug it back in and turn it on.',
      ],
      pick: 'In the list, click your calculator, then Connect.',
      cable: 'Still not in the list? Try another USB cable. Some cables only charge.',
    },
    noDevice: {
      lead: 'No calculator was picked.',
      pick: "In the list, click your calculator's name, then Connect.",
      cable: "Not in the list? Check that it's turned on, and use the cable that came with it. Some cables only charge.",
    },
    claimed: {
      lead: 'TI Connect CE (or another tab) is using the calculator.',
      leadChromeOS: 'Another tab is using the calculator.',
      next: 'Close it, then connect again.',
      stuck: 'Still stuck? Unplug the calculator and plug it back in.',
    },
    winSecurity: {
      lead: "Windows won't let this page use the calculator yet.",
      steps: [
        link => `${link('Download the latest TI Connect CE from TI')} and run the installer. Already on the latest? Uninstall it, then install it again.`,
        () => 'If TI Connect CE opens, close it.',
        () => 'Unplug the calculator, then plug it back in.',
      ],
    },
    chromeosBlocked: {
      lead: 'This Chromebook blocks websites from using USB devices.',
      why: 'This is often a school setting.',
      file: 'Download the file, then send it from a Windows or Mac computer with TI Connect CE.',
      list: what => `Download a ${what} below, then send it from a Windows or Mac computer with TI Connect CE.`,
      button: label => `Download ${label}`,
    },
    evoTwin: name => ["That's a TI-84 Evo.", `Get the Evo version of ${name} here.`],
  },
  quick: {
    hint: ['A popup lists your calc. Click it, then hit Connect.', 'Use the cable that came with your calc. Some cables only charge.'],
    again: 'Try again',
    winNoDevice: {
      lead: 'Calc not in the list? Get TI Connect CE first.',
      why: 'On Windows, your calc only shows up once TI Connect CE is installed.',
      steps: [
        link => `${link('Get TI Connect CE from TI')} and install it. Already have it? Update it.`,
        () => 'Close TI Connect CE if it opens.',
        () => 'Unplug your calc, plug it back in and turn it on.',
      ],
      pick: 'Then click your calc in the list and hit Connect.',
      cable: 'Still not there? Try another cable. Some only charge.',
    },
    noDevice: {
      lead: 'No calc picked.',
      pick: 'Click your calc in the list, then hit Connect.',
      cable: 'Not in the list? Turn it on and use the cable that came with it. Some cables only charge.',
    },
    claimed: {
      lead: 'TI Connect CE (or another tab) is using your calc.',
      leadChromeOS: 'Another tab is using your calc.',
      next: 'Close that, then try again.',
      stuck: 'Still stuck? Unplug your calc and plug it back in.',
    },
    winSecurity: {
      lead: "Windows won't let this page use your calc yet.",
      steps: [
        link => `${link('Get the latest TI Connect CE from TI')} and install it, even if you have it.`,
        () => 'Close TI Connect CE if it opens.',
        () => 'Unplug your calc and plug it back in.',
      ],
    },
    chromeosBlocked: {
      lead: "This Chromebook won't let websites use USB.",
      why: "That's often a school setting.",
      file: 'Download it, then send it from a Windows or Mac computer with TI Connect CE.',
      list: what => `Hit Download! on a ${what} below, then send it from a Windows or Mac computer with TI Connect CE.`,
      button: () => 'Download!',
    },
    evoTwin: name => ["That's a TI-84 Evo.", `Get the Evo version of ${name} here.`],
  },
};
const words = setup => WORDS[setup?.ceVoice === 'quick' ? 'quick' : 'plain'];

/** What to click in the device list and the cable line, under a Connect button before any device list. */
export function hintHtml(setup) {
  const [pick, cable] = words(setup).hint;
  return `<p class="ce-hint"><span>${esc(pick)}</span> <span>${esc(cable)}</span></p>`;
}

/** Shows or hides the hint inside `root` (a game page's card). */
export function showHint(root, on) {
  const hint = root?.querySelector?.('.ce-hint');
  if (hint) hint.hidden = !on;
}

// ------------------------------------------------------------ the device list

/** How long the device list was open, bucketed as the TI-84 Evo pages report theirs. */
export function pickerBucket(ms) {
  return ms < 300 ? '0s' : ms <= 2000 ? '2s' : ms <= 5000 ? '5s' : ms <= 15000 ? '15s' : ms <= 60000 ? '60s' : 'long';
}

// This click's list: '' when none was shown (a calculator this site was
// allowed connected without one), else its bucket, with _g when it closed
// with nothing picked while a TI device this site was allowed was plugged in
// (so the list was not empty). A lower bound: a first-time student's
// calculator is not allowed yet, so it never counts.
let clickPicker = '';

/**
 * navigator.usb with its device list timed, for one connect: pass it to
 * gamesend's pickCalculator. requestDevice is called straight through, so the
 * click's permission reaches the browser as before.
 */
export function timedUsb(usb = previewUsb() ?? globalThis.navigator?.usb) {
  clickPicker = '';
  if (!usb) return usb;
  return {
    getDevices: () => usb.getDevices(),
    async requestDevice(options) {
      const t0 = Date.now();
      try {
        const device = await usb.requestDevice(options);
        clickPicker = pickerBucket(Date.now() - t0);
        return device;
      } catch (err) {
        let label = pickerBucket(Date.now() - t0);
        if (label !== '0s') {
          try { if ((await CELink.granted({ usb })).length) label += '_g'; } catch { /* no answer: no suffix */ }
        }
        clickPicker = label;
        throw err;
      }
    },
  };
}

/** `picker` for this connect's events, when a device list was shown. */
export const pickerParams = () => (clickPicker ? { picker: clickPicker } : {});

// ------------------------------------------------------------ failed connects

// The errors this page load's Connect clicks failed with, so a send that
// failed while connecting gets the same fix as the Connect button.
const connectErrors = new WeakSet();
let chromeosSecurity = 0;

/**
 * A failed connect (not the quiet one on load): noted for failPanel, counted
 * when a Chromebook refused the open, and the extra ce_connect_fail params.
 */
export function noteFail(err, { cros = false } = {}) {
  if (err && typeof err === 'object') connectErrors.add(err);
  if (cros && failReason(err) === 'open_failed' && openDetail(err) === 'open_security') chromeosSecurity++;
  return pickerParams();
}

/** Which fix a failed connect gets, or null for the page's usual words. */
export function failKind(err, { win = false, cros = false, installerTab = false, twin = false } = {}) {
  if (!connectErrors.has(err)) return null;
  const reason = failReason(err);
  const detail = openDetail(err);
  if (reason === 'no_device') return win ? 'win_nodevice' : 'nodevice';
  if (reason === 'open_failed' && detail === 'open_security') {
    if (win) return 'win_security';
    if (cros && chromeosSecurity >= 2) return 'chromeos_blocked';
    return null;
  }
  // After a click through to the installer in another tab, the page's own words name that tab.
  if (reason === 'open_failed' && detail === 'claim_network') return installerTab ? null : 'claimed';
  if (reason === 'evo' && twin) return 'evo_twin';
  return null;
}

const tiLink = text => `<a href="${TICONNECT_URL}" target="_blank" rel="noopener nofollow">${esc(text)}</a>`;
const steps = list => `<ol>${list.map(s => `<li>${s(tiLink)}</li>`).join('')}</ol>`;

/**
 * A failed connect's fix as HTML for the card it failed in, or null to keep
 * the page's usual words. `where`: 'game' (a game page's card; its Connect
 * again button is .ce-connect-again), 'card' (a hub card's message, whose
 * button is the card's .ce-send-again: connect, then send), or 'panel' (the
 * hub's connect panel, whose own button sits under it and reads Connect again).
 * `dl` is the page's "Download the file instead", kept under the fix.
 */
export function failPanel(err, ctx = {}) {
  const { where = 'game', page = 'game', setup = {}, file = '', label = '', dl = '' } = ctx;
  const twin = setup.ceEvoTwin && setup.ceEvoName ? { href: setup.ceEvoTwin, name: setup.ceEvoName } : null;
  const kind = failKind(err, { ...ctx, twin: !!twin });
  if (!kind) return null;
  const w = words(setup);
  const again = where === 'game' ? `<p class="ce-fix-go"><button type="button" class="ce-connect-again">${esc(w.again)}</button></p>`
    : where === 'card' ? `<p class="ce-fix-go"><button type="button" class="ce-send-again">${esc(w.again)}</button></p>` : '';
  const box = (body, { retry = true } = {}) => `<div class="ce-fix" data-fix="${kind}"${retry ? ' data-again' : ''}>${body}${retry ? again : ''}</div>`;
  switch (kind) {
    case 'win_nodevice': {
      const t = w.winNoDevice;
      return box(`<p><strong>${esc(t.lead)}</strong> ${esc(t.why)}</p>${steps(t.steps)}<p><strong>${esc(t.pick)}</strong></p><p>${esc(t.cable)}</p>`) + dl;
    }
    case 'nodevice': {
      const t = w.noDevice;
      return box(`<p><strong>${esc(t.lead)}</strong></p><p><strong>${esc(t.pick)}</strong></p><p>${esc(t.cable)}</p>`) + dl;
    }
    case 'claimed': {
      const t = w.claimed;
      return box(`<p><strong>${esc(ctx.cros ? t.leadChromeOS : t.lead)}</strong> ${esc(t.next)}</p><p>${esc(t.stuck)}</p>`) + dl;
    }
    case 'win_security': {
      const t = w.winSecurity;
      return box(`<p><strong>${esc(t.lead)}</strong></p>${steps(t.steps)}`) + dl;
    }
    case 'chromeos_blocked': {
      // Said instead of "try again": the file is the way on from here.
      const t = w.chromeosBlocked;
      const what = page === 'math' ? 'program' : 'game';
      const go = file
        ? `<p>${esc(t.file)}</p><p class="ce-fail-dl ce-fix-dl"><a href="${esc(encodeURI(file))}" data-google-vignette="false">${esc(t.button(label))}</a></p>`
        : `<p>${esc(t.list(what))}</p>`;
      return box(`<p><strong>${esc(t.lead)}</strong> ${esc(t.why)}</p>${go}`, { retry: false });
    }
    case 'evo_twin': {
      const [lead, get] = w.evoTwin(twin.name);
      return `<p>${esc(lead)} <a href="${esc(twin.href)}">${esc(get)}</a></p>`;
    }
    default: return null;
  }
}

/** The hub panel's error, as a block: a fix as it is, other words in the panel's error line. */
export const errBlock = html => (String(html).startsWith('<div class="ce-fix') ? html : `<p class="msg err">${html}</p>`);

/** A connect panel's button under an error: the voice's Connect again under a fix that asks for it (the plain voice with no `setup`). */
export const panelButton = (html, setup) => (/^<div class="ce-fix"[^>]* data-again>/.test(String(html)) ? words(setup).again : 'Connect your calculator');

// ---------------------------------------------------------------- preview

// A device that refuses the open the way `mode` says, for previewUsb.
function refusingDevice(mode) {
  const fail = name => { throw new DOMException(`Preview: ${mode}`, name); };
  return {
    vendorId: TI_VENDOR_ID,
    productId: mode === 'evo' ? EVO_PRODUCT_ID : 0xE008,
    productName: mode === 'evo' ? 'TI-84 Evo' : 'TI-84 Plus CE',
    opened: false,
    configuration: null,
    configurations: [],
    async open() { if (mode === 'security') fail('SecurityError'); this.opened = true; },
    async selectConfiguration() {},
    async claimInterface() { fail('NetworkError'); },
    async releaseInterface() {},
    async close() { this.opened = false; },
    async reset() {},
  };
}

/**
 * On localhost only: ?usb=empty (the list closes with nothing picked after a
 * moment), claim (another program holds the calculator), security (the open
 * is refused for security) or evo (a TI-84 Evo is picked). Null otherwise.
 */
export function previewUsb(search = globalThis.location?.search ?? '') {
  const m = PREVIEW_HOST && /[?&]usb=(empty|claim|security|evo)\b/.exec(search);
  if (!m) return null;
  return {
    getDevices: async () => [],
    async requestDevice() {
      await new Promise(r => setTimeout(r, 700));
      if (m[1] === 'empty') throw new DOMException('Preview: no device selected.', 'NotFoundError');
      return refusingDevice(m[1]);
    },
  };
}
