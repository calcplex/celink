// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// "Send to calculator" on the TI-84 Plus CE download pages:
//   the games hub  a connect panel above the cards, and a split button on each
//                  card (Send to calculator, with Download file under the arrow)
//   a game page    one card under the download button: Connect, then Send
//   the math page  the hub's layout; the programs are TI-Basic, so no jailbreak
// Without WebUSB, or on a phone, the page keeps its download buttons only.
import { PROGRAMS, sendGame, collectEntries, isAssembly, inspect, jailbreakState, unpackZip, pickCalculator } from './gamesend.mjs';
import {
  PREVIEW_HOST, TICONNECT_URL, calcParams, esc, failReason, isChromeOS, isWindows, linkDead, refusal, refusalText,
  startHint, track, trackConnectFail,
} from './core.mjs';
import { CELink } from '../celink.mjs';

const INSTALLER = '/ti84plusce-jailbreak-installer/';
const HUB = '/downloads/ti84plusce/games/';
const MATH = '/downloads/ti84plusce/math/';

// ?win=1 and ?cros=1 preview the Windows and Chrome OS wording on localhost.
const WIN = isWindows(navigator) || (PREVIEW_HOST && /[?&]win=1\b/.test(location.search));
const CROS = isChromeOS(navigator) || (PREVIEW_HOST && /[?&]cros=1\b/.test(location.search));

const shortOs = os => String(os).split('.').slice(0, 3).join('.');
const jailbreakLink = text => `<a href="${INSTALLER}">${text}</a>`;

// Their licenses travel with the game, which a direct send skips, so Send
// unlocks only after the download.
const READ_FIRST = link => `This game's author asked for the license and readme to come with the game. ${link('Download it')}, read them, then click Send to calculator again.`;
const DOWNLOAD_FIRST = {
  '/downloads/ce/Geometry Dash.zip': READ_FIRST,
  '/downloads/ce/FALLDOWN.zip': READ_FIRST,
};

// Download links painted here keep the page's vignette opt-out.
const downloadLinkAttrs = () =>
  (document.querySelector('a[href^="/downloads/ce/"][data-google-vignette="false"]') ? ' data-google-vignette="false"' : '');
const decodedHref = a => {
  try { return decodeURI(a.getAttribute('href')); } catch { return a.getAttribute('href'); }
};

const downloaded = new Set();
function markDownloaded(file) {
  downloaded.add(file);
  try { sessionStorage.setItem('ce-send-dl:' + file, '1'); } catch { /* private mode */ }
}
function wasDownloaded(file) {
  if (downloaded.has(file)) return true;
  try { return sessionStorage.getItem('ce-send-dl:' + file) === '1'; } catch { return false; }
}
function watchDownloads(root) {
  root.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="/downloads/ce/"]');
    if (a) markDownloaded(decodedHref(a));
  });
}

