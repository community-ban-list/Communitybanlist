// The site's colour mode: light, dark, or auto, which follows the device's setting. The chosen mode is
// saved in local storage; public/static/color-mode.js applies it before the page is drawn.

export const COLOR_MODE_KEY = 'colorMode';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function getColorMode() {
  try {
    const mode = localStorage.getItem(COLOR_MODE_KEY);
    if (mode === 'light' || mode === 'dark') return mode;
  } catch {}
  return 'auto';
}

function applyColorMode(mode) {
  const theme = mode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-bs-theme', theme);
}

export function setColorMode(mode) {
  try {
    if (mode === 'auto') localStorage.removeItem(COLOR_MODE_KEY);
    else localStorage.setItem(COLOR_MODE_KEY, mode);
  } catch {}
  applyColorMode(mode);
}

// In auto mode, follow the device when its setting changes.
darkQuery.addEventListener('change', () => {
  if (getColorMode() === 'auto') applyColorMode('auto');
});
