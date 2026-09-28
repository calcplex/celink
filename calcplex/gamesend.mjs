// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import {compatibility} from './core.mjs';
import {CELink,CELinkError} from '../celink.mjs';
import {parseFile,TYPE} from '../tifiles.mjs';
// Send a game to a TI-84 Plus CE over celink: the jailbreak installer's "Send
// Snake" button, and the engine for a Send button on every CE games page.
//
// A game is one or more files (.8xp/.8xv/.8xg, or the .zip a games page
// already offers). Every file is sent, every time, and anything already under
// its name is deleted just before it goes: libraries included, whatever
// version the calculator had (keeping the old copies is not worth a send that
// fails). The order is C libraries, then data AppVars, then the program, so a
// transfer that stops half way does not leave a program that starts and
// cannot find what it needs.
//
// Before anything is deleted or sent, the space it needs is checked against
// what the calculator reports free, and an assembly game on an OS no
// published jailbreak covers is refused (a file the student can see and
// never run). Every variable sent is read back and compared unless the caller
// asks for the lighter size check.
//
// The page owns the words on screen. This file owns what goes over the cable,
// so node can test it against the simulated calculator in ../sim/.

const PROGRAMS=[TYPE.PROGRAM,TYPE.PROTECTED_PROGRAM];
// The CE's named table: programs, AppVars and groups share one set of names.
// Math values (a real A, a list) live apart and never clash with a game.
const NAMED=[...PROGRAMS,TYPE.APPVAR,TYPE.TEMP_PROGRAM,TYPE.GROUP];
const clash=(row,e)=>row.name===e.name && (row.type===e.type || (NAMED.includes(row.type)&&NAMED.includes(e.type)));
// An assembly or C program starts with the two-byte token 0xEF 0x7B right after
// its size word. TI-Basic never does, and TI-Basic needs no jailbreak.
export function isAssembly(entry) {
  const d=entry.data;
  return PROGRAMS.includes(entry.type) && d.length>=4 && d[2]===0xEF && d[3]===0x7B;
}
const same=(a,b)=>a.length===b.length && a.every((x,i)=>x===b[i]);

// A CE C library is an AppVar whose data opens (after the size word) with
// C0 C1 and then its version byte; LibLoad itself opens with BF FE and its
// version. Checked against CEdev's own declarations: GRAPHX 14, FILEIOC 8,
// KEYPADC 2, FONTLIBC 2, LibLoad 41 are exactly the bytes in its clibs.8xg.
// Used for the send order and for picking the newer copy when a game ships
// the same library twice; never to skip a send.
export function library(entry) {
  const d=entry?.data;
  if(!d || entry.type!==TYPE.APPVAR || d.length<5) return null;
  if(d[2]===0xC0 && d[3]===0xC1) return {version:d[4],loader:false};
  if(d[2]===0xBF && d[3]===0xFE) return {version:d[4],loader:true};
  return null;
}

// Programs and AppVars open with a 2-byte size word, and the calculator
// believes it over the length it was sent. Some published AppVars declare one
// byte more than they hold, so the stored variable claims a byte past its own
// end and reads back one byte long. Such a variable is padded with zeros to
// the length it declares before it goes, so the copy on the calculator is
// consistent and the download stays byte for byte the author's. A variable
// declaring LESS than it holds is sent as it is; the calculator ignores the
// tail.
const SIZE_WORD=[TYPE.PROGRAM,TYPE.PROTECTED_PROGRAM,TYPE.APPVAR,TYPE.TEMP_PROGRAM];
export function fixSizeWord(e) {
  const d=e.data;
  if(!SIZE_WORD.includes(e.type) || d.length<2) return e;
  const want=(d[0]|(d[1]<<8))+2;
  if(want<=d.length) return e;
  const data=new Uint8Array(want);
  data.set(d);
  return {...e,data,padded:want-d.length};
}

// The file's variables, refusing anything that is not a plain variable. A
// Flash app or an OS image never goes through a game button.
export function gameEntries(bytes) {
  const {entries}=parseFile(bytes);
  if(!entries.length) throw new GameSendError('BAD_FILE','The game file is empty.');
  for(const e of entries) {
    if([TYPE.FLASH_APP,TYPE.OS,TYPE.CERTIFICATE,TYPE.LICENSE].includes(e.type)) throw new GameSendError('BAD_FILE','This file is not a program or a variable.');
  }
  return entries.map(fixSizeWord);
}

