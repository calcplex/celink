// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// Send to calculator on the TI-84 Plus CE games hub, on every CE game page,
// and on the CE math programs page.
//
// The site's page generator adds this module to /downloads/ti84plusce/games/
// and every page under it, and to /downloads/ti84plusce/math/.
//
//   The hub   a connect panel above the cards, and on every card one split
//             button: Send to calculator, with an arrow for Download file.
//   A game    a connect card under the page's download button: Connect, then
//             Send to calculator, status and outcome in the one card.
//   Math      the hub's shape on the math page's cards.
//             Every program there is plain TI-Basic, so no jailbreak is
//             asked about or mentioned; the words say program, not game.
//
// A calculator that needs a jailbreak and shows none gets a popup on Send
// pointing at the installer, with Send anyway as the small option. On Windows
// the first Connect asks whether TI Connect CE is installed, the installer's
// question. A calculator the user already allowed on this site in an earlier
// click, and that is plugged in, is connected on load.
//
// No WebUSB, or a phone, and this module adds nothing: the page keeps its
// download buttons exactly as they are.
//
// What goes over the cable is gamesend.mjs, node-tested against the simulated
// calculator (test/gamesend.test.mjs and test/gamepack.test.mjs). This
// file owns the words on screen and the analytics, and borrows the
// installer's vocabulary for both.
import {sendGame,collectEntries,isAssembly,inspect,jailbreakState,unpackZip,pickCalculator,GameSendError} from './gamesend.mjs';
import {startHint,isWindows,isChromeOS,openDetail} from './core.mjs';

const INSTALLER='/ti84plusce-jailbreak-installer/';
const HUB='/downloads/ti84plusce/games/';
const MATH='/downloads/ti84plusce/math/';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const shortOs=os=>String(os).split('.').slice(0,3).join('.');
// ?win=1 on a localhost preview shows the Windows screens from a Mac, like
// installer.mjs's `?screen=` preview (which takes ?win=1 too). Never on the
// live site.
const WIN=isWindows(navigator)||(/^(localhost|127\.0\.0\.1)$/.test(location.hostname)&&/[?&]win=1\b/.test(location.search));
const CROS=isChromeOS(navigator)||(/^(localhost|127\.0\.0\.1)$/.test(location.hostname)&&/[?&]cros=1\b/.test(location.search));
const JB_LINK=text=>`<a href="${INSTALLER}">${text}</a>`;
const TICONNECT='https://education.ti.com/en/products/computer-software/ti-connect-ce-sw';

// Games whose author's permission or license covers the whole package, not
// the program alone. A direct send skips the zip, so for these the download
// comes first and Send unlocks after it.
const READ_FIRST=dl=>`This game's author asked for the license and readme to come with the game. ${dl('Download it')}, read them, then click Send to calculator again.`;
const DOWNLOAD_FIRST={
  // These authors ask for their license and readme to travel with the game,
  // so both get the same message.
  '/downloads/ce/Geometry Dash.zip':READ_FIRST,
  '/downloads/ce/FALLDOWN.zip':READ_FIRST,
};
// Download links painted here copy the page's existing download-link
// attributes.
const noVig=()=>document.querySelector('a[href^="/downloads/ce/"][data-google-vignette="false"]')?' data-google-vignette="false"':'';
const decodedHref=a=>{try {return decodeURI(a.getAttribute('href'));} catch {return a.getAttribute('href');}};
const downloaded=new Set();
function markDownloaded(file) {
  downloaded.add(file);
  try {sessionStorage.setItem('ce-send-dl:'+file,'1');} catch {}
}
function wasDownloaded(file) {
  if(downloaded.has(file)) return true;
  try {return sessionStorage.getItem('ce-send-dl:'+file)==='1';} catch {return false;}
}

