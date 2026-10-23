// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LEAVE_SHELL_KEY, OFFICIAL, ROUTES, RUNNING_TEXT, archiveMode, calcParams, checkCalculator, compatibility, digest,
  downloadParams, esc, failReason, fetchOfficial, identifyOfficial, inequalzStatus, installerFailReason, isCE,
  isChromeOS, isWindows, jbPromptChoice, NOT_CE_REASONS, notCEParams, productHex, INSTALLER_RETURNS, installerReturn, installerWithReturn, launchesArchived, linkDead, linkReason, needsAsm, officialFiles, openDetail,
  pageErrorText, parseFlashApp, parseVariable, programRunning, refusal, refusalText, refusedAt, resumable,
  sameVariable, startHint, stepTracker, unknownRefusal,
  deleteParams, STALL_TEXT, STALL_RESET_TEXT, STALL_HOOK_TEXT, stalledListing, stallText, stallDetail, stallLog,
} from '../core.mjs';
import { CELinkError } from '../../celink.mjs';
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
    assert.equal(startHint(v, 'SNAKE'), 'Start it with Asm(: press 2nd, then 0 to open the catalog, scroll down to Asm( and press enter, then press prgm, pick SNAKE, and press enter.');
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
  assert.equal(reason('NO_WEBUSB'), 'no_webusb');
  assert.equal(reason('OTHER_MODEL'), 'other_model');
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
    ['NO_WEBUSB', 'no_webusb'], ['OTHER_MODEL', 'other_model'], ['TIMEOUT', 'timeout'], ['PROTOCOL', 'link_lost'], ['POISONED', 'other']]) {
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
  assert.equal(refused(0x0037), 'The calculator refused the request (error 0x0037: an error code this library does not know; please report it).');
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
});

test('openDetail: an `other` failure says what kind of error it was, from a fixed list, never its text', () => {
  const kinds = [
    [new CELinkError('NO_ENDPOINTS', 'no bulk IN/OUT endpoints'), 'code_no_endpoints'],
    [new CELinkError('NOT_OPEN', 'link is not open'), 'code_not_open'],
    [{ code: 'BAD_HASH_X' }, 'code_bad_hash_x'],
    [new TypeError("Cannot read properties of undefined (reading 'transferIn')"), 'type_error'],
    [new RangeError('Offset is outside the bounds of the DataView'), 'range_error'],
    [new Error('anything at all'), 'error'],
    [new DOMException('Must be handling a user gesture to show a permission request.', 'NotAllowedError'), 'not_allowed_error'],
    [new DOMException('The device was disconnected.', 'NotSupportedError'), 'not_supported_error'],
    [Object.assign(new Error('x'), { name: 'Jane Smith' }), 'other_error'],
    [{ name: 'constructor' }, 'other_error'],
    [{ name: 'toString' }, 'other_error'],
    // A code that is not one of ours (text, a number, too long) is not passed on either.
    [{ code: 'jane@example.com', name: 'TypeError' }, 'type_error'],
    [{ code: '<script>' }, 'other_error'],
    [new DOMException('x', 'SecurityError'), 'security_error'],
    [{ code: 18, name: 'SecurityError' }, 'security_error'],
    [{ code: 'A_VERY_LONG_CODE_PAST_THE_LIMIT' }, 'other_error'],
    [{}, 'other_error'],
    ['Access denied for jane@example.com', 'thrown'],
    [42, 'thrown'],
    [null, 'thrown'],
    [undefined, 'thrown'],
  ];
  const vocabulary = /^(code_[a-z][a-z0-9_]{1,23}|[a-z_]+_error|error|thrown)$/;
  for (const [err, detail] of kinds) {
    assert.equal(failReason(err), 'other', String(err?.message ?? err));
    assert.equal(openDetail(err), detail, String(err?.message ?? err));
    assert.match(detail, vocabulary);
    assert.ok(detail.length <= 40);
  }
  // Errors with a reason of their own keep their old detail, or none.
  assert.equal(openDetail(new CELinkError('TI84_EVO', 'That is a TI-84 Evo')), undefined);
  assert.equal(openDetail(new CELinkError('DISCONNECTED', 'gone')), undefined);
  assert.equal(openDetail(new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0011 })), undefined);
  assert.equal(openDetail(Object.assign(new Error('x'), { name: 'NotFoundError' })), undefined);
  assert.equal(openDetail({ code: 'NO_RAM_SPACE' }), undefined);
});

