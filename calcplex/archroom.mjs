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

// The same rule by sector, from the calculator's listing. Observed in an
// emulator running OS 5.3.0, 5.3.1 and 5.8.5, reading the flash: the archive
// is a run of 64 KB sectors, each a status byte and 65,535 bytes; a variable
// never crosses a sector's end; its entry there is its size, its name and 10
// bytes of header; one erased sector is always held back; and the free figure
// counts every sector's unused tail. So the free figure alone cannot say
// whether a variable fits: 312 KB free in whole sectors took a send that
// 475 KB free in tails refused. A new variable goes into the first sector
// with room for it, else into an erased one; a garbage collection repacks
// the live variables first fit in their flash order.
export const SECTOR_BYTES = 65535;

/** A variable's room in an archive sector: its size, its name and the header. */
export function entryBytes(size, nameLength) {
  return size + (nameLength == null ? 8 : nameLength) + 10;
}

/**
 * Do the variables `sending` go in beside the archived ones? Both are lists
 * of entry sizes (entryBytes): `archived` in the listing's order, `sending`
 * in the order the send writes them, since the calculator places each one as
 * it arrives. `archiveFree` is the free figure the calculator reports. Places
 * the archived variables first fit, as a garbage collection would, then the
 * new ones first fit, never into the held-back sector.
 * -> { sectors (the archive's, the held-back one included), used, fits }
 */
export function sectorFit(archived, sending, archiveFree) {
  let live = 0;
  for (let i = 0; i < archived.length; i++) live += archived[i];
  const sectors = Math.round((live + archiveFree + SECTOR_BYTES + 1) / SECTOR_BYTES);
  const bins = [];
  const place = function (c) {
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] + c <= SECTOR_BYTES) { bins[i] += c; return; }
    }
    bins.push(c);
  };
  for (let i = 0; i < archived.length; i++) place(archived[i]);
  for (let i = 0; i < sending.length; i++) place(sending[i]);
  return { sectors, used: bins.length, fits: bins.length <= sectors - 1 };
}
