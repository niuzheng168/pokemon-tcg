// One engine host in a worker thread (server/engine-pool.mjs starts them): it opens the reviewed release itself and
// answers the protocol's requests (docs/ENGINE-PROTOCOL.md) for the matches the pool gives it.
import { parentPort, workerData } from 'node:worker_threads';
import { loadRelease } from './catalog.mjs';
import { createEngineHost } from './engine-host.mjs';

const host = createEngineHost({ release: await loadRelease(workerData.release ?? {}) });
parentPort.on('message', async (request) => parentPort.postMessage(await host.handle(request)));
parentPort.postMessage({ ready: true });
