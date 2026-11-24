'use strict';

import { CELL_SIZE, CELL_GAP, CELL_STRIDE, AISLE_SIZE } from './constants.js?v=28';

// Pure geometry and layout maths. No state, no DOM — this is the part that is
// worth testing in isolation.

// ── Tracks ───────────────────────────────────────────────
// Rows and columns are "tracks" of varying size: a full desk where there is a
// desk, a narrow walkway where there is none. Everything that positions or
// measures something on the grid goes through these, never through a fixed
// stride — otherwise the controls, the board and the print size drift apart.

/**
 * Sizes and start offsets for `n` tracks (1-based). `used` holds the indices
 * that contain a desk and get the full size; the rest get `aisle`.
 */
export function buildTracks(n, used, full = CELL_SIZE, aisle = AISLE_SIZE, gap = CELL_GAP) {
  const start = [0];
  const size  = [0];
  let pos = 0;
  for (let i = 1; i <= n; i++) {
    const s = used.has(i) ? full : aisle;
    start[i] = pos;
    size[i]  = s;
    pos += s + gap;
  }
  return { n, start, size, length: Math.max(0, pos - gap) };
}

/** Column and row tracks for a chart: which tracks hold a desk decides their size. */
export function chartTracks(desks, teacherDesk, gridCols, gridRows) {
  const cols = new Set();
  const rows = new Set();
  for (const d of desks) {
    rows.add(d.row);
    cols.add(d.col);
    if (d.size === 2) cols.add(d.col + 1);
  }
  if (teacherDesk) {
    cols.add(teacherDesk.col);
    rows.add(teacherDesk.row);
  }
  return { cols: buildTracks(gridCols, cols), rows: buildTracks(gridRows, rows) };
}

/** Pixel span from the start of track `from` to the end of track `to`. */
export function trackSpan(t, from, to = from) {
  const a = Math.max(1, Math.min(t.n, from));
  const b = Math.max(a, Math.min(t.n, to));
  return t.start[b] + t.size[b] - t.start[a];
}

// ── Uniform-grid helpers ─────────────────────────────────
// What the grid looks like with every track at full size. Kept for code that
// has no tracks to hand; the chart itself is drawn with the tracks above.

export function cellToPos(col, row) {
  return { left: (col - 1) * CELL_STRIDE, top: (row - 1) * CELL_STRIDE };
}

export function deskWidth(desk) {
  return desk && desk.size === 2 ? CELL_STRIDE * 2 - CELL_GAP : CELL_SIZE;
}

/** Pixel span of n cells including the gaps between them. */
export function spanOf(cells) {
  return cells * CELL_STRIDE - CELL_GAP;
}

export function calcGroupsPerRow(groupSize, gridCols) {
  if (groupSize === 1) return gridCols;
  return Math.max(1, Math.floor((gridCols + 1) / (groupSize + 1)));
}

/** Desk positions for a fresh layout. Desk rows sit on odd rows (1, 3, 5…),
 *  leaving a walking gap between them. */
export function computeLayout(deskCount, groupSize, gridCols) {
  const gpr     = calcGroupsPerRow(groupSize, gridCols);
  const colStep = groupSize === 1 ? 1 : groupSize + 1;
  return Array.from({ length: deskCount }, (_, i) => {
    const deskInGroup = i % groupSize;
    const groupIndex  = Math.floor(i / groupSize);
    return {
      col: (groupIndex % gpr) * colStep + deskInGroup + 1,
      row: Math.floor(groupIndex / gpr) * 2 + 1
    };
  });
}

export function calcRequiredRows(deskCount, groupSize, gridCols) {
  const gpr     = calcGroupsPerRow(groupSize, gridCols);
  const grpRows = Math.ceil(Math.ceil(deskCount / groupSize) / gpr);
  return Math.max(1, grpRows * 2 - 1);
}

/** A balanced grid for the given desk count — slightly wider than tall. */
export function computeAutoLayout(deskCount, groupSize) {
  const totalGroups = Math.ceil(deskCount / Math.max(1, groupSize));
  const gpr         = Math.max(2, Math.min(6, Math.round(Math.sqrt(totalGroups))));
  const gridCols    = groupSize <= 1 ? gpr : gpr * (groupSize + 1) - 1;
  const groupRows   = Math.ceil(totalGroups / gpr);
  // Each desk row is followed by a walkway, except the last one — a trailing
  // walkway is just an empty row at the back of the room.
  return {
    gridCols: Math.max(2, gridCols),
    gridRows: Math.max(1, groupRows * 2 - 1)
  };
}

/** Columns a desk physically covers: [first, last]. A wide desk covers two. */
function colSpan(desk) {
  return [desk.col, desk.col + (desk.size === 2 ? 1 : 0)];
}

/**
 * Diagonals count as neighbours — sitting corner to corner is still "sammen".
 *
 * Comparing desk.col alone treated a wide desk as if it stood only on its
 * left-hand cell, so a student sitting against its right half looked two
 * columns away and a "skal ikke sitte sammen" rule was silently ignored.
 * Measuring the gap between footprints handles both widths identically.
 */
export function areNeighbors(d1, d2) {
  if (Math.abs(d1.row - d2.row) > 1) return false;
  const [aFirst, aLast] = colSpan(d1);
  const [bFirst, bLast] = colSpan(d2);
  // 0 when the footprints touch or overlap, otherwise the columns between them.
  const gap = Math.max(bFirst - aLast, aFirst - bLast, 0);
  return gap <= 1;
}
