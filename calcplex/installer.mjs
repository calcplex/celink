// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// /ti84plusce-jailbreak-installer/: the guided CE installer, one task per
// screen.
//
// The logic is NOT reimplemented here. OS routing, the strict single-variable
// parser, the hash-pinned official file registry, collision checks and the
// read-back are all core.mjs / transport.mjs, the same modules the node tests
// in test/ cover. This file is the wizard around them: which screen is
// on, what the calculator is asked to do between transfers, and the analytics.
//
// BYTES: this site serves the author's release assets itself, byte for byte,
// under /downloads/ce/artifice/ with the author's LICENSE beside them and the
// author's release page linked from every download. The wizard fetches them same-origin and checks
// each one against the SHA-256 pin in core.mjs before it reaches USB, so the
// install is one click. If a fetch or a hash check fails, the file picker and
// the author's release page take over: a failure never becomes an unchecked
// send.
import {CETransport} from './transport.mjs';
import {sendGame, pickCalculator, GameSendError} from './gamesend.mjs';
import {INEQUALZ_URL, OFFICIAL, compatibility, fetchOfficial, identifyOfficial, inequalzStatus,
        isChromeOS, isWindows, needsLegacyUpdate, openDetail, officialFiles, parseFlashApp, parseVariable, routeReason,
        startHint} from './core.mjs';

const AUTHOR = 'https://yvantt.github.io/arTIfiCE/';
const RELEASE = tag => `https://github.com/YvanTT/arTIfiCE/releases/tag/${tag}`;
// Where "Manual installation" goes. The page generator writes it onto
// #cec-shell (the site's written tutorial or the author's own guide); without
// it, the tutorial URL below.
const WRITTEN = (document.getElementById('cec-shell') || {dataset: {}}).dataset.writtenSteps
  || '/ti84plusce-jailbreak-tutorial/';
const writtenAttrs = () => (/^https?:/.test(WRITTEN) ? ' target="_blank" rel="noopener nofollow"' : '');
const TICONNECT = 'https://education.ti.com/en/products/computer-software/ti-connect-ce-sw';
const GAMES = '/downloads/ti84plusce/games/';
// The one game the Play screen sends itself: CalcPlex's own Snake (0BSD),
// one assembly program with no C libraries.
// It is the file the games hub serves, /downloads/ce/SnakeCE.8xg (SHA-256
// 72daeecd…405ea4); the calculator name, SNAKE, comes from inside the file,
// not from the URL.
// `id` is the button, `label` the name in sentences, `name` the calculator's.
const GAME = {id: 'cec-snake', label: 'Snake', file: '/downloads/ce/SnakeCE.8xg', name: 'SNAKE'};
const PROGRAMS = '/ti84plusce-programs-tutorial/';
const ARCHIVING = 'https://education.ti.com/en/customer-support/knowledge-base/ti-83-84-plus-family/product-usage/34936';
// A step's calculator screens, one key press at a time.
//
// Every frame is a real emulated calculator running this install;
// nothing is drawn by hand. The reader steps through it and nothing moves on
// its own, because a novice cannot keep up with an animation they do not
// control. The numbered step list IS the instruction text, above the picture,
// with the current step lit; the picture under a step is the screen that step
// happens ON (so "press 1 for All RAM" sits beside the menu whose option 1 is
// All RAM), and `done` is the final, unnumbered entry: the result, beside the
// last frame.
//
// `frames` is the list of PNG suffixes, one per entry (steps then done), in
// order; when absent it is 0..steps.length.
const WALKS = {
  'ce-jb-reset-ram': {
    alt: 'Clearing the RAM on a calculator: the MEMORY menu, the RAM tab, the confirmation, then RAM Cleared',
    steps: [
      'Press <kbd>2nd</kbd>, then <kbd>+</kbd>.',
      'Press <kbd>7</kbd> for Reset.',
      'Press <kbd>1</kbd> for All RAM.',
      'Press <kbd>2</kbd> for Reset.',
    ],
    done: 'The RAM is clear.',
  },
  'ce-jb-v3-open-inequalz': {
    alt: 'Opening Inequalz on a calculator: the APPS list, the splash screen, then the Functions (Y=) screen',
    steps: [
      'Press <kbd>apps</kbd>, then arrow down to Inequalz.',
      'Press <kbd>enter</kbd>.',
      'Press any key to clear the splash screen.',
    ],
    done: 'Stay on this Y= screen.',
  },
  'ce-jb-v3-asmhook': {
    alt: 'Launching AsmHook2 on a calculator: it is now in the APPS list, and it reports Installation successful',
    steps: [
      'Once the calculator has restarted, press <kbd>apps</kbd>, then arrow to AsmHook2.',
      'Press <kbd>enter</kbd>.',
    ],
    done: 'It reports Installation successful.',
  },
  'ce-jb-v3-game': {
    alt: 'Starting a game on a calculator: the prgm menu, the name on the home screen, then the game running',
    steps: [
      'Press <kbd>prgm</kbd>, arrow to your game, then press <kbd>enter</kbd>. On a Python edition, choose TI-Basic first.',
      'Its name is on the home screen. Press <kbd>enter</kbd> again.',
    ],
    done: 'The game starts.',
  },
  'ce-jb-native-game': {
    alt: 'Starting a game on a calculator: the prgm menu, the name on the home screen, then the game running',
    steps: [
      'Press <kbd>prgm</kbd>, arrow to your game, then press <kbd>enter</kbd>. On a Python edition, choose TI-Basic first.',
      'Its name is on the home screen. Press <kbd>enter</kbd> again.',
    ],
    done: 'The game starts.',
  },
  // OS 5.2 and earlier: an assembly program starts through Asm(. The frames
  // are from the CEmu OS 5.3.0.0037 ROM, where Asm( still exists (no 5.0-5.2
  // OS runs in CEmu: the emulated 5.3 OS refuses TI's 5.0 update). None shows
  // a version number. The keystrokes are verified on hardware on OS 5.0.
  // The home screen line is Asm(prgmSNAKE with NO closing
  // parenthesis; never write one.
  'ce-jb-native-asm': {
    alt: 'Starting Snake through Asm( on a calculator: the catalog, Asm( selected, the prgm menu, Asm(prgmSNAKE on the home screen, then the game running',
    steps: [
      'Press <kbd>2nd</kbd>, then <kbd>0</kbd> for the catalog.',
      'Arrow down to Asm( and press <kbd>enter</kbd>.',
      'Press <kbd>prgm</kbd>, arrow to SNAKE, then press <kbd>enter</kbd>. The home screen reads Asm(prgmSNAKE.',
      'Press <kbd>enter</kbd>.',
    ],
    done: 'The game starts.',
  },
  'ce-jb-v21-run': {
    alt: 'Running arTIfiCE on a calculator: the prgm menu, prgmA on the home screen, the arTIfiCE shell, then the game running',
    steps: [
      'Press <kbd>prgm</kbd>, then press <kbd>enter</kbd> on A. On a Python edition, choose TI-Basic first.',
      'prgmA is on the home screen. Press <kbd>enter</kbd> again.',
      'The arTIfiCE shell lists your games. Arrow to one and press <kbd>enter</kbd>.',
    ],
    done: 'The game starts.',
  },
};

