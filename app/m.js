// Beacon boot: the shell (index.html) is the whole first load. This module is
// fetched after it, pulls in the stylesheet, then starts the app. Nothing here
// blocks the first paint: the loading line in the shell is replaced as soon as
// the stylesheet and the app arrive, usually within one round trip.

// The theme goes on before the stylesheet arrives, so a stored light theme
// never flashes the dark shell first. The app's toggle takes over from here.
try {
  if (localStorage.getItem('beacon-theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
    document.body.style.background = '#f6f3ec';
    document.body.style.color = '#1d2433';
  }
} catch { /* private mode: dark, the default */ }

const css = await fetch('style.css').then((r) => r.text());
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

await import('./app.js');
