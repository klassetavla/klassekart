'use strict';

import { LS_MAP, LS_LIST, LS_LAST, MAX_DESKS, MAX_NAME_LENGTH } from './constants.js?v=28';
import {
  state, replaceState, sanitizeState, createInitialState, clearUndo, setMoveMode
} from './state.js?v=28';
import { renderAll, renderClassroom, updatePrintHeader } from './render.js?v=28';
import { rebuildDesks } from './desks.js?v=28';
import { showToast } from './toast.js?v=28';
import { hideContextMenu } from './ui.js?v=28';

// ── Klasser ──────────────────────────────────────────────
// A class is the one thing the teacher saves: names, rules, seating chart,
// groups, absence and game settings all belong to it, and every change is
// written to localStorage on its own a moment later. There is no «Lagre».
//
// Storage layout:
//   klassetavla_index          {version, current, mode, classes: [{id, name, count, updated}]}
//   klassetavla_klasse_<id>    the class's state (same shape as an exported JSON file)
//
// Older versions kept a «last session» (klassekart_last), named seating charts
// (klassekart_<navn>) and bare name lists (kl_liste_<navn>). Those are turned
// into classes the first time this version runs, and are left in place
// untouched as a fallback — «Slett all lokal data» removes them too.

const LS_INDEX = 'klassetavla_index';
const LS_CLASS = 'klassetavla_klasse_';
export const LS_PREFIX = 'klassetavla_';
const SAVE_EVERY_MS = 700;
const ID_RE = /^k[a-z0-9]{4,40}$/;
const VALID_MODES = new Set(['seating', 'groups', 'activities']);

const $ = id => document.getElementById(id);

let currentId  = null;
let lastSaved  = null;  // what is stored for currentId, as serialised by serialize()
let saveFailed = false;
// True when the old data could not be brought over (storage full). Nothing is
// written then — not even the index — so the migration runs again next time
// instead of being marked done with classes missing.
let migrationPending = false;

// ── Helpers ──────────────────────────────────────────────
export function displayName(name) {
  return (name || '').trim() || 'Uten navn';
}

function newId() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The class as stored. The tab being shown is not part of the class. */
function serialize(s = state) {
  return JSON.stringify({ ...s, mode: undefined });
}

const collator = new Intl.Collator('no', { numeric: true, sensitivity: 'base' });

function readIndex() {
  try {
    const raw = localStorage.getItem(LS_INDEX);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || !Array.isArray(p.classes)) return null;
    const seen = new Set();
    return {
      version: 1,
      current: typeof p.current === 'string' ? p.current : null,
      mode:    VALID_MODES.has(p.mode) ? p.mode : 'seating',
      classes: p.classes
        .filter(c => c && typeof c.id === 'string' && ID_RE.test(c.id) && !seen.has(c.id) && seen.add(c.id))
        .map(c => ({
          id:      c.id,
          name:    typeof c.name === 'string' ? c.name.slice(0, 100) : '',
          count:   Number.isFinite(c.count) ? c.count : 0,
          updated: Number.isFinite(c.updated) ? c.updated : 0
        }))
    };
  } catch {
    return null;
  }
}

function writeIndex(idx) {
  localStorage.setItem(LS_INDEX, JSON.stringify(idx));
}

/** Read–modify–write, so a second tab's new classes aren't thrown away. */
function updateIndex(fn) {
  const idx = readIndex() || { version: 1, current: null, mode: 'seating', classes: [] };
  fn(idx);
  writeIndex(idx);
  return idx;
}

function upsertEntry(idx, id, s) {
  const entry = { id, name: s.className || '', count: s.students.length, updated: Date.now() };
  const i = idx.classes.findIndex(c => c.id === id);
  if (i === -1) idx.classes.push(entry);
  else idx.classes[i] = entry;
}

/** Turns stored JSON into a usable state; null if it isn't a class. */
function parseClass(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return toState(parsed);
  } catch {
    return null;
  }
}

/** sanitizeState plus a desk layout for classes that never had one (a bare
 *  name list, or a class that was created and not touched yet). */
