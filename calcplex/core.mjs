// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
// Portions derived from libticalcs and libtifiles (tilibs), Copyright (C) the tilibs authors; see LIBTICALCS.md.
//
// Routing by CE OS version, strict file parsers, and the pinned arTIfiCE files.
//
// ROUTING: three install routes.
//   5.4 or earlier -> 'native'  nothing to install (see startHint for how a game starts)
//   5.5 .. 5.8.4   -> 'v21'     arTIfiCE v2.1, one file, becomes prgmA
//   5.8.5 exactly  -> 'v3'      arTIfiCE v3, two files + an app that stays
//   anything else  -> 'unsupported' / 'unknown', fails closed
// The v2.1 route is named 'v21', not 'launcher', so the two launcher routes
// cannot be confused at a call site.
//
// The author's published release assets, pinned by SHA-256. The arTIfiCE
// files are not in this repository. calcplex.com serves the official release
// files byte for byte; picking a downloaded copy is the fallback. These hashes
// are what says a file is the real one. Hashes taken 2026-09-21 from
// https://github.com/YvanTT/arTIfiCE/releases.
//
// `replaces` marks a jailbreak file. It is sent under its own name and
// replaces a variable with that name, whatever its type. Math values never
// clash at all (transport.mjs, NAMED). Games and any file picked by hand keep
// full collision protection.
//
// `expectReboot` marks the v3 trigger AppVar. Sending it makes the calculator
// install AsmHook2 and reboot on its own, so there is nothing to read back and
// the link drops. Its collision check runs earlier, while the calculator is
// still on the home screen (see CETransport.precheck in transport.mjs).
//
// HOSTED. calcplex.com serves the author's release assets
// itself, byte for byte, under HOSTED_BASE, with the author's LICENSE beside
// them and the author's release page linked from every download. fetchOfficial() pulls a file from there and checks
// it against the same pin before it is offered to the transport, so hosting
// removes two clicks and changes nothing about what is allowed through. Picking
// a downloaded file by hand is still supported and is the fallback when the
// fetch fails.
export const ARTIFICE_SHA256='46e2cd27a93bad402de8811d01d77f52b0419fb09a9162957703ffe0ef756caa';
export const HOSTED_BASE='/downloads/ce/artifice/';
export const OFFICIAL={
  v21:{label:'arTIfiCE v2.1',tag:'v2.1',files:[
    {file:'arTIfiCE_v2.1.8xp',sha256:ARTIFICE_SHA256,name:'A',type:5,replaces:true},
  ]},
  v3:{label:'arTIfiCE v3',tag:'v3',files:[
    {file:'arTIfiCE.8xp',sha256:'98cbadab42f34d63542d3648f97ff4ad20527ff39c35df12bbc00842454d262b',name:'PPPP',type:5,replaces:true},
    {file:'INEQUVAR.8xv',sha256:'cc47cdda6fef69590a5377c095443e1cda911454ef68c173f0de5d17be2a0000',name:'INEQUVAR',type:21,replaces:true,expectReboot:true},
  ]},
};
export function officialFiles(route){return OFFICIAL[route]?.files||[];}
export function compatibility(version) {
  if(!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return 'unknown';
  const [a,b,c]=version.split('.').map(Number);
  if(a!==5) return 'unknown';
  if(b<=4) return 'native';
  if(b>=5 && (b<8 || (b===8 && c<=4))) return 'v21';
  if(b===8 && c===5) return 'v3';
  return 'unsupported';
}
// Plain-language reason the wizard shows next to the route it picked. Never
// suggests changing the OS: the route is read off the calculator as it is.
export function routeReason(version) {
  const route=compatibility(version);
  if(route==='native') return 'Assembly programs already run on this version, so there is nothing to install.';
  if(route==='v21') return 'arTIfiCE v2.1 covers 5.5 through 5.8.4. It is one file and it becomes program A.';
  if(route==='v3') return 'arTIfiCE v3 is the version that covers 5.8.5. It is two files and an app that stays on the calculator.';
  if(route==='unsupported') return 'No published jailbreak covers this version yet.';
  return 'This version was not recognised, so no route was picked and nothing will be sent.';
}
// True when a game must be started with Asm( (OS 5.2 and earlier). Not advice
// to change the OS.
export function needsLegacyUpdate(version) {
  return compatibility(version)==='native' && Number(version.split('.')[1])<3;
}
// How to start an assembly program called `name` once it is on the
// calculator, as one status line. OS 5.2 and earlier start it through Asm(
// (observed on hardware on OS 5.0: Snake runs from Asm(prgmSNAKE, which has
// no closing parenthesis). 5.3 and 5.4 and the v3
// route run it from prgm; v2.1 runs it from the arTIfiCE shell, program A.
// Assembly programs are treated as compatible across CE OS versions, apart
// from needing the jailbreak on 5.5 and later.
export function startHint(version,name) {
  const route=compatibility(version);
  if(route==='v21') return `Press prgm, run A, and pick ${name}.`;
  if(needsLegacyUpdate(version)) return `Start it with Asm(: press 2nd, 0, pick Asm(, press prgm, pick ${name}, and press enter.`;
  return `Press prgm, pick ${name}, and press enter twice.`;
}
export function parseVariable(input) {
  const b=new Uint8Array(input), v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(b.length<74 || new TextDecoder().decode(b.slice(0,10))!=='**TI83F*\x1a\x0a' || ![0,0x13].includes(b[10])) throw Error('Choose a TI-84 Plus CE .8xp or .8xv file.');
  const section=v.getUint16(53,true), h=v.getUint16(55,true), size=v.getUint16(57,true);
  if(h!==13 || 55+section+2!==b.length || section!==2+h+2+size || v.getUint16(70,true)!==size) throw Error('Choose a file containing one variable. The file is invalid or contains a group.');
  if(![5,6,21].includes(b[59])) throw Error('Only programs and AppVars are supported.');
  const nameBytes=b.slice(60,68), end=nameBytes.indexOf(0);
  const name=new TextDecoder().decode(end<0?nameBytes:nameBytes.slice(0,end));
  if(!/^[A-Z][A-Z0-9]{0,7}$/.test(name)) throw Error('Only names beginning with A–Z and containing A–Z or 0–9 are supported.');
  let sum=0;for(let i=55;i<b.length-2;i++) sum=(sum+b[i])&65535;
  if(v.getUint16(b.length-2,true)!==sum) throw Error('The file checksum is invalid. Download it again.');
  return {name,type:b[59],payload:b.slice(72,72+size),bytes:b};
}
export function sameVariable(a,b) {
  const x=parseVariable(a),y=parseVariable(b);
  return x.name===y.name&&x.type===y.type&&x.payload.length===y.payload.length&&x.payload.every((v,i)=>v===y.payload[i]);
}
export function renameProbe(input,name) {
  if(!/^G[A-F0-9]{7}$/.test(name)) throw Error('Invalid probe name');
  const b=new Uint8Array(input).slice(); parseVariable(b);
  b.set(new TextEncoder().encode(name),60);
  let sum=0;for(let i=55;i<b.length-2;i++)sum=(sum+b[i])&65535;
  new DataView(b.buffer).setUint16(b.length-2,sum,true);return b;
}
export function parseInfo(text,model) {
  const os=text.match(/^OS Version:\s*(\d+\.\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1];
  if(!/^TI-84\+CE(?: USB)?$/.test(model) && !/^TI-84 Plus CE(?: USB)?$/.test(model)) throw Error(`Detected ${model||'an unknown model'}. Connect a TI-84 Plus CE.`);
  if(!os) throw Error('Could not read an exact OS version. No files will be sent.');
  return {model,os,route:compatibility(os)};
}
// Which official file a user just picked, by hash. Returns the spec or null.
// The wizard uses this so the two v3 files can be chosen in either order and
// a file from the wrong release is named rather than silently sent.
export async function identifyOfficial(route,bytes) {
  const hash=await digest(bytes);
  return officialFiles(route).find(f=>f.sha256===hash)||null;
}
// Where this site serves the author's copy of a release asset.
export function hostedUrl(spec) {
  if(!spec||!spec.file) throw Error('No file to fetch.');
  return HOSTED_BASE+spec.file;
}
// Fetch one official file from this site and check it against its pin. Returns
// the bytes. Anything at all wrong throws, and the wizard then falls back to
// asking the person to download from the author's release page: a failure here
// must never turn into an unchecked send.
export async function fetchOfficial(spec,fetcher) {
  const get=fetcher||(typeof fetch==='function'?fetch:null);
  if(!get) throw Error('This browser cannot fetch the file.');
  const response=await get(hostedUrl(spec));
  if(!response||!response.ok) throw Error(`${spec.file} could not be downloaded from this site.`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(await digest(bytes)!==spec.sha256) throw Error(`${spec.file} did not match the author's published release and was discarded.`);
  return bytes;
}
// Windows is the only platform where the browser cannot talk to a CE out of the
// box: WebUSB needs the WinUSB driver, and TI Connect CE 6.1 and later is what
// installs it. macOS and ChromeOS need no driver; a ChromeOS connection has not
// been confirmed yet. userAgentData is the supported
// signal in current Chrome and Edge; the userAgent string is the fallback for
// everything that does not expose it.
export function isWindows(nav) {
  if(!nav) return false;
  const hinted=nav.userAgentData&&nav.userAgentData.platform;
  if(typeof hinted==='string'&&hinted) return hinted==='Windows';
  return /Windows|Win32|Win64|WOW64/i.test(String(nav.userAgent||''));
}
// Chrome OS: no TI Connect CE exists for it, so failure copy there must not
// send a student to install or close it.
export function isChromeOS(nav) {
  if(!nav) return false;
  const hinted=nav.userAgentData&&nav.userAgentData.platform;
  if(typeof hinted==='string'&&hinted) return hinted==='Chrome OS'||hinted==='Chromium OS';
  return /\bCrOS\b/.test(String(nav.userAgent||''));
}
// ce_connect_fail's `open_detail` analytics parameter: WHERE a connect died,
// in a fixed vocabulary, never the browser's own text.
// OPEN_FAILED carries celink's step (open/config/claim/alt) and the
// DOMException name, so a Chromebook policy block (open_security) reads apart
// from a held interface (claim_network) without hardware. A TIMEOUT while
// connecting means the port opened and the calculator never answered
// (no_reply). Anything else: none.
const OPEN_STEPS=['open','config','claim','alt'];
const OPEN_CAUSES={SecurityError:'security',NetworkError:'network',InvalidStateError:'state',NotFoundError:'notfound',AbortError:'abort'};
export function openDetail(err) {
  const code=err&&err.code;
  if(code==='TIMEOUT') return 'no_reply';
  if(code!=='OPEN_FAILED') return undefined;
  const step=OPEN_STEPS.includes(err.step)?err.step:'other';
  return `${step}_${Object.hasOwn(OPEN_CAUSES,err.cause)?OPEN_CAUSES[err.cause]:'other'}`;
}
// --- TI's Inequality Graphing app -----------------------------------------
// arTIfiCE v3 installs THROUGH Inequalz: the trigger AppVar only does anything
// while that app is open. A calculator without it cannot finish the route, so
// the wizard reads the app list before it sends anything and says so up front
// rather than letting the student find out at the last step.
//
// The name match is a prefix, case-insensitive: the calculator reports the app
// header's own name, which is "Inequalz" in the APPS menu on both the TI-84
// Plus CE and the TI-83 Premium CE. A prefix covers a shorter stored name.
export const INEQUALZ_NAME=/^inequal/i;
export const INEQUALZ_URL='https://education.ti.com/en/software/details/en/8C7FB96338F9469BB9D970AFC034EC39/inequality-graphing-app';
// 'present' | 'missing' | 'unknown'. 'unknown' is a real answer, not a bug:
// a listing that cannot report apps must not be read as "it is not there".
export function inequalzStatus(listing) {
  if(!listing||!Array.isArray(listing.apps)) return 'unknown';
  for(const app of listing.apps) {
    const name=app&&typeof app.name==='string'?app.name.trim():'';
    if(INEQUALZ_NAME.test(name)) return 'present';
  }
  return 'missing';
}

// --- Flash app (.8ek) container -------------------------------------------
// A SECOND strict parser, for the one file this project sends that is not a
// variable. parseVariable refuses everything that is not a **TI83F* single
// variable, which is what keeps OS and app files off transport.sendVerified.
// Sending TI's app needs a different container, so it gets its own parser with
// its own closed door rather than a hole in that one.
//
// Layout from libtifiles (files8x.cc ti8x_file_read_flash, filetypes.cc
// buffer_has_tifl_header): 78-byte header per entry, then its data.
//   0..7   "**TIFL**"
//   17..24 name
//   48     device type  0x73 = 83+/84+/CE family, 0x74 = 73
//   49     data type    0x23 OS, 0x24 application, 0x25 certificate, 0x3e license
//   74..77 data length, little endian
// A file may hold several entries (an app with its certificate). This parser
// refuses the file if any entry is an operating system, whatever the entry
// order.
export const TIFL_HEADER=78;
export const TIFL_OS=0x23, TIFL_APP=0x24, TIFL_CERT=0x25, TIFL_LICENSE=0x3e;
export const TIFL_DEVICE_83P=0x73;
export function parseFlashApp(input) {
  const b=new Uint8Array(input);
  if(b.length<TIFL_HEADER||new TextDecoder().decode(b.slice(0,8))!=='**TIFL**')
    throw Error('Choose the .8ek application file you downloaded from TI.');
  const entries=[];
  let at=0;
  while(at+TIFL_HEADER<=b.length) {
    if(new TextDecoder().decode(b.slice(at,at+8))!=='**TIFL**') break;
    const device=b[at+48], data=b[at+49];
    const length=b[at+74]|(b[at+75]<<8)|(b[at+76]<<16)|(b[at+77]<<24);
    const raw=b.slice(at+17,at+25), stop=raw.indexOf(0);
    entries.push({device,data,length,name:new TextDecoder().decode(stop<0?raw:raw.slice(0,stop)).replace(/\s+$/,'')});
    // An entry that claims more data than the file holds is a truncated
    // download. libtifiles stops reading and treats what it has as the file;
    // this parser refuses it instead, because a short Flash write is not
    // something to hand a calculator.
    if(length<0||length>b.length-(at+TIFL_HEADER))
      throw Error('That file is incomplete. Download it again from TI. Nothing was sent.');
    at+=TIFL_HEADER+length;
  }
  if(!entries.length) throw Error('Choose the .8ek application file you downloaded from TI.');
  if(entries.some(e=>e.data===TIFL_OS))
    throw Error('That is a calculator operating system, not an application. Nothing was sent. This page never sends an OS.');
  if(entries.some(e=>e.device!==TIFL_DEVICE_83P))
    throw Error('That file is not for the TI-84 Plus CE family. Nothing was sent.');
  const last=entries[entries.length-1];
  if(last.data!==TIFL_APP)
    throw Error('That file is not a calculator application. Nothing was sent.');
  const named=entries.filter(e=>e.data===TIFL_APP&&e.name).pop();
  return {name:named?named.name:'',entries};
}
export async function digest(bytes) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
