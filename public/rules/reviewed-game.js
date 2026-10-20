import { OfficialGame } from './game.js';
import { loadReviewedCatalogRelease, catalogReleaseReceipt } from './catalog-release.js';
import { getFormat } from './formats.js';

/** Review-bound admission; explicit pool checks are additional to release approval, not official certification. */
export async function createReviewedGame({ json, trustedReleases, handlers, maximumBytes, decks, seed, format, matchMode }) {
  const input = structuredClone({ decks, seed, format, matchMode });
  const catalog = await loadReviewedCatalogRelease({ json, trustedReleases, handlers, maximumBytes });
  getFormat(input.format); // No implicit developer-pool fallback at a release entry point.
  const ruleset = { region: catalog.ruleset.region, version: catalog.ruleset.version };
  const game = new OfficialGame({ ...input, ruleset, catalog });
  return Object.freeze({ game, catalog, approval: catalogReleaseReceipt(catalog) });
}

export async function restoreReviewedGame({ json, trustedReleases, handlers, maximumBytes, snapshot }) {
  const input = structuredClone(snapshot);
  const catalog = await loadReviewedCatalogRelease({ json, trustedReleases, handlers, maximumBytes });
  getFormat(input?.format);
  const game = OfficialGame.restore(input, { catalog });
  return Object.freeze({ game, catalog, approval: catalogReleaseReceipt(catalog) });
}
