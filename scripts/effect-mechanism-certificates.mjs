// Complete, parameterized text patterns over already reviewed primitives. These are semantic oracles, not a model
// answer normalizer: every side, quantity, unit-vs-card distinction, printed damage base and trigger is constructed
// independently. Clauses outside the grammar remain unsupported; there is no prefix-only admission.
import { clean } from './effect-units.mjs';

const entry = (handler, parameters) => ['effect', `cn.${handler}@1`, parameters];
const proof = (family, effects, extra = {}) => ({ family: `mechanism-${family}`, result: { status: 'ok', effects, ...extra } });
const literal = (value) => ({ kind: 'literal', value });
const multiply = (left, right) => ({ kind: 'multiply', left, right });
const TYPES = { 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic', 斗: 'Fighting', 恶: 'Darkness', 钢: 'Metal', 妖: 'Fairy', 无: 'Colorless' };
const textOf = (text) => clean(text).replaceAll(',', '，');

function energy(text) {
  const subject = '(?:附着于(这只宝可梦|对手战斗宝可梦)身上的|(这只宝可梦|对手战斗宝可梦)身上附着的)';
  const m = new RegExp(`^(?:选择|将)${subject}(\\d+)(个|张)(特殊|基本)?(?:【([草火水雷超斗恶钢妖无])】)?能量，(放于弃牌区|放回手牌|转附于(?:1只)?备战宝可梦身上)。$`).exec(text);
  if (m) {
    const own = (m[1] ?? m[2]) === '这只宝可梦', move = m[7].startsWith('转附');
    if (move && !own) return null; // This wording does not independently identify an opponent recipient.
    if (m[4] === '张' && m[6] && m[5] !== '基本') return null; // Do not confuse a named Basic card with current provision.
    const cards = m[4] === '张', selector = { kind: 'energy',
      ...(m[5] ? { category: m[5] === '特殊' ? 'special' : 'basic' } : {}),
      ...(cards && m[6] ? { types: [TYPES[m[6]]] } : {}) };
    const op = m[7] === '放于弃牌区' ? 'discardEnergy' : m[7] === '放回手牌' ? 'returnEnergy' : 'moveEnergy';
    return proof(op, [entry('attachedEnergy', { op, side: own ? 'own' : 'opponent', from: own ? 'self' : 'active',
      selector, providedTypes: !cards && m[6] ? [TYPES[m[6]]] : null, measure: cards ? 'cards' : 'units',
      quantity: { kind: 'exact', count: Number(m[3]) }, chooser: 'source',
      ...(op === 'returnEnergy' ? { to: 'hand' } : {}),
      ...(move ? { recipient: { position: 'bench', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' } : {}),
    })]);
  }
  const all = /^将(?:附着于这只宝可梦身上的|这只宝可梦身上附着的)(所有)?(?:【([草火水雷超斗恶钢妖无])】)?能量，(全部)?(放于弃牌区|放回手牌|(?:以任意方式)?转附于(?:1只)?备战宝可梦身上)。$/.exec(text);
  if (!all || !all[1] && !all[3]) return null;
  const op = all[4] === '放于弃牌区' ? 'discardEnergy' : all[4] === '放回手牌' ? 'returnEnergy' : 'moveEnergy';
  return proof(`${op}-all`, [entry('attachedEnergy', { op, side: 'own', from: 'self', selector: { kind: 'energy' },
    providedTypes: all[2] ? [TYPES[all[2]]] : null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source',
    ...(op === 'returnEnergy' ? { to: 'hand' } : {}),
    ...(op === 'moveEnergy' ? { recipient: { position: 'bench', selector: { kind: 'pokemon' } },
      distribution: all[4].startsWith('以任意方式') ? 'separateRecipients' : 'singleRecipient' } : {}),
  })]);
}

function damageFormula(text, unit) {
  const printed = /^(\d+)([+×x-])$/.exec(clean(unit.attack?.damage));
  if (!printed) return null;
  const base = Number(printed[1]), operator = printed[2];
  let m, value;
  if (operator === '+' && (m = /^追加造成(这只宝可梦|对手战斗宝可梦)身上(附着的能量|放置的伤害指示物)数量×(\d+)(?:点)?伤害。$/.exec(text))) {
    value = { kind: 'add', terms: [literal(base), multiply(literal(Number(m[3])), {
      kind: 'pokemon', who: m[1] === '这只宝可梦' ? 'self' : 'opponentActive',
      field: m[2] === '附着的能量' ? 'energyUnits' : 'damageCounters',
    })] };
  }
  if (operator === '+' && (m = /^抛掷1次硬币[，]?如果为正面，则追加造成(\d+)(?:点)?伤害。$/.exec(text)))
    return proof('coin-bonus', [entry('damageValue', {
      expression: { kind: 'add', terms: [literal(base), multiply(literal(Number(m[1])), { kind: 'coin', key: 'flips', field: 'heads' })] },
      rolls: [{ key: 'flips', spec: { kind: 'fixed', count: 1 } }],
    })]);
  if (value) return proof('damage-formula', [entry('damageValue', { expression: value })]);
  return null;
}

function atomic(text, unit) {
  let m;
  const attached = energy(text);
  if (attached) return attached;
  if ((m = /^回复这只宝可梦「?(\d+)」?点HP。$/.exec(text)))
    return proof('heal-self', [entry('heal', { target: 'self', amount: Number(m[1]) })]);
  if ((m = /^给对手的(战斗|1只备战|1只)宝可梦(?:身上)?，放置(\d+)个伤害指示物。$/.exec(text)))
    return proof('counters', [entry('counters', { side: 'opponent',
      target: { 战斗: 'active', '1只备战': 'bench', '1只': 'any' }[m[1]], count: Number(m[2]) })]);
  if ((m = /^给对手的(\d+)只(备战)?宝可梦(?:身上)?，各放置(\d+)个伤害指示物。$/.exec(text)) && Number(m[1]) >= 2)
    return proof('counters', [entry('counters', { side: 'opponent', target: m[2] ? 'bench' : 'any', count: Number(m[3]), targets: Number(m[1]) })]);
  if (text === '将场上的竞技场放于弃牌区。')
    return proof('discard-stadium', [entry('discardStadium', { op: 'discardStadium', side: 'either',
      selector: { kind: 'trainer', categories: ['stadium'] } })]);
  if ((m = /^从(?:自己的|自己)?牌库上方抽取卡牌，直到自己的手牌变为(\d+)张为止。$/.exec(text)))
    return proof('draw-until', [entry('drawUntil', { count: Number(m[1]) })]);
  if (unit.kind !== 'attack') return null;
  if (text === '将这只宝可梦与备战宝可梦互换。')
    return proof('switch-source', [entry('switch', { side: 'own', chooser: 'self', affected: 'source' })]);
  if ((m = /^给对手(?:的)?1只(备战)?宝可梦，(?:也)?造成(\d+)(?:点)?伤害。\[备战宝可梦不计算弱点、抗性。\]$/.exec(text)))
    return proof('damage-packet', [entry('damage', { side: 'opponent', target: m[1] ? 'bench' : 'any', amount: Number(m[2]),
      selection: { kind: 'exact', count: 1 }, options: {} })]);
  if ((m = /^给对手(?:的)?所有(备战)?宝可梦，(?:也)?各造成(\d+)(?:点)?伤害。\[备战宝可梦不计算弱点、抗性。\]$/.exec(text)))
    return proof('damage-packet', [entry('damage', { side: 'opponent', target: m[1] ? 'bench' : 'any', amount: Number(m[2]),
      selection: { kind: 'all' }, options: {} })]);
  if (text === '这个招式的伤害，不计算抗性。')
    return proof('damage-options', [entry('damageOptions', { ignoreResistance: true })]);
  if (text === '这个招式的伤害，不受对手战斗宝可梦身上效果的影响。')
    return proof('damage-options', [entry('damageOptions', { ignoreDefenderEffects: true })]);
  return damageFormula(text, unit);
}

const RESOLVE = new Set(['cn.draw@1', 'cn.drawUntil@1', 'cn.cards@1', 'cn.switch@1', 'cn.condition@1',
  'cn.heal@1', 'cn.counters@1', 'cn.attachedEnergy@1', 'cn.discardStadium@1', 'cn.coin@1']);
export function mechanismEffectProof(unit, usageKey, baseProof) {
  const text = textOf(unit.text), direct = atomic(text, unit);
  if (unit.kind === 'attack' && direct) return direct;
  const body = (text) => {
    const found = atomic(text, { ...unit, kind: 'ability' }) ?? baseProof({ ...unit, kind: 'attack', text,
      attack: { name: '', cost: '', damage: '' } });
    return found && found.result.effects.every((e) => RESOLVE.has(e[1])) ? found : null;
  };
  if (unit.kind === 'trainer' && ['item', 'supporter'].includes(unit.card.category) && direct
    && !direct.result.effects.some((e) => e[2].from === 'self' || e[2].target === 'self')
    && direct.result.effects.every((e) => RESOLVE.has(e[1]))) return direct;
  if (unit.kind === 'ability') {
    let m = /^(如果这只宝可梦在战斗场上的话，则)?在自己的回合可以使用(1次|任意次)。(.*)$/.exec(text);
    if (m && usageKey) {
      const found = body(m[3]);
      if (found) return proof(`ability-${found.family}`, found.result.effects, { mode: 'activated',
        usage: { period: m[2] === '1次' ? 'turn' : 'unlimited', scope: 'pokemon', key: usageKey, limit: m[2] === '1次' ? 1 : null },
        ...(m[1] ? { condition: { sourceActive: true } } : {}),
      });
    }
    m = /^在自己的回合，当将这张卡牌从手牌使出(放于备战区|并进行进化)时，可使用1次。(.*)$/.exec(text);
    if (m) {
      const found = body(m[2]);
      if (found) return proof(`trigger-${found.family}`, found.result.effects, { mode: 'triggered', usage: null,
        trigger: { event: m[1] === '放于备战区' ? 'bench' : 'evolve', origin: 'hand', subject: 'self',
          turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
      });
    }
  }
  if (unit.kind === 'attack' || unit.kind === 'trainer' && ['item', 'supporter'].includes(unit.card.category)) {
    const m = /^抛掷1次硬币[，]?如果为(正|反)面，则(.+)$/.exec(text);
    if (m) {
      const found = atomic(m[2], { ...unit, kind: 'ability' }) ?? baseProof({ ...unit, text: m[2] }), leaf = found?.result.effects;
      if (leaf?.length === 1 && ['cn.switch@1', 'cn.condition@1', 'cn.cards@1', 'cn.attachedEnergy@1'].includes(leaf[0][1]))
        return proof(`coin-${found.family}`, [entry('coin', { outcome: m[1] === '正' ? 'heads' : 'tails',
          effect: { handlerId: leaf[0][1], parameters: leaf[0][2] } })]);
    }
  }
  return null;
}