function toState(parsed) {
  const s = sanitizeState(parsed);
  if (!Array.isArray(parsed.desks) || parsed.desks.length === 0) {
    s.desks = [];
  }
  return s;
}

/** Installs `s` as the current state and makes sure it has desks. */
function install(s) {
  const mode = state.mode;
  replaceState(s);
  state.mode = mode;
  if (state.desks.length === 0) {
    state.hasRandomized = false;
    rebuildDesks(false);
  }
  clearUndo();
  setMoveMode(null);
  hideContextMenu();
}

// ── Saving ───────────────────────────────────────────────
function setStatus(kind) {
  const el = $('save-status');
  if (!el) return;
  el.classList.toggle('save-error', kind === 'error');
  if (kind === 'error') {
    el.textContent = '⚠ Ikke lagret';
    el.title = 'Nettleseren nektet å lagre — lagringsplassen kan være full, eller nettleseren er i privat modus.';
  } else {
    el.textContent = 'Lagret ✓';
    el.title = 'Alt lagres automatisk i denne nettleseren';
    if (kind === 'saved') {
      el.classList.remove('save-flash');
      void el.offsetWidth; // restart the animation
      el.classList.add('save-flash');
    }
  }
}

/** Writes the current class if anything changed since the last write.
 *  Returns false when there are changes that could not be stored. */
export function saveNow() {
  if (!currentId) return true;
  const json = serialize();
  if (json === lastSaved) {
    if (!migrationPending) rememberMode();
    return true;
  }
  if (migrationPending) {
    setStatus('error');
    return false;
  }
  try {
    localStorage.setItem(LS_CLASS + currentId, json);
    updateIndex(idx => {
      upsertEntry(idx, currentId, state);
      idx.current = currentId;
      idx.mode    = state.mode;
    });
    lastSaved = json;
    if (saveFailed) showToast('Lagret igjen ✓');
    saveFailed = false;
    setStatus('saved');
    return true;
  } catch {
    if (!saveFailed) showToast('Kunne ikke lagre — nettleserens lagringsplass kan være full');
    saveFailed = true;
    setStatus('error');
    return false;
  }
}

/** Before leaving the class on screen: true when it is safe to go. If the
 *  class can't be stored, the teacher decides — with a way to keep it. */
function canLeaveClass() {
  if (saveNow()) return true;
  return confirm(
    'Endringene i denne klassen kunne ikke lagres (lagringsplassen i nettleseren er full).\n\n' +
    'Velg Avbryt, og bruk «Last ned klassen som fil» i klassemenyen for å ta vare på dem.\n' +
    'Velg OK for å fortsette uten å lagre.'
  );
}

function rememberMode() {
  try {
    const idx = readIndex();
    if (idx && idx.mode !== state.mode) { idx.mode = state.mode; writeIndex(idx); }
  } catch { /* not worth bothering the teacher about */ }
}

// ── Switching ────────────────────────────────────────────
/** Starts an empty class. It is not written until something is typed into it,
 *  so opening the page (or wiping it on a shared PC) leaves nothing behind. */
function startBlank() {
  install(createInitialState());
  currentId = newId();
  lastSaved = serialize();
}

export function switchClass(id) {
  if (id === currentId) return;
  if (!canLeaveClass()) return;
  const s = parseClass(localStorage.getItem(LS_CLASS + id));
  if (!s) {
    showToast('Fant ikke klassen');
    updateIndex(idx => { idx.classes = idx.classes.filter(c => c.id !== id); });
    renderClassMenu();
    return;
  }
  install(s);
  currentId = id;
  lastSaved = serialize();
  updateIndex(idx => { idx.current = id; });
  renderAll();
  showToast(`Byttet til ${displayName(state.className)}`);
}

export function newClass() {
  if (!canLeaveClass()) return;
  startBlank();
  renderAll();
  startRename();
}

function duplicateClass() {
  if (!canLeaveClass()) return;
  const copy = structuredClone(state);
  copy.className = displayName(state.className) + ' (kopi)';
  install(copy);
  currentId = newId();
  lastSaved = null;
  saveNow();
  renderAll();
  showToast(`Laget kopi: ${state.className}`);
}