const walkEntries = w => w.steps.concat([w.done]);
const walkFrames = w => w.frames || walkEntries(w).map((_, i) => i);
const CHEVRON_LEFT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 2 4 7l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The walk component: the numbered list on top (clicking a step shows its
// picture), the picture under it with an arrow either side, and a step
// count. Step HTML is trusted (it carries <kbd>); the alt is escaped.
const walk = name => {
  const w = WALKS[name];
  return `
  <div class="cec-walk" data-walk="${name}">
    <ol class="cec-walk-steps">${walkEntries(w).map((step, i) => `
      <li class="${i === 0 ? 'is-now' : ''}${i === w.steps.length ? ' cec-walk-done' : ''}"><button type="button" data-go="${i}"><span>${step}</span></button></li>`).join('')}
    </ol>
    <figure class="cec-walk-pic">
      <button type="button" class="cec-walk-arrow" data-step="-1" aria-label="Previous step" disabled>${CHEVRON_LEFT}</button>
      <img src="/images/evo/${name}-${walkFrames(w)[0]}.png" alt="${esc(w.alt)}" width="320" height="240" decoding="async">
      <button type="button" class="cec-walk-arrow" data-step="1" aria-label="Next step">${CHEVRON_RIGHT}</button>
    </figure>
    <p class="cec-walk-count">Step 1 of ${w.steps.length}</p>
  </div>`;
};

// Called after every paint. Frames are preloaded so stepping never flashes.
// The arrows step by one, clicking a list item jumps to its step,
// and clicking the picture advances (no wrap). `_sync` puts the arrows'
// disabled state back after work() has blanket re-enabled every button.
function mountWalks() {
  root().querySelectorAll('.cec-walk').forEach(el => {
    const name = el.dataset.walk;
    const w = WALKS[name];
    if (!w) return;
    const frames = walkFrames(w);
    const n = walkEntries(w).length;
    frames.forEach(f => { new Image().src = `/images/evo/${name}-${f}.png`; });
    const img = el.querySelector('.cec-walk-pic img');
    const items = el.querySelectorAll('.cec-walk-steps li');
    const count = el.querySelector('.cec-walk-count');
    const [back, next] = el.querySelectorAll('.cec-walk-arrow');
    let at = 0;
    const show = i => {
      at = Math.max(0, Math.min(n - 1, i));
      img.src = `/images/evo/${name}-${frames[at]}.png`;
      items.forEach((li, k) => li.classList.toggle('is-now', k === at));
      count.textContent = at < w.steps.length ? `Step ${at + 1} of ${w.steps.length}` : 'Result';
      back.disabled = at === 0;
      next.disabled = at === n - 1;
    };
    back.onclick = () => show(at - 1);
    next.onclick = () => show(at + 1);
    el.querySelectorAll('.cec-walk-steps button').forEach(b => { b.onclick = () => show(Number(b.dataset.go)); });
    img.onclick = () => { if (at < n - 1) show(at + 1); };
    el._sync = () => show(at);
  });
}

// The two closing controls every route ends on, side by side: the games hub
// filled, the send-a-program walkthrough outlined. They stack only at phone
// width.
const gamesActions = () => `
    <div class="cec-actions cec-actions-pair">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${GAMES}">Games for the TI-84 Plus CE</a></div>
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius is-secondary" href="${PROGRAMS}" target="_blank" rel="noopener">How to put a game on it</a></div>
    </div>`;

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const STEPS = ['Connect', 'Check', 'Install', 'Play'];

// --- analytics -------------------------------------------------------------
// One guarded dispatcher: THIS MODULE is the only thing that counts a CE
// transfer. A page must never fire ce_* itself or the send would be counted
// twice. Parameter names are shared with the site's other send buttons (game,
// reason, retried, evo_os, evo_hw); `route` is the only extra key, and it is
// derivable from evo_os.
// Localhost previews load the real analytics tag, so test runs there would
// be counted as real visits. Off production the event goes to the console
// instead.
const PREVIEW_HOST = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
function track(event, params) {
  try {
    if (PREVIEW_HOST) { console.info('[not sent: preview]', event, params); return; }
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') window.gtag('event', event, params);
  } catch (e) {}
}
// Fixed vocabulary: GA4 collapses a high-cardinality dimension into "(other)"
// and the split is lost.
//
// Two sources feed it. celink throws CELinkError with a stable `code`, so
// anything from the cable is matched on the code and never on wording. The
// checks core.mjs makes before the cable (the hash pin, the route, the
// container, the collision rules, the read-back) are our own sentences, and
// those are still matched on the message.
//
// The calculator's own busy answers: 0x0011 "the calculator is busy" and
// 0x0034 "go to the home screen". Both mean wait and retry, not reconnect.
const CALC_BUSY = [0x0011, 0x0034];
function failReason(err) {
  const m = String((err && err.message) || err || '');
  const code = err && err.code;
  if (code === 'NO_DEVICE_SELECTED' || (err && err.name === 'NotFoundError')) return 'no_device';
  if (code === 'NO_WEBUSB' || code === 'OTHER_MODEL') return 'unsupported';
  if (code === 'LOW_BATTERY') return 'low_battery';
  if (code === 'TIMEOUT') return 'timeout';
  // Its own reason, apart from calc_busy: on Windows it is the TI Connect CE
  // symptom (the port is held).
  if (code === 'OPEN_FAILED') return 'open_failed';
  if (code === 'CALC_ERROR' && CALC_BUSY.includes(err.calcError)) return 'calc_busy';
  if (code === 'CALC_ERROR') return 'calc_error_' + err.calcError;
  // A dropped link, anywhere the reboot was not the thing we asked for.
  if (code === 'DISCONNECTED' || code === 'LINK_CLOSED' || code === 'USB_ERROR' || code === 'PROTOCOL') return 'link_lost';
  if (code === 'UNSUPPORTED_TYPE' || code === 'BAD_FILE' || code === 'BAD_ENTRY' || code === 'BAD_NAME') return 'bad_file';
  if (/Chrome or Edge/i.test(m)) return 'unsupported';
  if (/does not match the verified|did not match the author/i.test(m)) return 'bad_hash';
  if (/could not be downloaded from this site/i.test(m)) return 'fetch_failed';
  if (/already exists/i.test(m)) return 'collision';
  if (/read-back data did not match/i.test(m)) return 'readback_mismatch';
  if (/route that file belongs to/i.test(m)) return 'wrong_route';
  if (/Choose a|Only programs|Only names|checksum/i.test(m)) return 'bad_file';
  if (/Connect a TI-84 Plus CE|unknown model/i.test(m)) return 'wrong_model';
  return 'other';
}
// The outcomes whose wording is ours rather than the library's. Everything
// else shows the error's own message, which core.mjs writes for a reader.
const OUTCOME_TEXT = {
  no_device: 'No calculator was picked. Choose one from the browser list when you are ready.',
  open_failed: 'Another program is using the calculator. Close TI Connect CE and anything else that talks to it, unplug the calculator, plug it back in, then press Connect calculator again.',
  link_lost: 'The calculator stopped answering. Unplug the USB cable, plug it back in, then choose Start over.',
  low_battery: 'Charge the calculator before installing. Sending an app needs a battery that is not low.',
};
// A refusal code celink has no sentence for. Its message ends "please report
// it", which is a dead end for a student. Error 0x0036 has been seen; a second
// try usually clears it. Why the calculator sends it is not known, so this
// says what to do and nothing about the cause.
const unknownRefusal = code =>
  `The calculator turned that down (error ${code}). This often clears on a second try, so press the same button again. If it keeps happening, unplug the cable, plug it back in and choose Start over.`;

// --- "Didn't work?" -----------------------------------------------------
// A report-a-problem control, WITHOUT a text box. People type names, emails
// and schools into boxes, analytics events must not carry personal info,
// params cap at 100 characters, and a box with no reply path promises help
// nobody gives. So: four fixed choices, each showing its fix on the spot,
// and one ce_report event per choice per page load. The failures the page can
// see are already counted (ce_connect_fail, ce_send_fail); this catches the
// ones only the student sees, like "it said done but the game won't start".
// It reuses existing parameter names: `reason` carries the choice and `game`
// the step.
const HELP_EMAIL = 'contact@calcplex.com';
const REPORT_CHOICES = [
  ['not_found', "Connect doesn't find my calculator"],
  ['froze', 'The calculator froze or reset'],
  ['wont_start', "A game won't start"],
  ['other', 'Something else'],
];
function reportFix(choice) {
  const i = state.info;
  const li = items => `<ul>${items.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul>`;
  // Manual installation goes through TI Connect CE instead of this page's USB,
  // so it is the real fallback when connecting or installing fails. Not for
  // "a game won't start": by then the jailbreak is in, and redoing it by hand
  // fixes nothing.
  const manual = lead => `${lead} <a href="${WRITTEN}"${writtenAttrs()}>manual installation</a>.`;
  // On Windows the missing driver is the likeliest cause by far (tested: no
  // TI Connect CE, empty picker), so it leads there.
  if (choice === 'not_found') return li([
    onWindows() && `On Windows, <button type="button" class="cec-inline" data-go="install">install TI Connect CE</button>, and close it before you press Connect.`,
    'Use the USB cable that came with the calculator. Some cables only charge and carry no data.',
    'Turn the calculator on, unplug the cable, then plug it back in.',
    'Use Chrome or Edge on a computer.',
    manual('Still stuck? Try the'),
  ]);
  if (choice === 'froze') return li([
    'Unplug the cable, give the calculator a few seconds, then press Start over below.',
    // The reset button is the standard escape hatch.
    'Still frozen? Press the reset button on the back of the calculator. It clears RAM: archived programs are safe, the rest are erased.',
    'With arTIfiCE v3 the calculator restarts by itself when the jailbreak installs. That part is normal.',
    manual('If it keeps happening, try the'),
  ]);
  if (choice === 'wont_start') return li([
    i ? esc(startHint(i.os, 'the game')) : 'Start games the way the Play step shows for your calculator.',
    i && i.route === 'v3' && 'After a RAM reset, launch AsmHook2 again from <kbd>apps</kbd>.',
    'If the calculator mentions LibLoad or libraries, send the game\'s whole download from our games page again. Each one carries the libraries it needs.',
  ]);
  return li([manual('Try the')]);
}
// The one place the installer shows an address: the last line of every fix,
// after the fix itself, rather than in the footer of every screen, so a
// student reads an answer before they see a way to write in (a last resort).
// Plain text only: a mailto link does nothing on a machine with no mail
// client.
const reportMail = () => `<p class="cec-report-mail">Nothing working? Email ${HELP_EMAIL}.</p>`;
function toggleReport() {
  const box = $('#cec-report'), btn = $('#cec-report-open');
  if (!box || !btn) return;
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  // Close sits on the panel itself: pressing "Didn't work?" again to shut it
  // is not something anyone would guess.
  box.innerHTML = `<div class="cec-report-head"><p class="cec-report-q">What happened?</p>
    <button type="button" class="cec-inline cec-report-close">Close</button></div>
    <div class="cec-report-choices">${REPORT_CHOICES.map(([id, label]) =>
      `<button type="button" data-choice="${id}">${label}</button>`).join('')}</div>
    <div class="cec-report-fix" id="cec-report-fix" hidden></div>`;
  box.querySelectorAll('[data-choice]').forEach(b => { b.onclick = () => report(b.dataset.choice); });
  box.querySelector('.cec-report-close').onclick = () => { toggleReport(); btn.focus(); };
}
function report(choice) {
  const box = $('#cec-report');
  box.querySelectorAll('[data-choice]').forEach(b => b.classList.toggle('is-picked', b.dataset.choice === choice));
  const fix = $('#cec-report-fix');
  // The fix, then the address line, and nothing after it.
  fix.innerHTML = reportFix(choice) + reportMail();
  fix.hidden = false;
  const go = fix.querySelector('[data-go="install"]');
  if (go) go.onclick = () => { if (!state.busy) viewInstallTIConnect(); };
  if (state.reported[choice]) return;
  state.reported[choice] = true;
  const i = state.info || {};
  track('ce_report', {reason: choice, game: 'step_' + (STEPS[state.step] || 'none').toLowerCase(),
    evo_os: i.os || 'unknown', evo_hw: i.model || 'unknown', route: i.route || 'unknown',
    last_reason: state.lastReason || 'none'});
}

// --- wizard ----------------------------------------------------------------
const transport = new CETransport();
const state = {
  step: 0,          // index into STEPS
  info: null,       // {model, os, route} read off the calculator
  picked: {},       // file spec name -> {bytes, spec}
  screenFiles: [],  // the file(s) the screen on show is about
  pickedApp: null,  // TI's .8ek, if the person picked one on the Inequalz screen
  gate: null,       // an extra condition a screen puts on its Send button
  afterWork: null,  // the screen's own enable rule, re-run after every USB call
  sent: {},         // file spec name -> true
  busy: false,
  reportedInfo: false,
  lastReason: '',   // the last failReason() shown, for the report control
  reported: {},     // report choice -> true, so one page load counts each once
};

function root() { return $('#cec'); }

function progress() {
  const native = state.info && state.info.route === 'native';
  return `<nav class="cec-progress" aria-label="Progress"><ol>${STEPS.map((label, i) => {
    let cls = i === state.step ? 'is-now' : i < state.step ? 'is-done' : '';
    if (native && i === 2) cls = 'is-skipped';
    return `<li class="${cls}"${i === state.step ? ' aria-current="step"' : ''}>${label}</li>`;
  }).join('')}</ol></nav>`;
}

// The footer on every screen: Start over (a reload) on the left, the way out
// to manual installation on the right. There is no Back: Start over is the
// one way to go backwards.
function foot(extra) {
  return `<div class="cec-report" id="cec-report" hidden></div>
  <div class="cec-foot">
    <button type="button" id="cec-restart"${state.busy ? ' disabled' : ''}>Start over</button>
    <button type="button" id="cec-report-open"${state.busy ? ' disabled' : ''} aria-expanded="false" aria-controls="cec-report">Didn't work?</button>
    ${extra || ''}
    <a class="cec-manual" href="${WRITTEN}"${writtenAttrs()}>Manual installation</a>
  </div>`;
}

function paint(view, body, step) {
  state.gate = null;
  state.afterWork = null;
  if (typeof step === 'number') state.step = step;
  root().innerHTML = `${progress()}<section class="cec-card">${body}
    <p class="cec-status" role="status" aria-live="polite" id="cec-status"></p>
    <div class="cec-error" role="alert" id="cec-error" hidden></div>
    ${foot()}</section>`;
  // The status and error bands belong under the button they report on, so
  // they are moved (not re-rendered: say() and fail() find them by id) to just
  // after the card's last row of actions. A card with no actions keeps them
  // where they were written, just above the footer.
  const card = root().querySelector('.cec-card');
  // A row marked data-status (the Play screen's Snake button) claims them
  // even when other rows come after it.
  const rows = card.querySelectorAll('.cec-actions');
  if (rows.length) {
    const status = $('#cec-status');
    (card.querySelector('.cec-actions[data-status]') || rows[rows.length - 1]).insertAdjacentElement('afterend', status);
    status.insertAdjacentElement('afterend', $('#cec-error'));
  }
  $('#cec-restart').onclick = () => { if (!state.busy) location.reload(); };
  $('#cec-report-open').onclick = toggleReport;
  mountWalks();
  const heading = root().querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
}

// The two Windows failures a student meets before anything else, both about
// TI Connect CE. On Windows without TI Connect CE installed, Chrome's picker
// lists NOTHING, so the student cancels an empty
// list and lands on no_device. A running TI Connect CE holds the port, which
// shows as open_failed. Fixed strings only: innerHTML here never carries
// anything from the cable.
const WINDOWS_OUTCOME_HTML = {
  no_device: `<p><strong>Calculator not in the list?</strong> On Windows it only shows up once
    TI Connect CE is installed. If it is installed, check that the calculator is on and
    plugged in, then press Connect calculator again.</p>
    <p><button type="button" class="cec-inline" data-go="install">Install TI Connect CE</button></p>`,
  open_failed: `<p><strong>TI Connect CE is probably still open.</strong> Windows lets only one
    program use the calculator at a time. Close TI Connect CE, unplug the calculator, plug it
    back in, then press Connect calculator again.</p>`,
};
// Chrome OS has no TI Connect CE to close. Fixed strings only, as above.
const CHROMEOS_OUTCOME_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then press Connect calculator again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};
function say(text) { const el = $('#cec-status'); if (el) el.textContent = text || ''; }
function fail(err) {
  const el = $('#cec-error');
  if (!el) return;
  const reason = failReason(err);
  state.lastReason = reason;
  if (onWindows() && WINDOWS_OUTCOME_HTML[reason]) {
    el.innerHTML = WINDOWS_OUTCOME_HTML[reason];
    const go = el.querySelector('[data-go="install"]');
    if (go) go.onclick = () => { if (!state.busy) viewInstallTIConnect(); };
  } else {
    const unknown = err && err.code === 'CALC_ERROR' && /does not know/.test(err.message || '');
    el.textContent = (onChromeOS() && CHROMEOS_OUTCOME_TEXT[reason]) || OUTCOME_TEXT[reason] || (unknown ? unknownRefusal(err.calcError) : null)
      || (err && err.message) || String(err);
  }
  el.hidden = false;
  say('');
}

