// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The jailbreak installer's side of celink: one calculator, the collision
// rules, and a read-back after every send.
import { NAMED, checkCalculator, digest, linkDead, officialFiles, parseFlashApp, parseVariable, refusal, sameVariable } from './core.mjs';
import { readyEach } from './gamesend.mjs';
import { CELink } from '../celink.mjs';
import { buildFile, parseAppFile, parseFile } from '../tifiles.mjs';

const clashes = (rows, name) => rows.filter(r => r.name === name && NAMED.includes(r.type));

// A Flash write erases and writes up to a megabyte before it is acknowledged.
const APP_TIMEOUT_MS = 300000;

export class CETransport {
  link = null;
  device = null;
  info = null;
  /** Set once the link has died; every later call refuses until a reload. */
  poisoned = false;

  async #guard(fn) {
    if (this.poisoned) throw refusal('POISONED', 'Reconnect by unplugging the calculator and reloading this page.');
    try {
      return await fn();
    } catch (err) {
      if (linkDead(err)) this.poisoned = true;
      throw err;
    }
  }

  #exchange(fn) {
    return this.#guard(() => fn(readyEach(this.link)));
  }

  /**
   * Pick, open and identify the calculator: { model, os, route }. The picker
   * opens every time, before anything else is awaited, so it keeps the
   * click's activation.
   */
  async connect() {
    if (!navigator.usb) throw refusal('NO_WEBUSB', 'Use Chrome or Edge on a computer for direct USB. The manual guide works in other browsers.');
    this.link = await CELink.request({ appTimeout: APP_TIMEOUT_MS });
    this.device = this.link.device;
    if ((await CELink.granted()).length !== 1) throw refusal('SEVERAL_CALCULATORS', 'Connect only one TI calculator, then reload and try again.');
    const calc = await this.#guard(async () => {
      await this.link.open();
      return readyEach(this.link).info();
    });
    this.info = { ...checkCalculator(calc.productName, calc.osVersion), home: calc.atHomescreen };
    return this.info;
  }

  /** Every variable and application on the calculator, as list() rows. */
  directory() {
    return this.#exchange(link => link.list());
  }

  /** A variable read back off the calculator, as a file. */
  async receive(entry) {
    return buildFile([await this.#exchange(link => link.receive(entry.name, entry.type))]);
  }

  /**
   * Clear the way for every file of a route while the calculator is still on
   * the home screen: the v3 trigger is later sent with an app open, where a
   * listing has never been tried. A jailbreak file deletes what holds its
   * name (the trigger's own old copy too); any other clash refuses the route.
   */
  async precheck(files) {
    const rows = await this.directory();
    const refused = [];
    for (const f of files) {
      const existing = clashes(rows, f.name);
      if (!existing.length) continue;
      if (f.replaces) await this.#clear(f, existing, { all: !!f.expectReboot });
      else refused.push(f.name);
    }
    if (refused.length === 1) {
      throw refusal('COLLISION', `${refused[0]} already exists on the calculator and this file does not replace it. Nothing was sent. Rename or delete it on the calculator, then start over.`, { names: refused });
    }
    if (refused.length) {
      throw refusal('COLLISION', `${refused.join(' and ')} already exist on the calculator and these files do not replace them. Nothing was sent. Rename or delete them on the calculator, then start over.`, { names: refused });
    }
  }

  // A send overwrites a variable of the same type (observed on hardware for
  // program A) but never one of another type, so those are deleted first.
  // `all` deletes the same-type one too.
  async #clear(spec, existing, { all = false } = {}) {
    for (const e of existing) {
      if (e.type === spec.type && !all) continue;
      await this.#exchange(link => link.delete(e.name, e.type));
    }
  }

  /**
   * Send one variable file and read it back. `official` is a spec from
   * core.OFFICIAL: accepted only on its own route and at its pinned hash, and
   * then allowed to replace what holds its name. Any other file refuses to
   * overwrite, unless the calculator already holds an identical copy.
   * `skipDirectory` is for the v3 trigger, sent with an app open.
   */
  async sendVerified(bytes, { official = null, skipDirectory = false } = {}) {
    if (!this.info) throw refusal('NOT_CONNECTED', 'Connect and read the OS first.');
    const entry = parseVariable(bytes);
    const spec = official && await this.#checkOfficial(official, entry, bytes);
    if (!skipDirectory) {
      const existing = clashes(await this.directory(), entry.name);
      if (existing.length && spec?.replaces) await this.#clear(spec, existing);
      else if (existing.length) {
        if (existing.length === 1 && existing[0].type === entry.type && sameVariable(bytes, await this.receive(entry))) {
          return { name: entry.name, alreadyPresent: true, verified: true };
        }
        throw refusal('COLLISION', `${entry.name} already exists and does not exactly match this file. Nothing was overwritten. Choose a different file or resolve the name on the calculator.`, { names: [entry.name] });
      }
    }
    // parseFile's entry carries the file's own archived flag, which send() keeps.
    const file = parseFile(bytes).entries[0];
    const sent = await this.#exchange(link => link.send(file, { rebootOnLanding: !!spec?.expectReboot }));
    const back = sent.rebooted ? null : await this.#readBack(entry, spec);
    if (!back) {
      this.poisoned = true;
      return { name: entry.name, alreadyPresent: false, verified: false, rebooted: true };
    }
    if (!sameVariable(bytes, back)) throw refusal('NOT_VERIFIED', 'The read-back data did not match. Stop here; the transfer is not verified.');
    return { name: entry.name, alreadyPresent: false, verified: true };
  }

  async #checkOfficial(official, entry, bytes) {
    const spec = officialFiles(this.info.route).find(f => f.file === official.file);
    if (!spec) throw refusal('WRONG_ROUTE', 'This OS is not on the route that file belongs to.');
    if (entry.name !== spec.name || entry.type !== spec.type || await digest(bytes) !== spec.sha256) {
      const release = spec.file.startsWith('arTIfiCE') ? 'arTIfiCE' : 'official';
      throw refusal('BAD_HASH', `${spec.file} does not match the verified ${release} release. Nothing was sent.`);
    }
    return spec;
  }

  // The v3 trigger can also be acknowledged normally, with the restart just
  // after (observed on hardware on 5.8.5): the read-back then finds the link
  // gone, and that is the install, not a failure. Returns null for it.
  async #readBack(entry, spec) {
    try {
      return await this.receive(entry);
    } catch (err) {
      if (spec?.expectReboot && linkDead(err)) return null;
      throw err;
    }
  }

  /**
   * Write TI's Flash application (a .8ek). No read-back: the caller confirms
   * by listing the apps, which is what the calculator itself reports.
   */
  async sendApp(bytes, { onProgress } = {}) {
    if (!this.info) throw refusal('NOT_CONNECTED', 'Connect and read the OS first.');
    const { name } = parseFlashApp(bytes);
    await this.#exchange(link => link.sendApp(parseAppFile(bytes), { onProgress }));
    return { name, sent: true };
  }
}