// Every variable of every file, once, in sending order (libraries, LibLoad
// first; then data; then programs). The same library bundled twice (a game's
// .8xg and its clibs.8xg) keeps the newer copy. Two different variables under
// one name is a broken game package, refused before anything is sent.
export function collectEntries(files) {
  const list=Array.isArray(files)?files:[files];
  const out=[];
  for(const f of list) {
    for(const e of gameEntries(f instanceof Uint8Array?f:f.bytes)) {
      const i=out.findIndex(o=>clash({name:o.name,type:o.type},e));
      if(i<0) {out.push(e);continue;}
      const a=library(out[i]),b=library(e);
      if(a && b) {if(b.version>a.version) out[i]=e;continue;}
      if(out[i].type===e.type && same(out[i].data,e.data)) continue;
      throw new GameSendError('BAD_FILE',`This game's files contain two different variables named ${e.name}.`);
    }
  }
  const rank=e=>{const l=library(e);return l?(l.loader?0:1):PROGRAMS.includes(e.type)?3:2;};
  return out.map((e,i)=>[e,i]).sort((x,y)=>rank(x[0])-rank(y[0])||x[1]-y[1]).map(x=>x[0]);
}

export class GameSendError extends Error {
  constructor(code,message,extra={}) {super(message);this.name='GameSendError';this.code=code;Object.assign(this,extra);}
}

// What the calculator is and whether an assembly game can run on it:
//   native       OS 5.4 and older, assembly runs as it is
//   v21 / v3     5.5 to 5.8.5, assembly needs arTIfiCE first
//   unsupported  newer than any published jailbreak
//   unknown      a version that could not be read
export async function identify(link) {
  const info=await link.info();
  if(!/^TI-84 ?\+ ?CE|^TI-84 Plus CE/.test(String(info.productName||''))) {
    throw new GameSendError('OTHER_MODEL',`This is a ${info.productName||'calculator this page does not know'}. These files are for the TI-84 Plus CE.`);
  }
  return {model:info.productName,os:info.osVersion,route:compatibility(String(info.osVersion)),
    ramFree:info.ramFree??null,archiveFree:info.archiveFree??null};
}

// What a variable costs in memory: its data plus the calculator's own header
// for it. The simulator charges 9 bytes in RAM and 17 in archive; the real
// headers also hold the name, so the name length is added on top. An estimate,
// kept on the generous side so a refusal here means the transfer really would
// have run out.
const cost=(e,archived)=>e.data.length+e.name.length+(archived?20:9);
const kb=n=>Math.ceil(n/1024);

// Decide, with no I/O, what to delete and send, and whether it fits. Pure,
// so every case is a unit test.
export function planInstall(entries,{rows,ramFree=null,archiveFree=null,archive='file'}) {
  const steps=[];
  for(const e of entries) {
    const old=rows.filter(r=>clash(r,e));
    steps.push({entry:e,archived:archive==='all'||!!e.archived,remove:old,reason:old.length?'replace':'new'});
  }
  // Freed RAM comes back at once, but only when its delete runs, which is
  // just before its own file goes. So RAM is a running balance in send order:
  // a step may use what earlier deletes and its own gave back, never what a
  // later one will. Freed archive comes back only after the calculator
  // collects its garbage, which may not happen during a transfer, so it is
  // not counted at all.
  let ramNeed=0,arcNeed=0,ramBack=0,bal=ramFree??0,low=bal;
  for(const s of steps) {
    for(const r of s.remove) if(!r.archived && r.size!=null) {const b=r.size+r.name.length+9;ramBack+=b;bal+=b;}
    if(s.archived) arcNeed+=cost(s.entry,true);
    else {const c=cost(s.entry,false);ramNeed+=c;bal-=c;low=Math.min(low,bal);}
  }
  const space={ramNeed,arcNeed,ramBack,ramFree,archiveFree,ramShort:ramFree==null?0:Math.max(0,-low)};
  const warnings=[];
  // An assembly program runs from RAM, copied there even when it is archived,
  // so a game that fits in archive can still say ERR:MEMORY when it starts.
  const biggest=Math.max(0,...entries.filter(isAssembly).map(e=>e.data.length));
  if(ramFree!=null && biggest && bal<biggest+1024) {
    warnings.push({code:'LOW_RAM_TO_RUN',needKB:kb(biggest+1024),freeKB:Math.max(0,Math.floor(bal/1024))});
  }
  return {steps,space,warnings};
}

