<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Credits

## tilibs

celink is a port of parts of [tilibs](https://github.com/debrouxl/tilibs)
(GPL-2.0-or-later), read at commit `6dba390`:

- **libticalcs**: the DUSB raw and virtual packet layers, the commands and the
  TI-84 Plus CE calculator functions (`dusb_rpkt.cc`, `dusb_vpkt.cc`,
  `dusb_cmd.cc`, `calc_84p.cc`), and the calculator error table and its
  descriptions (`dusb_cmd.cc`, `error.cc`).
- **libtifiles**: TI-8x variable files, group files and Flash application
  files (`files8x.cc`, `filetypes.cc`, `types83p.cc`, `typesxx.cc`).
- **libticonv**: variable names, detokenizing and the TI-83 Plus character set
  (`ticonv.cc`, `tokens.cc`, `charset.cc`).

The copyright lines of the ported files name Romain Liévin (roms), Benjamin
Moody (FloppusMaximus) and Kevin Kofler. Lionel Debroux has maintained tilibs
since 2009, and its AUTHORS files also list Julien Blache (jb), Tijl Coosemans
(Kalimero), Jesse Palmer (jp3d) and Tyler Cassidy (tylerc).

The USB handling was compared with libticables (`link_usb1.cc`); where it
differs, the code says why.

`calcplex/core.mjs` follows libtifiles for its Flash application check and
rewords libticalcs' error descriptions.

## Other

- Benjamin Moody's [The TI-84 Plus USB Protocol: A Partial Analysis](https://brandonw.net/calcstuff/DirectUSB.txt)
  (2006), an early description of the protocol.
- The [CE C toolchain](https://github.com/CE-Programming/toolchain):
  `calcplex/gamesend.mjs` recognises its libraries by their headers.
- [arTIfiCE](https://github.com/YvanTT/arTIfiCE) by YvanTT (GPL-3.0), which
  `calcplex/installer.mjs` sends, pinned to the release files by SHA-256. Its
  files are not in this repository.
