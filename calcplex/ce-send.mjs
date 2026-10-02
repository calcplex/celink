// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// "Send to calculator" on the TI-84 Plus CE download pages:
//   the games hub  a connect panel above the cards, and a split button on each
//                  card (Send to calculator, with Download file under the arrow)
//   a game page    one card under the download button: Connect, then Send
//   the math page  the hub's layout; the programs are TI-Basic, so no jailbreak
// When the build switches Delete on, a game the connected calculator already
// has Delete as its main button on the hub and its own page, with Send
// again first under the arrow. The math page does the same, but only for a
// program whose content matches a version the site served: a student's own
// program under the same name never gets Delete.
// A Sent message for an assembly game ends with a help link, which opens
// answers for the calculator's route; on the math page, where programs arrive
// archived on 5.3 and later, it ends with "Can't find it?". Wherever a sentence names the prgm
// key, the key carries a "?" that shows it on the keypad. Wherever words
// ask for the game to be sent again, a Send again button sits beside them.
// Without WebUSB, or on a phone, the page keeps its download buttons only.
import {
  PROGRAMS, sendGame, collectEntries, deleteGame, isAssembly, inspect, jailbreakState, shellLabel, listedOnCalculator, planDelete, readyEach, spaceGames,
  unpackZip, pickCalculator, keepOwned, ownedHere, ownedAfterSend, ownedAfterFailedSend, ownedAfterDelete,
} from './gamesend.mjs';
import {
  DELETE_REASONS, FIND_HELP_OPEN, PREVIEW_HOST, SEND_AGAIN, TICONNECT_URL, archiveMode, asksSendAgain, calcParams, deleteParams, deleteReasonReporter, downloadParams, esc, failReason,
  jbPromptChoice, keyHelpHtml, mountKeyHelp, outOfSpace, presenceTracker, refusedAt, isChromeOS, isWindows, linkDead, pageErrorText, refusal, spaceListChange,
  startHelpAnswer, startHelpChoices, startHelpShown, startHint, startReporter, track, trackConnectFail, withKeyHelp, findHelpAnswer, findHelpShown,
} from './core.mjs';
import { CELink } from '../celink.mjs';

const INSTALLER = '/ti84plusce-jailbreak-installer/';
const HUB = '/downloads/ti84plusce/games/';
const MATH = '/downloads/ti84plusce/math/';

// ?win=1 and ?cros=1 preview the Windows and Chrome OS wording on localhost.
const WIN = isWindows(navigator) || (PREVIEW_HOST && /[?&]win=1\b/.test(location.search));
const CROS = isChromeOS(navigator) || (PREVIEW_HOST && /[?&]cros=1\b/.test(location.search));

// The build marks the pages' script tag when Delete is on, with the names
// Delete never touches (names another download also sends). The hub's and
// the game pages' tags carry the games list, which says which games a
// connected calculator has and which ones a send that runs out of room can
// offer to delete. The math page's carries its own list instead: every
// version of each program the site has served, so only a copy whose content
// is one of them counts as there. Without that list the math page has no Delete.
const DELETE_TAG = document.querySelector('script[data-ce-delete]');
const KEEP = (DELETE_TAG?.dataset.ceKeep || '').split(/\s+/).filter(Boolean);
const GAMES_URL = DELETE_TAG?.dataset.ceGames || '';
const OWN_URL = DELETE_TAG?.dataset.ceOwn || '';
const deleteOn = () => !!DELETE_TAG && (page !== 'math' || !!OWN_URL);
// Whether Delete goes by content (the math list) rather than by name and
// type. The tag decides, not the URL: the site serves the math page at
// other spellings of its path too (a doubled slash, an escaped letter), and
// a tag that carries the math list always means the math page (mount).
const byContent = () => !!OWN_URL || page === 'math';

const shortOs = os => String(os).split('.').slice(0, 3).join('.');
const jailbreakLink = text => `<a href="${INSTALLER}">${text}</a>`;
// Send again inside a message: it runs the send of the card the message is
// on, whatever that card's main button says at the time (one listener per card).
const SEND_AGAIN_HTML = `<button type="button" class="ce-send-again">${esc(SEND_AGAIN.text)}</button>`;

// Their licenses travel with the game, which a direct send skips, so Send
// unlocks only after the download.
const READ_FIRST = link => `This game's author asked for the license and readme to come with the game. ${link('Download it')}, read them, then click ${SEND_AGAIN_HTML}`;
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
// One listener per page, so each click on a download link counts once, in
// ce_download, apart from GA4's own file_download.
function watchDownloads(root) {
  root.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="/downloads/ce/"]');
    if (!a) return;
    const file = decodedHref(a);
    markDownloaded(file);
    const params = downloadParams(file, page, link && calc);
    if (params) track('ce_download', params);
  });
}

