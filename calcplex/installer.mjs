// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The guided jailbreak installer at /ti84plusce-jailbreak-installer/, one
// task per screen. The checks and transfers are core.mjs and transport.mjs;
// this is the wizard around them. The arTIfiCE files come from this site and
// are checked against their pins before they reach USB; if that fails, the
// student picks the author's download instead.
import { CETransport } from './transport.mjs';
import { pickCalculator, sendGame } from './gamesend.mjs';
import {
  INEQUALZ_URL, OFFICIAL, PREVIEW_HOST, ROUTES, TICONNECT_URL, calcParams, compatibility, esc, fetchOfficial,
  identifyOfficial, inequalzStatus, installerFailReason, isChromeOS, isWindows, linkDead, needsAsm, officialFiles,
  parseFlashApp, parseVariable, refusal, refusalText, refusedAt, startHint, track, trackConnectFail, unknownRefusal,
} from './core.mjs';
import { CELinkError } from '../celink.mjs';

const AUTHOR = 'https://yvantt.github.io/arTIfiCE/';
const RELEASE = tag => `https://github.com/YvanTT/arTIfiCE/releases/tag/${tag}`;
// "Manual installation": the site's written tutorial or the author's guide,
// whichever the page generator put on #cec-shell.
const WRITTEN = document.getElementById('cec-shell')?.dataset.writtenSteps || '/ti84plusce-jailbreak-tutorial/';
const writtenAttrs = () => (/^https?:/.test(WRITTEN) ? ' target="_blank" rel="noopener nofollow"' : '');
const GAMES = '/downloads/ti84plusce/games/';
// The game the Play screen sends: one assembly program, no C libraries.
// `name` is the variable inside the file.
const GAME = { id: 'cec-snake', label: 'Snake', file: '/downloads/ce/SnakeCE.8xg', name: 'SNAKE' };
const PROGRAMS = '/ti84plusce-programs-tutorial/';
const ARCHIVING = 'https://education.ti.com/en/customer-support/knowledge-base/ti-83-84-plus-family/product-usage/34936';
// Walkthroughs: a numbered list of key presses over emulator screenshots,
// stepped by the reader (nothing animates). Frame i is the screen step i
// happens on; `done` is the result, beside the last frame. A walk's frames
// are named after its key.
const GAME_WALK = {
  alt: 'Starting a game on a calculator: the prgm menu, the name on the home screen, then the game running',
  steps: [
    'Press <kbd>prgm</kbd>, arrow to your game, then press <kbd>enter</kbd>. On a Python edition, choose TI-Basic first.',
    'Its name is on the home screen. Press <kbd>enter</kbd> again.',
  ],
  done: 'The game starts.',
};
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
  'ce-jb-v3-game': GAME_WALK,
  'ce-jb-native-game': GAME_WALK,
  // OS 5.2 and earlier. Shot on 5.3, which still has Asm( (no earlier OS runs
  // in the emulator); the keystrokes were checked on hardware on 5.0. The home
  // screen line has no closing parenthesis.
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
const frameUrl = (name, i) => `/images/evo/${name}-${i}.png`;
const CHEVRON_LEFT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 2 4 7l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Step HTML is trusted (it carries <kbd>); the alt is escaped.
const walk = name => {
  const w = WALKS[name];
  return `
  <div class="cec-walk" data-walk="${name}">
    <ol class="cec-walk-steps">${walkEntries(w).map((step, i) => `
      <li class="${i === 0 ? 'is-now' : ''}${i === w.steps.length ? ' cec-walk-done' : ''}"><button type="button" data-go="${i}"><span>${step}</span></button></li>`).join('')}
    </ol>
    <figure class="cec-walk-pic">
      <button type="button" class="cec-walk-arrow" data-step="-1" aria-label="Previous step" disabled>${CHEVRON_LEFT}</button>
      <img src="${frameUrl(name, 0)}" alt="${esc(w.alt)}" width="320" height="240" decoding="async">
      <button type="button" class="cec-walk-arrow" data-step="1" aria-label="Next step">${CHEVRON_RIGHT}</button>
    </figure>
    <p class="cec-walk-count">Step 1 of ${w.steps.length}</p>
  </div>`;
};