// Every USB touch runs through here: one at a time, buttons locked, errors
// shown in words rather than thrown into the console.
async function work(fn) {
  if (state.busy) return;
  state.busy = true;
  const el = $('#cec-error'); if (el) el.hidden = true;
  root().querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    // Blanket re-enable, then let the screen put its own locks back. This
    // `finally` is exactly why a gated Send button needs afterWork: without
    // it, any failed call would hand the person a button meant to stay off.
    root().querySelectorAll('button, input').forEach(b => { b.disabled = false; });
    // The same goes for a walk's arrows: a dead arrow must not come back lit.
    root().querySelectorAll('.cec-walk').forEach(w => { if (w._sync) w._sync(); });
    if (state.afterWork) { try { state.afterWork(); } catch (e) {} }
  }
}

// `reason` is off wherever a sub-heading above already says it: the merged
// no-jailbreak screen, and the two routes that have one. It stays on for
// unsupported and unrecognised versions, where there is no sub and the reason
// is the entire answer.
function factsBlock({reason = true} = {}) {
  const i = state.info;
  return `<div class="cec-facts"><dl>
    <dt>Calculator</dt><dd>${esc(i.model || 'TI-84 Plus CE')}</dd>
    <dt>Software version</dt><dd>${esc(i.os)}</dd>
    <dt>What it needs</dt><dd>${esc(routeLabel(i.route))}</dd>
  </dl>${reason ? `<p class="cec-why">${esc(routeReason(i.os))}</p>` : ''}</div>`;
}
function shortOs(os) {
  const parts = String(os).split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : String(os);
}
function routeLabel(route) {
  return route === 'native' ? 'No jailbreak needed'
    : route === 'v21' ? 'arTIfiCE v2.1'
    : route === 'v3' ? 'arTIfiCE v3'
    : route === 'unsupported' ? 'No jailbreak yet'
    : 'Version not recognised';
}

