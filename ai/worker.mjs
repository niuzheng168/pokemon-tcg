// A search worker thread (ai/service.mjs starts them): it runs rollout jobs for one position at a time and answers in
// order. It opens the reviewed release itself and keeps the catalogs and searches it has built.
import { parentPort, workerData } from 'node:worker_threads';
import { loadRelease } from '../server/catalog.mjs';
import { createSearch } from './search.mjs';
import { printingKey } from './service.mjs';

const release = await loadRelease(workerData.release ?? {});
const catalogs = new Map(), searches = new Map();

async function catalogFor(snapshot) {
  const key = printingKey(snapshot);
  if (!catalogs.has(key)) {
    if (catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value);
    catalogs.set(key, release.catalogFor(key.split('|')));
  }
  return catalogs.get(key);
}

function searchFor(catalog, options) {
  const key = JSON.stringify(options);
  let byOptions = searches.get(catalog);
  if (!byOptions) searches.set(catalog, byOptions = new Map());
  if (!byOptions.has(key)) byOptions.set(key, createSearch(catalog, options));
  return byOptions.get(key);
}

parentPort.on('message', async ({ id, snapshot, me, jobs, options }) => {
  try {
    if (workerData.releaseId && release.releaseId !== workerData.releaseId) throw new Error('The worker opened another release.');
    const search = searchFor(await catalogFor(snapshot), options), cache = new Map();
    parentPort.postMessage({ id, results: jobs.map((job) => search.rollout(snapshot, me, job.world, job.action, cache)) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.stack ?? String(error) });
  }
});
parentPort.postMessage({ ready: true });
