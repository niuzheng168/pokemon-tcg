import { OfficialGame } from './game.js';
import { loadReviewedCatalogRelease, catalogReleaseReceipt, assertReviewedRelease, checkCatalogReleaseReceipt } from './catalog-release.js';
import { getFormat } from './formats.js';

function gameCatalog(release, legacy, printingIds) {
  if (release === undefined) return loadReviewedCatalogRelease(legacy);
  assertReviewedRelease(release);
  if (Object.values(legacy).some((v) => v !== undefined))
    throw new TypeError('Choose a pinned v2 release session OR v1 loading arguments, not both.');
  return release.catalogFor(printingIds);
}

/** Review-bound admission; explicit pool checks are additional to release approval, not official certification. */
export async function createReviewedGame({ release, json, trustedReleases, handlers, maximumBytes, decks, seed, format, matchMode, expectedApproval }) {
  const input = structuredClone({ decks, seed, format, matchMode });
  const expected = structuredClone(expectedApproval);
  const catalog = await gameCatalog(release, { json, trustedReleases, handlers, maximumBytes },
    release === undefined ? null : input.decks.flat());
  const compatibility = expected === undefined ? null : checkCatalogReleaseReceipt(catalog, expected);
  getFormat(input.format); // No implicit developer-pool fallback at a release entry point.
  const ruleset = { region: catalog.ruleset.region, version: catalog.ruleset.version };
  const game = new OfficialGame({ ...input, ruleset, catalog });
  return Object.freeze({ game, catalog, approval: catalogReleaseReceipt(catalog), compatibility });
}

export async function restoreReviewedGame({ release, json, trustedReleases, handlers, maximumBytes, snapshot, expectedApproval }) {
  const input = structuredClone(snapshot);
  const expected = structuredClone(expectedApproval);
  const catalog = await gameCatalog(release, { json, trustedReleases, handlers, maximumBytes },
    release === undefined ? null : Object.values(input.cards).map((c) => c.printingId));
  const compatibility = expected === undefined ? null : checkCatalogReleaseReceipt(catalog, expected);
  getFormat(input?.format);
  const game = OfficialGame.restore(input, { catalog });
  return Object.freeze({ game, catalog, approval: catalogReleaseReceipt(catalog), compatibility });
}