function deleteClass() {
  const name = displayName(state.className);
  if (!confirm(`Slette klassen «${name}»?\n\nElevlisten, reglene, klassekartet og gruppene forsvinner, og det kan ikke angres.`)) return;
  try { localStorage.removeItem(LS_CLASS + currentId); } catch { /* ignore */ }
  const idx = updateIndex(i => { i.classes = i.classes.filter(c => c.id !== currentId); });
  const next = [...idx.classes].sort((a, b) => b.updated - a.updated)[0];
  currentId = null;
  const s = next && parseClass(localStorage.getItem(LS_CLASS + next.id));
  if (s) {
    install(s);
    currentId = next.id;
    lastSaved = serialize();
    updateIndex(i => { i.current = next.id; });
  } else {
    startBlank();
  }
  renderAll();
  showToast(`«${name}» er slettet`);
}

/** A class read from an exported file becomes a new class of its own — it
 *  never overwrites the one on screen. */
export function importClass(parsed, fileName = '') {
  const s = toState(parsed);
  const base = (s.className || fileName.replace(/\.json$/i, '')).trim().slice(0, 100);
  const taken = new Set(listClasses().map(c => displayName(c.name).toLowerCase()));
  s.className = taken.has(displayName(base).toLowerCase()) ? `${displayName(base)} (importert)` : base;
  if (!canLeaveClass()) return;
  install(s);
  currentId = newId();
  lastSaved = null;
  saveNow();
  renderAll();
  showToast(`Hentet «${displayName(state.className)}» fra fil`);
}

/** After «Slett all lokal data». */
export function resetAfterWipe() {
  migrationPending = false;
  startBlank();
  renderAll();
}

export function listClasses() {
  const idx = readIndex();
  const list = idx ? [...idx.classes] : [];
  // The class on screen is listed even before its first save.
  if (currentId && !list.some(c => c.id === currentId)) {
    list.push({ id: currentId, name: state.className, count: state.students.length, updated: Date.now() });
  }
  const cur = list.find(c => c.id === currentId);
  if (cur) { cur.name = state.className; cur.count = state.students.length; }
  return list.sort((a, b) => collator.compare(displayName(a.name), displayName(b.name)));
}

// ── Migration from the old storage ──────────────────────
function sameStudents(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(n => set.has(n));
}

