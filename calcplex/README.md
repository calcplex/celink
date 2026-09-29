<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# calcplex/

The calcplex.com page code that runs on celink. The site serves it with the
library, so it is published here.

| File | What it is |
|---|---|
| `core.mjs` | Routing by OS version, strict checks on variable and Flash app files, SHA-256 pins for the arTIfiCE release files, refusal messages |
| `transport.mjs` | The jailbreak installer's link: collision rules and a read-back after every send |
| `gamesend.mjs` | Sending a game: C libraries first, a space check, then each variable read back |
| `ce-send.mjs` | The Send to calculator buttons on the download pages |
| `installer.mjs` | The TI-84 Plus CE jailbreak installer, which sends [arTIfiCE](https://github.com/YvanTT/arTIfiCE) |

On the site these files sit next to `celink.mjs` and `tifiles.mjs`, so the
build turns their `../` imports into `./`. `ce-send.mjs` and
`installer.mjs` start on import and need the site's markup, so only the other
three have tests (`calcplex/test/`, run by `npm test`).
