// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OFFICIAL, ROUTES, checkCalculator, compatibility, digest, esc, failReason, fetchOfficial, identifyOfficial, inequalzStatus,
  installerFailReason, isCE, isChromeOS, isWindows, linkDead, linkReason, needsAsm, officialFiles, openDetail, parseFlashApp,
  parseVariable, refusalText, sameVariable, startHint, unknownRefusal,
} from '../core.mjs';
import { TYPE } from '../../tifiles.mjs';
import { appSection, patched } from '../../test/testkit.mjs';

const probe = new Uint8Array(readFileSync(new URL('../../fixtures/probe.8xp', import.meta.url)));
const allOfficial = [...officialFiles('v21'), ...officialFiles('v3')];



test('each OS version gets its route, and anything unrecognised fails closed', () => {
  const cases = {
    native: ['5.0.0.0089', '5.3.0.0037', '5.4.0.0034'],
    v21: ['5.5.1.0058', '5.8.3.0001', '5.8.4.0058'],
    v3: ['5.8.5', '5.8.5.0001', '5.8.5.9999'],
    unsupported: ['5.8.6.0000', '5.9.0.0000', '5.10.0.0000'],
    unknown: ['7.0.0.3996', '5.8', 'garbage', '5.8.4junk', undefined],
  };
  for (const [route, versions] of Object.entries(cases)) {
    for (const v of versions) assert.equal(compatibility(v), route, v);
  }
});

test('every route has its words, and none suggests changing the OS', () => {
  for (const v of ['5.3.0.0037', '5.8.4.0058', '5.8.5', '5.9.0.0000', 'nonsense']) {
    const { label, heading, reason } = ROUTES[compatibility(v)];
    assert.ok(label && heading && reason.length > 20, v);
    assert.doesNotMatch(`${heading} ${reason}`, /updat|upgrad|downgrad|should work/i, v);
  }
});

test('Asm( is needed on 5.2 and earlier only', () => {
  for (const v of ['5.0.0.0089', '5.1.5.0019', '5.2.2.0043']) assert.equal(needsAsm(v), true, v);
  for (const v of ['5.3.0.0037', '5.4.0.0034', '5.8.4.0058', '5.8.5', '7.0.0.3996', 'bad', '5.2']) assert.equal(needsAsm(v), false, v);
});

test('startHint: Asm( on 5.2 and earlier, the arTIfiCE shell on v2.1, prgm otherwise', () => {
  for (const v of ['5.0.0.0089', '5.2.2.0043']) {
    assert.equal(startHint(v, 'SNAKE'), 'Start it with Asm(: press 2nd, 0, pick Asm(, press prgm, pick SNAKE, and press enter.');
  }
  for (const v of ['5.3.0.0037', '5.4.0.0034', '5.8.5.0074']) {
    assert.equal(startHint(v, 'SNAKE'), 'Press prgm, pick SNAKE, and press enter twice.');
  }
  assert.equal(startHint('5.8.4.0058', 'SNAKE'), 'Press prgm, run A, and pick SNAKE.');
});


test('the official files: pinned, sendable, and only the v3 trigger expects a reboot', () => {
  assert.deepEqual(officialFiles('native'), []);
  assert.deepEqual(officialFiles('unsupported'), []);
  assert.deepEqual(allOfficial.map(f => f.file), ['arTIfiCE_v2.1.8xp', 'arTIfiCE.8xp', 'INEQUVAR.8xv']);
  assert.ok(allOfficial.every(f => f.replaces));
  assert.deepEqual(allOfficial.filter(f => f.expectReboot).map(f => f.name), ['INEQUVAR']);
  for (const f of allOfficial) assert.match(f.sha256, /^[0-9a-f]{64}$/, f.file);
});

// The release files are not in this repository, so probe.8xp stands in for
// one by taking over its pin.
async function pinnedTo(spec, bytes, fn) {
  const pin = spec.sha256;
  spec.sha256 = await digest(bytes);
  try {
    return await fn();
  } finally {
    spec.sha256 = pin;
  }
}

