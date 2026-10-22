// Rare Candy's Basic ancestry is a derived fact about checked printed evolution links, not arbitrary Wiki metadata.
// In particular, a missing-image row such as 「呱呱泡蛙（SV5a）」 must not create a second, unreviewed Basic parent.
import { stageOf } from './machine-reprint.mjs';

export function buildStage1Parents(index, reviews, resolveNameKey) {
  const result = new Map();
  for (const e of index.entries) {
    if (e.duplicateOf || e.kind !== 'pokemon') continue;
    const r = reviews.get(e.id), a = r?.accepted;
    if (r?.image !== true || !a || !Array.isArray(r.conflicts)
      || r.conflicts.some((f) => ['name', 'stage', 'evolves_from'].includes(f.field))) continue;
    const name = a.name?.value, stage = a.stage?.value, parent = a.evolves_from?.value;
    if (typeof name !== 'string' || typeof parent !== 'string' || !name || !parent || stageOf(stage, name) !== 'stage1') continue;
    const key = resolveNameKey(name), from = resolveNameKey(parent);
    if (typeof key !== 'string' || !key || typeof from !== 'string' || !from) continue;
    const parents = result.get(key) ?? new Set();
    parents.add(from); result.set(key, parents);
  }
  return result;
}
