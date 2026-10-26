// Train the learned position value (ai/value-model.mjs) on self-play (scripts/ai-selfplay.mjs): a small neural network
// (ReLU hidden layers, a logistic output) by Adam on the log loss, the features standardised. Every tenth game is held
// out; the model kept is the epoch with the lowest held-out log loss, and the report compares it with evaluate.mjs's
// weights on the same positions.
//   node scripts/ai-train-value.mjs <dir|file.jsonl.gz>… [--hidden 64,32] [--epochs 8] [--lr 0.001] [--batch 256]
//     [--decay 0.00001] [--max-rows 6000000] [--drop <feature>,…] [--out ai/value-model.json] [--write]
// --drop leaves features out (their inputs count as average and their weights are 0).
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, constants } from 'node:zlib';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FEATURE_NAMES } from '../ai/features.mjs';
import { SEARCH_WEIGHTS } from '../ai/evaluate.mjs';
import { VALUE_WEIGHTS } from '../ai/value-weights.mjs';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  hidden: { type: 'string', default: '64,32' }, epochs: { type: 'string', default: '8' }, lr: { type: 'string', default: '0.001' },
  batch: { type: 'string', default: '256' }, decay: { type: 'string', default: '0.00001' }, 'max-rows': { type: 'string', default: '6000000' },
  out: { type: 'string', default: new URL('../ai/value-model.json', import.meta.url).pathname }, write: { type: 'boolean', default: false },
  seed: { type: 'string', default: '1' }, drop: { type: 'string', default: '' } } });
const F = FEATURE_NAMES.length, maxRows = Number(opt['max-rows']);
const dropped = opt.drop.split(',').filter(Boolean).map((name) => {
  const f = FEATURE_NAMES.indexOf(name);
  if (f < 0) throw new Error(`No feature ${name}.`);
  return f;
});

// A small seeded generator (mulberry32) for the initial weights and the shuffles.
let seed = Number(opt.seed) >>> 0;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

