// Sets the saved colour mode before the page is drawn, so dark mode does not flash white. It is a
// separate file because the site's Content Security Policy blocks inline scripts. The navbar's
// colour mode menu (src/utils/color-mode.js) changes the mode afterwards. It is not in static/,
// whose files browsers keep for a year, as its name stays the same when it changes.
(() => {
  let mode;
  try {
    mode = localStorage.getItem('colorMode');
  } catch {}
  if (mode !== 'light' && mode !== 'dark') {
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-bs-theme', mode);
})();
