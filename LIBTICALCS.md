<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# What celink takes from tilibs

celink is derived from libticalcs and libtifiles, the link and file libraries in
[tilibs](https://github.com/debrouxl/tilibs) (Romain Liévin, Lionel Debroux,
Benjamin Moody and the other contributors in its AUTHORS file,
GPL-2.0-or-later), and is licensed the same way.

After celink's first version worked on a calculator, the tilibs source (commit
`6dba390`, 2026-09-06) was read and every difference in behaviour was written
down as a numbered list; celink was then changed from that list. This file
is that list, one line per item; the numbers are cited in
`test/libticalcs.test.mjs`.

Taken directly:

- **The calculator error table.** `CALC_ERRORS` in `celink.mjs` is libticalcs'
  list of 24 D-USB error codes (`usb_errors[]` in
  `libticalcs/trunk/src/dusb_cmd.cc`), in the same order, with meanings reworded
  from `libticalcs/trunk/src/error.cc`.
- **Packet names.** `VAR_HDR`, `VAR_CNTS`, `DIR_REQ`, `VAR_REQ`, `RTS`,
  `DATA_ACK` and `EOT` follow `libticalcs/trunk/src/dusb_vpkt.h`, and so do the
  name and meaning of 0xBB00 (Delay Acknowledgement), which Moody's 2006
  document lists as unknown.
- **The Flash application file check** in `calcplex/core.mjs` follows libtifiles
  (`files8x.cc`, `filetypes.cc`), as its comments say.

Behaviour that follows libticalcs or libtifiles:

1. A zero-length write after a final raw packet whose length on the wire is a multiple of 64.
2. The delay acknowledgement (0xBB00): a wait in microseconds, capped at 400 ms; a delay packet with fewer than 4 bytes means 100 ms.
3. A buffer size request from the calculator in place of an acknowledgement is answered with the same size; 4-byte acknowledgements are accepted.
4. At most 1018 data bytes per raw packet on the CE.
5. A virtual packet that exactly fills one raw packet goes as that single final packet, as in libticalcs. (When a longer virtual packet ends exactly on a raw-packet boundary, libticalcs adds an empty final packet; celink sends the full last packet as the final one instead and has not tried libticalcs' framing on hardware.)
6. The meaning of the bytes Moody's document leaves open in Request to Send, Request Variable and Delete: the NUL after the name, the silent-send flag, and the delete protection byte.
7. Request to Send carries the type, archived and version attributes, not size.
8. The owner byte per command: `F0 0F` to send, `F0 07` to request, `F0 0B` to delete.
9. A 50 ms pause after each variable sent.
10. Built-in names with subscript digits (L₁ is `4C E2 82 81`), `IDList`, `u`/`v`/`w`, and the fixed names `Window`, `RclWindw`, `TblSet`.
11. Named lists without a leading ⌊.
12. The variable type table, including 0x0D as a list type, and the file extensions.
13. Requesting a variable asks for archived, version and size, and keeps the version.
14. Contents longer than the declared size are trimmed.
15. The forgiving file parser: a bad checksum or a wrong declared length is a warning, entries are read up to the declared length, an unknown entry header length is read as the 11-byte form.
16. (libticalcs negotiates once per session; celink negotiates before every operation by default.)
17. USB reads in whole endpoint packets.
18. No free-space check before a send; the calculator refuses.
19. The 24 error codes (see the error table above).
20. Clearing the halt on both endpoints after a stuck transfer.
21. The OS version from bytes 1 to 3 of parameter 0x000B, the build number only when parameter 0x0048 is 2 bytes, the product number from the last byte of parameter 0x0001.
22. (libticalcs adds `Window`, `RclWindw` and `TblSet` to a listing; celink does not.)
23. A silent send replaces a variable of the same name and type; the CE does not support the non-silent form for ordinary variables.

**A. Flash applications.** Sending, receiving, listing and deleting `.8ek`
applications: the `**TIFL**` layout, the application's name from its own header,
the battery check through parameter 0x002D, the Request to Send with type
`F0 0F 00 24`, the two acknowledgements around the Flash erase and write, the
receive and delete type words, and the error codes for rejected applications.

**B. Variable files.**
24. An archived word written as 0x0080 by older tools means archived, version 0; a 0x55BB-byte picture with version 0 is version 10.
25. Group files are read the same way.

If you know tilibs and see something that should be credited differently,
please open an issue.
