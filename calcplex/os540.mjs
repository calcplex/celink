// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The installer's update to OS 5.4.0, for a TI-84 Plus CE on OS 5.2 or
// earlier: the student downloads TI's OS file from TI-Planet, picks it here,
// and the page sends it. The file is TI's and is never fetched, hosted or
// changed here. Only 5.4.0, only to a calculator older than 5.3.
import { BOOT_MODE_REFUSAL, parseOSFile, sendOS } from '../celink-os.mjs';
import { esc, helpHtml, refusal } from './core.mjs';
import { OS_540_URL, connectAfresh, offersOs540 } from './connect.mjs';

/** The one OS this page sends, and the calculators it sends it to (older than `below`). */
export const OS540 = Object.freeze({ version: '5.4.0', below: '5.3.0' });

const OS_TIMEOUT_MS = 60000;

/**
 * Check a picked file before it is kept: TI's OS 5.4.0 for the TI-84 Plus CE,
 * signature fields present, nothing else. Returns { version, size }; refuses
 * with code OS_FILE and a sentence for the page.
 */
export function pickOS540(bytes) {
  let os;
  try {
    ({ os } = parseOSFile(bytes));
  } catch (e) {
    const text = {
      NOT_AN_OS: "That file isn't an OS. Pick the .8eu file from TI-Planet.",
      WRONG_MODEL: "That OS is for another calculator. Pick OS 5.4.0 for the TI-84 Plus CE.",
      NOT_SIGNED: "That file isn't TI's OS. Download it again from TI-Planet.",
    }[e.code] ?? "That file isn't a complete OS file. Download it again from TI-Planet.";
    throw refusal('OS_FILE', text, { fileCode: e.code, page: true });
  }
  if (os.base !== OS540.version) {
    throw refusal('OS_FILE', `That's OS ${os.version}. Pick OS 5.4.0: on 5.5 or later, games need a jailbreak.`, { fileCode: 'OS_VERSION', version: os.version, page: true });
  }
  return { version: os.version, size: os.size };
}

/**
 * Send OS 5.4.0 to the connected calculator. The installer's link is closed
 * first (sendOS opens the device itself) and the transport is left dead, so
 * the next Connect drops it (connect.mjs connectAfresh). Also works on a
 * calculator waiting for an OS, picked by a connect that failed with 0x0009:
 * transport.device is that calculator.
 */
export async function sendOS540(transport, bytes, { onProgress, onStage } = {}) {
  pickOS540(bytes);
  const device = transport.device ?? transport.link?.device;
  if (!device) throw refusal('NOT_CONNECTED', 'Connect the calculator first.');
  await transport.link?.close().catch(() => {});
  transport.poisoned = true;
  transport.info = null;
  return sendOS(device, bytes, { ...OS540, onProgress, onStage, osTimeout: OS_TIMEOUT_MS });
}

/** True when a connect found a calculator waiting for an OS: it refuses the normal mode with 0x0009. */
export function waitingForOS(err) {
  return err?.code === 'CALC_ERROR' && err.calcError === BOOT_MODE_REFUSAL;
}

/**
 * Whether a failed send leaves the calculator waiting for its OS. From the
 * data on, the old OS is gone. A link lost while the header goes out may
 * have gone either way. A refusal before the data changes nothing.
 */
export function leftWaiting(err) {
  if (err?.osStage === 'data' || err?.osStage === 'eot') return true;
  return err?.osStage === 'header' && err?.code !== 'OS_REFUSED' && !!err?.lost;
}

/** What the page says when a send fails. */
export function osSendText(err) {
  switch (err?.code) {
    case 'OS_FILE':
    case 'OS_VERSION': return err.page ? err.message : "That file isn't OS 5.4.0 for the TI-84 Plus CE.";
    case 'OS_TOO_NEW': return 'This calculator already has OS 5.3 or later.';
    case 'NOT_A_CE': return "This isn't a TI-84 Plus CE.";
    case 'BATTERY_LOW': return 'The battery is low. Charge the calculator, then send again.';
    case 'OS_REFUSED': return 'The calculator refused this OS. Nothing changed on it.';
    default: break;
  }
  if (leftWaiting(err)) return 'The update stopped part way. The calculator now waits for its OS.';
  if (err?.osStage === 'header') return 'The connection dropped as the update started. Connect again to see where the calculator is.';
  return null;
}

