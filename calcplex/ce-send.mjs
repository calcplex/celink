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
// Before a calculator is connected, the arrow also offers Delete from
// calculator (Delete on): it connects as Send does, then runs that card's
// Delete, confirm and all, when the calculator has the game. Nothing is sent.
// A Sent message for an assembly game ends with a help link, which opens
// answers for the calculator's route; on the math page, where programs arrive
// archived on 5.3 and later, it ends with "Can't find it?". Wherever a sentence names the prgm
// key, the key carries a "?" that shows it on the keypad. Wherever words
// ask for the game to be sent again, a Send again button sits beside them.
// A game or program on the connected calculator, including one this page just
// sent, gets "Played it? Rate it:" ("Used it?" on the math page) and five
// stars under its card.
// Without WebUSB, or on a phone, the page keeps its download buttons only.
// Another script on the page (a help panel, say) can follow what is on the
// connected calculator: see announceContents below.
// The page's build puts the connect panel in the HTML (#ce-conn) in the
// words painted first here, so nothing pops in when this loads; where
// this would not mount, <html> is ce-nosend and the panel shows a one-line note.
import {
  PROGRAMS, sendGame, collectEntries, checkSpace, planInstall, deleteGame, freeRamAgain, isAssembly, inspect, jailbreakState, shellLabel, listedOnCalculator, planDelete, readyEach, spaceGames,
  unpackZip, pickCalculator, keepOwned, ownedHere, ownedAfterSend, ownedAfterFailedSend, ownedAfterDelete,
} from './gamesend.mjs';
import {
  DELETE_REASONS, FEEDBACK_FORM, FEEDBACK_MAX, FIND_HELP_OPEN, PREVIEW_HOST, RATE_ASK_AT, RATE_STARS, SEND_AGAIN, TICONNECT_URL, archiveMode, asksSendAgain, calcParams, deleteParams, deleteReasonReporter, downloadParams, esc, failReason,
  jbPromptChoice, keyHelpHtml, mountKeyHelp, outOfSpace, presenceTracker, refusedAt, isChromeOS, isWindows, linkDead, pageErrorText, refusal, spaceListChange,
  feedbackText, sendFeedback, startHelpAnswer, startHelpChoices, startHelpShown, startHint, startReporter, track, trackConnectFail, withKeyHelp, findHelpAnswer, findHelpShown,
  rateParams, ratedNote, ratedStars, rememberRating, rememberRatingNote, rememberSend, sentAgo, evoAddress, evoHtml, evoText, isEvoDevice,
  openDetail, tabHandoff, TAB_BUSY_TEXT, joinLabels, partsOf, baseOf, needsAsm, sendOutcome, stallLog, stallText, stallDetail, modal,
} from './core.mjs';
import { CELink } from '../celink.mjs';

// The script tag can set the page up for markup other than this site's own:
// data-ce-page (hub, game or math, instead of reading it from the path),
// data-ce-cards (the hub's cards), data-ce-title (a card's title),
// data-ce-button (the element around a card's download link), data-ce-panel
// (the element the connect panel goes before), data-ce-installer (the
// jailbreak installer's address; one on another site opens in a new tab),
// data-ce-evo (the address of the site's TI-84 Evo page, linked when the
// student picks an Evo; one on another site opens in a new tab),
// data-ce-prompt (the panel's sentence before a calculator is connected),
// data-ce-split="off" (no arrow menu: the card's own download button until a
// calculator is connected, then Send to calculator with a download link under
// it; Delete is not offered) and data-ce-status="after" (a card's messages go
// right after the card instead of inside it, marked data-slot with the card's
// place among the cards beside it, so a stylesheet can lay them out).
// With data-ce-split="off": data-ce-send-label (the Send button's words) and
// data-ce-swap-download="off" (no download link under it; a student who wants
// the file unplugs, or the download-first gate links it). data-ce-progress=
// "bar" adds a bar under a card's Sending… line. data-ce-ram is the address of
// the measured free RAM each game needs to start (gamesend's ramToStart), and
// data-ce-parts the address of the games whose optional parts a send can
// leave out when the archive is short (core's partsOf, gamesend's sendGame).
const SETUP = document.querySelector('script[src*="/ce-send.mjs"]')?.dataset ?? {};
const INSTALLER = SETUP.ceInstaller || '/ti84plusce-jailbreak-tutorial/';
const INSTALLER_TARGET = /^https?:\/\//.test(INSTALLER) ? ' target="_blank" rel="noopener"' : '';
const HUB = '/downloads/ti84plusce/games/';
const MATH = '/downloads/ti84plusce/math/';
// Send first (data-ce-first on a game page's script tag): the connect card leads, one centred split in every state
// (Connect, Send or Delete, with "Download .zip" under its arrow) in place of
// the hidden download button, and a failed connect or send offers the file.
// A DOWNLOAD_FIRST game takes two steps in the same card: its download as the
// card's button (GATE_TEXT), then the Connect split.
const FIRST = SETUP.ceFirst != null;
const GATE_TEXT = label => `${esc(label)}'s author asked that the license and readme come with the game, so download it first and read them. Then you can send it here.`;
const GATE_DONE = 'Downloaded. Now connect your calculator to send it.';
const GATE_SEND = 'Downloaded. Now click Send to calculator to send it.';
const firstLabel = file => `Download .${file.split('.').pop().toLowerCase()}`;

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
// type. Off: the math page deletes by name and type like the games, so a
// modified copy can be deleted too, and the confirm is the only guard. The
// content path below stays behind this switch.
const byContent = () => false;

const shortOs = os => String(os).split('.').slice(0, 3).join('.');
const jailbreakLink = text => `<a href="${INSTALLER}"${INSTALLER_TARGET}>${text}</a>`;
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
// Send first: under a failed connect or send, the file (not for a TI-84 Evo, sent to its own page).
const failDownload = (file, err) => (FIRST && failReason(err) !== 'evo'
  ? `<p class="ce-fail-dl"><a href="${esc(encodeURI(file))}"${downloadLinkAttrs()}>Download the file instead</a></p>` : '');
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
    // Send first: a DOWNLOAD_FIRST card moves on to Connect, after the click's own
    // download (a link the repaint removed mid-click would not download).
    if (FIRST) setTimeout(changed, 0);
    const params = downloadParams(file, page, link && calc);
    // `from: 'fail'`: the Send-first link under a failed connect or send.
    if (params) track('ce_download', a.closest('.ce-fail-dl') ? { ...params, from: 'fail' } : params);
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

// The measured free RAM to start, { NAME: { size, ram } }, read once per
// page and started with the first send. A failed fetch is forgotten, so the
// next send tries again; one that has not come in 5 s counts as none, and the
// send warns by its own estimate.
let ramList = null;
function loadRam() {
  if (!ramList) {
    const list = SETUP.ceRam
      ? fetch(SETUP.ceRam).then(r => { if (!r.ok) throw refusal('FETCH', 'no RAM list'); return r.json(); })
        .then(l => (l && typeof l === 'object' && !Array.isArray(l) ? l : {}))
      : Promise.resolve({});
    ramList = list;
    list.catch(() => { if (ramList === list) ramList = null; });
  }
  return ramList;
}