async function gameFiles(file, label) {
  const response = await fetch(file);
  if (!response.ok) throw refusal('FETCH', `Couldn't get ${label} from this site. Try again in a moment.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return /\.zip$/i.test(file) ? unpackZip(bytes) : [bytes];
}

// One fetch per download for the page, shared by Send, Delete and a game
// page's check of what is on the calculator. A fetch that failed is
// forgotten, so the next click tries again.
const bundles = new Map();
function bundle(file, label) {
  if (!bundles.has(file)) {
    const files = gameFiles(file, label);
    bundles.set(file, files);
    files.catch(() => { if (bundles.get(file) === files) bundles.delete(file); });
  }
  return bundles.get(file);
}

// The build's list of every hub game and its files, read the first time a
// calculator connects with Delete on, or a send runs out of room. A failed
// fetch is forgotten, so the next one tries again.
let gamesList = null;
function loadGames() {
  if (!gamesList) {
    const list = GAMES_URL
      ? fetch(GAMES_URL).then(r => { if (!r.ok) throw refusal('FETCH', 'no games list'); return r.json(); })
      : Promise.resolve([]);
    gamesList = list;
    list.catch(() => { if (gamesList === list) gamesList = null; });
  }
  return gamesList;
}

// The math page's list of known versions, { file, name, type, versions } per
// card, read once per page: started when a connect starts and awaited after
// the calculator opens, so the picker keeps the click's permission. A failed
// fetch is forgotten, so the next connect tries again.
let ownList = null;
function loadOwn() {
  if (!ownList) {
    const list = OWN_URL
      ? fetch(OWN_URL).then(r => { if (!r.ok) throw refusal('FETCH', 'no math list'); return r.json(); })
        .then(l => (Array.isArray(l) ? l : []))
      : Promise.resolve([]);
    ownList = list;
    list.catch(() => { if (ownList === list) ownList = null; });
  }
  return ownList;
}

// `promise`, or a rejection once `ms` have passed.
const capped = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('too slow')), ms);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});

// A list that has not come in 5 s counts as none, so a slow fetch only ever
// costs the Delete, never a message.
const ownNow = () => capped(loadOwn(), 5000).catch(() => []);
const mathEntry = async file => (await ownNow()).find(e => e.file === file) ?? null;

// Whether a download's game is on the calculator, by planDelete's
// name-and-type rule: from the build's games list, which has every hub card;
// on a game page (`fetchGame`) from the download itself when the list has no
// entry or did not load. The hub never fetches every download for this.
// On the math page a program is there only as a version the site served:
// read back at connect or matched after a send (gamesend's ownedHere).
async function gameOnCalculator(file, label, rows, { fetchGame = true } = {}) {
  if (byContent()) {
    const owned = calc?.owned ?? [];
    const entry = await mathEntry(file);
    return !!entry && !KEEP.includes(entry.name) && ownedHere(owned, entry, rows);
  }
  const games = await loadGames().catch(() => null);
  const listed = listedOnCalculator(games, file, rows);
  if (listed !== null || !fetchGame) return !!listed;
  return planDelete(collectEntries(await bundle(file, label)), rows, { keep: KEEP }).remove.length > 0;
}

// A card's main button follows the listing: the function this returns says
// whether the card's game is there, checked again whenever the listing changes
// (connect, a send, a delete), and `repaint` runs when a new answer arrives.
// The programs known to be ours count too: a send that changes them is
// checked again even when the listing after it could not be taken.
// Until then, and with Delete off, the card offers Send (core's presenceTracker).
function presence(file, label, repaint, { fetchGame }) {
  return presenceTracker({
    rowsNow: () => (link && calc && deleteOn() ? calc.rows : null),
    ownedNow: () => calc?.owned,
    check: rows => gameOnCalculator(file, label, rows, { fetchGame }),
    repaint,
  });
}

// A running game stops the calculator answering USB; quitting the game is enough (observed on hardware).
const LOST_TEXT = 'The calculator stopped responding. If a game is running on it, quit the game and try again. Otherwise, unplug it, plug it back in, and try again.';
// The math page's things are programs.
const LOST_TEXT_MATH = 'The calculator stopped responding. If a program is running on it, quit it and try again. Otherwise, unplug it, plug it back in, and try again.';
const lostText = () => (page === 'math' ? LOST_TEXT_MATH : LOST_TEXT);
const OUTCOME_TEXT = {
  no_device: "No calculator was picked. Make sure it's plugged in and turned on, then try again. Not in the list? Try a different USB cable; charge-only cables won't work.",
  open_failed: "Couldn't connect. Close anything else using the calculator (like TI Connect CE or another tab), unplug it and plug it back in, then try again.",
  calc_busy: 'The calculator is busy. Press clear a few times to get back to the home screen, then try again.',
};
const WINDOWS_TEXT = {
  no_device: 'Calculator not in the list? On Windows it only shows up once TI Connect CE is installed. If it is, make sure the calculator is on, then try again.',
};
const CHROMEOS_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then try again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};

// This page's sentences by reason, the platform's own first. A function of
// the page, which mount() sets after this module loads.
const ownText = () => ({ ...OUTCOME_TEXT, link_lost: lostText(), timeout: lostText(), ...(CROS ? CHROMEOS_TEXT : {}), ...(WIN ? WINDOWS_TEXT : {}) });
const errorText = err => pageErrorText(err, { page, own: ownText() });

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
  // Started, not awaited: the picker needs the click's permission, so nothing
  // is awaited before it.
  const pending = page === 'math' && deleteOn() ? loadOwn() : null;
  say(present ? 'Connecting to your calculator…' : 'Select your calculator in the popup…');
  let l;
  try {
    l = await pickCalculator();
    say('Connecting to your calculator…');
    await l.open();
    // No list in 5 s means no Delete this time, never a slower connect.
    const own = pending ? await capped(pending, 5000).catch(() => []) : [];
    calc = await inspect(l, { own });
  } catch (err) {
    if (l) await l.close().catch(() => {});
    calc = null;
    if (!quiet) trackConnectFail(err, { page });
    throw err;
  }
  link = l;
  track('ce_calc_info', { ...calcParams(calc), route: calc.route, page, jb: jailbreakState(calc.route, calc.tools) });
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
// Outside means on the backdrop, pressed and released there: a click on the
// dialog's own padding stays, and so does the second click of a double-click
// that opened the dialog.
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
    const outside = e => {
      const r = d.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    d.addEventListener('pointerdown', e => { pressedOutside = e.target === d && outside(e); });
    d.addEventListener('click', e => {
      if (e.target === d && pressedOutside && e.detail < 2 && outside(e)) done(false);
      pressedOutside = false;
    });
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

// Resolves how the prompt closed: 'installer' (the link, which navigates on),
// 'send_anyway', or 'cancel' (Escape or a click outside).
async function askJailbreak() {
  const choice = await modal(`<h2>Jailbreak your calculator first</h2>
      <p>This calculator can't run games until it's jailbroken. It only takes a few minutes, and then every game here will work.</p>
      <p class="ce-modal-actions"><a class="ce-modal-go" href="${INSTALLER}">Jailbreak it now</a>
      <button type="button" class="ce-modal-anyway">Send anyway</button></p>`,
  (d, done) => {
    d.querySelector('.ce-modal-go').addEventListener('click', () => done('installer'));
    d.querySelector('.ce-modal-anyway').onclick = () => done('send_anyway');
  });
  return jbPromptChoice(choice);
}

// `where` finishes the "pick a game" sentence for the page it is on.
function verdict(c, where) {
  const connected = os => `<strong>Calculator connected</strong> (${os})`;
  const os = `OS ${esc(shortOs(c.os))}`;
  if (page === 'math') return `${connected(os)}. ${where}`;
  switch (jailbreakState(c.route, c.tools)) {
    case 'none': return `${connected(os)}. ${where}`;
    case 'found': return `${connected(`${os}, jailbroken`)}. ${where} ${c.route === 'v21' ? `Games start from ${keyHelpHtml('ce')}, then A.` : `Games start from the ${keyHelpHtml('ce')} menu.`}`;
    case 'shell': return `${connected(`${os}, jailbroken`)}. ${where} Games start from ${esc(shellLabel(c.route, c.tools))}.`;
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
// send. `say` shows progress and `show(html, kind)` the outcome. Nothing
// starts while the page connects on its own.
async function run({ file, label, say, show }) {
  if (busy || connecting) return;
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
    const files = await bundle(file, label);
    const entries = collectEntries(files);
    const asm = entries.some(isAssembly);
    const main = entries.filter(e => PROGRAMS.includes(e.type)).at(-1);
    const game = main ? main.name : label.slice(0, 20);
    if (asm && !sendAnyway && jailbreakState(c.route, c.tools) === 'missing') {
      say('');
      const choice = await askJailbreak();
      track('ce_jb_prompt', { choice, page, route: c.route, game });
      if (choice !== 'send_anyway') return;
      sendAnyway = true;
    }
    const sending = pct => say(`Sending ${label} to your calculator… ${pct}%`);
    sending(0);
    let r;
    try {
      r = await sendGame(link, files, {
        verify: 'full',
        archive: archiveMode(page),
        onProgress: (done, total) => { if (total) sending(Math.min(99, Math.round(done / total * 100))); },
      });
    } catch (err) {
      track('ce_send_fail', { game, reason: failReason(err), page, ...refusedAt(err) });
      if (linkDead(err)) await drop();
      // A send that stopped part way may have left files, which Delete offers to remove.
      // On the math page a copy it may have changed is no longer known to be ours.
      else if (deleteOn()) {
        if (calc) calc.owned = ownedAfterFailedSend(calc.owned, err, entries.map(e => e.name));
        await refreshRows();
      }
      throw err;
    }
    // `retried: 1`: the space check passed only on a second read of the calculator.
    track('ce_send_success', { game, outcome: r.replaced.length ? 'replaced' : 'sent', route: r.route, page, ...(r.rechecked ? { retried: 1 } : {}) });
    // A math program read back whole as a version the site served is ours, so its card turns to Delete.
    if (page === 'math' && deleteOn()) {
      const owned = await ownedAfterSend(calc?.owned, r, entries, await ownNow());
      if (calc) calc.owned = owned;
    }
    if (deleteOn()) await refreshRows();
    say('');
    show(sentHtml(r, main, asm, c), 'ok');
  } catch (err) {
    say('');
    if (err?.code === 'CANCELLED') return;
    const memory = deleteOn() && link ? outOfSpace(err) : null;
    const refusedBy = calc;
    const games = memory ? await loadGames().catch(() => null) : null;
    // Words that ask for another send get the button beside them, and so does
    // every message on a game the calculator has: its main button is Delete.
    const again = asksSendAgain(err)
      || (deleteOn() && link && calc ? await gameOnCalculator(file, label, calc.rows, { fetchGame: page === 'game' }).catch(() => false) : false);
    const text = `<p>${esc(errorText(err))}${again ? ` ${SEND_AGAIN_HTML}` : ''}</p>`;
    if (games) {
      const list = spaceList({ memory, lastReason: failReason(err), sending: file, sendingLabel: label, games, calc: refusedBy, say, show });
      list.wire(show(text + list.html, 'bad'));
    } else {
      show(text, 'bad');
    }
  } finally {
    busy = false;
    changed();
  }
}

// Delete matches against this listing, so it is taken again after a send or
// a delete changed the calculator, whether or not it finished.
// After a send it runs before the Sent message, which tells the student to
// start the game: a running game stops the calculator answering.
async function refreshRows() {
  if (!link) return;
  try {
    const rows = await readyEach(link).list();
    // Both in one tick, so each card checks once: its presence follows `rows` and `owned`.
    if (calc) {
      calc.owned = keepOwned(calc.owned, rows);
      calc.rows = rows;
    }
  } catch (err) {
    if (linkDead(err)) await drop();
  }
}

let helpPanels = 0;
function sentHtml(r, main, asm, c) {
  const state = jailbreakState(r.route, c.tools);
  // A shell starts games from inside itself, so its sentence names no key.
  const how = !main ? '' : asm && state === 'shell' ? `Start ${main.name} from ${shellLabel(r.route, c.tools)}.`
    // A TI-Basic program: the first enter pastes prgmNAME on the home screen, the second runs it.
    : asm ? startHint(r.os, main.name) : `Press prgm, pick ${main.name}, and press enter twice.`;
  const lower = withKeyHelp(how.charAt(0).toLowerCase() + how.slice(1), 'ce');
  const html = [];
  if (asm && state === 'missing') {
    html.push(`<p><strong>Sent!</strong> It won't start until your calculator is jailbroken: ${jailbreakLink('jailbreak it now')}, then ${lower}</p>`);
  } else if (main && startHelpShown(page, asm, state)) {
    const id = `ce-help-${++helpPanels}`;
    html.push(`<p><strong>Sent!</strong> To play it, ${lower} <button type="button" class="ce-help-open" aria-expanded="false" aria-controls="${id}">Game didn't start?</button></p>`,
      helpPanel(id, { route: r.route, jb: state, game: main.name, os: r.os, shell: shellLabel(r.route, c.tools) }));
  } else if (main && findHelpShown(page, r.os)) {
    const id = `ce-help-${++helpPanels}`;
    html.push(`<p><strong>Sent!</strong> To run it, ${lower} <button type="button" class="ce-help-open" aria-expanded="false" aria-controls="${id}">Can't find it?</button></p>`,
      findPanel(id, { route: r.route, game: main.name, os: r.os }));
  } else {
    html.push(`<p><strong>Sent!</strong> To ${page === 'math' ? 'run' : 'play'} it, ${lower}</p>`);
  }
  for (const w of r.warnings) {
    if (w.code === 'LOW_RAM_TO_RUN') html.push(`<p>Your calculator is low on RAM (${w.freeKB} KB free), so the ${page === 'math' ? 'program' : 'game'} may stop with ERR:MEMORY. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management).</p>`);
  }
  return html.join('');
}