test('refusedAt: the operation and step a calculator refused, and nothing for other errors', () => {
  const refused = extra => new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0036, ...extra });
  assert.deepEqual(refusedAt(refused({ op: 'send', step: 'rts' })), { at: 'send_rts' });
  const readying = refused({ op: 'ready', step: 'mode' });
  readying.readying = 'send';
  assert.deepEqual(refusedAt(readying), { at: 'ready_mode_before_send' });
  assert.deepEqual(refusedAt(new CELinkError('TIMEOUT', 'no reply')), {});
  assert.deepEqual(refusedAt(refused({})), {});
  assert.deepEqual(refusedAt(undefined), {});
});

test('calcParams reports the home screen as 1 or 0, and leaves it out when unknown', () => {
  assert.deepEqual(calcParams({ os: '5.8.4.0058', model: 'TI-84 Plus CE', home: true }), { evo_os: '5.8.4.0058', evo_hw: 'TI-84 Plus CE', home: 1 });
  assert.equal(calcParams({ os: '5.3.0.0037', model: 'TI-84 Plus CE', home: false }).home, 0);
  assert.equal('home' in calcParams({ os: '5.3.0.0037', model: 'TI-84 Plus CE' }), false);
});

test('launchesArchived: 5.3.0 and later start archived programs; anything else keeps the file\'s flag', () => {
  const cases = {
    '5.0.0.0089': false, '5.2.2.0001': false, '5.3.0.0037': true, '5.4.0.0034': true, '5.8.4.0058': true, '5.8.5.0074': true,
    '5.8.5': true, '6.0.0': false, '7.0.0.3996': false, nonsense: false, '': false, '5.3': false,
  };
  for (const [version, want] of Object.entries(cases)) assert.equal(launchesArchived(version), want, version);
  assert.equal(launchesArchived(undefined), false);
});

test('programRunning: error 0x0036 wherever it comes, and nothing else', () => {
  const refused = (calcError, extra) => new CELinkError('CALC_ERROR', 'refused', { calcError, ...extra });
  for (const extra of [{ op: 'send', step: 'rts' }, { op: 'delete', step: 'delete' }, { op: 'ready', step: 'mode' }, {}]) {
    assert.equal(programRunning(refused(0x0036, extra)), true, JSON.stringify(extra));
  }
  for (const err of [refused(0x0034), refused(0x0011), new CELinkError('TIMEOUT', 'no reply'), { code: 'TIMEOUT', calcError: 0x0036 }, undefined, null]) {
    assert.equal(programRunning(err), false, String(err?.code));
  }
});

test('a running program keeps its analytics: reason calc_error_54, not calc_busy, and where it was refused', () => {
  const rts = new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0036, op: 'send', step: 'rts' });
  const del = new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0036, op: 'delete', step: 'delete' });
  for (const err of [rts, del]) {
    assert.equal(failReason(err), 'calc_error_54');
    assert.equal(installerFailReason(err), 'calc_error_54');
    assert.notEqual(linkReason(err), 'calc_busy');
  }
  assert.deepEqual(refusedAt(rts), { at: 'send_rts' });
  assert.deepEqual(refusedAt(del), { at: 'delete_delete' });
});

test('the running-program words: plain, the same on every route, the shell key only on the installer', () => {
  assert.match(refusalText({ code: 'CALC_ERROR', calcError: 0x0036, op: 'send' }), /a program is running on the calculator/);
  assert.match(refusalText({ code: 'CALC_ERROR', calcError: 0x0036, op: 'sendApp' }), /^The calculator refused the app .*a program is running/);
  assert.equal(RUNNING_TEXT, "Your calculator is running a program, so it can't take files. Quit the program and go back to the home screen, then try again.");
  assert.equal(LEAVE_SHELL_KEY, 'mode');
  assert.doesNotMatch(RUNNING_TEXT, /\u2014|\u2013|arTIfiCE|\bclear\b|\bmode\b/);
});

