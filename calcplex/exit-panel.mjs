// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The exit test mode panel, one for every calculator: one button. A click
// uses the calculator this site was allowed when it is plugged in, else
// opens the browser's device list, and the exit runs as soon as one is
// picked. The transport (ce-exit.mjs for the TI-84 Plus CE, the TI-84 Evo's
// over Web Serial) says how a calculator is found and exited and has the
// calculator's own lines; everything else is here: the shared words, the
// in-flight guard, the counting and the feedback box.
//
// Counting (analytics; fixed vocabularies, nothing personal). Every page that
// mounts this panel sends the same events; the page path tells them apart:
//   exit_test_mode_unsupported {reason}   this browser can't (browser | mobile | not_loaded)
//   exit_test_mode_shown                  the button is ready
//   exit_test_mode_click                  the button was clicked
//   exit_test_mode_list                   the device list opened
//   exit_test_mode_connect {reason, picker}  the list closed: ok, or why not
//   exit_test_mode_cancel {picker}        it closed with nothing picked
//   exit_test_mode_wrong                  the other calculator was picked
//   exit_test_mode_start                  the exit went to a picked calculator
//   exit_test_mode_success {picker} / exit_test_mode_fail {reason, picker}
//                                         unless the transport counts them itself
//   exit_test_mode_feedback {reason}      a report was sent (the last outcome)
//
// The feedback box is the CE download pages' (the same classes, words and
// form, through core.mjs's feedbackText and sendFeedback): "Something not
// working? Tell us" under the panel opens it, and it opens by itself under a
// failed exit. What the page knows rides in front of the student's words:
// the tool, the calculator, the last outcome, the browser and the computer
// (one coarse word each) and the page. A preview posts nothing.
import { FEEDBACK_FORM, FEEDBACK_MAX, PREVIEW_HOST, esc, feedbackText, platformName, sendFeedback, track } from './core.mjs';

// The words both calculators share; `short` is the calculator's short name.
export const WORDS = {
  checking: 'Checking your browser…',
  plug: short => `Plug your ${short} into this computer, turn it on, and click Exit test mode.`,
  ready: '<strong>Calculator connected.</strong> Click Exit test mode below.',
  picking: 'Select your calculator in the popup…',
  working: 'Taking the calculator out of test mode…',
  notLoaded: "The tool didn't load properly. <strong>Reload the page</strong> and try again. If that doesn't help, hold <strong>Shift</strong> while you click reload to fetch a fresh copy.",
  fbAsk: "What didn't work?",
  fbAskFailed: 'What happened?',
  fbSend: 'Send',
  fbDone: 'Thank you! We read every response and will do our best to improve.',
  fbErr: `That didn't send. Try again, or <a href="${FEEDBACK_FORM}/viewform" target="_blank" rel="noopener">open the form</a>.`,
};

/** The browser as one coarse word and its major version ("chrome 131"); '' when it doesn't say. */
export function browserName(nav = globalThis.navigator) {
  const brands = nav?.userAgentData?.brands;
  if (Array.isArray(brands)) {
    const pick = ['Microsoft Edge', 'Google Chrome', 'Opera', 'Chromium']
      .map(b => brands.find(x => x.brand === b)).find(Boolean);
    if (pick) return `${pick.brand.replace(/^(Microsoft|Google) /, '').toLowerCase()} ${String(pick.version).split('.')[0]}`;
  }
  const ua = String(nav?.userAgent ?? '');
  const m = /\b(Edg|Firefox|Chrome|Version)\/(\d+)/.exec(ua.replace(/Chrome\/[\d.]+ (?=.*Edg\/)/, ''));
  if (!m) return '';
  const name = { Edg: 'edge', Firefox: 'firefox', Chrome: 'chrome', Version: /Safari/.test(ua) ? 'safari' : '' }[m[1]];
  return name ? `${name} ${m[2]}` : '';
}

/**
 * Wire the panel inside `root` to `transport`. `nav` stands in for
 * navigator (the feedback tag's browser and computer). Returns the click
 * handler's promise maker, for tests.
 */