// The help link's choices, hidden until the link opens them. The
// data attributes carry what the answer and the report need, so the panel
// keeps working after the cable is gone.
function helpPanel(id, { route, jb, game, os, shell }) {
  const choices = startHelpChoices(route, os, jb).map(([choice, label]) => `<button type="button" data-help="${esc(choice)}" aria-pressed="false">${esc(label)}</button>`);
  return `<div class="ce-help" id="${id}" hidden data-route="${esc(route)}" data-jb="${esc(jb)}" data-game="${esc(game)}" data-os="${esc(os)}" data-shell="${esc(shell)}">`
    + `<p class="ce-help-q">What happened?</p><div class="ce-help-choices">${choices.join('')}</div><div class="ce-help-fix"></div></div>`;
}

// The math page's "Can't find it?": one answer, no choices. Its first open
// is reported as its own choice (FIND_HELP_OPEN), without a jailbreak state,
// so it never reads as a games panel's open.
function findPanel(id, { route, game, os }) {
  return `<div class="ce-help" id="${id}" hidden data-open="${FIND_HELP_OPEN}" data-route="${esc(route)}" data-game="${esc(game)}" data-os="${esc(os)}">`
    + `<div class="ce-help-fix"><p>${answerHtml(findHelpAnswer(game))}</p></div></div>`;
}