// Same rules as the installer's track(): nothing leaves a localhost preview,
// and only fixed parameter names with fixed vocabularies are ever sent.
const PREVIEW_HOST=/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
function track(event,params) {
  try {
    if(PREVIEW_HOST) {console.info('[not sent: preview]',event,params);return;}
    if(typeof window.gtag==='function') window.gtag('event',event,params);
  } catch {}
}
// The installer's buckets (installer.mjs failReason), plus the ones only a
// games page meets. Codes, never wording.
const CALC_BUSY=[0x0011,0x0034];
function failReason(err) {
  const code=err&&err.code;
  if(code==='NO_DEVICE_SELECTED'||(err&&err.name==='NotFoundError')) return 'no_device';
  if(code==='NO_WEBUSB'||code==='OTHER_MODEL') return 'unsupported';
  if(code==='OPEN_FAILED') return 'open_failed';
  if(code==='TIMEOUT') return 'timeout';
  if(code==='CALC_ERROR'&&CALC_BUSY.includes(err.calcError)) return 'calc_busy';
  if(code==='CALC_ERROR') return 'calc_error_'+err.calcError;
  if(['DISCONNECTED','LINK_CLOSED','USB_ERROR','PROTOCOL'].includes(code)) return 'link_lost';
  if(code==='NO_ARCHIVE_SPACE') return 'no_space';
  if(code==='NO_RAM_SPACE') return 'no_ram';
  if(code==='NO_JAILBREAK') return 'no_jailbreak';
  if(code==='READBACK') return 'readback_mismatch';
  if(code==='FETCH') return 'fetch_failed';
  if(['BAD_FILE','BAD_ENTRY','BAD_NAME','UNSUPPORTED_TYPE'].includes(code)) return 'bad_file';
  return 'other';
}
const LOST=['link_lost','timeout'];
const OUTCOME_TEXT={
  no_device:"No calculator was picked. Make sure it's plugged in and turned on, then try again. Not in the list? Try a different USB cable; charge-only cables won't work.",
  open_failed:"Couldn't connect. Close anything else using the calculator (like TI Connect CE or another tab), unplug it and plug it back in, then try again.",
  link_lost:'The calculator stopped responding. Unplug it, plug it back in, and try again.',
  timeout:'The calculator stopped responding. Unplug it, plug it back in, and try again.',
  calc_busy:'The calculator is busy. Press clear a few times to get back to the home screen, then try again.',
};
const WINDOWS_TEXT={
  no_device:"Calculator not in the list? On Windows it only shows up once TI Connect CE is installed. If it is, make sure the calculator is on, then try again.",
};
// Chrome OS has no TI Connect CE to close (?cros=1 previews it on localhost).
const CHROMEOS_TEXT={
  open_failed:"Couldn't connect. Close any other tab using the calculator, unplug it and plug it back in, then try again. Some school Chromebooks don't let websites use USB devices, so if it keeps failing, try a Windows or Mac computer.",
};
// The engine's messages say "game"; on the math page the thing is a program.
const noun=text=>page==='math'?String(text).replace(/\bgame\b/g,'program'):text;
function errorText(err) {
  const reason=failReason(err);
  let text=(WIN&&WINDOWS_TEXT[reason])||(CROS&&CHROMEOS_TEXT[reason])||OUTCOME_TEXT[reason]||(err&&err.message)||String(err);
  if(err&&((err.partial&&err.partial.length)||(err.removed&&err.removed.length))) text+=' Press Send again to finish.';
  return noun(text);
}