// Refuse before anything moves, naming how much to free.
export function checkSpace({space}) {
  const {ramNeed,arcNeed,ramFree,archiveFree,ramShort}=space;
  if(archiveFree!=null && arcNeed>archiveFree) {
    throw new GameSendError('NO_ARCHIVE_SPACE',`Not enough room on the calculator: this game needs ${kb(arcNeed)} KB of archive and there's ${Math.floor(archiveFree/1024)} KB free. Delete a few programs you don't need (2nd, +, 2: Mem Management), then try again.`,{needKB:kb(arcNeed-archiveFree)});
  }
  if(ramShort>0) {
    throw new GameSendError('NO_RAM_SPACE',`Not enough RAM on the calculator: this game needs ${kb(ramNeed)} KB and there's ${Math.floor(ramFree/1024)} KB free. Delete or archive a few programs you don't need (2nd, +, 2: Mem Management), then try again.`,{needKB:kb(ramShort)});
  }
}

// Send a game over an OPEN link. `files` is one file's bytes or a list of them
// (Uint8Array, or {bytes} as unpackZip returns). Options:
//   onProgress(done,total)  bytes, across every variable sent
//   onStep(step,name)       'delete', 'send', 'verify'; for a page that shows
//                           what it is doing
//   verify                  'full' reads every variable back and compares it
//                           (default); 'size' lists once at the end and compares
//                           sizes, for big games where a full read doubles the wait
//   archive                 'file' puts each variable where its file says (default);
//                           'all' archives everything, which survives a RAM reset and
//                           leaves RAM to run in. Not the default until archived
//                           programs are seen starting on every route on hardware.
// Returns {os, route, asm, sent, replaced, warnings, bytes, rechecked}
// (rechecked: the space check only passed on a second read of the calculator).
// A failure part way throws with `partial` = the names already on the
// calculator (a variable that failed its read back included), and `removed` =
// names deleted to make way whose new copy never landed. A library in
// `removed` means the student's other C games are missing it until the next
// send, so the page should always offer that send.
export async function sendGame(link,files,{onProgress=null,onStep=null,verify='full',archive='file'}={}) {
  const todo=collectEntries(files);
  const calc=await identify(link);
  const asm=todo.some(isAssembly);
  if(asm && (calc.route==='unsupported'||calc.route==='unknown')) {
    throw new GameSendError('NO_JAILBREAK',`There's no jailbreak for OS ${calc.os} yet, so this game can't run on it. Nothing was sent.`);
  }
  let rows=await link.list(),rechecked=false;
  let plan=planInstall(todo,{rows,ramFree:calc.ramFree,archiveFree:calc.archiveFree,archive});
  try {checkSpace(plan);}
  catch(err) {
    if(err.code!=='NO_RAM_SPACE'&&err.code!=='NO_ARCHIVE_SPACE') throw err;
    // Ask once more before refusing: a single read of the free-memory
    // parameters can come back wrong (observed on hardware as 0 bytes free on
    // a calculator with plenty of RAM). A calculator that really is full says
    // so twice.
    rechecked=true;
    const again=await link.info();
    rows=await link.list();
    plan=planInstall(todo,{rows,ramFree:again.ramFree??null,archiveFree:again.archiveFree??null,archive});
    checkSpace(plan);
  }
  const total=plan.steps.reduce((n,s)=>n+s.entry.data.length,0);
  let before=0;
  const sent=[],replaced=[],removed=new Set();
  try {
    for(const s of plan.steps) {
      const e=s.entry;
      for(const r of s.remove) {onStep?.('delete',r.name);await link.delete(r.name,r.type);removed.add(r.name);}
      onStep?.('send',e.name);
      await link.send(e,{
        archive:s.archived,
        onProgress:onProgress?(done)=>onProgress(before+done,total):undefined,
      });
      before+=e.data.length;
      removed.delete(e.name);
      sent.push(e.name);
      if(verify==='full') {
        onStep?.('verify',e.name);
        const back=await link.receive(e.name,e.type);
        if(!same(back.data,e.data)) {
          const at=back.data.findIndex((x,i)=>x!==e.data[i]);
          throw new GameSendError('READBACK',`${e.name} didn't arrive intact. Click Send again to retry.`,
            {variable:e.name,sentBytes:e.data.length,backBytes:back.data.length,firstDiff:at<0?Math.min(back.data.length,e.data.length):at});
        }
      }
      if(s.reason==='replace') replaced.push(e.name);
    }
    if(verify==='size' && plan.steps.length) {
      onStep?.('verify',null);
      const now=await link.list();
      for(const s of plan.steps) {
        const r=now.find(r=>r.name===s.entry.name && r.type===s.entry.type);
        if(!r || (r.size!=null && r.size!==s.entry.data.length)) throw new GameSendError('READBACK',`${s.entry.name} didn't arrive intact. Click Send again to retry.`,{variable:s.entry.name});
      }
    }
  } catch(e) {
    e.partial=sent.slice();
    e.removed=[...removed];
    throw e;
  }
  return {os:calc.os,route:calc.route,asm,sent,replaced,warnings:plan.warnings,bytes:total,rechecked};
}

