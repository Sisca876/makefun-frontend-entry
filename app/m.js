// Beacon boot: the shell (index.html) is the whole first load. This module is
// fetched after it, pulls in the stylesheet, then starts the app. Nothing here
// blocks the first paint: the loading line in the shell is replaced as soon as
// the stylesheet and the app arrive, usually within one round trip.

const css = await fetch('style.css').then((r) => r.text());
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

await import('./app.js');