// ---- the cable: one link per page, opened on the first click that needs it
let link=null,calc=null,busy=false,present=false,anyway=false;
const listeners=new Set();
const changed=()=>listeners.forEach(f=>f());
// Automatic connect on load. navigator.usb.getDevices() lists only devices
// the user already allowed on this site by choosing them in the browser's
// picker in an earlier click, so this never reaches any other calculator.
// When one of those is plugged in, the page connects without a click and
// shows "Calculator connected"; no picker opens, so it says Connecting, not
// "pick it". `quiet` skips the Windows TI Connect CE question and the
// connect-failure analytics event. A failure here (another tab holding the
// calculator) just leaves the Connect button.
let page='game',connecting=false;
async function refreshPresent() {
  try {present=(await navigator.usb.getDevices()).some(d=>d.vendorId===0x0451);} catch {present=false;}
  if(present&&!link&&!busy&&!connecting) {
    connecting=true;changed();
    try {await connect(page,()=>{},{quiet:true});} catch {}
    connecting=false;
  }
  changed();
}
// Windows: WebUSB reaches the CE through the driver TI Connect CE installs;
// without it Chrome's picker is empty (observed on Windows). Asked once per
// browser, before the first picker. Resolves true to go on to the picker.
function askTIConnect() {
  let known=false;
  try {known=localStorage.getItem('ce-send-ticonnect')==='yes';} catch {}
  if(!WIN||present||known) return Promise.resolve(true);
  const remember=()=>{try {localStorage.setItem('ce-send-ticonnect','yes');} catch {}};
  return modal(`<h2>Is TI Connect CE installed?</h2>
      <p>On Windows, your calculator only shows up once TI Connect CE, TI's own software, is installed on this computer.</p>
      <p class="ce-modal-actions"><button type="button" class="ce-modal-go" data-v="yes">Yes, it's installed</button>
      <button type="button" class="ce-modal-alt" data-v="no">No, or I'm not sure</button></p>`,
    (d,done)=>{
      d.querySelector('[data-v="yes"]').onclick=()=>{remember();done(true);};
      d.querySelector('[data-v="no"]').onclick=()=>{
        d.innerHTML=`<h2>Install TI Connect CE first</h2>
          <ol><li><a href="${TICONNECT}" target="_blank" rel="noopener nofollow">Download TI Connect CE from TI</a> and run the installer.</li>
          <li>If it opens, close it. This page can't reach the calculator while it's open.</li>
          <li>Come back to this tab and click below.</li></ol>
          <p class="ce-modal-actions"><button type="button" class="ce-modal-go">It's installed</button></p>`;
        d.querySelector('.ce-modal-go').onclick=()=>{remember();done(true);};
      };
    });
}
async function connect(page,say,{quiet=false}={}) {
  if(link) return calc;
  if(!quiet&&!(await askTIConnect())) throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});
  say(present?'Connecting to your calculator…':'Select your calculator in the popup…');
  let l;
  try {
    l=await pickCalculator();
    await l.open();
    calc=await inspect(l);
  } catch(err) {
    if(l) {try {await l.close();} catch {}}
    calc=null;
    if(!quiet) {
      const detail=openDetail(err);
      track('ce_connect_fail',detail?{reason:failReason(err),open_detail:detail,page}:{reason:failReason(err),page});
    }
    throw err;
  }
  link=l;
  track('ce_calc_info',{evo_os:calc.os,evo_hw:calc.model,route:calc.route,page});
  refreshPresent();
  return calc;
}
async function drop() {
  const l=link;link=null;calc=null;
  if(l) {try {await l.close();} catch {}}
  refreshPresent();
}
if(navigator.usb&&navigator.usb.addEventListener) {
  navigator.usb.addEventListener('connect',refreshPresent);
  navigator.usb.addEventListener('disconnect',e=>{if(link&&e.device===link.device) drop(); else refreshPresent();});
}
window.addEventListener('pagehide',()=>{if(link) link.close().catch(()=>{});});

