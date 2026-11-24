'use strict';

import {
  CELL_SIZE, CTRL_SIZE, BB_MARGIN, MIN_BB_SIZE,
  VALID_PRINT_FORMATS, VALID_PRINT_ORIENTATIONS,
  MM_TO_PX, PAGE_MARGIN_MM, PAGE_SIZES_MM, PRINT_HEADER_PX, MIN_PRINT_ZOOM,
  PRINT_FIT_SLACK, MIN_SCREEN_ZOOM, MAX_PRESENT_ZOOM,
  NAME_MAX_PX, NAME_FLOOR_PX, NAME_MIN_PX, NAME_MAX_LINES
} from './constants.js';
import {
  state, isFreeDesk, studentsWithoutDesk, isAxisEmpty, detectDuplicates, getMoveMode
} from './state.js';
import { chartTracks, trackSpan } from './layout.js';
import { todayKey, absentToday } from './groups.js';
import { renderGroupsAll } from './groups-view.js';
import { renderActivitiesAll } from './activities-view.js';
import { renderRuleList } from './rules-view.js';
import { renderClassBar } from './classes.js';

// Re-exported so callers keep importing every render function from one place.
export { renderRuleList };

const $ = id => document.getElementById(id);

// ── Geometry ─────────────────────────────────────────────
// Track sizes depend on where the desks stand, so they are recomputed from
// state whenever they're needed rather than cached across edits.
function tracks() {
  return chartTracks(state.desks, state.teacherDesk, state.gridCols, state.gridRows);
}

function posOf(t, col, row) {
  return { left: t.cols.start[col] ?? 0, top: t.rows.start[row] ?? 0 };
}

function deskPixelWidth(t, desk) {
  return trackSpan(t.cols, desk.col, desk.col + (desk.size === 2 ? 1 : 0));
}

// ── Text sizing ──────────────────────────────────────────
// Every desk uses the same font size, and names wrap onto lines — first name
// on one, surname on the next — instead of each name being squeezed onto one
// line at its own size. That gave a chart where every desk looked different,
// and long names ended up at 7px and clipped anyway.

const DESK_PAD_X   = 6;   // must match .desk padding + border in styles.css
const DESK_PAD_Y   = 6;
const NAME_LINE_H  = 1.18; // must match .desk line-height
const NAME_WEIGHT  = 600;  // must match .desk font-weight

let measureCtx = null;
let chartNamePx = NAME_MAX_PX;

let fontFamily = null;

function textWidth(text, px) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!fontFamily) fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  const font = `${NAME_WEIGHT} ${px}px ${fontFamily}`;
  if (measureCtx.font !== font) measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** The pieces a name may break between: spaces, and right after a hyphen. */
function nameTokens(name) {
  const out = [];
  name.split(/\s+/).filter(Boolean).forEach((word, wi) => {
    const parts = word.split(/(?<=-)/);
    parts.forEach((p, pi) => out.push({ text: p, space: wi > 0 && pi === 0 }));
  });
  return out;
}

/** Lines `name` needs at `px` in a box `width` wide; Infinity if a piece can't fit at all. */
function linesNeeded(name, px, width) {
  let lines = 1;
  let line  = '';
  for (const tok of nameTokens(name)) {
    if (textWidth(tok.text, px) > width) return Infinity;
    const candidate = line ? line + (tok.space ? ' ' : '') + tok.text : tok.text;
    if (textWidth(candidate, px) <= width) {
      line = candidate;
    } else {
      lines++;
      line = tok.text;
    }
  }
  return lines;
}

function deskInnerBox(desk) {
  const wide = desk && desk.size === 2;
  // Measured against the full-size track; desks always sit in one. Two px of
  // slack absorbs the difference between canvas and DOM text measurement.
  const width = (wide ? CELL_SIZE * 2 + 8 : CELL_SIZE) - DESK_PAD_X * 2 - 2;
  return { width, height: CELL_SIZE - DESK_PAD_Y * 2 - 1 };
}

function fitsAt(name, px, desk, maxLines = Infinity) {
  const box   = deskInnerBox(desk);
  const lines = linesNeeded(name, px, box.width);
  return lines <= maxLines && lines * px * NAME_LINE_H <= box.height;
}

