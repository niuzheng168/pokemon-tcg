// Re-translation rounds (scripts/effect-translation-rounds.json; scripts/effect_translate.py --round). Round 1 is
// .data/effect-translation/out/<model>/; round rN is out-rN/<model>/. Earlier outputs are kept; readers take a unit's
// latest round that has an output.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TRANSLATION_ROUNDS = JSON.parse(readFileSync(new URL('./effect-translation-rounds.json', import.meta.url), 'utf8'));

/** Path of one model's output for a unit from the latest round that has one. */
export function modelOutputPath(base, model, uid) {
  for (const { round } of [...TRANSLATION_ROUNDS].reverse()) {
    const path = join(base, `out-${round}`, model, `${uid}.json`);
    if (existsSync(path)) return path;
  }
  return join(base, 'out', model, `${uid}.json`);
}