// The games with optional parts, { NAME: { base, parts } }, read once per
// page like the RAM list, and the same way: a list that does not come is
// none, and the send is all or nothing as before.
let partsList = null;
function loadParts() {
  if (!partsList) {
    const list = SETUP.ceParts
      ? fetch(SETUP.ceParts).then(r => { if (!r.ok) throw refusal('FETCH', 'no parts list'); return r.json(); })
        .then(l => (l && typeof l === 'object' && !Array.isArray(l) ? l : {}))
      : Promise.resolve({});
    partsList = list;
    list.catch(() => { if (partsList === list) partsList = null; });
  }
  return partsList;
}

// `promise`, or a rejection once `ms` have passed.
const capped = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('too slow')), ms);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});

// A list that has not come in 5 s counts as none, so a slow fetch only ever
// costs the Delete, never a message.
const ownNow = () => capped(loadOwn(), 5000).catch(() => []);
const ramNow = () => capped(loadRam(), 5000).catch(() => ({}));
const partsNow = () => capped(loadParts(), 5000).catch(() => ({}));
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
const DEFRAG_TEXT = 'Your calculator is defragmenting its memory to make room. This can take a minute. Keep it plugged in.';
const LOST_TEXT = 'The calculator stopped responding. If a game is running on it, quit the game and try again. Otherwise, unplug it, plug it back in, and try again.';
// The math page's things are programs.
const LOST_TEXT_MATH = 'The calculator stopped responding. If a program is running on it, quit it and try again. Otherwise, unplug it, plug it back in, and try again.';
const lostText = () => (page === 'math' ? LOST_TEXT_MATH : LOST_TEXT);
// A listing that went silent part way (core's stalledListing) is a calculator
// to turn off and on, and the second time in this tab one whose RAM needs a
// reset; a connect that times out after one is the same silence. Counted per
// tab in sessionStorage.
const stalls = stallLog(() => window.sessionStorage);
const OUTCOME_TEXT = {
  no_device: "No calculator was picked. Make sure it's plugged in and turned on, then try again. Not in the list? Try a different USB cable; charge-only cables won't work.",
  open_failed: "Couldn't connect. Close anything else using the calculator (like TI Connect CE or another tab), unplug it and plug it back in, then try again.",
  calc_busy: 'The calculator is busy. Press clear a few times to get back to the home screen, then try again.',
};
// On Windows a claim the browser refuses is TI Connect CE or another tab
// holding the calculator. An open refused for security is a driver the
// browser can't open the calculator through, which the latest TI Connect CE
// replaces.
const WINDOWS_TEXT = {
  no_device: 'Calculator not in the list? On Windows it only shows up once TI Connect CE is installed. If it is, update it to the latest version from TI, make sure the calculator is on, then try again.',
  open_failed: "Couldn't connect. Close TI Connect CE and any other tab using the calculator, unplug it and plug it back in, then try again.",
};
const WINDOWS_SECURITY_TEXT = "Windows won't let the page use the calculator yet. Update TI Connect CE to the latest version from TI, then unplug the calculator, plug it back in and try again.";
const CHROMEOS_TEXT = {
  open_failed: "Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then try again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};

// This page's sentences by reason, the platform's own first. A function of
// the page, which mount() sets after this module loads.
// After a click through to an installer on another site, a refused open is
// most likely that tab still holding the calculator: name it first.
const INSTALLER_TAB_TEXT = { open_failed: "Couldn't connect. Close the jailbreak tab and anything else using the calculator (like TI Connect CE or another tab), unplug it and plug it back in, then try again." };
const ownText = err => ({ ...OUTCOME_TEXT, link_lost: lostText(), timeout: stallText(err, { page, route: calc?.route }) ?? lostText(), evo: evoText(page), ...(CROS ? CHROMEOS_TEXT : {}), ...(WIN ? WINDOWS_TEXT : {}), ...(wentToInstaller ? INSTALLER_TAB_TEXT : {}), ...(WIN && openDetail(err) === 'open_security' ? { open_failed: WINDOWS_SECURITY_TEXT } : {}) });
const errorText = err => pageErrorText(err, { page, own: ownText(err) });
// errorText as HTML: a TI-84 Evo gets a link to the site's Evo page.
const errorHtml = err => (failReason(err) === 'evo' ? evoHtml(page, evoAddress(page, SETUP.ceEvo)) : esc(errorText(err)));

// One link per page, opened on the first click that needs it, or on load when
// the browser already allowed a plugged-in calculator on this site.
let page = 'game';
let link = null, calc = null;
let busy = false, connecting = false, present = false, sendAnyway = false;
// The installer on another site opens in a new tab, and this tab's open link
// would keep the calculator from it. A click on it lets the calculator go and
// parks: no connecting on our own until the student clicks Connect again.
// Another tab of this site taking the calculator parks this one too
// (`handoff`); `parkedFor` is who took it: 'installer' or 'page'.
let parked = false, wentToInstaller = false, parkedFor = '';
const listeners = new Set();
// Only one tab can hold the calculator. A Connect click asks this site's other
// tabs to let it go first; one that is sending or deleting keeps it, and the
// click says to wait. This tab lets it go the same way: never mid-job, and
// then it parks.
const handoff = tabHandoff({
  holding: () => !!link,
  busy: () => busy,
  park: who => {
    parked = true;
    parkedFor = who;
    changed();
  },
  release: async () => {
    const l = link;
    link = null;
    calc = null;
    if (l) await l.close().catch(() => {});
    changed();
  },
});
const changed = () => {
  handoff.held(!!link);
  listeners.forEach(f => f());
};

async function refreshPresent() {
  try {
    // A TI-84 Evo the student once picked is not a calculator to connect to.
    present = (await CELink.granted()).some(d => !isEvoDevice(d));
  } catch {
    present = false;
  }
  // Never while another tab of this site holds it: that tab keeps it.
  const free = () => present && !link && !busy && !connecting && !parked;
  if (free() && !(await handoff.othersHold()) && free()) {
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
  if (!quiet) {
    parked = false;
    parkedFor = '';
  }
  if (!quiet && !(await askTIConnect())) throw refusal('CANCELLED', 'The TI Connect CE question was dismissed.');
  // Started, not awaited: the picker needs the click's permission, so nothing
  // is awaited before it.
  const pending = page === 'math' && deleteOn() && byContent() ? loadOwn() : null;
  say(present ? 'Connecting to your calculator…' : 'Select your calculator in the popup…');
  let l;
  try {
    l = await pickCalculator();
    // After the picker, which needs the click's permission: a calculator
    // another tab holds is one this site was allowed, so no picker shows.
    if (!quiet && (await handoff.claim()) === 'busy') throw refusal('TAB_BUSY', TAB_BUSY_TEXT);
    say('Connecting to your calculator…');
    await l.open();
    // No list in 5 s means no Delete this time, never a slower connect.
    const own = pending ? await capped(pending, 5000).catch(() => []) : [];
    calc = await inspect(l, { own });
    // Another tab's Connect click came while this one connected on its own.
    if (quiet && parked) throw refusal('CANCELLED', 'Another tab took the calculator.');
  } catch (err) {
    if (l) await l.close().catch(() => {});
    calc = null;
    stalls.note(err, { connecting: true });
    // The picked device, when there was one: a calculator that is not a CE
    // reports its USB product id.
    if (!quiet) trackConnectFail(err, { page }, l?.device);
    throw err;
  }
  link = l;
  track('ce_calc_info', { ...calcParams(calc), route: calc.route, page, jb: jailbreakState(calc.route, calc.tools) });
  await announceContents({ fresh: false });
  refreshPresent();
  return calc;
}

// What is on the calculator, for another script on the page: with
// window.ceSendContents set to true before a listing is taken (at connect,
// after a send, after a delete), the page reads the free memory again and
// dispatches 'ce-send:contents' on window, detail { ramFree, archiveFree,
// rows }: free bytes as read (null when the calculator refused the read),
// and the listing's rows { name, type, typeName, size, archived }. The event stays in the page; nothing here sends it
// anywhere. Without the flag nothing extra is read and no event goes out.
const contentsWatched = () => typeof window !== 'undefined' && window.ceSendContents === true;
async function announceContents({ fresh = true } = {}) {
  if (!contentsWatched() || !link || !calc) return;
  if (fresh) {
    let free = { ramFree: null, archiveFree: null }; // a refused read: not known now
    try {
      // Free RAM read as 0 is read once more; a second 0 is not known.
      const l = readyEach(link);
      const i = await freeRamAgain(l, await l.info());
      free = { ramFree: i.ramFree, archiveFree: i.archiveFree };
    } catch (err) {
      if (linkDead(err)) {
        await drop();
        return;
      }
    }
    if (calc) Object.assign(calc, free);
  }
  if (!calc) return;
  try {
    const rows = (calc.rows ?? []).map(r => ({ name: r.name, type: r.type, typeName: r.typeName, size: r.size, archived: r.archived }));
    window.dispatchEvent(new CustomEvent('ce-send:contents', { detail: { ramFree: calc.ramFree, archiveFree: calc.archiveFree, rows } }));
  } catch { /* a listener never breaks the page */ }
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
window.addEventListener('pagehide', () => {
  if (link) link.close().catch(() => {});
  handoff.held(false);
});
if (INSTALLER_TARGET) {
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.getAttribute('href') !== INSTALLER || !(link || present)) return;
    parked = true;
    parkedFor = 'installer';
    wentToInstaller = true;
    const l = link;
    link = null;
    calc = null;
    if (l) l.close().catch(() => {});
    changed();
  }, true);
}

