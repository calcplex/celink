// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The guided jailbreak installer at the top of /ti84plusce-jailbreak-tutorial/,
// one task per screen, and the manual installation under it (mountGuide). The checks and transfers are core.mjs and transport.mjs;
// this is the wizard around them. The arTIfiCE files come from this site and
// are checked against their pins before they reach USB; if that fails, the
// student picks the author's download instead.
//
// Connect, second version: every computer starts on Connect (Windows is asked
// about TI Connect CE only after an empty device list), a Connect after a lost
// link asks for the calculator again instead of a reload, and the screens
// around it say what the device list looks like. The logic it adds is
// connect.mjs.
//
// Sending OS 5.4.0: on OS 5.2 and earlier the native screen sends OS 5.4.0
// from the file the student downloads from TI-Planet. The screens are
// os540.mjs.
//
// The app panel (the app feature): the same screens drawn as one panel
// the height of the window, one step at a time; the app block near the end.
import { CETransport } from './transport.mjs';
import { OS_540_URL, connectAfresh, connectFailScreen, noUsbKind, offersOs540, reconnect, runningText } from './connect.mjs';
import { os540Screens, waitingForOS } from './os540.mjs';
import { pickCalculator, sendGame } from './gamesend.mjs';
import {
  INEQUALZ_URL, LEAVE_SHELL_KEY, OFFICIAL, PREVIEW_HOST, ROUTES, RUNNING_TEXT, TICONNECT_URL, archiveMode, calcParams, compatibility, esc,
  fetchOfficial, identifyOfficial, inequalzStatus, installerFailReason, installerReturn, isChromeOS, isWindows, keyHelpHtml, linkDead, modelLabel, mountKeyHelp,
  needsAsm, officialFiles, openDetail, parseFlashApp, parseVariable, programRunning, refusal, refusalText, refusedAt, resumable, startHint,
  stepTracker, tabHandoff, track, trackConnectFail, unknownRefusal, unreadModel, TAB_BUSY_TEXT,
} from './core.mjs';
import { CELinkError } from '../celink.mjs';
import { EVO_PRODUCT_ID as EVO_ID } from '../celink.mjs';

const AUTHOR = 'https://yvantt.github.io/arTIfiCE/';
const RELEASE = tag => `https://github.com/YvanTT/arTIfiCE/releases/tag/${tag}`;
// "Manual installation": the steps under the wizard on the same page, as the
// page generator put them on #cec-shell.
const WRITTEN = document.getElementById('cec-shell')?.dataset.writtenSteps || '#manual';
const writtenAttrs = () => (/^https?:/.test(WRITTEN) ? ' target="_blank" rel="noopener nofollow"' : '');
const SHELL = document.getElementById('cec-shell')?.dataset || {};
const LOCAL = PREVIEW_HOST ? new URLSearchParams(location.search) : null;
const setting = (param, attr, fallback) => (LOCAL?.has(param) ? LOCAL.get(param) : SHELL[attr] || fallback);
// The app panel: data-app "on" on #cec-shell (the generator writes it while
// the app feature is on); ?app=on or ?app=off on localhost.
const APP = setting('app', 'app', 'off') === 'on';
// The Run screen's "arTIfiCE didn't open?" link and the running-program check before
// a v2.1 send (data-runcheck 'on'). Both arms of the AsmHook2 split ask too.
const RUN_CHECK = setting('runcheck', 'runcheck', 'off') === 'on';
const GAMES = '/downloads/ti84plusce/games/';
// A page that sent the student here with ?next=<path> (core's
// INSTALLER_RETURNS): the last screen goes back there instead of to games.
const BACK = installerReturn(location.search);
// The connection picture, served beside this module.
const ART = '/ti84plusce-jailbreak-tutorial/connection.svg';
// The game the Play screen sends: one assembly program, no C libraries.
// `name` is the variable inside the file.
const GAME = { id: 'cec-snake', label: 'Snake', file: '/downloads/ce/SnakeCE.8xg', name: 'SNAKE' };
const ARCHIVING = 'https://education.ti.com/en/customer-support/knowledge-base/ti-83-84-plus-family/product-usage/34936';
// Walkthroughs: a numbered list of key presses over emulator screenshots,
// stepped by the reader (nothing animates). Frame i is the screen step i
// happens on; `done` is the result, beside the last frame. A walk's frames
// are named after its key.
const GAME_WALK = {
  alt: 'Starting a game on a calculator: the prgm menu, the name on the home screen, then the game running',
  steps: [
    'Press <kbd>prgm</kbd>, arrow to your game, then press <kbd>enter</kbd>.',
    'Its name is on the home screen. Press <kbd>enter</kbd> again.',
  ],
  done: 'The game starts.',
  note: 'On a Python edition, <kbd>prgm</kbd> first asks TI-Basic or Python. Pick TI-Basic.',
};
const WALKS = {
  'ce-jb-reset-ram': {
    alt: 'Clearing the RAM on a calculator: the MEMORY menu, the RAM tab, the confirmation, then RAM Cleared',
    steps: [
      'Press <kbd>2nd</kbd>, then <kbd>+</kbd>.',
      'Press <kbd>7</kbd> for Reset.',
      'Press <kbd>1</kbd> for All RAM.',
      'To confirm, press <kbd>2</kbd> for Reset.',
    ],
    done: 'It says RAM Cleared.',
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
    done: 'It reports Installation successful. Press <kbd>clear</kbd> until the home screen shows, or the calculator won\'t take the game.',
  },
  // Turning the jailbreak back on after a RAM reset (the popup's found-but-off
  // screen): opening AsmHook2 again sets its hook (CEmu 5.8.5: Installation
  // successful!, games start from prgm). The same three screens as above.
  'ce-jb-v3-turnon': {
    frames: 'ce-jb-v3-asmhook',
    alt: 'Opening AsmHook2 on a calculator: the APPS list, AsmHook2 picked, then Installation successful',
    steps: [
      'Press <kbd>apps</kbd>.',
      'Arrow down to AsmHook2 and press <kbd>enter</kbd>.',
    ],
    done: 'It says Installation successful. Press <kbd>clear</kbd>. Games start from <kbd>prgm</kbd> again.',
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
    alt: 'Running arTIfiCE on a calculator: the prgm menu, prgmA on the home screen, arTIfiCE\'s list of games, then the game running',
    steps: [
      'Press <kbd>prgm</kbd>, then press <kbd>enter</kbd> on A.',
      'prgmA is on the home screen. Press <kbd>enter</kbd> again.',
      'arTIfiCE lists your games. Arrow to one and press <kbd>enter</kbd>.',
    ],
    done: 'The game starts.',
    note: 'On a Python edition, <kbd>prgm</kbd> first asks TI-Basic or Python. Pick TI-Basic.',
  },
};

const walkEntries = w => w.steps.concat([w.done]);
// A walk may show another walk's pictures (`frames`).
const frameUrl = (name, i) => `/images/evo/${WALKS[name]?.frames || name}-${i}.png`;
const CHEVRON_LEFT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 2 4 7l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Step HTML is trusted (it carries <kbd>); the alt is escaped. The result is
// numbered like the steps. Each row carries a chevron so it reads as
// something to click, and a labelled Next sits under the picture. A walk's
// `note` (the Python edition's extra question) goes under it, once, never
// inside a step; the manual installation writes its own (`note: false`).
const walk = (name, { note = true } = {}) => {
  const w = WALKS[name];
  const n = walkEntries(w).length;
  return `
  <div class="cec-walk" data-walk="${name}">
    <ol class="cec-walk-steps">${walkEntries(w).map((step, i) => `
      <li${i === 0 ? ' class="is-now"' : ''}><button type="button" data-go="${i}"><span>${step}</span><span class="cec-walk-go" aria-hidden="true">${CHEVRON_RIGHT}</span></button></li>`).join('')}
    </ol>
    <figure class="cec-walk-pic">
      <img src="${frameUrl(name, 0)}" alt="${esc(w.alt)}" width="320" height="240" decoding="async">
    </figure>
    <div class="cec-walk-nav">
      <button type="button" class="cec-walk-arrow" aria-label="Previous step" disabled>${CHEVRON_LEFT}</button>
      <p class="cec-walk-count">Step 1 of ${n}</p>
      <button type="button" class="cec-walk-next" aria-label="Next step">Next ${CHEVRON_RIGHT}</button>
    </div>${note && w.note ? `
    <p class="cec-walk-note">${w.note}</p>` : ''}
  </div>`;
};

// Back and Next step by one, a list item jumps to its step, a click on the
// picture advances. Frames are preloaded so stepping never flashes: at once in
// the wizard, and in the manual installation (`lazy`, seven walks, most in
// routes nobody opened) the first time a pointer or focus reaches the walk.
// `_sync` restores Back and Next after work() has re-enabled every button.
function mountWalks(scope = root(), { lazy = false } = {}) {
  scope.querySelectorAll('.cec-walk').forEach(el => {
    const name = el.dataset.walk;
    const w = WALKS[name];
    const n = walkEntries(w).length;
    const preload = () => {
      if (el._preloaded) return;
      el._preloaded = true;
      for (let i = 0; i < n; i++) new Image().src = frameUrl(name, i);
    };
    if (lazy) ['pointerenter', 'focusin', 'touchstart'].forEach(type => el.addEventListener(type, preload, { once: true, passive: true }));
    else preload();
    const img = el.querySelector('.cec-walk-pic img');
    const items = el.querySelectorAll('.cec-walk-steps li');
    const count = el.querySelector('.cec-walk-count');
    const back = el.querySelector('.cec-walk-arrow');
    const next = el.querySelector('.cec-walk-next');
    let at = 0;
    // A button that disables itself while focused would drop keyboard focus
    // to the page, so focus moves to the other one.
    const show = i => {
      at = Math.max(0, Math.min(n - 1, i));
      img.src = frameUrl(name, at);
      items.forEach((li, k) => li.classList.toggle('is-now', k === at));
      count.textContent = `Step ${at + 1} of ${n}`;
      const focused = document.activeElement;
      back.disabled = at === 0;
      next.disabled = at === n - 1;
      if (focused === next && next.disabled) back.focus();
      else if (focused === back && back.disabled) next.focus();
    };
    back.onclick = () => show(at - 1);
    next.onclick = () => show(at + 1);
    el.querySelectorAll('.cec-walk-steps button').forEach(b => { b.onclick = () => show(Number(b.dataset.go)); });
    img.onclick = () => { if (at < n - 1) show(at + 1); };
    el._sync = () => show(at);
  });
}

// Every route ends on the games hub, in this tab: the page lets go of the
// calculator on leaving, so the hub can open it. `secondary`: the screen's
// main button is another one (Send Snake), so this one is outlined, and a
// screen has one filled button.
const gamesActions = ({ secondary = false } = {}) => (BACK ? backActions({ secondary }) : `
    <div class="cec-actions">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius${secondary ? ' is-secondary' : ''}" href="${GAMES}">See all games</a></div>
    </div>`);
const backActions = ({ secondary = false } = {}) => `
    <div class="cec-actions">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius${secondary ? ' is-secondary' : ''}" href="${esc(BACK.href)}">Go back to ${esc(BACK.name)}</a></div>
    </div>`;

const $ = s => document.querySelector(s);

// Sent here from a page (BACK), the last step is going back to it, not playing.
const STEPS = ['Connect', 'Check', 'Install', BACK ? 'Done' : 'Play'];