async function gameFiles(file, label) {
  const response = await fetch(file);
  if (!response.ok) throw refusal('FETCH', `Couldn't get ${label} from this site. Try again in a moment.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return /\.zip$/i.test(file) ? unpackZip(bytes) : [bytes];
}

const LOST_TEXT = 'The calculator stopped responding. Unplug it, plug it back in, and try again.';
const OUTCOME_TEXT = {
  no_device: "No calculator was picked. Make sure it's plugged in and turned on, then try again. Not in the list? Try a different USB cable; charge-only cables won't work.",
  open_failed: "Couldn't connect. Close anything else using the calculator (like TI Connect CE or another tab), unplug it and plug it back in, then try again.",
  link_lost: LOST_TEXT,
  timeout: LOST_TEXT,
  calc_busy: 'The calculator is busy. Press clear a few times to get back to the home screen, then try again.',
};
const WINDOWS_TEXT = {
  no_device: 'Calculator not in the list? On Windows it only shows up once TI Connect CE is installed. If it is, make sure the calculator is on, then try again.',
};
const CHROMEOS_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then try again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};

function errorText(err) {
  const reason = failReason(err);
  let text = (WIN && WINDOWS_TEXT[reason]) || (CROS && CHROMEOS_TEXT[reason]) || OUTCOME_TEXT[reason] || refusalText(err) || err?.message || String(err);
  if (err?.partial?.length || err?.removed?.length) text += ' Press Send again to finish.';
  // The engine says "game"; on the math page the thing is a program.
  return page === 'math' ? text.replace(/\bgame\b/g, 'program') : text;
}

// One link per page, opened on the first click that needs it, or on load when
// the browser already allowed a plugged-in calculator on this site.
let page = 'game';
let link = null, calc = null;
let busy = false, connecting = false, present = false, sendAnyway = false;
const listeners = new Set();
const changed = () => listeners.forEach(f => f());

async function refreshPresent() {
  try {
    present = (await CELink.granted()).length > 0;
  } catch {
    present = false;
  }
  if (present && !link && !busy && !connecting) {
    connecting = true;
    changed();
    try { await connect(() => {}, { quiet: true }); } catch { /* leaves the Connect button */ }
    connecting = false;
  }
  changed();
}

// `quiet` is the automatic connect on load: no TI Connect CE question and no
// ce_connect_fail event.
async function connect(say, { quiet = false } = {}) {
  if (link) return calc;
  if (!quiet && !(await askTIConnect())) throw refusal('CANCELLED', 'The TI Connect CE question was dismissed.');
  say(present ? 'Connecting to your calculator…' : 'Select your calculator in the popup…');
  let l;
  try {
    l = await pickCalculator();
    await l.open();
    calc = await inspect(l);
  } catch (err) {
    if (l) await l.close().catch(() => {});
    calc = null;
    if (!quiet) trackConnectFail(err, { page });
    throw err;
  }
  link = l;
  track('ce_calc_info', { ...calcParams(calc), route: calc.route, page });
  refreshPresent();
  return calc;
}

// A Connect button: connect, and hand any failure but a dismissed question to
// `onError`. With `repaint` false the page is left as it is until the connect
// ends, so what `say` writes into the clicked button stays on screen.
async function connectFromClick(say, onError, { repaint = true } = {}) {
  if (busy) return;
  busy = true;
  if (repaint) changed();
  try {
    await connect(say);
  } catch (err) {
    if (err?.code !== 'CANCELLED') onError(err);
  } finally {
    busy = false;
    changed();
  }
}

async function drop() {
  const l = link;
  link = null;
  calc = null;
  if (l) await l.close().catch(() => {});
  refreshPresent();
}

// Registered at load whatever mount() decides, so a calculator this site was
// already allowed connects when it is plugged in, on a phone too.
if (navigator.usb?.addEventListener) {
  navigator.usb.addEventListener('connect', refreshPresent);
  navigator.usb.addEventListener('disconnect', e => {
    if (link && e.device === link.device) drop();
    else refreshPresent();
  });
}
window.addEventListener('pagehide', () => { if (link) link.close().catch(() => {}); });

// `wire(dialog, done)` sets the buttons; Escape or a click outside resolves false.
function modal(html, wire) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'ce-modal';
    d.innerHTML = html;
    document.body.append(d);
    const done = v => {
      if (!d.open) return;
      d.close();
      d.remove();
      resolve(v);
    };
    d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    d.addEventListener('click', e => { if (e.target === d) done(false); });
    wire(d, done);
    d.showModal();
  });
}

// Without TI Connect CE's driver, Chrome's picker on Windows is empty
// (observed on Windows). Asked once per browser, before the first picker.
function askTIConnect() {
  let known = false;
  try { known = localStorage.getItem('ce-send-ticonnect') === 'yes'; } catch { /* private mode */ }
  if (!WIN || present || known) return Promise.resolve(true);
  const remember = () => {
    try { localStorage.setItem('ce-send-ticonnect', 'yes'); } catch { /* private mode */ }
  };
  return modal(`<h2>Is TI Connect CE installed?</h2>
      <p>On Windows, your calculator only shows up once TI Connect CE, TI's own software, is installed on this computer.</p>
      <p class="ce-modal-actions"><button type="button" class="ce-modal-go" data-v="yes">Yes, it's installed</button>
      <button type="button" class="ce-modal-alt" data-v="no">No, or I'm not sure</button></p>`,
  (d, done) => {
    d.querySelector('[data-v="yes"]').onclick = () => { remember(); done(true); };
    d.querySelector('[data-v="no"]').onclick = () => {
      d.innerHTML = `<h2>Install TI Connect CE first</h2>
          <ol><li><a href="${TICONNECT_URL}" target="_blank" rel="noopener nofollow">Download TI Connect CE from TI</a> and run the installer.</li>
          <li>If it opens, close it. This page can't reach the calculator while it's open.</li>
          <li>Come back to this tab and click below.</li></ol>
          <p class="ce-modal-actions"><button type="button" class="ce-modal-go">It's installed</button></p>`;
      d.querySelector('.ce-modal-go').onclick = () => { remember(); done(true); };
    };
  });
}