// "TI-Basic" never breaks at its hyphen in a narrow answer box.
const nowrapTerms = html => html.replace(/\bTI-Basic\b/g, '<span class="ce-nowrap">TI-Basic</span>');
const answerHtml = parts => parts.map(p => (typeof p === 'string' ? nowrapTerms(esc(p)) : p === SEND_AGAIN ? SEND_AGAIN_HTML : jailbreakLink(esc(p.text)))).join('');

// One listener for every help panel the page shows.
function watchHelp(root) {
  const report = startReporter();
  const reportFrom = (panel, choice) => {
    const d = panel.dataset;
    report({ choice, page, route: d.route, jb: d.jb, game: d.game, os: d.os });
  };
  root.addEventListener('click', e => {
    const open = e.target.closest?.('.ce-help-open');
    if (open) {
      const panel = document.getElementById(open.getAttribute('aria-controls'));
      if (!panel) return;
      const showing = panel.hidden;
      panel.hidden = !showing;
      open.setAttribute('aria-expanded', String(showing));
      if (showing) reportFrom(panel, panel.dataset.open || 'open');
      return;
    }
    const pick = e.target.closest?.('.ce-help [data-help]');
    if (!pick) return;
    const panel = pick.closest('.ce-help');
    for (const b of panel.querySelectorAll('[data-help]')) {
      b.classList.toggle('is-picked', b === pick);
      b.setAttribute('aria-pressed', String(b === pick));
    }
    const d = panel.dataset;
    panel.querySelector('.ce-help-fix').innerHTML = `<p>${answerHtml(startHelpAnswer(d.route, pick.dataset.help, { os: d.os, name: d.game, jb: d.jb, shell: d.shell }))}</p>`;
    reportFrom(panel, pick.dataset.help);
  });
}

