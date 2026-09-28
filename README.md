<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# celink

A JavaScript library that talks to a TI-84 Plus CE over WebUSB from a web page.
It reads what is on the calculator, sends programs, app variables and Flash
applications to it, receives them back and deletes them. It is what the "Send
to calculator" buttons and the TI-84 Plus CE jailbreak installer on
[calcplex.com](https://calcplex.com) run on.

Plain ES modules, no dependencies, no build step. Runs in Chrome or Edge
(WebUSB), and in Node 20+ for the tests. Licensed GPL-2.0-or-later.

Most of this code was written with AI, then tested against a strict simulated
calculator and on real calculators.

## Where it comes from

celink started from Benjamin Moody's 2006 document
[The TI-84 Plus USB Protocol: A Partial Analysis](https://brandonw.net/calcstuff/DirectUSB.txt),
WikiTI, and USB captures of a real TI-84 Plus CE (some of them of an earlier
command-line tool of ours that is built on libticalcs, so libticalcs' behaviour
was visible in them).

It was then compared, point by point, with libticalcs and libtifiles, the link
and file libraries in [tilibs](https://github.com/debrouxl/tilibs), and changed
to match them in most places. That brought a lot of tilibs into celink: its
table of calculator error codes and their meanings, several packet
names, the per-command type bytes, the delay acknowledgement, the forgiving file
parser, and the whole Flash application send.
[LIBTICALCS.md](LIBTICALCS.md) lists every item. celink is therefore a
derivative of tilibs, and it is licensed the same way.

## Credits

- **tilibs (libticalcs and libtifiles)** by Romain Liévin, Lionel Debroux, Benjamin Moody and
  the other contributors in its
  [AUTHORS](https://github.com/debrouxl/tilibs/blob/master/libticalcs/trunk/AUTHORS)
  file. GPL-2.0-or-later. Most of what celink knows beyond Moody's 2006 document
  comes from here.
- **Benjamin Moody (FloppusMaximus)** for the 2006 analysis of the TI-84 Plus
  USB protocol, the base everything here is built on.
- **WikiTI** for the list of TI USB product ids.
- **The [CE C toolchain](https://github.com/CE-Programming/toolchain)** team, whose
  shared C libraries the Send buttons install alongside C games.
- **YvanTT** for [arTIfiCE](https://github.com/YvanTT/arTIfiCE) (GPL-3.0),
  which the installer in `calcplex/` sends. Its files are not in this
  repository.

## Files

| File | What it is |
|---|---|
| `celink.mjs` | The USB transport and the commands (`CELink`, `CELinkError`) |
| `tifiles.mjs` | Read and write `.8xp` / `.8xv` / `.8xg` variable files and `.8ek` application files |
| `sim/calculator.mjs` | A simulated calculator behind a `USBDevice`-shaped interface; the test oracle |
| `test/` | `node --test` suites; `libticalcs.test.mjs` names the LIBTICALCS.md item each test covers, `app.test.mjs` covers Flash applications |
| `calcplex/` | calcplex.com's page code that runs on celink: the Send buttons and the jailbreak installer. It ships with the library, so it is here too; see its README |
| `fixtures/` | Two small programs the tests send: `probe.8xp` and CalcPlex's [Snake](https://github.com/calcplex/snake) (0BSD) |
| `LIBTICALCS.md` | What celink takes from tilibs |

## API

Everything is async. Errors are `CELinkError` with a stable `code` and a message a
student can read. `TIFileError` from `tifiles.mjs` has the same shape; `sendFile`
and `sendApp` reject with it when they are given a file's bytes that do not parse.

```js
import { CELink } from './celink.mjs';
import { parseFile, buildFile, makeEntry, parseAppFile, buildAppFile, TYPE } from './tifiles.mjs';
```

**`CELink.request({ usb })`** shows the browser's device picker, filtered on TI's
vendor id 0x0451 only. Must be called from a click, and **at most once per
click**: since Chrome 153 the
browser process *consumes* the click's activation when it opens the picker, so a
second `requestDevice` in the same click (a retry after a cancel, a second
filter set) fails as `NotFoundError`, which reads exactly like the user
cancelling. Try
`CELink.granted()` first and only prompt when it comes back empty.
```js
const link = await CELink.request();          // uses navigator.usb
```

**`CELink.fromDevice(device)`** wraps a device the page was already allowed to use.
```js
const [device] = await CELink.granted();      // usb.getDevices(), TI devices only
const link = CELink.fromDevice(device);
```

**`link.open()` / `link.close()`** open the device, select configuration 1 (or the
first one with a bulk IN/OUT pair), claim that interface, find the bulk endpoints
from the descriptors. `close()` releases the interface and closes the device.
```js
await link.open();
await link.close();
```

**`link.info()`** reads the calculator's parameters in one request. Parameters the
calculator marks invalid are simply missing from the result.
```js
const i = await link.info();
// { productName: 'TI-84 Plus CE', productId: 0xE008, osVersion: '5.3.0.0037',
//   bootVersion: '5.0.0.0089', hardwareVersion: 7, ramFree, archiveFree, language,
//   subLanguage, atHomescreen, batteryOk, lcdWidth: 320, lcdHeight: 240,
//   productNumber, raw: Map<paramId, Uint8Array> }
```
`osVersion` is `major.minor.micro` from bytes 1, 2 and 3 of parameter 0x000B (byte
0 is not part of the version), then `.build` from parameter 0x0048 when that is
exactly 2 bytes (printed as 4 decimal digits). `bootVersion` is the same from
0x0009 and 0x0049. `productNumber` is the last byte of parameter 0x0001 (0x13 on
the CE).

**`link.list()`** is a directory listing with the size, type and archived attributes.
```js
for (const v of await link.list()) console.log(v.name, v.typeName, v.size, v.archived);
// each row: { name, nameBytes, type, typeName, size, archived, typeRaw }
```
The calculator does not list its permanent variables `Window`, `RclWindw` and
`TblSet` (types 0x0F, 0x10, 0x11); they exist on every CE all the same.

**`link.send(entry, { archive, onProgress, onPhase, rebootOnLanding })`** sends
one variable, with its version from the file.
```js
const { entries } = parseFile(new Uint8Array(await file.arrayBuffer()));
await link.send(entries[0], { archive: false, onProgress: (sent, total) => {} });
// resolves { name, bytes }
```
A send is silent: it replaces a variable of the same name and type without
asking. `send()` and `sendFile()` refuse a Flash application with
`UNSUPPORTED_TYPE` before anything is sent: an app goes through `sendApp()`
(below), so writing Flash is always a deliberate call. A calculator refusal is `CALC_ERROR` with the number in
`err.calcError` and a sentence in the message (`CALC_ERRORS` has all 24 known
codes; the ones a student meets are 0x000C out of memory, 0x0012 locked,
0x001B too large and 0x0034 not at the home screen).

`onPhase(phase)` marks three moments around the landing: `'final-write-started'`
just before the last data packet's USB write begins, `'final-written'` when the
whole variable is on the wire, and `'acknowledged'` when the calculator has taken
it. `onProgress` reports bytes; `onPhase` reports these boundaries.

`rebootOnLanding: true` is for a variable that makes the calculator reboot the
instant it lands, dropping the USB link before it acknowledges. The point of no
return is when the **write of the final data packet starts** (after the Request
to Send has been acknowledged): a reboot can make that very `transferOut` reject
even though every USB packet was taken, so the boundary is the start of the write,
not its completion. With the option set:
- if the link drops from `'final-write-started'` onward (a rejected
  `transferOut` of whatever shape, a timeout, a disconnect, or a missing
  acknowledgement), `send()` resolves with
  `{ name, bytes, rebooted: true, acknowledged: false }` and closes the link;
  every later call throws `CELinkError` code `LINK_CLOSED` telling you to
  reconnect (call `open()` again, or make a new link);
- if the link drops **before** the final packet's write starts, it throws,
  exactly as an ordinary send would;
- if the calculator acknowledges normally, it resolves with
  `{ name, bytes, rebooted: false, acknowledged: true }` after End of
  Transmission, just as in a normal send. A drop while End of Transmission is
  written, after a clean acknowledgement, also reports `acknowledged: false`.

Without the option, behaviour is unchanged: the result is `{ name, bytes }` and
a landing reboot surfaces as an ordinary `TIMEOUT` / `USB_ERROR` /
`DISCONNECTED` error. `sendFile(..., { rebootOnLanding: true })` works only for
a file holding exactly one variable.

**`link.sendFile(bytesOrParsed, opts)`** sends every entry of a file, one after
another, 50 ms apart (a `.8xg` group is just several entries).
```js
await link.sendFile(new Uint8Array(await file.arrayBuffer()), { archive: true });
```

**`link.receive(name, type)`** requests a variable and returns it as an entry,
version included, that `buildFile` can save.
```js
const e = await link.receive('HELLO', TYPE.PROGRAM);
const fileBytes = buildFile([e]);
```

**`link.delete(name, type)`**
```js
await link.delete('HELLO', TYPE.PROGRAM);
```

**Names.** A name is sent the way the calculator spells it, in UTF-8. Built-in
lists and equations use subscript digits: `'L1'` and `'L₁'` both go out as
`L₁` (4C E2 82 81); likewise `Y₁`, `r₁` and `X₁⊺`. `Str1`, `Pic1`, `GDB1` and
`[A]` keep plain characters. A named list is its bare name (`'⌊SCORE'` goes out
as `SCORE`). A `list()` row's `nameBytes` passes through untouched.

### Flash applications

```js
const parsed = parseFile(new Uint8Array(await file.arrayBuffer())); // a .8ek
await link.sendApp(parsed, { onProgress: (sent, total) => {} });   // or pass the bytes
// resolves { name, bytes }
const apps = await link.listApps();          // list() rows of type 0x24; read-only
const e = await link.receiveApp('CabriJr');  // also link.receive(name, TYPE.FLASH_APP)
const file = buildAppFile(e);                // a .8ek, hardware id from the calculator
await link.deleteApp('CabriJr');             // also link.delete(name, TYPE.FLASH_APP)
```
**`link.sendApp(app, { onProgress })`** is the only call in the library that
writes an application to Flash. `app` is the file's bytes, what `parseFile`
returned for it, or its entry. It does, in order:

1. the buffer size negotiation and the normal-mode ping (no other mode);
2. **the battery check**: parameter 0x002D ("enough battery for Flash"). If it
   says 0, `sendApp` rejects with `LOW_BATTERY` and nothing more is sent. With
   `quirks.appBatteryDetail` it also reads 0x002E (level) and 0x002F (external
   power) for the message; that is off by default because the calculator has
   never been asked for those two;
3. **Request to Send**: `00` (folder length), the name length, the name, `00`,
   the data length (4 bytes), `01` (silent), then exactly two attributes in this
   order: 0x0002 type `F0 0F 00 24` and 0x0003 archived `01`. No version;
4. wait for 0xAA00 (the calculator erases Flash here and may send delay
   acknowledgements, which are waited out);
5. the whole application data in one Variable Contents, cut into raw packets by
   the usual rule (the zero-length write and the empty final packet apply);
   `onProgress(sent, total)` after each raw packet;
6. wait for 0xAA00 (the Flash write);
7. End of Transmission, with no reply awaited.

The name sent is the one inside the application's own signed header, falling
back to the file header's name. Refusals come back as `CALC_ERROR` with a
sentence about the app (`APP_ERRORS`): 0x002E is a signature that does not
match, 0x002C/2D/2F/30 other rejections, 0x002B battery low, 0x000C not enough
archive memory, 0x0006 an older copy in the way. `link.appTimeout` (30000 ms)
applies while the app streams and to the two waits.

`parseFile` reads a `.8ek` (`parseAppFile` directly): a chain of `**TIFL**`
sections; the one with data type 0x24 is the application. The result has the
usual `{ entries, warnings }` plus `sections`; the entry is type 0x24 with
`app` = `{ headerName, embeddedName, hardwareId, deviceType, revision, flags,
objectType, dateBytes }`. It refuses a file for another calculator, an unknown
section type, a section over 4 MB less 16 KB, a truncated file, an application
whose data does not start with 0x81, a file with only a license or
certificate, a monochrome application (hardware id 0, Intel HEX) and an
operating system (this library does not send operating systems). Warnings:
`NO_EMBEDDED_NAME`, `TRAILING_BYTES`, `OTHER_MODEL` (a TI-73 app),
`SEVERAL_APPS`.

**`link.capture` / `link.captureLog` / `link.exportCapture()`**: with
`link.capture = true` every raw packet in both directions is kept as
`{ dir: 'out'|'in', t: ms, bytes }` (a zero-length write is an empty `bytes`).
`exportCapture()` gives JSON with the device, endpoints, negotiated buffer size,
the assumed bytes in use, one line per operation, and every packet as spaced hex
with a one-line decode.
```js
link.capture = true;
await link.info();
download(link.exportCapture());
```

**`link.allocation`** is the calculator's answer to the Buffer Size Request, and
**`link.bufferSize`** is the data bytes per raw packet that follow from it (1023
and 1018 on the CE). **`link.lastDelayMs`** is the last wait a Delay
Acknowledgement asked for.

**`link.quirks`**: every byte the library had to assume, so a hardware pass can try
alternatives without editing code (see `DEFAULT_QUIRKS` in `celink.mjs`).
`Object.assign(link.quirks, cloneQuirks(CONFIRMED_ON_5_3))` goes back to the
command bytes of the first hardware pass (`CONFIRMED_ON_5_3` is frozen, so clone
it before changing single fields). **`link.timeout`** (3000 ms per transfer) and
**`link.streamTimeout`** (15000 ms while variable data streams and for the
calculator's answer after it).

Error codes: `NO_WEBUSB`, `NO_DEVICE_SELECTED`, `NO_DEVICE`, `OPEN_FAILED`,
`NO_ENDPOINTS`, `NOT_OPEN`, `TIMEOUT`, `USB_ERROR`, `DISCONNECTED`, `PROTOCOL`,
`CALC_ERROR`, `UNSUPPORTED_TYPE`, `BAD_ENTRY`, `BAD_NAME`, `LOW_BATTERY`,
`LINK_CLOSED`; from `tifiles.mjs` (as `TIFileError`) `BAD_FILE`, `BAD_ENTRY`,
`BAD_NAME`, `TOO_LARGE`, `UNSUPPORTED_TYPE`. `TIMEOUT`, `USB_ERROR`,
`DISCONNECTED` and `PROTOCOL` close the link (all but `DISCONNECTED` first try
to clear a halt on both endpoints; call `open()` again); `LINK_CLOSED` means the link was
closed for good (a `rebootOnLanding` landing) and needs a fresh `open()`; the
others leave it usable. Operations on one link run one at a time, in call order.

### tifiles.mjs

```js
const { comment, entries, warnings } = parseFile(bytes);
// entry: { name, nameBytes (8 bytes), type, typeName, version, archived, data, size }
// warnings: [{ code, message }]
const bytes = buildFile(entries, { comment: 'My game' });
const e = makeEntry({ name: 'CELINKT', type: TYPE.APPVAR, body: someBytes }); // adds the 2-byte length
typeName(0x15);                                  // 'app variable'
fileExtension(TYPE.IMAGE);                       // '8ca'
```
`data` is the variable exactly as stored in the file (for programs and app
variables that includes the 2-byte length at the front) and is passed to the
calculator untouched.

`parseFile` accepts what TI's own software accepts. These are **warnings**, not
errors: `BAD_CHECKSUM`, `NO_CHECKSUM`, `DECLARED_LENGTH` (the data-section length
disagrees with the entries), `TRAILING_BYTES` and `HEADER_LENGTH` (an entry
header that is neither 11 nor 13 bytes, read as 11). It still refuses, with
`BAD_FILE`, a file that is not a variable file, whose declared data section or an
entry runs past the end, whose entry lengths disagree, that has no entries, or
that is 8 MB or larger. A file starting with `**TIFL**` is read as an application file (see Flash applications above).

## Tests

```sh
npm test
```
runs `node --test test/*.test.mjs calcplex/test/*.test.mjs`. The simulator is strict: every
transport test also checks that it recorded no protocol violations. It refuses
what a real CE refuses (oversize packets, commands before the ping, reads that
are not whole USB packets, a final packet that fills whole USB packets without a
zero-length write after it) and can send delay acknowledgements, its own buffer
size requests, and a reboot as a variable lands.

## How the protocol works

A summary of Moody's 2006 analysis of the TI-84 Plus USB protocol, which the CE
follows with larger packets, as corrected by the libticalcs comparison
([LIBTICALCS.md](LIBTICALCS.md)) and by what a real CE did.

There are two layers of framing. The bottom layer is the **raw packet**: a 4-byte
length, a 1-byte type, then that many bytes. There are five raw types: a request
for a buffer size (1), the answer (2), a piece of a larger message that continues
(3), the last piece (4), and an acknowledgement (5, the two bytes E0 00).
Every type 3 or 4 packet must be acknowledged with a type 5 before the sender
sends anything else, in both directions. Each raw packet goes in its own USB bulk
transfer. The CE only sees the end of a bulk transfer at a short USB packet, so a
last raw packet whose length (header included) is a multiple of 64 is followed by
a zero-length write.

Each **operation** starts with the host offering a maximum raw packet size (we
offer 1024) and the calculator answering with the size it will accept. The CE
answers 1023 and accepts at most 1018 data bytes per raw packet, whatever it
answers. This library negotiates and pings again before every operation, which
the hardware pass showed works. libticalcs negotiates once per session, and
`negotiateEachOperation: false` does that instead; it has not been tried on a
calculator. The
calculator can also reopen the negotiation mid-stream by sending its own buffer
size request where an acknowledgement was expected; the host answers with the
same size and carries on.

Inside raw packets 3 and 4 travel **virtual packets**: a 4-byte length, a 2-byte
type and the data, cut into as many raw packets as the buffer size needs and glued
back together by the receiver. When the data exactly fills its last raw packet,
that full packet is the type 4; an empty type 4 after a full type 3 hangs a real
CE (hardware, 2026-09-23). The reader accepts either shape from the calculator. The
first virtual packet of every operation is a **ping** that sets the mode (the
"normal operation" mode allows the variable commands); the calculator
acknowledges it by echoing the ping's 4-byte value. Wherever the host waits for an
answer, the calculator may first send a **delay acknowledgement** (0xBB00) whose
4 bytes are a wait in microseconds; the host sleeps that long (at most 400 ms)
before reading on.

The commands used here:

- **Parameter request** (0x0007): a count and a list of 16-bit parameter ids. The
  answer (0x0008) repeats each id with a validity byte and, when valid, a 16-bit
  length and the value. Product name, versions, free memory, screen size and
  battery state are all parameters.
- **Directory listing** (0x0009): a list of wanted attribute ids. The calculator
  answers with one **variable header** (0x000A) per variable (name, then each
  attribute with a validity byte, length and value) and then **end of
  transmission** (0xDD00). Attribute 1 is the size, 2 the type, 3 archived, 8
  the variable's version.
- **Silent send**: a **request to send** (0x000B) with the name, its NUL, the
  size, the silent flag 01, and the type, archived and version attributes; the
  calculator acknowledges (0xAA00); the host sends the **variable contents**
  (0x000D); the calculator acknowledges again; the host ends with end of
  transmission. A variable of the same name and type is replaced.
- **Request variable** (0x000C): the name, the attributes wanted back, and the
  type given as attribute 0x0011. The calculator answers with a variable header
  and then the contents.
- **Delete** (0x0010): the name, the type, a protection byte of 01 (delete even
  if archived or locked) and an empty destination; the calculator acknowledges.

Any refusal comes back as an **error** virtual packet (0xEE00) holding a 16-bit
code. Type attributes are `F0 <owner> 00 <type id>`; the owner byte is 0x0F when
sending, 0x07 when requesting and 0x0B when deleting. All protocol numbers are
big-endian; the variable data itself is carried as it is.

## What has run on real calculators

Tested on three TI-84 Plus CE units (OS 5.3.0.0037, 5.8.4.0058 and 5.8.5), in
Chrome and from Node through node-usb, on macOS and Windows.

- **USB:** vendor 0x0451, product 0xE008. One interface with bulk IN 0x81 and OUT 0x02, 64-byte packets.
- **Buffer size:** offered 1024, the CE allocates 1023 and takes at most 1018 data bytes per raw packet. A raw packet with 1023 data bytes is never acknowledged and leaves the link dead until the calculator is replugged; a USB reset does not clear it.
- **Framing:** after a final raw packet whose wire length is a multiple of 64, a zero-length write is required. A virtual packet that exactly fills one raw packet must go as that one final packet; sending it as a continuation followed by an empty final packet hung the link every time.
- **info():** product name, product number 0x13, OS and boot versions (build numbers in parameters 0x0048 and 0x0049), hardware version, screen size, home screen, battery. Free RAM (0x000E) read 0 in the first pass on OS 5.3 and has also come back as a one-off 0 on a calculator with plenty of RAM, so treat a 0 as unreliable. Parameter 0x005D is invalid on OS 5.3.
- **list(), send(), receive(), delete()** of programs, app variables and lists, to RAM and to archive, single- and multi-packet, read back byte-identical; `sendFile()` of group files; silent overwrite; a file with a wrong checksum; L₁ as a built-in name.
- **A variable that makes the calculator restart when it lands:** the restart does not always come at the same moment. Once it rejected the final USB write; once it came after a clean acknowledgement, so the next read met a stalled endpoint. `rebootOnLanding` reports both, so whatever runs next has to survive the link being gone.
- **sendApp()** of TI's Inequalz application completed once; it was not checked byte by byte.
- **Windows:** Chrome's device picker lists nothing until TI Connect CE (for its driver) has been installed; after that it connects and sends.
- **Chrome OS:** a connection has not been confirmed yet.
- **Test trap:** an app variable's first two bytes are its size. A test variable that declared more bytes than it sent, followed by the hang above, left a calculator showing ERR:MEMORY with Mem Management unreachable until a full memory reset. Build test variables with `body`, never raw `data`.

### Still unverified

Each item is something celink assumes and no real calculator has confirmed. The
quirk that switches it, if any, is in brackets.

- **Other units.** OS versions between 5.3 and 5.8.4, other hardware revisions and the Python edition, including whether they also allocate 1023. Whether product id 0xE008 is unique to the CE: WikiTI lists it for the older 84 Plus SE, so read the model from parameter 0x0002, never from the product id.
- **Linux** needs a udev rule for vendor 0x0451; not tried.
- **Configurations 2 and 3.** What they are for is unknown.
- **Zero-length packets from the calculator** after a raw packet that ends on a 64-byte boundary. The reader does not depend on them.
- **Delay acknowledgements (0xBB00) and buffer size requests from the calculator.** Handled as libticalcs handles them [`delayCapMicros`], but no calculator has been seen to send either.
- **Negotiating once per connection** [`negotiateEachOperation: false`] has not been tried.
- **Language ids.** 9 and 1 were reported; what they map to is unknown, so they are returned as numbers.
- **A full calculator.** Nothing in celink checks free space before a send; the calculator is expected to refuse with 0x000C (out of memory) or 0x001B (too large). Neither has been seen from celink.
- **Error codes.** The meanings in `CALC_ERRORS` come from libticalcs. The only code seen from celink so far is 0x0036, which is not in the table, through the jailbreak installer; a second try usually clears it. The simulator's 0x7Fxx codes are placeholders for refusals whose real code is not known (variable not found, bad name).
- **Parameter lengths are 16-bit.** Parameter 0x0022 (the screen) carries 153,600 bytes, so its length field cannot describe it. `info()` never requests it.
- **Flash applications beyond the one send above:** whether the erase and write waits come with delay acknowledgements and how long they are [`link.appTimeout`]; the battery check through 0x002D [`appBatteryCheck`] and whether 0x002E / 0x002F answer [`appBatteryDetail`]; receiving [`appReceiveTypeWord`, `appReceiveAttributes`]; deleting; the error codes.
- **Other variable types.** Protected programs, lists, matrices and the rest are sent the same way as programs and app variables.
- **Timeouts.** 3 s per transfer, and 15 s while streaming or waiting after the data, are guesses. In the failed first pass, the stuck transfer surfaced as `USB_ERROR` ("transferIn error: Cancelled") rather than `TIMEOUT`. Both close the link after trying to clear a halt on both endpoints.
- **Recovering a wedged calculator without a replug.** After an unacknowledged oversize packet, a libusb device reset did not clear it. Only a replug did, and that left a 2-byte fragment of the variable behind, which `list()` and `delete()` cleaned up. Whether clearing the endpoint halts helps is unknown.
- **A busy calculator.** Whether commands work while a program is running or a menu is open is unknown. 0x0034 is the code a CE is said to answer when it is not at the home screen.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE). Copyright (C) 2026 CalcPlex, and
the tilibs authors for the parts listed in [LIBTICALCS.md](LIBTICALCS.md).