// Resolves true to send anyway.
function askJailbreak() {
  return modal(`<h2>Jailbreak your calculator first</h2>
      <p>This calculator can't run games until it's jailbroken. It only takes a few minutes, and then every game here will work.</p>
      <p class="ce-modal-actions"><a class="ce-modal-go" href="${INSTALLER}">Jailbreak it now</a>
      <button type="button" class="ce-modal-anyway">Send anyway</button></p>`,
  (d, done) => { d.querySelector('.ce-modal-anyway').onclick = () => done(true); });
}

// `where` finishes the "pick a game" sentence for the page it is on.
function verdict(c, where) {
  const connected = os => `<strong>Calculator connected</strong> (${os})`;
  const os = `OS ${esc(shortOs(c.os))}`;
  if (page === 'math') return `${connected(os)}. ${where}`;
  switch (jailbreakState(c.route, c.tools)) {
    case 'none': return `${connected(os)}. ${where}`;
    case 'found': return `${connected(`${os}, jailbroken`)}. ${where} ${c.route === 'v21' ? 'Games start from prgm, then A.' : 'Games start from the prgm menu.'}`;
    case 'missing': return `${connected(os)}. It needs a jailbreak before games will run: ${jailbreakLink('jailbreak it first')}, then come back and send games.`;
    default: return `${connected(os)}. There's no jailbreak for this version yet, so these games won't run on it.`;
  }
}

function statusHtml(where) {
  if (link && calc) return verdict(calc, where);
  if (connecting) return 'Connecting to your calculator…';
  return `Plug in your TI-84 Plus CE, turn it on, and click ${where.startsWith('Pick') ? 'Connect' : 'Send to calculator'} to install ${page === 'math' ? 'programs' : 'games'}.`;
}

function statusKind() {
  if (!(link && calc)) return '';
  if (page === 'math') return 'ok';
  const state = jailbreakState(calc.route, calc.tools);
  return state === 'missing' || state === 'blocked' ? 'warn' : 'ok';
}

// Everything a Send button does: connect if needed, check the jailbreak,
// send. `say` shows progress and `show(html, kind)` the outcome.
async function run({ file, label, say, show }) {
  if (busy) return;
  const gate = DOWNLOAD_FIRST[file];
  if (gate && !wasDownloaded(file)) {
    show(`<p>${gate(t => `<a href="${esc(encodeURI(file))}" class="ce-gate-dl"${downloadLinkAttrs()}><strong>${t}</strong></a>`)}</p>`, 'warn');
    return;
  }
  busy = true;
  changed();
  try {
    const c = await connect(say);
    say(`Getting ${label}…`);
    const files = await gameFiles(file, label);
    const entries = collectEntries(files);
    const asm = entries.some(isAssembly);
    if (asm && !sendAnyway && jailbreakState(c.route, c.tools) === 'missing') {
      say('');
      if (!(await askJailbreak())) return;
      sendAnyway = true;
    }
    const main = entries.filter(e => PROGRAMS.includes(e.type)).at(-1);
    const game = main ? main.name : label.slice(0, 20);
    const sending = pct => say(`Sending ${label} to your calculator… ${pct}%`);
    sending(0);
    let r;
    try {
      r = await sendGame(link, files, { onProgress: (done, total) => { if (total) sending(Math.min(99, Math.round(done / total * 100))); } });
    } catch (err) {
      track('ce_send_fail', { game, reason: failReason(err), page });
      if (linkDead(err)) await drop();
      throw err;
    }
    // `retried: 1`: the space check passed only on a second read of the calculator.
    track('ce_send_success', { game, outcome: r.replaced.length ? 'replaced' : 'sent', route: r.route, page, ...(r.rechecked ? { retried: 1 } : {}) });
    say('');
    show(sentHtml(r, main, asm, c), 'ok');
  } catch (err) {
    say('');
    if (err?.code === 'CANCELLED') return;
    show(`<p>${esc(errorText(err))}</p>`, 'bad');
  } finally {
    busy = false;
    changed();
  }
}