// Where the words are ours. Refusals read through refusalText; anything else
// shows the error's own message.
const OUTCOME_TEXT = {
  no_device: 'No calculator was picked. Press the button again, click your calculator in the list, then Connect.',
  open_failed: 'Another program is using the calculator. Close TI Connect CE and anything else that talks to it, unplug the calculator, plug it back in, then press Connect calculator again.',
  link_lost: 'The calculator stopped answering. If a game is running on it, quit the game and connect again. Otherwise, unplug the USB cable, plug it back in, then choose Start over.',
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

// "Didn't work?" fits the step it opens on. A step with one likely problem
// shows its fix at once; only Connect, where two different things go wrong,
// asks first (fixed choices, never a text box: a box collects personal
// details that must not reach analytics). Either way the panel ends with Help
// chat. One ce_report per value per page load: the choice picked, or, for a
// step with no choices, the open itself with the step's value; `game` is the step.
const REPORT_CHOICES = {
  not_found: "My calculator isn't in the list",
  in_use: "It's in the list but won't connect",
};
// The choices for the step on show, or [] when the step has one fix.
function reportChoices() {
  return state.step === 0 ? ['not_found', 'in_use'] : [];
}
// The value a step with no choices counts its open as.
function reportTopic() {
  const screen = state.screen || '';
  if (state.step >= 3 || state.jailbroken || screen === 'native' || screen === 'v21_found') return 'wont_start';
  if (screen === 'v3_reset' || screen === 'v3_inequalz') return 'froze';
  return 'other';
}
function reportFix(choice) {
  const i = state.info;
  const p = items => items.filter(Boolean).map(x => `<p>${x}</p>`).join('');
  const manual = lead => `${lead} <a href="${WRITTEN}"${writtenAttrs()}>manual installation</a>.`;
  const replug = 'Unplug the calculator, plug it back in, then press Start over.';
  // On Windows the missing driver is by far the likeliest cause.
  if (choice === 'not_found') return p([
    onWindows() ? '<button type="button" class="cec-inline" data-go="install">Install TI Connect CE</button>. Windows only lists the calculator once it is installed.'
      : 'Turn the calculator on, then unplug the cable and plug it back in.',
    'Use the cable that came with the calculator. Some cables only charge.',
  ]);
  if (choice === 'in_use') return p([
    'Close TI Connect CE and any other tab using the calculator.',
    'Then unplug it, plug it back in and try again.',
  ]);
  if (choice === 'froze') return p([
    state.screen === 'v3_inequalz' ? 'The calculator restarts on its own when the install finishes.' : 'Clearing the RAM restarts the calculator.',
    'If it froze instead, unplug the cable, press the reset button on the back of the calculator, then press Start over.',
  ]);
  if (choice === 'wont_start') return p([
    i ? esc(startHint(i.os, 'the game')) : 'Start games the way the Play step shows for your calculator.',
    // Same tab: this page lets go of the calculator on leaving, so the games page can open it.
    `If it mentions LibLoad or libraries, send the game again from <a href="${GAMES}">our games page</a>.`,
  ]);
  // Turn on the jailbreak: AsmHook2 missing means the last file never took.
  if (state.screen === 'v3_finish') return p(['If AsmHook2 isn\'t in apps, the install didn\'t finish. Press Start over and do the steps again.']);
  return p([replug, manual('Still stuck? Try the')]);
}
// Help chat at the end of the panel: the footer's own link (Plexy's), so it
// shows exactly when that one does: not there, or hidden, means no button.
const helpLink = () => [...document.querySelectorAll('#cec .cec-foot .hp-link')].find(l => l.getClientRects().length) || null;
function toggleReport() {
  const box = $('#cec-report'), btn = $('#cec-report-open');
  if (!box || !btn) return;
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const choices = reportChoices();
  box.innerHTML = `<div class="cec-report-head"><p class="cec-report-q">${choices.length ? 'What happened?' : 'Didn\'t work?'}</p>
    <button type="button" class="cec-inline cec-report-close">Close</button></div>
    ${choices.length ? `<div class="cec-report-choices">${choices.map(id =>
      `<button type="button" data-choice="${id}">${REPORT_CHOICES[id]}</button>`).join('')}</div>` : ''}
    <div class="cec-report-fix" id="cec-report-fix" hidden></div>
    <p class="cec-report-chat" hidden><button type="button" class="cec-inline" id="cec-report-chat">Help chat</button></p>`;
  box.querySelectorAll('[data-choice]').forEach(b => { b.onclick = () => report(b.dataset.choice); });
  box.querySelector('.cec-report-close').onclick = () => { toggleReport(); btn.focus(); };
  // Shown once Plexy's link is in the footer (it adds it after the page loads).
  const chat = $('#cec-report-chat');
  chat.onclick = () => helpLink()?.click();
  const showChat = () => { chat.parentElement.hidden = !helpLink(); };
  showChat();
  if (chat.parentElement.hidden) setTimeout(showChat, 1500);
  if (!choices.length) report(reportTopic());
}
function report(choice) {
  const box = $('#cec-report');
  box.querySelectorAll('[data-choice]').forEach(b => b.classList.toggle('is-picked', b.dataset.choice === choice));
  const fix = $('#cec-report-fix');
  fix.innerHTML = reportFix(choice);
  fix.hidden = false;
  // An answer that names Start over shows it (on Connect it waits for a failure).
  const restart = $('#cec-restart');
  if (restart && fix.textContent.includes('Start over')) restart.hidden = false;
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
  v21: null,        // arTIfiCE v2.1 then Snake; a retry resumes at the one that failed
  deadEnd: false,   // the screen on show ends the install (its footer shows Manual installation)
  screen: '',       // the ce_step name of the screen on show
  answered: {},     // Run screen check: answer -> true, so one page load counts each once
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

// The footer's Manual installation link shows only where doing it by hand is
// the real way out (the section is right under the wizard): on a screen that ends the install, and after a failure. Not after
// a failure the manual installation can't fix either: an Evo, a calculator
// that isn't a CE, a low battery, another tab busy with it, a program left
// running. A version arTIfiCE doesn't cover has no manual route either.
// One wrong_model keeps it: a calculator that gave no model name
// (unreadModel), which is almost always a CE TI Connect CE can still reach.
const NO_MANUAL = ['evo', 'no_webusb', 'other_model', 'wrong_model', 'low_battery', 'tab_busy', 'running_before'];
function showManual(on) {
  const a = root()?.querySelector('.cec-manual');
  if (a) a.hidden = !on;
}

// There is no Back: Start over (a reload) is the one way backwards. On the
// first screen it would only reload that screen, so it shows there only
// after a failure (whose words may name it).
function foot() {
  return `<div class="cec-report" id="cec-report" hidden></div>
  <div class="cec-foot">
    <button type="button" id="cec-restart"${state.busy ? ' disabled' : ''}${state.screen === 'connect' ? ' hidden' : ''}>Start over</button>
    <button type="button" id="cec-report-open"${state.busy ? ' disabled' : ''} aria-expanded="false" aria-controls="cec-report">Didn't work?</button>
    <a class="cec-manual" href="${manualHref()}"${writtenAttrs()}${state.deadEnd ? '' : ' hidden'}>Manual installation</a>
  </div>`;
}

// Counts the first time each screen shows in a page load.
const stepOnce = stepTracker();
function trackStep(screen) {
  stepOnce(screen, state.info?.route);
}

// The prgm key's picture box, one per page, mounted in boot().
let keyHelp = null;

// A key (or the prgm key help) and the punctuation after it stay on one line.
const keepKeyPunctuation = html => html.replace(/(?:<kbd>[^<]*<\/kbd>|<button type="button" class="cec-keyhelp"[^>]*>(?:[^<]|<(?!\/button>))*<\/button>)[.,:;)]+/g, m => `<span class="cec-nobr">${m}</span>`);

// Smooth, unless the reader's system asks for less motion: then it jumps.
const scrollBehavior = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');

// The site's bar (site.js) is fixed once the page has scrolled past it, and
// then covers the top of the window whenever it has slid back in.
function barBottom() {
  const bar = document.getElementById('sticky-navigation');
  if (!bar || getComputedStyle(bar).position !== 'fixed') return 0;
  return Math.max(0, bar.getBoundingClientRect().bottom);
}

// Screens differ a lot in height, so a button pressed at the bottom of a tall
// one could leave the next screen's start above the window, or its button
// below it. After
// a screen change, if the card's top is hidden or the new screen's first
// button is off-screen, the card's top comes to just under the site's bar
// (its scroll-margin-top). When both are in view, nothing moves. Focus stays
// where paint() put it.
function anchorView(card) {
  const top = card.getBoundingClientRect().top;
  const bar = barBottom();
  const bottom = window.innerHeight || document.documentElement.clientHeight;
  const main = [...card.querySelectorAll('.cec-actions .wp-block-button__link')].find(b => b.getClientRects().length);
  const r = main?.getBoundingClientRect();
  if (top >= bar && top < bottom && (!r || (r.top >= bar && r.bottom <= bottom))) return;
  card.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
}

// The progress row is the card's first line, so it reads as part of the tool.
// `deadEnd`: this screen ends the install. The
// first paint (the page loading) never scrolls; every later one is a screen
// change and anchors the view.
let painted = false;
function paint(body, step, screen, { deadEnd = false } = {}) {
  trackStep(screen);
  state.gate = null;
  state.afterWork = null;
  state.step = step;
  state.screen = screen;
  state.deadEnd = deadEnd;
  if (APP) return appFrame(body);
  root().innerHTML = `<section class="cec-card">${progress()}${keepKeyPunctuation(body)}
    <p class="cec-status" role="status" aria-live="polite" id="cec-status"></p>
    <div class="cec-error" role="alert" id="cec-error" hidden></div>
    ${foot()}</section>`;
  // The status and error bands move under the button they report on: the
  // last row of actions, or a row marked data-status (after the device-list
  // line, which stays right under its Connect button).
  const card = root().querySelector('.cec-card');
  const rows = card.querySelectorAll('.cec-actions');
  if (rows.length) {
    const status = $('#cec-status');
    const row = card.querySelector('.cec-actions[data-status]') || rows[rows.length - 1];
    (row.nextElementSibling?.classList.contains('cec-picker-line') ? row.nextElementSibling : row).insertAdjacentElement('afterend', status);
    status.insertAdjacentElement('afterend', $('#cec-error'));
  }
  $('#cec-restart').onclick = () => { if (!state.busy) location.reload(); };
  $('#cec-report-open').onclick = toggleReport;
  mountWalks();
  const heading = root().querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  if (painted) anchorView(card);
  painted = true;
  keyHelp?.refresh();
}

// On Windows, no_device is usually an empty picker (no TI Connect CE driver)
// and open_failed a running TI Connect CE or another tab holding the port.
// open_security, an open refused for security, is a driver the browser can't
// open the calculator through, which the latest TI Connect CE replaces.
// A failed Connect moves to its own screen for the first two (connectFailScreen);
// these bands are for the same failure again on that screen, and for a device
// list opened by any other button.
const WINDOWS_OUTCOME_HTML = {
  no_device_again: `<p><strong>No calculator was picked.</strong> If the list was empty, turn the calculator on or try another USB cable.</p>`,
  no_device: `<p><strong>Install TI Connect CE, then try again.</strong> On Windows the calculator only shows up in the list once it's installed.</p>
    <p><button type="button" class="cec-inline" data-go="install">Install TI Connect CE</button></p>`,
  open_failed: `<p><strong>Close TI Connect CE and any other tab using the calculator.</strong> Then unplug it, plug it back in and press Connect calculator again.</p>`,
  open_security: `<p><strong>Update TI Connect CE to the <a href="${TICONNECT_URL}" target="_blank" rel="noopener nofollow">latest version from TI</a>.</strong> Then unplug the calculator, plug it back in and press Connect calculator again.</p>`,
};
// The Windows box for an error: open_security has its own, and so does an
// empty list on the screen that already says to install TI Connect CE.
const windowsKey = (err, reason) => (reason === 'open_failed' && openDetail(err) === 'open_security' ? 'open_security' : reason === 'no_device' && (state.screen === 'win_nodevice' || state.screen === 'win_install') ? 'no_device_again' : reason);
// A TI-84 Evo shares TI's vendor id, so it shows in the device list.
const EVO = '/ti84evo-jailbreak/';
const EVO_OUTCOME_HTML = `<p>That's a TI-84 Evo. This jailbreak is only for the TI-84 Plus CE, and there is no jailbreak for the Evo yet. <a href="${EVO}">What your Evo can run</a></p>`;
// A school Chromebook's policy can stop the device list from opening at all:
// the browser then reports no device picked (no_device), or the list failed
// to open (`picker`, set where the picker is called). Either way the
// Chromebook line goes with it.
const CHROMEOS_OUTCOME_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then press Connect calculator again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
  no_device: "No calculator was picked. Press the button again, click your calculator in the list, then Connect. Some school Chromebooks don't let websites use USB devices, so if no list opens, try a Windows or Mac computer.",
  picker: "Your browser couldn't open the list of devices. Some school Chromebooks don't let websites use USB devices, so try a Windows or Mac computer.",
};
// The Chrome OS text for an error: a failed device list has its own.
const chromeosKey = (err, reason) => (err?.picker && reason !== 'no_device' ? 'picker' : reason);
// Marks an error thrown by the browser's device list (before any calculator
// was picked), so fail() can tell it from a cable that dropped later.
const PICKER_CODES = ['NO_DEVICE_SELECTED', 'USB_ERROR'];
function markPicker(err) {
  if (err && typeof err === 'object' && PICKER_CODES.includes(err.code)) err.picker = true;
  return err;
}
function say(text) { const el = $('#cec-status'); if (el) el.textContent = text || ''; }
function fail(err) {
  const el = $('#cec-error');
  if (!el) return;
  const reason = installerFailReason(err);
  state.lastReason = reason;
  if (programRunning(err)) {
    el.textContent = runningText({ route: state.info?.route, screen: state.screen }) || RUNNING_TEXT;
  } else if (lostText(err, reason)) {
    lostBand(lostText(err, reason));
  } else if (reason === 'evo') {
    el.innerHTML = EVO_OUTCOME_HTML;
  } else if (onWindows() && WINDOWS_OUTCOME_HTML[windowsKey(err, reason)]) {
    el.innerHTML = WINDOWS_OUTCOME_HTML[windowsKey(err, reason)];
    const go = el.querySelector('[data-go="install"]');
    if (go) go.onclick = () => { if (!state.busy) viewInstallTIConnect(); };
  } else {
    el.textContent = (onChromeOS() && CHROMEOS_OUTCOME_TEXT[chromeosKey(err, reason)]) || OUTCOME_TEXT[reason]
      || (reason === 'timeout' ? timeoutText(err) : null)
      || (unknownRefusal(err) ? retryText(err.calcError) : null) || refusalText(err) || err?.message || String(err);
  }
  el.hidden = false;
  if (APP) {
    appShowManual(el);
    // Nothing picked, on Connect: the line under the button already says
    // what to do in the list, so the error says only what happened.
    if (reason === 'no_device' && state.screen === 'connect' && !onWindows() && !onChromeOS()) el.textContent = 'No calculator was picked.';
    const go = $('#cec-go');
    if (go && /^(connect|win_)/.test(state.screen)) {
      go.textContent = 'Try again';
      // The card's words name its button; here the button says Try again.
      el.innerHTML = el.innerHTML.replace(/press Connect calculator again/g, 'press Try again');
    }
  }
  showManual(state.deadEnd || !(programRunning(err) || (NO_MANUAL.includes(reason) && !unreadModel(err))));
  say('');
}

// A band that just appeared must be seen (after fail() and lostBand(), from
// work(), lost() and the preview): Start over comes back (its words may name
// it), and if the band is out of the window it scrolls in, the least distance
// (its scroll-margin keeps it clear of the site's bar).
function showBand() {
  const el = $('#cec-error');
  if (!el || el.hidden) return;
  const restart = $('#cec-restart');
  // The popup's Start over shows on its first step only when the band names it.
  if (restart && !(APP && state.step === 0 && !/Start over/.test(el.textContent))) restart.hidden = false;
  const r = el.getBoundingClientRect();
  const bottom = window.innerHeight || document.documentElement.clientHeight;
  if (r.top < barBottom() || r.bottom > bottom) el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
}

// A link that died part way through an install (unplugged, stopped answering,
// taken by another tab) is picked up again from the screen the student is on:
// the band's button opens the device list and checks it is the same calculator.
const LOST_TEXT = {
  POISONED: 'The connection to the calculator was lost. Unplug it and plug it back in.',
  OTHER_CALCULATOR: 'This is not the calculator you started with. Plug that one in.',
};
// A link that dies during a send on Check or Install gets the same band, except
// while the v3 trigger goes, which restarts the calculator on purpose, and on
// the native screen, whose Send picks the calculator itself.
const OWN_PICK = ['native', 'v3_inequalz'];
function lostText(err, reason) {
  if (LOST_TEXT[err?.code]) return LOST_TEXT[err.code];
  const during = state.step >= 1 && state.step <= 2 && !OWN_PICK.includes(state.screen);
  if (during && transport.poisoned && (reason === 'link_lost' || reason === 'timeout')) return 'The calculator stopped answering. Unplug it and plug it back in.';
  return null;
}
function lostBand(lead) {
  const el = $('#cec-error');
  if (!el) return;
  el.innerHTML = `<p>${esc(lead)} Then <button type="button" class="cec-inline" data-go="reconnect">connect again</button>.</p>`;
  el.hidden = false;
  el.querySelector('[data-go="reconnect"]').onclick = reconnectClick;
}
function reconnectClick() {
  work(async () => {
    trackStep('reconnect_click');
    say('Pick your calculator in the browser window that opens.');
    const before = transport.link;
    try {
      await reconnect(transport, { beforeOpen: claim });
    } catch (err) {
      if (transport.link === before) markPicker(err);
      trackConnectFail(err, {}, transport.link === before ? undefined : transport.link?.device);
      throw err;
    }
    trackStep('reconnected');
    say('Connected again. Carry on from this step.');
  });
}