/** Largest size from `max` down to `min` (half-pixel steps) at which `name` fits. */
function largestFit(name, desk, max, min, maxLines) {
  for (let px = max; px >= min; px -= 0.5) {
    if (fitsAt(name, px, desk, maxLines)) return px;
  }
  return null;
}

// Share of the names allowed to be smaller than the rest. Without it one
// «Mathilde Kristiansen-Johannessen» pulled every name in the room down to
// the floor size.
const NAME_OUTLIER_SHARE = 0.1;

/** The one size the whole chart uses: the largest at which (nearly) every name
 *  fits on NAME_MAX_LINES lines, but never below the floor. */
function computeChartNamePx() {
  const scale = state.textScale || 1;
  const max   = NAME_MAX_PX   * scale;
  const floor = NAME_FLOOR_PX * scale;
  const fits  = state.desks
    .filter(d => d.studentName)
    .map(d => largestFit(d.studentName, d, max, floor, NAME_MAX_LINES) ?? floor)
    .sort((a, b) => a - b);
  const skip = Math.floor(fits.length * NAME_OUTLIER_SHARE);
  chartNamePx = fits.length > 0 ? Math.max(floor, fits[skip]) : max;
  return chartNamePx;
}

function pxString(px) {
  return (Math.round(px * 2) / 2) + 'px';
}

/**
 * Font size for one desk: the chart's common size, or smaller for a name that
 * doesn't fit even at that.
 */
export function deskFontSize(name, desk) {
  if (!name) return pxString(NAME_FLOOR_PX * (state.textScale || 1));
  if (fitsAt(name, chartNamePx, desk)) return pxString(chartNamePx);
  const min = NAME_MIN_PX * (state.textScale || 1);
  return pxString(largestFit(name, desk, chartNamePx, min) ?? min);
}

/** Last check against the real layout: canvas measuring is close to, but not
 *  exactly, what the browser does. Anything still overflowing shrinks a bit. */
function settleDeskFont(el) {
  if (!el.textContent || el.querySelector('input')) return;
  let px = parseFloat(el.style.fontSize) || chartNamePx;
  const min = NAME_MIN_PX * (state.textScale || 1);
  let guard = 12;
  while (guard-- > 0 && px > min &&
         (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
    px -= 0.5;
    el.style.fontSize = pxString(px);
  }
}

// ── Small syncs ──────────────────────────────────────────
export function updateGridDisplay() {
  const cv = $('grid-cols-val');
  const rv = $('grid-rows-val');
  if (cv) cv.textContent = state.gridCols;
  if (rv) rv.textContent = state.gridRows;
}

export function updateStudentCount() {
  $('student-count').textContent = '(' + state.students.length + ')';
}

export function updateDatalist() {
  const dl = $('students-datalist');
  dl.textContent = '';
  state.students.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  });
}

/** Which tool is showing: body class, tab state and the main button's label. */
export function syncModeUI() {
  const mode = state.mode;
  // One class per tool rather than a single «is groups» flag: each tool's
  // panels are shown by `body.mode-x .x-only` in styles.css.
  ['seating', 'groups', 'activities'].forEach(name => {
    document.body.classList.toggle('mode-' + name, mode === name);
  });
  document.querySelectorAll('[data-mode-tab]').forEach(tab => {
    const on = tab.dataset.modeTab === mode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  });
}

