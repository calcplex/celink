// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// node --test calcplex/test/gamesend.test.mjs
// The installer's Send Snake button, against the simulated CE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {sendGame,gameEntries,isAssembly,pickCalculator} from '../gamesend.mjs';
import {CELink} from '../../celink.mjs';
import {parseFile,TYPE} from '../../tifiles.mjs';
import {SimulatedCalculator} from '../../sim/calculator.mjs';

// CalcPlex's own Snake: the games hub's SnakeCE.8xg, which the installer's
// Send Snake button fetches. The program inside is named SNAKE.
const SNAKE=new Uint8Array(readFileSync(new URL('../../fixtures/SnakeCE.8xg',import.meta.url)));
const SNAKE_SHA256='72daeecd410e2eca8b9e6a0d7fa4f2f4ebc725b2c2c52cbc3c69088ee6405ea4';
const OS={
  early:{major:5,minor:0,micro:0,build:89},
  native:{major:5,minor:3,micro:0,build:37},
  v21:{major:5,minor:8,micro:4,build:58},
  v3:{major:5,minor:8,micro:5,build:74},
  unsupported:{major:5,minor:8,micro:6,build:10},
};
const offered=sim=>sim.commands.filter(c=>c.type===0x000B).length;
const deleted=sim=>sim.commands.filter(c=>c.type===0x0010).length;

async function open({os='native',vars=[],...simOpts}={}) {
  const sim=new SimulatedCalculator({os:OS[os],vars,...simOpts});
  const link=CELink.fromDevice(sim);
  link.timeout=500;link.streamTimeout=2000;
  await link.open();
  return {sim,link};
}
const stored=(bytes,patch)=>{
  const e=parseFile(bytes).entries[0];
  const data=patch?patch(e.data.slice()):e.data;
  return {name:e.name,type:e.type,data,archived:e.archived,version:e.version};
};

test('Snake is the pinned build: one assembly program, no libraries',()=>{
  assert.equal(SNAKE.length,10491);
  assert.equal(createHash('sha256').update(SNAKE).digest('hex'),SNAKE_SHA256);
  const [e,...rest]=gameEntries(SNAKE);
  assert.equal(rest.length,0,'nothing rides along: no LibLoad, no C libraries');
  assert.equal(e.name,'SNAKE');
  assert.equal(e.type,TYPE.PROTECTED_PROGRAM);
  assert.ok(isAssembly(e));
});

for(const os of ['native','v21','v3']) {
  test(`sends Snake to an empty ${os} calculator and reads it back`,async()=>{
    const {sim,link}=await open({os});
    const seen=[];
    const r=await sendGame(link,SNAKE,{onProgress:(d,t)=>seen.push([d,t])});
    assert.deepEqual(r.sent,['SNAKE']);
    assert.deepEqual(r.replaced,[]);
    assert.equal(r.route,os);
    assert.equal(r.asm,true);
    assert.deepEqual(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM).data,gameEntries(SNAKE)[0].data);
    assert.ok(seen.length>0,'progress was reported');
    const n=gameEntries(SNAKE)[0].data.length;
    assert.deepEqual(seen.at(-1),[n,n]);
    assert.deepEqual(sim.violations,[]);
  });
}

test('OS 5.0 needs no jailbreak: Snake is sent, read back, and the route is native',async()=>{
  const {sim,link}=await open({os:'early'});
  const r=await sendGame(link,SNAKE);
  assert.deepEqual(r.sent,['SNAKE']);
  assert.equal(r.route,'native');
  assert.match(r.os,/^5\.0\.0/);
  assert.deepEqual(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM).data,gameEntries(SNAKE)[0].data);
  assert.deepEqual(sim.violations,[]);
});

test('an OS no jailbreak covers gets no assembly game, and nothing is sent',async()=>{
  const {sim,link}=await open({os:'unsupported'});
  await assert.rejects(sendGame(link,SNAKE),e=>e.code==='NO_JAILBREAK' && /5\.8\.6/.test(e.message));
  assert.equal(offered(sim),0);
});

test('the same Snake already there is sent again, no compare',async()=>{
  const {sim,link}=await open({vars:[stored(SNAKE)]});
  const r=await sendGame(link,SNAKE);
  assert.deepEqual(r.sent,['SNAKE']);
  assert.deepEqual(r.replaced,['SNAKE']);
  assert.equal(offered(sim),1);
  assert.deepEqual(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM).data,gameEntries(SNAKE)[0].data);
});

test('a different SNAKE is replaced without asking',async()=>{
  const old=stored(SNAKE,d=>{d[d.length-1]^=0xFF;return d;});
  const {sim,link}=await open({vars:[old]});
  const r=await sendGame(link,SNAKE);
  assert.deepEqual(r.sent,['SNAKE']);
  assert.deepEqual(r.replaced,['SNAKE']);
  assert.equal(deleted(sim),1);
  assert.deepEqual(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM).data,gameEntries(SNAKE)[0].data);
});

test('a variable with the same name is replaced, whatever its type',async()=>{
  for(const type of [TYPE.PROGRAM,TYPE.APPVAR]) {
    const {sim,link}=await open({vars:[{name:'SNAKE',type,data:Uint8Array.of(1,0,0x31),archived:false,version:0}]});
    const r=await sendGame(link,SNAKE);
    assert.deepEqual(r.replaced,['SNAKE']);
    assert.equal(sim.get('SNAKE',type),undefined,'the old one is gone');
    assert.deepEqual(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM).data,gameEntries(SNAKE)[0].data);
  }
});

test('another calculator model is refused before anything is listed',async()=>{
  // The simulator always answers as a CE, so the reply is stubbed here.
  const {sim,link}=await open();
  link.info=async()=>({productName:'TI-84 Plus',osVersion:'2.55.0'});
  await assert.rejects(sendGame(link,SNAKE),e=>e.code==='OTHER_MODEL');
  assert.equal(offered(sim),0);
});

test('pickCalculator reuses the one granted calculator and prompts only when there is none',async()=>{
  const sim=new SimulatedCalculator({os:OS.native});
  let prompts=0;
  const usb=g=>({getDevices:async()=>g,requestDevice:async()=>{prompts++;return sim;}});
  const a=await pickCalculator({usb:usb([sim])});
  assert.equal(a.device,sim);
  assert.equal(prompts,0);
  const b=await pickCalculator({usb:usb([])});
  assert.equal(b.device,sim);
  assert.equal(prompts,1);
  await pickCalculator({usb:usb([sim,new SimulatedCalculator()])});
  assert.equal(prompts,2,'two granted calculators: ask which');
});


test('the calculator gets SNAKE, the name inside the file, not the SnakeCE URL name',async()=>{
  const {sim,link}=await open({os:'v3'});
  const r=await sendGame(link,SNAKE);
  assert.deepEqual(r.sent,['SNAKE']);
  assert.ok(sim.get('SNAKE',TYPE.PROTECTED_PROGRAM),'SNAKE is there');
  assert.ok(!sim.get('SNAKECE',TYPE.PROTECTED_PROGRAM) && !sim.get('SNAKECE',TYPE.PROGRAM),'no SNAKECE was made');
});