function sentHtml(r, main, asm, c) {
  const how = !main ? '' : asm ? startHint(r.os, main.name) : `Press prgm, pick ${main.name}, and press enter.`;
  const lower = how.charAt(0).toLowerCase() + how.slice(1);
  const html = asm && jailbreakState(r.route, c.tools) === 'missing'
    ? [`<p><strong>Sent!</strong> It won't start until your calculator is jailbroken: ${jailbreakLink('jailbreak it now')}, then ${esc(lower)}</p>`]
    : [`<p><strong>Sent!</strong> To ${page === 'math' ? 'run' : 'play'} it, ${esc(lower)}</p>`];
  for (const w of r.warnings) {
    if (w.code === 'LOW_RAM_TO_RUN') html.push(`<p>Your calculator is low on RAM (${w.freeKB} KB free), so the ${page === 'math' ? 'program' : 'game'} may stop with ERR:MEMORY. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management).</p>`);
  }
  return html.join('');
}

// One card under the download button, which stays the first thing a student
// sees. It says what to do, then turns green or amber with the OS and
// jailbreak state, and shows progress and the outcome.
function mountGame() {
  const a = [...document.querySelectorAll('.entry-content a[href^="/downloads/ce/"], main a[href^="/downloads/ce/"]')]
    .find(el => /\.(8xg|8xp|zip)$/i.test(el.getAttribute('href')));
  if (!a) return;
  const file = decodedHref(a);
  const label = (a.textContent.split('|')[0] || '').trim() || 'This game';
  const card = document.createElement('div');
  card.className = 'ce-conn is-leaf';
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <p class="msg ce-leaf-msg"></p>
    <button type="button" class="ce-conn-go"></button>
    <p class="msg sub ce-leaf-progress" aria-live="polite"></p>
    <div class="ce-leaf-result" hidden></div>`;
  (a.closest('.wp-block-button') || a).after(card);
  watchDownloads(document);
  const msg = card.querySelector('.ce-leaf-msg');
  const go = card.querySelector('.ce-conn-go');
  const progress = card.querySelector('.ce-leaf-progress');
  const result = card.querySelector('.ce-leaf-result');
  let outcome = ''; // a failure tints the card until the next try
  listeners.add(() => {
    const connected = !!(link && calc);
    msg.innerHTML = connected || connecting
      ? statusHtml('Click Send to calculator to install it.')
      : 'Plug in your TI-84 Plus CE, turn it on, and click Connect to send this game.';
    const kind = statusKind();
    card.className = 'ce-conn is-leaf' + (kind ? ' ' + kind : outcome === 'bad' ? ' bad' : '');
    go.textContent = connected ? 'Send to calculator' : 'Connect your calculator';
    go.disabled = busy || connecting;
  });
  changed();
  const say = t => { progress.textContent = t || ''; };
  const show = (html, kind) => {
    outcome = kind;
    result.innerHTML = html;
    result.className = `ce-leaf-result is-${kind}`;
    result.hidden = false;
    changed();
  };
  go.onclick = async () => {
    if (busy) return;
    outcome = '';
    result.hidden = true;
    result.innerHTML = '';
    if (link && calc) {
      run({ file, label, say, show });
      return;
    }
    await connectFromClick(say, err => show(`<p>${esc(errorText(err))}</p>`, 'bad'));
    say('');
  };
}

const ARROW = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function closeMenus(except) {
  document.querySelectorAll('.ce-split-menu').forEach(m => {
    if (m === except) return;
    m.hidden = true;
    m.parentElement.querySelector('.ce-split-arrow').setAttribute('aria-expanded', 'false');
  });
}

function mountHub() {
  const what = page === 'math' ? 'program' : 'game';
  const cards = [...document.querySelectorAll('.entry-content .wp-block-media-text')]
    .map(card => ({ card, a: card.querySelector('a[href^="/downloads/ce/"]') }))
    .filter(x => x.a && /\.(8xg|8xp|zip)$/i.test(x.a.getAttribute('href')));
  if (!cards.length) return;
  watchDownloads(document);
  document.addEventListener('click', e => { if (!e.target.closest('.ce-split')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });
  mountPanel(cards[0].card, `Pick a ${what} below and click Send to calculator.`);
  for (const { card, a } of cards) mountSplit(card, a);
  changed();
}

function mountPanel(before, where) {
  const panel = document.createElement('div');
  panel.setAttribute('role', 'status');
  before.before(panel);
  let panelError = '';
  listeners.add(() => {
    const kind = statusKind();
    panel.className = 'ce-conn' + (kind ? ' ' + kind : panelError ? ' bad' : '');
    if ((link && calc) || connecting) {
      panel.innerHTML = `<p class="msg">${statusHtml(where)}</p>`;
      return;
    }
    panel.innerHTML = `<p class="msg">${statusHtml(where)}</p>
      ${panelError ? `<p class="msg err">${esc(panelError)}</p>` : ''}
      <button type="button" class="ce-conn-go"${busy ? ' disabled' : ''}>Connect your calculator</button>`;
    const button = panel.querySelector('.ce-conn-go');
    button.onclick = () => {
      if (busy) return;
      panelError = '';
      connectFromClick(t => { button.textContent = t; button.disabled = true; }, err => { panelError = errorText(err); }, { repaint: false });
    };
  });
}

// The main half is what the student can do now: Download until a calculator
// is connected, then Send. The arrow offers the other.
function mountSplit(card, a) {
  const file = decodedHref(a);
  const label = (card.querySelector('h2')?.textContent || '').trim() || (page === 'math' ? 'This program' : 'This game');
  const old = a.closest('.wp-block-button');
  const href = esc(a.getAttribute('href'));
  const split = document.createElement('div');
  split.className = 'wp-block-button floated ce-split';
  old.after(split);
  old.style.display = 'none';
  const status = document.createElement('div');
  status.className = 'ce-card-status';
  status.setAttribute('role', 'status');
  [...card.querySelectorAll('.wp-block-button.floated')].at(-1).after(status);
  const show = (html, kind) => {
    status.innerHTML = html;
    status.className = `ce-card-status is-${kind}`;
  };
  const say = t => {
    if (t) show(`<p>${esc(t)}</p>`, 'busy');
    else if (status.classList.contains('is-busy')) show('', '');
  };
  const send = () => {
    closeMenus();
    run({ file, label, say, show });
  };
  let mode = '';
  const paint = () => {
    const want = link && calc ? 'send' : 'download';
    if (want !== mode) {
      mode = want;
      const button = 'wp-block-button__link no-border-radius';
      split.innerHTML = (mode === 'send'
        ? `<button type="button" class="${button} ce-split-main">Send to calculator</button>`
        : `<a class="${button} ce-split-main" href="${href}"${downloadLinkAttrs()}>Download</a>`)
        + `<button type="button" class="${button} ce-split-arrow" aria-label="More ways to get ${esc(label)}" aria-haspopup="menu" aria-expanded="false">${ARROW}</button>`
        + `<div class="ce-split-menu" role="menu" hidden>${mode === 'send'
          ? `<a role="menuitem" href="${href}"${downloadLinkAttrs()}>Download file</a>`
          : '<button type="button" role="menuitem" class="ce-split-send">Send to calculator</button>'}</div>`;
      const arrow = split.querySelector('.ce-split-arrow');
      const menu = split.querySelector('.ce-split-menu');
      arrow.onclick = () => {
        const open = menu.hidden;
        closeMenus(menu);
        menu.hidden = !open;
        arrow.setAttribute('aria-expanded', String(open));
      };
      split.querySelector(mode === 'send' ? '.ce-split-main' : '.ce-split-send').onclick = send;
    }
    split.querySelectorAll('button').forEach(b => { b.disabled = busy; });
  };
  listeners.add(paint);
  paint();
}

function mount() {
  if (!navigator.usb) return;
  // A CE on a phone's USB port is untested, so phones keep the downloads only.
  const mobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) return;
  const at = path => location.pathname === path || location.pathname === path + 'index.html';
  page = at(HUB) ? 'hub' : at(MATH) ? 'math' : 'game';
  if (page === 'game') mountGame();
  else mountHub();
  refreshPresent();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