// --- step 1: connect -------------------------------------------------------
// Windows is the one platform with something to install first: WebUSB reaches
// the calculator through the WinUSB driver, and TI Connect CE 6.1 and later is
// what puts that driver on the machine. Without it Chrome's picker is EMPTY
// (observed on Windows), and a running TI Connect CE holds the port. So
// Windows gets a question first ("is it installed?") that has to be read to be
// answered, and the failure bands name TI Connect CE too. TI Connect CE does
// NOT open itself when its installer finishes (observed on Windows), so the
// install screen only warns against opening it.
// macOS and ChromeOS need no driver; a ChromeOS connection has not been
// confirmed yet. The detection helper lives in core.mjs and
// is tested there.
// Set only by the localhost preview driver, so the Windows screens can be
// looked at from a Mac. Never set anywhere else.
let forceWindows = false, forceChromeOS = false;
function onWindows() {
  return forceWindows || (typeof navigator !== 'undefined' && isWindows(navigator));
}
function onChromeOS() {
  return forceChromeOS || (typeof navigator !== 'undefined' && isChromeOS(navigator));
}
function viewWindowsCheck() {
  paint(viewWindowsCheck, `
    <div class="cec-hero"><img src="/ti84plusce-jailbreak-installer/connection.svg" alt="" width="280" height="112"></div>
    <h2>Is TI Connect CE installed on this computer?</h2>
    <p class="cec-sub">On Windows, this page can only find your calculator once TI Connect CE, TI's own software, is installed.</p>
    <div class="cec-actions cec-actions-pair">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-have">Yes, it's installed</button></div>
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius is-secondary" id="cec-need">No, or I'm not sure</button></div>
    </div>
  `, 0);
  $('#cec-have').onclick = viewConnect;
  $('#cec-need').onclick = viewInstallTIConnect;
}
function viewInstallTIConnect() {
  paint(viewInstallTIConnect, `
    <h2>Install TI Connect CE first</h2>
    <p class="cec-sub">Without it, your calculator won't show up when you press Connect.</p>
    <div class="cec-do">
      <ol>
        <li><a href="${TICONNECT}" target="_blank" rel="noopener nofollow">Download TI Connect CE from TI</a> and run the installer.</li>
        <li>If you open TI Connect CE, <strong>close it</strong> before you carry on. This page can't reach the calculator while it's open.</li>
        <li>Come back to this tab.</li>
      </ol>
    </div>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-installed">It's installed</button></div>
    </div>
  `, 0);
  $('#cec-installed').onclick = viewConnect;
}
function viewConnect() {
  const usb = typeof navigator !== 'undefined' && navigator.usb;
  const win = onWindows();
  paint(viewConnect, `
    <div class="cec-hero"><img src="/ti84plusce-jailbreak-installer/connection.svg" alt="" width="280" height="112"></div>
    <h2>Connect your calculator</h2>
    <div class="cec-do">
      <ol>
        <li>Plug the CE into this computer with its charging cable and turn it on.</li>
        ${win
          ? `<li><strong>Close TI Connect CE.</strong> This page can't reach the calculator while it's open.</li>`
          : onChromeOS() ? '' : `<li>Quit TI Connect CE if it is open.</li>`}
      </ol>
    </div>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-go"${usb ? '' : ' disabled'}>Connect calculator</button></div>
    </div>
    <p class="cec-why">Different calculator versions need different jailbreaks. This page reads the version over the cable and picks the right one.</p>
    ${usb ? '' : '<p class="cec-why">Direct USB needs Chrome or Edge on a computer. Manual installation works in any browser.</p>'}
  `, 0);
  if (!usb) return;
  $('#cec-go').onclick = () => work(async () => {
    say('Pick your calculator in the browser window that opens.');
    try {
      state.info = transport.info && !transport.poisoned ? transport.info : await transport.connect();
    } catch (err) {
      // A failed connect is counted as well as a successful one, so a failure
      // before any send (the whole Windows problem) is visible. The success
      // count is ce_calc_info; the analytics tool's own operating system
      // field gives the Windows split.
      const detail = openDetail(err);
      track('ce_connect_fail', detail ? {reason: failReason(err), open_detail: detail} : {reason: failReason(err)});
      throw err;
    }
    if (!state.reportedInfo) {
      state.reportedInfo = true;
      track('ce_calc_info', {evo_os: state.info.os, evo_hw: state.info.model, route: state.info.route});
    }
    say('');
    // The no-jailbreak route has nothing to choose, so its answer and its
    // instructions are one screen rather than a click apart.
    if (state.info.route === 'native') viewNative(); else viewRoute();
  });
}

