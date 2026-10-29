// Card images fetched ahead of the table, so a card drawn or played shows at once. The table asks for the images of
// your own deck as soon as a game is on it (they tell nothing you do not know), a few at a time and at low priority so
// the game's own requests go first. The opponent's cards are never asked for ahead: each is fetched when it is shown,
// like any other revealed card. Every image is fetched once per page and kept (holding it keeps it in the page's memory
// cache); across games and reloads the browser's cache keeps it (server/app.mjs: a card image for a day, a library
// image for good).
const kept = new Map(); // url → the loaded image (null while waiting or loading)
const queue = [];
let running = 0;
const AT_ONCE = 3;

/** Fetch these image URLs in the background, each once; returns how many were new. */
export function preloadImages(urls) {
  let added = 0;
  for (const url of urls) {
    if (!url || kept.has(url)) continue;
    kept.set(url, null);
    queue.push(url);
    added++;
  }
  pump();
  return added;
}

function pump() {
  while (running < AT_ONCE && queue.length) {
    const url = queue.shift(), img = new Image();
    running++;
    img.decoding = 'async';
    img.fetchPriority = 'low';
    const done = () => { running--; kept.set(url, img); pump(); };
    // Decoded too, so the first frame that shows it does not wait for that either.
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(done);
    img.onerror = done;
    img.src = url;
  }
}

/** For tests: the URLs asked for, and how many are loaded. */
export const preloadState = () => ({ asked: [...kept.keys()], loaded: [...kept.values()].filter(Boolean).length, waiting: queue.length + running });
