// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The installer's Connect step: where a failed connect leads, a Connect that
// drops a dead link instead of asking for a reload, and connecting the same
// calculator again part way through an install.
import { isChromeOS, isWindows, needsAsm, platformName, refusal } from './core.mjs';

/**
 * The screen a failed connect moves to, or null to stay and show the error.
 * Only Windows has one: an empty or cancelled device list (no_device) goes to
 * the screen that installs or updates TI Connect CE, whose driver is what
 * puts the calculator in the list; an open refused for security goes to the
 * update screen. Never back to the screen the student is on.
 */
export function connectFailScreen({ reason, detail, windows, screen }) {
  if (!windows) return null;
  if (reason === 'no_device' && screen !== 'win_nodevice' && screen !== 'win_install') return 'win_nodevice';
  if (reason === 'open_failed' && detail === 'open_security' && screen !== 'win_security') return 'win_security';
  return null;
}

/**
 * transport.connect(), after dropping a link that died. The device list still
 * opens first in the click: the dead link is closed alongside it and the open
 * waits for that close (in `beforeOpen`, which runs after the list).
 */
export async function connectAfresh(transport, { beforeOpen } = {}) {
  let closing = null;
  if (transport.poisoned) {
    const dead = transport.link;
    transport.poisoned = false;
    transport.info = null;
    closing = dead ? dead.close().catch(() => {}) : null;
  }
  return transport.connect({
    beforeOpen: async () => {
      await closing;
      if (beforeOpen) await beforeOpen();
    },
  });
}

/**
 * Connect again part way through an install, after an unplug or another tab
 * took the calculator. The device list opens as on the Connect screen, and the
 * calculator must be the one the install started on: same route, same OS.
 * Anything else, or a failed connect, leaves the transport as it was (dead), so
 * the next press of a send button asks for this again rather than sending.
 */
export async function reconnect(transport, { beforeOpen } = {}) {
  const before = transport.info;
  if (!before) throw refusal('NOT_CONNECTED', 'Connect and read the OS first.');
  transport.poisoned = true;
  let info;
  try {
    info = await connectAfresh(transport, { beforeOpen });
  } catch (err) {
    transport.info = before;
    transport.poisoned = true;
    throw err;
  }
  if (info.route !== before.route || info.os !== before.os) {
    await transport.link?.close().catch(() => {});
    transport.info = before;
    transport.poisoned = true;
    throw refusal('OTHER_CALCULATOR', 'This is not the calculator you started with.');
  }
  return info;
}

/**
 * What the no-WebUSB card says: 'chromeos' (USB turned off, as on some school
 * Chromebooks), 'mobile' (a phone or tablet: do this on a computer) or
 * 'computer' (the wrong browser: open this page in Chrome or Edge).
 */
export function noUsbKind(nav) {
  if (isChromeOS(nav)) return 'chromeos';
  if (isWindows(nav)) return 'computer';
  const p = platformName(nav);
  return p === 'android' || p === 'ios' ? 'mobile' : 'computer';
}

// TI-Planet's archive entry for OS 5.4.0, the last version where assembly
// games start from prgm without a jailbreak. The file is never hosted or sent
// here; the student sends it with TI Connect CE.
export const OS_540_URL = 'https://tiplanet.org/forum/archives_voir.php?id=2236014&short=1';

/** Whether to offer the update to OS 5.4.0: only on OS 5.2 and earlier, never on 5.3 or later. */
export function offersOs540(version) {
  return needsAsm(String(version));
}

// A send refused as a program running (0x0036) on v3's Play screen: the
// likeliest program is AsmHook2, left on its Installation successful screen.
export const ASMHOOK_OPEN_TEXT = "Your calculator is probably still on AsmHook2's Installation successful screen, so it can't take files. Press clear until the home screen shows, then press Send Snake again.";

/** The text for a program-running refusal, or null to keep the page's usual one. */
export function runningText({ route, screen }) {
  return route === 'v3' && screen === 'play' ? ASMHOOK_OPEN_TEXT : null;
}
