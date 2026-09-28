<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# calcplex/

The calcplex.com page code that uses celink. It is published here because the site serves it together with the library.

- `core.mjs`: routing by CE OS version, strict parsers for variable files and Flash app files, and the SHA-256 pins for the official arTIfiCE release files.
- `transport.mjs`: the adapter between the installer and celink.
- `gamesend.mjs`: the engine behind the site's "Send to calculator" buttons. It orders C libraries before programs, checks free space, sends, and reads each variable back.
- `ce-send.mjs`: the Send buttons on the site's CE game and math download pages.
- `installer.mjs`: the guided TI-84 Plus CE jailbreak installer at /ti84plusce-jailbreak-installer/. It sends YvanTT's arTIfiCE (https://github.com/YvanTT/arTIfiCE, GPL-3.0), pinned to the files published at https://github.com/YvanTT/arTIfiCE/releases.

On the site these modules sit flat in one folder next to `celink.mjs` and `tifiles.mjs`, so the build rewrites the imports from `../celink.mjs` and `../tifiles.mjs` to `./celink.mjs` and `./tifiles.mjs`.

`ce-send.mjs` and `installer.mjs` start on import and need the site's page markup, so they have no tests here. The other three are tested against the simulated calculator in `../sim/`:

```
node --test calcplex/test/*.test.mjs
```