test('identifyOfficial names a file only on its own route', async () => {
  assert.equal(await identifyOfficial('v21', probe), null);
  await pinnedTo(OFFICIAL.v21.files[0], probe, async () => {
    assert.equal((await identifyOfficial('v21', probe)).file, 'arTIfiCE_v2.1.8xp');
    assert.equal(await identifyOfficial('v3', probe), null);
    assert.equal(await identifyOfficial('native', probe), null);
  });
});

test('fetchOfficial asks this site for the file and returns it only at its pin', async () => {
  const spec = OFFICIAL.v21.files[0];
  await pinnedTo(spec, probe, async () => {
    const got = await fetchOfficial(spec, async url => {
      assert.equal(url, '/downloads/ce/artifice/arTIfiCE_v2.1.8xp');
      return { ok: true, arrayBuffer: async () => probe.slice() };
    });
    assert.deepEqual(got, probe);
  });
  const tampered = probe.slice();
  tampered[80] ^= 1;
  await assert.rejects(fetchOfficial(spec, async () => ({ ok: true, arrayBuffer: async () => tampered })), { code: 'BAD_HASH' });
  await assert.rejects(fetchOfficial(spec, async () => ({ ok: false, status: 404 })), { code: 'FETCH' });
  await assert.rejects(fetchOfficial(spec, async () => { throw new Error('offline'); }), /offline/);
});

test('parseVariable reads the one program or AppVar in a file', () => {
  const v = parseVariable(probe);
  assert.equal(v.name, 'LINKTEST');
  assert.equal(v.type, TYPE.PROGRAM);
  // The CE product id byte that arTIfiCE's own files carry.
  assert.equal(parseVariable(patched(probe, b => { b[10] = 0x13; })).name, 'LINKTEST');
});

test('parseVariable refuses damage, groups, other types and odd names as BAD_FILE', () => {
  const refused = [
    ['corrupt', (() => { const b = probe.slice(); b[72] ^= 1; return b; })()],
    ['Flash file', new TextEncoder().encode('**TIFL**')],
    ['truncated', probe.slice(0, 70)],
    ['OS type', patched(probe, b => { b[59] = 0x23; })],
    ['trailing byte', Uint8Array.from([...probe, 0])],
    ['lower-case name', patched(probe, b => { b[60] = 0x6C; })],
  ];
  for (const [what, bytes] of refused) assert.throws(() => parseVariable(bytes), { code: 'BAD_FILE' }, what);
});

test('sameVariable compares name, type and contents', () => {
  const renamed = patched(probe, b => { b[67] = 0x5A; });
  assert.equal(sameVariable(probe, probe.slice()), true);
  assert.equal(sameVariable(probe, renamed), false);
});

const tifl = ({ name = 'Inequalz', device = 0x73, data = TYPE.FLASH_APP } = {}) =>
  appSection({ name, deviceType: device, dataType: data, data: new Uint8Array(8) });
const join = (...parts) => Uint8Array.from(parts.flatMap(p => [...p]));

test('parseFlashApp accepts an app, with or without its certificate, and names it', () => {
  assert.equal(parseFlashApp(tifl()).name, 'Inequalz');
  assert.equal(parseFlashApp(tifl({ name: 'Inequal' })).name, 'Inequal');
  const signed = parseFlashApp(join(tifl({ name: 'Cert', data: TYPE.CERTIFICATE }), tifl()));
  assert.equal(signed.entries.length, 2);
  assert.equal(signed.name, 'Inequalz');
});

test('parseFlashApp refuses an operating system anywhere in the file', () => {
  for (const bytes of [
    tifl({ data: TYPE.OS }),
    join(tifl({ data: TYPE.OS }), tifl()),
    join(tifl(), tifl({ data: TYPE.OS })),
  ]) assert.throws(() => parseFlashApp(bytes), /operating system/);
});

