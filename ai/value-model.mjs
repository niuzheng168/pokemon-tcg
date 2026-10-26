// The learned position value: a small neural network from features.mjs's numbers to a chance to win, trained on
// self-play (scripts/ai-selfplay.mjs, scripts/ai-train-value.mjs). A model is plain JSON: the feature names it was
// trained with, their means and spreads, and the layers (ReLU between them, a logistic output).
import { readFileSync } from 'node:fs';
import { featureReader, FEATURE_NAMES } from './features.mjs';

export const DEFAULT_MODEL = new URL('./value-model.json', import.meta.url);
const models = new Map();

/** The model at `path` (a file path or URL), read once. */
export function loadValueModel(path = DEFAULT_MODEL) {
  const key = String(path);
  if (!models.has(key)) models.set(key, compileModel(JSON.parse(readFileSync(path, 'utf8'))));
  return models.get(key);
}

/** A model's forward pass: features → logit. */
export function compileModel(model) {
  if (model.features.join() !== FEATURE_NAMES.join()) throw new Error('The value model was trained with other features.');
  const mean = Float64Array.from(model.mean), scale = Float64Array.from(model.std, (s) => 1 / (s || 1));
  const layers = model.layers.map((l) => ({ inputs: l.inputs, outputs: l.outputs, w: Float64Array.from(l.w), b: Float64Array.from(l.b) }));
  const buffers = layers.map((l) => new Float64Array(l.outputs)), input = new Float64Array(mean.length);
  function logit(x) {
    for (let i = 0; i < input.length; i++) input[i] = (x[i] - mean[i]) * scale[i];
    let a = input;
    layers.forEach((l, k) => {
      const out = buffers[k], last = k === layers.length - 1;
      for (let o = 0; o < l.outputs; o++) {
        let z = l.b[o];
        for (let i = 0, row = o * l.inputs; i < l.inputs; i++) z += l.w[row + i] * a[i];
        out[o] = last || z > 0 ? z : 0;
      }
      a = out;
    });
    return a[0];
  }
  return { model, logit };
}

/** The learned value as an evaluator (as evaluate.mjs's): P(win) for `me` from `me`'s view. */
export function createLearnedEvaluator(catalog, compiled = loadValueModel()) {
  const features = featureReader(catalog);
  return {
    evaluate(view, me) {
      if (view.result) return view.result.draw ? 0.5 : view.result.winner === me ? 1 : 0;
      return 1 / (1 + Math.exp(-compiled.logit(features(view, me))));
    },
  };
}
