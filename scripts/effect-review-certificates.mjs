// Certificates for agreed model translations that no narrow template covers. Admitted only if both models' complete
// programs are canonically identical (checked when authoring) and a per-unit semantic review, recorded in the committed
// ledger catalog/.../library/machine/effect-reviews.json, judged exactly that program "correct". Wrong/unsure verdicts
// stay in the queue. Programs with a fallback (cn.orElse@1) or a ruling placeholder are never admitted this way: a
// card that lets a player choose must not become a fixed order, and an open ruling is not a reviewed behaviour.
import { createHash } from 'node:crypto';
import { canonicalEffectResult } from './effect-certificates.mjs';

export const REVIEW_FAMILY = 'consensus-review';
export const REVIEW_SCHEMA = 'cn-effect-reviews/1';

export const programSha256 = (result) => createHash('sha256').update(canonicalEffectResult(result)).digest('hex');

const EXCLUDED = /"cn\.orElse@1"|needsRuling/;

// Handler calls anywhere in a program: [key, handlerId, parameters] entries and nested {handlerId, parameters}.
function* calls(v) {
  if (Array.isArray(v)) {
    if (v.length === 3 && typeof v[1] === 'string' && /^cn\.[A-Za-z]+@\d+$/.test(v[1])) yield [v[1], v[2] ?? {}];
    for (const x of v) yield* calls(x);
  } else if (v && typeof v === 'object') {
    if (typeof v.handlerId === 'string') yield [v.handlerId, v.parameters ?? {}];
    for (const x of Object.values(v)) yield* calls(x);
  }
}
const values = (v, key) => [...(function* walk(x) {
  if (Array.isArray(x)) for (const y of x) yield* walk(y);
  else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) {
    if (k === key) yield* (Array.isArray(y) ? y : [y]);
    yield* walk(y);
  }
})(v)];

// Classes of text a handler cannot express exactly, found while reviewing; a review cannot admit them. Each returns a
// reason, or null.
export function inexpressible(unit, result) {
  const text = unit.text ?? '';
  for (const [id, p] of calls(result)) {
    const attach = id === 'cn.attachDiscard@1' ? p : id === 'cn.attachThenDraw@1' && p.from === 'discard' ? p.attach : null;
    // attachDiscard's count is a maximum (≥1): 「弃牌区中的2张…，附着于」 would let a player attach just one.
    if (attach && attach.count >= 2 && !text.includes('最多')) return 'exact count from the discard pile';
    if (id === 'cn.cards@1' && p.from === 'deck' && p.selector?.kind === 'any' && ['upTo', 'exact'].includes(p.quantity?.kind)
      && text.includes('若希望')) return 'optional any-card deck search must take a card';
    // Which Pokémon an effect may put onto the Bench without naming them or their stage needs a ruling source.
    if (id === 'cn.cards@1' && p.to === 'bench' && !p.selector?.nameKeys && !p.selector?.stages)
      return 'unnamed Pokémon put onto the Bench';
  }
  // 「（除「X」外）」 excepts an Ability by name; an ID exempts only this definition's copy, not another printing's.
  if (values(result, 'exceptAbilityIds').length) return 'Ability exception by name, not by this definition';
  if ([...values(result, 'tag'), ...values(result, 'tags')].some((t) => typeof t === 'string' && /[\u3400-\u9fff]/.test(t)))
    return 'card tag spelled in Chinese, not as the catalog tags it';
  return null;
}

// A non-KO promotion schedule or a copied special attack's handling is a ruling: its slot accepts official evidence only,
// so a machine definition cannot fill it with its card-library record. Not a review finding, so not in the ledger.
export const needsOfficialEvidence = (result) => [...values(result, 'promotion'), ...values(result, 'special')]
  .some((slot) => JSON.stringify(slot).includes('CARD_EVIDENCE'));

// ledger: the parsed effect-reviews.json. Returns a Map uid → review row; rejects duplicates and unknown verdicts.
export function reviewLedger(ledger) {
  if (ledger?.schema !== REVIEW_SCHEMA || !Array.isArray(ledger.reviews)) throw new Error('Unknown effect review ledger schema.');
  const rows = new Map();
  for (const row of ledger.reviews) {
    if (rows.has(row.uid)) throw new Error(`Duplicate effect review: ${row.uid}`);
    if (!['correct', 'wrong', 'unsure'].includes(row.verdict) || !/^[0-9a-f]{64}$/.test(row.programSha256 ?? ''))
      throw new Error(`Malformed effect review: ${row.uid}`);
    rows.set(row.uid, row);
  }
  return rows;
}

// The certificate for one unit's agreed program, or null. `reviews` is the Map from reviewLedger.
export function reviewedConsensusProof(unit, result, reviews) {
  if (result?.status !== 'ok' || EXCLUDED.test(JSON.stringify(result)) || inexpressible(unit, result)
    || needsOfficialEvidence(result)) return null;
  const review = reviews.get(unit.uid);
  if (review?.verdict !== 'correct' || review.programSha256 !== programSha256(result)) return null;
  return { family: REVIEW_FAMILY, result, review: { verdict: review.verdict, programSha256: review.programSha256 } };
}