// Is a jailbreak installed? Only names checked against the tools' own files:
//   A         the arTIfiCE v2.1 launcher program (core.mjs OFFICIAL.v21:
//             name 'A'), counted only at its exact size (904 bytes) and, in
//             inspect(), only when its bytes read back as the author's: an
//             empty prgmA fools the name check
//   AsmHook2  the app arTIfiCE v3 installs (the author's installer,
//             arTIfiCE.8xp, reports it by that name)
//   Cesium    the app the CESIUM program creates (Cesium's readme says that
//             running the CESIUM program creates the application)
//   CESIUM    that installer program, not yet run
// CEaShell is left out: its name on the calculator has not been checked.
// A soft hint only. A is a common program name, v2.1 runs through A every
// session, and AsmHook2's hook is lost on a RAM reset, so a match never blocks
// and no match is a suggestion, not a refusal. Matched here in the browser;
// jailbreakTools returns only the fixed labels in TOOLS below ('arTIfiCE',
// 'AsmHook2', 'Cesium', 'Cesium installer'), never a name read from the
// calculator.
// The variable inside arTIfiCE_v2.1.8xp (the file core.mjs pins by hash):
// its data length and the SHA-256 of that data, size word included.
const ARTIFICE_A={size:904,sha256:'a3d6b61efdc4352b945e78d67278a1975854d4f81070c8235e0abfcf21fcfd12'};
const TOOLS=[
  {name:'A',types:[TYPE.PROGRAM,TYPE.PROTECTED_PROGRAM],size:ARTIFICE_A.size,tool:'arTIfiCE'},
  {name:'AsmHook2',types:[TYPE.FLASH_APP],tool:'AsmHook2'},
  {name:'Cesium',types:[TYPE.FLASH_APP],tool:'Cesium'},
  {name:'CESIUM',types:[TYPE.PROGRAM,TYPE.PROTECTED_PROGRAM],tool:'Cesium installer'},
];
export function jailbreakTools(rows) {
  return TOOLS.filter(t=>rows.some(r=>r.name===t.name && t.types.includes(r.type) && (!t.size||r.size===t.size))).map(t=>t.tool);
}
// The calculator and its jailbreak tools, in one listing, for a page to show
// before anything is sent.
export async function inspect(link) {
  const calc=await identify(link);
  const rows=await link.list();
  let tools=jailbreakTools(rows);
  if(tools.includes('arTIfiCE')) {
    const row=rows.find(r=>r.name==='A' && r.size===ARTIFICE_A.size);
    let real=false;
    try {
      const back=await link.receive('A',row.type);
      const hash=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',back.data));
      real=[...hash].map(b=>b.toString(16).padStart(2,'0')).join('')===ARTIFICE_A.sha256;
    } catch {}
    if(!real) tools=tools.filter(t=>t!=='arTIfiCE');
  }
  return {...calc,tools};
}
// What the page should say before sending an assembly game:
//   'none'      this OS runs assembly as it is
//   'found'     a jailbreak tool is on the calculator
//   'missing'   this OS needs one and none was found: suggest the installer
//   'blocked'   no published jailbreak for this OS (sendGame refuses assembly)
export function jailbreakState(route,tools) {
  if(route==='native') return 'none';
  if(route==='v21'||route==='v3') return tools.length?'found':'missing';
  return 'blocked';
}