export function updatePrintHeader() {
  const suffix = { groups: 'Grupper', activities: 'Mariusleken' }[state.mode];
  $('ph-class').textContent = suffix
    ? (state.className ? `${state.className} · ${suffix}` : suffix)
    : (state.className || 'Klassekart');
  $('ph-date').textContent  =
    new Date().toLocaleDateString('no-NO', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Shows the duplicate-name warning and returns the duplicates found. */
export function syncDupWarning() {
  const names = $('students-textarea').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  const dups   = detectDuplicates(names);
  const warnEl = $('dup-warning');
  if (dups.length > 0) {
    warnEl.textContent   = '⚠ Duplikat: ' + dups.join(', ');
    warnEl.style.display = 'block';
  } else {
    warnEl.textContent   = '';
    warnEl.style.display = 'none';
  }
  return dups;
}

// ── Print scaling ────────────────────────────────────────

/** Printable area of the chosen sheet, in CSS px. */
function printableAreaPx() {
  const [short, long] = PAGE_SIZES_MM[state.printFormat] || PAGE_SIZES_MM.A4;
  const landscape = state.printOrientation === 'landscape';
  return {
    width:  ((landscape ? long : short) - PAGE_MARGIN_MM * 2) * MM_TO_PX,
    height: ((landscape ? short : long) - PAGE_MARGIN_MM * 2) * MM_TO_PX
  };
}

/**
 * Size #classroom will occupy on paper.
 *
 * Computed rather than measured, because on screen the element also contains
 * the row/column controls that print hides. With the board horizontal it spans
 * exactly the desk grid; vertically it adds the board and the gap beside it.
 */
function chartPrintSize() {
  const board = getComputedStyle($('blackboard'));
  const gap   = parseFloat(getComputedStyle($('classroom')).gap) || 20;
  const t     = tracks();
  const gridW = t.cols.length;
  const gridH = t.rows.length;
  const pos   = state.blackboardPosition || 'top';

  // Computed style rather than offsetWidth/Height: those are affected by the
  // on-screen zoom, the CSS sizes are not.
  return (pos === 'top' || pos === 'bottom')
    ? { width: gridW, height: (parseFloat(board.height) || 54) + gap + gridH }
    : { width: (parseFloat(board.width) || 52) + gap + gridW, height: gridH };
}

function printHeaderHeightPx() {
  const el = $('print-header');
  // Has layout only while printing; trust a real measurement when we get one.
  if (el && el.offsetHeight > 0) {
    return el.offsetHeight + (parseFloat(getComputedStyle(el).marginBottom) || 0);
  }
  return PRINT_HEADER_PX;
}

/**
 * Sets the zoom that makes the chart fit one sheet.
 *
 * Uses `zoom` rather than `transform: scale()` on purpose — transform leaves
 * the layout box at full size, so an oversized chart would still push a second
 * page out and the auto-margin centring would work off the wrong height.
 */
export function updatePrintScale() {
  const cls = $('classroom');
  if (!cls) return;

  if (!state.scaleToFitOnPrint) {
    cls.style.setProperty('--print-zoom', '1');
    return;
  }

  const area  = printableAreaPx();
  const chart = chartPrintSize();
  const availH = Math.max(1, area.height - printHeaderHeightPx());

  if (chart.width <= 0 || chart.height <= 0) {
    cls.style.setProperty('--print-zoom', '1');
    return;
  }

  const fit = Math.min(1,
    (area.width * PRINT_FIT_SLACK) / chart.width,
    (availH     * PRINT_FIT_SLACK) / chart.height);
  cls.style.setProperty('--print-zoom', String(Math.max(MIN_PRINT_ZOOM, fit)));
}

// ── Print page style ─────────────────────────────────────
export function updatePrintPageStyle() {
  let style = $('print-page-style');
  if (!style) {
    style    = document.createElement('style');
    style.id = 'print-page-style';
    document.head.appendChild(style);
  }
  // Allowlist-validated: these values land inside a stylesheet.
  const fmt = VALID_PRINT_FORMATS.has(state.printFormat)           ? state.printFormat      : 'A4';
  const ori = VALID_PRINT_ORIENTATIONS.has(state.printOrientation) ? state.printOrientation : 'landscape';
  // Group lists and answer sheets read best upright; the chart's own paper
  // settings are hidden outside the chart, so they don't apply there either.
  const upright = state.mode !== 'seating';
  let css = `@media print { @page { size: ${upright ? 'A4 portrait' : `${fmt} ${ori}`}; margin: 10mm; } }`;
  if (!upright && state.hideEmptyDesksOnPrint) {
    css += ' @media print { .desk-empty { visibility: hidden !important; } }';
  }
  style.textContent = css;
  updatePrintScale();
}

// ── Stats banner ─────────────────────────────────────────
export function renderStatsBanner() {
  const banner = $('stats-banner');
  if (!banner) return;
  if (state.desks.length === 0) { banner.classList.remove('visible'); return; }

  const inList   = new Set(state.students);
  const stale    = state.desks.filter(d => d.studentName && !inList.has(d.studentName)).length;
  const locked   = state.desks.filter(d => d.locked).length;
  const assigned = state.desks.filter(d => d.studentName && !d.locked && inList.has(d.studentName)).length;
  const marked   = state.desks.filter(d => d.marked && !d.studentName && !d.locked).length;
  const empty    = state.desks.filter(isFreeDesk).length;

  banner.textContent = '';
  const entries = [
    ['🎲', assigned, 'plassert'],
    ...(locked > 0 ? [['🔒', locked, 'låst']] : []),
    ...(marked > 0 ? [['📦', marked, 'markert']] : []),
    ['⬜', empty,    'tom' + (empty !== 1 ? 'me' : '')],
    ...(stale > 0 ? [['⚠️', stale, 'ikke i listen']] : [])
  ];
  entries.forEach(([icon, count, label]) => {
    const span = document.createElement('span');
    span.textContent = `${icon} ${count} ${label}`;
    banner.appendChild(span);
  });
  banner.classList.add('visible');
}

// ── Mismatch warning ─────────────────────────────────────
function pluralDesks(n) { return `pult${n !== 1 ? 'er' : ''}`; }

/** Desks holding a name that is no longer on the student list. */
export function staleDesks() {
  const inList = new Set(state.students);
  return state.desks.filter(d => d.studentName && !inList.has(d.studentName));
}

export function renderMismatchWarning() {
  const w  = $('mismatch-warning');
  const ol = $('overflow-list');
  w.textContent  = '';
  w.className    = '';
  ol.textContent = '';

  // Nothing to say before there are any students. The first visit used to
  // greet the teacher with «24 pulter er tomme — Fjern 24 overflødige pulter».
  const stale = staleDesks();
  if (state.students.length === 0 && stale.length === 0) return;

  const unassigned = studentsWithoutDesk();
  const emptyCount = state.desks.filter(isFreeDesk).length;
  // A seat still holding a removed student is free as far as placing goes —
  // «Plasser» fills those first (fixMissingDesks).
  const reusable   = stale.filter(d => !d.locked && !d.marked).length;

  const addRow = (text, action, btnLabel, extraClass = '') => {
    w.className = 'show';
    const row  = document.createElement('div');
    row.className = 'mm-row';
    const span = document.createElement('span');
    span.textContent = text;
    const btn = document.createElement('button');
    btn.type          = 'button';
    btn.className     = 'btn-fix-desks' + (extraClass ? ' ' + extraClass : '');
    btn.textContent   = btnLabel;
    btn.dataset.action = action;
    row.append(span, btn);
    w.appendChild(row);
  };

  if (stale.length > 0) {
    const n = stale.length;
    addRow(`${n} elev${n > 1 ? 'er' : ''} på pultene er ikke i elevlisten`,
           'remove-stale', 'Fjern dem fra kartet', 'btn-stale-desks');
  }

  if (unassigned.length > 0) {
    const n = unassigned.length;
    // The button fills free desks first and only creates what's still missing.
    // Labelling it "+ Legg til 6 pulter" when six desks are already standing
    // empty promised something it never did.
    const needNew = Math.max(0, n - emptyCount - reusable);
    const label = needNew > 0
      ? `+ Legg til ${needNew} ${pluralDesks(needNew)}`
      : `Plasser ${n} elev${n > 1 ? 'er' : ''}`;
    addRow(`${n} elev${n > 1 ? 'er' : ''} har ikke pult`, 'fix-desks', label);
    ol.textContent = 'Uten pult: ' + unassigned.join(', ');
  } else if (emptyCount > 0 && stale.length === 0) {
    addRow(`${emptyCount} ${pluralDesks(emptyCount)} er tom${emptyCount > 1 ? 'me' : ''}`,
           'trim-desks', `Fjern ${emptyCount} overflødige ${pluralDesks(emptyCount)}`,
           'btn-trim-desks');
  }
}

// ── Row / column controls ────────────────────────────────
function buildAxisSlot(axis, index, t) {
  const isRow     = axis === 'row';
  const track     = isRow ? t.rows : t.cols;
  const isAisle   = track.size[index] < CELL_SIZE;
  const moveMode  = getMoveMode();
  const inMode    = moveMode?.type === axis;
  const otherMode = moveMode && !inMode;

  const ctrl = document.createElement('div');
  ctrl.className = isRow ? 'row-ctrl' : 'col-ctrl';
  if (isAisle) ctrl.classList.add('rc-aisle');
  if (isRow) {
    ctrl.style.top    = track.start[index] + 'px';
    ctrl.style.height = track.size[index] + 'px';
  } else {
    ctrl.style.left   = track.start[index] + 'px';
    ctrl.style.width  = track.size[index] + 'px';
  }

  const noun = isRow ? 'rad' : 'kolonne';

  if (inMode) {
    if (moveMode.index === index) {
      ctrl.classList.add('rc-selected');
      const btn = document.createElement('button');
      btn.className      = 'ctrl-btn ctrl-cancel';
      btn.textContent    = '✕';
      btn.title          = 'Avbryt flytting';
      btn.dataset.action = 'cancel-move';
      ctrl.appendChild(btn);
    } else if (isAxisEmpty(axis, index)) {
      ctrl.classList.add('rc-valid');
      ctrl.title            = `Flytt ${noun} ${moveMode.index} hit`;
      ctrl.style.cursor     = 'pointer';
      ctrl.dataset.action   = 'drop-axis';
      ctrl.dataset.axis     = axis;
      ctrl.dataset.index    = index;
    } else {
      ctrl.classList.add('rc-invalid');
      ctrl.title = `${isRow ? 'Raden' : 'Kolonnen'} er ikke tom`;
    }
  } else if (!otherMode) {
    const del = document.createElement('button');
    del.className      = 'ctrl-btn ctrl-delete';
    del.textContent    = '×';
    del.title          = `Slett ${noun}`;
    del.dataset.action = 'delete-axis';
    del.dataset.axis   = axis;
    del.dataset.index  = index;

    const mov = document.createElement('button');
    mov.className      = 'ctrl-btn ctrl-move';
    mov.textContent    = isRow ? '⇅' : '⇄';
    mov.title          = `Flytt ${noun} til tom ${noun}`;
    mov.dataset.action = 'pick-axis';
    mov.dataset.axis   = axis;
    mov.dataset.index  = index;

    // An empty walkway has nothing to move — it only needs deleting.
    if (isAisle) ctrl.append(del);
    else ctrl.append(del, mov);
  }
  return ctrl;
}

export function renderRowColControls() {
  const rowCtrl = $('row-controls');
  const colCtrl = $('col-controls');
  if (!rowCtrl || !colCtrl) return;

  rowCtrl.textContent = '';
  colCtrl.textContent = '';
  const t = tracks();
  rowCtrl.style.height = t.rows.length + 'px';
  colCtrl.style.width  = t.cols.length + 'px';

  for (let r = 1; r <= state.gridRows; r++) rowCtrl.appendChild(buildAxisSlot('row', r, t));
  for (let c = 1; c <= state.gridCols; c++) colCtrl.appendChild(buildAxisSlot('col', c, t));
}

// ── Group backgrounds ────────────────────────────────────
function isContiguous(values) {
  return values.every((v, i) => i === 0 || v === values[i - 1] + 1);
}

function renderGroupBackgrounds(container, t) {
  const byGroup = new Map();
  state.desks.forEach(d => {
    if (!byGroup.has(d.groupId)) byGroup.set(d.groupId, []);
    byGroup.get(d.groupId).push(d);
  });

  const PAD = 5;
  byGroup.forEach(desks => {
    if (desks.length < 2) return;
    if (desks.some(d => d.size === 2)) return; // wide desks would overlap the frame

    const cols  = desks.map(d => d.col).sort((a, b) => a - b);
    const rows  = desks.map(d => d.row).sort((a, b) => a - b);
    const uRows = [...new Set(rows)];
    const uCols = [...new Set(cols)];

    const horizontal = uRows.length === 1 && isContiguous(cols);
    const vertical   = uCols.length === 1 && isContiguous(rows);
    if (!horizontal && !vertical) return;

    const col0 = horizontal ? cols[0] : uCols[0];
    const row0 = horizontal ? uRows[0] : rows[0];
    const pos  = posOf(t, col0, row0);
    const bg   = document.createElement('div');
    bg.className    = 'group-bg';
    bg.style.left   = (pos.left - PAD) + 'px';
    bg.style.top    = (pos.top  - PAD) + 'px';
    bg.style.width  = (horizontal ? trackSpan(t.cols, cols[0], cols[cols.length - 1]) : t.cols.size[col0]) + PAD * 2 + 'px';
    bg.style.height = (vertical   ? trackSpan(t.rows, rows[0], rows[rows.length - 1]) : t.rows.size[row0]) + PAD * 2 + 'px';
    container.appendChild(bg);
  });
}

// One colour per table group, in the order the groups appear in the room, so
// a chart of pairs or fours reads at a glance — and matches nothing else, so
// it isn't mistaken for the Grupper tab. A lone desk gets a neutral colour.
const DESK_COLORS = [
  '#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5', '#e03131',
  '#0c8599', '#f08c00', '#5f3dc4', '#c2255c', '#66a80f'
];
const LONE_DESK_COLOR = '#adb5bd';

function deskGroupColors() {
  const members = new Map();
  [...state.desks]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .forEach(d => {
      if (!members.has(d.groupId)) members.set(d.groupId, 0);
      members.set(d.groupId, members.get(d.groupId) + 1);
    });
  const colors = new Map();
  let i = 0;
  members.forEach((count, id) => {
    colors.set(id, count >= 2 ? DESK_COLORS[i++ % DESK_COLORS.length] : LONE_DESK_COLOR);
  });
  return colors;
}

// ── Blackboard ───────────────────────────────────────────
export function defaultBlackboardInset() {
  return { before: CTRL_SIZE + BB_MARGIN, after: BB_MARGIN };
}

/**
 * Length of the track the board is measured against.
 *
 * `inset.before` is measured from the edge of #classroom, which on screen
 * starts CTRL_SIZE earlier than the desk grid because the row/column controls
 * sit there. The track therefore has to include that strip — leaving it out is
 * what made the board CTRL_SIZE too narrow, giving it 40px of air on one side
 * and 12px on the other despite BB_MARGIN promising an equal margin.
 */
export function blackboardTrackLength() {
  const pos  = state.blackboardPosition || 'top';
  const t    = tracks();
  const grid = (pos === 'top' || pos === 'bottom') ? t.cols.length : t.rows.length;
  return CTRL_SIZE + grid;
}

/** Resizes/positions the board. Cheap enough to call on every drag frame —
 *  it deliberately does not rebuild the drag handles. */
export function syncBlackboard() {
  const bb    = $('blackboard');
  const cls   = $('classroom');
  const pos   = state.blackboardPosition || 'top';
  const inset = state.blackboardInset ?? defaultBlackboardInset();

  cls.classList.remove('bb-top', 'bb-bottom', 'bb-left', 'bb-right');
  cls.classList.add('bb-' + pos);

  const isHoriz = pos === 'top' || pos === 'bottom';
  const size    = Math.max(MIN_BB_SIZE, blackboardTrackLength() - inset.before - inset.after);

  // The row/column controls are hidden when printing, which pulls the desk grid
  // CTRL_SIZE closer to the edge. --ctrl-shift (0 on screen, -CTRL_SIZE in
  // print, set in styles.css) moves the board by the same amount so it stays
  // aligned with the desks on paper.
  const before = `calc(${inset.before}px + var(--ctrl-shift, 0px))`;

  if (isHoriz) {
    Object.assign(bb.style, {
      width: size + 'px', height: '',
      marginLeft: before, marginRight: inset.after + 'px',
      marginTop: '', marginBottom: ''
    });
  } else {
    Object.assign(bb.style, {
      height: size + 'px', width: '',
      marginTop: before, marginBottom: inset.after + 'px',
      marginLeft: '', marginRight: ''
    });
  }
}

/** Creates the resize handles and reset button once. Previously these were
 *  torn down and rebuilt on every mousemove of a board drag. */
export function ensureBlackboardHandles() {
  const bb = $('blackboard');
  if (bb.querySelector('.bb-handle')) return;

  const before = document.createElement('div');
  before.className    = 'bb-handle bb-handle-before';
  before.dataset.edge = 'before';

  const after = document.createElement('div');
  after.className    = 'bb-handle bb-handle-after';
  after.dataset.edge = 'after';

  const reset = document.createElement('button');
  reset.id            = 'bb-reset';
  reset.title         = 'Tilbakestill tavle';
  reset.textContent   = '↺';
  reset.dataset.action = 'reset-blackboard';

  bb.append(before, after, reset);
}

// ── Desks ────────────────────────────────────────────────
export function createDeskElement(desk, t = tracks(), colors = deskGroupColors(), ctx = deskContext()) {
  const el      = document.createElement('div');
  const isEmpty = !desk.studentName;

  let cls = 'desk';
  if (isEmpty && !desk.marked)  cls += ' desk-empty';
  if (desk.locked)              cls += ' desk-locked';
  if (desk.marked && isEmpty)   cls += ' desk-marked';
  if (desk.size === 2)          cls += ' desk-wide';

  if (!isEmpty && !ctx.inList.has(desk.studentName)) {
    cls += ' desk-stale';
    el.title = 'Ikke i elevlisten';
  } else if (!isEmpty && ctx.away.has(desk.studentName)) {
    cls += ' desk-absent';
    el.title = 'Borte i dag';
  }

  el.className      = cls;
  el.id             = 'desk-el-' + desk.id;
  el.draggable      = true;
  el.dataset.id     = desk.id;
  el.textContent    = desk.studentName || '';
  el.style.fontSize = deskFontSize(desk.studentName, desk);
  el.style.width    = deskPixelWidth(t, desk) + 'px';
  el.style.setProperty('--desk-color', colors.get(desk.groupId) || LONE_DESK_COLOR);

  const p = posOf(t, desk.col, desk.row);
  el.style.left = p.left + 'px';
  el.style.top  = p.top  + 'px';
  return el;
}

/** Who is on the list and who is away today — looked up once per render. */
function deskContext() {
  return {
    inList: new Set(state.students),
    away:   new Set(absentToday(state.groups, todayKey()))
  };
}

function createTeacherDeskElement(td, t) {
  const el       = document.createElement('div');
  el.className   = 'desk desk-teacher';
  el.id          = 'desk-el-teacher';
  el.draggable   = true;
  el.dataset.id  = 'teacher';
  el.textContent = 'LÆRER';

  const p = posOf(t, td.col, td.row);
  el.style.left = p.left + 'px';
  el.style.top  = p.top  + 'px';
  return el;
}

/** Re-applies font sizes without rebuilding the grid — used by the text-size
 *  slider, which fires continuously while dragging. */
export function refreshDeskFontSizes() {
  computeChartNamePx();
  state.desks.forEach(desk => {
    const el = $('desk-el-' + desk.id);
    if (!el) return;
    el.style.fontSize = deskFontSize(desk.studentName, desk);
    settleDeskFont(el);
  });
}

export function renderClassroom() {
  $('classroom-title').textContent = state.className;
  updatePrintHeader();
  syncBlackboard();
  ensureBlackboardHandles();

  const t         = tracks();
  const colors    = deskGroupColors();
  const ctx       = deskContext();
  const container = $('grid-container');
  container.textContent = '';
  container.style.width  = t.cols.length + 'px';
  container.style.height = t.rows.length + 'px';

  // 1 — grid cells. Walkway cells are narrow, but still drop targets: drop a
  // desk there and the row or column widens to take it.
  const frag = document.createDocumentFragment();
  for (let row = 1; row <= state.gridRows; row++) {
    for (let col = 1; col <= state.gridCols; col++) {
      const cell = document.createElement('div');
      cell.className   = 'grid-cell';
      cell.dataset.col = col;
      cell.dataset.row = row;
      const p = posOf(t, col, row);
      cell.style.left   = p.left + 'px';
      cell.style.top    = p.top  + 'px';
      cell.style.width  = t.cols.size[col] + 'px';
      cell.style.height = t.rows.size[row] + 'px';
      frag.appendChild(cell);
    }
  }
  container.appendChild(frag);

  // 2 — group backgrounds, 3 — desks, 4 — teacher desk
  computeChartNamePx();
  renderGroupBackgrounds(container, t);
  const deskEls = state.desks.map(desk => createDeskElement(desk, t, colors, ctx));
  deskEls.forEach(el => container.appendChild(el));
  if (state.teacherDesk) container.appendChild(createTeacherDeskElement(state.teacherDesk, t));

  renderRowColControls();
  renderStatsBanner();
  updatePrintScale();
  fitChartToScreen();
  // Only now are the desks laid out and measurable.
  deskEls.forEach(settleDeskFont);
  // A drag or a randomise can make or mend a broken rule.
  renderRuleList();
}

// ── Fit to screen ────────────────────────────────────────
// The chart shrinks (never grows) to fit the window, so the whole room is
// visible on a 1366×768 laptop with both panels open. «Vis for klassen»
// (present.js) lets it grow to fill a projector.

let fitObserver = null;

export function fitChartToScreen() {
  const cls     = $('classroom');
  const wrapper = $('classroom-wrapper');
  if (!cls || !wrapper) return;
  if (!document.body.classList.contains('mode-seating')) return;

  const presenting = document.body.classList.contains('presenting');
  cls.style.setProperty('--screen-zoom', '1');

  const wr = wrapper.getBoundingClientRect();
  const cr = cls.getBoundingClientRect();
  if (cr.width <= 0 || cr.height <= 0) return;

  const ws    = getComputedStyle(wrapper);
  const padX  = (parseFloat(ws.paddingLeft) || 0) + (parseFloat(ws.paddingRight) || 0);
  const padB  = parseFloat(ws.paddingBottom) || 0;
  // Space from the chart's top edge to the bottom of the wrapper's content box.
  const top   = cr.top - wr.top + wrapper.scrollTop;
  const availW = wrapper.clientWidth - padX;
  const availH = wrapper.clientHeight - top - padB;

  const max  = presenting ? MAX_PRESENT_ZOOM : 1;
  const min  = presenting ? 0.2 : MIN_SCREEN_ZOOM;
  const zoom = Math.max(min, Math.min(max, availW / cr.width, availH / cr.height));
  cls.style.setProperty('--screen-zoom', String(Math.floor(zoom * 1000) / 1000));
}

/** The current on-screen zoom, for code that turns mouse movement into chart pixels. */
export function screenZoom() {
  const z = parseFloat($('classroom')?.style.getPropertyValue('--screen-zoom'));
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Refits whenever the space around the chart changes: window resize, a side
 *  panel folding away, a warning appearing above the chart. */
export function initChartFit() {
  if (fitObserver || typeof ResizeObserver === 'undefined') return;
  let queued = false;
  fitObserver = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitChartToScreen(); });
  });
  fitObserver.observe($('classroom-wrapper'));
}