test('archive mode by page: every page archives programs, the math page included', () => {
  for (const page of ['hub', 'game', 'installer', 'math']) assert.equal(archiveMode(page), 'programs');
});

test('the jailbreak prompt reports a fixed choice: its two buttons, anything else is cancel', () => {
  assert.equal(jbPromptChoice('installer'), 'installer');
  assert.equal(jbPromptChoice('send_anyway'), 'send_anyway');
  for (const closed of [false, undefined, null, '', 'Escape']) assert.equal(jbPromptChoice(closed), 'cancel');
});

test('ce_download: the site file name, the page, and connected as 1 or 0; other links send nothing', () => {
  assert.deepEqual(downloadParams('/downloads/ce/SnakeCE.8xg', 'hub', true), { game: 'SnakeCE', page: 'hub', connected: 1 });
  assert.deepEqual(downloadParams('/downloads/ce/Geometry Dash.zip', 'game', null), { game: 'Geometry Dash', page: 'game', connected: 0 });
  assert.deepEqual(downloadParams('/downloads/ce/DISTANCE.8xp', 'math', undefined), { game: 'DISTANCE', page: 'math', connected: 0 });
  assert.equal(downloadParams('/downloads/ce/clibs.8XV', 'hub', false).game, 'clibs');
  assert.equal(downloadParams('/downloads/ce/readme.txt', 'game', true), null);
  assert.equal(downloadParams('/downloads/ce/', 'hub', true), null);
});

test('ce_step fires once per screen, with the route only once it is known', () => {
  const sent = [];
  const step = stepTracker((event, params) => sent.push([event, params]));
  step('connect');
  step('connect');
  step('route_v21', 'v21');
  step('files_v21', 'v21');
  step('route_v21', 'v21');
  step('connect', 'v21');
  assert.deepEqual(sent, [
    ['ce_step', { screen: 'connect' }],
    ['ce_step', { screen: 'route_v21', route: 'v21' }],
    ['ce_step', { screen: 'files_v21', route: 'v21' }],
  ]);
  // A second tracker (a new page load) counts again.
  const again = [];
  stepTracker((e, p) => again.push(p))('connect');
  assert.equal(again.length, 1);
});

test('resumable: a retry after the second step fails never repeats the first', async () => {
  const calls = [];
  let gameFails = 1;
  const seq = resumable([
    async () => { calls.push('A'); },
    async () => { calls.push('SNAKE'); if (gameFails-- > 0) throw refusal('NO_ARCHIVE_SPACE', 'full'); },
  ]);
  assert.equal(seq.next, 0);
  await assert.rejects(seq.run(), { code: 'NO_ARCHIVE_SPACE' });
  assert.equal(seq.next, 1, 'the first step landed');
  await seq.run();
  assert.deepEqual(calls, ['A', 'SNAKE', 'SNAKE']);
  assert.equal(seq.next, 2);
  await seq.run();
  assert.deepEqual(calls, ['A', 'SNAKE', 'SNAKE'], 'a finished sequence sends nothing more');

  const first = resumable([async () => { throw refusal('FETCH', 'no'); }, async () => calls.push('never')]);
  await assert.rejects(first.run());
  assert.equal(first.next, 0, 'nothing landed, so the page offers no skip');
});

