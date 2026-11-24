'use strict';

import { fitChartToScreen, initChartFit } from './render.js';

// «📺 Vis for klassen» for the seating chart: hides every menu and control and
// scales the chart up to fill the screen — the chart's counterpart to the
// group tool's tavlemodus. Editing is switched off while it shows; Esc, the ✕
// or leaving fullscreen brings the normal view back.

const $ = id => document.getElementById(id);

let closeBtn = null;
let enteredFullscreen = false;

function isPresenting() {
  return document.body.classList.contains('presenting');
}

function ensureCloseButton() {
  if (closeBtn) return closeBtn;
  closeBtn = document.createElement('button');
  closeBtn.type      = 'button';
  closeBtn.id        = 'present-close';
  closeBtn.className = 'present-close';
  closeBtn.textContent = '✕';
  closeBtn.title     = 'Lukk (Esc)';
  closeBtn.setAttribute('aria-label', 'Lukk visningen for klassen');
  closeBtn.hidden = true;
  closeBtn.addEventListener('click', exitPresent);
  document.body.appendChild(closeBtn);
  return closeBtn;
}

export function enterPresent() {
  if (isPresenting()) return;
  document.body.classList.add('presenting');
  ensureCloseButton().hidden = false;
  fitChartToScreen();

  enteredFullscreen = false;
  const root = document.documentElement;
  if (root.requestFullscreen && !document.fullscreenElement) {
    root.requestFullscreen()
      .then(() => { enteredFullscreen = true; })
      .catch(() => { /* not allowed here — the in-page view still works */ });
  }
  closeBtn.focus({ preventScroll: true });
}

export function exitPresent() {
  if (!isPresenting()) return;
  document.body.classList.remove('presenting');
  if (closeBtn) closeBtn.hidden = true;
  if (enteredFullscreen && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  enteredFullscreen = false;
  fitChartToScreen();
  $('btn-present')?.focus({ preventScroll: true });
}

export function initPresentMode() {
  initChartFit();
  ensureCloseButton();

  $('btn-present')?.addEventListener('click', enterPresent);

  // Capture phase, so Esc closes the view before anything else reacts to it.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isPresenting()) {
      e.preventDefault();
      e.stopPropagation();
      exitPresent();
    }
  }, true);

  // Leaving fullscreen with the browser's own Esc/F11 ends the view too —
  // otherwise the teacher is left in a menu-less page with no obvious way out.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && enteredFullscreen && isPresenting()) {
      enteredFullscreen = false;
      exitPresent();
    }
  });

  // Switching tool while presenting (it shouldn't be possible, but a keyboard
  // shortcut might) must not leave the other tabs without their menus.
  document.addEventListener('click', e => {
    if (isPresenting() && e.target.closest('[data-mode-tab]')) exitPresent();
  }, true);
}
