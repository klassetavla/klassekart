'use strict';

import { LS_MAP, LS_LIST, LS_LAST, MAX_IMPORT_BYTES } from './constants.js?v=28';
import { state } from './state.js?v=28';
import { showToast } from './toast.js?v=28';
import { prepareChartForExport } from './render.js?v=28';
import { LS_PREFIX, importClass, resetAfterWipe } from './classes.js?v=28';

// Files and wiping. Saving and loading classes lives in classes.js.

const $ = id => document.getElementById(id);

/** Filename-safe version of a class name. */
export function safeName(name) {
  return (name || 'Uten navn').replace(/[^\w æøåÆØÅ-]/g, '').trim() || 'Uten navn';
}

export function clearAllData() {
  if (!confirm('Dette sletter alle klassene dine (elevlister, regler, kart og grupper) fra denne nettleseren permanent.\nEr du sikker?')) return;
  let doomed = [];
  try {
    doomed = Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX) || k.startsWith(LS_MAP) || k.startsWith(LS_LIST) || k === LS_LAST);
    doomed.forEach(k => localStorage.removeItem(k));
  } catch { /* storage blocked — nothing stored either */ }
  // The names are still in memory and would be written straight back on the
  // next autosave. Clear the screen too, so «slettet» really means deleted.
  resetAfterWipe();
  showToast('All lokal data er slettet fra nettleseren');
}

// ── JSON file export / import ────────────────────────────
// The file is the class's state — the same shape older versions exported, so
// files go both ways between old and new versions.
export function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = safeName(state.className) + '.json';
  a.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showToast('Klassen er lastet ned som fil — åpne den med «Hent klasse fra fil» på en annen PC');
}

export function importJSON(file) {
  if (file.size > MAX_IMPORT_BYTES) { showToast('Filen er for stor til å være en klasse'); return; }
  const reader = new FileReader();
  reader.onerror = () => showToast('Kunne ikke lese filen');
  reader.onload = e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      showToast('Filen er ikke en klasse fra Klassetavla');
      return;
    }
    // Imported files are shared between machines and hand-editable, so they
    // go through the same clamping as everything else (in importClass).
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.desks)) {
      showToast('Filen er ikke en klasse fra Klassetavla');
      return;
    }
    importClass(parsed, file.name || '');
  };
  reader.readAsText(file);
}

// ── PNG export ───────────────────────────────────────────
export async function exportPNG() {
  if (typeof html2canvas === 'undefined') {
    showToast('Bildebiblioteket er ikke lastet — sjekk nettforbindelsen');
    return;
  }
  showToast('Genererer bilde...');

  // Hide editing affordances that shouldn't appear in the exported image.
  const overrides = document.createElement('style');
  overrides.textContent = `
    .desk-locked::after { display: none !important; }
    #row-controls, #col-controls { display: none !important; }
    .bb-handle, #bb-reset, .sidebar-tab { display: none !important; }
    ${state.hideEmptyDesksOnPrint ? '.desk-empty { visibility: hidden !important; }' : ''}
  `;
  document.head.appendChild(overrides);
  // Full size, no on-screen zoom, no empty grid cells — as on paper.
  const restore = prepareChartForExport();

  try {
    const canvas = await html2canvas($('classroom'), {
      backgroundColor: '#ffffff',
      scale:           2,
      logging:         false,
      useCORS:         true
    });
    const a    = document.createElement('a');
    a.download = safeName(state.className) + '.png';
    a.href     = canvas.toDataURL('image/png');
    a.click();
  } catch {
    showToast('Kunne ikke eksportere bilde');
  } finally {
    restore();
    overrides.remove();
  }
}
