<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# celink

A JavaScript port of the TI-84 Plus CE parts of [tilibs](https://github.com/debrouxl/tilibs):
libticalcs' DUSB link code and the pieces of libtifiles and libticonv it needs.
It talks to a TI-84 Plus CE over WebUSB to read the calculator's parameters,
list, send, receive and delete variables, and send, receive and delete Flash
applications.

Plain ES modules with no dependencies and no build step. It runs in Chrome and
Edge, and in Node 20+ against any object shaped like a `USBDevice` (the tests
use a simulated calculator). Where celink departs from tilibs, the code says
why in one line; many departures are behaviour a real calculator showed.

Most of this code was written with AI.

## Calculators

The TI-84 Plus CE (USB vendor 0x0451, product 0xE008).

Windows needs the driver that TI Connect CE installs; until then the browser's
device picker lists nothing. On Linux the user needs access to the device node,
usually through a udev rule for vendor 0x0451. Only one program can hold the
calculator at a time, so close TI Connect CE first.

## Quickstart

```js
import { CELink } from './celink.mjs';
import { parseFile } from './tifiles.mjs';

sendButton.onclick = async () => {
  // Reuse a calculator the page may already use: a click opens one picker at most.
  const granted = await CELink.granted();
  const link = granted.length === 1 ? CELink.fromDevice(granted[0]) : await CELink.request();
  await link.open();
  try {
    await link.ready();
    const { productName, osVersion } = await link.info();
    const bytes = new Uint8Array(await (await fetch('GAME.8xp')).arrayBuffer());
    await link.sendFile(parseFile(bytes), {
      onProgress: (sent, total) => console.log(`${productName} ${osVersion}: ${sent}/${total}`),
    });
  } finally {
    await link.close();
  }
};
```

## API

`celink.mjs`. Every instance method returns a promise; calls on one link run
one at a time, in order.

| Call | Does |
|---|---|
| `CELink.request(options)` | Shows the browser's picker for TI devices and wraps the one chosen, with `fromDevice`'s options. Call it from a click, once per click |
| `CELink.granted()` | The TI devices the page may already use |
| `CELink.fromDevice(device, { timeout, streamTimeout, appTimeout })` | Wraps a `USBDevice`. Timeouts are per transfer: 3 s, 15 s for variable contents, 30 s for a Flash application |
| `open()`, `close()` | Claim and release interface 0. Nothing goes over the cable until `ready()` |
| `ready()` | libticalcs' `is_ready`: negotiate the packet size and set the normal mode. Required before the first operation |
| `info()` | Product name and number, OS and boot versions, hardware version, free RAM and archive, screen size, battery, home screen; `params` holds every raw value |
| `list()` | `[{ name, type, typeName, size, archived }]` for variables and applications |
| `send(entry, { archive, onProgress, rebootOnLanding })` | Sends one variable, replacing one of the same name and type; `archive` defaults to the entry's own flag. Resolves `{ name, bytes, rebooted }` |
| `sendFile(file, options)` | Sends every variable of a `.8xp`, `.8xv` or `.8xg`, as `parseFile` returned it, in order |
| `receive(name, type)`, `delete(name, type)` | Names as typed (`'L1'`) or as listed (`'L₁'`) |
| `sendApp(file, { onProgress })` | Sends the Flash application of a `.8ek`, as `parseAppFile` returned it |
| `receiveApp(name)`, `listApps()`, `deleteApp(name)` | Flash applications on the calculator |
| `onPacket = (dir, bytes) => {}` | Sees every raw packet, for captures |
| `anomalies`, `onAnomaly = (kind, detail) => {}` | Counts, and reports as they happen, what the link lets through where libticalcs fails (leftover packets before a buffer answer, an acknowledgement inside a listing, a short parameter reply) and the endpoint halts it clears before closing on a lost link |

Errors are `CELinkError` with a stable `code`. A calculator refusal is
`CALC_ERROR` with `calcError` (its code), `op` and `step`; `CALC_ERRORS` holds
libticalcs' descriptions. `TIMEOUT`, `USB_ERROR`, `DISCONNECTED` and `PROTOCOL`
close the link, because a WebUSB transfer that timed out cannot be cancelled
and would swallow the next reply; `open()` and `ready()` again to go on.

`tifiles.mjs` reads and writes the files:

```js
import { parseFile, buildFile, makeEntry, parseAppFile, buildAppFile, TYPE } from './tifiles.mjs';

const { entries, warnings } = parseFile(bytes);   // .8xp, .8xv or .8xg
const file = buildFile(entries, { comment: 'My program' });
const entry = makeEntry({ name: 'SAVE', type: TYPE.APPVAR, body });  // adds the size word

const app = parseAppFile(ekBytes);                // .8ek
const ek = buildAppFile(app.entries[0]);
```

Like libtifiles, `parseFile` warns rather than refuses on a bad checksum or a
wrong declared length; it also warns, where libtifiles refuses, on a file that
ends before its checksum. `nameToString` and `nameToBytes` convert names through
libticonv's tokens and character set.

## Hardware behaviour

| Behaviour | What it means for a host |
|---|---|
| The CE allocates 1023 bytes and takes at most 1018 data bytes a raw packet: the 5-byte header counts | A larger packet wedges the calculator's USB until it is unplugged; no reset from the host recovers it |
| A final raw packet that fills whole 64-byte USB packets needs a zero-length write after it | Without it the calculator waits for more |
| Contents that exactly fill several raw packets end on the full last packet (2030 bytes ran this way) | libticalcs adds an empty type 4 after it, which has not been tried on a CE; celink does not |
| A single full type 3 followed by an empty type 4 hung the calculator until it was replugged | A virtual packet that fits one raw packet goes as a single type 4, as libticalcs sends it |
| A variable that restarts the calculator as it lands can fail the last write although it arrived, or be acknowledged first | Use `rebootOnLanding`, and treat the link as gone after it either way |
| The calculator believes a variable's size word over the bytes sent | Build variables with `makeEntry({ body })`; a size word larger than the data has caused ERR:MEMORY |
| Free RAM (parameter 0x000E) can read 0 on a calculator with plenty | Read it again before refusing a send for space |
| The CE has no USB serial number | After a restart the browser cannot tell it is the same device |
| A click's user activation is spent on the first device picker | A second `requestDevice` in the same click fails like a cancel |
| Error 0x0036 refuses some sends and is not in libticalcs' table | The cause is unknown; reports with the calculator's screen and OS are welcome |

## calcplex/

The page code calcplex.com runs on top of celink: the Send to calculator
buttons and the TI-84 Plus CE jailbreak installer. It is served together with
the library, so its source is here too. See [calcplex/README.md](calcplex/README.md).

## Tests

```sh
npm test
```

The tests run against `sim/calculator.mjs`, a simulated CE behind a
`USBDevice`-shaped interface. It refuses what a real CE refuses. Anything a CE
was not seen to accept and libticalcs does not send is recorded as a
violation, and so is libticalcs framing that has never been tried on a CE; the
tests assert there were none. Tests whose title starts "observed on hardware"
pin what a real calculator did. `fixtures/` holds a small TI-Basic program
(`probe.8xp`) and CalcPlex's [Snake](https://github.com/calcplex/snake)
(`SnakeCE.8xg`, 0BSD).

## Credits

celink is derived from tilibs by Romain Liévin, Lionel Debroux, Kevin Kofler,
Benjamin Moody and the other tilibs contributors. [CREDITS.md](CREDITS.md) lists
what comes from where.

## License

GPL-2.0-or-later, the same as tilibs. See [LICENSE](LICENSE).