// Every USB touch runs through here: one at a time, buttons locked, errors shown.
async function work(fn) {
  if (state.busy) return;
  state.busy = true;
  const el = $('#cec-error'); if (el) el.hidden = true;
  showManual(state.deadEnd);
  root().querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  root().classList.add('is-busy');
  try {
    await fn();
  } catch (err) {
    fail(err);
    showBand();
  } finally {
    state.busy = false;
    root().classList.remove('is-busy');
    // Re-enable everything, then let the screen and its walks lock what should stay off.
    root().querySelectorAll('button, input').forEach(b => { b.disabled = false; });
    root().querySelectorAll('.cec-walk').forEach(w => w._sync?.());
    state.afterWork?.();
    handoff.held(holds());
  }
}

// `reason` is left off where a heading already says it.
function factsBlock({ reason = true } = {}) {
  const i = state.info;
  return `<div class="cec-facts"><dl>
    <dt>Calculator</dt><dd>${esc(modelLabel(i.model))}</dd>
    <dt>Software version</dt><dd>${esc(i.os)}</dd>
    <dt>What it needs</dt><dd>${esc(ROUTES[i.route].label)}</dd>
  </dl>${reason ? `<p class="cec-why">${esc(ROUTES[i.route].reason)}</p>` : ''}</div>`;
}

// Windows reaches a CE only through the driver TI Connect CE 6.1+ installs;
// without it Chrome's picker is empty (observed on Windows). Every computer
// starts on Connect; on Windows an empty or cancelled list moves to the screen
// that installs or updates TI Connect CE (connectFailScreen), and an open
// refused for security to the one that updates it. Both carry their own
// Connect button. The installer does not open TI Connect CE when it finishes
// (observed on Windows), so those screens only warn against opening it.
// The localhost preview can force either platform.
let forceWindows = false, forceChromeOS = false;
const onWindows = () => forceWindows || isWindows(navigator);
const onChromeOS = () => forceChromeOS || isChromeOS(navigator);

// The one thing to do in the device list, as one line right under every
// Connect button. No picture of the list (too small to read).
const pickerHint = () => `
    <p class="cec-picker-line">In the list that opens, click your calculator, then Connect.</p>`;
const connectButton = () => `
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-go">Connect calculator</button></div>
    </div>`;

const TI_LINK = text => `<a href="${TICONNECT_URL}" target="_blank" rel="noopener nofollow">${text}</a>`;
const WIN_STEPS = [
  `${TI_LINK('Download TI Connect CE from TI')} and run the installer. Already have it? Update it to the latest version.`,
  '<strong>If you open TI Connect CE, close it</strong> before you carry on. We can\'t reach the calculator while it\'s open.',
  'Unplug the calculator, plug it back in and turn it on.',
];
const WIN_FIX = {
  // From "Didn't work?" > Connect doesn't find my calculator.
  install: {
    heading: 'Install TI Connect CE first',
    sub: "Without it, your calculator won't show up when you press Connect.",
    steps: WIN_STEPS,
  },
  // After an empty or cancelled device list.
  nodevice: {
    heading: 'Install TI Connect CE, then connect again',
    sub: 'On Windows, your calculator only shows up in the list once TI Connect CE is installed.',
    steps: WIN_STEPS,
  },
  // After an open refused for security (open_security).
  security: {
    heading: 'Update TI Connect CE, then connect again',
    sub: "Windows won't let this page use the calculator yet.",
    steps: [
      `${TI_LINK('Download the latest TI Connect CE from TI')} and run the installer. Already on the latest? Uninstall it, then install it again.`,
      '<strong>If TI Connect CE opens, close it.</strong> We can\'t reach the calculator while it\'s open.',
      'Unplug the calculator, then plug it back in.',
    ],
  },
};
function viewWinFix(kind) {
  if (APP) return appWinFix(kind);
  const fix = WIN_FIX[kind];
  paint(`
    <h2>${fix.heading}</h2>
    <p class="cec-sub">${fix.sub}</p>
    <ol class="cec-do">${fix.steps.map(step => `
      <li>${step}</li>`).join('')}
    </ol>
    ${connectButton()}
    ${pickerHint()}
  `, 0, `win_${kind}`);
  wireConnect();
}
const viewInstallTIConnect = () => viewWinFix('install');

function viewConnect() {
  if (APP) return appConnect();
  const usb = !!navigator.usb;
  const win = onWindows();
  paint(`
    <div class="cec-head">
      <img class="cec-head-art" src="${ART}" alt="" width="280" height="112">
      <h2>Connect your calculator</h2>
    </div>
    <p class="cec-lead">Plug the CE into this computer with the USB cable that came with it and turn it on.${win
      ? " <strong>Close TI Connect CE</strong> if it's open, or we can't reach the calculator."
      : onChromeOS() ? '' : " Quit TI Connect CE if it's open on this computer, or we can't reach the calculator."}</p>
    ${connectButton()}
    ${usb ? pickerHint() : ''}
    ${usb ? '' : '<p class="cec-why">Direct USB needs Chrome or Edge on a computer. The manual installation below uses TI Connect CE instead.</p>'}
  `, 0, 'connect');
  if (!usb) { $('#cec-go').disabled = true; return; }
  wireConnect();
}

