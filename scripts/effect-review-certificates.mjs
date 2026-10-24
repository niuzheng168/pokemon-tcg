// Certificates for model translations that no narrow template covers. Admitted only if a per-unit semantic review,
// recorded in the committed ledger catalog/.../library/machine/effect-reviews.json, judged exactly that program "correct":
// the agreed program of both models (consensus-review) or, where they disagree, one model's program (disagreement-review). Wrong/unsure verdicts
// stay in the queue. Programs with a fallback (cn.orElse@1) or a ruling placeholder are never admitted this way: a
// card that lets a player choose must not become a fixed order, and an open ruling is not a reviewed behaviour.
import { createHash } from 'node:crypto';
import { canonicalEffectResult } from './effect-certificates.mjs';

export const REVIEW_FAMILY = 'consensus-review';
// User decision 2026-10-23: when the two models' programs differ (or only one produced a program), the one program a
// per-unit review judged "correct" is admitted too, under its own family so its provenance stays visible.
export const DISAGREEMENT_FAMILY = 'disagreement-review';
export const REVIEW_FAMILIES = Object.freeze([REVIEW_FAMILY, DISAGREEMENT_FAMILY]);
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
  // II.E-10 「若希望」 around an any-card deck search (which must take the printed count, H 牌库): only cn.optional@1 can decline it.
  const declinable = new Set([...calls(result)].filter(([id]) => id === 'cn.optional@1').flatMap(([, p]) => [...calls(p)].map(([, q]) => q)));
  for (const [id, p] of calls(result)) {
    const attach = id === 'cn.attachDiscard@1' ? p : id === 'cn.attachThenDraw@1' && p.from === 'discard' ? p.attach : null;
    // attachDiscard's count is a maximum (≥1) unless `exact` (II.D-04): 「弃牌区中的2张…，附着于」 without it would let a player attach
    // just one. 「任意数量的」 is `anyNumber` (II.D-02), none included.
    if (attach && attach.count >= 2 && !attach.exact && !attach.anyNumber && !text.includes('最多')) return 'exact count from the discard pile';
    // Only a 「若希望」 in the search's own sentence makes it optional (「…加入手牌。并重洗牌库。若希望，可将…互换」 qualifies the switch).
    if (id === 'cn.cards@1' && p.from === 'deck' && p.selector?.kind === 'any' && ['upTo', 'exact'].includes(p.quantity?.kind)
      && text.split('。').some((s) => s.includes('若希望') && s.includes('牌库')) && !declinable.has(p)) return 'optional any-card deck search must take a card';
  }
  // 「（除「X」外）」 excepts an Ability by name; an ID exempts only this definition's copy, not another printing's.
  if (values(result, 'exceptAbilityIds').length) return 'Ability exception by name, not by this definition';
  if ([...values(result, 'tag'), ...values(result, 'tags')].some((t) => typeof t === 'string' && /[\u3400-\u9fff]/.test(t)))
    return 'card tag spelled in Chinese, not as the catalog tags it';
  return null;
}

// A non-KO promotion schedule or a copied special attack's handling is a ruling. The kernel settles the ruled value
// by the ruleset's sourced rule (effects.field-return-promotion, attack.copy-special-rule); any other value needs
// official evidence of its own, which a card-library record is not. Not a review finding, so not in the ledger.
const RULED = { promotion: (slot) => slot?.timing === 'afterRelatedResolution', special: (slot) => slot?.mode === 'consumeUserQuota' };
export const needsOfficialEvidence = (result) => Object.entries(RULED).some(([key, ruled]) =>
  values(result, key).some((slot) => !ruled(slot) && JSON.stringify(slot).includes('CARD_EVIDENCE')));

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

// The certificate for one unit's reviewed program, or null: the agreed program (consensus-review) or, where the models
// disagree, the one program the review judged (disagreement-review). `reviews` is the Map from reviewLedger.
export function reviewedConsensusProof(unit, result, reviews, family = REVIEW_FAMILY) {
  if (!REVIEW_FAMILIES.includes(family)) throw new Error(`Unknown review family: ${family}`);
  if (result?.status !== 'ok' || EXCLUDED.test(JSON.stringify(result)) || inexpressible(unit, result)
    || needsOfficialEvidence(result)) return null;
  const review = reviews.get(unit.uid);
  if (review?.verdict !== 'correct' || review.programSha256 !== programSha256(result)) return null;
  return { family, result, review: { verdict: review.verdict, programSha256: review.programSha256 } };
}