function askDelete(label) {
  return modal(`<h2>Delete ${esc(label)} from your calculator?</h2>
      <p class="ce-modal-actions"><button type="button" class="ce-modal-go is-danger" data-v="delete">Delete</button>
      <button type="button" class="ce-modal-alt" data-v="cancel" autofocus>Cancel</button></p>`,
  (d, done) => {
    d.querySelector('[data-v="delete"]').onclick = () => done('delete');
    d.querySelector('[data-v="cancel"]').onclick = () => done(false);
  });
}

// A finished message (sent, deleted, an error) can be closed from its corner.
const CLOSE_X = '<button type="button" class="ce-close" aria-label="Close">×</button>';

// "Why?" under a finished delete: one pick per delete, sent once as
// ce_delete_reason. Ignoring it sends nothing.
function whyHtml() {
  return `<p class="ce-why"><span>Why did you delete it?</span> ${DELETE_REASONS.map(([id, text]) => `<button type="button" data-why="${id}" aria-pressed="false">${esc(text)}</button>`).join(' ')}</p>`;
}
function wireWhy(box, { game, lastReason }) {
  const line = box.querySelector('.ce-why');
  if (!line) return;
  const report = deleteReasonReporter({ game, page, lastReason });
  line.addEventListener('click', e => {
    const pick = e.target.closest('[data-why]');
    if (!pick || !report(pick.dataset.why)) return;
    for (const b of line.querySelectorAll('[data-why]')) {
      b.classList.toggle('is-picked', b === pick);
      b.setAttribute('aria-pressed', String(b === pick));
      b.disabled = true;
    }
  });
}

// Under a send refused for space: this site's games on the calculator that
// refused, in the memory that ran out (the build's games list against the
// listing), each with Delete. Not the game being sent. No game there, no list.
// `space`: { memory, lastReason, sending, sendingLabel, games, calc, say, show } of that box,
// `calc` being the calculator that refused.
const spaceRows = space => (calc && calc === space.calc
  ? spaceGames({ games: space.games, rows: calc.rows, memory: space.memory, sending: space.sending })
  : []);