// The popups below are core's modal().

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
      <p class="ce-modal-actions"><a class="ce-modal-go" href="${INSTALLER}"${INSTALLER_TARGET}>Jailbreak it now</a>
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
    // No jailbreak on 5.4 and earlier, so no A: say how games start there.
    case 'none': return `${connected(os)}. ${where} ${needsAsm(c.os) ? 'No jailbreak needed: games start through Asm( on this version.' : `No jailbreak needed: games start from the ${keyHelpHtml('ce')} menu.`}`;
    case 'found': return `${connected(`${os}, jailbroken`)}. ${where} ${c.route === 'v21' ? `Games start from ${keyHelpHtml('ce')}, then A.` : `Games start from the ${keyHelpHtml('ce')} menu.`}`;
    case 'shell': return `${connected(`${os}, jailbroken`)}. ${where} Games start from ${esc(shellLabel(c.route, c.tools))}.`;
    case 'missing': return `${connected(os)}. It needs a jailbreak before games will run: ${jailbreakLink('jailbreak it first')}, then come back and send games.`;
    default: return `${connected(os)}. There's no jailbreak for this version yet, so these games won't run on it.`;
  }
}

const IN_OTHER_TAB = 'Your calculator is connected in another tab. Click Connect to use it here.';
function statusHtml(where) {
  if (link && calc) return verdict(calc, where);
  if (connecting) return 'Connecting to your calculator…';
  if (parked && parkedFor === 'page') return IN_OTHER_TAB;
  if (parked && where.startsWith('Pick')) return 'When you’re done jailbreaking, connect your calculator again.';
  if (SETUP.cePrompt && where.startsWith('Pick')) return esc(SETUP.cePrompt);
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
    // Send first: the game page's card goes back to its Download step, never a warning.
    if (FIRST && page === 'game') {
      changed();
      return;
    }
    // This site's own hub (a tag with no data-ce-* layout setup): the same
    // neutral first step in the card's message, with the card's download.
    if (!SETUP.cePage) {
      const box = show(`<p>${GATE_TEXT(label)}</p><p><a class="ce-gate-go" href="${esc(encodeURI(file))}"${downloadLinkAttrs()}>Download ${esc(label)}</a></p>`, 'gate');
      // After the click's own download, the message says what comes next.
      box?.querySelector('.ce-gate-go')?.addEventListener('click', () =>
        setTimeout(() => show(`<p>${GATE_SEND}</p>`, 'gate'), 0));
      return;
    }
    show(`<p>${gate(t => `<a href="${esc(encodeURI(file))}" class="ce-gate-dl"${downloadLinkAttrs()}><strong>${t}</strong></a>`)}</p>`, 'warn');
    return;
  }
  busy = true;
  changed();
  const launchRam = ramNow();
  const partsListed = partsNow();
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
    let pct = 0;
    const sending = p => { pct = p; say(`Sending ${label} to your calculator… ${p}%`, p); };
    sending(0);
    const listed = await partsListed;
    let r;
    try {
      r = await sendGame(link, files, {
        verify: 'full',
        archive: archiveMode(page, main?.name),
        launchRam: await launchRam,
        parts: partsOf(listed, main?.name),
        // A game with parts that does not fit even without them is refused with its smallest install's figures.
        base: baseOf(listed, main?.name),
        onProgress: (done, total) => { if (total) sending(Math.min(99, Math.round(done / total * 100))); },
        // The calculator shows "Defragmenting..." meanwhile; the next progress replaces this.
        onBusy: () => say(DEFRAG_TEXT, pct),
      });
    } catch (err) {
      // A listing before or between the files that went silent; the link drops below.
      if (stalls.note(err)?.stalls) err.route ??= c.route;
      const stall = stallDetail(err);
      track('ce_send_fail', { game, reason: failReason(err), page, ...refusedAt(err), ...(err?.defrag ? { defrag: 1 } : {}), ...(stall ? { open_detail: stall } : {}) });
      if (linkDead(err)) await drop();
      // A send that stopped part way may have left files, which Delete offers to remove.
      // On the math page a copy it may have changed is no longer known to be ours.
      else if (deleteOn() || contentsWatched()) {
        if (calc) calc.owned = ownedAfterFailedSend(calc.owned, err, entries.map(e => e.name));
        await refreshRows();
      }
      throw err;
    }
    // `retried: 1`: the space check passed only on a second read of the calculator.
    track('ce_send_success', { game, outcome: sendOutcome(r), route: r.route, page, ...(r.rechecked ? { retried: 1 } : {}), ...(r.defrag ? { defrag: 1 } : {}) });
    // A game that just arrived gets stars too; a vote on it carries the minutes since this send.
    if (!r.replaced.length) rememberSend('ce:' + file);
    // A math program read back whole as a version the site served is ours, so its card turns to Delete.
    if (page === 'math' && deleteOn() && byContent()) {
      const owned = await ownedAfterSend(calc?.owned, r, entries, await ownNow());
      if (calc) calc.owned = owned;
    }
    if (deleteOn() || contentsWatched()) await refreshRows();
    say('');
    const partial = r.leftOut.length || r.added.length ? partsHtml(r, listed, main?.name, label) : null;
    // A send that left parts out for space offers the games that could make room, as a refusal does.
    const games = r.leftOut.length && deleteOn() && link ? await loadGames().catch(() => null) : null;
    const list = games ? spaceList({ memory: 'archive', lastReason: 'partial', sending: file, sendingLabel: label, games, calc, say, show }) : null;
    const box = show(sentHtml(r, main, asm, c, partial) + (list?.html ?? ''), 'ok');
    list?.wire(box);
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
    const text = `<p>${errorHtml(err)}${again ? ` ${SEND_AGAIN_HTML}` : ''}</p>${failDownload(file, err)}`;
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
// A card marked data-ce-app="<name>" is an app that installs through its own
// module (an app's setup files and its steps at the calculator), which
// registers window.ceSendOwn[<name>] = job. Its Send connects as any card's
// does, then lends the job this page's link: job({ link, calc }) runs with
// every other button held and resolves { rows, dead }: its last listing of
// the calculator (this page takes no new one, since the student may be
// running the app's setup by then) and whether the link died.
async function runOwn(name, { file, say, show }) {
  const job = window.ceSendOwn?.[name];
  if (busy || connecting || typeof job !== 'function') return;
  busy = true;
  changed();
  try {
    await connect(say);
    say('');
    const r = await job({ link, calc });
    if (r?.dead) await drop();
    else if (Array.isArray(r?.rows) && calc) {
      calc.owned = keepOwned(calc.owned, r.rows);
      calc.rows = r.rows;
    }
  } catch (err) {
    say('');
    if (linkDead(err)) await drop();
    if (err?.code !== 'CANCELLED') show(`<p>${errorHtml(err)}</p>${failDownload(file, err)}`, 'bad');
  } finally {
    busy = false;
    changed();
  }
}

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
    // A silent listing here shows nothing, but the next connect's words count it.
    stalls.note(err);
    if (linkDead(err)) await drop();
    return;
  }
  await announceContents();
}

