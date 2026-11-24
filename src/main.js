'use strict';

import {
  MAX_GRID, MAX_DESK_COUNT, MAX_DESKS, MAX_NAME_LENGTH, MIN_TEXT_SCALE, MAX_TEXT_SCALE, MAX_RULES
} from './constants.js';
import {
  state, pushUndo, getMoveMode, renameStudentRefs, dropRemovedStudents, hasRemovedStudents,
  createInitialState
} from './state.js';
import { computeAutoLayout } from './layout.js';
import {
  renderAll, renderClassroom, renderMismatchWarning, updateGridDisplay,
  updatePrintPageStyle, updatePrintHeader, updateStudentCount, updateDatalist,
  refreshDeskFontSizes, renderRuleList, syncDupWarning, updatePrintScale
} from './render.js';
import { rebuildDesks, toggleTeacherDesk, nudgeGrid, exitMoveMode } from './desks.js';
import { randomizeSeating } from './randomize.js';
import { initGroups, renderGroupsAll } from './groups-view.js';
import { initActivities, renderActivitiesAll } from './activities-view.js';
import { initDragAndDrop, initBlackboardResize } from './dnd.js';
import { clearAllData, exportJSON, importJSON, exportPNG } from './storage.js';
import { initClasses } from './classes.js';
import { initBridges } from './bridges.js';
import { initUI, undo, pasteFromClipboard, hideContextMenu } from './ui.js';
import { showToast, hideToast } from './toast.js';
import { initPresentMode } from './present.js';

const $ = id => document.getElementById(id);

// ── Randomize ────────────────────────────────────────────
function handleRandomize() {
  if (syncDupWarning().length > 0) {
    showToast('Fjern duplikatnavn først');
    return;
  }
  pushUndo();

  // The first randomisation also picks a sensible grid; later ones respect
  // whatever layout the teacher has arranged by hand.
  if (!state.hasRandomized) {
    // One desk per student — 25 students and the default 24 desks used to
    // leave someone standing after the very first draw, and 3 students got 24.
    // A desk count the teacher typed in themselves is only ever raised.
    const size   = Math.max(1, state.groupSize);
    const needed = Math.ceil(state.students.length / size) * size;
    const untouched = state.deskCount === createInitialState().deskCount;
    if (needed > 0 && (needed > state.deskCount || untouched)) {
      state.deskCount = Math.min(MAX_DESK_COUNT, needed);
      $('desk-count').value = state.deskCount;
    }
    const auto = computeAutoLayout(state.deskCount, state.groupSize);
    state.gridCols = Math.min(MAX_GRID, auto.gridCols);
    state.gridRows = Math.min(MAX_GRID, auto.gridRows);
    updateGridDisplay();
    rebuildDesks(false);
    state.hasRandomized = true;
  }

  const { violations } = randomizeSeating();
  renderClassroom();
  renderMismatchWarning();

  // No count: the screen may be on the projector. Which rules broke is shown
  // in the (closed) rules panel.
  showToast(violations > 0
    ? 'Randomisert — ikke alle regler kunne oppfylles'
    : 'Pulter randomisert!');
}

// ── Rules ────────────────────────────────────────────────
function addRule(type) {
  const a = $('rule-a').value.trim();
  const b = $('rule-b').value.trim();
  if (!a || !b) { showToast('Skriv inn to elevnavn'); return; }
  if (a === b)  { showToast('Navnene må være forskjellige'); return; }

  // One rule per pair: adding the opposite type changes the existing rule
  // rather than leaving two contradicting ones behind.
  const existing = state.rules.find(r => (r.a === a && r.b === b) || (r.a === b && r.b === a));
  if (existing?.type === type) { showToast('Denne regelen finnes allerede'); return; }
  if (!existing && state.rules.length >= MAX_RULES) { showToast(`Maks ${MAX_RULES} regler`); return; }

  if (existing) existing.type = type;
  else state.rules.push({ a, b, type });

  $('rule-a').value = '';
  $('rule-b').value = '';
  $('rule-a').focus();
  renderRuleList();
  renderGroupsAll();
  renderActivitiesAll();
  showToast(existing
    ? `Regelen er endret til «${type === 'together' ? 'sammen' : 'ikke sammen'}»`
    : 'Regel lagt til');
}

// ── Student textarea ─────────────────────────────────────
function handleStudentInput(e) {
  const newNames = e.target.value.split('\n').map(s => s.trim().slice(0, MAX_NAME_LENGTH)).filter(Boolean);
  syncDupWarning();

  // If exactly one name was swapped for another, treat it as a rename and
  // follow it to whichever desk the student is sitting at.
  const removed = state.students.filter(n => !newNames.includes(n));
  const added   = newNames.filter(n => !state.students.includes(n));
  if (removed.length === 1 && added.length === 1) {
    const [oldName, newName] = [removed[0], added[0]];
    renameStudentRefs(oldName, newName);
    state.desks.forEach(d => {
      if (d.studentName === oldName) d.studentName = newName;
    });
  }

  state.students = [...new Set(newNames)].slice(0, MAX_DESKS);
  updateStudentCount();
  updateDatalist();
  // Re-drawn so desks of students who were just deleted show as «ikke i
  // elevlisten» while the teacher is still typing.
  renderClassroom();
  renderMismatchWarning();
  renderRuleList();
  renderGroupsAll();
  renderActivitiesAll();
}

