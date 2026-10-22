import test from 'node:test';
import assert from 'node:assert/strict';
import { mechanismEffectProof } from '../scripts/effect-mechanism-certificates.mjs';
import { certifyEffectText, certifyCandidate } from '../scripts/effect-certificates.mjs';
import { check } from '../scripts/effect-validate.mjs';

const unit = (text, extra = {}) => ({ kind: 'attack', text, card: { name: '测试', category: null },
  attack: { name: '测试招式', damage: '20', cost: '' }, ...extra });
const proof = (u, key = 'cn:test:ability') => mechanismEffectProof(u, key, certifyEffectText);
const p = (text) => proof(unit(text)).result.effects[0][2];

test('attached Energy quantities distinguish physical cards from provided units and retain side/type/category', () => {
  assert.deepEqual(p('选择这只宝可梦身上附着的2个能量，放于弃牌区。'), {
    op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
    providedTypes: null, measure: 'units', quantity: { kind: 'exact', count: 2 }, chooser: 'source',
  });
  assert.equal(p('选择这只宝可梦身上附着的2张能量，放于弃牌区。').measure, 'cards');
  assert.deepEqual(p('将附着于对手战斗宝可梦身上的1个特殊能量，放于弃牌区。').selector, { kind: 'energy', category: 'special' });
  assert.equal(p('将附着于对手战斗宝可梦身上的1个特殊能量，放于弃牌区。').side, 'opponent');
  assert.deepEqual(p('选择这只宝可梦身上附着的2个【火】能量，放于弃牌区。').providedTypes, ['Fire']);
  const named = p('选择这只宝可梦身上附着的2张基本【火】能量，放于弃牌区。');
  assert.deepEqual(named.selector, { kind: 'energy', category: 'basic', types: ['Fire'] }); assert.equal(named.providedTypes, null);
  assert.equal(proof(unit('选择这只宝可梦身上附着的2张【火】能量，放于弃牌区。')), null);
});

test('all-card discard/return and single/separate recipient movement never become optional selection', () => {
  const all = p('将附着于这只宝可梦身上的能量，全部放于弃牌区。');
  assert.deepEqual(all.quantity, { kind: 'all' }); assert.equal(all.measure, 'cards');
  assert.deepEqual(p('将这只宝可梦身上附着的所有能量，放回手牌。').quantity, { kind: 'all' });
  assert.equal(p('将这只宝可梦身上附着的所有能量，以任意方式转附于备战宝可梦身上。').distribution, 'separateRecipients');
  assert.equal(p('将这只宝可梦身上附着的所有能量，转附于1只备战宝可梦身上。').distribution, 'singleRecipient');
  assert.equal(p('选择附着于这只宝可梦身上的1个能量，转附于备战宝可梦身上。').recipient.position, 'bench');
  assert.equal(proof(unit('选择附着于对手战斗宝可梦身上的1个能量，转附于备战宝可梦身上。')), null);
});

test('damage formulas independently read the printed base, named Pokémon stat and a single bonus flip', () => {
  const energy = unit('追加造成对手战斗宝可梦身上附着的能量数量×50伤害。', { attack: { damage: '30+', cost: '', name: '攻击' } });
  const r = proof(energy).result;
  assert.deepEqual(r.effects[0][2].expression, { kind: 'add', terms: [
    { kind: 'literal', value: 30 }, { kind: 'multiply', left: { kind: 'literal', value: 50 },
      right: { kind: 'pokemon', who: 'opponentActive', field: 'energyUnits' } },
  ] });
  const counters = proof({ ...energy, text: '追加造成这只宝可梦身上放置的伤害指示物数量×10伤害。' }).result;
  assert.deepEqual(counters.effects[0][2].expression.terms[1].right, { kind: 'pokemon', who: 'self', field: 'damageCounters' });
  const coin = proof({ ...energy, text: '抛掷1次硬币如果为正面，则追加造成20点伤害。' }).result.effects[0][2];
  assert.equal(coin.expression.terms[0].value, 30); assert.equal(coin.expression.terms[1].left.value, 20);
  assert.deepEqual(coin.rolls[0].spec, { kind: 'fixed', count: 1 });
  assert.equal(proof({ ...energy, attack: { ...energy.attack, damage: '30' } }), null);
});