function spaceRowsHtml(here) {
  if (!here.length) return '';
  const off = busy || !(link && calc) ? ' disabled' : '';
  const rows = here.map(g => `<li><span>${esc(g.label)}</span> <button type="button" class="ce-space-del" aria-label="Delete ${esc(g.label)}"${off}>Delete</button></li>`);
  return `<p class="ce-space-q">Games from this site on your calculator:</p><ul class="ce-space">${rows.join('')}</ul>`;
}

// Every out-of-space list on the page. A listener keeps each one on its
// calculator's listing (core.spaceListChange): a delete or a send anywhere
// on the page redraws it, and another calculator takes it away.
const spaceLists = new Set();

function wireSpaceRows(entry, here) {
  entry.el.querySelectorAll('.ce-space-del').forEach((b, i) => {
    const { say, show } = entry.space;
    b.onclick = () => removeGame({ file: here[i].file, label: here[i].label, say, show, space: entry.space });
  });
}

function spaceList(space) {
  const here = spaceRows(space);
  if (!here.length) return { html: '', wire() {} };
  return {
    html: `<div class="ce-space-list">${spaceRowsHtml(here)}</div>`,
    wire(box) {
      const el = box.querySelector('.ce-space-list');
      if (!el) return;
      const entry = { el, space, rows: calc?.rows };
      wireSpaceRows(entry, here);
      spaceLists.add(entry);
    },
  };
}

// A list whose last game left goes with its heading, as after its own last Delete.
function followSpaceLists() {
  for (const entry of spaceLists) {
    const change = entry.el.isConnected ? spaceListChange({ refusedBy: entry.space.calc, calc, rows: entry.rows }) : 'gone';
    const here = change === 'redraw' ? spaceRows(entry.space) : null;
    if (change === 'gone' || change === 'drop' || here?.length === 0) {
      entry.el.remove();
      spaceLists.delete(entry);
      continue;
    }
    if (here) {
      entry.rows = calc.rows;
      entry.el.innerHTML = spaceRowsHtml(here);
      wireSpaceRows(entry, here);
    }
    entry.el.querySelectorAll('.ce-space-del').forEach(b => { b.disabled = busy || !(link && calc); });
  }
}

// Delete: the game's own program and data, after a confirm. A cancel sends
// nothing. From the out-of-space list (`space`), the outcome keeps the rest
// of the list under it, and only the calculator that refused is touched: if
// another one was plugged in while the confirm was open, its list is gone
// and nothing is deleted.
async function removeGame({ file, label, say, show, space = null }) {
  closeMenus();
  if (busy || !(link && calc)) return;
  if (await askDelete(label) !== 'delete' || busy) return;
  if (space && calc && calc !== space.calc) return;
  // After a delete from the out-of-space list, the refused game is one click
  // away, named so it is not mistaken for the game just deleted.
  const sendRefused = space?.sendingLabel
    ? `<p class="ce-space-next"><button type="button" class="ce-send-again">Send ${esc(space.sendingLabel)}</button></p>` : '';
  const outcome = (html, kind, why) => {
    const list = space ? spaceList(space) : null;
    const box = show(html + (why ? sendRefused + whyHtml() : '') + (list ? list.html : ''), kind);
    if (why) wireWhy(box, why);
    list?.wire(box);
  };
  // The cable came out while the confirm was open.
  if (!(link && calc)) {
    outcome(`<p>${esc(lostText())}</p>`, 'bad');
    return;
  }
  busy = true;
  changed();
  const lastReason = space?.lastReason;
  const from = { page, route: calc.route, lastReason };
  let game = label.slice(0, 20);
  try {
    say(`Deleting ${label}…`);
    const files = await bundle(file, label);
    const main = collectEntries(files).filter(e => PROGRAMS.includes(e.type)).at(-1);
    if (main) game = main.name;
    // The math page deletes only a version the site served, read back again
    // now; without its list entry, nothing (own: []).
    const r = byContent()
      ? await deleteGame(link, files, { keep: KEEP, own: [await mathEntry(file)].filter(Boolean) })
      : await deleteGame(link, files, { keep: KEEP });
    // Both in one tick, so each card checks once: its presence follows `rows` and `owned`.
    if (calc) {
      calc.owned = ownedAfterDelete(calc.owned, r);
      calc.rows = r.rows;
    }
    say('');
    if (r.deleted.length) {
      track('ce_delete', deleteParams({ ...from, game, outcome: 'deleted', bytes: r.bytes }));
      outcome(`<p>${esc(label)} was deleted from your calculator.</p>`, 'ok', { game, lastReason });
    } else if (r.notOurs?.length) {
      track('ce_delete', deleteParams({ ...from, game, outcome: 'not_ours' }));
      outcome(`<p>The ${esc(r.notOurs[0].name)} on your calculator isn't the one from this page, so it wasn't deleted.</p>`, 'warn');
    } else {
      track('ce_delete', deleteParams({ ...from, game, outcome: 'nothing' }));
      outcome(`<p>${esc(label)} isn't on your calculator.</p>`, 'warn');
    }
  } catch (err) {
    say('');
    track('ce_delete', deleteParams({ ...from, game, outcome: 'failed', err }));
    if (linkDead(err)) await drop();
    else await refreshRows();
    outcome(`<p>${esc(err?.code === 'READBACK' ? `${label} is still on your calculator. Try again.` : errorText(err))}</p>`, 'bad');
  } finally {
    busy = false;
    changed();
  }
}

