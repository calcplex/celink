// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The wizard's adapter, against celink's simulated calculator.
//
// Everything here runs the REAL celink code over the REAL protocol:
// the simulator is a USBDevice-shaped calculator that checks the framing as it
// goes, so a test that passes has exercised the same bytes a CE would see.
//
// What is NOT covered here, and cannot be: the wizard's error classifier and
// the two screen texts it picks (installer.mjs calls boot() on import and
// needs a document). The code the low-battery mapping keys on IS covered: see
// the last test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CETransport} from '../transport.mjs';
import {parseVariable,OFFICIAL,inequalzStatus} from '../core.mjs';
import {CELink,CELinkError} from '../../celink.mjs';
import {parseFile,TYPE} from '../../tifiles.mjs';
import {SimulatedCalculator} from '../../sim/calculator.mjs';

const probe=new Uint8Array(readFileSync(new URL('../../fixtures/probe.8xp',import.meta.url)));
const probeEntry=parseVariable(probe);

const OS={v21:{major:5,minor:8,micro:4,build:58},v3:{major:5,minor:8,micro:5,build:74}};
const enc=s=>new TextEncoder().encode(s);
function noViolations(sim){assert.deepEqual(sim.violations,[],'the simulator saw no protocol violations');}
/** How many times the calculator was asked to take a variable or an app. */
function offered(sim){return sim.commands.filter(c=>c.type===0x000B).length;}

/** A transport wired to a simulated calculator, already connected. */
async function connected({route='v21',vars=[],...simOpts}={}) {
  const sim=new SimulatedCalculator({os:OS[route],vars,...simOpts});
  const t=new CETransport();
  const link=CELink.fromDevice(sim);
  link.timeout=500;link.streamTimeout=2000;link.appTimeout=2000;
  // connect() is covered on its own below; these tests start after it.
  await link.open();
  t.link=link;t.device=sim;t.calc=await link.info();
  t.info={model:t.calc.productName,os:t.calc.osVersion,route};
  return {sim,link,t};
}
/** One stored variable, in the shape SimulatedCalculator's `vars` takes. */
function stored(bytes) {
  const e=parseFile(bytes).entries[0];
  return {name:e.name,type:e.type,data:e.data,archived:e.archived,version:e.version};
}

// --- connect ---------------------------------------------------------------

test('connect picks a calculator, opens it and routes off its OS',async()=>{
  const sim=new SimulatedCalculator({os:OS.v3});
  const asked=[];
  const nav={usb:{
    requestDevice:async opts=>{asked.push(opts);return sim;},
    getDevices:async()=>[sim],
  }};
  Object.defineProperty(globalThis,'navigator',{value:nav,configurable:true,writable:true});
  try {
    const t=new CETransport();
    const info=await t.connect();
    assert.deepEqual(info,{model:'TI-84 Plus CE',os:'5.8.5.0074',route:'v3'});
    assert.equal(t.device,sim,'the picked device is exposed for the disconnect listener');
    assert.equal(t.poisoned,false);
    // TI's vendor id and nothing else: the picker must not offer other devices.
    assert.deepEqual(asked[0].filters,[{vendorId:0x0451}]);
    // A second TI calculator on the bus is refused rather than guessed at.
    nav.usb.getDevices=async()=>[sim,new SimulatedCalculator()];
    await assert.rejects(new CETransport().connect(),/only one TI calculator/);
    noViolations(sim);
  } finally {delete globalThis.navigator;}
});

test('connect reads a 5.3 calculator as the no-install route',async()=>{
  // The model and version checks themselves are core.mjs's (core.test.mjs);
  // what matters here is that the fields celink reads reach them intact.
  const sim=new SimulatedCalculator({os:{major:5,minor:3,micro:0,build:37}});
  Object.defineProperty(globalThis,'navigator',{
    value:{usb:{requestDevice:async()=>sim,getDevices:async()=>[sim]}},configurable:true,writable:true});
  try {
    assert.deepEqual(await new CETransport().connect(),{model:'TI-84 Plus CE',os:'5.3.0.0037',route:'native'});
  } finally {delete globalThis.navigator;}
  noViolations(sim);
});

// --- listing ---------------------------------------------------------------

test('directory fails closed when the listing does not carry both arrays',async()=>{
  const {t}=await connected();
  t.listing=async()=>({vars:[]});
  await assert.rejects(t.directory(),/No file was sent/);
});