test('counters/packets target the printed location and preserve bench reminder/selection semantics', () => {
  assert.deepEqual(p('给对手的1只备战宝可梦身上，放置7个伤害指示物。'), { side: 'opponent', target: 'bench', count: 7 });
  assert.deepEqual(p('给对手的2只备战宝可梦身上，各放置1个伤害指示物。'), { side: 'opponent', target: 'bench', count: 1, targets: 2 });
  assert.deepEqual(p('给对手的1只宝可梦，造成50点伤害。[备战宝可梦不计算弱点、抗性。]'), {
    side: 'opponent', target: 'any', amount: 50, selection: { kind: 'exact', count: 1 }, options: {},
  });
  assert.equal(p('给对手的所有宝可梦，各造成20点伤害。[备战宝可梦不计算弱点、抗性。]').selection.kind, 'all');
  assert.equal(proof(unit('给对手的1只宝可梦，造成50点伤害。[不计算弱点、抗性。]')), null);
  assert.deepEqual(p('这个招式的伤害，不计算抗性。'), { ignoreResistance: true });
});

test('once/unlimited activated and hand-origin triggered Abilities are different complete envelopes', () => {
  const body = '选择这只宝可梦身上附着的1个能量，转附于备战宝可梦身上。';
  const ability = (text) => unit(text, { kind: 'ability', ability: { name: '测试特性' } });
  const activated = proof(ability('在自己的回合可以使用1次。' + body)).result;
  assert.equal(activated.mode, 'activated'); assert.equal(activated.usage.period, 'turn'); assert.equal(activated.usage.limit, 1);
  const unlimited = proof(ability('在自己的回合可以使用任意次。' + body)).result;
  assert.equal(unlimited.usage.period, 'unlimited'); assert.equal(unlimited.usage.limit, null);
  for (const [word, event] of [['放于备战区', 'bench'], ['并进行进化', 'evolve']]) {
    const r = proof(ability(`在自己的回合，当将这张卡牌从手牌使出${word}时，可使用1次。` + body)).result;
    assert.equal(r.mode, 'triggered'); assert.equal(r.usage, null);
    assert.deepEqual(r.trigger, { event, origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true });
  }
  assert.equal(proof(ability('在自己的回合，当将这张卡牌从弃牌区使出放于备战区时，可使用1次。' + body)), null);
  assert.equal(proof(ability('在自己的回合可以使用1次。' + body), null), null);
});

test('new patterns never drop extra clauses, optionality, costs, quotas or a shared-flip clause', () => {
  const examples = ['选择这只宝可梦身上附着的2个能量，放于弃牌区。', '追加造成这只宝可梦身上放置的伤害指示物数量×10伤害。',
    '给对手的战斗宝可梦身上，放置7个伤害指示物。'];
  for (const text of examples) {
    const u = unit(text, { attack: { damage: '20+', name: '测试招式', cost: '' } });
    for (const extra of ['然后，令这只宝可梦昏厥。', '[在对战中只能使用1次。]', '如果成功，则抽取2张卡牌。'])
      assert.equal(proof({ ...u, text: text + extra }), null);
    assert.equal(proof({ ...u, text: '若希望，可' + text }), null);
  }
  assert.equal(proof(unit('抛掷1次硬币如果为正面，则追加造成20伤害。并使对手陷入【麻痹】状态。')), null);
});

test('independent programs themselves pass the native kernel; a disagreeing model or semantic parameter change is rejected', () => {
  const examples = [
    unit('将场上的竞技场放于弃牌区。'),
    unit('选择这只宝可梦身上附着的2个能量，放于弃牌区。'),
    unit('给对手的1只宝可梦，造成50点伤害。[备战宝可梦不计算弱点、抗性。]'),
    unit('追加造成这只宝可梦身上放置的伤害指示物数量×10伤害。', { attack: { damage: '20+', name: '测试', cost: '' } }),
    unit('在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。从自己牌库上方抽取2张卡牌。',
      { kind: 'ability', ability: { name: '测试' } }),
  ];
  for (const u of examples) {
    const r = proof(u).result;
    assert.equal(check(u, r).valid, true, u.text);
    assert.ok(certifyCandidate(u, r, r, r.usage?.key), u.text);
    const changed = structuredClone(r); changed.effects[0][1] = 'cn.unknown@1';
    assert.equal(certifyCandidate(u, r, changed, r.usage?.key), null);
  }
});