test('parseFlashApp refuses what is not a CE application', () => {
  assert.throws(() => parseFlashApp(tifl({ data: TYPE.CERTIFICATE })), /not a calculator application/);
  assert.throws(() => parseFlashApp(tifl({ data: TYPE.LICENSE })), /not a calculator application/);
  assert.throws(() => parseFlashApp(tifl({ device: 0x74 })), /not for the TI-84 Plus CE/);
  for (const bytes of [probe, new Uint8Array(10)]) assert.throws(() => parseFlashApp(bytes), /\.8ek/);
  const truncated = tifl();
  truncated[74] = 200;
  assert.throws(() => parseFlashApp(truncated), /incomplete/);
  assert.throws(() => parseVariable(tifl()), { code: 'BAD_FILE' });
});

test('checkCalculator wants the name a TI-84 Plus CE reports and an exact OS version', () => {
  assert.deepEqual(checkCalculator('TI-84 Plus CE', '5.8.4.0058'), { model: 'TI-84 Plus CE', os: '5.8.4.0058', route: 'v21' });
  assert.equal(checkCalculator('TI-84+CE', '5.3.0.0037').route, 'native');
  assert.equal(checkCalculator('TI-84 Plus CE USB', '5.8.5.0074').route, 'v3');
  for (const model of ['TI-84 Plus CE-T', 'TI-84 Plus CE Python', 'TI-84 PlusCE', 'TI-84 Evo']) {
    assert.throws(() => checkCalculator(model, '5.8.5.0074'), { code: 'WRONG_MODEL', message: `Detected ${model}. Connect a TI-84 Plus CE.` }, model);
  }
  assert.throws(() => checkCalculator(undefined, '5.8.5'), /unknown model/);
  assert.throws(() => checkCalculator('TI-84 Plus CE', undefined), { code: 'NO_OS_VERSION' });
});

test('isCE: a name that starts as a TI-84 Plus CE\'s does', () => {
  for (const name of ['TI-84 Plus CE', 'TI-84+CE', 'TI-84 + CE', 'TI-84 Plus CE-T', 'TI-84 Plus CE Python']) assert.equal(isCE(name), true, name);
  for (const name of ['TI-84 PlusCE', 'TI-84Plus CE', 'TI-83 Premium CE', 'TI-84 Plus', undefined]) assert.equal(isCE(name), false, String(name));
});

test('esc makes any value safe for HTML, whatever its type', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(undefined), 'undefined');
  assert.equal(esc(5.3), '5.3');
});

const directory = (...apps) => [{ name: 'INEQUAL', type: TYPE.PROGRAM }, ...apps.map(name => ({ name, type: TYPE.FLASH_APP }))];

test('inequalzStatus: present when the directory lists Inequalz', () => {
  for (const name of ['Inequalz', 'INEQUALZ', 'inequal', ' Inequalz ']) assert.equal(inequalzStatus(directory('Finance', name)), 'present', name);
});

test('inequalzStatus: missing when other apps are listed and it is not', () => {
  assert.equal(inequalzStatus(directory('Finance', 'PlySmlt2', 'AsmHook2')), 'missing');
});

test('inequalzStatus: missing when no app is listed at all, unknown with no listing', () => {
  assert.equal(inequalzStatus(directory()), 'missing');
  assert.equal(inequalzStatus(undefined), 'unknown');
});