// What a send of a game with optional parts says before how to start it,
// when it left parts out or only added the missing ones: what went, and
// what did not with the archive to free so Send again adds it. The game's
// entry in the parts list names them: its `base` (what the required files
// hold), the parts, and `whole` (all of it).
function partsHtml(r, listed, name, label) {
  const entry = listed?.[name] ?? {};
  let lead;
  if (r.added.length) lead = `Sent ${esc(joinLabels(r.added))}.`;
  else {
    const went = typeof entry.base === 'string' ? [entry.base, ...partsOf(listed, name).map(p => p.label).filter(l => !r.leftOut.includes(l))] : [];
    lead = went.length ? `Sent, with ${esc(joinLabels(went))}.` : 'Sent!';
  }
  if (!r.leftOut.length) {
    return `<strong>${lead}</strong> ${typeof entry.whole === 'string' ? `${esc(label)} now has ${esc(entry.whole)}.` : ''}`.trim();
  }
  const them = r.leftOut.length === 1 ? 'it' : 'them';
  const free = r.addKB > 0
    ? `To add ${them}, delete about ${r.addKB.toLocaleString('en-US')} KB of programs you don't need (2nd, +, 2: Mem Management), then click ${SEND_AGAIN_HTML}`
    : `To add ${them}, click ${SEND_AGAIN_HTML}`;
  return `<strong>${lead}</strong> Your calculator didn't have room for ${esc(joinLabels(r.leftOut))}. ${free}`;
}

let helpPanels = 0;
function sentHtml(r, main, asm, c, partial = null) {
  const state = jailbreakState(r.route, c.tools);
  // A shell starts games from inside itself, so its sentence names no key.
  const how = !main ? '' : asm && state === 'shell' ? `Start ${main.name} from ${shellLabel(r.route, c.tools)}.`
    // A TI-Basic program: the first enter pastes prgmNAME on the home screen, the second runs it.
    : asm ? startHint(r.os, main.name) : `Press prgm, pick ${main.name}, and press enter twice.`;
  const lower = withKeyHelp(how.charAt(0).toLowerCase() + how.slice(1), 'ce');
  // A send that left parts out says so first, and its own first words replace "Sent!".
  const html = partial ? [`<p>${partial}</p>`] : [];
  const sent = partial ? '' : '<strong>Sent!</strong> ';
  if (asm && state === 'missing') {
    html.push(`<p>${sent}It won't start until your calculator is jailbroken: ${jailbreakLink('jailbreak it now')}, then ${lower}</p>`);
  } else if (main && startHelpShown(page, asm, state)) {
    const id = `ce-help-${++helpPanels}`;
    html.push(`<p>${sent}To play it, ${lower} <button type="button" class="ce-help-open" aria-expanded="false" aria-controls="${id}">Game didn't start?</button></p>`,
      helpPanel(id, { route: r.route, jb: state, game: main.name, os: r.os, shell: shellLabel(r.route, c.tools) }));
  } else if (main && findHelpShown(page, r.os)) {
    const id = `ce-help-${++helpPanels}`;
    html.push(`<p>${sent}To run it, ${lower} <button type="button" class="ce-help-open" aria-expanded="false" aria-controls="${id}">Can't find it?</button></p>`,
      findPanel(id, { route: r.route, game: main.name, os: r.os }));
  } else {
    html.push(`<p>${sent}To ${page === 'math' ? 'run' : 'play'} it, ${lower}</p>`);
  }
  for (const w of r.warnings) {
    if (w.code !== 'LOW_RAM_TO_RUN') continue;
    const what = page === 'math' ? 'program' : 'game';
    // A measured figure is worth naming; the estimate is only a lower bound.
    html.push(w.measured
      ? `<p>Your calculator is low on RAM (${w.freeKB} KB free) and this ${what} needs about ${w.needKB} KB to start, so it may stop with ERROR: MEMORY. Delete or archive about ${w.shortKB} KB of programs you don't need (2nd, +, 2: Mem Management).</p>`
      : `<p>Your calculator is low on RAM (${w.freeKB} KB free), so the ${what} may stop with ERROR: MEMORY. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management).</p>`);
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
function wireWhy(box, { game, label, os, route, lastReason }) {
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
    const ask = FEEDBACK_ASK[pick.dataset.why];
    if (ask) line.insertAdjacentHTML('afterend', feedbackHtml(label || game, { ask, why: pick.textContent, os, route }));
  });
}