export function mount(root, transport, { nav = globalThis.navigator } = {}) {
  if (!root || !transport) return null;
  const $ = sel => root.querySelector(sel);
  const conn = $('.exit-conn');
  const btn = $('.exit-btn');
  const status = $('.exit-status');
  const fbSlot = $('.exit-fb-slot');
  const fbOpen = $('.exit-fb-open');
  const T = transport;
  const base = new Map([[conn, conn.className], [status, status.className]]);
  const say = (el, cls, html) => { el.className = base.get(el) + (cls ? ` ${cls}` : ''); el.innerHTML = html; };
  let busy = false;
  let boxes = 0;          // feedback boxes opened (their textarea ids); set before the can't-run return, which still wires the box
  let last = '';          // the last outcome, for the feedback tag and event
  let picker = '';        // this click's device list, when one was shown
  let listShown = false;  // a device list was opened on this page load
  const crossLink = () => `<a href="${esc(T.other.href)}">Use the ${esc(T.other.short)} tool</a>.`;

  const kind = T.support();
  if (kind) {
    track('exit_test_mode_unsupported', { reason: kind });
    say(conn, 'warn', `<p class="msg">${kind === 'not_loaded' ? WORDS.notLoaded : T.unsupportedHtml(kind)}</p>`);
    btn.disabled = true;
    last = `unsupported: ${kind}`;
    wireFeedback();
    return null;
  }

  async function refresh() {
    if (busy) return;
    const present = await T.present();
    if (busy) return;
    if (present) say(conn, 'ok', `<p class="msg">${WORDS.ready}</p>`);
    else say(conn, '', `<p class="msg">${WORDS.plug(T.short)}</p>${listShown ? '' : T.hintHtml()}`);
  }

  function failed(err, { box = true } = {}) {
    const reason = T.reason(err);
    last = `fail: ${reason}`;
    const html = T.failHtml(err);
    say(status, html && html.startsWith('<div class="ce-fix') ? '' : 'err', html ?? '');
    if (box) openFeedback(true);
  }

  async function run() {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    closeFeedback();
    say(status, '', '');
    picker = '';
    track('exit_test_mode_click', {});
    try {
      // 1. the calculator: the allowed one when it is plugged in, else the list
      if (!(await T.present())) {
        track('exit_test_mode_list', {});
        listShown = true;
        status.textContent = WORDS.picking;
        try {
          await T.pick();
          picker = T.pickerParams().picker || '';
          track('exit_test_mode_connect', { reason: 'ok', ...T.pickerParams() });
        } catch (err) {
          picker = T.pickerParams(err).picker || '';
          track('exit_test_mode_connect', { reason: T.reason(err), ...T.pickerParams(err) });
          if (T.isWrong(err)) {
            last = 'wrong calculator';
            track('exit_test_mode_wrong', {});
            say(status, '', `<p class="msg">That's a ${esc(T.other.name)}. ${crossLink()}</p>`);
            return;
          }
          if (T.isCancel(err)) {
            last = 'cancelled';
            track('exit_test_mode_cancel', picker ? { picker } : {});
            const help = T.failHtml(err) ?? '';
            say(status, '', T.listShowsOther ? help : `${help} Have a ${esc(T.other.name)}? ${crossLink()}`);
            return;
          }
          failed(err);
          return;
        }
      }
      // 2. the exit, at once
      track('exit_test_mode_start', {});
      say(status, '', WORDS.working);
      try {
        await T.exit();
      } catch (err) {
        if (!T.countsExit) track('exit_test_mode_fail', { reason: T.reason(err), ...(picker ? { picker } : {}) });
        failed(err);
        return;
      }
      if (!T.countsExit) track('exit_test_mode_success', picker ? { picker } : {});
      last = 'done';
      say(status, 'ok', T.doneHtml);
    } finally {
      busy = false;
      btn.disabled = false;
      refresh();
    }
  }

  btn.addEventListener('click', run);
  // A fix's own "Connect again" runs the same click.
  status.addEventListener('click', e => {
    if (e.target.closest?.('.ce-connect-again')) run();
  });

  // ---- the feedback box (the CE download pages': classes, words, form)
  function feedbackParts() {
    return ['Exit test mode', T.name, last || 'no exit yet', picker && `picker ${picker}`, browserName(nav), platformName(nav), globalThis.location?.pathname, PREVIEW_HOST ? 'PREVIEW' : ''];
  }
  function openFeedback(afterFail = false) {
    if (!fbSlot) return;
    const old = fbSlot.querySelector('.ce-fb');
    const text = old?.querySelector('textarea')?.value ?? '';
    const id = `exit-fb-${++boxes}`;
    fbSlot.innerHTML = `<div class="ce-fb"><label for="${id}">${esc(afterFail ? WORDS.fbAskFailed : WORDS.fbAsk)}</label>`
      + `<textarea id="${id}" rows="3" maxlength="${FEEDBACK_MAX}">${esc(text)}</textarea>`
      + `<p class="ce-fb-row"><button type="button" class="ce-fb-send"${text.trim() ? '' : ' disabled'}>${esc(WORDS.fbSend)}</button></p></div>`;
    if (!afterFail) fbSlot.querySelector('textarea').focus();
  }
  function closeFeedback() {
    const fb = fbSlot?.querySelector('.ce-fb');
    if (fb && !fb.querySelector('textarea')?.value.trim()) fbSlot.innerHTML = '';
  }
  function wireFeedback() {
    if (!fbSlot) return;
    fbOpen?.addEventListener('click', e => { e.preventDefault(); openFeedback(false); });
    fbSlot.addEventListener('input', e => {
      const fb = e.target.closest?.('.ce-fb');
      if (fb) fb.querySelector('.ce-fb-send').disabled = fb.hasAttribute('data-busy') || !e.target.value.trim();
    });
    fbSlot.addEventListener('click', async e => {
      const go = e.target.closest?.('.ce-fb-send');
      if (!go) return;
      const fb = go.closest('.ce-fb');
      const text = fb.querySelector('textarea').value.trim();
      if (!text || fb.hasAttribute('data-busy')) return;
      fb.setAttribute('data-busy', '1');
      go.disabled = true;
      fb.querySelector('.ce-fb-err')?.remove();
      try {
        if (PREVIEW_HOST) console.info('[not sent: preview]', 'feedback', feedbackText(text, feedbackParts()));
        else await sendFeedback(text, feedbackParts());
        fb.removeAttribute('data-busy');
        fb.innerHTML = `<p class="ce-fb-done">${esc(WORDS.fbDone)}</p>`;
        track('exit_test_mode_feedback', { reason: (last.split(': ')[1] || last || 'none').replace(/\s+/g, '_') });
      } catch {
        fb.removeAttribute('data-busy');
        go.disabled = false;
        go.closest('.ce-fb-row').insertAdjacentHTML('afterend', `<p class="ce-fb-err">${WORDS.fbErr}</p>`);
      }
    });
  }

  wireFeedback();
  T.watch(refresh);
  track('exit_test_mode_shown', {});
  refresh();
  return run;
}