function canonical(s) {
  return serialize({ ...s, hasRandomized: true });
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

/**
 * Builds classes from klassekart_last, klassekart_<navn> and kl_liste_<navn>.
 * Returns {current, mode} or null when there was nothing to bring over.
 * Never deletes or changes the old keys.
 */
function migrateLegacy() {
  let keys;
  try { keys = Object.keys(localStorage); } catch { return null; }
  const found = [];  // {state, isSession}
  let mode = 'seating';

  // Saved charts
  keys.filter(k => k.startsWith(LS_MAP) && k !== LS_LAST).sort().forEach(k => {
    const parsed = readJSON(k);
    if (!parsed || !Array.isArray(parsed.desks)) return;
    const s = toState(parsed);
    if (!s.className.trim()) s.className = k.slice(LS_MAP.length);
    found.push({ state: s, isSession: false });
  });

  // Last session — the teacher's most recent work, so it becomes the current class.
  let sessionEntry = null;
  const last = readJSON(LS_LAST);
  if (last && typeof last === 'object' && Array.isArray(last.desks)) {
    if (VALID_MODES.has(last.mode)) mode = last.mode;
    const s = toState(last);
    const hasContent = s.students.length > 0 || s.desks.some(d => d.studentName) || s.rules.length > 0;
    if (hasContent) {
      const twin = found.find(f => canonical(f.state) === canonical(s));
      if (twin) {
        twin.isSession = true;               // saved and unchanged since — one class
        sessionEntry = twin;
      } else {
        // Same name as a saved chart but different content: keep both, and
        // tell them apart by name rather than guessing which one is wanted.
        const name = displayName(s.className);
        found.forEach(f => {
          if (displayName(f.state.className).toLowerCase() === name.toLowerCase()) {
            f.state.className = `${displayName(f.state.className)} (lagret kart)`;
          }
        });
        if (!s.className.trim()) s.className = 'Min klasse';
        sessionEntry = { state: s, isSession: true };
        found.push(sessionEntry);
      }
    }
  }

  // Bare name lists — only those that aren't already a class with the same pupils.
  keys.filter(k => k.startsWith(LS_LIST)).sort().forEach(k => {
    const parsed = readJSON(k);
    if (!Array.isArray(parsed)) return;
    const students = [...new Set(
      parsed.filter(n => typeof n === 'string').map(n => n.trim().slice(0, MAX_NAME_LENGTH)).filter(Boolean)
    )].slice(0, MAX_DESKS);
    if (students.length === 0) return;
    if (found.some(f => sameStudents(f.state.students, students))) return;
    const listName = k.slice(LS_LIST.length).trim();
    const s = createInitialState();
    s.students  = students;
    s.className = found.some(f => displayName(f.state.className).toLowerCase() === displayName(listName).toLowerCase())
      ? `${displayName(listName)} (elevliste)`
      : listName;
    found.push({ state: s, isSession: false });
  });

  if (found.length === 0) return null;

  const idx = { version: 1, current: null, mode, classes: [] };
  const writes = found.map(f => ({ id: newId() + Math.random().toString(36).slice(2, 4), ...f }));
  // Everything is written before the index, so a full disk leaves the old data
  // in charge and the migration simply runs again next time. What did get
  // written is removed again, so retries don't pile up copies.
  try {
    writes.forEach(w => {
      localStorage.setItem(LS_CLASS + w.id, serialize(w.state));
      upsertEntry(idx, w.id, w.state);
    });
    idx.current = (writes.find(w => w.isSession) ||
                   [...writes].sort((a, b) => collator.compare(displayName(a.state.className), displayName(b.state.className)))[0]).id;
    writeIndex(idx);
  } catch (err) {
    writes.forEach(w => { try { localStorage.removeItem(LS_CLASS + w.id); } catch { /* ignore */ } });
    try { localStorage.removeItem(LS_INDEX); } catch { /* ignore */ }
    throw err;
  }
  return { current: idx.current, mode };
}

// ── Start-up ─────────────────────────────────────────────
export function initClasses() {
  let idx = readIndex();
  if (!idx) {
    try {
      if (migrateLegacy()) idx = readIndex();
    } catch {
      // Storage full or blocked: show the old last session so the teacher can
      // keep working, but write nothing until the migration has succeeded.
      migrationPending = true;
      const last = readJSON(LS_LAST);
      if (last && Array.isArray(last.desks)) {
        install(toState(last));
        currentId = newId();
        lastSaved = serialize();
      }
    }
  }

  if (idx && !currentId) {
    const order = [
      idx.classes.find(c => c.id === idx.current),
      ...[...idx.classes].sort((a, b) => b.updated - a.updated)
    ].filter(Boolean);
    for (const entry of order) {
      const s = parseClass(localStorage.getItem(LS_CLASS + entry.id));
      if (s) {
        install(s);
        currentId = entry.id;
        lastSaved = serialize();
        break;
      }
    }
    state.mode = idx.mode;
  }
  if (!currentId) startBlank();
  if (migrationPending) {
    setStatus('error');
    setTimeout(() => showToast('Nettleserens lagringsplass er full — endringer lagres ikke før det er ryddet plass'), 800);
  }

  setInterval(saveNow, SAVE_EVERY_MS);
  // pagehide fires reliably on tab close, where beforeunload is often ignored.
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  // Another tab saved this class. Take its version — unless there are edits
  // here that haven't been written yet, in which case ours win on the next tick.
  window.addEventListener('storage', e => {
    if (!currentId || migrationPending) return;
    // «Slett all lokal data» in another tab.
    if (e.key === null) {
      if (!readIndex()) resetAfterWipe();
      return;
    }
    if (e.key !== LS_CLASS + currentId) return;
    if (serialize() !== lastSaved) return;
    if (e.newValue === null) {
      // The class was deleted in another tab: don't bring it back.
      const idx  = readIndex();
      const next = idx && [...idx.classes].sort((a, b) => b.updated - a.updated)[0];
      const s    = next && parseClass(localStorage.getItem(LS_CLASS + next.id));
      if (s) {
        install(s);
        currentId = next.id;
        lastSaved = serialize();
      } else {
        startBlank();
      }
      renderAll();
      return;
    }
    const s = parseClass(e.newValue);
    if (!s) return;
    // Through install(), so this tab's undo steps — which belong to the
    // version it is replacing — can't be replayed over the other tab's work.
    install(s);
    lastSaved = serialize();
    renderAll();
  });

  initClassMenu();
}

// ── Class bar and menu ───────────────────────────────────
export function renderClassBar() {
  const name = $('class-switch-name');
  if (!name) return;
  name.textContent = displayName(state.className);
  name.classList.toggle('class-unnamed', !state.className.trim());
  const input = $('class-name');
  if (input && document.activeElement !== input) input.value = state.className;
}

function renderClassMenu() {
  const list = $('class-menu-list');
  list.textContent = '';
  listClasses().forEach(c => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'class-menu-item class-menu-class';
    btn.setAttribute('role', 'menuitemradio');
    const on = c.id === currentId;
    btn.setAttribute('aria-checked', String(on));
    btn.dataset.classId = c.id;
    const check = document.createElement('span');
    check.className = 'class-menu-check';
    check.textContent = on ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'class-menu-name';
    label.textContent = displayName(c.name);
    const count = document.createElement('span');
    count.className = 'class-menu-count';
    count.textContent = c.count ? `${c.count} elever` : '';
    btn.append(check, label, count);
    list.appendChild(btn);
  });
}