test('page error text: a running program wins on every page, the page words by reason, the math page says program', () => {
  const running = new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0036, op: 'send', step: 'rts' });
  const own = { no_device: 'Not in the list?', calc_error_54: 'never shown' };
  for (const page of ['hub', 'game', 'math']) assert.equal(pageErrorText(running, { page, own }), RUNNING_TEXT);
  assert.equal(pageErrorText(new CELinkError('NO_DEVICE_SELECTED', 'none'), { page: 'hub', own }), 'Not in the list?');
  const full = refusal('NO_ARCHIVE_SPACE', 'This game needs 40 KB of archive.');
  assert.equal(pageErrorText(full, { page: 'game', own }), 'This game needs 40 KB of archive.');
  assert.equal(pageErrorText(full, { page: 'math', own }), 'This program needs 40 KB of archive.');
  const other = new CELinkError('CALC_ERROR', 'refused', { calcError: 0x0006, op: 'send', step: 'rts' });
  assert.equal(pageErrorText(other, { page: 'hub' }), refusalText(other));
  const partial = new CELinkError('DISCONNECTED', 'The calculator stopped answering.', { partial: ['clibs'] });
  assert.equal(pageErrorText(partial, { page: 'hub', own: { link_lost: 'Plug it back in.' } }), 'Plug it back in. Press Send again to finish.');
  // A refusal for memory already says to free some and try again: no "Press Send again".
  const ram = refusal('NO_RAM_SPACE', 'Not enough RAM. Delete or archive a few programs, then try again.', { partial: ['clibs'] });
  assert.equal(pageErrorText(ram, { page: 'hub' }), 'Not enough RAM. Delete or archive a few programs, then try again.');
  assert.equal(pageErrorText(running, { page: 'hub' }), RUNNING_TEXT, 'no table needed');
});

const stall = (extra = {}) => Object.assign(new CELinkError('TIMEOUT', 'The calculator did not answer within 3000 ms (waiting for the calculator).'), { listing: true }, extra);
const fakeStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('stalledListing: a listing timeout with no defragment before it, nothing else', () => {
  assert.equal(stalledListing(stall()), true);
  assert.equal(stalledListing(stall({ defrag: true })), false, 'a defragment is the defrag wait\'s case');
  assert.equal(stalledListing(new CELinkError('TIMEOUT', 'x')), false, 'a timeout outside a listing');
  assert.equal(stalledListing(Object.assign(new CELinkError('DISCONNECTED', 'x'), { listing: true })), false);
  assert.equal(stalledListing(null), false);
  assert.equal(stalledListing('TIMEOUT'), false);
});

test('stallLog: the first stall, the second, and a connect timeout after one; counted in sessionStorage', () => {
  const store = fakeStorage();
  const log = stallLog(() => store);
  const plain = new CELinkError('TIMEOUT', 'x');
  assert.equal(log.note(plain, { connecting: true }).afterStall, undefined, 'no stall yet: an ordinary timeout');
  const first = log.note(stall());
  assert.equal(first.stalls, 1);
  assert.equal(store.m.get('ce-stalls'), '1');
  assert.equal(log.note(new CELinkError('TIMEOUT', 'x'), { connecting: true }).afterStall, true);
  assert.equal(log.note(new CELinkError('TIMEOUT', 'x')).afterStall, undefined, 'only at connect');
  assert.equal(log.note(Object.assign(new CELinkError('TIMEOUT', 'x'), { defrag: true }), { connecting: true }).afterStall, undefined);
  assert.equal(log.note(new CELinkError('DISCONNECTED', 'x'), { connecting: true }).afterStall, undefined);
  assert.equal(log.note(first).stalls, 1, 'an error is noted once');
  assert.equal(log.count(), 1);
  // A reload in the same tab: a new log over the same storage.
  const again = stallLog(() => store).note(stall());
  assert.equal(again.stalls, 2);
});

test('stallLog: storage that throws or is missing counts for the page load only', () => {
  const throwing = stallLog(() => { throw new DOMException('denied', 'SecurityError'); });
  assert.equal(throwing.note(stall()).stalls, 1);
  assert.equal(throwing.note(stall()).stalls, 2);
  const broken = stallLog(() => ({ getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } }));
  assert.equal(broken.note(stall()).stalls, 1);
  assert.equal(broken.note(stall()).stalls, 2);
  const none = stallLog(() => undefined);
  assert.equal(none.note(stall()).stalls, 1);
  assert.equal(none.note(new CELinkError('TIMEOUT', 'x'), { connecting: true }).afterStall, true);
  const junk = fakeStorage();
  junk.setItem('ce-stalls', 'NaN');
  assert.equal(stallLog(() => junk).note(stall()).stalls, 1);
});