// The feedback box: one text field into the feedback form, under "Why did
// you delete it?" after the two answers that leave a question open. What
// the page knows (the game, the answer, the OS) rides in front of the
// words; one listener (watchFeedback) sends every box on the page. A box
// with a post in flight is marked data-busy, and typing in it does not
// re-enable Send. A preview (PREVIEW_HOST) posts nothing: the row goes to the
// console and the box thanks as if it went.
const FEEDBACK_ASK = { didnt_work: "What didn't work?", didnt_like: 'What could be improved?' };
// ce_feedback's choice, from the answer's words the box keeps.
const FEEDBACK_ASK_IDS = Object.fromEntries(DELETE_REASONS.map(([id, text]) => [text, id]));
let feedbackBoxes = 0;
// The stars' box: `note` replaces "deleted: <why>" in the tag, `choice`
// ce_feedback's choice, `closable` adds an X, `rateKey` keeps the words sent
// for that vote and `text` starts the box with the words sent last time.
function feedbackHtml(label, { ask, why = '', os = '', route = '', note = '', choice = '', closable = false, rateKey = '', text = '' }) {
  const id = `ce-fb-${++feedbackBoxes}`;
  return `<div class="ce-fb" data-game="${esc(label)}" data-why="${esc(why)}" data-os="${esc(os)}" data-route="${esc(route)}" data-note="${esc(note)}" data-choice="${esc(choice)}" data-rate-key="${esc(rateKey)}">`
    + (closable ? '<button type="button" class="ce-fb-close" aria-label="Close">×</button>' : '')
    + `<label for="${id}">${esc(ask)}</label>`
    + `<textarea id="${id}" rows="3" maxlength="${FEEDBACK_MAX}">${esc(text)}</textarea>`
    + `<p class="ce-fb-row"><button type="button" class="ce-fb-send"${text.trim() ? '' : ' disabled'}>Send</button></p></div>`;
}

// The tag in front of the words, from the box's own data.
function feedbackParts(fb) {
  const d = fb.dataset;
  return ['CE', d.game, d.note || `deleted: ${d.why}`, d.os && `OS ${shortOs(d.os)}`, d.route, location.pathname, PREVIEW_HOST ? 'PREVIEW' : ''];
}