// --- step 2: what this calculator needs ------------------------------------
function viewRoute() {
  const route = state.info.route;
  const next = {
    v21: ['Install arTIfiCE v2.1', viewFilesV21],
    // v3 reads the app list first: without TI's Inequalz there is no route,
    // and finding that out after a RAM reset would erase programs for nothing.
    v3: ['Install arTIfiCE v3', checkInequalz],
  }[route];
  paint(viewRoute, `
    <h2>${({v21: 'This calculator needs arTIfiCE v2.1', v3: 'This calculator needs arTIfiCE v3', unsupported: 'arTIfiCE does not cover this version yet', unknown: 'The version could not be read'})[route] || 'What this calculator needs'}</h2>
    ${factsBlock({reason: !next})}
    ${next ? '' : `<p>Nothing will be sent. ${route === 'unknown'
      ? 'Check the About screen on the calculator and connect again.'
      : `<a href="${AUTHOR}" target="_blank" rel="noopener nofollow">The author's page</a> lists every version arTIfiCE covers.`}</p>`}
    ${next ? `<div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">${next[0]}</button></div></div>` : ''}
  `, 1);
  if (next) $('#cec-next').onclick = next[1];
}

// --- 5.4 or earlier: nothing to install ------------------------------------
// The takeaway is the heading, because that is the whole answer for this
// route. On OS 5.3 and 5.4 an assembly program starts straight from the prgm
// menu, verified on the CEmu 5.3.0.0037 ROM by running an assembly program
// that way. On 5.2 and earlier it starts through Asm(: the same Send Snake
// button, then the Asm( walk (its pictures shot on 5.3; see WALKS).
function viewNative() {
  const early = needsLegacyUpdate(state.info.os);
  paint(viewNative, `
    <h2>No jailbreak needed</h2>
    <p class="cec-sub">Games already run on OS ${esc(state.info.os)}.</p>
    ${sendActions()}
    ${walk(early ? 'ce-jb-native-asm' : 'ce-jb-native-game')}
    ${gamesActions()}
  `, 1);
  wireSends();
}

// --- arTIfiCE v3, gate 1: is TI's Inequalz app even on this calculator? ----
// arTIfiCE v3 installs THROUGH Inequalz. Without it the route cannot finish, so
// the app list is read before the RAM reset rather than after it: nobody
// should erase their programs and only then find out they are stuck.
//
// TI'S APP IS NOT HOSTED HERE. It is TI's file, the student downloads it
// from TI, and the only thing this page does with it is pass it to the
// calculator.
function checkInequalz() {
  work(async () => {
    say('Checking the calculator.');
    const status = inequalzStatus(await transport.listing());
    say('');
    if (status === 'present') return viewV3Reset();
    if (status === 'missing') return viewNoInequalz();
    viewInequalzUnsure();
  });
}

function viewNoInequalz() {
  paint(viewNoInequalz, `
    <h2>First, install Inequality Graphing on your calculator</h2>
    <div class="cec-do">
      <ol>
        <li><strong>Download the app from TI</strong> with the button below. The file ends in <code>.8ek</code>.</li>
        <li><strong>Click Choose File</strong>, pick the file you downloaded, then click Send the app.</li>
      </ol>
    </div>
    <div class="cec-actions" style="margin-bottom:18px">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${INEQUALZ_URL}" target="_blank" rel="noopener nofollow">Get Inequality Graphing from TI</a></div>
    </div>
    <label class="cec-file-input">Choose the .8ek file you downloaded
      <input type="file" id="cec-app" accept=".8ek"></label>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-send-app" disabled>Send the app</button></div>
    </div>
    <p class="cec-why">arTIfiCE v3 installs through TI's Inequality Graphing app, Inequalz. Your calculator doesn't have it installed. If you would rather send it with TI Connect CE, do that, then press Start over.</p>
  `, 2);
  state.pickedApp = null;
  // work()'s finally re-enables every button, so the send lock is re-applied
  // through afterWork rather than once at paint time.
  state.afterWork = () => {
    const b = $('#cec-send-app');
    if (b) b.disabled = !state.pickedApp;
  };
  state.afterWork();
  $('#cec-app').onchange = e => work(async () => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Refuses an OS outright, here, before the file is even held on to. See
    // parseFlashApp in core.mjs: celink will not send an operating system
    // either, but the refusal a person reads should be ours and should come
    // the moment they pick the wrong file.
    const app = parseFlashApp(bytes);
    state.pickedApp = bytes;
    say(`${app.name || file.name} is ready to send.`);
  });
  $('#cec-send-app').onclick = () => work(async () => {
    const picked = state.pickedApp;
    if (!picked) throw Error('Choose the .8ek file first.');
    // The one transfer big enough to need a readout: TI's app is about a
    // megabyte and takes tens of seconds, where the variables take one or two.
    // It reuses the status band and the sentence already on screen, with the
    // percentage on the end, rather than introducing a second kind of UI.
    //
    // The figure stops at 99%. The library counts bytes ONTO THE WIRE, and the
    // last of them is on it well before the calculator has erased and written a
    // megabyte of Flash and acknowledged it (tens of seconds on hardware), all
    // of them spent reading "100%". Capping it keeps the number
    // honest, and the percentage comes off entirely once the send is confirmed.
    const sending = 'Sending the app. Leave the cable alone until it finishes.';
    say(sending);
    try {
      await transport.sendApp(picked, {
        onProgress: (done, total) => say(total ? `${sending} ${Math.min(99, Math.round((done / total) * 100))}%` : sending),
      });
      say(sending);
      track('ce_send_success', {game: 'TI_INEQUALZ', retried: 0});
    } catch (err) {
      track('ce_send_fail', {game: 'TI_INEQUALZ', reason: failReason(err)});
      throw err;
    }
    await confirmInequalz('The app was sent but the calculator still does not list it. Check the apps menu yourself, then press Start over.');
  });
}

// Re-read the app list and move on only if the calculator itself now lists it.
async function confirmInequalz(stillMissing) {
  say('Checking the calculator.');
  const status = inequalzStatus(await transport.listing());
  say('');
  if (status === 'present') return viewV3Reset();
  if (status === 'unknown') return viewInequalzUnsure();
  throw Error(stillMissing);
}

function viewInequalzUnsure() {
  paint(viewInequalzUnsure, `
    <h2>Check for Inequalz on the calculator</h2>
    <p class="cec-sub">The app list came back empty, so check by hand.</p>
    <div class="cec-do">
      <ol>
        <li><strong>Press <kbd>apps</kbd>.</strong> Look for Inequalz in the list.</li>
        <li><strong>If it is not there, <a href="${INEQUALZ_URL}" target="_blank" rel="noopener nofollow">get it from TI</a>
          and send it with TI Connect CE before you carry on.</strong></li>
      </ol>
    </div>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Inequalz is on the calculator</button></div>
      <button type="button" id="cec-recheck" class="cec-plain">Check again</button>
    </div>
  `, 2);
  $('#cec-next').onclick = viewV3Reset;
  $('#cec-recheck').onclick = () => work(() => confirmInequalz('The calculator still did not list its apps. Carry on from the apps menu if you can see Inequalz there.'));
}

// --- arTIfiCE v3, gate 2: the RAM reset ------------------------------------
function viewV3Reset() {
  paint(viewV3Reset, `
    <h2>Clear the calculator's RAM</h2>
    <div class="warn"><p>This erases every program and variable that is not archived.
      <a href="${ARCHIVING}" target="_blank" rel="noopener nofollow">Archive</a> or back up anything
      you want to keep first.</p></div>
    ${walk('ce-jb-reset-ram')}
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">The RAM is cleared</button></div></div>
    <p class="cec-why">arTIfiCE v3 needs a clear RAM to install.</p>
  `, 2);
  $('#cec-next').onclick = viewV3Installer;
}

// --- the file screens ------------------------------------------------------
// ONE FILE PER SCREEN on the v3 route. The two v3 files are sent at different
// moments and the second only works with an app open, so showing both under a
// single Send button would invite the misread "send both now". Each
// screen fetches, checks and sends the one file it is about, and the other
// file is not on it at all.
//
// The happy path shows NO file list and no hash chatter: the file arrives from
// this site, gets checked, and the button turns on. The row list, the status
// text, the author's release page and the picker all live inside the fallback
// block, which stays hidden unless a fetch or a hash check fails. Credits are
// in the footer under the card, not on every screen.
function filesScreen(view, {files, heading, lead = '', action, tag, step, onSend, before = '', after = '', gate = null}) {
  paint(view, `
    <h2>${heading}</h2>
    ${typeof lead === 'string' && lead ? `<p class="cec-sub">${lead}</p>` : ''}
    ${before}
    <div id="cec-fallback" hidden>
      <p>This file did not load from this site. Download it from the author's release page and
        pick it here.</p>
      <ul class="cec-files" id="cec-filelist">${files.map(f => `
        <li data-file="${esc(f.file)}"><span class="cec-name">${esc(f.file)}</span><span class="cec-state"></span></li>`).join('')}</ul>
      <div class="cec-actions" style="margin-bottom:18px;margin-top:0">
        <div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${RELEASE(tag)}" target="_blank" rel="noopener nofollow">Open the ${esc(tag)} release page</a></div>
      </div>
      <label class="cec-file-input">Choose the file you downloaded
        <input type="file" id="cec-pick" accept=".8xp,.8xv"></label>
    </div>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next" disabled>${action}</button></div>
    </div>
    ${after}
  `, step);
  state.screenFiles = files;
  state.gate = gate;
  state.afterWork = renderPicked;
  $('#cec-pick').onchange = e => work(async () => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parseVariable(bytes);
    const spec = await identifyOfficial(state.info.route, bytes);
    // Right release AND the file this particular step is about. Picking the
    // trigger on the installer screen is a mistake worth naming, not a send.
    if (!spec || !files.some(f => f.file === spec.file))
      throw Error(`${file.name} is not the file this step needs. Download it again from the author's release page.`);
    state.picked[spec.file] = {bytes, spec};
    say('');
  }).then(renderPicked);
  $('#cec-next').onclick = onSend;
  renderPicked();
  fetchHosted(files);
}

