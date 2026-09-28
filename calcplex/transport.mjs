// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink; see README.md and LIBTICALCS.md.
import {digest,officialFiles,parseFlashApp,parseInfo,parseVariable,sameVariable} from './core.mjs';
import {CELink,CELinkError} from '../celink.mjs';
import {buildFile,parseFile,TYPE} from '../tifiles.mjs';
// Adapter from the installer to celink (../celink.mjs).
//
// The method names and return shapes below are the ones the wizard calls.
// Underneath, celink serialises its own operations, carries stable error
// CODES rather than sentences, and reports a landing reboot as a result
// instead of a failure.
//
// TIMEOUTS. celink's are per USB transfer, not per operation: `timeout` 3s,
// `streamTimeout` 15s while variable data streams, `appTimeout` 30s around a
// Flash write. The variable defaults are left alone. The Flash one is NOT: a
// megabyte of application is the slowest thing this page sends, so sendApp
// gives that write a 300s budget.
//
// POISONING. Only the failures that actually close the link (LINK_DROP below)
// set `poisoned`. Any other calculator error leaves the link usable, so a
// retry can work without a page reload.
const LINK_DROP=new Set(['TIMEOUT','USB_ERROR','DISCONNECTED','PROTOCOL','LINK_CLOSED']);
// WHERE A NAME CAN CLASH. The CE keeps math values (real, complex, fraction,
// list...) apart from the named table of programs, AppVars and groups, and a
// real A sits beside program A without either noticing. Only this table is
// ever compared: matching on name alone would make the real A that `5→A`
// leaves behind block arTIfiCE v2.1 (program A) with "A already exists".
const NAMED=[TYPE.PROGRAM,TYPE.PROTECTED_PROGRAM,TYPE.APPVAR,TYPE.TEMP_PROGRAM,TYPE.GROUP];
const clashes=(entries,name)=>entries.filter(e=>e.name===name&&NAMED.includes(e.type));
export class CETransport {
  constructor(log=()=>{}) {this.log=log;this.poisoned=false;this.link=null;this.device=null;this.info=null;this.calc=null;}
  // Every celink call goes through here so one rule decides what kills the link.
  async guard(fn) {
    if(this.poisoned)throw Error('Reconnect by unplugging the calculator and reloading this page.');
    try {
      return await fn();
    } catch(err) {
      if(err instanceof CELinkError && LINK_DROP.has(err.code)) this.poisoned=true;
      throw err;
    }
  }
  async connect() {
    if(!navigator.usb)throw Error('Use Chrome or Edge on a computer for direct USB. The manual guide works in other browsers.');
    // This call stays before all awaited initialization so browser activation is preserved.
    this.link=await CELink.request();
    this.device=this.link.device;
    const granted=await CELink.granted();
    if(granted.length!==1)throw Error('Connect only one TI calculator, then reload and try again.');
    await this.guard(async()=>{
      await this.link.open();
      this.calc=await this.link.info();
    });
    this.log('Model: '+this.calc.productName);
    this.log('OS Version: '+this.calc.osVersion);
    // parseInfo does the model check, the exact-version check and the routing,
    // with the wording the wizard shows. celink hands over fields, so the one
    // line parseInfo reads is built here rather than the checks being copied
    // out of core.mjs. An unreadable version arrives as "undefined" and is
    // refused there.
    this.info=parseInfo(`OS Version: ${this.calc.osVersion}`,this.calc.productName);
    return this.info;
  }
  // The calculator's directory in the shape the wizard reads:
  // {memory, vars:[...], apps:[...]}. `apps` is its own array, which is what
  // the Inequalz check reads. celink's listApps() is list() filtered to type
  // 0x24, so this splits ONE listing rather than asking the calculator twice.
  // Returned WITHOUT throwing on an empty apps array, because "the calculator
  // did not report its apps" is an answer the wizard shows rather than an
  // error: inequalzStatus turns it into 'unknown'.
  async listing() {
    const rows=await this.guard(()=>this.link.list());
    const row=r=>({name:r.name,type:r.type,archived:r.archived,size:r.size});
    return {
      memory:this.calc?{ram:this.calc.ramFree,archive:this.calc.archiveFree}:null,
      vars:rows.filter(r=>r.type!==TYPE.FLASH_APP).map(row),
      apps:rows.filter(r=>r.type===TYPE.FLASH_APP).map(row),
    };
  }
  // Every name on the calculator, variables and apps together. Collision
  // checks use this, and they DO require both arrays: refusing to send is the
  // right move when the calculator will not say what is already on it.
  async directory() {
    const listing=await this.listing();
    if(!Array.isArray(listing.vars)||!Array.isArray(listing.apps))throw Error('The calculator directory could not be checked. No file was sent.');
    return [...listing.vars,...listing.apps];
  }
  // celink hands back a parsed entry; the callers here compare whole files, so
  // it is rebuilt into one. buildFile writes the same 13-byte entry header
  // core.mjs's parseVariable expects, so the round trip is exact.
  async receive(entry) {
    const got=await this.guard(()=>this.link.receive(entry.name,entry.type));
    return buildFile([got]);
  }
  // Collision check on its own, with no transfer of the files themselves. The
  // v3 trigger AppVar is sent while the Inequalz app is open, and a directory
  // listing in that state is untested, so the wizard checks every file it is going to send WHILE THE CALCULATOR IS STILL
  // ON THE HOME SCREEN. A jailbreak file (`replaces`) clears its own way here:
  // anything of another type under its name is deleted, and so is the
  // trigger's own name, since overwriting it inside Inequalz is untested and a
  // retry of a half-finished v3 install always finds one. Anything else
  // that clashes still refuses the whole route up front.
  async precheck(files) {
    const entries=await this.directory();
    const refused=[];
    for(const f of files) {
      const existing=clashes(entries,f.name);
      if(!existing.length) continue;
      if(!f.replaces) {refused.push(f.name);continue;}
      await this.clearFor(f,existing,{all:!!f.expectReboot});
    }
    if(refused.length)throw Error(refused.length===1
      ? `${refused[0]} already exists on the calculator and this file does not replace it. Nothing was sent. Rename or delete it on the calculator, then start over.`
      : `${refused.join(' and ')} already exist on the calculator and these files do not replace them. Nothing was sent. Rename or delete them on the calculator, then start over.`);
    return true;
  }
  // A jailbreak file is sent under its own name, and a variable with that
  // name is replaced, whatever its type. A same-type entry is left for the
  // send to overwrite silently (observed on hardware for program A); anything
  // else under the name is deleted first, because a send never replaces a
  // different type. `all` deletes the same-type entry too.
  async clearFor(spec,existing,{all=false}={}) {
    for(const e of existing) {
      if(!all && e.type===spec.type) continue;
      await this.guard(()=>this.link.delete(e.name,e.type));
    }
  }
  async sendVerified(bytes,{official=null,route=null,skipDirectory=false,onProgress=null}={}) {
    if(!this.info)throw Error('Connect and read the OS first.');
    const wanted=route||this.info.route;
    if(official&&wanted!==this.info.route)throw Error('This OS is not on the route that file belongs to.');
    const entry=parseVariable(bytes);
    // An official file is only accepted on its own route and only at its pinned
    // hash, name and type. A stray file can never reach the replacement policy.
    if(official) {
      const spec=officialFiles(this.info.route).find(f=>f.file===official.file);
      if(!spec)throw Error('This OS is not on the route that file belongs to.');
      if(entry.name!==spec.name||entry.type!==spec.type||await digest(bytes)!==spec.sha256)
        throw Error(`${spec.file} does not match the verified ${spec.file.startsWith('arTIfiCE')?'arTIfiCE':'official'} release. Nothing was sent.`);
      official=spec;
    }
    // Anything else keeps collision protection; a jailbreak file (`replaces`)
    // clears its name and goes through.
    if(!skipDirectory) {
      const existing=clashes(await this.directory(),entry.name);
      if(existing.length && official?.replaces) {
        await this.clearFor(official,existing);
      } else if(existing.length) {
        if(existing.length===1 && existing[0].type===entry.type && sameVariable(bytes,await this.receive(entry))) {
          return {name:entry.name,alreadyPresent:true,verified:true};
        }
        throw Error(`${entry.name} already exists and does not exactly match this file. Nothing was overwritten. Choose a different file or resolve the name on the calculator.`);
      }
    }
    // core's parseVariable is the gate; celink's parser is what produces the
    // entry to put on the wire (its version byte, its name bytes, and the
    // ARCHIVED FLAG THE FILE ITSELF CARRIES). That flag is not cosmetic:
    // arTIfiCE_v2.1.8xp is flagged archived and the other two are not, and they
    // are sent exactly that way.
    const file=parseFile(bytes).entries[0];
    const sent=await this.guard(()=>this.link.send(file,{
      archive:file.archived,
      onProgress:onProgress||undefined,
      rebootOnLanding:!!official?.expectReboot,
    }));
    // The v3 trigger AppVar reboots the calculator, so there is no link left to
    // read it back over. That step is confirmed by the person looking at the
    // calculator, and the wizard says so instead of claiming a verification it
    // did not make.
    //
    // The reboot arrives in one of TWO shapes, and both end here. celink can
    // report the link dropping while the AppVar lands, which is what the
    // simulator does and what a calculator that resets mid-transfer does. A
    // 5.8.5 calculator on hardware did neither: it acknowledged the AppVar
    // normally, so the send came back `rebooted:false`, and only THEN ran
    // arTIfiCE's installer and restarted. The link was already gone by the
    // time the read-back's first packet went out, and it came back as
    // `USB_ERROR ... USB status "stall"` from inside celink's _begin, although
    // the install had worked.
    //
    // So the read-back is still ATTEMPTED (a calculator that took the AppVar
    // and did not restart is checked like any other send), and only a link
    // that has gone is read as the restart. Nothing extra goes on the wire;
    // the same exchange is only read differently.
    const landed={name:entry.name,alreadyPresent:false,verified:false,rebooted:true};
    if(official?.expectReboot && sent.rebooted) {
      this.poisoned=true;
      return landed;
    }
    let returned;
    try {
      returned=await this.receive(entry);
    } catch(err) {
      if(official?.expectReboot && err instanceof CELinkError && LINK_DROP.has(err.code)) {
        this.poisoned=true;
        return landed;
      }
      throw err;
    }
    if(!sameVariable(bytes,returned))throw Error('The read-back data did not match. Stop here; the transfer is not verified.');
    return {name:entry.name,alreadyPresent:false,verified:true};
  }
  // The ONE path that sends something that is not a variable: TI's Inequality
  // Graphing app, which arTIfiCE v3 installs through and which this project
  // does not host. The file is the person's own download from TI.
  //
  // Why this is a separate method and not a flag on sendVerified: writing Flash
  // has to be a deliberate call. celink enforces that from its side too
  // (send() refuses an application with UNSUPPORTED_TYPE and sendApp() is the
  // only writer it has), and parseFlashApp stands in front of it here,
  // refusing a file with ANY operating-system entry whatever the entry order
  // is. sendVerified's own parser stays just as strict.
  //
  // There is no read-back: a Flash app is not a variable and pulling the whole
  // megabyte back would cost more than it proves. The caller confirms by
  // re-reading the app list, which is what the calculator itself reports.
  async sendApp(bytes,{timeout=300000,onProgress=null}={}) {
    if(!this.info)throw Error('Connect and read the OS first.');
    const app=parseFlashApp(bytes);
    const parsed=parseFile(bytes);
    this.link.appTimeout=timeout;
    await this.guard(()=>this.link.sendApp(parsed,{onProgress:onProgress||undefined}));
    return {name:app.name,sent:true};
  }
}