// One card under the download button, which stays the first thing a student
// sees. It says what to do, then turns green or amber with the OS and
// jailbreak state, and shows progress and the outcome. Its button connects,
// then sends; with Delete on, a game already on the calculator gets the hub
// card's split instead: Delete, and Send again under the arrow.
function mountGame() {
  const a = [...document.querySelectorAll('.entry-content a[href^="/downloads/ce/"], main a[href^="/downloads/ce/"]')]
    .find(el => /\.(8xg|8xp|zip)$/i.test(el.getAttribute('href')));
  if (!a) return;
  const file = decodedHref(a);
  const label = (a.textContent.split('|')[0] || '').trim() || 'This game';
  const href = esc(a.getAttribute('href'));
  const card = document.createElement('div');
  card.className = 'ce-conn is-leaf';
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <p class="msg ce-leaf-msg"></p>
    <div class="ce-leaf-actions"></div>
    <p class="msg sub ce-leaf-progress" aria-live="polite"></p>
    <div class="ce-leaf-result" hidden></div>`;
  (a.closest('.wp-block-button') || a).after(card);
  watchDownloads(document);
  const msg = card.querySelector('.ce-leaf-msg');
  const actions = card.querySelector('.ce-leaf-actions');
  const progress = card.querySelector('.ce-leaf-progress');
  const result = card.querySelector('.ce-leaf-result');
  let outcome = ''; // a failure tints the card until the next try
  const say = t => { progress.textContent = t || ''; };
  const show = (html, kind) => {
    outcome = kind;
    result.innerHTML = CLOSE_X + html;
    result.className = `ce-leaf-result is-${kind}`;
    result.hidden = false;
    changed();
    return result;
  };
  const clearResult = () => {
    outcome = '';
    result.hidden = true;
    result.innerHTML = '';
  };
  const send = () => {
    closeMenus();
    if (busy) return;
    clearResult();
    run({ file, label, say, show });
  };
  const go = async () => {
    if (busy) return;
    if (link && calc) {
      send();
      return;
    }
    clearResult();
    await connectFromClick(say, err => show(`<p>${esc(errorText(err))}</p>`, 'bad'));
    say('');
  };
  const remove = () => removeGame({ file, label, say, show });
  result.addEventListener('click', e => {
    if (e.target.closest('.ce-close')) clearResult();
    else if (e.target.closest('.ce-send-again')) send();
  });
  let mode = '';
  const here = presence(file, label, () => paint(), { fetchGame: true });
  const paint = () => {
    const connected = !!(link && calc);
    const onCalc = connected && here();
    msg.innerHTML = connected || connecting
      ? statusHtml(onCalc ? `${esc(label)} is already on your calculator.` : 'Click Send to calculator to install it.')
      : 'Plug in your TI-84 Plus CE, turn it on, and click Connect to send this game.';
    const kind = statusKind();
    card.className = 'ce-conn is-leaf' + (kind ? ' ' + kind : outcome === 'bad' ? ' bad' : '');
    const want = !connected ? 'connect' : onCalc ? 'delete' : 'send';
    if (want !== mode) {
      mode = want;
      if (mode === 'delete') {
        actions.innerHTML = `<div class="ce-split ce-leaf-split is-delete">${splitHtml(mode, { href, label })}</div>`;
        wireSplit(actions.firstElementChild, mode, { send, remove });
      } else {
        actions.innerHTML = `<button type="button" class="ce-conn-go">${mode === 'send' ? 'Send to calculator' : 'Connect your calculator'}</button>`;
        actions.firstElementChild.onclick = go;
      }
    }
    actions.querySelectorAll('button').forEach(b => { b.disabled = busy || connecting; });
  };
  listeners.add(paint);
  changed();
}

const ARROW = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function closeMenus(except) {
  document.querySelectorAll('.ce-split-menu').forEach(m => {
    if (m === except) return;
    m.hidden = true;
    m.parentElement.querySelector('.ce-split-arrow').setAttribute('aria-expanded', 'false');
  });
}

// One pair of listeners per page: a click outside any split, or Escape, closes its menu.
function watchMenus() {
  document.addEventListener('click', e => { if (!e.target.closest('.ce-split')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });
}

// A split button's halves: the main one is what the student can do now, the
// arrow offers the rest. 'download' (no calculator yet), 'send', or 'delete'
// (the game is on the calculator: Send again comes first under the arrow).
function splitHtml(mode, { href, label }) {
  const button = 'wp-block-button__link no-border-radius';
  const download = `<a role="menuitem" href="${href}"${downloadLinkAttrs()}>Download file</a>`;
  const [main, items] = {
    download: [`<a class="${button} ce-split-main" href="${href}"${downloadLinkAttrs()}>Download</a>`,
      '<button type="button" role="menuitem" class="ce-split-send">Send to calculator</button>'],
    send: [`<button type="button" class="${button} ce-split-main">Send to calculator</button>`, download],
    delete: [`<button type="button" class="${button} ce-split-main ce-danger" aria-label="Delete ${esc(label)} from calculator">Delete</button>`,
      `<button type="button" role="menuitem" class="ce-split-send">${esc(SEND_AGAIN.text)}</button>${download}`],
  }[mode];
  return main
    + `<button type="button" class="${button} ce-split-arrow" aria-label="More ways to get ${esc(label)}" aria-haspopup="menu" aria-expanded="false">${ARROW}</button>`
    + `<div class="ce-split-menu" role="menu" hidden>${items}</div>`;
}

// `send` and `remove` run the card's send and its Delete.
function wireSplit(split, mode, { send, remove }) {
  const arrow = split.querySelector('.ce-split-arrow');
  const menu = split.querySelector('.ce-split-menu');
  arrow.onclick = () => {
    const open = menu.hidden;
    closeMenus(menu);
    menu.hidden = !open;
    arrow.setAttribute('aria-expanded', String(open));
  };
  if (mode !== 'download') split.querySelector('.ce-split-main').onclick = mode === 'delete' ? remove : send;
  split.querySelector('.ce-split-send')?.addEventListener('click', send);
}

function mountHub() {
  const what = page === 'math' ? 'program' : 'game';
  const cards = [...document.querySelectorAll('.entry-content .wp-block-media-text')]
    .map(card => ({ card, a: card.querySelector('a[href^="/downloads/ce/"]') }))
    .filter(x => x.a && /\.(8xg|8xp|zip)$/i.test(x.a.getAttribute('href')));
  if (!cards.length) return;
  watchDownloads(document);
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
// is connected, then Send, or Delete when the game is already on it (Delete
// on). The arrow offers the rest.
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
    status.innerHTML = html && kind !== 'busy' ? CLOSE_X + html : html;
    status.className = `ce-card-status is-${kind}`;
    return status;
  };
  const say = t => {
    if (t) show(`<p>${esc(t)}</p>`, 'busy');
    else if (status.classList.contains('is-busy')) show('', '');
  };
  const send = () => {
    closeMenus();
    run({ file, label, say, show });
  };
  const remove = () => removeGame({ file, label, say, show });
  status.addEventListener('click', e => {
    if (e.target.closest('.ce-close')) show('', '');
    else if (e.target.closest('.ce-send-again')) send();
  });
  let mode = '';
  const here = presence(file, label, () => paint(), { fetchGame: false });
  const paint = () => {
    const want = !(link && calc) ? 'download' : here() ? 'delete' : 'send';
    if (want !== mode) {
      mode = want;
      split.classList.toggle('is-delete', mode === 'delete');
      split.innerHTML = splitHtml(mode, { href, label });
      wireSplit(split, mode, { send, remove });
    }
    // The connect on load opens the calculator too: a click then would open it twice.
    split.querySelectorAll('button').forEach(b => { b.disabled = busy || connecting; });
  };
  listeners.add(paint);
  paint();
}

function mount() {
  if (!navigator.usb) return;
  // A CE on a phone's USB port is untested, so phones keep the downloads only.
  const mobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) return;
  // The path as the server reads it: Cloudflare serves these pages at a
  // doubled slash or an escaped letter too, and the browser keeps that spelling.
  let here = location.pathname;
  try { here = decodeURIComponent(here); } catch { /* a stray %: keep it as it is */ }
  here = here.replace(/\/{2,}/g, '/');
  const at = path => here === path || here === path + 'index.html';
  // A tag that carries the math list makes this the math page wherever it is
  // served, so its Delete can only go by content.
  page = OWN_URL ? 'math' : at(HUB) ? 'hub' : at(MATH) ? 'math' : 'game';
  watchHelp(document);
  watchMenus();
  if (page === 'game') mountGame();
  else mountHub();
  // An out-of-space list follows the listing, and its Deletes wait for the
  // cable and for other work.
  listeners.add(followSpaceLists);
  // Send again inside a message waits for other work, like the card's own buttons.
  listeners.add(() => document.querySelectorAll('.ce-send-again').forEach(b => { b.disabled = busy || connecting; }));
  // Last, so it runs after the panels repaint: a box whose key was painted
  // away closes, one whose key moved follows it.
  const keyHelp = mountKeyHelp('ce', { onOpen: () => track('ce_key_help', { page }) });
  listeners.add(() => keyHelp.refresh());
  refreshPresent();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