// Pull every file this screen needs off our own server. A file already in hand
// (picked by the person after an earlier failure) is left alone.
function fetchHosted(files) {
  const pending = files.filter(f => !state.picked[f.file]);
  if (!pending.length) { renderPicked(); return; }
  Promise.all(pending.map(async f => {
    try {
      state.picked[f.file] = {bytes: await fetchOfficial(f), spec: f};
    } catch (err) {
      const li = document.querySelector(`#cec-filelist li[data-file="${f.file}"]`);
      if (li) li.querySelector('.cec-state').textContent = 'pick it below';
      track('ce_send_fail', {game: 'ARTIFICE_FETCH', reason: failReason(err)});
      const fallback = $('#cec-fallback');
      if (fallback) fallback.hidden = false;
    }
  })).then(renderPicked);
}

function renderPicked() {
  const files = state.screenFiles || [];
  files.forEach(f => {
    const li = document.querySelector(`#cec-filelist li[data-file="${f.file}"]`);
    if (!li) return;
    const ready = !!state.picked[f.file];
    li.classList.toggle('is-ready', ready);
    if (ready) li.querySelector('.cec-state').textContent = 'ready';
  });
  const next = $('#cec-next');
  if (next) next.disabled = !(files.length && files.every(f => state.picked[f.file])
    && (state.gate ? state.gate() : true));
}