test('Windows and Chrome OS: userAgentData when it has a platform, else the userAgent', () => {
  const nav = (platform, userAgent) => ({ userAgentData: platform === undefined ? undefined : { platform }, userAgent });
  assert.equal(isWindows(nav('Windows', 'Mozilla/5.0 (Macintosh)')), true);
  assert.equal(isWindows(nav('macOS', 'Mozilla/5.0 (Windows NT 10.0)')), false);
  assert.equal(isWindows(nav('', 'Mozilla/5.0 (Windows NT 10.0)')), true);
  assert.equal(isWindows(nav(undefined, 'Mozilla/5.0 (Windows NT 6.1; WOW64) Firefox/151')), true);
  assert.equal(isWindows(nav(undefined, 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140')), false);
  assert.equal(isChromeOS(nav('Chrome OS')), true);
  assert.equal(isChromeOS(nav('Chromium OS')), true);
  assert.equal(isChromeOS(nav('Linux', 'Mozilla/5.0 (X11; CrOS x86_64)')), false);
  assert.equal(isChromeOS(nav('', 'Mozilla/5.0 (X11; CrOS aarch64)')), true);
  assert.equal(isChromeOS(nav(undefined, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140')), false);
});


test('linkReason maps library codes to the fixed reasons, and leaves the rest to the page', () => {
  const reason = (code, extra) => linkReason({ code, ...extra });
  assert.equal(reason('NO_DEVICE_SELECTED'), 'no_device');
  assert.equal(linkReason({ name: 'NotFoundError' }), 'no_device');
  assert.equal(reason('NO_WEBUSB'), 'unsupported');
  assert.equal(reason('OTHER_MODEL'), 'unsupported');
  assert.equal(reason('OPEN_FAILED'), 'open_failed');
  assert.equal(reason('TIMEOUT'), 'timeout');
  assert.equal(reason('CALC_ERROR', { calcError: 0x0011 }), 'calc_busy');
  assert.equal(reason('CALC_ERROR', { calcError: 0x0034 }), 'calc_busy');
  assert.equal(reason('CALC_ERROR', { calcError: 0x0036 }), 'calc_error_54');
  for (const code of ['DISCONNECTED', 'LINK_CLOSED', 'USB_ERROR', 'PROTOCOL']) assert.equal(reason(code), 'link_lost', code);
  for (const code of ['BAD_FILE', 'BAD_ENTRY', 'BAD_NAME', 'UNSUPPORTED_TYPE']) assert.equal(reason(code), 'bad_file', code);
  for (const code of ['NO_RAM_SPACE', 'BAD_HASH', 'BAD_APP', undefined]) assert.equal(reason(code), undefined, code);
  assert.equal(linkReason(null), undefined);
});

test('failReason: the link reasons, then the pages\' own codes, then other', () => {
  assert.equal(failReason({ code: 'TIMEOUT' }), 'timeout');
  assert.equal(failReason({ code: 'NO_RAM_SPACE' }), 'no_ram');
  assert.equal(failReason({ code: 'NOT_VERIFIED' }), 'readback_mismatch');
  assert.equal(failReason({ code: 'WRONG_MODEL' }), 'wrong_model');
  for (const err of [{ code: 'constructor' }, new TypeError('a page bug'), 'thrown text']) assert.equal(failReason(err), 'other', String(err));
});

test('installerFailReason: the installer\'s own reasons, where they differ from the games pages\'', () => {
  assert.equal(installerFailReason({ code: 'CALC_ERROR', calcError: 0x002B, op: 'sendApp' }), 'low_battery');
  assert.equal(installerFailReason({ code: 'CALC_ERROR', calcError: 0x002B, op: 'send' }), 'calc_error_43');
  assert.equal(installerFailReason({ code: 'CALC_ERROR', calcError: 0x002B, op: 'ready', readying: 'sendApp' }), 'calc_error_43', 'the ping before the app');
  for (const code of ['NO_ARCHIVE_SPACE', 'NO_RAM_SPACE', 'NO_JAILBREAK', 'READBACK']) assert.equal(installerFailReason({ code }), 'other', code);
  assert.equal(installerFailReason({ code: 'COLLISION', names: ['A'] }), 'collision');
  assert.equal(installerFailReason({ code: 'COLLISION', names: ['PPPP', 'INEQUVAR'] }), 'other');
  for (const [code, reason] of [['NOT_VERIFIED', 'readback_mismatch'], ['BAD_HASH', 'bad_hash'], ['FETCH', 'fetch_failed'],
    ['WRONG_ROUTE', 'wrong_route'], ['WRONG_MODEL', 'wrong_model'], ['BAD_FILE', 'bad_file'], ['BAD_APP', 'other'],
    ['NO_WEBUSB', 'unsupported'], ['OTHER_MODEL', 'unsupported'], ['TIMEOUT', 'timeout'], ['PROTOCOL', 'link_lost'], ['POISONED', 'other']]) {
    assert.equal(installerFailReason({ code }), reason, code);
  }
});

test('linkDead: every code after which the link must be reopened', () => {
  for (const code of ['TIMEOUT', 'USB_ERROR', 'DISCONNECTED', 'PROTOCOL', 'LINK_CLOSED']) assert.equal(linkDead({ code }), true, code);
  for (const code of ['CALC_ERROR', 'OPEN_FAILED', 'BAD_FILE']) assert.equal(linkDead({ code }), false, code);
  assert.equal(linkDead(null), false);
});

test('unknownRefusal: a calculator error code the library cannot describe', () => {
  assert.equal(unknownRefusal({ code: 'CALC_ERROR', calcError: 0x0036 }), true);
  assert.equal(unknownRefusal({ code: 'CALC_ERROR', calcError: 0x002B }), false);
  assert.equal(unknownRefusal({ code: 'TIMEOUT' }), false);
});

test('refusalText: a sentence for each refusal, in an app\'s terms when an app was being written', () => {
  const refused = (calcError, op = 'send') => refusalText({ code: 'CALC_ERROR', calcError, op });
  assert.equal(refused(0x000C), 'The calculator refused the request (error 0x000c: the calculator is out of memory. Delete or archive something and try again).');
  assert.match(refused(0x000C, 'sendApp'), /^The calculator refused the app \(error 0x000c: there is not enough free archive memory/);
  assert.match(refused(0x002E, 'sendApp'), /^The calculator refused the app \(error 0x002e: the calculator rejected the app because its signature/);
  assert.match(refused(0x0012, 'sendApp'), /refused the request .*locked/, 'a code with no app sentence');
  assert.equal(refusalText({ code: 'CALC_ERROR', calcError: 0x0011, op: 'ready', readying: 'sendApp' }),
    'The calculator refused the app (error 0x0011: the calculator is busy. Go to the home screen and try again).');
  assert.match(refusalText({ code: 'CALC_ERROR', calcError: 0x0011, op: 'ready', readying: 'send' }), /^The calculator refused the request/);
  assert.equal(refused(0x0036), 'The calculator refused the request (error 0x0036: an error code this library does not know; please report it).');
  assert.equal(refusalText({ code: 'TIMEOUT' }), undefined);
});

test('openDetail: <step>_<cause> for OPEN_FAILED, no_reply for TIMEOUT, never browser text', () => {
  const failed = (step, name) => ({ code: 'OPEN_FAILED', step, cause: Object.assign(new Error('Access denied.'), { name }) });
  assert.equal(openDetail(failed('open', 'SecurityError')), 'open_security');
  assert.equal(openDetail(failed('claim', 'NetworkError')), 'claim_network');
  assert.equal(openDetail(failed('config', 'InvalidStateError')), 'config_state');
  assert.equal(openDetail(failed('<script>', 'Access denied.')), 'other_other');
  assert.equal(openDetail(failed('claim', 'constructor')), 'claim_other');
  assert.equal(openDetail({ code: 'OPEN_FAILED', step: 'open', cause: 'thrown text' }), 'open_other');
  assert.equal(openDetail({ code: 'TIMEOUT' }), 'no_reply');
  assert.equal(openDetail({ code: 'NO_DEVICE_SELECTED' }), undefined);
  assert.equal(openDetail(null), undefined);
});