function watchFeedback(root) {
  root.addEventListener('input', e => {
    const fb = e.target.closest?.('.ce-fb');
    if (fb) fb.querySelector('.ce-fb-send').disabled = fb.hasAttribute('data-busy') || !e.target.value.trim();
  });
  root.addEventListener('click', async e => {
    const go = e.target.closest?.('.ce-fb-send');
    if (!go) return;
    const fb = go.closest('.ce-fb');
    const text = fb.querySelector('textarea').value.trim();
    if (!text || fb.hasAttribute('data-busy')) return;
    fb.setAttribute('data-busy', '1');
    go.disabled = true;
    fb.querySelector('.ce-fb-err')?.remove();
    try {
      if (PREVIEW_HOST) console.info('[not sent: preview]', 'feedback', feedbackText(text, feedbackParts(fb)));
      else await sendFeedback(text, feedbackParts(fb));
      fb.removeAttribute('data-busy');
      if (fb.dataset.rateKey) rememberRatingNote(fb.dataset.rateKey, text);
      fb.innerHTML = '<p class="ce-fb-done">Thank you! We read every response and will do our best to improve.</p>';
      track('ce_feedback', { game: fb.dataset.game.slice(0, 40), page, choice: fb.dataset.choice || FEEDBACK_ASK_IDS[fb.dataset.why] || 'other' });
    } catch {
      fb.removeAttribute('data-busy');
      go.disabled = false;
      go.closest('.ce-fb-row').insertAdjacentHTML('afterend', `<p class="ce-fb-err">That didn't send. Try again, or <a href="${FEEDBACK_FORM}/viewform" target="_blank" rel="noopener">open the form</a>.</p>`);
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
// and nothing is deleted. `via` ('menu': the arrow's Delete from calculator,
// below) rides every ce_delete of the click as `from`.
async function removeGame({ file, label, say, show, space = null, via = '' }) {
  closeMenus();
  if (busy || !(link && calc)) return;
  // The files the game writes while it runs (high scores, settings), from the
  // games list; without the list, the game's own files only.
  const saves = byContent() ? [] : ((await capped(loadGames(), 5000).catch(() => null))?.find(g => g.file === file)?.saves ?? []);
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
  const withVia = params => (via ? { ...params, from: via } : params);
  const { os, route } = calc;
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
      : await deleteGame(link, files, { keep: KEEP, saves });
    // Both in one tick, so each card checks once: its presence follows `rows` and `owned`.
    if (calc) {
      calc.owned = ownedAfterDelete(calc.owned, r);
      calc.rows = r.rows;
    }
    await announceContents();
    say('');
    if (r.deleted.length) {
      track('ce_delete', withVia(deleteParams({ ...from, game, outcome: 'deleted', bytes: r.bytes })));
      outcome(`<p>${esc(label)} was deleted from your calculator.</p>`, 'ok', { game, label, os, route, lastReason });
    } else if (r.notOurs?.length) {
      track('ce_delete', withVia(deleteParams({ ...from, game, outcome: 'not_ours' })));
      outcome(`<p>The ${esc(r.notOurs[0].name)} on your calculator isn't the one from this page, so it wasn't deleted.</p>`, 'warn');
    } else {
      track('ce_delete', withVia(deleteParams({ ...from, game, outcome: 'nothing' })));
      outcome(`<p>${esc(label)} isn't on your calculator.</p>`, 'warn');
    }
  } catch (err) {
    say('');
    if (stalls.note(err)?.stalls) err.route ??= route;
    track('ce_delete', withVia(deleteParams({ ...from, game, outcome: 'failed', err })));
    if (linkDead(err)) await drop();
    else await refreshRows();
    outcome(`<p>${err?.code === 'READBACK' ? esc(`${label} is still on your calculator. Try again.`) : errorHtml(err)}</p>`, 'bad');
  } finally {
    busy = false;
    changed();
  }
}

// Delete from calculator under the arrow, before a calculator is connected:
// connect as Send does (the TI Connect CE question, the picker, the same
// failure words through `failed`, without the file, which a failed Delete
// never offers either), then the card's own Delete when the listing has its
// game, by the rule the card's main button follows (`fetchGame` as its
// presence check has it). A game that is not there says so, as a Delete that
// found nothing does. Nothing is ever sent.
async function removeFirst({ file, label, say, show, fetchGame, failed }) {
  closeMenus();
  if (busy || connecting) return;
  if (!(link && calc)) {
    await connectFromClick(say, failed);
    say('');
  }
  if (busy || !(link && calc)) return;
  const there = await gameOnCalculator(file, label, calc.rows, { fetchGame }).catch(() => false);
  if (busy || !(link && calc)) return;
  if (there) {
    await removeGame({ file, label, say, show, via: 'menu' });
    return;
  }
  const game = await gameName(file, label).catch(() => label.slice(0, 20));
  if (!calc) return;
  track('ce_delete', { ...deleteParams({ page, route: calc.route, game, outcome: 'nothing' }), from: 'menu' });
  show(`<p>${esc(label)} isn't on your calculator.</p>`, 'warn');
}

// Stars: "Played it? Rate it:" under the card of a game on the
// calculator, including one this page just sent (so the student sees stars
// exist before leaving). One vote per game per browser,
// by file, which can be changed; a vote goes out as ce_rate with the game's
// program name ('4'), a change as '4to2', either with '@Nm' when it comes
// within a day of this browser's fresh send (rememberSend), and three stars
// or fewer open the feedback box. The math page too, as "Used it?".
// ?rate=1 on localhost shows the first card's stars without a calculator.
const DEMO_RATE = PREVIEW_HOST && /[?&]rate=1\b/.test(location.search);
const STAR = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z" fill="currentColor"/></svg>';

// The game's name on the calculator: the games list's, else its download's main program.
async function gameName(file, label) {
  const listed = (await loadGames().catch(() => null))?.find(g => g.file === file)?.game;
  if (listed) return listed;
  const main = collectEntries(await bundle(file, label)).filter(e => PROGRAMS.includes(e.type)).at(-1);
  return main ? main.name : label.slice(0, 20);
}

// The stars row after `after`; the function it returns shows or hides it
// (`onCalc`: the card's game is on the connected calculator). A rated game
// shows "Your rating:" with its stars filled, and another star changes the
// vote (a great first impression can sour).
function mountRate(after, { file, label, demo = false }) {
  const key = 'ce:' + file;
  const row = document.createElement('div');
  row.className = 'ce-rate';
  row.hidden = true;
  row.innerHTML = '<span class="ce-rate-q"></span>'
    + `<span class="ce-stars" role="group" aria-label="Rate ${esc(label)}">`
    + Array.from({ length: RATE_STARS }, (_, i) => `<button type="button" data-stars="${i + 1}" aria-label="${i + 1} star${i ? 's' : ''}" aria-pressed="false">${STAR}</button>`).join('')
    + '</span><p class="ce-rate-done" aria-live="polite"></p>';
  after.after(row);
  const q = row.querySelector('.ce-rate-q');
  const done = row.querySelector('.ce-rate-done');
  let mine = 0;          // the vote this browser holds
  let votedHere = false; // a vote or change on this page keeps the row up
  const fill = () => {
    q.textContent = mine ? 'Your rating:' : `${page === 'math' ? 'Used it?' : 'Played it?'} Rate it:`;
    for (const b of row.querySelectorAll('[data-stars]')) {
      const n = Number(b.dataset.stars);
      b.classList.toggle('is-on', n <= mine);
      b.setAttribute('aria-pressed', String(n === mine));
    }
  };
  row.addEventListener('click', async e => {
    if (e.target.closest?.('.ce-fb-close')) {
      row.querySelector('.ce-fb')?.remove();
      return;
    }
    const pick = e.target.closest?.('[data-stars]');
    if (!pick) return;
    const n = Number(pick.dataset.stars);
    if (n === mine) return;
    const from = mine;
    mine = n;
    votedHere = true;
    rememberRating(key, n);
    fill();
    done.textContent = from ? 'Updated. Thanks for rating it!' : 'Thanks for rating it!';
    const since = sentAgo(key);
    const note = `rated ${n} of ${RATE_STARS}` + (from ? `, was ${from}` : '') + (since === null ? '' : `, ${since} min after sending`);
    const fb = row.querySelector('.ce-fb');
    if (fb?.querySelector('textarea')) fb.dataset.note = note;
    else if (n <= RATE_ASK_AT) {
      fb?.remove();
      const { os = '', route = '' } = calc || {};
      row.insertAdjacentHTML('beforeend', feedbackHtml(label, { ask: 'What could be improved?', os, route, note, choice: 'rated', closable: true, rateKey: key, text: ratedNote(key) }));
    }
    const params = rateParams({ game: await gameName(file, label).catch(() => label.slice(0, 20)), page, stars: n, from, since });
    if (params) track('ce_rate', params);
  });
  return onCalc => {
    if (!votedHere) { mine = ratedStars(key); fill(); }
    row.hidden = !(votedHere || onCalc || demo);
  };
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
  const built = document.getElementById('ce-conn');
  const card = built || document.createElement('div');
  card.className = 'ce-conn is-leaf';
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <p class="msg ce-leaf-msg"></p>
    <div class="ce-leaf-actions"></div>
    <p class="msg sub ce-leaf-progress" aria-live="polite"></p>
    <div class="ce-leaf-result" hidden></div>`;
  if (!built) (a.closest('.wp-block-button') || a).after(card);
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
    await connectFromClick(say, err => show(`<p>${errorHtml(err)}</p>${failDownload(file, err)}`, 'bad'));
    say('');
  };
  const remove = () => removeGame({ file, label, say, show });
  const removeHere = () => {
    if (busy || connecting) return;
    clearResult();
    removeFirst({ file, label, say, show, fetchGame: true, failed: err => show(`<p>${errorHtml(err)}</p>`, 'bad') });
  };
  result.addEventListener('click', e => {
    if (e.target.closest('.ce-close')) clearResult();
    else if (e.target.closest('.ce-send-again')) send();
  });
  let mode = '';
  const here = presence(file, label, () => paint(), { fetchGame: true });
  const rate = mountRate(card, { file, label, demo: DEMO_RATE });
  const paint = () => {
    const connected = !!(link && calc);
    const onCalc = connected && here();
    rate(onCalc);
    // Send first, a DOWNLOAD_FIRST game: its download is step one, in Connect's place.
    const gateGame = FIRST && !!DOWNLOAD_FIRST[file];
    const gated = gateGame && !onCalc && !wasDownloaded(file);
    msg.innerHTML = gated ? GATE_TEXT(label) : connected || connecting
      ? statusHtml(onCalc ? `${esc(label)} is already on your calculator.` : 'Click Send to calculator to install it.')
      : parked && parkedFor === 'page' ? IN_OTHER_TAB : gateGame ? GATE_DONE : 'Plug in your TI-84 Plus CE, turn it on, and click Connect to send this game.';
    const kind = statusKind();
    card.className = 'ce-conn is-leaf' + (kind ? ' ' + kind : outcome === 'bad' ? ' bad' : '');
    const want = gated ? 'gate' : !connected ? 'connect' : onCalc ? 'delete' : 'send';
    if (want !== mode) {
      mode = want;
      // Send first: the gate's download, then every state is the split, the
      // download under its arrow (the page's HTML already holds the Connect
      // one in these words).
      if (mode === 'gate') {
        actions.innerHTML = `<a class="ce-conn-go ce-gate-go" href="${href}"${downloadLinkAttrs()}>Download ${esc(label)}</a>`;
      } else if (mode === 'delete' || FIRST) {
        actions.innerHTML = `<div class="ce-split ce-leaf-split${mode === 'delete' ? ' is-delete' : ''}">${splitHtml(mode, { href, label, dl: FIRST ? firstLabel(file) : '', remove: deleteOn() })}</div>`;
        wireSplit(actions.firstElementChild, mode, { send: mode === 'connect' ? go : send, remove, removeFirst: removeHere });
      } else {
        actions.innerHTML = `<button type="button" class="ce-conn-go">${mode === 'send' ? 'Send to calculator' : 'Connect your calculator'}</button>`;
        actions.firstElementChild.onclick = go;
      }
    }
    actions.querySelectorAll('button').forEach(b => { b.disabled = busy || connecting; });
  };
  listeners.add(paint);
  changed();
  demoFeedback(show, label);
  demoSent(show, label, file);
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
// `remove`: before a calculator is connected ('connect', 'download'), Delete
// from calculator comes last under the arrow (removeFirst).
function splitHtml(mode, { href, label, dl = '', remove = false }) {
  const button = 'wp-block-button__link no-border-radius';
  const download = `<a role="menuitem" href="${href}"${downloadLinkAttrs()}>${esc(dl || 'Download file')}</a>`;
  const removeItem = remove ? '<button type="button" role="menuitem" class="ce-split-remove">Delete from calculator</button>' : '';
  const [main, items] = {
    connect: [`<button type="button" class="${button} ce-split-main">Connect your calculator</button>`, download + removeItem],
    download: [`<a class="${button} ce-split-main" href="${href}"${downloadLinkAttrs()}>Download</a>`,
      '<button type="button" role="menuitem" class="ce-split-send">Send to calculator</button>' + removeItem],
    send: [`<button type="button" class="${button} ce-split-main">Send to calculator</button>`, download],
    delete: [`<button type="button" class="${button} ce-split-main ce-danger" aria-label="Delete ${esc(label)} from calculator">Delete</button>`,
      `<button type="button" role="menuitem" class="ce-split-send">${esc(SEND_AGAIN.text)}</button>${download}`],
  }[mode];
  return main
    + `<button type="button" class="${button} ce-split-arrow" aria-label="More ways to get ${esc(label)}" aria-haspopup="menu" aria-expanded="false">${ARROW}</button>`
    + `<div class="ce-split-menu" role="menu" hidden>${items}</div>`;
}

// `send` and `remove` run the card's send and its Delete, `removeFirst` the
// menu's Delete from calculator.
function wireSplit(split, mode, { send, remove, removeFirst: first }) {
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
  split.querySelector('.ce-split-remove')?.addEventListener('click', first);
}

function mountHub() {
  const what = page === 'math' ? 'program' : 'game';
  const cards = [...document.querySelectorAll(SETUP.ceCards || '.entry-content .wp-block-media-text')]
    .map(card => ({ card, a: card.querySelector('a[href^="/downloads/ce/"]') }))
    .filter(x => x.a && /\.(8xg|8xp|zip)$/i.test(x.a.getAttribute('href')));
  if (!cards.length) return;
  watchDownloads(document);
  mountPanel((SETUP.cePanel && cards[0].card.closest(SETUP.cePanel)) || cards[0].card, `Pick a ${what} below and click ${esc(SETUP.ceSendLabel || 'Send to calculator')}${/[.!?]$/.test(SETUP.ceSendLabel || '') ? '' : '.'}`);
  for (const { card, a } of cards) mountSplit(card, a);
  changed();
}

function mountPanel(before, where) {
  const built = document.getElementById('ce-conn');
  const panel = built || document.createElement('div');
  panel.setAttribute('role', 'status');
  if (!built) before.before(panel);
  // HTML, from errorHtml.
  let panelError = '';
  listeners.add(() => {
    const kind = statusKind();
    panel.className = 'ce-conn' + (kind ? ' ' + kind : panelError ? ' bad' : '');
    if ((link && calc) || connecting) {
      panel.innerHTML = `<p class="msg">${statusHtml(where)}</p>`;
      return;
    }
    panel.innerHTML = `<p class="msg">${statusHtml(where)}</p>
      ${panelError ? `<p class="msg err">${panelError}</p>` : ''}
      <button type="button" class="ce-conn-go"${busy ? ' disabled' : ''}>Connect your calculator</button>`;
    const button = panel.querySelector('.ce-conn-go');
    button.onclick = () => {
      if (busy) return;
      panelError = '';
      connectFromClick(t => { button.textContent = t; button.disabled = true; }, err => { panelError = errorHtml(err); }, { repaint: false });
    };
  });
}

// The main half is what the student can do now: Download until a calculator
// is connected, then Send, or Delete when the game is already on it (Delete
// on). The arrow offers the rest.
function mountSplit(card, a) {
  const file = decodedHref(a);
  const label = (card.querySelector(SETUP.ceTitle || 'h2')?.textContent || '').trim() || (page === 'math' ? 'This program' : 'This game');
  const old = a.closest(SETUP.ceButton || '.wp-block-button') || a;
  const href = esc(a.getAttribute('href'));
  const swap = SETUP.ceSplit === 'off';
  const split = document.createElement('div');
  split.className = swap ? 'ce-swap' : 'wp-block-button floated ce-split';
  old.after(split);
  if (!swap) old.style.display = 'none';
  const status = document.createElement('div');
  status.className = 'ce-card-status';
  status.setAttribute('role', 'status');
  if (SETUP.ceStatus === 'after') {
    const beside = [...card.parentElement.children].filter(el => el.matches(SETUP.ceCards || '.entry-content .wp-block-media-text') && el.querySelector('a[href^="/downloads/ce/"]'));
    status.dataset.slot = String(beside.indexOf(card));
    card.after(status);
  } else [...card.querySelectorAll('.wp-block-button.floated')].at(-1).after(status);
  const show = (html, kind) => {
    status.innerHTML = html && kind !== 'busy' ? CLOSE_X + html : html;
    status.className = `ce-card-status is-${kind}`;
    return status;
  };
  const say = (t, pct) => {
    if (t) show(`<p>${esc(t)}</p>` + (pct != null && SETUP.ceProgress === 'bar' ? `<div class="ce-bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>` : ''), 'busy');
    else if (status.classList.contains('is-busy')) show('', '');
  };
  // A card marked data-ce-app installs through another module's job (runOwn).
  const app = card.dataset.ceApp;
  const send = () => {
    closeMenus();
    if (app) runOwn(app, { file, say, show });
    else run({ file, label, say, show });
  };
  const remove = () => removeGame({ file, label, say, show });
  // Not for an app card: its own module says whether it is there.
  const removeHere = () => removeFirst({ file, label, say, show, fetchGame: page === 'math', failed: err => show(`<p>${errorHtml(err)}</p>`, 'bad') });
  status.addEventListener('click', e => {
    if (e.target.closest('.ce-close')) show('', '');
    else if (e.target.closest('.ce-send-again')) send();
  });
  let mode = '';
  // The math hub has no games list, so its few small downloads say what each card sends.
  const here = app ? () => false : presence(file, label, () => paint(), { fetchGame: page === 'math' });
  // Send-only cards (data-ce-split="off") never offer stars, so they get no row.
  const rate = swap ? () => {} : mountRate(status, { file, label, demo: DEMO_RATE && card === document.querySelector('.wp-block-media-text') });
  const paint = () => {
    if (swap) return paintSwap();
    const want = !(link && calc) ? 'download' : here() ? 'delete' : 'send';
    rate(want === 'delete');
    if (want !== mode) {
      mode = want;
      split.classList.toggle('is-delete', mode === 'delete');
      split.innerHTML = splitHtml(mode, { href, label, remove: deleteOn() && !app });
      wireSplit(split, mode, { send, remove, removeFirst: removeHere });
    }
    // The connect on load opens the calculator too: a click then would open it twice.
    split.querySelectorAll('button').forEach(b => { b.disabled = busy || connecting; });
  };
  // Without the arrow: the page's own button until a calculator is connected,
  // then Send to calculator in the same button style, a download link under it.
  const paintSwap = () => {
    const want = link && calc ? 'send' : 'download';
    if (want !== mode) {
      mode = want;
      old.style.display = mode === 'send' ? 'none' : '';
      split.hidden = mode !== 'send';
      split.innerHTML = mode !== 'send' ? '' : `<button type="button" class="ce-swap-send ${esc(a.className)}">${esc(SETUP.ceSendLabel || 'Send to calculator')}</button>`
        + (SETUP.ceSwapDownload === 'off' ? '' : `<a class="ce-swap-dl" href="${href}"${downloadLinkAttrs()}>Download file</a>`);
      split.querySelector('.ce-swap-send')?.addEventListener('click', send);
    }
    split.querySelectorAll('button').forEach(b => { b.disabled = busy || connecting; });
  };
  listeners.add(paint);
  paint();
  if (card === document.querySelector('.wp-block-media-text')) {
    demoFeedback(show, label);
    demoSent(show, label, file);
  }
}

// ?fb=deleted on localhost paints a finished delete on the game page (on a
// hub, the first card) without a calculator, to look at the feedback box.
function demoFeedback(show, label) {
  if (!(PREVIEW_HOST && /[?&]fb=deleted\b/.test(location.search))) return;
  const box = show(`<p>${esc(label)} was deleted from your calculator.</p>${whyHtml()}`, 'ok');
  wireWhy(box, { game: label, label, os: '5.8.2.0012', route: 'v21' });
}

// ?sent=partial1, partial2, added or addedsome on localhost paints a finished
// send of the first game with optional parts (one or two parts left out, a
// Send again that added the rest or only some of it) without a calculator, to
// look at the Sent message. ?sent=asm paints this card's game sent to an
// OS 5.2 calculator (no jailbreak, started through Asm(), with its "Game
// didn't start?" panel; ?sent=refused paints the refusal its Send gives with
// 700 KB of archive free, worked out by the sender's own planInstall and
// checkSpace (a game with parts: the smallest install's figures).
async function demoSent(show, label, file) {
  const m = PREVIEW_HOST && /[?&]sent=(partial1|partial2|added|addedsome|asm|refused)\b/.exec(location.search);
  if (!m) return;
  if (m[1] === 'asm' || m[1] === 'refused') {
    const entries = collectEntries(await bundle(file, label));
    const main = entries.filter(e => PROGRAMS.includes(e.type)).at(-1);
    if (m[1] === 'asm') {
      show(sentHtml({ os: '5.2.2.0043', route: 'native', warnings: [] }, main, true, { tools: [] }), 'ok');
      return;
    }
    const listed = await partsNow();
    const optional = new Set(partsOf(listed, main?.name).flatMap(part => part.names));
    const plan = planInstall(entries.filter(e => !optional.has(e.name)), { rows: [], archiveFree: 700 * 1024, ramFree: 150000, archive: archiveMode(page, main?.name) });
    try {
      checkSpace(plan, optional.size ? { least: baseOf(listed, main?.name) || true } : {});
    } catch (err) {
      show(`<p>${errorHtml(err)}</p>`, 'bad');
    }
    return;
  }
  const listed = await partsNow();
  const name = Object.keys(listed)[0];
  const labels = partsOf(listed, name).map(p => p.label);
  if (!name || labels.length < 2) return;
  const r = {
    partial1: { added: [], leftOut: labels.slice(-1) },
    partial2: { added: [], leftOut: labels, addKB: 406 },
    added: { added: labels.slice(-1), leftOut: [] },
    addedsome: { added: labels.slice(0, 1), leftOut: labels.slice(1) },
  }[m[1]];
  Object.assign(r, { os: '5.8.4.0058', route: 'v21', warnings: [], addKB: r.addKB ?? 76 });
  show(sentHtml(r, { name }, true, { tools: ['arTIfiCE v2.1'] }, partsHtml(r, listed, name, label)), 'ok');
}

function mount() {
  // A CE on a phone's USB port is untested, so phones keep the downloads only.
  // The page's <head> runs this same check first, so the panel's note is
  // up before the first paint; keep the two alike.
  const mobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (!navigator.usb || mobile) {
    document.documentElement.classList.add('ce-nosend');
    return;
  }
  // The path as the server reads it: Cloudflare serves these pages at a
  // doubled slash or an escaped letter too, and the browser keeps that spelling.
  let here = location.pathname;
  try { here = decodeURIComponent(here); } catch { /* a stray %: keep it as it is */ }
  here = here.replace(/\/{2,}/g, '/');
  const at = path => here === path || here === path + 'index.html';
  // A tag that carries the math list makes this the math page wherever it is
  // served, so its Delete can only go by content.
  page = OWN_URL ? 'math' : ['hub', 'game', 'math'].includes(SETUP.cePage) ? SETUP.cePage : at(HUB) ? 'hub' : at(MATH) ? 'math' : 'game';
  watchHelp(document);
  watchFeedback(document);
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