// The rows: features, label, the old evaluator's features, and whether held out.
const files = positionals.flatMap((p) => statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => f.endsWith('.jsonl.gz')).map((f) => join(p, f)) : [p]);
let X = new Float32Array(1 << 20), Y = new Uint8Array(1 << 18), V = new Float32Array(13 << 18), held = new Uint8Array(1 << 18);
let n = 0, games = 0, draws = 0;
const grow = (a, size) => { if (a.length >= size) return a; const b = new a.constructor(Math.max(size, a.length * 2)); b.set(a); return b; };
for (const file of files) {
  // A run still writing may end in half a game: what decompresses is read, a cut-off last line is skipped.
  for (const line of gunzipSync(readFileSync(file), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8').split('\n')) {
    if (!line || n >= maxRows) continue;
    let game;
    try { game = JSON.parse(line); } catch { continue; }
    if (game.winner === null) { draws++; continue; }
    games++;
    for (const row of game.rows) {
      if (n >= maxRows) break;
      X = grow(X, (n + 1) * F); Y = grow(Y, n + 1); V = grow(V, (n + 1) * 13); held = grow(held, n + 1);
      X.set(row.x, n * F); V.set(row.v, n * 13);
      Y[n] = Number(game.winner === row.me);
      held[n] = Number(game.g % 10 === 0);
      n++;
    }
  }
}
const train = [], test = [];
for (let i = 0; i < n; i++) (held[i] ? test : train).push(i);
console.log(`${files.length} files, ${games} games (${draws} unfinished or drawn left out), ${train.length} training and ${test.length} held-out positions`);

// Standardise with the training rows' means and spreads.
const mean = new Float64Array(F), std = new Float64Array(F);
for (const i of train) for (let f = 0; f < F; f++) mean[f] += X[i * F + f];
mean.forEach((v, f) => { mean[f] = v / train.length; });
for (const i of train) for (let f = 0; f < F; f++) std[f] += (X[i * F + f] - mean[f]) ** 2;
std.forEach((v, f) => { std[f] = Math.sqrt(v / train.length) || 1; });

// The network.
const sizes = [F, ...opt.hidden.split(',').filter(Boolean).map(Number), 1];
const layers = sizes.slice(1).map((outputs, k) => {
  const inputs = sizes[k], w = new Float64Array(outputs * inputs).map(() => gauss() * Math.sqrt(2 / inputs));
  return { inputs, outputs, w, b: new Float64Array(outputs), gw: new Float64Array(w.length), gb: new Float64Array(outputs),
    mw: new Float64Array(w.length), vw: new Float64Array(w.length), mb: new Float64Array(outputs), vb: new Float64Array(outputs),
    z: new Float64Array(outputs), a: new Float64Array(outputs), d: new Float64Array(outputs) };
});
const input = new Float64Array(F);
function forward(i) {
  for (let f = 0; f < F; f++) input[f] = (X[i * F + f] - mean[f]) / std[f];
  for (const f of dropped) input[f] = 0;
  let a = input;
  layers.forEach((l, k) => {
    const last = k === layers.length - 1;
    for (let o = 0; o < l.outputs; o++) {
      let z = l.b[o];
      for (let j = 0, row = o * l.inputs; j < l.inputs; j++) z += l.w[row + j] * a[j];
      l.z[o] = z; l.a[o] = last || z > 0 ? z : 0;
    }
    a = l.a;
  });
  return a[0];
}
function backward(dLogit) {
  layers.at(-1).d[0] = dLogit;
  for (let k = layers.length - 1; k >= 0; k--) {
    const l = layers[k], prev = k ? layers[k - 1].a : input;
    for (let o = 0; o < l.outputs; o++) {
      const d = l.d[o];
      if (!d) continue;
      l.gb[o] += d;
      for (let j = 0, row = o * l.inputs; j < l.inputs; j++) l.gw[row + j] += d * prev[j];
    }
    if (!k) break;
    const below = layers[k - 1];
    for (let j = 0; j < l.inputs; j++) {
      if (below.z[j] <= 0) { below.d[j] = 0; continue; }
      let s = 0;
      for (let o = 0; o < l.outputs; o++) s += l.w[o * l.inputs + j] * l.d[o];
      below.d[j] = s;
    }
  }
}
let t = 0;
function step(lr, batch, decay) {
  t++;
  const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** t, c2 = 1 - b2 ** t;
  const update = (p, g, m, v, wd) => {
    for (let j = 0; j < p.length; j++) {
      const grad = g[j] / batch + wd * p[j];
      m[j] = b1 * m[j] + (1 - b1) * grad; v[j] = b2 * v[j] + (1 - b2) * grad * grad;
      p[j] -= lr * (m[j] / c1) / (Math.sqrt(v[j] / c2) + 1e-8);
      g[j] = 0;
    }
  };
  for (const l of layers) { update(l.w, l.gw, l.mw, l.vw, decay); update(l.b, l.gb, l.mb, l.vb, 0); }
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function score(rows, predict) {
  let loss = 0, right = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const i of rows) {
    const p = Math.min(1 - 1e-7, Math.max(1e-7, predict(i))), y = Y[i];
    loss -= y ? Math.log(p) : Math.log(1 - p);
    right += Number((p > 0.5) === (y === 1));
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    bin.n++; bin.p += p; bin.y += y;
  }
  return { logLoss: +(loss / rows.length).toFixed(4), accuracy: +(right / rows.length).toFixed(3),
    calibration: bins.filter((b) => b.n).map((b) => [+(b.p / b.n).toFixed(2), +(b.y / b.n).toFixed(2), b.n]) };
}
const linear = (w) => (i) => sigmoid(w.reduce((s, x, k) => s + x * V[i * 13 + k], 0));
const baseline = { search: score(test, linear(SEARCH_WEIGHTS)), fitted: score(test, linear(VALUE_WEIGHTS.weights)) };
console.log('evaluate.mjs on the held-out positions:', JSON.stringify({ search: baseline.search.logLoss, searchAccuracy: baseline.search.accuracy,
  fitted: baseline.fitted.logLoss, fittedAccuracy: baseline.fitted.accuracy }));

const epochs = Number(opt.epochs), batch = Number(opt.batch), decay = Number(opt.decay), lr0 = Number(opt.lr), started = performance.now();
let result, best = null;
for (let epoch = 0; epoch < epochs; epoch++) {
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  const lr = lr0 * 0.5 * (1 + Math.cos(Math.PI * epoch / epochs));
  for (let s = 0; s < train.length; s += batch) {
    const end = Math.min(train.length, s + batch);
    for (let k = s; k < end; k++) { const i = train[k]; backward(sigmoid(forward(i)) - Y[i]); }
    step(lr, end - s, decay);
  }
  result = score(test, (i) => sigmoid(forward(i)));
  console.log(`epoch ${epoch + 1}: held-out log loss ${result.logLoss}, ${(result.accuracy * 100).toFixed(1)}% right, ${((performance.now() - started) / 60000).toFixed(1)} min`);
  if (!best || result.logLoss < best.result.logLoss) best = { epoch: epoch + 1, result, layers: layers.map((l) => ({ w: l.w.slice(), b: l.b.slice() })) };
}
// The best epoch's weights.
layers.forEach((l, k) => { l.w.set(best.layers[k].w); l.b.set(best.layers[k].b); });
result = best.result;
console.log(`kept epoch ${best.epoch}; calibration (predicted, actual, positions):`, JSON.stringify(result.calibration));

const r6 = (a) => Array.from(a, (x) => +x.toPrecision(6));
// A dropped feature's weights are 0, so the model reads it as nothing.
for (const f of dropped) for (let o = 0; o < layers[0].outputs; o++) layers[0].w[o * F + f] = 0;
const model = {
  features: FEATURE_NAMES, mean: r6(mean), std: r6(std),
  layers: layers.map((l) => ({ inputs: l.inputs, outputs: l.outputs, w: r6(l.w), b: r6(l.b) })),
  trained: { games, rows: train.length, heldOut: test.length, hidden: sizes.slice(1, -1), epochs, epoch: best.epoch,
    dropped: dropped.map((f) => FEATURE_NAMES[f]), testLogLoss: result.logLoss, testAccuracy: result.accuracy,
    searchWeightsLogLoss: baseline.search.logLoss, searchWeightsAccuracy: baseline.search.accuracy },
};
if (opt.write) { writeFileSync(opt.out, `${JSON.stringify(model)}\n`); console.log(`Wrote ${opt.out}`); }