// --- arTIfiCE v2.1: one file, becomes program A ----------------------------
function viewFilesV21() {
  filesScreen(viewFilesV21, {
    files: OFFICIAL.v21.files,
    tag: OFFICIAL.v21.tag,
    step: 2,
    heading: 'Send arTIfiCE v2.1',
    action: 'Send arTIfiCE v2.1',
    after: '<p class="cec-why">One program, named A. That is the whole install for this version.</p>',
    onSend: sendV21,
  });
}

function sendV21() {
  work(async () => {
    const {bytes, spec} = state.picked[OFFICIAL.v21.files[0].file];
    say('Sending.');
    try {
      await transport.sendVerified(bytes, {official: spec});
      track('ce_send_success', {game: 'ARTIFICE_V21', retried: 0});
      say('');
    } catch (err) {
      track('ce_send_fail', {game: 'ARTIFICE_V21', reason: failReason(err)});
      throw err;
    }
    viewV21Run();
  });
}

function viewV21Run() {
  paint(viewV21Run, `
    <h2>Run arTIfiCE</h2>
    <p class="cec-sub">arTIfiCE is on the calculator as program A.</p>
    ${walk('ce-jb-v21-run')}
    <p>Whenever you want to play: <kbd>prgm</kbd>, run A, pick the game. <kbd>mode</kbd> leaves the shell.</p>
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Done</button></div></div>
  `, 2);
  $('#cec-next').onclick = viewPlay;
}

// --- arTIfiCE v3, file 1 of 2: the installer program -----------------------
function viewV3Installer() {
  filesScreen(viewV3Installer, {
    files: [OFFICIAL.v3.files[0]],
    tag: OFFICIAL.v3.tag,
    step: 2,
    heading: 'Send the installer program',
    action: 'Send arTIfiCE.8xp',
    after: '<p class="cec-why">File 1 of 2. The trigger comes next, once Inequalz is open.</p>',
    onSend: sendV3Installer,
  });
}

function sendV3Installer() {
  work(async () => {
    const installer = state.picked[OFFICIAL.v3.files[0].file];
    // BOTH names are checked NOW, while the calculator is still on the home
    // screen. The trigger AppVar goes out later with an app in front, and a
    // directory listing in that state is untested, so the whole route is refused up front rather than half installed.
    say('Checking the calculator.');
    await transport.precheck(OFFICIAL.v3.files);
    say('Sending the installer program.');
    try {
      await transport.sendVerified(installer.bytes, {official: installer.spec});
      track('ce_send_success', {game: 'ARTIFICE_V3_PPPP', retried: 0});
    } catch (err) {
      track('ce_send_fail', {game: 'ARTIFICE_V3_PPPP', reason: failReason(err)});
      throw err;
    }
    state.sent[installer.spec.file] = true;
    say('');
    viewV3Inequalz();
  });
}

// --- arTIfiCE v3, file 2 of 2: the trigger, sent INTO an open app ----------
// This screen is the only place INEQUVAR.8xv appears. Its send button stays
// off until the student ticks that Inequalz is open on Y=, because sending it
// at any other moment does nothing useful.
function viewV3Inequalz() {
  const trigger = OFFICIAL.v3.files[1];
  filesScreen(viewV3Inequalz, {
    files: [trigger],
    tag: OFFICIAL.v3.tag,
    step: 2,
    heading: 'Open Inequalz, then send the trigger',
    lead: 'The installer program is on the calculator.',
    action: 'Send the trigger',
    onSend: sendV3Trigger,
    before: `
      ${walk('ce-jb-v3-open-inequalz')}
      <div class="warn"><p>Send the trigger only while Inequalz is open on its Y= screen, the last picture above.</p></div>
      <label class="cec-confirm"><input type="checkbox" id="cec-open"> Inequalz is open on its Y= screen</label>`,
    after: '<p class="cec-why">The calculator restarts on its own when the trigger lands. That is the install finishing.</p>',
    gate: () => {
      const box = document.getElementById('cec-open');
      return !!(box && box.checked);
    },
  });
  $('#cec-open').onchange = renderPicked;
}

function sendV3Trigger() {
  work(async () => {
    const trigger = state.picked[OFFICIAL.v3.files[1].file];
    say('Sending the trigger. The calculator restarts as it lands.');
    try {
      // No directory listing (an app is in front) and no read-back (the link
      // drops when the calculator reboots). precheck already cleared the name.
      await transport.sendVerified(trigger.bytes, {official: trigger.spec, skipDirectory: true});
      track('ce_send_success', {game: 'ARTIFICE_V3_INEQUVAR', retried: 0});
    } catch (err) {
      // Diagnostic: the exact library code and message, so a misreported
      // reboot can be told apart from a real link loss.
      console.warn('trigger send failed', err && err.code, err && err.message, err);
      track('ce_send_fail', {game: 'ARTIFICE_V3_INEQUVAR', reason: failReason(err)});
      throw err;
    }
    say('');
    viewV3Finish();
  });
}

// No "games start from prgm" line here: the jailbreak is not finished until
// AsmHook2 has run. The Play screen, reached by Done, says it.
function viewV3Finish() {
  paint(viewV3Finish, `
    <h2>Launch AsmHook2</h2>
    <p class="cec-sub">The calculator installs AsmHook2 and restarts on its own.</p>
    ${walk('ce-jb-v3-asmhook')}
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Done</button></div></div>
    <p class="cec-why"><strong>Good to know.</strong> You only need to launch AsmHook2 once; it stays through restarts. After a RAM reset, launch it again. If Inequalz later reports CONFLICTING APPS, choose option 2, then launch AsmHook2 again after leaving it.</p>
  `, 2);
  $('#cec-next').onclick = viewPlay;
}

