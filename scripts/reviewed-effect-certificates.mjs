// Exact complete units from the committed hand-reviewed pool, with the existing mechanism regressions as evidence.
// This reuses their PROGRAM, not their printing identity, quality tier, rule box, deck limits or format permission.
// No fuzzy name/wording match, no deleted clauses, no gold/model cache dependency.
import { buildEffectGold } from './effect-gold.mjs';
import { unitOf, clean } from './effect-units.mjs';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';
import { createHash } from 'node:crypto';
import { canonicalDefinition } from '../public/rules/card-schema.js';

const definitions = new Map(reviewed.DEFINITIONS.map((d) => [d.definitionId, d]));
const printings = new Map(reviewed.PRINTINGS.map((p) => [p.printingId, p]));
const proofs = new Map(), byText = new Map();
const textKey = (unit) => JSON.stringify([unit.kind, unit.card.category ?? '', clean(unit.text)]);
for (const gold of buildEffectGold().units) {
  if (gold.unit.kind === 'rule') continue; // Separate whole-card rule-box gate, never a free-standing attack certificate.
  const def = definitions.get(printings.get(gold.card).definitionBindings[0].definitionId);
  const m = def.mechanics;
  const owned = gold.unit.kind === 'attack' ? m.attacks.filter((a) => a.name === gold.unit.attack.name)
    : gold.unit.kind === 'ability' ? m.abilities.filter((a) => a.name === gold.unit.ability.name) : [];
  if (['attack', 'ability'].includes(gold.unit.kind) && owned.length !== 1)
    throw new Error(`Ambiguous reviewed effect unit: ${gold.uid}`);
  // The legacy gold wire describes effect bodies, not these additional execution contracts. Never turn a partial
  // authoring export into an apparently complete certificate when the reviewed source also needs one of them.
  if (owned[0]?.failureCheck || owned[0]?.specialRule || owned[0]?.costs || gold.unit.kind === 'attack' && owned[0]?.condition
    || gold.unit.kind === 'trainer' && m.grantedAttacks?.length
    || gold.unit.kind === 'energy' && ['attachCosts', 'handAttachTo', 'remainOn'].some((k) => Object.hasOwn(m, k))) continue;
  const effects = owned[0]?.effects ?? m.effects;
  if (effects.some((e) => Object.keys(e).some((k) => !['effectId', 'handlerId', 'parameters', 'sourceOfTruth'].includes(k)))) continue;
  const scope = owned[0]?.attackId ?? owned[0]?.abilityId, local = scope?.slice(def.definitionId.length + 1);
  const namedTargets = new Set();
  const replace = (v) => {
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)]));
    if (typeof v === 'string' && local && (v === `DEF:${local}` || v.startsWith(`DEF:${local}:`)))
      return `DEF:${gold.unit.kind === 'attack' ? 'a' : 'b'}${v.slice(4 + local.length)}`;
    if (typeof v === 'string' && v.startsWith('DEF:') && gold.unit.kind === 'ability') {
      const matches = m.attacks.filter((a) => v === `DEF:${a.attackId.slice(def.definitionId.length + 1)}`
        && clean(gold.unit.text).includes(`「${clean(a.name)}」`));
      if (matches.length === 1) { namedTargets.add(matches[0].name); return `ATTACK:${matches[0].name}`; }
    }
    return v;
  };
  const result = replace(gold.expected);
  // A gold unit with a cross-unit reference cannot be rebased without matching its named target on the whole card.
  // Keep this explicit rather than applying the translator's stand-in "a" to an arbitrary first attack.
  let crossUnit = false;
  const scan = (v) => {
    if (v && typeof v === 'object') Object.values(v).forEach(scan);
    else if (typeof v === 'string' && v.startsWith('DEF:')
      && !new RegExp(`^DEF:${gold.unit.kind === 'attack' ? 'a' : 'b'}(?::|$)`).test(v)) crossUnit = true;
  };
  scan(result);
  if (crossUnit || namedTargets.size > 1) continue;
  const proof = { result, provenance: { printingId: gold.card, definitionId: def.definitionId,
    definitionSha256: createHash('sha256').update(canonicalDefinition(def)).digest('hex'),
    testIds: [...def.implementation.testIds] },
    // The translator's one-attack stand-in used "a". The actual physical card is bound by its printed name below.
    ...(namedTargets.size === 1 ? { referenceAliases: { 'DEF:a': `ATTACK:${[...namedTargets][0]}` } } : {}) };
  proofs.set(gold.uid, proof);
  // Trainer/Energy card names do not affect these context-free programs. Card-specific identity/limits/rules are
  // still built from the target printing, separately. Do not generalize an implicit reference to the source's name.
  if (['trainer', 'energy'].includes(gold.unit.kind)
    && (!JSON.stringify(result).includes(`NAME:${gold.unit.card.name}`)
      || clean(gold.unit.text).includes(`「${clean(gold.unit.card.name)}」`))) {
    const key = textKey(gold.unit), existing = byText.get(key);
    if (!byText.has(key)) byText.set(key, proof);
    else if (JSON.stringify(existing?.result) !== JSON.stringify(result)) byText.set(key, null); // Ambiguous → no fallback.
  }
}

export function reviewedEffectProof(unit, usageKey) {
  const { uid, ...identity } = unit;
  const exact = proofs.get(unitOf(identity).uid);
  const proof = exact ?? (['trainer', 'energy'].includes(unit.kind) ? byText.get(textKey(unit)) : null);
  if (!proof) return null;
  const result = structuredClone(proof.result);
  if (unit.kind === 'ability' && result.usage?.key) {
    if (!usageKey) return null;
    result.usage.key = usageKey;
  }
  return { family: `reviewed-${unit.kind}`, result, reviewed: { ...structuredClone(proof.provenance),
    match: exact ? 'exact-unit' : 'exact-text-and-category' },
    ...(proof.referenceAliases ? { referenceAliases: { ...proof.referenceAliases } } : {}) };
}

// The policy attached to copy/return programs has an official-evidence schema, unlike a machine card's identity.
// Retain the actual reviewed source card and explicitly scope the citation to its tested control policy. This is
// NOT evidence that the target machine printing was hand-reviewed, and never replaces that printing's own sources.
export function reviewedProgramEvidence(printingId) {
  const p = printings.get(printingId);
  if (!p) return null;
  return definitions.get(p.definitionBindings[0].definitionId).sourceOfTruth.map((s) => ({
    ...s, sourceId: `reviewed-policy:${s.sourceId}`,
    locator: `${s.locator}；仅复用此人工审核卡的已测试效果程序控制参数依据，不证明目标机器印刷的身份或人工审核质量。`,
  }));
}