test('stallText: off and on first, a RAM reset the second time, AsmHook2 only on 5.8.5 games pages', () => {
  assert.equal(stallText(stall({ stalls: 1 }), { page: 'game', route: 'v3' }), STALL_TEXT);
  assert.equal(stallText(new CELinkError('TIMEOUT', 'x'), { page: 'game' }), undefined);
  assert.equal(stallText(Object.assign(new CELinkError('TIMEOUT', 'x'), { afterStall: true }), { page: 'hub' }), STALL_TEXT);
  assert.equal(stallText(stall({ stalls: 2, route: 'v3' }), { page: 'game' }), `${STALL_RESET_TEXT} ${STALL_HOOK_TEXT}`);
  assert.equal(stallText(stall({ stalls: 3 }), { page: 'hub', route: 'v3' }), `${STALL_RESET_TEXT} ${STALL_HOOK_TEXT}`, 'the page\'s route when the error has none');
  assert.equal(stallText(stall({ stalls: 2, route: 'v3' }), { page: 'math' }), STALL_RESET_TEXT, 'TI-Basic needs no hook');
  assert.equal(stallText(stall({ stalls: 2, route: 'v21' }), { page: 'game' }), STALL_RESET_TEXT);
  assert.equal(stallText(stall({ stalls: 2 }), { page: 'game' }), STALL_RESET_TEXT, 'no route known');
  assert.equal(stallText({ code: 'DISCONNECTED', stalls: 2 }), undefined);
  // Plain copy: the keys spelled as on the keypad, digits for menu choices.
  for (const t of [STALL_TEXT, STALL_RESET_TEXT, STALL_HOOK_TEXT]) {
    assert.doesNotMatch(t, /[\u2013\u2014]|\bfree\b|don't worry|nothing (is )?wrong/i);
  }
  assert.match(STALL_TEXT, /\(2nd, on, then on\)/);
  assert.match(STALL_RESET_TEXT, /2nd, \+, 7:\u00a0Reset, 1:\u00a0All\u00a0RAM, 2:\u00a0Reset/);
  assert.equal(STALL_RESET_TEXT.replace(/\s+/g, ' ').includes('2nd, +, 7: Reset, 1: All RAM, 2: Reset'), true, 'the same words with plain spaces');
  assert.match(STALL_RESET_TEXT, /deletes programs that aren't archived/);
  assert.ok(`${STALL_RESET_TEXT} ${STALL_HOOK_TEXT}`.length <= 300);
});

test('stallDetail and openDetail: stalled_list, stalled_list_again, no_reply_after_stall, else no_reply', () => {
  assert.equal(openDetail(stall({ stalls: 1 })), 'stalled_list');
  assert.equal(openDetail(stall({ stalls: 2 })), 'stalled_list_again');
  assert.equal(openDetail(stall({ stalls: 5 })), 'stalled_list_again');
  assert.equal(openDetail(Object.assign(new CELinkError('TIMEOUT', 'x'), { afterStall: true })), 'no_reply_after_stall');
  assert.equal(openDetail(stall()), 'no_reply', 'not noted: an ordinary timeout');
  assert.equal(stallDetail(new CELinkError('TIMEOUT', 'x')), undefined);
  assert.equal(stallDetail({ code: 'OPEN_FAILED', stalls: 1 }), undefined);
});

test('deleteParams: a delete whose listing stalled carries open_detail', () => {
  const base = { game: 'CHECKERS', page: 'hub', route: 'v3', outcome: 'failed' };
  assert.equal(deleteParams({ ...base, err: stall({ stalls: 1 }) }).open_detail, 'stalled_list');
  assert.equal(deleteParams({ ...base, err: new CELinkError('TIMEOUT', 'x') }).open_detail, undefined);
});

test('pageErrorText: the page\'s stall words replace the stopped-responding words for a stalled listing', () => {
  const own = err => ({ timeout: stallText(err, { page: 'game', route: 'v3' }) ?? 'LOST' });
  const e1 = stall({ stalls: 1 });
  assert.equal(pageErrorText(e1, { page: 'game', own: own(e1) }), STALL_TEXT);
  const e0 = new CELinkError('TIMEOUT', 'x');
  assert.equal(pageErrorText(e0, { page: 'game', own: own(e0) }), 'LOST');
});

test('productHex: a USB product id as four lower-case hex digits', () => {
  assert.equal(productHex({ productId: 0xE003 }), 'e003');
  assert.equal(productHex({ productId: 0xE008 }), 'e008');
  assert.equal(productHex({ productId: 0x0001 }), '0001');
  for (const d of [undefined, null, {}, { productId: -1 }, { productId: 0x10000 }, { productId: 1.5 }, { productId: '57347' }]) {
    assert.equal(productHex(d), undefined, JSON.stringify(d));
  }
});

test('notCEParams: the product id and the model, only for a calculator that is not a CE', () => {
  assert.deepEqual(NOT_CE_REASONS, ['other_model', 'wrong_model']);
  const plus = refusal('OTHER_MODEL', 'x', { model: 'TI-84 Plus' });
  assert.deepEqual(notCEParams('other_model', plus, { productId: 0xE003 }), { open_detail: 'e003', evo_hw: 'TI-84 Plus' });
  assert.deepEqual(notCEParams('wrong_model', refusal('WRONG_MODEL', 'x', { model: 'TI-84 Plus Silver Edition' }), { productId: 0xE008 }),
    { open_detail: 'e008', evo_hw: 'TI-84 Plus Silver Edition' });
  // No device known (the picker never returned one): the model alone.
  assert.deepEqual(notCEParams('other_model', plus, undefined), { evo_hw: 'TI-84 Plus' });
  // A model that is not plain, or none: the product id alone.
  for (const model of ['', 'TI<84>', 'x'.repeat(41), 'TI-84\nPlus', undefined, 42]) {
    assert.deepEqual(notCEParams('other_model', refusal('OTHER_MODEL', 'x', { model }), { productId: 0xE003 }), { open_detail: 'e003' }, String(model));
  }
  // Every other reason: nothing, even with a device.
  for (const reason of ['no_webusb', 'no_device', 'open_failed', 'timeout', 'evo', 'other', 'unsupported']) {
    assert.deepEqual(notCEParams(reason, plus, { productId: 0xE003 }), {}, reason);
  }
});

test('installer ?next=: only a listed page, word for word, gets a way back', () => {
  const PLEXMATH = '/downloads/ti84plusce/math/plexmath/';
  assert.equal(installerReturn(''), null);
  assert.equal(installerReturn('?screen=play-v3'), null);
  for (const search of [`?next=${PLEXMATH}`, `?next=${encodeURIComponent(PLEXMATH)}`, `?screen=play-v3&next=${PLEXMATH}`]) {
    assert.deepEqual(installerReturn(search), { href: PLEXMATH, name: 'PlexMath' }, search);
  }
  for (const next of ['https://evil.example/downloads/ti84plusce/math/plexmath/', '//evil.example/downloads/ti84plusce/math/plexmath/',
    'http://calcplex.com/downloads/ti84plusce/math/plexmath/', 'javascript:alert(1)', '/downloads/ti84plusce/math/plexmath',
    '/downloads/ti84plusce/math/plexmath/?x=1', '/downloads/ti84plusce/math/plexmath/#x', '/downloads/ti84plusce/games/', '/', '',
    '/downloads/ti84plusce/math/plexmath/../../games/', '\\\\evil.example', ' /downloads/ti84plusce/math/plexmath/', 'constructor', '__proto__', 'toString']) {
    assert.equal(installerReturn(`?next=${encodeURIComponent(next)}`), null, next);
  }
  assert.equal(installerReturn(`?next=/x/&next=${PLEXMATH}`), null);
  assert.equal(installerWithReturn('/ti84plusce-jailbreak-tutorial/', PLEXMATH), `/ti84plusce-jailbreak-tutorial/?next=${PLEXMATH}`);
  assert.equal(installerWithReturn('/ti84plusce-jailbreak-tutorial/', 'https://evil.example/'), '/ti84plusce-jailbreak-tutorial/');
  for (const path of Object.keys(INSTALLER_RETURNS)) assert.match(path, /^\/[a-z0-9/-]+\/$/, path);
});