// --- sendVerified: the happy path, read back off the calculator ------------

test('a file already on the calculator, identical, is reported not re-sent',async()=>{
  // An ordinary file. A jailbreak file is sent again instead: re-sending the
  // v3 trigger is what fires the install.
  const {sim,t}=await connected({route:'v3',vars:[stored(probe)]});
  const before=sim.log.length;
  const r=await t.sendVerified(probe);
  assert.deepEqual(r,{name:probeEntry.name,alreadyPresent:true,verified:true});
  assert.ok(sim.log.length>before,'it did read the calculator');
  assert.equal(offered(sim),0,'but never asked to send');
  noViolations(sim);
});

// --- sendVerified: the refusals --------------------------------------------

test('a same-name variable of another type stops the send before USB',async()=>{
  const {sim,t}=await connected({route:'v21',vars:[{name:probeEntry.name,type:TYPE.APPVAR,data:new Uint8Array(4)}]});
  await assert.rejects(t.sendVerified(probe),/already exists/);
  assert.equal(offered(sim),0,'nothing was offered to the calculator');
  noViolations(sim);
});

test('a game-style file still refuses a same-name program, but not a math value',async()=>{
  const {sim,t}=await connected({route:'v21',vars:[{name:probeEntry.name,type:TYPE.PROTECTED_PROGRAM,data:new Uint8Array([2,0,0,0])}]});
  await assert.rejects(t.sendVerified(probe),/already exists/);
  assert.equal(offered(sim),0);
});

test('sendVerified still refuses a Flash application outright',async()=>{
  const {t}=await connected({route:'v3'});
  t.directory=()=>assert.fail('the container is checked first');
  await assert.rejects(t.sendVerified(app8ek()),/Choose a TI-84 Plus CE/);
});

// --- sendVerified: the trigger that reboots the calculator as it lands ------

// What a 5.8.5 calculator did on hardware. It took the AppVar and
// acknowledged it in the ordinary way, so celink returned rebooted:false, and
// only THEN ran arTIfiCE's installer and restarted. The link was gone by the
// read-back, whose first read came back stalled:
// `USB_ERROR Reading from the calculator failed (USB status "stall")`, thrown
// from celink's _begin, although the install had worked.
/** Let the send finish normally, then take the calculator off the link. */
function rebootAfterAck(sim,link,how=()=>{sim.transferIn=async()=>({status:'stall',bytesWritten:0});}) {
  const send=link.send.bind(link);
  link.send=async(...a)=>{const r=await send(...a);how();return r;};
}

test('a dropped link on an ordinary send is still a failure',async()=>{
  // The tolerance is scoped to the trigger. Any other file that loses the link
  // after the calculator acknowledged it is a lost link, and says so.
  const {sim,t}=await connected({route:'v21'});
  rebootAfterAck(sim,t.link);
  await assert.rejects(t.sendVerified(probe),
    err=>err instanceof CELinkError&&err.code==='USB_ERROR');
  assert.equal(t.poisoned,true);
});

// --- precheck --------------------------------------------------------------

test('precheck clears a clean calculator, and clears the way on a dirty one',async()=>{
  const clean=await connected({route:'v3'});
  assert.equal(await clean.t.precheck(OFFICIAL.v3.files),true);
  // A half-finished v3 install left both behind. PPPP is left for its send to
  // overwrite; the trigger's name is cleared, since its send runs inside Inequalz.
  const dirty=await connected({route:'v3',vars:[
    {name:'PPPP',type:TYPE.PROGRAM,data:new Uint8Array([2,0,0,0])},
    {name:'INEQUVAR',type:TYPE.APPVAR,data:new Uint8Array([2,0,0,0])},
    {name:'PPPP',type:TYPE.APPVAR,data:new Uint8Array([2,0,0,0])},
  ]});
  assert.equal(await dirty.t.precheck(OFFICIAL.v3.files),true);
  assert.equal(offered(dirty.sim),0,'precheck never transfers anything');
  const left=(await dirty.t.directory()).map(e=>`${e.name}:${e.type}`).sort();
  assert.deepEqual(left,[`PPPP:${TYPE.PROGRAM}`]);
  noViolations(dirty.sim);
});

