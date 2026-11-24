'use strict';

import { MAX_GROUP_HISTORY } from './constants.js';
import { state, pushUndo, deskCells } from './state.js';
import { todayKey, presentStudents, buildResult, pastGroupings } from './groups.js';
import { renderClassroom, renderMismatchWarning } from './render.js';
import { renderGroupsAll } from './groups-view.js';
import { showToast } from './toast.js';

// Bridges between the seating chart and the groups: make groups out of who
// sits together, or seat the drawn groups together.

const $ = id => document.getElementById(id);

const readingOrder = (a, b) => a.row - b.row || a.col - b.col;

/** Two desks touch when their footprints are side by side or front to back. */
function touches(a, b) {
  const cb = deskCells(b);
  return deskCells(a).some(([c1, r1]) => cb.some(([c2, r2]) => Math.abs(c1 - c2) + Math.abs(r1 - r2) === 1));
}

/**
 * The desk clusters on the chart: desks of the same table group that also
 * touch. A desk dragged away from its table forms a cluster of its own. In
 * reading order — front row first, left to right.
 */
export function deskClusters(desks = state.desks) {
  const byGroup = new Map();
  desks.forEach(d => {
    if (!byGroup.has(d.groupId)) byGroup.set(d.groupId, []);
    byGroup.get(d.groupId).push(d);
  });
  const clusters = [];
  byGroup.forEach(list => {
    const left = new Set(list);
    while (left.size > 0) {
      const start = left.values().next().value;
      left.delete(start);
      const comp  = [start];
      const queue = [start];
      while (queue.length > 0) {
        const a = queue.pop();
        for (const b of [...left]) {
          if (touches(a, b)) { left.delete(b); comp.push(b); queue.push(b); }
        }
      }
      clusters.push(comp.sort(readingOrder));
    }
  });
  return clusters.sort((a, b) => readingOrder(a[0], b[0]));
}

/** Who sits together at each table, leaving out absent students. */
function chartGroups() {
  const present = new Set(presentStudents(state.students, state.groups, todayKey()));
  return deskClusters()
    .map(c => c.map(d => d.studentName).filter(n => n && present.has(n)))
    .filter(names => names.length > 0);
}

function canUseChart() {
  return chartGroups().filter(names => names.length >= 2).length >= 2;
}

// ── Grupper ← klassekartet ───────────────────────────────
export function groupsFromChart() {
  const groups = chartGroups();
  if (groups.filter(n => n.length >= 2).length < 2) {
    showToast('Klassekartet har ingen bordgrupper å bruke ennå');
    return;
  }
  pushUndo();
  const g     = state.groups;
  const today = todayKey();
  g.history = pastGroupings(g, today, MAX_GROUP_HISTORY);
  g.result  = { ...buildResult(groups, g.roles, today), fromChart: true };
  renderGroupsAll();
  showToast(`${groups.length} grupper — slik elevene sitter i klassekartet`);
}

// ── Klassekartet ← grupper ───────────────────────────────
export function seatGroupsTogether() {
  const res = state.groups.result;
  if (!res) { showToast('Trekk grupper i Grupper-fanen først'); return; }

  const listed = new Set(state.students);
  // Students on a locked or «tom pult»-marked desk stay where they are.
  const fixedNames = new Set(state.desks.filter(d => d.locked || d.marked).map(d => d.studentName).filter(Boolean));
  const groups = res.groups
    .map(grp => grp.members.map(m => m.name).filter(n => listed.has(n) && !fixedNames.has(n)))
    .filter(names => names.length > 0);
  if (groups.length === 0) { showToast('Gruppene har ingen elever å plassere'); return; }

  pushUndo();
  const clusters = deskClusters()
    .map(c => c.filter(d => !d.locked && !d.marked))
    .filter(c => c.length > 0);
  clusters.flat().forEach(d => { d.studentName = null; });

  const freeIn = c => c.filter(d => !d.studentName);
  let split = 0;

  for (const names of groups) {
    // Best fit: the fullest table that still has room for the whole group.
    const whole = clusters
      .filter(c => freeIn(c).length >= names.length)
      .sort((a, b) => freeIn(a).length - freeIn(b).length)[0];
    if (whole) {
      freeIn(whole).forEach((d, i) => { if (i < names.length) d.studentName = names[i]; });
      continue;
    }
    // No table is big enough: spill over into the next tables in reading
    // order, so the group still ends up side by side.
    split++;
    let next = 0;
    for (const c of clusters) {
      for (const d of freeIn(c)) {
        if (next >= names.length) break;
        d.studentName = names[next++];
      }
      if (next >= names.length) break;
    }
  }

  // Everyone else on the list (not in any group, e.g. absent when the groups
  // were drawn) takes whatever desks are left.
  const seated = new Set(state.desks.map(d => d.studentName).filter(Boolean));
  const rest   = state.students.filter(n => !seated.has(n));
  const free   = clusters.flatMap(freeIn);
  rest.forEach((name, i) => { if (free[i]) free[i].studentName = name; });

  state.hasRandomized = true;
  renderClassroom();
  renderMismatchWarning();
  showToast(split > 0
    ? 'Gruppene sitter sammen — noen er delt over to bord fordi bordene er mindre enn gruppene'
    : 'Gruppene sitter sammen');
}

// ── Buttons ──────────────────────────────────────────────
/** Shows the bridge buttons only when they have something to work with. */
export function syncBridgeButtons() {
  const hasGroups = !!state.groups.result?.groups.some(grp => grp.members.length > 0);
  $('btn-seat-groups').hidden = !hasGroups;
  const fromChart = canUseChart();
  $('btn-groups-from-chart').hidden       = !fromChart;
  $('btn-groups-from-chart-empty').hidden = !fromChart;
}

export function initBridges() {
  $('btn-seat-groups').addEventListener('click', seatGroupsTogether);
  $('btn-groups-from-chart').addEventListener('click', groupsFromChart);
  $('btn-groups-from-chart-empty').addEventListener('click', groupsFromChart);
}
