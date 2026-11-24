// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// How much free archive a send needs. Its own module, with no imports and
// nothing newer than ES2018, so a page can check the room before it loads the
// sender (and in browsers too old for the sender's own syntax).

// The archive refuses a variable while it still lists free space: it behaves
// as if a variable must fit inside one 64 KB flash sector's free run and one
// sector is held back for garbage collection. Observed in an emulator running
// OS 5.8.5: with 190 KB listed free a 40 KB variable fitted and a 45 KB one
// was refused, a game whose files needed 88 KB was refused with 190 KB free,
// and one whose files needed 354 KB (four of them 64 KB) was refused with
// 490 KB free. So a send needs room for itself, for its two largest archived
// variables once more, and one sector beyond that.
export const ARCHIVE_MARGIN = 65536;

/**
 * The archive a send needs for the variables it archives, each given by its
 * size there: `need`, their sum, and `reserve`, the room ARCHIVE_MARGIN's note
 * describes (the two largest once more and one sector; none when nothing is
 * archived). It fits when need + reserve <= archive free. gamesend.mjs
 * planInstall counts a send's space with it, and a page that says whether
 * something will fit should use it too, so the two never disagree.
 */
export function archiveRoom(sizes) {
  let need = 0, largest = 0, second = 0;
  for (const c of sizes) {
    need += c;
    if (c > largest) { second = largest; largest = c; }
    else if (c > second) second = c;
  }
  return { need, reserve: need ? largest + second + ARCHIVE_MARGIN : 0 };
}