// Arrows step by one, a list item jumps to its step, a click on the picture
// advances. Frames are preloaded so stepping never flashes. `_sync` restores
// the arrows after work() has re-enabled every button.
function mountWalks() {
  root().querySelectorAll('.cec-walk').forEach(el => {
    const name = el.dataset.walk;
    const w = WALKS[name];
    const n = walkEntries(w).length;
    for (let i = 0; i < n; i++) new Image().src = frameUrl(name, i);
    const img = el.querySelector('.cec-walk-pic img');
    const items = el.querySelectorAll('.cec-walk-steps li');
    const count = el.querySelector('.cec-walk-count');
    const [back, next] = el.querySelectorAll('.cec-walk-arrow');
    let at = 0;
    const show = i => {
      at = Math.max(0, Math.min(n - 1, i));
      img.src = frameUrl(name, at);
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

// Every route ends on these two: the games hub and the send-a-program tutorial.
const gamesActions = () => `
    <div class="cec-actions cec-actions-pair">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${GAMES}">Games for the TI-84 Plus CE</a></div>
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius is-secondary" href="${PROGRAMS}" target="_blank" rel="noopener">How to put a game on it</a></div>
    </div>`;

const $ = s => document.querySelector(s);

const STEPS = ['Connect', 'Check', 'Install', 'Play'];

// Where the words are ours. Refusals read through refusalText; anything else
// shows the error's own message.
const OUTCOME_TEXT = {
  no_device: 'No calculator was picked. Choose one from the browser list when you are ready.',
  open_failed: 'Another program is using the calculator. Close TI Connect CE and anything else that talks to it, unplug the calculator, plug it back in, then press Connect calculator again.',
  link_lost: 'The calculator stopped answering. Unplug the USB cable, plug it back in, then choose Start over.',
  low_battery: 'Charge the calculator before installing. Sending an app needs a battery that is not low.',
};
// celink's TIMEOUT says what it was waiting for and how long.
const timeoutText = err =>
  `The calculator stopped answering${err.during ? ` (${err.during}, no reply in ${err.ms} ms)` : ''}. Check the cable, make sure the calculator is on and at the home screen, then connect again.`;
// For a refusal code with no description: a second try usually clears it.
const retryText = code =>
  `The calculator turned that down (error ${code}). This often clears on a second try, so press the same button again. If it keeps happening, unplug the cable, plug it back in and choose Start over.`;

// ce_send_success or ce_send_fail for one of the installer's own transfers.
async function tracked(game, send) {
  try {
    await send();
  } catch (err) {
    console.warn(`${game} failed:`, err?.code, err?.message);
    track('ce_send_fail', { game, reason: installerFailReason(err), ...refusedAt(err) });
    throw err;
  }
  track('ce_send_success', { game, retried: 0 });
}

// Fixed choices, never a text box (a box collects personal details that must
// not reach analytics). Each shows its fix and sends one ce_report per page
// load, with the choice as `reason` and the step as `game`.
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
  // Manual installation avoids this page's USB entirely. It fixes nothing once
  // the jailbreak is in, so "a game won't start" does not offer it.
  const manual = lead => `${lead} <a href="${WRITTEN}"${writtenAttrs()}>manual installation</a>.`;
  // On Windows the missing driver is by far the likeliest cause.
  if (choice === 'not_found') return li([
    onWindows() && `On Windows, <button type="button" class="cec-inline" data-go="install">install TI Connect CE</button>, and close it before you press Connect.`,
    'Use the USB cable that came with the calculator. Some cables only charge and carry no data.',
    'Turn the calculator on, unplug the cable, then plug it back in.',
    'Use Chrome or Edge on a computer.',
    manual('Still stuck? Try the'),
  ]);
  if (choice === 'froze') return li([
    'Unplug the cable, give the calculator a few seconds, then press Start over below.',
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
// The address comes last, after the fix, and as plain text: a mailto link
// does nothing on a machine with no mail client.
const reportMail = () => `<p class="cec-report-mail">Nothing working? Email ${HELP_EMAIL}.</p>`;
function toggleReport() {
  const box = $('#cec-report'), btn = $('#cec-report-open');
  if (!box || !btn) return;
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;
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
  fix.innerHTML = reportFix(choice) + reportMail();
  fix.hidden = false;
  const go = fix.querySelector('[data-go="install"]');
  if (go) go.onclick = () => { if (!state.busy) viewInstallTIConnect(); };
  if (state.reported[choice]) return;
  state.reported[choice] = true;
  const i = state.info || {};
  track('ce_report', {
    reason: choice, game: 'step_' + (STEPS[state.step] || 'none').toLowerCase(),
    ...calcParams({ os: i.os || 'unknown', model: i.model || 'unknown' }), route: i.route || 'unknown',
    last_reason: state.lastReason || 'none',
  });
}

const transport = new CETransport();
const state = {
  step: 0,          // index into STEPS
  info: null,       // { model, os, route } read off the calculator
  picked: {},       // file spec name -> { bytes, spec }
  screenFiles: [],  // the file(s) the screen on show is about
  pickedApp: null,  // TI's .8ek, if the person picked one on the Inequalz screen
  gate: null,       // an extra condition a screen puts on its Send button
  afterWork: null,  // the screen's own enable rule, re-run after every USB call
  busy: false,
  reportedInfo: false,
  lastReason: '',   // the last reason shown, for the report control
  reported: {},     // report choice -> true, so one page load counts each once
};

function root() { return $('#cec'); }

function progress() {
  const native = state.info?.route === 'native';
  return `<nav class="cec-progress" aria-label="Progress"><ol>${STEPS.map((label, i) => {
    let cls = i === state.step ? 'is-now' : i < state.step ? 'is-done' : '';
    if (native && i === 2) cls = 'is-skipped';
    return `<li class="${cls}"${i === state.step ? ' aria-current="step"' : ''}>${label}</li>`;
  }).join('')}</ol></nav>`;
}

// There is no Back: Start over (a reload) is the one way backwards.
function foot() {
  return `<div class="cec-report" id="cec-report" hidden></div>
  <div class="cec-foot">
    <button type="button" id="cec-restart"${state.busy ? ' disabled' : ''}>Start over</button>
    <button type="button" id="cec-report-open"${state.busy ? ' disabled' : ''} aria-expanded="false" aria-controls="cec-report">Didn't work?</button>
    <a class="cec-manual" href="${WRITTEN}"${writtenAttrs()}>Manual installation</a>
  </div>`;
}

function paint(body, step) {
  state.gate = null;
  state.afterWork = null;
  state.step = step;
  root().innerHTML = `${progress()}<section class="cec-card">${body}
    <p class="cec-status" role="status" aria-live="polite" id="cec-status"></p>
    <div class="cec-error" role="alert" id="cec-error" hidden></div>
    ${foot()}</section>`;
  // The status and error bands move under the button they report on: the
  // last row of actions, or a row marked data-status.
  const card = root().querySelector('.cec-card');
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
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

// On Windows, no_device is usually an empty picker (no TI Connect CE driver)
// and open_failed a running TI Connect CE holding the port.
const WINDOWS_OUTCOME_HTML = {
  no_device: `<p><strong>Calculator not in the list?</strong> On Windows it only shows up once
    TI Connect CE is installed. If it is installed, check that the calculator is on and
    plugged in, then press Connect calculator again.</p>
    <p><button type="button" class="cec-inline" data-go="install">Install TI Connect CE</button></p>`,
  open_failed: `<p><strong>TI Connect CE is probably still open.</strong> Windows lets only one
    program use the calculator at a time. Close TI Connect CE, unplug the calculator, plug it
    back in, then press Connect calculator again.</p>`,
};
const CHROMEOS_OUTCOME_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then press Connect calculator again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};
function say(text) { const el = $('#cec-status'); if (el) el.textContent = text || ''; }
function fail(err) {
  const el = $('#cec-error');
  if (!el) return;
  const reason = installerFailReason(err);
  state.lastReason = reason;
  if (onWindows() && WINDOWS_OUTCOME_HTML[reason]) {
    el.innerHTML = WINDOWS_OUTCOME_HTML[reason];
    const go = el.querySelector('[data-go="install"]');
    if (go) go.onclick = () => { if (!state.busy) viewInstallTIConnect(); };
  } else {
    el.textContent = (onChromeOS() && CHROMEOS_OUTCOME_TEXT[reason]) || OUTCOME_TEXT[reason]
      || (reason === 'timeout' ? timeoutText(err) : null)
      || (unknownRefusal(err) ? retryText(err.calcError) : null) || refusalText(err) || err?.message || String(err);
  }
  el.hidden = false;
  say('');
}

// Every USB touch runs through here: one at a time, buttons locked, errors shown.
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
    // Re-enable everything, then let the screen and its walks lock what should stay off.
    root().querySelectorAll('button, input').forEach(b => { b.disabled = false; });
    root().querySelectorAll('.cec-walk').forEach(w => w._sync?.());
    state.afterWork?.();
  }
}

// `reason` is left off where a heading already says it.
function factsBlock({ reason = true } = {}) {
  const i = state.info;
  return `<div class="cec-facts"><dl>
    <dt>Calculator</dt><dd>${esc(i.model)}</dd>
    <dt>Software version</dt><dd>${esc(i.os)}</dd>
    <dt>What it needs</dt><dd>${esc(ROUTES[i.route].label)}</dd>
  </dl>${reason ? `<p class="cec-why">${esc(ROUTES[i.route].reason)}</p>` : ''}</div>`;
}

// Windows reaches a CE only through the driver TI Connect CE 6.1+ installs;
// without it Chrome's picker is empty (observed on Windows). So Windows is
// asked first. The installer does not open TI Connect CE when it finishes
// (observed on Windows), so the install screen only warns against opening it.
// The localhost preview can force either platform.
let forceWindows = false, forceChromeOS = false;
const onWindows = () => forceWindows || isWindows(navigator);
const onChromeOS = () => forceChromeOS || isChromeOS(navigator);
function viewWindowsCheck() {
  paint(`
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
  paint(`
    <h2>Install TI Connect CE first</h2>
    <p class="cec-sub">Without it, your calculator won't show up when you press Connect.</p>
    <div class="cec-do">
      <ol>
        <li><a href="${TICONNECT_URL}" target="_blank" rel="noopener nofollow">Download TI Connect CE from TI</a> and run the installer.</li>
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
  const usb = !!navigator.usb;
  const win = onWindows();
  paint(`
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
      trackConnectFail(err);
      throw err;
    }
    if (!state.reportedInfo) {
      state.reportedInfo = true;
      track('ce_calc_info', { ...calcParams(state.info), route: state.info.route });
    }
    say('');
    if (state.info.route === 'native') viewNative(); else viewRoute();
  });
}

function viewRoute() {
  const route = state.info.route;
  const next = {
    v21: ['Install arTIfiCE v2.1', viewFilesV21],
    v3: ['Install arTIfiCE v3', checkInequalz],
  }[route];
  paint(`
    <h2>${ROUTES[route].heading}</h2>
    ${factsBlock({ reason: !next })}
    ${next ? '' : `<p>Nothing will be sent. ${route === 'unknown'
      ? 'Check the About screen on the calculator and connect again.'
      : `<a href="${AUTHOR}" target="_blank" rel="noopener nofollow">The author's page</a> lists every version arTIfiCE covers.`}</p>`}
    ${next ? `<div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">${next[0]}</button></div></div>` : ''}
  `, 1);
  if (next) $('#cec-next').onclick = next[1];
}

function viewNative() {
  const early = needsAsm(state.info.os);
  paint(`
    <h2>${ROUTES.native.heading}</h2>
    <p class="cec-sub">Games already run on OS ${esc(state.info.os)}.</p>
    ${sendActions()}
    ${walk(early ? 'ce-jb-native-asm' : 'ce-jb-native-game')}
    ${gamesActions()}
  `, 1);
  wireSends();
}

// v3 installs through Inequalz, so the app list is read before the RAM reset:
// nobody should erase their programs and only then find out they are stuck.
// The app is not hosted here; the student downloads it from TI.
function checkInequalz() {
  work(async () => {
    say('Checking the calculator.');
    const status = inequalzStatus(await transport.directory());
    say('');
    if (status === 'present') return viewV3Reset();
    if (status === 'missing') return viewNoInequalz();
    viewInequalzUnsure();
  });
}

function viewNoInequalz() {
  paint(`
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
  state.afterWork = () => {
    const b = $('#cec-send-app');
    if (b) b.disabled = !state.pickedApp;
  };
  state.afterWork();
  $('#cec-app').onchange = e => work(async () => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Refused the moment the wrong file is picked, before it is kept.
    const app = parseFlashApp(bytes);
    state.pickedApp = bytes;
    say(`${app.name || file.name} is ready to send.`);
  });
  $('#cec-send-app').onclick = () => work(async () => {
    const picked = state.pickedApp;
    if (!picked) throw refusal('NO_FILE', 'Choose the .8ek file first.');
    // The percentage counts bytes onto the wire, which finish long before the
    // calculator has written the Flash, so it stops at 99.
    const sending = 'Sending the app. Leave the cable alone until it finishes.';
    say(sending);
    await tracked('TI_INEQUALZ', () => transport.sendApp(picked, {
      onProgress: (done, total) => say(total ? `${sending} ${Math.min(99, Math.round((done / total) * 100))}%` : sending),
    }));
    say(sending);
    await confirmInequalz('The app was sent but the calculator still does not list it. Check the apps menu yourself, then press Start over.');
  });
}

// Re-read the app list and move on only if the calculator itself now lists it.
async function confirmInequalz(stillMissing) {
  say('Checking the calculator.');
  const status = inequalzStatus(await transport.directory());
  say('');
  if (status === 'present') return viewV3Reset();
  if (status === 'unknown') return viewInequalzUnsure();
  throw refusal('NOT_LISTED', stillMissing);
}

function viewInequalzUnsure() {
  paint(`
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

function viewV3Reset() {
  paint(`
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

// One file per screen: the two v3 files go at different moments, and showing
// both would invite "send both now". The file list, the release page and the
// picker are a fallback, shown only when this site's copy fails to load.
function filesScreen({ files, heading, lead = '', action, tag, step, onSend, before = '', after = '', gate = null }) {
  paint(`
    <h2>${heading}</h2>
    ${lead ? `<p class="cec-sub">${lead}</p>` : ''}
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
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parseVariable(bytes);
    // The right release, and the file this step is about.
    const spec = await identifyOfficial(state.info.route, bytes);
    if (!spec || !files.some(f => f.file === spec.file)) {
      throw refusal('WRONG_FILE', `${file.name} is not the file this step needs. Download it again from the author's release page.`);
    }
    state.picked[spec.file] = { bytes, spec };
    say('');
  }).then(renderPicked);
  $('#cec-next').onclick = onSend;
  renderPicked();
  fetchHosted(files);
}

// A file already picked by hand after an earlier failure is not fetched again.
function fetchHosted(files) {
  const pending = files.filter(f => !state.picked[f.file]);
  if (!pending.length) { renderPicked(); return; }
  Promise.all(pending.map(async f => {
    try {
      state.picked[f.file] = { bytes: await fetchOfficial(f), spec: f };
    } catch (err) {
      const li = document.querySelector(`#cec-filelist li[data-file="${f.file}"]`);
      if (li) li.querySelector('.cec-state').textContent = 'pick it below';
      track('ce_send_fail', { game: 'ARTIFICE_FETCH', reason: installerFailReason(err), ...refusedAt(err) });
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

function viewFilesV21() {
  filesScreen({
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
    const { bytes, spec } = state.picked[OFFICIAL.v21.files[0].file];
    say('Sending.');
    await tracked('ARTIFICE_V21', () => transport.sendVerified(bytes, { official: spec }));
    say('');
    viewV21Run();
  });
}

function viewV21Run() {
  paint(`
    <h2>Run arTIfiCE</h2>
    <p class="cec-sub">arTIfiCE is on the calculator as program A.</p>
    ${walk('ce-jb-v21-run')}
    <p>Whenever you want to play: <kbd>prgm</kbd>, run A, pick the game. <kbd>mode</kbd> leaves the shell.</p>
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Done</button></div></div>
  `, 2);
  $('#cec-next').onclick = viewPlay;
}

function viewV3Installer() {
  filesScreen({
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
    // Both names are cleared now, on the home screen: the trigger goes later,
    // with an app open.
    say('Checking the calculator.');
    await transport.precheck(OFFICIAL.v3.files);
    say('Sending the installer program.');
    await tracked('ARTIFICE_V3_PPPP', () => transport.sendVerified(installer.bytes, { official: installer.spec }));
    say('');
    viewV3Inequalz();
  });
}

// Send stays off until the student ticks that Inequalz is open on Y=.
function viewV3Inequalz() {
  const trigger = OFFICIAL.v3.files[1];
  filesScreen({
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
    gate: () => !!$('#cec-open')?.checked,
  });
  $('#cec-open').onchange = renderPicked;
}

function sendV3Trigger() {
  work(async () => {
    const trigger = state.picked[OFFICIAL.v3.files[1].file];
    say('Sending the trigger. The calculator restarts as it lands.');
    // No listing with an app in front; precheck already cleared the name.
    await tracked('ARTIFICE_V3_INEQUVAR', () => transport.sendVerified(trigger.bytes, { official: trigger.spec, skipDirectory: true }));
    say('');
    viewV3Finish();
  });
}

// The jailbreak is not finished until AsmHook2 has run, so how to start games
// waits for the Play screen.
function viewV3Finish() {
  paint(`
    <h2>Launch AsmHook2</h2>
    <p class="cec-sub">The calculator installs AsmHook2 and restarts on its own.</p>
    ${walk('ce-jb-v3-asmhook')}
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Done</button></div></div>
    <p class="cec-why"><strong>Good to know.</strong> You only need to launch AsmHook2 once; it stays through restarts. After a RAM reset, launch it again. If Inequalz later reports CONFLICTING APPS, choose option 2, then launch AsmHook2 again after leaving it.</p>
  `, 2);
  $('#cec-next').onclick = viewPlay;
}

// One button that sends Snake, so a game runs the moment the jailbreak is
// done. After the v3 restart the installer's link is gone, and the click
// picks the calculator again.
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
function sendGameButton(game) {
  work(async () => {
    let link = null;
    try {
      link = await gameLink();
      say(`Getting ${game.label}.`);
      const response = await fetch(game.file);
      if (!response.ok) throw refusal('FETCH', `${game.label} could not be downloaded from this site. Try again in a moment.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      say(`Sending ${game.label}. Leave the cable alone until it finishes.`);
      const r = await sendGame(link, [bytes], {
        onProgress: (done, total) => { if (total) say(`Sending ${game.label}. Leave the cable alone until it finishes. ${Math.min(99, Math.round(done / total * 100))}%`); },
      });
      const outcome = r.replaced.length ? 'replaced' : 'sent';
      track('ce_send_success', { game: game.name, outcome, route: r.route, page: 'installer' });
      const how = startHint(String(state.info?.os || r.os), game.name);
      say(`${game.label} is on the calculator. ${how}`);
    } catch (err) {
      // A dead link is dropped for good: the next click picks again.
      if (linkDead(err)) {
        if (link === transport.link) transport.poisoned = true;
        playLink = null;
      }
      track('ce_send_fail', { game: game.name, reason: installerFailReason(err), ...refusedAt(err) });
      throw err;
    }
  });
}
const sendActions = () => `
    <div class="cec-actions" data-status><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="${GAME.id}">Send ${GAME.label}</button></div></div>`;
function wireSends() {
  $(`#${GAME.id}`).onclick = () => sendGameButton(GAME);
}

function viewPlay() {
  paint(`
    <h2>Put a game on it</h2>
    <p class="cec-sub">Send Snake to see it work. ${state.info?.route === 'v21' ? 'Games start from the arTIfiCE shell: <kbd>prgm</kbd>, run A, pick the game.' : 'Games start from the <kbd>prgm</kbd> menu.'}</p>
    ${sendActions()}
    ${state.info?.route === 'v21' ? '' : walk('ce-jb-v3-game')}
    ${gamesActions()}
  `, 3);
  wireSends();
  // A CE has no USB serial number, so after the v3 restart the browser no
  // longer knows it (observed on hardware on 5.8.5).
  if (transport.poisoned && !playLink) say('The calculator restarted, so your browser will ask you to pick it again when you press Send.');
}

function unavailable(message) {
  root().innerHTML = `<section class="cec-card"><h2>This page needs Chrome or Edge</h2>
    <p>${esc(message)}</p>
    <div class="cec-actions"><div class="wp-block-button"><a class="wp-block-button__link no-border-radius" href="${WRITTEN}"${writtenAttrs()}>Manual installation</a></div></div></section>`;
}

// On localhost only: paint any screen from a made-up OS version, so every
// screen can be looked at without a calculator. Nothing here sends.
//   ?screen=<name>  one screen (PREVIEW_SCREENS)   &picked=1  files in hand
//   &error=<text>   the error band                 &fail=<code>  a library error's band
//   &win=1, &cros=1 Windows or Chrome OS wording
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
  if (!PREVIEW_HOST) return false;
  window.__cecPreview = name => {
    const screen = PREVIEW_SCREENS[name];
    if (!screen) return Object.keys(PREVIEW_SCREENS);
    const [os, view] = screen;
    state.info = { model: 'TI-84 Plus CE', os, route: compatibility(os) };
    state.picked = {};
    transport.info = state.info;
    transport.poisoned = false;
    view();
    return name;
  };
  window.__cecPreviewPicked = () => {
    (state.screenFiles.length ? state.screenFiles : officialFiles(state.info.route))
      .forEach(f => { state.picked[f.file] = { bytes: null, spec: f }; });
    renderPicked();
  };
  window.__cecPreviewError = message => { fail(refusal('PREVIEW', message)); };
  // CALC_ERROR_<decimal> is a calculator refusal with that code.
  window.__cecPreviewFail = code => {
    const n = /^CALC_ERROR_(\d+)$/.exec(code);
    fail(n ? new CELinkError('CALC_ERROR', 'A previewed refusal.', { calcError: Number(n[1]) }) : refusal(code, code));
  };
  window.__cecPreviewWindows = on => { forceWindows = !!on; };
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

function boot() {
  if (!root()) return;
  // Before the WebUSB check: a preview may load in a frame, which has no WebUSB.
  if (installPreview()) return;
  if (!navigator.usb) {
    unavailable('Sending files straight to a calculator only works in Chrome or Edge on a computer. Manual installation works in any browser.');
    return;
  }
  // Release the calculator on leaving, so the games hub in the same tab can open it.
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