// The Connect button, on the Connect screen and on the Windows screens. Its
// first press in a page load counts as ce_step connect_click. A link that died
// is dropped and the device list opens again (connectAfresh): no reload.
function wireConnect() {
  $('#cec-go').onclick = () => work(async () => {
    trackStep('connect_click');
    say('Pick your calculator in the browser window that opens.');
    // transport.link changes only once the device list has returned a calculator.
    const before = transport.link;
    try {
      state.info = transport.info && !transport.poisoned ? transport.info : await connectAfresh(transport, { beforeOpen: claim });
    } catch (err) {
      if (transport.link === before) markPicker(err);
      if (waitingForOS(err)) return os540().found();
      // A calculator picked this time that is not a CE reports its USB product id.
      trackConnectFail(err, {}, transport.link === before ? undefined : transport.link?.device);
      const next = connectFailScreen({ reason: installerFailReason(err), detail: openDetail(err), windows: onWindows(), screen: state.screen });
      if (!next) throw err;
      state.lastReason = installerFailReason(err);
      say('');
      viewWinFix(next.slice('win_'.length));
      return;
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
  if (APP) return appRoute();
  const route = state.info.route;
  const next = {
    v21: ['Install arTIfiCE v2.1', viewFilesV21],
    v3: ['Install arTIfiCE v3', checkInequalz],
  }[route];
  paint(`
    <h2>${ROUTES[route].heading}</h2>
    ${factsBlock({ reason: !next })}
    ${next ? '' : `<p>${route === 'unknown'
      ? 'Check the About screen on the calculator and connect again.'
      : `<a href="${AUTHOR}" target="_blank" rel="noopener nofollow">The author's page</a> lists every version arTIfiCE covers.`}</p>`}
    ${next ? `<div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">${next[0]}</button></div></div>` : ''}
  `, 1, `route_${route}`, { deadEnd: route === 'unknown' });
  if (next) $('#cec-next').onclick = next[1];
}

function viewNative() {
  if (APP) return appNative();
  const early = needsAsm(state.info.os);
  const lead = early ? `Games start with Asm(, then the ${keyHelpHtml('cec')} menu.` : `Games start from the ${keyHelpHtml('cec')} menu.`;
  paint(`
    <h2>${ROUTES.native.heading}</h2>
    <p class="cec-sub">Games already run on OS ${esc(state.info.os)}.</p>
    ${sendActions()}
    <div id="cec-howto"><p>${lead}</p>${walk(early ? 'ce-jb-native-asm' : 'ce-jb-native-game')}</div>
    ${offersOs540(state.info.os) ? os540Box() : ''}
    ${gamesActions({ secondary: true })}
  `, 1, 'native');
  wireSends();
  const tiplanet = $('#cec-os540-get');
  if (tiplanet) tiplanet.addEventListener('click', () => trackStep('native_os540'));
  if (offersOs540(state.info.os)) os540().wire();
}

// Sending OS 5.4.0: the screens are os540.mjs's, made on first use.
let osScreens = null;
const os540 = () => (osScreens ??= os540Screens({
  $, root, state, transport, work, say, paint, trackStep, claim, pickerHint, viewNative, viewRoute,
  tiLink: TI_LINK, keyHelp: () => keyHelpHtml('cec'),
  // In the app panel the update is its own screens, drawn with the panel's pieces.
  app: APP ? { paint: (screen, step, name) => paint(appScreen(screen), step, name), btn: appBtn, quiet: appQuiet, warn: appWarn, archive: ARCHIVE_LINK } : null,
}));

// OS 5.2 and earlier only: the other way, updating to OS 5.4.0, where games
// start from prgm with no Asm(. Exactly 5.4.0: from 5.5 on, assembly needs a
// jailbreak. The OS file is TI's; the student gets it from TI-Planet's archive
// and sends it with TI Connect CE. Never offered to any other version.
const os540Box = () => os540().box();

// A file input drawn as an outlined button, in the same family as the rest
// (the browser's own "Choose File" control looked like nothing else here).
// The input stays in the page, focusable, with the full words as its name.
const fileButton = (id, accept, name) => `
      <label class="cec-file-btn"><input type="file" id="${id}" accept="${accept}" aria-label="${name}"><span class="wp-block-button__link no-border-radius is-secondary" aria-hidden="true">Choose File</span></label>`;

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
  if (APP) return appNoInequalz();
  paint(`
    <h2>First, install Inequality Graphing on your calculator</h2>
    <ol class="cec-do">
      <li><strong>Click Get Inequality Graphing from TI</strong> and download the app from TI's page. The file ends in <code>.8ek</code> and usually lands in your Downloads folder.</li>
      <li><strong>Come back to this tab and click Choose File.</strong> Pick the <code>.8ek</code> file you downloaded, then click Send the app.</li>
    </ol>
    <div class="cec-actions">
      <div class="wp-block-button"><a class="wp-block-button__link no-border-radius is-secondary" href="${INEQUALZ_URL}" target="_blank" rel="noopener nofollow">Get Inequality Graphing from TI</a></div>
    </div>
    <div class="cec-actions">
      ${fileButton('cec-app', '.8ek', 'Choose the .8ek file you downloaded')}
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-send-app" disabled>Send the app</button></div>
    </div>
    <p class="cec-why">arTIfiCE v3 installs through TI's Inequality Graphing app, Inequalz. Your calculator doesn't have it installed.</p>
  `, 2, 'no_inequalz');
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
  if (APP) return appInequalzUnsure();
  paint(`
    <h2>Check for Inequalz on the calculator</h2>
    <p class="cec-sub">The app list came back empty, so check by hand.</p>
    <ol class="cec-do">
      <li><strong>Press <kbd>apps</kbd>.</strong> Look for Inequalz in the list.</li>
      <li><strong>If it is not there, <button type="button" class="cec-inline" id="cec-ineq-send">send it from this page</button>.</strong></li>
    </ol>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Inequalz is on the calculator</button></div>
      <button type="button" id="cec-recheck" class="cec-plain">Check again</button>
    </div>
  `, 2, 'inequalz_unsure');
  $('#cec-next').onclick = viewV3Reset;
  $('#cec-recheck').onclick = () => work(() => confirmInequalz('The calculator still did not list its apps. Carry on from the apps menu if you can see Inequalz there.'));
  $('#cec-ineq-send').onclick = () => { if (!state.busy) viewNoInequalz(); };
}

function viewV3Reset() {
  if (APP) return appV3Reset();
  paint(`
    <h2>Clear the calculator's RAM</h2>
    <div class="warn"><p>This erases every program and variable that is not archived.
      <a href="${ARCHIVING}" target="_blank" rel="noopener nofollow">Archive</a> or back up anything
      you want to keep first.</p></div>
    ${walk('ce-jb-reset-ram')}
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">The RAM is cleared</button></div></div>
    <p class="cec-why">arTIfiCE v3 needs a clear RAM to install.</p>
  `, 2, 'v3_reset');
  $('#cec-next').onclick = viewV3Installer;
}

// One file per screen: the two v3 files go at different moments, and showing
// both would invite "send both now". The file list, the release page and the
// picker are a fallback, shown only when this site's copy fails to load.
// `also` goes in the button's row, after it, so the status and error bands
// still come after both.
function filesScreen({ files, heading, lead = '', action, also = '', tag, step, screen, onSend, before = '', after = '', gate = null }) {
  paint(`
    <h2>${heading}</h2>
    ${lead ? `<p class="cec-sub">${lead}</p>` : ''}
    ${before}
    <div id="cec-fallback" hidden>
      <p>This file did not load from this site. Download it from the author's release page and
        pick it here.</p>
      <ul class="cec-files" id="cec-filelist">${files.map(f => `
        <li data-file="${esc(f.file)}"><span class="cec-name">${esc(f.file)}</span><span class="cec-state"></span></li>`).join('')}</ul>
      <div class="cec-actions" style="margin-bottom:14px;margin-top:0">
        <div class="wp-block-button"><a class="wp-block-button__link no-border-radius is-secondary" href="${RELEASE(tag)}" target="_blank" rel="noopener nofollow">Open the ${esc(tag)} release page</a></div>
        ${fileButton('cec-pick', '.8xp,.8xv', 'Choose the file you downloaded')}
      </div>
    </div>
    <div class="cec-actions">
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next" disabled>${action}</button></div>${also}
    </div>
    ${after}
  `, step, screen);
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
  const ready = files.length && files.every(f => state.picked[f.file]) && (state.gate ? state.gate() : true);
  // The send button, and Send only arTIfiCE where the screen has it.
  document.querySelectorAll('#cec-next, #cec-only').forEach(b => { b.disabled = !ready; });
}

// Snake goes with arTIfiCE, so the shell has a game to list the first time it
// runs, and nothing is running on the calculator while either one is sent.
function viewFilesV21() {
  if (APP) return appFilesV21();
  state.v21 = resumable([sendArtificeV21, () => sendGameTo(GAME)]);
  filesScreen({
    files: OFFICIAL.v21.files,
    tag: OFFICIAL.v21.tag,
    step: 2,
    screen: 'files_v21',
    heading: 'Send arTIfiCE v2.1 and Snake',
    action: 'Send arTIfiCE and Snake',
    also: '<button type="button" id="cec-only" class="cec-plain cec-alt" disabled>Send only arTIfiCE</button>',
    after: '<p class="cec-why">arTIfiCE is the jailbreak program that lets your calculator run games. We send Snake with it so you have a game to try.</p>',
    onSend: sendV21,
  });
  $('#cec-only').onclick = sendV21Only;
}

async function sendArtificeV21() {
  const { bytes, spec } = state.picked[OFFICIAL.v21.files[0].file];
  say('Sending.');
  await tracked('ARTIFICE_V21', async () => {
    await freeToSend();
    await transport.sendVerified(bytes, { official: spec });
  });
}

// Before a v2.1 send (RUN_CHECK): a program left running refuses the file
// part way, so the page looks first and names the key that leaves it.
async function freeToSend() {
  if (!RUN_CHECK || state.info?.route !== 'v21') return;
  if (!(await transport.busyCheck()).running) return;
  throw refusal('RUNNING_BEFORE', runningBeforeText());
}
const runningBeforeText = () => [
  'A program is running on your calculator, so it can\'t take files.',
  `If it shows arTIfiCE's list of games, press ${LEAVE_SHELL_KEY} to leave it.`,
  'If it\'s another program, quit it. Then press the button again.',
].filter(Boolean).join(' ');

// arTIfiCE alone, for someone who does not want Snake. It lands on the Run
// screen a skipped Snake leads to, which asks for a game before A runs.
// Both choices count their click as ce_step before the send (files_v21_only
// here, files_v21_snake on the main button), so one report compares them and
// a send that fails still shows the choice.
function sendV21Only() {
  work(async () => {
    trackStep('files_v21_only');
    await sendArtificeV21();
    say('');
    viewV21Run({ snake: false, only: true });
  });
}

function sendV21() {
  work(async () => {
    trackStep('files_v21_snake');
    try {
      await state.v21.run();
    } catch (err) {
      if (state.v21.next > 0) offerSkip(); // arTIfiCE landed, Snake did not
      throw err;
    }
    say('');
    viewV21Run({ snake: true });
  });
}

// arTIfiCE landed and Snake did not: the screen says so, the button retries
// Snake alone, and the jailbreak can go on without it.
function offerSkip() {
  const next = $('#cec-next');
  if (!next || $('#cec-skip')) return;
  // arTIfiCE is on now: "Go on without Snake" takes the place of Send only arTIfiCE.
  $('#cec-only')?.remove();
  const heading = root().querySelector('.cec-card h2');
  heading.textContent = `Send ${GAME.label}`;
  if (APP) root().querySelector('.cec-app-body .cec-sub')?.remove();
  heading.insertAdjacentHTML('afterend', '<p class="cec-sub">arTIfiCE is on the calculator as program A.</p>');
  next.textContent = `Send ${GAME.label}`;
  next.closest('.cec-actions').insertAdjacentHTML('beforeend', `<button type="button" id="cec-skip" class="cec-plain">Go on without ${GAME.label}</button>`);
  $('#cec-skip').onclick = () => { if (!state.busy) viewV21Run({ snake: false }); };
}

// Without Snake the shell would open to an empty list, and a game sent while
// it is open is refused, so a game goes on first. The same screen follows
// Send only arTIfiCE; its ce_step name keeps the two apart.
const runScreen = ({ snake, only }) => (snake ? 'v21_run' : only ? 'v21_run_only' : 'v21_run_nosnake');
function viewV21Run({ snake, only = false }) {
  if (APP) return appV21Run({ snake, only });
  if (BACK) return viewBack('arTIfiCE is on the calculator as program A.');
  paint(`
    <h2>Run arTIfiCE</h2>
    <p class="cec-sub">${snake ? `arTIfiCE and ${GAME.label} are on the calculator.` : 'arTIfiCE is on the calculator as program A.'}</p>
    ${snake ? '' : `<p>Put a game on the calculator before you run A. Send ${GAME.label} here.</p>${sendActions()}`}
    ${walk('ce-jb-v21-run')}
    <p>Whenever you want to play: ${keyHelpHtml('cec')}, run A, pick the game.</p>
    ${RUN_CHECK ? checkBlock('plain') : ''}
    ${gamesActions({ secondary: !snake })}
  `, 3, runScreen({ snake, only }));
  if (!snake) wireSends();
  if (RUN_CHECK) wireCheck('plain');
}


// Under the Run walk. Plain route: one quiet link, "arTIfiCE didn't open?",
// that lists the likely causes and counts ce_step screen v21_check outcome no
// once per page load (v21_check yes is no longer sent).
// With AsmHook2 (keys builds): "Did it say AsmHook2 is on?", two buttons,
// each answer counted once per page load as v21_hook_check yes or no.
const CHECKS = {
  plain: {
    screen: 'v21_check',
    link: "arTIfiCE didn't open?",
    no: () => [
      'No A after you press prgm? Press Start over and send arTIfiCE again.',
      'prgmA is still on the home screen? Press enter.',
      'On a Python edition, prgm asks for TI-Basic or Python first. Choose TI-Basic.',
    ],
  },
};
const checkBlock = kind => (CHECKS[kind].link ? `
    <div class="cec-check cec-check-link" id="cec-check">
      <p><button type="button" class="cec-check-open" data-answer="no" aria-expanded="false" aria-controls="cec-check-fix">${CHECKS[kind].link}</button></p>
      <div class="cec-check-fix" id="cec-check-fix" hidden></div>
    </div>` : `
    <div class="cec-check" id="cec-check">
      <p class="cec-check-q">${CHECKS[kind].question}</p>
      <div class="cec-report-choices"><button type="button" data-answer="yes">Yes</button><button type="button" data-answer="no">No</button></div>
      <div class="cec-check-fix" id="cec-check-fix" hidden></div>
    </div>`);
function wireCheck(kind) {
  const box = $('#cec-check');
  box?.querySelectorAll('[data-answer]').forEach(b => {
    b.onclick = () => {
      const answer = b.dataset.answer;
      if (CHECKS[kind].link) b.setAttribute('aria-expanded', 'true');
      else box.querySelectorAll('[data-answer]').forEach(x => x.classList.toggle('is-picked', x === b));
      const fix = $('#cec-check-fix');
      fix.innerHTML = answer === 'yes' ? `<p>${CHECKS[kind].yes()}</p>`
        : `<ul>${CHECKS[kind].no().map(line => `<li>${line}</li>`).join('')}</ul>`;
      fix.hidden = false;
      const key = `${kind}_${answer}`;
      if (state.answered[key]) return;
      state.answered[key] = true;
      track('ce_step', { screen: CHECKS[kind].screen, route: 'v21', outcome: answer });
    };
  });
}
function viewV3Installer() {
  if (APP) return appV3Installer();
  filesScreen({
    files: [OFFICIAL.v3.files[0]],
    tag: OFFICIAL.v3.tag,
    step: 2,
    screen: 'v3_installer',
    heading: 'Send the installer program',
    action: 'Send the installer',
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
  if (APP) return appV3Inequalz();
  const trigger = OFFICIAL.v3.files[1];
  filesScreen({
    files: [trigger],
    tag: OFFICIAL.v3.tag,
    step: 2,
    screen: 'v3_inequalz',
    heading: 'Open Inequalz, then finish the install',
    lead: 'The installer program is on the calculator.',
    action: 'Finish the install',
    onSend: sendV3Trigger,
    before: `
      ${walk('ce-jb-v3-open-inequalz')}
      <div class="warn"><p>Finish the install only while Inequalz is open on its Y= screen, the last picture above.</p></div>
      <label class="cec-confirm"><input type="checkbox" id="cec-open"> Inequalz is open on its Y= screen</label>`,
    after: '<p class="cec-why">The calculator restarts on its own when the install finishes.</p>',
    gate: () => !!$('#cec-open')?.checked,
  });
  $('#cec-open').onchange = renderPicked;
}

function sendV3Trigger() {
  work(async () => {
    const trigger = state.picked[OFFICIAL.v3.files[1].file];
    say('Finishing the install. The calculator restarts on its own.');
    // No listing with an app in front; precheck already cleared the name.
    await tracked('ARTIFICE_V3_INEQUVAR', () => transport.sendVerified(trigger.bytes, { official: trigger.spec, skipDirectory: true }));
    say('');
    viewV3Finish();
  });
}

// The jailbreak is not finished until AsmHook2 has run, so how to start games
// waits for the Play screen.
function viewV3Finish() {
  if (APP) return appV3Finish();
  paint(`
    <h2>Launch AsmHook2</h2>
    <p class="cec-sub">The calculator installs AsmHook2 and restarts on its own.</p>
    ${walk('ce-jb-v3-asmhook')}
    <div class="cec-actions"><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-next">Done</button></div></div>
    <p class="cec-why"><strong>Good to know.</strong> The jailbreak lasts until you reset your RAM. Come back to this page to turn it back on. If Inequalz later shows CONFLICTING APPS, choose option 2, then leave Inequalz and launch AsmHook2 again.</p>
  `, 2, 'v3_finish');
  $('#cec-next').onclick = viewPlay;
}

// One button that sends Snake, so a game runs the moment the jailbreak is
// done. After the v3 restart the installer's link is gone, and the click
// picks the calculator again.
let playLink = null;
async function gameLink() {
  if (transport.link && !transport.poisoned) return transport.link;
  if (!playLink) {
    const link = await pickCalculator().catch(err => { throw markPicker(err); });
    await claim();
    await link.open();
    playLink = link;
    syncPlayPicks();
  }
  return playLink;
}

// Only one tab can hold the calculator. Before this page opens it, the site's
// other tabs are asked to let it go (core's tabHandoff); one that is sending
// or deleting keeps it, and the click says to wait. This page lets it go the
// same way, never while it works, and then needs a reload, as after an unplug.
const holds = () => !!((transport.link?.opened && !transport.poisoned) || playLink);
const handoff = tabHandoff({
  who: 'installer',
  holding: holds,
  busy: () => state.busy,
  release: async () => {
    const links = [transport.link, playLink];
    if (transport.link) transport.poisoned = true;
    playLink = null;
    await Promise.all(links.map(l => l?.close().catch(() => {})));
    lost('Another tab is using the calculator now. Close that tab.');
  },
});
// The link was dropped under the student: on Connect the button asks again;
// on the steps after it, the band's connect again does; once the install is
// in, the Send buttons pick the calculator themselves.
function lost(lead) {
  if (state.step === 0) say(`${lead} Then press ${APP ? 'Connect' : 'Connect calculator'}.`);
  else if (state.step >= 3 || state.busy || state.screen === 'native') say(lead);
  else { lostBand(lead); showBand(); }
}
async function claim() {
  if ((await handoff.claim()) === 'busy') throw refusal('TAB_BUSY', TAB_BUSY_TEXT);
}
// Send `game`, archived where the OS starts archived programs. Resolves
// sendGame's result.
async function sendGameTo(game) {
  let link = null;
  try {
    link = await gameLink();
    if (link === transport.link) await freeToSend();
    say(`Getting ${game.label}.`);
    const response = await fetch(game.file);
    if (!response.ok) throw refusal('FETCH', `${game.label} could not be downloaded from this site. Try again in a moment.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    say(`Sending ${game.label}. Leave the cable alone until it finishes.`);
    const r = await sendGame(link, [bytes], {
      archive: archiveMode('installer', game.name),
      onProgress: (done, total) => { if (total) say(`Sending ${game.label}. Leave the cable alone until it finishes. ${Math.min(99, Math.round(done / total * 100))}%`); },
    });
    const outcome = r.replaced.length ? 'replaced' : 'sent';
    track('ce_send_success', { game: game.name, outcome, route: r.route, page: 'installer' });
    return r;
  } catch (err) {
    // A dead link is dropped for good: the next click picks again.
    if (linkDead(err)) {
      if (link === transport.link) transport.poisoned = true;
      playLink = null;
      syncPlayPicks();
    }
    track('ce_send_fail', { game: game.name, reason: installerFailReason(err), ...refusedAt(err) });
    throw err;
  }
}
// The Play screens' button. Once the game is there, how to start it comes
// into view.
function sendGameButton(game) {
  work(async () => {
    const r = await sendGameTo(game);
    say(`${game.label} is on the calculator. ${startHint(String(state.info?.os || r.os), game.name)}`);
    if (APP) appSent();
    $('#cec-howto')?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  });
}
const sendActions = () => `
    <div class="cec-actions" data-status><div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="${GAME.id}">Send ${GAME.label}</button></div></div>`;
function wireSends() {
  $(`#${GAME.id}`).onclick = () => sendGameButton(GAME);
}

// The v3 route's last screen (v2.1 sends Snake with arTIfiCE). The button
// comes first, how to start a game under it.
// A CE has no USB serial number, so after the v3 restart the browser no
// longer knows it (observed on hardware on 5.8.5): with no live link, Send
// Snake opens the device list again, and the Play screen says so before it.
// The line goes once Send Snake has the calculator (a second send will not
// open the list) and comes back if that link dies.
const playPicks = () => !(transport.link && !transport.poisoned) && !playLink;
function syncPlayPicks() {
  const line = $('#cec-play-picks');
  if (line) line.hidden = !playPicks();
}
function viewPlay() {
  if (BACK) return viewBack('');
  if (APP) return appPlay();
  paint(`
    <h2>Your calculator is jailbroken</h2>
    <p class="cec-sub">Press <kbd>clear</kbd> until the home screen shows, then send Snake.</p>
    <p id="cec-play-picks"${playPicks() ? '' : ' hidden'}>It restarted, so the list opens again when you press Send Snake. Click your calculator, then Connect.</p>
    ${sendActions()}
    <div id="cec-howto"><p>Games start from the ${keyHelpHtml('cec')} menu.</p>${walk('ce-jb-v3-game')}</div>
    ${gamesActions({ secondary: true })}
  `, 3, 'play');
  wireSends();
}

// The last screen for a student a page sent here (BACK): the jailbreak is
// in, so the way on is back to that page, in this tab.
function viewBack(lead) {
  if (APP) return appBack(lead);
  paint(`
    <h2>Your calculator is jailbroken</h2>
    ${lead ? `<p class="cec-sub">${lead}</p>` : ''}
    ${backActions()}
  `, 3, 'back');
}

// On a Chromebook the browser is Chrome already, so no WebUSB there reads as
// USB turned off (as on some school Chromebooks), not as the wrong browser.
const CHROMEOS_NO_USB = ['The installer can\'t use USB on this Chromebook', 'Some school Chromebooks don\'t let websites use USB devices. Try a Windows or Mac computer.'];
// A phone or tablet can't do this at all; a computer only needs the other
// browser, so it gets the page's address to copy (only where the clipboard
// API exists). Its press counts once as ce_step no_webusb_copy.
const NO_USB = {
  chromeos: CHROMEOS_NO_USB,
  mobile: ['The installer needs a computer', 'Do this on a computer with Chrome or Edge.'],
  computer: ['The installer needs Chrome or Edge', 'Open this page in Chrome or Edge.'],
};
function unavailable(kind = onChromeOS() ? 'chromeos' : noUsbKind(navigator)) {
  if (APP) return appUnavailable(kind);
  trackStep('no_webusb');
  state.screen = 'no_webusb';
  const [title, text] = NO_USB[kind];
  const copy = kind === 'computer' && !!navigator.clipboard?.writeText;
  const manual = `<div class="wp-block-button"><a class="wp-block-button__link no-border-radius${copy ? ' is-secondary' : ''}" href="${WRITTEN}"${writtenAttrs()}>Manual installation</a></div>`;
  root().innerHTML = `<section class="cec-card"><h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    <div class="cec-actions${copy ? ' cec-actions-pair' : ''}">${copy ? `
      <div class="wp-block-button"><button type="button" class="wp-block-button__link no-border-radius" id="cec-copy">Copy link</button></div>` : ''}
      ${manual}</div>
    <p class="cec-status" role="status" aria-live="polite" id="cec-status"></p></section>`;
  if (!copy) return;
  $('#cec-copy').onclick = async () => {
    trackStep('no_webusb_copy');
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      say('Link copied. Paste it into the address bar in Chrome or Edge.');
    } catch {
      say(`Copy this address into Chrome or Edge: ${location.origin + location.pathname}`);
    }
  };
}

// --- The app (the app feature) ----------------------------------------------
// The installer as a popup: on this page a small card opens it; on a page
// that loads this module beside its own sender (a game page, PlexMath: the
// generator writes a hidden #cec-shell with data-host), a click on any link
// to this page opens it in place instead. Inside: one golden path, one title,
// one sentence, one main button. Every screen still paints through paint()
// with its ce_step name and keeps the ids the logic above reads (#cec-go,
// #cec-next, #cec-keys, #cec-keys-row, #cec-open, #cec-auto-go, ...). Each view
// above hands over to its app twin first thing while APP is set. With the
// keys on, the page does the calculator's steps; the steps by hand show only
// where an automated step stopped.
const ICON = {
  check: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.8 10 11 4.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  done: '<svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="#e6f4ec"/><circle cx="28" cy="28" r="19" fill="#1e8a4f"/><path d="M19.5 28.5 25.5 34 36.5 22.5" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6v3.5M8 11.7v.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  hand: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-4.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.2 15a1.6 1.6 0 0 1 2.5-2L8 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l4.5 4.5v14.5H6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 2.5V7h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  game: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h5v-4h6v8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="16" r="1.6" fill="currentColor"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9-9 9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

// The page this module was loaded into to jailbreak on the spot: its name
// (data-host on #cec-shell, written by the generator), or '' on this page.
const HOST = setting('host', 'host', '');
// On a host page, the game the student was sending when CE Send asked for a
// jailbreak (its ce-jailbreak-for event): the last screen offers it in place
// of Snake. ?forgame=<label> on localhost.
let forGame = PREVIEW_HOST ? new URLSearchParams(location.search).get('forgame') : null;
// The game was sent already (a "Game didn't start?" button asked): send it again.
let forAgain = PREVIEW_HOST && new URLSearchParams(location.search).has('again');

// The main button, a quiet second action, a link styled as either, and the
// small disclosure for anything that explains.
const appBtn = (id, label, { disabled = false, big = false, alt = false } = {}) =>
  `<button type="button" class="cec-btn${big ? ' cec-btn-big' : ''}${alt ? ' cec-btn-alt' : ''}" id="${id}"${disabled ? ' disabled' : ''}>${label}</button>`;
const appLink = (href, label, { quiet = false, blank = false, big = false, alt = false } = {}) =>
  `<a class="${quiet ? 'cec-quiet' : `cec-btn${big ? ' cec-btn-big' : ''}${alt ? ' cec-btn-alt' : ''}`}" href="${href}"${blank ? ' target="_blank" rel="noopener nofollow"' : ''}>${label}</a>`;
const appQuiet = (id, label) => `<button type="button" class="cec-quiet" id="${id}">${label}</button>`;
const appMore = (summary, html) => `<details class="cec-more"><summary>${summary}</summary><div class="cec-more-body">${html}</div></details>`;
const appWarn = html => `<p class="cec-app-warn">${ICON.warn}<span>${html}</span></p>`;
// The tab's own title while "Your turn" stands in for it (appAutoRefresh).
let tabTitle = null;

// The way on once the jailbreak is in: more games, or back to the page that
// opened the popup (or the one that sent the student here, ?next=). `alt`:
// outlined, where the screen's main button is another (Run it for me, Send Snake).
const appOnward = ({ big = true, alt = false } = {}) => (HOST ? appBtn('cec-app-back', HOST === 'the games' ? 'See all games' : `Back to ${esc(HOST)}`, { big, alt })
  : BACK ? appLink(esc(BACK.href), `Go back to ${esc(BACK.name)}`, { big, alt })
  : appLink(GAMES, 'See all games', { big, alt }));
// The last line for both AsmHook2 routes. The way back on is the games
// pages' Turn it back on, which opens this popup at that step.
const APP_LASTS = '<p class="cec-app-hint">The jailbreak lasts until you reset your RAM. Come back to this page to turn it back on.</p>';
function wireOnward() {
  const back = $('#cec-app-back');
  if (back) back.onclick = () => appClose({ release: true });
}

// A screen's body. `top` is a picture over the title (the connection
// illustration, a done mark); `manual` is the by-hand half of a screen whose
// main button presses the keys, shown only once a press has failed (or
// always, with the keys off); `tail` comes after it.
function appScreen({ top = '', title, lead = '', actions = '', after = '', manual = '', tail = '', more = '', cls = '' }) {
  const keys = actions.includes('id="cec-keys-row"');
  return `<div class="cec-app-body${cls ? ` ${cls}` : ''}${keys && manual ? ' has-keys' : ''}">
    ${top}
    <h2>${title}</h2>
    ${lead ? `<p class="cec-sub">${lead}</p>` : ''}
    ${actions}
    ${after}
    ${manual ? `<div class="cec-app-manual">${manual}</div>` : ''}
    ${tail}
    ${more}
  </div>`;
}

// The "for me" button and its own lines (forMeClick writes into them). With
// no label, the lines only: a by-hand screen under the chain keeps them, so a
// stopped step can say why.
const appKeys = ({ label = '', hint = '', hidden = false }) => `
    <div class="cec-keys cec-app-keys" id="cec-keys-row"${hidden ? ' hidden' : ''}>
      ${label ? `<div class="cec-actions">${appBtn('cec-keys', label)}</div>` : ''}
      ${hint ? `<p class="cec-keys-lead">${hint}</p>` : ''}
      <p class="cec-status" role="status" aria-live="polite" id="cec-keys-note"></p>
      <div class="cec-error" role="alert" id="cec-keys-error" hidden></div>
    </div>`;

// A walk as the card has it: every step in a numbered list, the calculator
// screen beside it (in a dark bezel) following the step picked. A step or the
// picture moves it; the card's Back and Next stay in the markup for
// mountWalks, out of sight.
const appWalk = name => walk(name, { note: false }).replace('class="cec-walk"', 'class="cec-walk cec-app-walk"');


// The footer: Start over (not on the first step, where it would only show
// that step again, unless a failure there names it), the credits and Plexy's
// Help chat. One line on a laptop. "Didn't work?" sits in the screen itself
// (appFrame), under a failure and on the install and play steps.
const appFoot = () => `<div class="cec-foot">
    <button type="button" id="cec-restart"${state.busy ? ' disabled' : ''}${state.step === 0 ? ' hidden' : ''}>Start over</button>
    ${appCredits()}
  </div>`;
// The credits wherever the popup opens, at its bottom: the tutorial
// page's own list (data-credits on #cec-shell,
// written by the generator), each author's name and source link in view,
// the whole list one click away.
const CREDITS = (() => {
  try {
    return JSON.parse(document.getElementById('cec-shell')?.dataset.credits || '[]');
  } catch {
    return [];
  }
})();
// This installer's own source (GPL), the last line of the list.
const CELINK = 'https://github.com/calcplex/celink';
const creditLink = ([label, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${esc(label)}</a>`;
const appCredits = () => (CREDITS.length ? `<details class="cec-app-credits">
      <summary>Credits: ${CREDITS.filter(c => c.by).map(c => {
    const src = (c.links || []).find(([l]) => l === 'Source') || (c.links || [])[0];
    return `${src ? creditLink([c.name, src[1]]) : esc(c.name)} by ${esc(c.by)}`;
  }).join(', ')}</summary>
      <ul>${CREDITS.map(c => `<li><strong>${esc(c.name)}</strong>${esc(c.text ?? `, ${c.note ? `${c.note}, ` : ''}by ${c.by}${c.license ? `, ${c.license}` : ''}.`)}${(c.links || []).length ? ` ${c.links.map(creditLink).join(' &middot; ')}` : ''}</li>`).join('')}
        <li><strong>This installer</strong>, by CalcPlex. GPL. ${creditLink(['Source', CELINK])}</li></ul>
    </details>` : '');

// Four segments and their words. The segment on show fills halfway, or, while
// the v3 chain runs, as far as the chain has got. A last screen (jailbroken,
// a game ready, no jailbreak needed, already jailbroken) shows the bar full.
const appDone = () => /^(play|native|v21_found|back|v21_run)/.test(state.screen || '');
function appProgress() {
  // Updating to OS 5.4.0 is the native route's Install step, done once it is.
  const native = state.info?.route === 'native' && !/^os540_/.test(state.screen || '') && !state.os540Done;
  const done = appDone();
  const at = done ? STEPS.length - 1 : state.step;
  let fill = done ? 1 : 0.5;
  const segs = STEPS.map((label, i) => {
    const cls = native && i === 2 ? 'is-skipped' : done || i < at ? 'is-done' : i === at ? 'is-now' : '';
    return `<li class="${cls}"${i === at ? ` aria-current="step" style="--fill:${fill}"` : ''}><span>${label}</span></li>`;
  }).join('');
  return `<nav class="cec-progress cec-app-progress" aria-label="Progress"><ol>${segs}</ol>
    <p class="cec-app-steplabel">Step ${at + 1} of ${STEPS.length} <span aria-hidden="true">·</span> ${STEPS[at]}</p></nav>`;
}

// paint()'s frame. The status and error lines go where the screen marks them
// (data-status-spot), else under the row of actions marked data-status, else
// under the last row, else at the end. A screen's help link (Didn't work?,
// arTIfiCE didn't open?) has one fixed spot at the bottom of the content,
// its room kept when it is empty, so nothing moves when it shows.
function appFrame(body) {
  root().innerHTML = `<section class="cec-card cec-app" data-screen="${esc(state.screen)}">${appProgress()}
    <div class="cec-app-main">${keepKeyPunctuation(body)}<div class="cec-app-second"></div></div>
    <div class="cec-report" id="cec-report" hidden></div>
    ${appFoot()}</section>`;
  const card = root().querySelector('.cec-app');
  const main = card.querySelector('.cec-app-main');
  const status = document.createElement('p');
  Object.assign(status, { className: 'cec-status', id: 'cec-status' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = document.createElement('div');
  Object.assign(error, { className: 'cec-error', id: 'cec-error', hidden: true });
  error.setAttribute('role', 'alert');
  const spot = main.querySelector('[data-status-spot]');
  const rows = [...main.querySelectorAll('.cec-actions')].filter(r => !r.closest('.cec-keys'));
  const anchor = spot || main.querySelector('.cec-actions[data-status]') || rows[rows.length - 1];
  // "Didn't work?" right under the failure band; on the install and play
  // steps it shows without one too.
  const didnt = document.createElement('p');
  didnt.className = `cec-app-didnt${state.step >= 2 ? ' is-always' : ''}`;
  didnt.innerHTML = `<button type="button" id="cec-report-open"${state.busy ? ' disabled' : ''} aria-expanded="false" aria-controls="cec-report">Didn't work?</button>`;
  if (anchor) anchor.after(status, error);
  else (main.querySelector('.cec-app-body') || main).append(status, error);
  const second = main.querySelector('.cec-app-second');
  // The v2.1 Run screen's own link takes the spot; its fixes still open in
  // place, where the screen put them.
  const check = main.querySelector('.cec-check-link');
  if (check) {
    const fix = check.querySelector('.cec-check-fix');
    if (fix) check.before(fix);
    second.append(check);
  }
  second.append(didnt);
  $('#cec-restart').onclick = () => { if (!state.busy) appRestart(); };
  $('#cec-report-open').onclick = toggleReport;
  mountWalks();
  wireOnward();
  const heading = root().querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  painted = true;
  keyHelp?.refresh();
}

// A failure (or a line that points at the steps below) in a keys screen
// shows its by-hand half, where the way on is.
function appShowManual(el) {
  const body = el?.closest?.('.cec-app-body.has-keys');
  if (body) body.classList.add('is-manual');
}
// The by-hand half, shown (a preview's &manual=1).
function appManual() {
  root().querySelector('.cec-app-body.has-keys')?.classList.add('is-manual');
}

// One line under the title. TI Connect CE holding the calculator is a
// failure's line (open_failed), not a warning up front.
function appConnect() {
  const usb = !!navigator.usb;
  paint(appScreen({
    cls: 'cec-app-connect',
    top: `<div class="cec-app-hero"><img src="${ART}" alt="" width="280" height="112"></div>`,
    title: 'Connect your calculator',
    lead: 'Plug your TI-84 Plus CE into this computer and turn it on.',
    actions: `<div class="cec-actions" data-status>${appBtn('cec-go', 'Connect', { disabled: !usb, big: true })}</div>`,
    after: usb ? '<p class="cec-app-hint cec-app-pickline">In the list that opens, click your calculator, then Connect.</p>'
      : '<p class="cec-app-hint">Direct USB needs Chrome or Edge on a computer.</p>',
  }), 0, 'connect');
  if (!usb) return;
  wireConnect();
}

function appWinFix(kind) {
  const fix = WIN_FIX[kind];
  paint(appScreen({
    cls: 'cec-app-win',
    title: fix.heading,
    lead: fix.sub,
    actions: `<ol class="cec-app-steps">${fix.steps.map(step => `<li>${step}</li>`).join('')}</ol>
      <div class="cec-actions">${appBtn('cec-go', 'Connect')}</div>`,
  }), 0, `win_${kind}`);
  wireConnect();
}

// Before a route's install: a jailbreak already on the calculator skips it.
// v3: AsmHook2 among the apps (it only needs turning on). v2.1: program A
// that is arTIfiCE v2.1 byte for byte (its size, then its SHA-256 read back).
function appRoute() {
  const route = state.info.route;
  const next = {
    v21: ['Install the jailbreak', viewFilesV21],
    v3: ['Install the jailbreak', checkInequalz],
  }[route];
  const i = state.info;
  // The page presses the v3 keys only with the keys on (and in English).
  let auto = false;
  const found = `<p class="cec-app-found">${next ? ICON.check : ''}<span>${esc(modelLabel(i.model))}</span><span>OS ${esc(i.os)}</span></p>`;
  const action = next ? appBtn('cec-next', next[0], { big: true })
    : route === 'unknown' ? appBtn('cec-again', 'Connect again')
    : appLink(AUTHOR, 'See the versions it covers', { blank: true });
  paint(appScreen({
    top: found,
    title: ROUTES[route].heading,
    lead: next ? (route !== 'v3' ? '' : auto ? 'The page does every step for you.' : 'It takes a few steps on your calculator.')
      : route === 'unknown' ? 'Check the About screen on the calculator, then connect again.'
      : 'arTIfiCE\'s author lists every version it covers.',
    actions: `<div class="cec-actions">${action}</div>`,
    after: next && appByHandLanguage() ? '<p class="cec-app-hint">Your calculator isn\'t set to English, so the steps show which keys to press.</p>' : '',
  }), 1, `route_${route}`, { deadEnd: route === 'unknown' });
  if (next) $('#cec-next').onclick = next[1];
  const again = $('#cec-again');
  if (again) again.onclick = () => { if (!state.busy) location.reload(); };
  if (next && !state.jbLooked && !(PREVIEW_HOST && !transport.link)) {
    state.jbLooked = true;
    // After the Connect press that painted this screen has finished.
    setTimeout(function go() { if (state.busy) setTimeout(go, 50); else appLookForJailbreak(route); }, 0);
  }
}
// The keys are on for this page load, but the calculator's language keeps
// them off (forMe): the route screen says so, calmly.
function appByHandLanguage() {
  let off = false;
  return off;
}
// AsmHook2 among the apps (either route: it only needs turning on), else on
// v2.1 arTIfiCE's own A.
async function appLookForJailbreak(route) {
  let found = '';
  await work(async () => {
    say('Checking your calculator.');
    const rows = await transport.directory();
    state.apps = rows;
    if (rows.some(r => r.type === TYPE_FLASH_APP && /^asmhook2$/i.test(String(r.name).replace(/[\s\0]+$/, '')))) found = 'hook';
    else if (route === 'v21' && await hasArtificeA(rows)) found = 'a';
    say('');
  });
  if (!found || state.screen !== `route_${route}`) return;
  trackStep(`${route}_found`);
  if (found === 'hook') appHookFound();
  else appAFound();
}

// arTIfiCE v2.1 already on (it never needs installing twice): one calm
// screen, then how to start a game. With the AsmHook2 route on, adding
// AsmHook2 is offered first: games then start from prgm.
function appAFound() {
  let hook = false;
  paint(appScreen({
    top: `<div class="cec-app-done">${ICON.done}</div>`,
    title: 'Already jailbroken',
    lead: hook ? 'arTIfiCE is already on your calculator. Add AsmHook2 and games start from the prgm menu.' : 'arTIfiCE is already on your calculator.',
    actions: `<div class="cec-actions">${appBtn('cec-next', hook ? 'Add AsmHook2' : 'Show me how to play', { big: true })}${hook ? appQuiet('cec-keep', 'Keep it as it is') : ''}</div>`,
  }), 1, 'v21_found');
  $('#cec-next').onclick = () => { if (state.busy) return; if (hook) viewFilesV21(); else viewV21Run({ snake: false }); };
  const keep = $('#cec-keep');
  if (keep) keep.onclick = () => { if (!state.busy) appV21Run({ snake: false }); };
}
const TYPE_FLASH_APP = 0x24;
// arTIfiCE v2.1's program A, as the games pages know it (gamesend's
// JAILBREAKS): the name, a listed size of 904, then the bytes' SHA-256.
const ARTIFICE_A = { size: 904, sha256: 'a3d6b61efdc4352b945e78d67278a1975854d4f81070c8235e0abfcf21fcfd12' };
async function hasArtificeA(rows) {
  const row = rows.find(r => r.name === 'A' && (r.type === 0x05 || r.type === 0x06) && r.size === ARTIFICE_A.size);
  if (!row || !transport.link?.receive) return false;
  try {
    const { data } = await transport.link.receive(row.name, row.type);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return [...hash].map(b => b.toString(16).padStart(2, '0')).join('') === ARTIFICE_A.sha256;
  } catch {
    return false;
  }
}

// v3 with AsmHook2 already there: no reset, no reinstall; one press turns it
// on (it says Installation successful, clear takes it home), then Play.
function appHookFound() {
  let keys = false;
  // AsmHook2 there means the student wants it running: with the
  // keys, straight to the hands-off turn-on (the chain's panel over this
  // screen, which is the way on if it stops); by hand, the keys to press.
  paint(appScreen({
    title: 'Turn your jailbreak back on',
    lead: 'A RAM reset turns it off.',
    manual: `${appWalk('ce-jb-v3-turnon')}
      <div class="cec-actions">${appBtn('cec-next', 'Done', { big: true })}</div>`,
  }), 1, 'v3_found');
  $('#cec-next').onclick = viewPlay;
}

function appNative() {
  if (os540().landed()) return appOs540Done();
  if (HOST) return appStart({ title: 'No jailbreak needed', lead: `Games already run on OS ${esc(state.info.os)}.`, screen: 'native', step: 1 });
  paint(appScreen({
    title: ROUTES.native.heading,
    lead: `Games already run on OS ${esc(state.info.os)}.`,
    actions: `<div class="cec-actions" data-status>${appBtn(GAME.id, `Send ${GAME.label}`, { big: true })}</div>`,
    more: offersOs540(state.info.os) ? os540().link() : '',
  }), 1, 'native');
  wireSends();
  const tiplanet = $('#cec-os540-get');
  if (tiplanet) tiplanet.addEventListener('click', () => trackStep('native_os540'));
  if (offersOs540(state.info.os)) os540().wireLink();
}

// Connected again after this page sent OS 5.4.0: the update is the news, then
// the game. The screen stays 'native', so Send turns it into the game's last
// screen (appSent).
function appOs540Done() {
  const lead = `No jailbreak needed. Games start from the ${keyHelpHtml('cec')} menu.`;
  if (HOST) return appStart({ title: 'You\'re on OS 5.4.0', lead, screen: 'native', step: 1 });
  paint(appScreen({
    top: `<div class="cec-app-done">${ICON.done}</div>`,
    title: 'You\'re on OS 5.4.0',
    lead,
    actions: `<div class="cec-actions" data-status>${appBtn(GAME.id, `Send ${GAME.label}`, { big: true })}</div>`,
  }), 1, 'native');
  wireSends();
}

function appNoInequalz() {
  paint(appScreen({
    title: 'Install Inequality Graphing first',
    lead: 'arTIfiCE v3 installs through this TI app.',
    // One family of buttons: the next step's is filled, the others outlined,
    // and a step done is ticked.
    actions: `<ol class="cec-app-steps cec-app-steps-do" id="cec-ineq-steps">
        <li data-step="get"><span>Get the app from TI. The file ends in <code>.8ek</code>.</span><a id="cec-get-app" class="cec-btn cec-btn-step" href="${INEQUALZ_URL}" target="_blank" rel="noopener nofollow">Get it from TI</a></li>
        <li data-step="pick"><span id="cec-pick-text">Pick the file you downloaded.</span><label class="cec-btn cec-btn-alt cec-btn-step cec-app-file" id="cec-pick-app">Choose file<input type="file" id="cec-app" accept=".8ek"></label></li>
        <li data-step="send"><span>Send it to the calculator.</span></li>
      </ol>
      <div class="cec-actions">${appBtn('cec-send-app', 'Send the app', { disabled: true, big: true })}</div>`,
  }), 2, 'no_inequalz');
  state.pickedApp = null;
  // The next step: get (nothing done yet), pick (TI's page opened), send (a file picked).
  let next = 'get';
  const order = ['get', 'pick', 'send'];
  const mark = () => {
    $('#cec-ineq-steps')?.querySelectorAll('li').forEach(li => {
      li.classList.toggle('is-done', order.indexOf(li.dataset.step) < order.indexOf(next));
      li.classList.toggle('is-next', li.dataset.step === next);
    });
    $('#cec-get-app')?.classList.toggle('cec-btn-alt', next !== 'get');
    $('#cec-pick-app')?.classList.toggle('cec-btn-alt', next !== 'pick');
  };
  state.afterWork = () => {
    const b = $('#cec-send-app');
    if (b) b.disabled = !state.pickedApp;
    mark();
  };
  state.afterWork();
  $('#cec-get-app').addEventListener('click', () => { if (next === 'get') { next = 'pick'; mark(); } });
  // A file picked (the preview's no-inequalz-picked too).
  state.markInequalz = (step, name) => {
    next = step;
    $('#cec-pick-text').textContent = `${name} is picked.`;
    state.afterWork();
  };
  $('#cec-app').onchange = e => work(async () => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const app = parseFlashApp(bytes);
    state.pickedApp = bytes;
    state.markInequalz('send', app.name || file.name);
    say('');
  });
  $('#cec-send-app').onclick = () => work(async () => {
    const picked = state.pickedApp;
    if (!picked) throw refusal('NO_FILE', 'Choose the .8ek file first.');
    const sending = 'Sending the app. Leave the cable alone until it finishes.';
    say(sending);
    await tracked('TI_INEQUALZ', () => transport.sendApp(picked, {
      onProgress: (done, total) => say(total ? `${sending} ${Math.min(99, Math.round((done / total) * 100))}%` : sending),
    }));
    say(sending);
    await confirmInequalz('The app was sent but the calculator still does not list it. Check the apps menu yourself, then press Start over.');
  });
}

function appInequalzUnsure() {
  paint(appScreen({
    title: 'Check for Inequalz on the calculator',
    lead: 'Press <kbd>apps</kbd> on your calculator and look for Inequalz.',
    actions: `<div class="cec-actions">${appBtn('cec-next', 'Inequalz is on the calculator', { big: true })}${appQuiet('cec-recheck', 'Check again')}</div>`,
    more: appMore('Not there?', '<p><button type="button" class="cec-inline" id="cec-ineq-send">Send it from this page</button></p>'),
  }), 2, 'inequalz_unsure');
  $('#cec-next').onclick = viewV3Reset;
  $('#cec-recheck').onclick = () => work(() => confirmInequalz('The calculator still did not list its apps. Carry on from the apps menu if you can see Inequalz there.'));
  $('#cec-ineq-send').onclick = () => { if (!state.busy) viewNoInequalz(); };
}

const ARCHIVE_LINK = `<a href="${ARCHIVING}" target="_blank" rel="noopener nofollow">Archive</a>`;
// v3's RAM step. With the keys on (and the chain not yet running) it is the
// one screen before everything: what the page will do, the erase warning, one
// button. Under the chain, and with the keys off, it is the steps by hand.
function appV3Reset() {
  let keys = false;
  paint(appScreen({
    title: 'Clear the calculator\'s RAM',
    lead: 'arTIfiCE v3 needs a clear RAM.',
    after: appWarn(`Erases every program that is not archived. ${ARCHIVE_LINK} what you want to keep.`),
    manual: `${appWalk('ce-jb-reset-ram')}
      <div class="cec-actions">${appBtn('cec-next', 'The RAM is cleared', { big: true })}</div>`,
  }), 2, 'v3_reset');
  $('#cec-next').onclick = viewV3Installer;
}

// A files screen (filesScreen's twin): the same fetch, pins, fallback picker
// and gate; `actions` holds #cec-next (and #cec-only where it is offered).
function appFilesScreen({ files, tag, step, screen, title, lead = '', top = '', actions = '', after = '', manual = '', more = '', onSend, gate = null }) {
  paint(appScreen({
    top, title, lead, manual, more, after,
    actions: `${actions}
      <div id="cec-fallback" class="cec-app-fallback" hidden>
        <p>This file did not load from this site. Download it from the author's release page and pick it here.</p>
        <ul class="cec-files" id="cec-filelist">${files.map(f => `
          <li data-file="${esc(f.file)}"><span class="cec-name">${esc(f.file)}</span><span class="cec-state"></span></li>`).join('')}</ul>
        <p class="cec-app-fallback-row">${appLink(RELEASE(tag), `Open the ${esc(tag)} release page`, { quiet: true, blank: true })}
          <label class="cec-app-file">Choose the file<input type="file" id="cec-pick" accept=".8xp,.8xv"></label></p>
      </div>`,
  }), step, screen);
  state.screenFiles = files;
  state.gate = gate;
  state.afterWork = renderPicked;
  $('#cec-pick').onchange = e => work(async () => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parseVariable(bytes);
    const spec = await identifyOfficial(state.info.route, bytes);
    if (!spec || !files.some(f => f.file === spec.file)) {
      throw refusal('WRONG_FILE', `${file.name} is not the file this step needs. Download it again from the author's release page.`);
    }
    state.picked[spec.file] = { bytes, spec };
    say('');
  }).then(renderPicked);
  $('#cec-next').onclick = onSend;
  renderPicked();
  return fetchHosted(files);
}
// What a files screen sends, as cards.
const appFileCards = cards => `<div class="cec-app-files">${cards.map(([icon, name, what]) => `
    <div class="cec-app-filecard"><span class="cec-app-fileicon">${ICON[icon]}</span><span><b>${name}</b>${what ? `<small>${what}</small>` : ''}</span></div>`).join('')}</div>`;

function appFilesV21() {
  state.v21 = resumable([sendArtificeV21, () => sendGameTo(GAME)]);
  appFilesScreen({
    files: OFFICIAL.v21.files,
    tag: OFFICIAL.v21.tag,
    step: 2,
    screen: 'files_v21',
    top: appFileCards([['file', 'arTIfiCE v2.1', 'becomes program A'], ['game', 'Snake', 'a game to try']]),
    title: 'Send arTIfiCE v2.1 and Snake',
    actions: `<div class="cec-actions">${appBtn('cec-next', 'Send arTIfiCE and Snake', { disabled: true, big: true })}<button type="button" id="cec-only" class="cec-quiet cec-plain cec-alt" disabled>Send only arTIfiCE</button></div>`,
    onSend: sendV21,
  });
  $('#cec-only').onclick = sendV21Only;
}

function appV3Installer() {
  const fetched = appFilesScreen({
    files: [OFFICIAL.v3.files[0]],
    tag: OFFICIAL.v3.tag,
    step: 2,
    screen: 'v3_installer',
    top: appFileCards([['file', 'arTIfiCE', 'the installer']]),
    title: 'Send the installer program',
    actions: `<div class="cec-actions">${appBtn('cec-next', 'Send the installer', { disabled: true, big: true })}</div>`,
    onSend: sendV3Installer,
  });
}

function appV3Inequalz() {
  const trigger = OFFICIAL.v3.files[1];
  let keys = false;
  const fetched = appFilesScreen({
    files: [trigger],
    tag: OFFICIAL.v3.tag,
    step: 2,
    screen: 'v3_inequalz',
    title: 'Open Inequalz, then finish the install',
    manual: `${appWalk('ce-jb-v3-open-inequalz')}
      <div class="cec-actions"><label class="cec-confirm"><input type="checkbox" id="cec-open"> Inequalz is open on its Y= screen</label>${appBtn('cec-next', 'Finish the install', { disabled: true })}</div>`,
    more: appMore('What happens next?', '<p>The calculator restarts on its own when the install finishes.</p>'),
    onSend: sendV3Trigger,
    gate: () => !!$('#cec-open')?.checked,
  });
  $('#cec-open').onchange = renderPicked;
}

function appV3Finish() {
  let keys = false;
  paint(appScreen({
    title: 'Turn on the jailbreak',
    manual: `${appWalk('ce-jb-v3-asmhook')}
      <div class="cec-actions">${appBtn('cec-next', 'Done', { big: true })}</div>`,
  }), 2, 'v3_finish');
  $('#cec-next').onclick = viewPlay;
}

// How to start a game, as keys, for the route and OS: the one way the
// last screen teaches.
function appStartLines(name) {
  const os = String(state.info?.os || '');
  const route = state.info?.route;
  // AsmHook2 switched on (the AsmHook2 route, or Turn it on): games from prgm.
  if (route === 'v21' && state.hookOn) return [`Press <kbd>prgm</kbd>, pick ${name}, then press <kbd>enter</kbd> twice.`];
  if (route === 'v21') return ['Press <kbd>prgm</kbd>, pick A, then press <kbd>enter</kbd> twice.', `Pick ${name} and press <kbd>enter</kbd>.`];
  if (route === 'native' && needsAsm(os)) return ['Press <kbd>2nd</kbd> <kbd>0</kbd>, pick Asm( and press <kbd>enter</kbd>.', `Press <kbd>prgm</kbd>, pick ${name}, then press <kbd>enter</kbd> twice.`];
  return [`Press <kbd>prgm</kbd>, pick ${name}, then press <kbd>enter</kbd> twice.`];
}
// The first prgm is the key help (a picture of the key on hover or click).
const appStartList = name => `<ol class="cec-app-start">${appStartLines(name).map(l => `<li>${l}</li>`).join('').replace('<kbd>prgm</kbd>', keyHelpHtml('cec'))}</ol>
    <p class="cec-app-hint">On a Python edition, <kbd>prgm</kbd> first asks TI-Basic or Python. Pick TI-Basic.</p>`;
// The last screen: how to start a game, and the way on. `send` is the Snake
// row a screen shows above it when no game is on the calculator yet.
function appStart({ title = 'Your calculator is jailbroken', lead = '', screen, step = 3, name = 'your game', keys = '', send = '', tail = '' }) {
  state.jailbroken = true;
  paint(appScreen({
    top: `<div class="cec-app-done">${ICON.done}</div>`,
    title,
    lead,
    actions: `${send}${appStartList(name)}${keys}<div class="cec-actions cec-app-onward">${appOnward()}</div>`,
    tail,
  }), step, screen);
}
// After Snake goes on the Play or native screen: that screen becomes the last one.
function appSent() {
  const screen = root().querySelector('.cec-app')?.dataset.screen;
  if (screen !== 'play' && screen !== 'native') return;
  const body = root().querySelector('.cec-app-body');
  if (!body) return;
  body.innerHTML = `<div class="cec-app-done">${ICON.done}</div><h2 tabindex="-1">${GAME.label} is ready to play</h2>
    <p class="cec-sub">To start it:</p>
    ${keepKeyPunctuation(appStartList('SNAKE'))}
    <div class="cec-actions cec-app-onward">${appOnward()}</div>
    ${state.info?.route === 'v3' || state.hookOn ? APP_LASTS : ''}`;
  body.querySelector('h2').focus({ preventScroll: true });
  wireOnward();
  say('');
}

function appPlay() {
  let home = false;
  state.jailbroken = true;
  // Both AsmHook2 routes: what to do after a RAM reset.
  const tail = state.info?.route === 'v3' || state.hookOn ? APP_LASTS : '';
  // A host page: its own game (the one the student was sending), sent by the
  // page itself once the popup lets the calculator go; or back to the page.
  if (HOST) {
    paint(appScreen({
      top: home ? `<div class="cec-app-done">${ICON.done}</div>` : '',
      title: 'Your calculator is jailbroken',
      lead: `${forGame && forAgain ? `Start ${esc(forGame)} from prgm now, or send it again.` : forGame ? `You can put ${esc(forGame)} on it now.` : 'You can put a game on it now.'}${home ? '' : ' Press <kbd>clear</kbd> until the home screen shows first.'}`,
      actions: `<div class="cec-actions cec-app-onward">${forGame ? appBtn('cec-app-sendfor', `Send ${esc(forGame)}${forAgain ? ' again' : ''}`, { big: true }) : ''}${appOnward({ alt: !!forGame })}</div>`,
      tail,
    }), 3, 'play');
    const send = $('#cec-app-sendfor');
    if (send) send.onclick = () => appClose({ release: true, send: true });
    return;
  }
  paint(appScreen({
    top: home ? `<div class="cec-app-done">${ICON.done}</div>` : '',
    title: 'Your calculator is jailbroken',
    lead: 'You can put a game on it now.',
    actions: `${appPlayNext(home)}<div class="cec-actions" data-status>${appBtn(GAME.id, `Send ${GAME.label}`, { big: true })}${appOnward({ alt: true })}</div>`,
    tail,
  }), 3, 'play');
  wireSends();
}
// What to do before Send, in the screen's words: the home screen first, and
// after the restart, the second pick in the device list (it reads as part of
// the step, not a status line).
function appPlayNext(home) {
  const repick = transport.poisoned && !playLink;
  const send = `click Send ${GAME.label}`;
  const text = !home && repick ? `Press <kbd>clear</kbd> until the home screen shows. Then ${send} and pick your calculator in the list again.`
    : !home ? `Press <kbd>clear</kbd> until the home screen shows, then ${send}.`
    : repick ? `Your calculator restarted, so ${send} and pick it in the list again.` : '';
  return text ? `<p class="cec-app-next">${text}</p>` : '';
}

// v2.1's last screen: how to start a game (A, then the game), with Run it for
// me where the keys are on. A Snake row first when no game went with A.
function appV21Run({ snake, only = false }) {
  if (BACK) return viewBack('arTIfiCE is on the calculator as program A.');
  state.jailbroken = true;
  let keys = false;
  let check = '';
  check = RUN_CHECK ? checkBlock('plain') : '';
  const game = snake ? GAME.name : HOST ? 'your game' : 'a game';
  paint(appScreen({
    // The done mark once a game is on (or the host page sends one).
    top: snake || HOST ? `<div class="cec-app-done">${ICON.done}</div>` : '',
    title: snake ? `${GAME.label} is ready to play` : 'Your calculator is jailbroken',
    lead: snake ? 'To start it:' : HOST ? 'arTIfiCE is on your calculator. Close this and send your game.' : 'You can put a game on it now.',
    actions: `${snake || HOST ? '' : `<div class="cec-actions" data-status>${appBtn(GAME.id, `Send ${GAME.label}`)}</div>`}
      ${appStartList(game)}
      ${keys ? appRunKeys(!snake) : ''}
      <div class="cec-actions cec-app-onward">${appOnward({ alt: keys || !(snake || HOST) })}</div>`,
    // The pictures only where Run it for me stopped: the start lines say the same keys.
    manual: keys ? appWalk('ce-jb-v21-run') : '',
    tail: check,
  }), 3, runScreen({ snake, only }));
  if (!snake && !HOST) wireSends();
  if (RUN_CHECK) wireCheck('plain');
}
// The Run screen's keys row; hidden until a game is on (sendGameButton shows it).
function appRunKeys(hidden) {
  let html = '';
  return html;
}

function appBack(lead) {
  paint(appScreen({
    top: `<div class="cec-app-done">${ICON.done}</div>`,
    title: 'Your calculator is jailbroken',
    lead,
    actions: BACK ? `<div class="cec-actions">${appLink(esc(BACK.href), `Go back to ${esc(BACK.name)}`, { big: true })}</div>` : '',
  }), 3, 'back');
}

function appUnavailable(kind) {
  trackStep('no_webusb');
  state.screen = 'no_webusb';
  const [title, text] = NO_USB[kind];
  const copy = kind === 'computer' && !!navigator.clipboard?.writeText;
  // The popup's one size; with Copy link the main button, Do it by hand is
  // the help link in its usual spot.
  const byHand = appLink(WRITTEN, 'Do it by hand', { quiet: copy });
  root().innerHTML = `<section class="cec-card cec-app" data-screen="no_webusb"><div class="cec-app-main"><div class="cec-app-body">
    <div class="cec-app-hero"><img src="${ART}" alt="" width="280" height="112"></div>
    <h2 tabindex="-1">${esc(title)}</h2>
    <p class="cec-sub">${esc(text)}</p>
    <div class="cec-actions">${copy ? appBtn('cec-copy', 'Copy link', { big: true }) : byHand}</div>
    <p class="cec-status" role="status" aria-live="polite" id="cec-status"></p></div>
    <div class="cec-app-second">${copy ? `<p>${byHand}</p>` : ''}</div></div>
    <div class="cec-foot">${appCredits()}</div></section>`;
  if (!copy) return;
  $('#cec-copy').onclick = async () => {
    trackStep('no_webusb_copy');
    try {
      await navigator.clipboard.writeText(location.origin + '/ti84plusce-jailbreak-tutorial/');
      say('Link copied. Paste it into the address bar in Chrome or Edge.');
    } catch {
      say(`Copy this address into Chrome or Edge: ${location.origin}/ti84plusce-jailbreak-tutorial/`);
    }
  };
}

// --- The popup ----------------------------------------------------------------
// #cec moves into a <dialog> inside #cec-shell (so every app style still
// applies). On this page a card opens it; on a host page, a click on a link to
// this page does (the link still works where this module never loads). The
// first screen paints on the first open, so `connect` counts students who
// opened it (ce_step app_open counts the opens).
let dialog = null, appFirst = null, appOpened = false, appRootEl = null;
// A host page's #cec back into the popup.
function appAttach() {
  if (appRootEl && dialog) { dialog.append(appRootEl); appRootEl = null; }
}
function appBoot() {
  const shell = $('#cec-shell');
  if (!shell) return;
  shell.dataset.app = 'on';
  const cec = root();
  cec.innerHTML = '';
  dialog = document.createElement('dialog');
  dialog.className = 'cec-dialog';
  dialog.setAttribute('aria-label', 'Jailbreak your calculator');
  dialog.innerHTML = `<button type="button" class="cec-dialog-x" aria-label="Close">${ICON.close}</button>`;
  cec.before(dialog);
  dialog.append(cec);
  if (HOST) { appRootEl = cec; cec.remove(); }
  dialog.querySelector('.cec-dialog-x').onclick = () => appClose();
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    // Escape in Plexy's panel tucks Plexy away; it never closes the popup.
    if (document.activeElement?.closest?.(PLEXY)) return;
    appClose();
  });
  appPlexy();
  if (HOST) {
    document.addEventListener('ce-jailbreak-for', e => {
      forGame = String(e.detail?.label || '') || null;
      forAgain = !!e.detail?.again;
    });
    document.addEventListener('click', e => {
      const a = e.target?.closest?.('a[href]');
      if (!a || dialog.contains(a)) return;
      let url = null;
      try { url = new URL(a.getAttribute('href'), location.href); } catch { return; }
      if (url.origin !== location.origin || url.pathname !== '/ti84plusce-jailbreak-tutorial/' || url.hash) return;
      e.preventDefault();
      // After the page's own handlers (a prompt closing on this click).
      setTimeout(appOpen, 0);
    }, true);
    appReopen();
    return;
  }
  shell.insertAdjacentHTML('afterbegin', `<section class="cec-launch">
    <img class="cec-launch-art" src="${ART}" alt="" width="280" height="112">
    <div class="cec-launch-text"><p class="cec-launch-eyebrow">Installer</p><p class="cec-launch-title">Jailbreak your calculator in the browser</p>
      <p class="cec-launch-sub">Plug in your TI-84 Plus CE. This page picks the right jailbreak and installs it.</p></div>
    ${appBtn('cec-launch', 'Start', { big: true })}</section>`);
  $('#cec-launch').onclick = appOpen;
  appReopen();
}
// After Start over (appRestart), straight back into the popup.
function appReopen() {
  let again = false;
  try { again = !!sessionStorage.getItem('cec-reopen'); sessionStorage.removeItem('cec-reopen'); } catch { /* no storage */ }
  if (again && !(PREVIEW_HOST && new URLSearchParams(location.search).has('screen'))) setTimeout(appOpen, 0);
}
function appOpen() {
  if (!dialog) return;
  appAttach();
  if (!appOpened) {
    appOpened = true;
    trackStep('app_open');
    appFirst?.();
  } else if (!dialog.open) {
    // Every fresh open starts at step 1 (a closed popup never runs
    // a step, so nothing is cut short). Within one open, nothing restarts.
    appFresh();
    trackStep('app_reopen');
    appFirst?.();
  }
  if (!dialog.open) {
    dialog.showModal();
    appFloat(true);
    // The screen's heading, not the close button, takes the focus.
    root()?.querySelector('h2')?.focus({ preventScroll: true });
  }
}
// Back to before the first screen: the links let go (the quiet connect or
// Connect makes a new one), and every step's state cleared. Per-page-load
// counters (reported, answered, keyTries) stay, so nothing counts twice.
function appFresh() {
  for (const l of [transport.link, playLink]) if (l) l.close().catch(() => {});
  Object.assign(transport, { link: null, info: null, poisoned: false });
  playLink = null;
  handoff.held(false);
  Object.assign(state, {
    step: 0, info: null, picked: {}, screenFiles: [], pickedApp: null, gate: null, afterWork: null, v21: null, deadEnd: false, screen: '',
    jailbroken: false, marked: false, hookOn: false, homeConfirmed: false, quietTried: false, jbLooked: false, lastKeys: null,
  });
}
// Closing keeps where the student is (the card opens it there again), except
// while the page is working on the calculator. `release` (Back to the host
// page) lets go of the calculator so that page can connect.
// On a host page, once the calculator is jailbroken, any close lets it go
// and tells the page (cec-jailbroken, { send }: CE Send connects again and,
// with `send`, sends the game it was sending), after the links have closed.
function appClose({ release = false, send = false } = {}) {
  if (!dialog) return;
  let running = state.busy;
  if (running) {
    say('Wait until this step finishes. Leave the calculator plugged in.');
    return;
  }
  // Also when the popup had the calculator (the quiet connect took it from the page).
  const tell = HOST && (state.jailbroken || !!transport.link);
  if (release || tell) {
    const closing = [transport.link, playLink].filter(Boolean).map(l => l.close().catch(() => {}));
    if (transport.link) transport.poisoned = true;
    playLink = null;
    handoff.held(false);
    if (tell) {
      trackStep(send ? 'app_host_send' : 'app_host_back');
      Promise.all(closing).then(() => document.dispatchEvent(new CustomEvent('cec-jailbroken', { detail: { send } })));
    }
    // The next open is told its game again, if any (CE Send's prompt or help button).
    forGame = null;
    forAgain = false;
  }
  dialog.close();
  appFloat(false);
  if (HOST) { appRootEl = root(); appRootEl?.remove(); }
}

// Plexy's panel and pill, and the prgm key's picture, are added to the end of
// <body>. A modal dialog leaves everything outside it inert and under it, so
// while the popup is open they live inside it (above its content: their own
// fixed position and z-index), and go back when it closes. Plexy still reads
// this page (#cec is in it, the installer's ce_step events reach it).
const PLEXY = '.hp-panel, .hp-pill';
const FLOATERS = `${PLEXY}, #cec-keyhelp-pop`;
function appFloat(into) {
  if (!dialog) return;
  for (const el of document.querySelectorAll(FLOATERS)) {
    if (into && el.parentElement !== dialog) {
      dialog.append(el);
      // Plexy focused its box while it was still outside (inert): again, now it can take it.
      if (el.matches('.hp-panel') && !el.hidden && !el.contains(document.activeElement)) el.querySelector('textarea')?.focus();
    }
    if (!into && el.parentElement === dialog) document.body.append(el);
  }
}
function appPlexy() {
  // Anything Plexy opens while the popup is open comes inside it.
  new MutationObserver(() => { if (dialog?.open) appFloat(true); }).observe(document.body, { childList: true });
  // Plexy closed with its X: the popup's heading takes the focus back.
  new MutationObserver(() => {
    const panel = dialog?.querySelector('.hp-panel'), pill = dialog?.querySelector('.hp-pill');
    if (!dialog?.open || !panel || !panel.hidden || (pill && !pill.hidden)) return;
    if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest?.(PLEXY)) {
      root()?.querySelector('h2')?.focus({ preventScroll: true });
    }
  }).observe(dialog, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
// Start over: the page reloads (every link and state starts clean) and the
// popup opens again on Connect.
function appRestart() {
  try { sessionStorage.setItem('cec-reopen', '1'); } catch { /* the card opens it */ }
  location.reload();
}
// The first screen, painted on the first open.
const appFirstScreen = fn => { appFirst = fn; };
// --- The manual installation under the wizard ------------------------------
// The page's own HTML (#jbg) holds every route and every step, readable with
// no script at all. Here each walk list (<ol class="jbg-walk" data-walk>)
// becomes this wizard's stepped picture viewer for that walk (the list reads
// exactly like WALKS[name]), and the OS picker
// shows one route at a time (its button again closes it). An address ending
// #os-<route> picks that route, which is where the wizard's Manual installation
// link points once it knows the calculator's route. There is no route for versions after 5.8.5 (none
// exists); a calculator that reports one gets the wizard's own screen, and its
// Manual installation link goes to the section.
// The section is a <details>, closed until the reader opens it, a link on the
// page (the wizard's) jumps into it, or the address names it. ce_step counts
// it once per page load: manual_open, and manual_<route> for each route shown
// (the existing screen and route parameters).
// The page splits the wizard's native route in two, since their steps differ
// completely: asm (5.2 or earlier, start with Asm() and native (5.3 and 5.4,
// start from prgm).
const GUIDE_ROUTES = ['asm', 'native', 'v21', 'v3'];
const guideRoute = info => (info?.route === 'native' && needsAsm(String(info.os)) ? 'asm' : info?.route);
function manualHref() {
  const route = guideRoute(state.info);
  return WRITTEN.startsWith('#') && GUIDE_ROUTES.includes(route) ? `#os-${route}` : WRITTEN;
}
function mountGuide() {
  const guide = $('#jbg');
  if (!guide) return;
  guide.querySelectorAll('ol.jbg-walk[data-walk]').forEach(ol => {
    if (WALKS[ol.dataset.walk]) ol.outerHTML = keepKeyPunctuation(walk(ol.dataset.walk, { note: false }));
  });
  mountWalks(guide, { lazy: true });
  const manual = guide.querySelector('details#manual');
  const toManual = hash => hash === '#manual' || /^#os-/.test(hash);
  if (manual) {
    manual.addEventListener('toggle', () => { if (manual.open) trackStep('manual_open'); });
    // Opened before the browser follows the link, so it can scroll to what is inside.
    document.addEventListener('click', e => {
      const a = e.target?.closest?.('a[href^="#"]');
      if (a && toManual(a.getAttribute('href'))) manual.open = true;
    }, true);
    window.addEventListener('hashchange', () => { if (toManual(location.hash)) manual.open = true; });
    if (toManual(location.hash)) {
      manual.open = true;
      if (location.hash === '#manual') manual.scrollIntoView({ block: 'start' });
    }
  }
  const picker = guide.querySelector('.jbg-picker');
  const panels = [...guide.querySelectorAll('.jbg-route')];
  if (!picker || !panels.length) return;
  const hint = guide.querySelector('.jbg-hint');
  const buttons = [...picker.querySelectorAll('button[data-route]')];
  const hashRoute = () => {
    const route = (/^#os-([a-z0-9]+)$/.exec(location.hash) || [])[1];
    return GUIDE_ROUTES.includes(route) ? route : null;
  };
  const pick = route => {
    buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.route === route)));
    panels.forEach(p => { p.hidden = p.dataset.route !== route; });
    if (hint) hint.hidden = !!route;
    if (route) trackStep(`manual_${route}`);
  };
  // The heading above the picker (the Find your OS version toggle sits between
  // them), so the reader sees what the buttons are for.
  let heading = picker.previousElementSibling;
  while (heading && heading.tagName !== 'H3') heading = heading.previousElementSibling;
  const reveal = () => (heading || picker).scrollIntoView({ block: 'start' });
  // Pressing the open route's button again closes it,
  // and the address drops its #os- so a reload doesn't reopen it.
  buttons.forEach(b => {
    b.onclick = () => {
      const route = b.getAttribute('aria-pressed') === 'true' ? null : b.dataset.route;
      pick(route);
      history.replaceState(null, '', route ? `#os-${route}` : location.pathname + location.search);
    };
  });
  window.addEventListener('hashchange', () => {
    const route = hashRoute();
    if (!route) return;
    pick(route);
    reveal();
  });
  picker.hidden = false;
  pick(hashRoute());
  if (hashRoute()) reveal();
}

// On localhost only: paint any screen from a made-up OS version, so every
// screen can be looked at without a calculator. Nothing here sends.
//   ?screen=<name>  one screen (PREVIEW_SCREENS)   &picked=1  files in hand
//   &error=<text>   the error band                 &fail=<code>  a library error's band (PICKER: the device list failed)
//   &win=1, &cros=1 Windows or Chrome OS wording
const PREVIEW_SCREENS = {
  connect: ['5.8.5', viewConnect],
  'win-install': ['5.8.5', () => viewWinFix('install')],
  'win-nodevice': ['5.8.5', () => viewWinFix('nodevice')],
  'win-security': ['5.8.5', () => viewWinFix('security')],
  'no-webusb': ['5.8.5', () => unavailable('computer')],
  'no-webusb-mobile': ['5.8.5', () => unavailable('mobile')],
  'native-52': ['5.2.2.0043', viewNative],
  'route-v21': ['5.8.4.0058', viewRoute],
  'route-v3': ['5.8.5', viewRoute],
  'route-unsupported': ['5.9.0.0000', viewRoute],
  'route-unknown': ['nonsense', viewRoute],
  native: ['5.3.0.0037', viewNative],
  'native-50': ['5.0.0.0089', viewNative],
  'files-v21': ['5.8.4.0058', viewFilesV21],
  'v21-run': ['5.8.4.0058', () => viewV21Run({ snake: true })],
  'v21-run-nosnake': ['5.8.4.0058', () => viewV21Run({ snake: false })],
  'no-inequalz': ['5.8.5', viewNoInequalz],
  'inequalz-unsure': ['5.8.5', viewInequalzUnsure],
  'v3-reset': ['5.8.5', viewV3Reset],
  'v3-installer': ['5.8.5', viewV3Installer],
  'v3-inequalz': ['5.8.5', viewV3Inequalz],
  'v3-finish': ['5.8.5', viewV3Finish],
  'play-v3': ['5.8.5', viewPlay],
  // App states with no screen of their own: the device list open over
  // Connect, the wait for the restart, Play once Snake went.
  'connect-picking': ['5.8.5', () => { viewConnect(); say('Pick your calculator in the browser window that opens.'); }],
  'play-v3-sent': ['5.8.5', () => { viewPlay(); appSent(); }],
  'play-v3-restarted': ['5.8.5', () => { transport.poisoned = true; viewPlay(); }],
  'native-sent': ['5.3.0.0037', () => { viewNative(); appSent(); }],
  'v21-found': ['5.8.4.0058', appAFound],
  'v3-found': ['5.8.5', appHookFound],
  'no-inequalz-picked': ['5.8.5', () => { viewNoInequalz(); state.pickedApp = new Uint8Array(1); state.markInequalz('send', 'Inequalz'); }],
  // Updating to OS 5.4.0 (os540.mjs), screen by screen; nothing is sent.
  'os540-get': ['5.2.2.0043', () => os540().start()],
  'os540-sent': ['5.2.2.0043', () => os540().sent()],
  'os540-waiting': ['5.2.2.0043', () => os540().waiting()],
  'os540-done': ['5.4.0.0034', () => { state.os540Done = true; viewNative(); }],
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
  window.__cecPreviewError = message => { fail(refusal('PREVIEW', message)); showBand(); };
  // CALC_ERROR_<decimal> is a calculator refusal with that code; PICKER is a
  // device list that failed to open.
  window.__cecPreviewFail = code => {
    const n = /^CALC_ERROR_(\d+)$/.exec(code);
    if (code === 'PICKER') fail(markPicker(new CELinkError('USB_ERROR', 'The browser could not show the device list: previewed.')));
    else fail(n ? new CELinkError('CALC_ERROR', 'A previewed refusal.', { calcError: Number(n[1]) }) : refusal(code, code));
    showBand();
  };
  window.__cecPreviewWindows = on => { forceWindows = !!on; };
  const q = new URLSearchParams(location.search);
  if (q.get('win')) forceWindows = true;
  if (q.get('cros')) forceChromeOS = true;
  const want = q.get('screen');
  if (want && PREVIEW_SCREENS[want]) {
    if (APP) appAttach();
    window.__cecPreview(want);
    if (q.get('picked')) window.__cecPreviewPicked();
    if (q.get('error')) window.__cecPreviewError(q.get('error'));
    if (q.get('fail')) window.__cecPreviewFail(q.get('fail'));
    // The popup, open on the screen; &manual=1 the by-hand half, &report=1
    // Didn't work? open, &check=yes|no an answer, &host=<name> a host page.
    if (APP) { appOpened = true; if (dialog && !dialog.open) dialog.showModal(); root()?.querySelector('h2')?.focus({ preventScroll: true }); }
    if (q.get('manual')) appManual();
    if (q.get('report')) toggleReport();
    if (q.get('check')) document.querySelector(`#cec-check [data-answer="${q.get('check')}"]`)?.click();
    return true;
  }
  return false;
}

function boot() {
  // The manual installation needs no USB, so it comes before every check.
  mountGuide();
  // A host page writes no #cec (Plexy's panel reads #cec as "this is the
  // installer"): the popup makes it, and keeps it in the page only while open.
  if (APP && HOST && !root() && $('#cec-shell')) $('#cec-shell').append(Object.assign(document.createElement('div'), { id: 'cec' }));
  if (!root()) return;
  if (APP) appBoot();
  else if ($('#cec-shell')?.dataset.app) $('#cec-shell').dataset.app = 'off';
  // First, so previews have it too.
  keyHelp = mountKeyHelp('cec', { onOpen: () => track('ce_key_help', { page: 'installer' }) });
  // Before the WebUSB check: a preview may load in a frame, which has no WebUSB.
  if (installPreview()) return;
  if (APP && !navigator.usb) { appFirstScreen(() => unavailable()); return; }
  if (!navigator.usb) {
    unavailable();
    return;
  }
  // Release the calculator on leaving, so the games hub in the same tab can open it.
  window.addEventListener('pagehide', () => {
    for (const l of [transport.link, playLink]) if (l) l.close().catch(() => {});
    handoff.held(false);
  });
  navigator.usb.addEventListener('disconnect', e => {
    if (e.device === transport.device && !transport.poisoned) {
      transport.poisoned = true;
      lost('The calculator was unplugged. Plug it back in.');
    }
    handoff.held(holds());
  });
  if (APP) { appFirstScreen(viewConnect); return; }
  viewConnect();
}

boot();