// A send that stopped part way is remembered for a day, so a page opened
// again still knows what a calculator waiting for an OS needs. Storage may be
// blocked; then it is only known in this page.
const PENDING_KEY = 'cec-os540';
const PENDING_MS = 24 * 3600 * 1000;
let pendingHere = false;

export function markPending(store = globalThis.localStorage) {
  pendingHere = true;
  try { store?.setItem(PENDING_KEY, String(Date.now())); } catch { /* storage blocked */ }
}
export function clearPending(store = globalThis.localStorage) {
  pendingHere = false;
  try { store?.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
}
export function pending(store = globalThis.localStorage, now = Date.now()) {
  if (pendingHere) return true;
  try {
    const at = Number(store?.getItem(PENDING_KEY));
    return at > 0 && now - at < PENDING_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the installer's screens

/**
 * The installer's OS 5.4.0 screens, wired into the installer by its os_send
 * feature blocks. `ui` is what they
 * use of the installer: { $, root, state, transport, work, say, paint,
 * trackStep, claim, pickerHint, tiLink, keyHelp, viewNative, viewRoute, app }.
 * `app`, set while the installer draws its app panel, is that panel's pieces:
 * { paint(screen, step, name), btn, quiet, warn, archive }. There the update
 * is its own screens, one step each, laid out as the Inequality Graphing
 * install is; without it, a box on the native screen.
 * Returns { box, wire, found, waiting, sent, link, wireLink, start, landed }:
 * the native screen's box (or, in the panel, its link to the update and that
 * link's wiring), the update's screens, the screen for a Connect that found a
 * calculator waiting for its OS, and whether a connect found the update done.
 */
export function os540Screens(ui) {
  const { $, state } = ui;
  let pickedOS = null;   // TI's OS 5.4.0, once picked; kept so sending again needs no second pick
  let bandsWired = false;
  let bandsHome = null;
  const app = ui.app || null;

  // With the file already picked (sending again), only the button.
  const pick = ({ status = false, input = true } = {}) => `${input ? `
      <label class="cec-file-input">Choose the .8eu file you downloaded
        <input type="file" id="cec-os-file" accept=".8eu"></label>` : ''}
      <div class="cec-actions"${status ? ' data-status' : ''} id="cec-os-row">
        <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-os-send" disabled>Send OS 5.4.0</button></div>
      </div>`;
  const before = () => `
      <ul class="cec-os540-notes">
        <li>It takes a few minutes. Keep the cable plugged in until the calculator restarts.</li>
        <li>It erases the programs in RAM. Archive or back up the ones you want to keep.</li>
        <li>If it stops part way, plug the calculator back in and send again. The calculator waits for its OS.</li>
      </ul>`;
  const tiConnect = () => `<p class="cec-why">Or send the file with ${ui.tiLink('TI Connect CE')}, then press Start over.</p>`;

  // The app panel: numbered steps with their own buttons, as the Inequality
  // Graphing install has them. The next step's button is filled, the others
  // outlined, a step done is ticked.
  const PICK_LINE = '<p class="cec-app-hint cec-app-pickline">In the list that opens, click your calculator, then Connect.</p>';
  const appStep = (step, text, button = '') => `
        <li data-step="${step}"><span${step === 'pick' ? ' id="cec-os-pick-text"' : ''}>${text}</span>${button}</li>`;
  const appChoose = () => '<label class="cec-btn cec-btn-alt cec-btn-step cec-app-file" id="cec-os-pick">Choose file<input type="file" id="cec-os-file" accept=".8eu"></label>';
  const appSendRow = () => `<div class="cec-actions" data-status>${app.btn('cec-os-send', 'Send OS 5.4.0', { disabled: true, big: true })}</div>`;
  let next = 'get';
  const mark = () => {
    if (!app) return;
    const order = ['get', 'pick', 'send'];
    $('#cec-os-steps')?.querySelectorAll?.('li').forEach(li => {
      const at = order.indexOf(li.dataset.step);
      li.classList.toggle('is-done', at >= 0 && at < order.indexOf(next));
      li.classList.toggle('is-next', li.dataset.step === next);
    });
    $('#cec-os540-get')?.classList?.toggle('cec-btn-alt', next !== 'get');
    $('#cec-os-pick')?.classList?.toggle('cec-btn-alt', next !== 'pick');
  };

  // The native screen's way in, under Send, and a "?" saying why.
  const WHY = "OS 5.4.0 doesn't need a jailbreak either. Games start right from the prgm menu, with no Asm(.";
  const link = () => `<p class="cec-app-os540">${app.quiet('cec-os540-open', 'Or update to OS 5.4.0')}${helpHtml('cec', WHY, 'Why update to OS 5.4.0?')}</p>`;
  function wireLink() {
    const open = $('#cec-os540-open');
    if (open) open.onclick = () => { if (!state.busy) start(); };
  }

  // Get the file, pick it, send it.
  function start() {
    next = pickedOS ? 'send' : 'get';
    app.paint({
      title: 'Update to OS 5.4.0',
      lead: `On OS 5.4.0, games start from the ${ui.keyHelp()} menu, with no Asm(.`,
      actions: `<ol class="cec-app-steps cec-app-steps-do" id="cec-os-steps">${
        appStep('get', 'Get OS 5.4.0. The file ends in <code>.8eu</code>.', `<a id="cec-os540-get" class="cec-btn cec-btn-step" href="${OS_540_URL}" target="_blank" rel="noopener nofollow">Get it from TI-Planet</a>`)}${
        appStep('pick', pickedOS ? 'OS 5.4.0 is picked.' : 'Pick the file you downloaded.', appChoose())}${
        appStep('send', 'Send it to the calculator. It takes a few minutes.')}
      </ol>
      ${app.warn(`Erases every program that is not archived. ${app.archive} what you want to keep.`)}
      ${appSendRow()}`,
    }, 2, 'os540_get');
    $('#cec-os540-get')?.addEventListener?.('click', () => {
      ui.trackStep('native_os540');
      if (next === 'get') { next = 'pick'; mark(); }
    });
    wire();
  }

  // The transfer: a bar, and the percent under it.
  function appSending() {
    app.paint({
      title: 'Sending OS 5.4.0',
      lead: 'Keep the cable plugged in. It takes a few minutes.',
      actions: '<div class="cec-app-sendbar" id="cec-os-bar" role="progressbar" aria-label="OS 5.4.0 sent" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><div data-status-spot></div>',
    }, 2, 'os540_sending');
  }
  function progress(pct) {
    const bar = $('#cec-os-bar');
    bar?.setAttribute?.('aria-valuenow', String(pct));
    const fill = bar?.querySelector?.('span');
    if (fill) fill.style.width = `${pct}%`;
    ui.say(`${pct}%`);
  }

  // OS 5.2 and earlier only: the other way, updating to OS 5.4.0, where games
  // start from prgm with no Asm(. Exactly 5.4.0: from 5.5 on, assembly needs a
  // jailbreak. TI Connect CE stays the other way to send it.
  const box = () => `
    <div class="cec-os540">
      <p><strong>Or update to OS 5.4.0.</strong> On 5.4.0, games start from the ${ui.keyHelp()} menu, with no Asm(.</p>
      <ol>
        <li><a id="cec-os540-get" href="${OS_540_URL}" target="_blank" rel="noopener nofollow">Download OS 5.4.0 from TI-Planet</a>. Get 5.4.0 exactly: on OS 5.5 or later, games need a jailbreak.</li>
        <li>Come back to this tab and click Choose File. Pick the <code>.8eu</code> file you downloaded.</li>
        <li>Click Send OS 5.4.0.</li>
      </ol>
      ${before()}
      ${pick()}
      ${tiConnect()}
    </div>`;

  // The file input and Send OS 5.4.0, on the native screen and on the screen
  // for a calculator waiting for its OS. `connect` opens the device list
  // first: the calculator is not connected (waiting for its OS, or restarted).
  function wire({ connect = false } = {}) {
    // On the native screen the status and error lines sit under the game's
    // Send; while the OS box is used they move under the box.
    const bandsUnder = row => {
      if (app || connect || !row?.isConnected) return;
      row.insertAdjacentElement('afterend', $('#cec-status'));
      $('#cec-status').insertAdjacentElement('afterend', $('#cec-error'));
    };
    if (!connect && !app) {
      bandsHome = $('#cec-status')?.previousElementSibling ?? null;
      if (!bandsWired) {
        bandsWired = true;
        ui.root().addEventListener('click', e => {
          if (state.screen !== 'native' || state.busy) return;
          bandsUnder(e.target.closest?.('.cec-os540') ? $('.cec-os540') : bandsHome);
        }, true);
      }
    }
    state.afterWork = () => {
      const b = $('#cec-os-send');
      if (b) b.disabled = !pickedOS;
      mark();
    };
    state.afterWork();
    if (pickedOS && !app) ui.say('OS 5.4.0 is ready to send.');
    const input = $('#cec-os-file');
    if (input) input.onchange = e => ui.work(async () => {
      bandsUnder($('.cec-os540'));
      const file = e.target.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Refused the moment the wrong file is picked, before it is kept.
      pickedOS = null;
      pickOS540(bytes);
      pickedOS = bytes;
      ui.trackStep('os540_picked');
      if (app) {
        next = 'send';
        const text = $('#cec-os-pick-text');
        if (text) text.textContent = 'OS 5.4.0 is picked.';
        ui.say('');
        return;
      }
      ui.say('OS 5.4.0 is ready to send.');
    });
    $('#cec-os-send').onclick = () => ui.work(async () => {
      bandsUnder($('.cec-os540'));
      const bytes = pickedOS;
      if (!bytes) throw refusal('NO_FILE', 'Choose the .8eu file first.');
      if (connect) {
        ui.say('Pick your calculator in the browser window that opens.');
        try {
          state.info = await connectAfresh(ui.transport, { beforeOpen: ui.claim });
        } catch (err) {
          // A calculator waiting for its OS refuses the normal mode: send to it.
          if (!waitingForOS(err)) throw err;
        }
        if (state.info && !offersOs540(state.info.os)) return afterConnect();
      }
      await send(bytes);
    });
  }

  async function send(bytes) {
    const sending = 'Sending OS 5.4.0. Keep the cable plugged in.';
    ui.trackStep('os540_send');
    markPending();
    if (app) appSending();
    ui.say('Checking the calculator.');
    try {
      await sendOS540(ui.transport, bytes, {
        onStage: stage => { if (stage === 'begin') ui.say('Starting the update.'); if (stage === 'eot') ui.say('Finishing.'); },
        onProgress: (done, total) => {
          const pct = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
          if (app) progress(pct);
          else ui.say(total ? `${sending} ${pct}%` : sending);
        },
      });
    } catch (err) {
      ui.trackStep(`os540_fail_${err.osStage || 'file'}`);
      // The native screen stays for anything that left the calculator as it was.
      if (leftWaiting(err)) {
        state.info = null;
        return waiting({ lead: osSendText(err) });
      }
      if (!['OS_REFUSED', 'BATTERY_LOW'].includes(err.code) && err.osStage !== 'header') clearPending();
      // In the panel, back to the steps (the file still picked), the band under Send.
      if (app) start();
      // Its own code, so the error band shows this sentence.
      throw refusal('OS_SEND', osSendText(err) || err.message, { cause: err });
    }
    ui.trackStep('os540_sent');
    ui.say('');
    sent();
  }

  // After the transfer: the calculator checks the OS and restarts by itself.
  function sent() {
    if (app) {
      app.paint({
        title: 'Your calculator is installing OS 5.4.0',
        lead: 'It restarts by itself in about a minute. Once its home screen says RAM Cleared, connect again.',
        actions: `<div class="cec-actions" data-status>${app.btn('cec-go', 'Connect again', { big: true })}</div>`,
        after: PICK_LINE,
      }, 2, 'os540_sent');
    } else {
      ui.paint(`
    <h2>The calculator is installing OS 5.4.0</h2>
    <p class="cec-sub">It checks the new OS, then restarts by itself.</p>
    <div class="cec-do">
      <ol>
        <li>Wait for the home screen. It says RAM Cleared. This takes about a minute.</li>
        <li>Click Connect again.</li>
      </ol>
    </div>
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-go">Connect again</button></div></div>
    ${ui.pickerHint()}
  `, 1, 'os540_sent');
    }
    $('#cec-go').onclick = () => ui.work(async () => {
      ui.say('Pick your calculator in the browser window that opens.');
      try {
        state.info = await connectAfresh(ui.transport, { beforeOpen: ui.claim });
      } catch (err) {
        if (waitingForOS(err)) return waiting({ lead: "The calculator didn't take the OS. It waits for its OS." });
        throw err;
      }
      afterConnect();
    });
  }

  // Connected again: on 5.4.0 the update is done and the usual native screen
  // takes over; any other OS gets its own screen.
  function afterConnect() {
    ui.say('');
    if (!offersOs540(state.info.os)) clearPending();
    if (state.info.os.startsWith(`${OS540.version}.`)) {
      ui.trackStep('os540_done');
      state.os540Done = true;
    }
    if (state.info.route === 'native') ui.viewNative(); else ui.viewRoute();
  }

  // A connect that finds OS 5.4.0 after an update from this page (Connect
  // again, or Start over and a fresh Connect): the update is done, and the
  // native screen says so.
  function landed() {
    if (state.os540Done) return true;
    if (!state.info?.os?.startsWith(`${OS540.version}.`) || !pending()) return false;
    clearPending();
    ui.trackStep('os540_done');
    state.os540Done = true;
    return true;
  }

  // The calculator lost its old OS part way through an update: send again.
  function waiting({ lead = 'The update stopped part way. The calculator waits for its OS.' } = {}) {
    markPending();
    if (app) {
      next = pickedOS ? 'send' : 'pick';
      app.paint({
        title: 'Send OS 5.4.0 again',
        lead: esc(lead),
        actions: `<ol class="cec-app-steps cec-app-steps-do" id="cec-os-steps">${
          appStep('plug', 'Plug the calculator back in. It says Waiting... Please install operating system now.')}${
          pickedOS ? '' : appStep('pick', 'Pick the <code>.8eu</code> file again.', appChoose())}${
          appStep('send', 'Send it again.')}
        </ol>
        ${app.warn("Don't press clear on the calculator. That erases everything on it.")}
        ${appSendRow()}`,
        after: PICK_LINE,
      }, 2, 'os540_waiting');
      return wire({ connect: true });
    }
    ui.paint(`
    <h2>Send OS 5.4.0 again</h2>
    <p class="cec-sub">${esc(lead)}</p>
    <div class="cec-do">
      <ol>
        <li>Plug the calculator back in. It says Waiting... Please install operating system now.</li>
        <li><strong>Don't press clear on the calculator.</strong> That erases everything on it.</li>
        <li>${pickedOS ? 'Click Send OS 5.4.0.' : 'Choose the <code>.8eu</code> file again, then click Send OS 5.4.0.'}</li>
      </ol>
    </div>
    ${pick({ status: true, input: !pickedOS })}
    ${ui.pickerHint()}
    ${tiConnect()}
  `, 1, 'os540_waiting');
    wire({ connect: true });
  }

  // Connect found a calculator waiting for its OS. After a send from this
  // page that is the screen to send again; any other time this page does not
  // know which OS it had, so it only says what the calculator needs.
  function found() {
    ui.trackStep('os540_waiting_found');
    if (pending()) return waiting({ lead: 'The calculator waits for its OS. An update from this page stopped part way.' });
    throw refusal('WAITING_FOR_OS', 'Your calculator is waiting for its operating system. Send it the OS it had with TI Connect CE, then press Start over.');
  }

  return { box, wire, found, waiting, sent, link, wireLink, start, landed };
}
