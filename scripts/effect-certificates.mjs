// Independent, deliberately narrow card-text recognizers. Model agreement and schema validation are NOT semantic
// approval. A candidate is admitted only if its entire text matches one of these tested templates and its executable
// result equals the independently constructed program. Unmatched clauses stay in the diagnostic queue.
import { clean } from './effect-units.mjs';

const entry = (handler, parameters) => ['effect', `cn.${handler}@1`, parameters];
const result = (family, effects, extra = {}) => ({ family, result: { status: 'ok', effects, ...extra } });
const literal = (value) => ({ kind: 'literal', value });
const CONDITIONS = { 睡眠: 'asleep', 麻痹: 'paralyzed', 混乱: 'confused', 中毒: 'poisoned', 灼伤: 'burned' };
const number = '「?(\\d+)」?';

function simple(text) {
  let m;
  if ((m = new RegExp(`^从(?:自己|自己的)?牌库上方抽取${number}张卡牌。$`).exec(text)))
    return result('draw', [entry('draw', { count: Number(m[1]) })]);
  if ((m = new RegExp(`^给这只宝可梦也造成${number}(?:点)?伤害。$`).exec(text)))
    return result('recoil', [entry('recoilDamage', { side: 'own', target: 'self', amount: Number(m[1]),
      selection: { kind: 'all' }, options: {} })]);
  if ((m = new RegExp(`^回复这只宝可梦${number}HP。$`).exec(text)))
    return result('heal-self', [entry('heal', { target: 'self', amount: Number(m[1]) })]);
  if ((m = /^(?:使|令)对手的战斗宝可梦陷入【(睡眠|麻痹|混乱|中毒|灼伤)】状态。$/.exec(text)))
    return result('condition', [entry('condition', { side: 'opponent', condition: CONDITIONS[m[1]] })]);
  if ((m = /^抛掷1次硬币[，,]?如果为(正|反)面，则(?:使|令)对手的战斗宝可梦陷入【(睡眠|麻痹|混乱|中毒|灼伤)】状态。$/.exec(text)))
    return result('coin-condition', [entry('coin', { outcome: m[1] === '正' ? 'heads' : 'tails',
      effect: { handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: CONDITIONS[m[2]] } } })]);
  if (text === '在下一个自己的回合，这只宝可梦无法使用招式。')
    return result('attack-lock', [entry('lasting', { side: 'own', target: 'self',
      effect: { op: 'restriction', scope: 'all', actions: ['attack'] }, duration: 'nextOwnTurn',
      clearOnBench: true, clearOnEvolution: true })]);
  if (text === '在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。')
    return result('retreat-lock', [entry('lasting', { side: 'opponent', target: 'active',
      effect: { op: 'restriction', scope: 'all', actions: ['retreat'] }, duration: 'nextOpponentTurn',
      clearOnBench: true, clearOnEvolution: true })]);
  if ((m = /^在下一个对手的回合，这只宝可梦所受到的招式的伤害「-(\d+)」。$/.exec(text)))
    return result('guard', [entry('lasting', { side: 'own', target: 'self',
      effect: { op: 'modifier', field: 'defenseDamage', amount: -Number(m[1]), scope: 'all' },
      duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true })]);
  if ((m = /^抛掷(\d+)次硬币，造成正面(?:次数|数量)×(\d+)伤害。$/.exec(text)))
    return result('coin-damage', [entry('damageValue', { expression: { kind: 'multiply', left: literal(Number(m[2])),
      right: { kind: 'coin', key: 'flips', field: 'heads' } }, rolls: [{ key: 'flips', spec: { kind: 'fixed', count: Number(m[1]) } }] })]);
  if (text === '选择对手的1只备战宝可梦，将其与战斗宝可梦互换。')
    return result('gust', [entry('switch', { side: 'opponent', chooser: 'self', affected: 'selected' })]);
  if (text === '将自己的战斗宝可梦与备战宝可梦互换。')
    return result('switch', [entry('switch', { side: 'own', chooser: 'self', affected: 'active' })]);
  if ((m = /^给对手所有备战宝可梦，也各造成(\d+)伤害。$/.exec(text)))
    return result('bench-damage', [entry('damage', { side: 'opponent', target: 'bench', amount: Number(m[1]),
      selection: { kind: 'all' }, options: {} })]);
  return null;
}