/**
 * Puts the chart in its natural size and print look for an image export
 * (html2canvas understands neither CSS zoom nor our screen-only states).
 * Returns a function that restores the screen view.
 */
export function prepareChartForExport() {
  const cls = $('classroom');
  cls.style.setProperty('--screen-zoom', '1');
  cls.classList.add('exporting');
  return () => {
    cls.classList.remove('exporting');
    fitChartToScreen();
  };
}

// ── Full render ──────────────────────────────────────────
export function renderAll() {
  syncModeUI();
  renderClassBar();
  $('students-textarea').value = state.students.join('\n');
  syncDupWarning();
  $('desk-count').value = state.deskCount;
  $('group-size').value = state.groupSize;
  updateGridDisplay();
  $('blackboard-position').value = state.blackboardPosition || 'top';
  $('btn-teacher-desk').textContent =
    state.teacherDesk ? 'Fjern lærerpult' : 'Legg til lærerpult';

  const pct = Math.round((state.textScale || 1) * 100);
  $('text-scale').value          = pct;
  $('text-scale-val').textContent = pct + '%';

  $('print-format').value       = state.printFormat || 'A4';
  $('print-orientation').value  = state.printOrientation || 'landscape';
  $('hide-empty-desks').checked = !!state.hideEmptyDesksOnPrint;
  $('scale-to-fit').checked     = state.scaleToFitOnPrint !== false;
  updatePrintPageStyle();

  updateStudentCount();
  updateDatalist();
  renderClassroom();
  renderMismatchWarning();
  renderRuleList();
  renderGroupsAll();
  renderActivitiesAll();
  initChartFit();
}