/**
 * Once the teacher is done editing the list (the textarea loses focus), anyone
 * no longer on it leaves the chart, the groups and the teams. Not on every
 * keystroke — deleting a name to retype it must not cost the student their seat.
 */
function settleStudentList() {
  if (!hasRemovedStudents()) return;
  pushUndo({ all: true });
  const desks = dropRemovedStudents();
  renderClassroom();
  renderMismatchWarning();
  renderRuleList();
  renderGroupsAll();
  renderActivitiesAll();
  if (desks > 0) {
    showToast(`${desks === 1 ? 'Én elev' : desks + ' elever'} som ikke lenger er i listen er tatt bort fra kartet (Angre: Ctrl+Z)`);
  }
}

// ── Event wiring ─────────────────────────────────────────
function setupEventListeners() {
  document.querySelectorAll('[data-mode-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (state.mode === tab.dataset.modeTab) return;
      if (getMoveMode()) exitMoveMode();
      hideContextMenu();
      hideToast();
      state.mode = tab.dataset.modeTab;
      renderAll();
    });
  });

  $('students-textarea').addEventListener('input', handleStudentInput);
  $('students-textarea').addEventListener('change', settleStudentList);

  $('desk-count').addEventListener('change', e => {
    state.deskCount = Math.max(1, Math.min(MAX_DESK_COUNT, +e.target.value || 1));
    e.target.value  = state.deskCount;
    rebuildDesks(true);
    renderAll();
  });

  $('group-size').addEventListener('change', e => {
    state.groupSize = +e.target.value;
    rebuildDesks(true);
    renderAll();
  });

  $('grid-cols-dec').addEventListener('click', () => nudgeGrid('gridCols', -1));
  $('grid-cols-inc').addEventListener('click', () => nudgeGrid('gridCols', +1));
  $('grid-rows-dec').addEventListener('click', () => nudgeGrid('gridRows', -1));
  $('grid-rows-inc').addEventListener('click', () => nudgeGrid('gridRows', +1));

  $('blackboard-position').addEventListener('change', e => {
    state.blackboardPosition = e.target.value;
    state.blackboardInset    = null;
    renderClassroom();
  });

  $('btn-teacher-desk').addEventListener('click', toggleTeacherDesk);
  $('btn-randomize').addEventListener('click', handleRandomize);
  $('btn-paste-students').addEventListener('click', pasteFromClipboard);

  $('btn-clear-data').addEventListener('click', clearAllData);

  // Rules
  $('rules-info').addEventListener('click', e => {
    // The button sits inside <summary>; without this the click also opens the
    // rules, which is exactly what must not happen in front of the class.
    e.preventDefault();
    const tip = $('rules-tip');
    tip.hidden = !tip.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!tip.hidden));
  });
  $('btn-add-apart').addEventListener('click', () => addRule('apart'));
  $('btn-add-together').addEventListener('click', () => addRule('together'));
  $('use-rules').addEventListener('change', e => {
    const field = { groups: 'useRulesGroups', activities: 'useRulesActivities' }[state.mode]
      || 'useRulesSeating';
    state[field] = e.target.checked;
    renderRuleList();
    renderGroupsAll();
  });

  // Print / export / import
  $('btn-print').addEventListener('click', () => window.print());
  document.addEventListener('klassetavla:export', exportJSON);
  $('btn-export-png').addEventListener('click', exportPNG);
  $('import-file').addEventListener('change', e => {
    if (e.target.files.length > 0) {
      importJSON(e.target.files[0]);
      e.target.value = '';
    }
  });

  // Text size — fires continuously while dragging, so only the font sizes are
  // touched rather than rebuilding the whole grid on every tick.
  $('text-scale').addEventListener('input', e => {
    const pct = +e.target.value;
    state.textScale = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, pct / 100));
    $('text-scale-val').textContent = pct + '%';
    refreshDeskFontSizes();
  });

  // Print settings
  $('print-format').addEventListener('change', e => {
    state.printFormat = e.target.value;
    updatePrintPageStyle();
  });
  $('print-orientation').addEventListener('change', e => {
    state.printOrientation = e.target.value;
    updatePrintPageStyle();
  });
  $('hide-empty-desks').addEventListener('change', e => {
    state.hideEmptyDesksOnPrint = e.target.checked;
    updatePrintPageStyle();
  });
  $('scale-to-fit').addEventListener('change', e => {
    state.scaleToFitOnPrint = e.target.checked;
    updatePrintScale();
  });

  // Last chance to get the zoom right — by now the print layout is settled, so
  // the header can be measured for real instead of falling back to a constant.
  window.addEventListener('beforeprint', updatePrintScale);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (getMoveMode()) exitMoveMode();
      hideContextMenu();
    }
    const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      undo();
    }
  });
}

// ── Init ─────────────────────────────────────────────────
function initApp() {
  // Loads the current class (bringing older saved data over the first time)
  // and starts the autosave.
  initClasses();

  setupEventListeners();
  initUI();
  initGroups();
  initActivities();
  initBridges();
  initDragAndDrop();
  initBlackboardResize();
  initPresentMode();
  renderAll();
}

document.addEventListener('DOMContentLoaded', initApp);