const SEARCH_SELECTORS = {
  '宝可梦': { kind: 'pokemon' }, '【基础】宝可梦': { kind: 'pokemon', stages: ['basic'] },
  '基本能量': { kind: 'energy', category: 'basic' }, '支援者': { kind: 'trainer', categories: ['supporter'] },
  '物品': { kind: 'trainer', categories: ['item'] }, '宝可梦道具': { kind: 'trainer', categories: ['tool'] },
};
function search(text) {
  const m = /^选择自己(牌库|弃牌区)(?:中|中的)(最多)?(\d+)张(.+?)，(在给对手看过之后，加入手牌|放于备战区|放回牌库并重洗牌库)。(并重洗牌库。)?$/.exec(text);
  if (!m || !Object.hasOwn(SEARCH_SELECTORS, m[4])) return null;
  const from = m[1] === '牌库' ? 'deck' : 'discard', to = m[5].includes('手牌') ? 'hand' : m[5].includes('备战') ? 'bench' : 'deck';
  // Never infer an omitted shuffle, hidden-zone reveal or a deployment rule from an almost-matching sentence.
  if (from === 'deck' && !m[6] || from === 'discard' && m[6] || to === 'bench' && m[4] !== '【基础】宝可梦') return null;
  return result('search', [entry('cards', { from, to, selector: SEARCH_SELECTORS[m[4]],
    quantity: { kind: m[2] ? 'upTo' : 'exact', count: Number(m[3]) }, reveal: to !== 'bench', lookTop: null,
    shuffleAfter: from === 'deck' || to === 'deck' })]);
}

export function certifyEffectText(unit, usageKey) {
  const text = clean(unit.text).replaceAll(',', '，');
  if (unit.kind === 'attack') return simple(text) ?? search(text);
  if (unit.kind === 'trainer' && ['item', 'supporter'].includes(unit.card.category)) {
    const found = simple(text) ?? search(text);
    // Only handlers whose semantics are identical on a Trainer. A recoil/lock clause is not a Trainer program.
    if (found && ['draw', 'search', 'gust', 'switch', 'coin-condition', 'condition'].includes(found.family)) return found;
    const m = /^将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取(\d+)张卡牌。$/.exec(text);
    if (m) return result('hand-shuffle-draw', [entry('handDeckDraw', { side: 'own', ownDraw: Number(m[1]), opponentDraw: 0 })]);
  }
  if (unit.kind === 'ability') {
    const m = /^(如果这只宝可梦在战斗场上的话，则)?在自己的回合可以使用1次。(.*)$/.exec(text);
    if (!m || !usageKey) return null;
    const body = simple(m[2]) ?? search(m[2]);
    if (!body || !['draw', 'search', 'switch', 'condition'].includes(body.family)) return null;
    return result(`ability-${body.family}`, body.result.effects, { mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: usageKey, limit: 1 }, ...(m[1] ? { condition: { sourceActive: true } } : {}) });
  }
  if (unit.kind === 'energy' && text === '这张卡牌，可被视作2个【无】能量。')
    return result('double-colorless', [], { baseUnits: [['Colorless'], ['Colorless']] });
  return null;
}

// Compare all executable fields. Only local effect keys and local roll variable names are alpha-renamed; arbitrary
// keys (especially usage, selectors and names) must not disappear as they did in the diagnostic Python comparison.
export function canonicalEffectResult(result) {
  const r = structuredClone(result), entries = r.effects ?? [], refs = new Map();
  entries.forEach(([key], i) => refs.set(`DEF:a:${key}`, `DEF:a:e${i}`));
  const walk = (v, rolls = new Map()) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, rolls));
    if (v && typeof v === 'object') {
      if (Array.isArray(v.rolls)) rolls = new Map(v.rolls.map((roll, i) => [roll.key, `r${i}`]));
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) =>
        [k, k === 'key' && rolls.has(x) ? rolls.get(x) : walk(x, rolls)]));
    }
    return refs.get(v) ?? v;
  };
  delete r.uid; delete r.notes; delete r.reasons;
  r.effects = entries.map(([, handlerId, parameters]) => [handlerId, walk(parameters)]);
  return JSON.stringify(walk(r));
}

export function certifyCandidate(unit, astra, sol, usageKey) {
  if (astra?.status !== 'ok' || sol?.status !== 'ok') return null;
  const a = structuredClone(astra), b = structuredClone(sol);
  // Match the deterministic reader normalization, never trust a model's spelling of a usage key.
  if (unit.kind === 'ability') for (const r of [a, b]) if (r.usage?.key) r.usage.key = usageKey;
  const proof = certifyEffectText(unit, usageKey);
  if (!proof) return null;
  const expected = canonicalEffectResult(proof.result);
  if (canonicalEffectResult(a) !== expected || canonicalEffectResult(b) !== expected) return null;
  return { family: proof.family, result: a };
}