test('precheck lets arTIfiCE v2.1 through anything named A',async()=>{
  const prog=await connected({route:'v21',vars:[{name:'A',type:TYPE.PROGRAM,data:new Uint8Array([2,0,0,0])}]});
  assert.equal(await prog.t.precheck(OFFICIAL.v21.files),true);
  const appvar=await connected({route:'v21',vars:[{name:'A',type:TYPE.APPVAR,data:new Uint8Array([2,0,0,0])}]});
  assert.equal(await appvar.t.precheck(OFFICIAL.v21.files),true);
});

test('precheck still refuses a clash for a file that does not replace',async()=>{
  const {sim,t}=await connected({route:'v21',vars:[{name:probeEntry.name,type:TYPE.PROGRAM,data:new Uint8Array([2,0,0,0])}]});
  await assert.rejects(t.precheck([{name:probeEntry.name,type:TYPE.PROGRAM}]),/already exists on the calculator/);
  assert.equal(offered(sim),0);
});

// --- sendApp: the one non-variable send ------------------------------------
// A .8ek built the way celink's own app tests build one, so it satisfies
// core.mjs's parseFlashApp and celink's parser both.

function field(id,contents){
  const n=id&0x0F, len=contents.length;
  const lb=n===0x0D?[len]:n===0x0E?[len&255,len>>8]:[];
  const out=new Uint8Array(2+lb.length+len);
  out[0]=id>>8;out[1]=id&255;out.set(lb,2);out.set(contents,2+lb.length);
  return out;
}
function appImage(name,size){
  const nf=field(0x8140|name.length,enc(name));
  const head=new Uint8Array(6+nf.length);
  head[0]=0x81;head[1]=0x0F;
  const body=size-6;
  head[2]=body>>>24;head[3]=(body>>>16)&255;head[4]=(body>>>8)&255;head[5]=body&255;
  head.set(nf,6);
  const out=new Uint8Array(size);
  out.set(head);
  return out;
}
function app8ek({name='Inequalz',dataType=0x24,deviceType=0x73,size=2048}={}) {
  const data=appImage(name,size);
  const h=new Uint8Array(78);
  h.set(enc('**TIFL**'));
  h[8]=1;h[9]=2;h[12]=0x22;h[13]=0x09;h[14]=0x20;h[15]=0x26;
  h[16]=name.length;h.set(enc(name),17);
  h[48]=deviceType;h[49]=dataType;h[73]=0x13;
  h[74]=data.length&255;h[75]=(data.length>>8)&255;h[76]=(data.length>>16)&255;h[77]=data.length>>>24;
  const out=new Uint8Array(78+data.length);
  out.set(h);out.set(data,78);
  return out;
}

test('sendApp writes TI\'s application to Flash and the calculator then lists it',async()=>{
  const {sim,t}=await connected({route:'v3'});
  const r=await t.sendApp(app8ek());
  assert.deepEqual(r,{name:'Inequalz',sent:true});
  assert.equal(t.link.appTimeout,300000,'a megabyte of Flash does not finish inside the variable timeout');
  const listing=await t.listing();
  assert.deepEqual(listing.apps.map(a=>a.name),['Inequalz']);
  assert.equal(inequalzStatus(listing),'present');
  noViolations(sim);
});

test('sendApp refuses an operating system, a variable file and an unread calculator',async()=>{
  const {sim,t}=await connected({route:'v3'});
  await assert.rejects(t.sendApp(app8ek({dataType:0x23})),/operating system/i);
  await assert.rejects(t.sendApp(probe),/\.8ek/);
  assert.equal(offered(sim),0,'nothing was offered to the calculator for either');
  const cold=await connected({route:'v3'});
  cold.t.info=null;
  await assert.rejects(cold.t.sendApp(app8ek()),/Connect and read the OS first/);
  assert.equal(offered(cold.sim),0);
});

// --- the codes the wizard's two new outcomes key on ------------------------

test('a low battery stops a Flash write with LOW_BATTERY, before anything is sent',async()=>{
  const {sim,t}=await connected({route:'v3',battery:{ok:false,level:5,external:false}});
  await assert.rejects(t.sendApp(app8ek()),err=>err instanceof CELinkError&&err.code==='LOW_BATTERY');
  assert.equal(offered(sim),0,'the app was never offered');
  assert.equal(t.poisoned,false,'a refusal to start is not a dead link');
});
