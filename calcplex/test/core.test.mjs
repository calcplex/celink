// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {compatibility,parseVariable,renameProbe,sameVariable,parseInfo,
        OFFICIAL,officialFiles,routeReason,
        HOSTED_BASE,hostedUrl,isWindows,isChromeOS,openDetail,
        inequalzStatus,parseFlashApp,TIFL_APP,TIFL_OS,TIFL_CERT,TIFL_LICENSE} from '../core.mjs';
const load=name=>new Uint8Array(readFileSync(new URL('../../fixtures/'+name,import.meta.url)));
const probe=load('probe.8xp');
test('OS routing fails closed on unknown and newer OS',()=>{
 for(const v of ['5.3.0.0037','5.4.0.0034'])assert.equal(compatibility(v),'native');
 for(const v of ['5.5.1.0058','5.8.3.0001','5.8.4.0058'])assert.equal(compatibility(v),'v21');
 for(const v of ['5.10.0.0000','5.9.0.0000','5.8.6.0000'])assert.equal(compatibility(v),'unsupported');
 for(const v of ['7.0.0.3996','5.8','garbage','5.8.4junk'])assert.equal(compatibility(v),'unknown');
});
test('5.8.5 routes to arTIfiCE v3 and nothing else does',()=>{
 for(const v of ['5.8.5','5.8.5.0001','5.8.5.9999'])assert.equal(compatibility(v),'v3');
 // the boundary either side of the v3 window
 assert.equal(compatibility('5.8.4.0058'),'v21');
 assert.equal(compatibility('5.8.6.0000'),'unsupported');
});
test('every route explains itself without naming an OS change',()=>{
 for(const v of ['5.3.0.0037','5.8.4.0058','5.8.5','5.9.0.0000','nonsense']) {
  const why=routeReason(v);
  assert.ok(why.length>20,`no reason for ${v}`);
  assert.doesNotMatch(why,/updat|upgrad|downgrad|should work/i,`route reason for ${v} steers the OS`);
 }
});
test('official file registry is pinned by hash, name and type',()=>{
 assert.equal(officialFiles('native').length,0);
 assert.equal(officialFiles('unsupported').length,0);
 assert.equal(officialFiles('v21').length,1);
 assert.equal(officialFiles('v3').length,2);
 // every jailbreak file replaces whatever has its name, of any type; games never do
 const replacing=[...officialFiles('v21'),...officialFiles('v3')].filter(f=>f.replaces);
 assert.deepEqual(replacing.map(f=>f.file),['arTIfiCE_v2.1.8xp','arTIfiCE.8xp','INEQUVAR.8xv']);
 // the v3 trigger AppVar is the only file that expects a reboot instead of a readback
 const rebooting=officialFiles('v3').filter(f=>f.expectReboot);
 assert.deepEqual(rebooting.map(f=>f.name),['INEQUVAR']);
 for(const f of [...officialFiles('v21'),...officialFiles('v3')]) {
  assert.match(f.sha256,/^[0-9a-f]{64}$/,`${f.file} has no pinned hash`);
  assert.match(f.name,/^[A-Z][A-Z0-9]{0,7}$/,`${f.file} has an unsendable name`);
  assert.ok([5,6,21].includes(f.type),`${f.file} has a disallowed type`);
 }
 assert.equal(OFFICIAL.v3.tag,'v3');
});
test('exact CE model and exact OS required',()=>{
 assert.equal(parseInfo('OS Version: 5.8.4.0058\n','TI-84 Plus CE').os,'5.8.4.0058');
 assert.throws(()=>parseInfo('OS Version: 7.0.0.3996','TI-84 Evo'));
 assert.throws(()=>parseInfo('Boot Version: 5.8.4.0058','TI-84 Plus CE'));
});
test('valid probe and random name retain payload',()=>{
 assert.equal(parseVariable(probe).name,'LINKTEST');const b=renameProbe(probe,'G123ABCD');
 assert.equal(parseVariable(b).name,'G123ABCD');assert.deepEqual(parseVariable(b).payload,parseVariable(probe).payload);
 assert.equal(sameVariable(probe,b),false);assert.equal(sameVariable(b,b),true);
});
test('reject corruption, firmware, groups, disallowed types and truncated data',()=>{
 const corrupt=probe.slice();corrupt[72]^=1;assert.throws(()=>parseVariable(corrupt));
 assert.throws(()=>parseVariable(new TextEncoder().encode('**TIFL**')));
 assert.throws(()=>parseVariable(probe.slice(0,70)));
 const invalidType=probe.slice();invalidType[59]=0x23;assert.throws(()=>parseVariable(invalidType));
 const group=new Uint8Array(probe.length+1);group.set(probe);assert.throws(()=>parseVariable(group));
});