// --- step 4: play ----------------------------------------------------------
// One button that puts Snake on the calculator, so the student sees a game
// run the moment the jailbreak is done, and the hub for everything else.
//
// This is one known file rather than a general send box, which would
// duplicate the hub, and on the v3 route the cable is gone by this point. The
// cable question is answered in gameLink(): the installer's own
// link if it is still alive (5.3 and v2.1), otherwise the calculator is picked
// again, inside the same click, after the v3 restart. What goes over the cable
// is gamesend.mjs, node-tested against the simulated calculator with this
// exact file.
let playLink = null;
async function gameLink() {
  if (transport.link && !transport.poisoned) return transport.link;
  if (!playLink) {
    const link = await pickCalculator();
    await link.open();
    playLink = link;
  }
  return playLink;
}
// A variable with the same name on the calculator is replaced without
// asking, whatever its type.
function sendGameButton(game) {
  work(async () => {
    let link = null;
    try {
      link = await gameLink();
      say(`Getting ${game.label}.`);
      const response = await fetch(game.file);
      if (!response.ok) throw new GameSendError('FETCH', `${game.label} could not be downloaded from this site. Try again in a moment.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      say(`Sending ${game.label}. Leave the cable alone until it finishes.`);
      const r = await sendGame(link, bytes, {
        onProgress: (done, total) => { if (total) say(`Sending ${game.label}. Leave the cable alone until it finishes. ${Math.min(99, Math.round(done / total * 100))}%`); },
      });
      const outcome = r.replaced.length ? 'replaced' : 'sent';
      track('ce_send_success', {game: game.name, outcome, route: r.route, page: 'installer'});
      const how = startHint(String(state.info && state.info.os || r.os), game.name);
      say(`${game.label} is on the calculator. ${how}`);
    } catch (err) {
      // A dropped link is dropped for good: the next click picks again.
      if (err && ['TIMEOUT', 'USB_ERROR', 'DISCONNECTED', 'PROTOCOL', 'LINK_CLOSED'].includes(err.code)) {
        if (link === transport.link) transport.poisoned = true;
        playLink = null;
      }
      track('ce_send_fail', {game: game.name, reason: failReason(err)});
      throw err;
    }
  });
}
const sendActions = () => {
  return `
    <div class="cec-actions" data-status><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="${GAME.id}">Send ${GAME.label}</button></div></div>`;
};
function wireSends() {
  const b = $(`#${GAME.id}`);
  if (b) b.onclick = () => sendGameButton(GAME);
}

function viewPlay() {
  paint(viewPlay, `
    <h2>Put a game on it</h2>
    <p class="cec-sub">Send Snake to see it work. ${state.info && state.info.route === 'v21' ? 'Games start from the arTIfiCE shell: <kbd>prgm</kbd>, run A, pick the game.' : 'Games start from the <kbd>prgm</kbd> menu.'}</p>
    ${sendActions()}
    ${state.info && state.info.route === 'v21' ? '' : walk('ce-jb-v3-game')}
    ${gamesActions()}
  `, 3);
  wireSends();
  // After the v3 restart the browser has forgotten the calculator: the CE has
  // no USB serial number, so Chrome cannot match the restarted device to the
  // one it was allowed (observed on a 5.8.5 calculator). Say so before the
  // picker surprises anyone.
  if (transport.poisoned && !playLink) say('The calculator restarted, so your browser will ask you to pick it again when you press Send.');
}

// --- boot ------------------------------------------------------------------
function unavailable(message) {
  root().innerHTML = `<section class="cec-card"><h2>This page needs Chrome or Edge</h2>
    <p>${esc(message)}</p>
    <div class="cec-actions"><div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${WRITTEN}"${writtenAttrs()}>Manual installation</a></div></div></section>`;
}

// --- preview-only screen driver --------------------------------------------
// Checking the page needs a picture of every screen, and most screens only
// exist after a calculator has answered. This paints any one of them from a
// made-up OS version so they can be shot without hardware.
//
// It is installed ONLY on localhost, so it cannot be reached on the live site.
// It also cannot send anything wherever it runs: every transfer goes through
// transport.sendVerified, which throws before it touches USB unless connect()
// has really run. Nothing here fakes a success.
const PREVIEW_SCREENS = {
  connect: ['5.8.5', viewConnect],
  'win-check': ['5.8.5', viewWindowsCheck],
  'win-install': ['5.8.5', viewInstallTIConnect],
  'route-v21': ['5.8.4.0058', viewRoute],
  'route-v3': ['5.8.5', viewRoute],
  'route-unsupported': ['5.9.0.0000', viewRoute],
  'route-unknown': ['nonsense', viewRoute],
  native: ['5.3.0.0037', viewNative],
  'native-50': ['5.0.0.0089', viewNative],
  'files-v21': ['5.8.4.0058', viewFilesV21],
  'v21-run': ['5.8.4.0058', viewV21Run],
  'no-inequalz': ['5.8.5', viewNoInequalz],
  'inequalz-unsure': ['5.8.5', viewInequalzUnsure],
  'v3-reset': ['5.8.5', viewV3Reset],
  'v3-installer': ['5.8.5', viewV3Installer],
  'v3-inequalz': ['5.8.5', viewV3Inequalz],
  'v3-finish': ['5.8.5', viewV3Finish],
  play: ['5.8.4.0058', viewPlay],
  'play-v3': ['5.8.5', viewPlay],
};
function installPreview() {
  const host = location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;
  window.__cecPreview = name => {
    const screen = PREVIEW_SCREENS[name];
    if (!screen) return Object.keys(PREVIEW_SCREENS);
    const [os, view] = screen;
    state.info = {model: 'TI-84 Plus CE', os, route: compatibility(os)};
    state.picked = {};
    transport.info = state.info;
    transport.poisoned = false;
    view();
    return name;
  };
  window.__cecPreviewPicked = () => {
    // every file THIS screen is about, so the Send button is enabled in the shot
    (state.screenFiles.length ? state.screenFiles : officialFiles(state.info.route))
      .forEach(f => { state.picked[f.file] = {bytes: null, spec: f}; });
    renderPicked();
  };
  window.__cecPreviewError = message => { fail(Error(message)); };
  // &fail=<code> shows the band a real library error with that code gets
  // (NO_DEVICE_SELECTED, OPEN_FAILED), Windows wording included under ?win=1.
  // CALC_ERROR_<n> is a refusal celink has no sentence for, worded as celink
  // words it.
  window.__cecPreviewFail = code => {
    const n = /^CALC_ERROR_(\d+)$/.exec(code);
    const e = Error(n ? `The calculator refused the request (error 0x${Number(n[1]).toString(16).padStart(4, '0')}: an error code this library does not know; please report it).` : code);
    e.code = n ? 'CALC_ERROR' : code;
    if (n) e.calcError = Number(n[1]);
    fail(e);
  };
  // ?win=1 makes this browser count as Windows: the Connect screen's wording
  // and the Windows failure bands. The two Windows-only screens have their
  // own ?screen= names.
  window.__cecPreviewWindows = on => { forceWindows = !!on; };
  // ?screen=<name> paints one screen straight from the URL, so the
  // screenshots are a reproducible script rather than a hand-driven session.
  // ?picked=1 fills the file list, &error=<text> shows the error band.
  const q = new URLSearchParams(location.search);
  if (q.get('win')) forceWindows = true;
  if (q.get('cros')) forceChromeOS = true;
  const want = q.get('screen');
  if (want && PREVIEW_SCREENS[want]) {
    window.__cecPreview(want);
    if (q.get('picked')) window.__cecPreviewPicked();
    if (q.get('error')) window.__cecPreviewError(q.get('error'));
    if (q.get('fail')) window.__cecPreviewFail(q.get('fail'));
    return true;
  }
  return false;
}

export function boot() {
  if (!root()) return;
  // A URL-driven preview screen wins over the capability checks below: it may
  // load in a preview frame, and WebUSB is not exposed to a frame.
  if (installPreview()) return;
  if (typeof navigator === 'undefined' || !navigator.usb) {
    unavailable('Sending files straight to a calculator only works in Chrome or Edge on a computer. Manual installation works in any browser.');
    return;
  }
  // Let go of the calculator when the page goes, so the games hub, opened in
  // the same tab, can open it at once. A page that kept the link open would
  // leave the hub's Connect reporting that another program is using it.
  window.addEventListener('pagehide', () => {
    for (const l of [transport.link, playLink]) if (l) l.close().catch(() => {});
  });
  navigator.usb.addEventListener('disconnect', e => {
    if (e.device === transport.device && !transport.poisoned) {
      transport.poisoned = true;
      say('The calculator was unplugged. Plug it back in and reload this page.');
    }
  });
  if (onWindows()) viewWindowsCheck(); else viewConnect();
}

boot();
