// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// node --test calcplex/test/gamepack.test.mjs
// The games-page engine in gamesend.mjs: multi-file games, zips, the space
// check and the jailbreak-tool check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import {collectEntries,planInstall,checkSpace,unpackZip,crc32,jailbreakTools,jailbreakState} from '../gamesend.mjs';
import {buildFile,makeEntry,TYPE} from '../../tifiles.mjs';

const SNAKE=new Uint8Array(readFileSync(new URL('../../fixtures/SnakeCE.8xg',import.meta.url)));

test('collectEntries(): two different variables under one name is a broken package',()=>{
  const a=buildFile([makeEntry({name:'LEVELS',type:TYPE.APPVAR,body:Uint8Array.of(1)})]);
  const b=buildFile([makeEntry({name:'LEVELS',type:TYPE.APPVAR,body:Uint8Array.of(2)})]);
  assert.throws(()=>collectEntries([a,b]),e=>e.code==='BAD_FILE' && /LEVELS/.test(e.message));
  assert.equal(collectEntries([a,a]).length,1,'an identical copy is fine');
});

test('checkSpace(): RAM is a running balance; a later delete cannot pay for an earlier send',()=>{
  // The case: LEVELS (3 KB) and GAME (8 KB) in RAM, 5 KB free. The new
  // LEVELS (12 KB) goes first; the 8 KB GAME delete comes after it.
  const app=(name,n)=>makeEntry({name,type:TYPE.APPVAR,body:new Uint8Array(n)});
  const prog=(name,n)=>makeEntry({name,type:TYPE.PROTECTED_PROGRAM,body:new Uint8Array(n)});
  const todo=collectEntries([buildFile([app('LEVELS',12000),prog('GAME',500)])]);
  const rows=[{name:'LEVELS',type:TYPE.APPVAR,size:3002,archived:false},{name:'GAME',type:TYPE.PROTECTED_PROGRAM,size:8002,archived:false}];
  assert.throws(()=>checkSpace(planInstall(todo,{rows,ramFree:5000,archiveFree:3e6})),e=>e.code==='NO_RAM_SPACE' && e.needKB>=4);
});

// ---- zips

function zip(files,{method=8,corrupt=false}={}) {
  const enc=new TextEncoder(),parts=[],central=[];
  let off=0;
  for(const [path,data] of files) {
    const name=enc.encode(path),body=method===8?deflateRawSync(data):data,crc=crc32(data);
    const h=Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(method,8);
    h.writeUInt32LE(crc,14);h.writeUInt32LE(body.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
    const c=Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(method,10);
    c.writeUInt32LE(corrupt?(crc^1)>>>0:crc,16);c.writeUInt32LE(body.length,20);c.writeUInt32LE(data.length,24);
    c.writeUInt16LE(name.length,28);c.writeUInt32LE(off,42);
    parts.push(h,name,body);central.push(c,name);
    off+=30+name.length+body.length;
  }
  const cd=Buffer.concat(central),e=Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(files.length,8);e.writeUInt16LE(files.length,10);
  e.writeUInt32LE(cd.length,12);e.writeUInt32LE(off,16);
  return new Uint8Array(Buffer.concat([...parts,cd,e]));
}

test('unpackZip(): stored and deflated, calculator files only, CRC-checked',async()=>{
  const a=SNAKE,b=Uint8Array.of(1,2,3);
  for(const method of [0,8]) {
    const files=await unpackZip(zip([['SnakeCE.8xg',a],['README.md',b],['__MACOSX/._SnakeCE.8xg',a]],{method}));
    assert.deepEqual(files.map(f=>f.path),['SnakeCE.8xg']);
    assert.deepEqual(files[0].bytes,a);
  }
  await assert.rejects(unpackZip(zip([['SnakeCE.8xg',a]],{corrupt:true})),e=>e.code==='BAD_FILE' && /damaged/.test(e.message));
  await assert.rejects(unpackZip(zip([['README.md',b]])),e=>e.code==='BAD_FILE');
  await assert.rejects(unpackZip(Uint8Array.of(1,2,3)),e=>e.code==='BAD_FILE');
  // A deflate stream that will not inflate, and a zip cut short: BAD_FILE, not a TypeError.
  const good=zip([['SnakeCE.8xg',a]]);
  const bad=good.slice();bad[40]^=0xFF;bad[41]^=0xFF;bad[45]^=0xFF;
  await assert.rejects(unpackZip(bad),e=>e.code==='BAD_FILE');
  await assert.rejects(unpackZip(good.slice(0,good.length-30)),e=>e.code==='BAD_FILE');
  const pick=await unpackZip(zip([['a/X.8xp',a],['b/Y.8xv',a]]),{include:['b/Y.8xv']});
  assert.deepEqual(pick.map(f=>f.path),['b/Y.8xv']);
  await assert.rejects(unpackZip(zip([['a/X.8xp',a]]),{include:['a/Z.8xp']}),e=>/missing a\/Z\.8xp/.test(e.message));
});

test('jailbreak tools: only the verified names, programs and apps by type',()=>{
  const row=(name,type)=>({name,type});
  const sized=(name,type,size)=>({name,type,size});
  assert.deepEqual(jailbreakTools([sized('A',TYPE.PROGRAM,904),row('AsmHook2',TYPE.FLASH_APP)]),['arTIfiCE','AsmHook2']);
  assert.deepEqual(jailbreakTools([sized('A',TYPE.PROGRAM,2)]),[],'an empty prgmA is not arTIfiCE');
  assert.deepEqual(jailbreakTools([row('Cesium',TYPE.FLASH_APP),row('CESIUM',TYPE.PROTECTED_PROGRAM)]),['Cesium','Cesium installer']);
  assert.deepEqual(jailbreakTools([row('A',TYPE.REAL??0),row('AsmHook2',TYPE.APPVAR),row('CHECKERS',TYPE.PROTECTED_PROGRAM)]),[],'a math A and an AppVar named like an app are not tools');
  assert.equal(jailbreakState('native',[]),'none');
  assert.equal(jailbreakState('v21',[]),'missing');
  assert.equal(jailbreakState('v3',['AsmHook2']),'found');
  assert.equal(jailbreakState('unsupported',['Cesium']),'blocked');
});