test("accept CE product identifier used by official arTIfiCE",()=>{
 const bytes=load("probe.8xp");bytes[10]=0x13;assert.equal(parseVariable(bytes).name,"LINKTEST");
});

test('the pre-5.3 predicate answers only for CE versions before 5.3',async()=>{
 const {needsLegacyUpdate}=await import('../core.mjs');
 for(const v of ['5.0.0.0089','5.1.5.0019','5.2.2.0043'])assert.equal(needsLegacyUpdate(v),true);
 for(const v of ['5.3.0.0037','5.4.0.0034','5.8.4.0058','5.8.5','7.0.0.3996','bad','5.2'])assert.equal(needsLegacyUpdate(v),false);
});

// --- the Windows driver note ----------------------------------------------
// Windows is the only platform with something to install before the browser
// can reach a CE (the WinUSB driver, which TI Connect CE 6.1+ installs). The
// wizard shows the callout on exactly the platforms this returns true for, so
// a wrong answer either nags a Mac or leaves a Windows reader stuck.
test('Windows is detected from userAgentData first, then the userAgent',()=>{
 // the modern signal wins outright, even when the UA string disagrees
 assert.equal(isWindows({userAgentData:{platform:'Windows'},userAgent:'Mozilla/5.0 (Macintosh)'}),true);
 assert.equal(isWindows({userAgentData:{platform:'macOS'},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}),false);
 for(const p of ['macOS','Linux','Chrome OS','Android','iOS'])
  assert.equal(isWindows({userAgentData:{platform:p},userAgent:'Mozilla/5.0 (Windows NT 10.0)'}),false,p);
 // the fallback, for browsers that do not expose userAgentData at all
 assert.equal(isWindows({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140'}),true);
 assert.equal(isWindows({userAgent:'Mozilla/5.0 (Windows NT 6.1; WOW64) Firefox/151'}),true);
 assert.equal(isWindows({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140'}),false);
 assert.equal(isWindows({userAgent:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140'}),false);
 assert.equal(isWindows({userAgent:'Mozilla/5.0 (Linux; Android 14) Chrome/140'}),false);
 // an empty userAgentData.platform is not an answer, so it falls through
 assert.equal(isWindows({userAgentData:{platform:''},userAgent:'Mozilla/5.0 (Windows NT 10.0)'}),true);
 // nothing to read at all is never Windows
 assert.equal(isWindows(null),false);
 assert.equal(isWindows({}),false);
});

// --- the hosted arTIfiCE files --------------------------------------------
// This site now serves the author's release assets, each under one folder
// and named after the release asset.
test('hosted URLs sit under one folder and are named after the release asset',()=>{
 assert.equal(HOSTED_BASE,'/downloads/ce/artifice/');
 assert.equal(hostedUrl(OFFICIAL.v21.files[0]),'/downloads/ce/artifice/arTIfiCE_v2.1.8xp');
 assert.equal(hostedUrl(OFFICIAL.v3.files[0]),'/downloads/ce/artifice/arTIfiCE.8xp');
 assert.equal(hostedUrl(OFFICIAL.v3.files[1]),'/downloads/ce/artifice/INEQUVAR.8xv');
 assert.throws(()=>hostedUrl(null));
 assert.throws(()=>hostedUrl({}));
});

// --- is TI's Inequalz app on the calculator? -------------------------------
// The v3 route runs through that app, so the wizard reads the app list before
// it asks for a RAM reset. Three answers, and "unknown" has to stay distinct
// from "missing": a listing that cannot report apps must never be read as
// proof the app is absent.
test('the app list answers present, missing or unknown',()=>{
 const apps=names=>({memory:{},vars:[],apps:names.map(name=>({name,folder:'',type:36,type_name:'APPL'}))});
 assert.equal(inequalzStatus(apps(['Inequalz'])),'present');
 assert.equal(inequalzStatus(apps(['Finance','Inequalz','PlySmlt2'])),'present');
 // the calculator's own casing and padding are not something to bet on
 assert.equal(inequalzStatus(apps(['INEQUALZ'])),'present');
 assert.equal(inequalzStatus(apps(['inequal'])),'present');
 assert.equal(inequalzStatus(apps([' Inequalz '])),'present');
 assert.equal(inequalzStatus(apps(['Finance','PlySmlt2','AsmHook2'])),'missing');
 assert.equal(inequalzStatus(apps([])),'missing');
 // a near miss is not a match
 assert.equal(inequalzStatus(apps(['Equation','Polynom'])),'missing');
 // no apps array at all: the calculator did not say, so neither do we
 assert.equal(inequalzStatus({memory:{},vars:[]}),'unknown');
 assert.equal(inequalzStatus({memory:{},vars:[],apps:null}),'unknown');
 assert.equal(inequalzStatus(null),'unknown');
 assert.equal(inequalzStatus(undefined),'unknown');
 // junk entries are skipped rather than thrown on
 assert.equal(inequalzStatus({vars:[],apps:[null,{},{name:42},{name:'Inequalz'}]}),'present');
 assert.equal(inequalzStatus({vars:[],apps:[null,{},{name:42}]}),'missing');
});

// --- the Flash app container ----------------------------------------------
// This parser is the door a picked file has to get through before anything
// can reach a Flash write, and it refuses an operating system whatever the
// entry order is. Layout from the **TIFL** container.
function tifl({name='Inequalz',device=0x73,data=0x24,payload=8}={}) {
 const b=new Uint8Array(78+payload);
 b.set(new TextEncoder().encode('**TIFL**'),0);
 b.set(new TextEncoder().encode(name.padEnd(8,'\0').slice(0,8)),17);
 b[48]=device; b[49]=data;
 b[74]=payload&255; b[75]=(payload>>8)&255; b[76]=(payload>>16)&255; b[77]=(payload>>24)&255;
 return b;
}
function join(...parts) {
 const total=parts.reduce((n,p)=>n+p.length,0), out=new Uint8Array(total);
 let at=0; for(const p of parts){out.set(p,at);at+=p.length;}
 return out;
}
test('a Flash app file is accepted and its name read',()=>{
 const app=parseFlashApp(tifl({name:'Inequalz'}));
 assert.equal(app.name,'Inequalz');
 assert.equal(app.entries.length,1);
 assert.equal(app.entries[0].data,TIFL_APP);
 // a short name is NUL-padded in the header and comes back trimmed
 assert.equal(parseFlashApp(tifl({name:'Inequal'})).name,'Inequal');
});
test('an operating system is refused, whatever else is in the file',()=>{
 assert.throws(()=>parseFlashApp(tifl({data:TIFL_OS})),/operating system/i);
 // An OS entry is refused before or after an app entry: the whole file goes.
 assert.throws(()=>parseFlashApp(join(tifl({data:TIFL_OS}),tifl({data:TIFL_APP}))),/operating system/i);
 assert.throws(()=>parseFlashApp(join(tifl({data:TIFL_APP}),tifl({data:TIFL_OS}))),/operating system/i);
});
test('a certificate, a license and a foreign device are refused',()=>{
 assert.throws(()=>parseFlashApp(tifl({data:TIFL_CERT})),/not a calculator application/i);
 assert.throws(()=>parseFlashApp(tifl({data:TIFL_LICENSE})),/not a calculator application/i);
 assert.throws(()=>parseFlashApp(tifl({device:0x74})),/not for the TI-84 Plus CE/i);
});
test('an app carrying its certificate is accepted and named from the app entry',()=>{
 // the real shape of a signed app: certificate entry, then the application
 const app=parseFlashApp(join(tifl({name:'Cert',data:TIFL_CERT}),tifl({name:'Inequalz',data:TIFL_APP})));
 assert.equal(app.entries.length,2);
 assert.equal(app.name,'Inequalz');
});
test('anything that is not a TIFL container is refused',()=>{
 assert.throws(()=>parseFlashApp(probe),/\.8ek/);
 assert.throws(()=>parseFlashApp(new Uint8Array(10)),/\.8ek/);
 assert.throws(()=>parseFlashApp(new TextEncoder().encode('**TI83F*\x1a\x0a'.padEnd(200,'\0'))),/\.8ek/);
 // truncated: the header says more data follows than the file holds
 const short=tifl({payload:8}); short[74]=200;
 assert.throws(()=>parseFlashApp(short),/incomplete/i);
});
test('a variable file never parses as an app and an app never as a variable',()=>{
 assert.throws(()=>parseFlashApp(probe));
 assert.throws(()=>parseVariable(tifl()));
});

test('startHint: Asm( on 5.2 and earlier, prgm on 5.3 to 5.4 and v3, the shell on v2.1',async()=>{
  const {startHint}=await import('../core.mjs');
  for(const v of ['5.0.0.0089','5.1.5.0019','5.2.2.0043'])
    assert.equal(startHint(v,'SNAKE'),'Start it with Asm(: press 2nd, 0, pick Asm(, press prgm, pick SNAKE, and press enter.');
  for(const v of ['5.3.0.0037','5.4.0.0034','5.8.5.0074'])
    assert.equal(startHint(v,'SNAKE'),'Press prgm, pick SNAKE, and press enter twice.');
  assert.equal(startHint('5.8.4.0058','SNAKE'),'Press prgm, run A, and pick SNAKE.');
  for(const v of ['5.0.0.0089','5.3.0.0037','5.8.4.0058','5.8.5']) assert.ok(!/\u2014/.test(startHint(v,'SNAKE')),'no em dash');
});

test('Chrome OS is detected from userAgentData first, then CrOS in the userAgent',()=>{
 assert.equal(isChromeOS({userAgentData:{platform:'Chrome OS'},userAgent:'Mozilla/5.0 (Macintosh)'}),true);
 assert.equal(isChromeOS({userAgentData:{platform:'Chromium OS'}}),true);
 for(const p of ['macOS','Linux','Windows','Android'])
  assert.equal(isChromeOS({userAgentData:{platform:p},userAgent:'Mozilla/5.0 (X11; CrOS x86_64)'}),false,p);
 assert.equal(isChromeOS({userAgent:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140'}),true);
 assert.equal(isChromeOS({userAgent:'Mozilla/5.0 (X11; Linux x86_64) Chrome/140'}),false);
 assert.equal(isChromeOS({userAgentData:{platform:''},userAgent:'Mozilla/5.0 (X11; CrOS aarch64)'}),true);
 assert.equal(isChromeOS(null),false);
});
test('open_detail is a fixed vocabulary: step_cause for OPEN_FAILED, no_reply for TIMEOUT',()=>{
 assert.equal(openDetail({code:'OPEN_FAILED',step:'open',cause:'SecurityError'}),'open_security');
 assert.equal(openDetail({code:'OPEN_FAILED',step:'claim',cause:'NetworkError'}),'claim_network');
 assert.equal(openDetail({code:'OPEN_FAILED',step:'config',cause:'InvalidStateError'}),'config_state');
 // anything unexpected collapses to other, so no browser text reaches analytics
 assert.equal(openDetail({code:'OPEN_FAILED',step:'<script>',cause:'Access denied.'}),'other_other');
 assert.equal(openDetail({code:'OPEN_FAILED'}),'other_other');
 assert.equal(openDetail({code:'OPEN_FAILED',step:'claim',cause:'constructor'}),'claim_other','no prototype names');
 assert.equal(openDetail({code:'TIMEOUT'}),'no_reply');
 assert.equal(openDetail({code:'NO_DEVICE_SELECTED'}),undefined);
 assert.equal(openDetail(null),undefined);
});