// The .8xp/.8xv/.8xg files inside a games page's .zip, so the Send button
// sends exactly what the Download button gives. `include` (paths inside the
// zip) picks which; by default every calculator file in it. Stored and
// deflated entries only (all any zip tool writes for these), CRC-checked.
const CALC_FILE=/\.8x[pvg]$/i;
export async function unpackZip(bytes,{include=null}={}) {
  try {return await readZip(bytes,include);}
  catch(e) {
    if(e instanceof GameSendError) throw e;
    // A bounds read past the end, or a deflate stream that will not inflate.
    throw new GameSendError('BAD_FILE','The game download is damaged. Try again in a moment.');
  }
}
async function readZip(bytes,include) {
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-22-65535);p--) if(dv.getUint32(p,true)===0x06054b50) {end=p;break;}
  if(end<0) throw new GameSendError('BAD_FILE','The game download is not a readable zip.');
  const count=dv.getUint16(end+10,true);
  let p=dv.getUint32(end+16,true);
  // ZIP64 marks its real values elsewhere; nothing this site hosts needs it.
  if(count===0xFFFF || p===0xFFFFFFFF) throw new GameSendError('BAD_FILE','The game download is packed in a way this page cannot read.');
  const out=[];
  for(let i=0;i<count;i++) {
    if(dv.getUint32(p,true)!==0x02014b50) throw new GameSendError('BAD_FILE','The game download is not a readable zip.');
    const method=dv.getUint16(p+10,true),crc=dv.getUint32(p+16,true);
    const csize=dv.getUint32(p+20,true),usize=dv.getUint32(p+24,true);
    const nlen=dv.getUint16(p+28,true),xlen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true);
    const local=dv.getUint32(p+42,true);
    const path=new TextDecoder().decode(bytes.subarray(p+46,p+46+nlen));
    p+=46+nlen+xlen+clen;
    if(!CALC_FILE.test(path) || /(^|\/)__MACOSX\//.test(path)) continue;
    if(include && !include.includes(path)) continue;
    const start=local+30+dv.getUint16(local+26,true)+dv.getUint16(local+28,true);
    const raw=bytes.subarray(start,start+csize);
    let data;
    if(method===0) data=raw.slice();
    else if(method===8) data=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new GameSendError('BAD_FILE',`${path} is packed in a way this page cannot read.`);
    if(data.length!==usize || crc32(data)!==crc) throw new GameSendError('BAD_FILE',`${path} in the game download is damaged. Try again in a moment.`);
    out.push({path,bytes:data});
  }
  if(include) for(const want of include) if(!out.some(f=>f.path===want)) throw new GameSendError('BAD_FILE',`The game download is missing ${want}.`);
  if(!out.length) throw new GameSendError('BAD_FILE','The game download has no calculator files in it.');
  return out;
}
let CRC;
export function crc32(b) {
  if(!CRC) {CRC=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CRC[n]=c>>>0;}}
  let c=0xFFFFFFFF;
  for(let i=0;i<b.length;i++) c=CRC[(c^b[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}

// Pick the calculator: one this page was already allowed to use if there is
// exactly one, else the browser's picker. Chrome 153 spends the click's
// activation on the first picker it opens, so this prompts at most once per
// click and asks granted() first.
export async function pickCalculator({usb=globalThis.navigator?.usb}={}) {
  const granted=await CELink.granted({usb});
  if(granted.length===1) return CELink.fromDevice(granted[0]);
  return CELink.request({usb});
}

export {CELinkError};