async function gameFiles(file,label) {
  const response=await fetch(file);
  if(!response.ok) throw new GameSendError('FETCH',`Couldn't get ${label} from this site. Try again in a moment.`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  return /\.zip$/i.test(file)?await unpackZip(bytes):[bytes];
}

// ---- words
// What the calculator can do, after the model line. `where` finishes the
// "pick a game" sentence for the page it is on.
function verdict(c,where) {
  const os=`OS ${esc(shortOs(c.os))}`;
  if(page==='math') return `<strong>Calculator connected</strong> (${os}). ${where}`;
  const state=jailbreakState(c.route,c.tools);
  if(state==='none') return `<strong>Calculator connected</strong> (${os}). ${where}`;
  if(state==='found') return `<strong>Calculator connected</strong> (${os}, jailbroken). ${where} ${c.route==='v21'?'Games start from prgm, then A.':'Games start from the prgm menu.'}`;
  if(state==='missing') return `<strong>Calculator connected</strong> (${os}). It needs a jailbreak before games will run: ${JB_LINK('jailbreak it first')}, then come back and send games.`;
  return `<strong>Calculator connected</strong> (${os}). There's no jailbreak for this version yet, so these games won't run on it.`;
}
function statusHtml(where) {
  if(link&&calc) return verdict(calc,where);
  if(connecting) return 'Connecting to your calculator…';
  return `Plug in your TI-84 Plus CE, turn it on, and click ${where.startsWith('Pick')?'Connect':'Send to calculator'} to install ${page==='math'?'programs':'games'}.`;
}
const statusKind=()=>{
  if(!(link&&calc)) return '';
  if(page==='math') return 'ok';
  const s=jailbreakState(calc.route,calc.tools);
  return s==='missing'||s==='blocked'?'warn':'ok';
};

// One modal for both questions. `wire(dialog,done)` sets the buttons; Escape
// or a click outside resolves false.
function modal(html,wire) {
  return new Promise(resolve=>{
    const d=document.createElement('dialog');
    d.className='ce-modal';
    d.innerHTML=html;
    document.body.append(d);
    const done=v=>{if(!d.open) return;d.close();d.remove();resolve(v);};
    d.addEventListener('cancel',e=>{e.preventDefault();done(false);});
    d.addEventListener('click',e=>{if(e.target===d) done(false);});
    wire(d,done);
    d.showModal();
  });
}

// The popup a student cannot scroll past: this calculator needs a jailbreak
// and shows none. Resolves true to send anyway.
function askJailbreak() {
  return modal(`<h2>Jailbreak your calculator first</h2>
      <p>This calculator can't run games until it's jailbroken. It only takes a few minutes, and then every game here will work.</p>
      <p class="ce-modal-actions"><a class="ce-modal-go" href="${INSTALLER}">Jailbreak it now</a>
      <button type="button" class="ce-modal-anyway">Send anyway</button></p>`,
    (d,done)=>{d.querySelector('.ce-modal-anyway').onclick=()=>done(true);});
}

// Connect if needed, check the jailbreak, send. `say` shows progress and
// `show(html,kind)` the outcome. Everything a Send button does, hub or page.
async function run({file,label,page,say,show}) {
  if(busy) return;
  const gate=DOWNLOAD_FIRST[file];
  if(gate&&!wasDownloaded(file)) {
    show(`<p>${gate(t=>`<a href="${esc(encodeURI(file))}" class="ce-gate-dl"${noVig()}><strong>${t}</strong></a>`)}</p>`,'warn');
    return;
  }
  busy=true;changed();
  try {
    const c=await connect(page,say);
    say(`Getting ${label}…`);
    const files=await gameFiles(file,label);
    const entries=collectEntries(files);
    const asm=entries.some(isAssembly);
    if(asm && !anyway && jailbreakState(c.route,c.tools)==='missing') {
      say('');
      if(!(await askJailbreak())) return;
      anyway=true;
    }
    const main=entries.filter(e=>e.type===5||e.type===6).at(-1);
    const game=main?main.name:label.slice(0,20);
    const sending=pct=>say(`Sending ${label} to your calculator… ${pct}%`);
    sending(0);
    let r;
    try {
      r=await sendGame(link,files,{onProgress:(done,total)=>{if(total) sending(Math.min(99,Math.round(done/total*100)));}});
    } catch(err) {
      track('ce_send_fail',{game,reason:failReason(err),page});
      if(LOST.includes(failReason(err))) await drop();
      throw err;
    }
    // retried: 1 = the space check passed only on a second read of the
    // calculator (see sendGame in gamesend.mjs). Reuses the `retried`
    // parameter.
    track('ce_send_success',{game,outcome:r.replaced.length?'replaced':'sent',route:r.route,page,...(r.rechecked?{retried:1}:{})});
    say('');
    const how=!main?'':asm?startHint(r.os,main.name):`Press prgm, pick ${main.name}, and press enter.`;
    const lower=how.charAt(0).toLowerCase()+how.slice(1);
    const verb=page==='math'?'run':'play';
    const html=asm && jailbreakState(r.route,c.tools)==='missing'
      ? [`<p><strong>Sent!</strong> It won't start until your calculator is jailbroken: ${JB_LINK('jailbreak it now')}, then ${esc(lower)}</p>`]
      : [`<p><strong>Sent!</strong> To ${verb} it, ${esc(lower)}</p>`];
    for(const w of r.warnings) {
      if(w.code==='LOW_RAM_TO_RUN') html.push(`<p>Your calculator is low on RAM (${w.freeKB} KB free), so the ${page==='math'?'program':'game'} may stop with ERR:MEMORY. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management).</p>`);
    }
    show(html.join(''),'ok');
  } catch(err) {
    say('');
    if(err&&err.code==='CANCELLED') return;
    show(`<p>${esc(errorText(err))}</p>`,'bad');
  } finally {
    busy=false;changed();
  }
}
function watchDownloads(root) {
  root.addEventListener('click',e=>{
    const a=e.target.closest&&e.target.closest('a[href^="/downloads/ce/"]');
    if(a) markDownloaded(decodedHref(a));
  });
}

// ---- a game page ---------------------------------------------------------
// One card under the download button: one obvious place for the eye and the
// instructions. Before a calculator is connected it says what to do and
// offers Connect; connected, it turns green or amber with the OS and
// jailbreak state and the button becomes Send to calculator. Progress and the outcome show in the card too.
// The download button above it is untouched, so it stays the first thing a
// student sees.
function mountGame() {
  const a=[...document.querySelectorAll('.entry-content a[href^="/downloads/ce/"], main a[href^="/downloads/ce/"]')]
    .find(a=>/\.(8xg|8xp|zip)$/i.test(a.getAttribute('href')));
  if(!a) return;
  const file=decodedHref(a);
  const label=(a.textContent.split('|')[0]||'').trim()||'This game';
  const anchor=a.closest('.wp-block-button')||a;
  const card=document.createElement('div');
  card.className='ce-conn is-leaf';
  card.setAttribute('role','status');
  card.innerHTML=`
    <p class="msg ce-leaf-msg"></p>
    <button type="button" class="ce-conn-go"></button>
    <p class="msg sub ce-leaf-progress" aria-live="polite"></p>
    <div class="ce-leaf-result" hidden></div>`;
  anchor.after(card);
  watchDownloads(document);
  const msg=card.querySelector('.ce-leaf-msg'),go=card.querySelector('.ce-conn-go'),
    progress=card.querySelector('.ce-leaf-progress'),result=card.querySelector('.ce-leaf-result');
  let outcome='';   // the last result's kind, so a failure tints the card until the next try
  listeners.add(()=>{
    const connected=!!(link&&calc);
    msg.innerHTML=connected||connecting
      ? statusHtml('Click Send to calculator to install it.')
      : 'Plug in your TI-84 Plus CE, turn it on, and click Connect to send this game.';
    const kind=statusKind();
    card.className='ce-conn is-leaf'+(kind?' '+kind:outcome==='bad'?' bad':'');
    go.textContent=connected?'Send to calculator':'Connect your calculator';
    go.disabled=busy||connecting;
  });
  changed();
  const say=t=>{progress.textContent=t||'';};
  const show=(html,kind)=>{outcome=kind;result.innerHTML=html;result.className=`ce-leaf-result is-${kind}`;result.hidden=false;changed();};
  const clear=()=>{outcome='';result.hidden=true;result.innerHTML='';};
  go.onclick=async()=>{
    if(busy) return;
    clear();
    if(link&&calc) {run({file,label,page:'game',say,show});return;}
    busy=true;changed();
    try {await connect(page,say);}
    catch(err) {if(!(err&&err.code==='CANCELLED')) show(`<p>${esc(errorText(err))}</p>`,'bad');}
    finally {busy=false;say('');changed();}
  };
}

// ---- the hub -------------------------------------------------------------
const ARROW='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function closeMenus(except) {
  document.querySelectorAll('.ce-split-menu').forEach(m=>{
    if(m===except) return;
    m.hidden=true;
    m.parentElement.querySelector('.ce-split-arrow').setAttribute('aria-expanded','false');
  });
}
function mountHub() {
  const what=page==='math'?'program':'game';
  const cards=[...document.querySelectorAll('.entry-content .wp-block-media-text')]
    .map(card=>({card,a:card.querySelector('a[href^="/downloads/ce/"]')}))
    .filter(x=>x.a&&/\.(8xg|8xp|zip)$/i.test(x.a.getAttribute('href')));
  if(!cards.length) return;
  watchDownloads(document);
  document.addEventListener('click',e=>{if(!e.target.closest('.ce-split')) closeMenus();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape') closeMenus();});

  const panel=document.createElement('div');
  panel.setAttribute('role','status');
  cards[0].card.before(panel);
  let panelError='';
  listeners.add(()=>{
    const kind=statusKind();
    panel.className='ce-conn'+(kind?' '+kind:panelError?' bad':'');
    const where=`Pick a ${what} below and click Send to calculator.`;
    if((link&&calc)||connecting) {panel.innerHTML=`<p class="msg">${statusHtml(where)}</p>`;return;}
    panel.innerHTML=`<p class="msg">${statusHtml(where)}</p>
      ${panelError?`<p class="msg err">${esc(panelError)}</p>`:''}
      <button type="button" class="ce-conn-go"${busy?' disabled':''}>Connect your calculator</button>`;
    panel.querySelector('.ce-conn-go').onclick=async()=>{
      if(busy) return;
      busy=true;panelError='';
      const b=panel.querySelector('.ce-conn-go');
      try {await connect(page,t=>{b.textContent=t;b.disabled=true;});}
      catch(err) {panelError=err&&err.code==='CANCELLED'?'':errorText(err);}
      finally {busy=false;changed();}
    };
  });

  for(const {card,a} of cards) {
    const file=decodedHref(a);
    const label=(card.querySelector('h2')?.textContent||'').trim()||(page==='math'?'This program':'This game');
    const old=a.closest('.wp-block-button');
    const href=esc(a.getAttribute('href'));
    const split=document.createElement('div');
    split.className='wp-block-button floated ce-split';
    old.after(split);
    old.style.display='none';
    const status=document.createElement('div');
    status.className='ce-card-status';
    status.setAttribute('role','status');
    [...card.querySelectorAll('.wp-block-button.floated')].at(-1).after(status);
    const show=(html,kind)=>{status.innerHTML=html;status.className=`ce-card-status is-${kind}`;};
    const say=t=>{if(t) show(`<p>${esc(t)}</p>`,'busy'); else if(status.classList.contains('is-busy')) show('','');};
    const send=()=>{closeMenus();run({file,label,page,say,show});};
    // The main half is whatever this student can do right now: Download
    // until a calculator is connected, then Send. The arrow offers the other.
    // "Send to calculator" plus the arrow fits beside "More Information" in
    // browser windows wider than about 1120px; narrower, More Information
    // wraps to its own line, which is fine.
    let mode='';
    const paintSplit=()=>{
      const want=link&&calc?'send':'download';
      if(want!==mode) {
        mode=want;
        split.innerHTML=(mode==='send'
          ? `<button type="button" class="wp-block-button__link no-border-radius ce-split-main">Send to calculator</button>`
          : `<a class="wp-block-button__link no-border-radius ce-split-main" href="${href}"${noVig()}>Download</a>`)
          +`<button type="button" class="wp-block-button__link no-border-radius ce-split-arrow" aria-label="More ways to get ${esc(label)}" aria-haspopup="menu" aria-expanded="false">${ARROW}</button>`
          +`<div class="ce-split-menu" role="menu" hidden>${mode==='send'
            ? `<a role="menuitem" href="${href}"${noVig()}>Download file</a>`
            : `<button type="button" role="menuitem" class="ce-split-send">Send to calculator</button>`}</div>`;
        const arrow=split.querySelector('.ce-split-arrow'),menu=split.querySelector('.ce-split-menu');
        arrow.onclick=()=>{
          const open=menu.hidden;
          closeMenus(menu);
          menu.hidden=!open;
          arrow.setAttribute('aria-expanded',String(open));
        };
        if(mode==='send') split.querySelector('.ce-split-main').onclick=send;
        else split.querySelector('.ce-split-send').onclick=send;
      }
      split.querySelectorAll('button').forEach(b=>{b.disabled=busy;});
    };
    listeners.add(paintSplit);
    paintSplit();
  }
  changed();
}

function mount() {
  if(!navigator.usb) return; // no WebUSB: the download buttons are the whole story
  // Android Chrome has WebUSB, but a CE on a phone's USB port is untested,
  // so phones keep the downloads only.
  const mobile=navigator.userAgentData?navigator.userAgentData.mobile:/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if(mobile) return;
  const at=p=>location.pathname===p||location.pathname===p+'index.html';
  page=at(HUB)?'hub':at(MATH)?'math':'game';
  if(page==='game') mountGame(); else mountHub();
  refreshPresent();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount); else mount();