function openMenu() {
  renderClassMenu();
  $('class-menu').hidden = false;
  $('class-switch').setAttribute('aria-expanded', 'true');
  ($('class-menu').querySelector('[aria-checked="true"]') || $('class-menu').querySelector('button'))?.focus();
}

function closeMenu(focusSwitch = false) {
  if ($('class-menu').hidden) return;
  $('class-menu').hidden = true;
  $('class-switch').setAttribute('aria-expanded', 'false');
  if (focusSwitch) $('class-switch').focus();
}

let renameOriginal = '';
export function startRename() {
  closeMenu();
  const input = $('class-name');
  renameOriginal = state.className;
  input.value = state.className;
  $('class-switch').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function finishRename(keep) {
  const input = $('class-name');
  if (input.hidden) return;
  if (!keep) state.className = renameOriginal;
  else state.className = input.value.trim().slice(0, 100);
  input.hidden = true;
  $('class-switch').hidden = false;
  renderClassBar();
  $('classroom-title').textContent = state.className;
  updatePrintHeader();
  renderClassroom();
  saveNow();
}

function initClassMenu() {
  $('class-switch').addEventListener('click', e => {
    e.stopPropagation();
    if ($('class-menu').hidden) openMenu();
    else closeMenu();
  });

  $('class-menu').addEventListener('click', e => {
    e.stopPropagation();
    const cls = e.target.closest('[data-class-id]');
    if (cls) { closeMenu(); switchClass(cls.dataset.classId); return; }
    const action = e.target.closest('[data-class-action]')?.dataset.classAction;
    if (!action) return;
    closeMenu();
    switch (action) {
      case 'new':       newClass(); break;
      case 'rename':    startRename(); break;
      case 'duplicate': duplicateClass(); break;
      case 'export':    document.dispatchEvent(new CustomEvent('klassetavla:export')); break;
      case 'import':    $('import-file').click(); break;
      case 'delete':    deleteClass(); break;
    }
  });

  $('class-menu').addEventListener('keydown', e => {
    const items = [...$('class-menu').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === 'Escape')    { e.preventDefault(); closeMenu(true); }
    if (e.key === 'Tab')       closeMenu();
  });

  document.addEventListener('click', e => {
    if (!$('class-menu').hidden && !e.target.closest('.class-section')) closeMenu();
  });

  const input = $('class-name');
  // Live, so the board title follows the typing.
  input.addEventListener('input', () => {
    state.className = input.value.slice(0, 100);
    $('classroom-title').textContent = state.className;
    $('class-switch-name').textContent = displayName(state.className);
  });
  input.addEventListener('blur', () => finishRename(true));
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finishRename(false); $('class-switch').focus(); }
  });
}
