// Builds site/: the hosted web version, static files only (no server).
//   /           web/: redirects to the game, plus 404, robots and sitemap
//   /play/      redirects to /play/cn/
//   /play/cn/   the CN/V20261019 official-rules game, native ES modules from public/
//   node scripts/build-web.mjs   then   sf publish site
// Reviewed card images (public/img/cn-cards/, npm run cn:images) are copied when present;
// without them the page shows text cards.
import { cp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public'), site = join(root, 'site'), play = join(site, 'play');

// SITE_URL: the production address (canonical link, sitemap). Keep site/.spacefast: it links the folder
// to its Space, so the next `sf publish site` updates the same one.
const SITE_URL = (process.env.SITE_URL || 'https://pokemon.space.fast').replace(/\/$/, '');
for (const e of await readdir(site).catch(() => [])) if (e !== '.spacefast') await rm(join(site, e), { recursive: true, force: true });

// Local card caches may be symlinks to a NAS. Static output must contain files,
// not machine-specific links that break when the site is deployed elsewhere.
const copy = (from, to) => cp(from, to, { recursive: true, dereference: true, filter: (src) => !src.endsWith('.DS_Store') });
for (const part of ['index.html', 'cn', 'rules', join('data', 'cn')]) await copy(join(pub, part), join(play, part));
const images = join(pub, 'img', 'cn-cards');
if (await stat(images).catch(() => null)) await copy(images, join(play, 'img', 'cn-cards'));
else console.warn('public/img/cn-cards/ is missing (npm run cn:images): the site will show text cards.');

// The game stays as native ES modules, NOT bundled: an approved release pins the
// installed handlers' exact function source, and a bundler/minifier would rewrite
// that code and invalidate the release.
for (const f of ['app.js', 'ai.js', 'trusted-releases.js']) if ((await readFile(join(play, 'cn', f), 'utf8')) !== (await readFile(join(pub, 'cn', f), 'utf8')))
  throw new Error(`play/cn/${f} must be byte-identical to public/cn/${f}`);
for (const f of await readdir(join(play, 'rules'), { recursive: true })) if (f.endsWith('.js') &&
    (await readFile(join(play, 'rules', f), 'utf8')) !== (await readFile(join(pub, 'rules', f), 'utf8')))
  throw new Error(`play/rules/${f} must be byte-identical to the reviewed kernel source`);

await copy(join(root, 'web'), site);
for (const f of ['index.html', 'robots.txt', 'sitemap.xml']) {
  const p = join(site, f);
  await writeFile(p, (await readFile(p, 'utf8')).replaceAll('__SITE_URL__', SITE_URL));
}
console.log(`site/ ready for ${SITE_URL}: /play/cn/`);
