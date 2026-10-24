// Synthetic definitions only. Attack sequencing and target choices:
// 「将场上的竞技场放于弃牌区。如果无法将卡牌放于弃牌区的话，则这个招式失败。」「在造成伤害前，将放于这只宝可梦身上的「宝可梦道具」放于弃牌区。
// 如果无法将卡牌放于弃牌区的话，则这个招式失败。」 (attack.failure.discard);
// 「选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，给新出场的宝可梦造成120伤害。在这个回合，如果没有从手牌使出「X」的话，则这个招式失败。」;
// 「给对手的1只备战宝可梦，造成170点伤害。如果在这个回合，已经从手牌使出了「X」的话，也给对手1只其他备战宝可梦，造成170点伤害。」;
// 「选择对手战斗宝可梦所拥有的1个招式（除GX招式外），作为这个招式使用。」;
// 「对手选择对手自己的1只宝可梦。给该宝可梦造成90点伤害。」 (attack.opponent-target);
// 「对手将对手自己牌库上方的3张卡牌，放于弃牌区。或者，对手选择对手自己的3张手牌，放于弃牌区。」 (effects.choose-one-opponent);
// 「查看对手的手牌，如果其中有能量的话，则使对手的战斗宝可梦陷入【麻痹】状态。」 (effects.counted-condition);
// 「除这只宝可梦外，从双方场上所有宝可梦中，选择1只剩余HP最少的宝可梦，使其【昏厥】。」 (effects.knockout-lowest);
// 「将受到这个招式的伤害而昏厥的宝可梦以及放于其身上的所有卡牌放于放逐区。」 (ko.attack-lost-zone);
// 「当对手的场上宝可梦身上附有【水】能量时，若希望，可将这个招式的伤害，给予对手的1只备战宝可梦而不是战斗宝可梦。」 (damage.redirect).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertExecutableDefinition, canonicalDefinition } from '../../public/rules/card-schema.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const catalogOf = { handler: (id) => handlers.get(id) };
const atk = (key, printed, effects, extra = {}) => ({ attackId: `base:${key}`, name: `测试${key}`, cost: ['Water'],
  printedDamage: printed === null ? null : { value: printed, operator: 'fixed' }, effects, sourceOfTruth: EVIDENCE, ...extra });
async function make(attacks, transform = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push(...attacks);
    transform(defs);
  });
}
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const use = (g, key) => command(g, { type: 'attack', attackId: `base:${key}` });
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const water = (s) => attached(s, 0, s.players[0].active, 'water');
const putStadium = (s, owner = 1) => { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; return id; };
const logs = (s, ruleId) => s.events.filter((e) => e.ruleId === ruleId);
const used = (s) => s.battleHistory.events.filter((e) => e.kind === 'attackUsed').length;
// A synthetic definition put through the card checks and the game-load guard, as a reviewed card would be.
function check(definition) {
  assertExecutableDefinition(definition, { ruleset: CN_V20261019, approvedDefinitions: new Map([[definition.definitionId, canonicalDefinition(definition)]]), handlers });
  assertSupportedDefinition(catalogOf, definition);
}
const withAttack = async (attack) => { const d = clone(def((await fixture()).definitions, 'base')); d.mechanics.attacks = [attack]; return d; };

const stadiumDrop = binding('cn.discardStadium@1', { op: 'discardStadium', side: 'either', selector: { kind: 'trainer', categories: ['stadium'] } }, 'stadium');
const toolDrop = binding('cn.countedToolDiscard@1', { side: 'own', target: 'self', quantity: { kind: 'all' } }, 'tool');
const requires = (effectId) => ({ failureCheck: { requires: `fixture:${effectId}`, sourceOfTruth: EVIDENCE } });

test('attack.failure.discard: schema, CN rule and supplementary rulings', async () => {
  const sources = requireRule(CN_V20261019, 'attack.failure.discard').sourceOfTruth.map((r) => r.documentId);
  assert.deepEqual(sources, ['CN-advanced-3.1.0', 'JP-official-qa', 'JP-official-qa', 'JP-official-qa']);
  await check(await withAttack(atk('end', 120, [stadiumDrop], requires('stadium'))));
  await check(await withAttack(atk('axe', 50, [toolDrop], requires('tool'))));
  // Only one of its own attack's Stadium or Tool discard entries.
  for (const bad of [atk('x', 120, [stadiumDrop], requires('other')),
    atk('y', 120, [binding('cn.draw@1', { count: 1 }, 'draw')], requires('draw'))])
    await assert.rejects(async () => check(await withAttack(bad)), /own attack's Stadium or Tool discard/);
  // Other self-failure forms still cannot go with a before-damage step.
  await assert.rejects(async () => check(await withAttack(atk('z', 50, [toolDrop],
    { failureCheck: { coin: { mode: 'fixed', count: 1, minimumHeads: 1 }, sourceOfTruth: EVIDENCE } }))), (e) => e.code === 'unsupported-failure-timing');
});

test('「将场上的竞技场放于弃牌区。如果无法…则这个招式失败」: no Stadium fails; a Stadium still changes this damage, then goes', async () => {
  const f = await make([atk('end', 80, [stadiumDrop], requires('stadium'))]);
  let g = board(f, water);
  use(g, 'end'); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0, 'No Stadium: the attack fails (JP Q&A ポワルン たいようのすがた).');
  assert.equal(logs(s, 'attack.failure.self').at(-1).data.receipt.passed, false);
  assert.equal(used(s), 1, 'A failed own-text condition is still a used attack.');
  assert.equal(s.current, 1);
  let stadium;
  g = board(f, (s) => { water(s); stadium = putStadium(s); });
  use(g, 'end'); settle(g);
  s = restore(g, f).snapshot();
  assert.equal(s.players[1].active.counters, 6, '80 − 20: the Stadium is discarded after the damage (JP Q&A 格闘道場).');
  assert.equal(s.stadium, null);
  assert(s.players[1].discard.includes(stadium));
});

test('a Stadium protected from this attack\'s effects cannot be discarded: the attack fails', async () => {
  const f = await make([atk('end', 120, [stadiumDrop], requires('stadium'))], (defs) => {
    def(defs, 'stadium').mechanics.effects.push(binding('cn.stadiumProtection@1', { effect: { op: 'stadiumProtection', scope: 'self',
      channel: 'effects', useRule: 'ordinary', from: 'opponent', categories: ['attack'] } }, 'shield'));
  });
  const g = board(f, (s) => { water(s); putStadium(s); });
  use(g, 'end'); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0);
  assert.notEqual(s.stadium, null);
});

test('「在造成伤害前，将放于这只宝可梦身上的「宝可梦道具」放于弃牌区。如果无法…」: discarded first, its +30 is gone', async () => {
  const f = await make([atk('axe', 50, [toolDrop], requires('tool'))]);
  let g = board(f, water);
  use(g, 'axe'); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 0, 'No Tool: the attack fails.');
  let tool;
  g = board(f, (s) => { water(s); tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(tool); });
  use(g, 'axe'); settle(g);
  const s = restore(g, f).snapshot();
  assert.equal(s.players[1].active.counters, 5, 'Not 80 (JP Q&A メルメタル「リモデルアックス」×げんきのハチマキ).');
  assert(s.players[0].discard.includes(tool));
  assert.deepEqual(logs(s, 'attack.failure.self').at(-1).data.receipt, { kind: 'predicate', passed: true });
});

test('a predicate failure check goes with a before-damage switch: 「…然后，给新出场的宝可梦造成120伤害。在这个回合，如果没有从手牌使出「X」的话…」', async () => {
  const plot = { kind: 'not', condition: { kind: 'historyFact', fact: 'supporterPlayed', selector: { kind: 'trainer', nameKeys: ['research'] } } };
  const f = await make([atk('tentacle', null, [
    binding('cn.countedSwitch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'gust'),
    binding('cn.damageValue@1', { expression: { kind: 'multiply', left: { kind: 'literal', value: 60 },
      right: { kind: 'effectCards', effectId: 'fixture:gust' } } }, 'damage')], { failureCheck: { predicate: plot, sourceOfTruth: EVIDENCE } })]);
  let other;
  let g = board(f, (s) => { water(s); other = bench(s, 1, 'other'); });
  use(g, 'tentacle'); settle(g);
  let s = g.snapshot();
  assert.notEqual(s.players[1].active.id, other.id, 'Failed before anything: no switch.');
  assert.equal(s.players[1].bench[0].counters, 0);
  g = board(f, (s) => { water(s); other = bench(s, 1, 'other'); hand(s, 0, 'research'); });
  command(g, { type: 'playTrainer', cardId: g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'research') });
  settle(g);
  use(g, 'tentacle');
  assert.deepEqual(g.snapshot().pending.options, [other.id]);
  restore(g, f);
  answer(g, [other.id]); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].active.id, other.id);
  assert.equal(s.players[1].active.counters, 6);
});

test('「如果在这个回合，已经从手牌使出了「X」的话，也给对手1只其他备战宝可梦，造成170点伤害」: one, or two different, Benched Pokémon', async () => {
  const twice = { kind: 'choose', condition: { kind: 'historyFact', fact: 'supporterPlayed', selector: { kind: 'trainer', nameKeys: ['research'] } },
    ifTrue: { kind: 'literal', value: 2 }, ifFalse: { kind: 'literal', value: 1 } };
  const f = await make([atk('cross', null, [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 170,
    selection: { kind: 'exact', count: twice }, options: {} }, 'cross')], { specialRule: 'GX' })], (defs) => {
    const m = def(defs, 'base').mechanics; m.ruleBox = true; m.tags = ['GX']; m.prizeCount = 2;
    def(defs, 'other').mechanics.hp = 200;
  });
  let a, b;
  const three = (s) => { water(s); a = bench(s, 1, 'other'); b = bench(s, 1, 'other'); bench(s, 1, 'base'); };
  let g = board(f, three);
  use(g, 'cross');
  let q = g.snapshot().pending;
  assert.deepEqual([q.minimum, q.maximum], [1, 1]);
  answer(g, [a.id]); settle(g);
  g = board(f, (s) => { three(s); hand(s, 0, 'research'); });
  command(g, { type: 'playTrainer', cardId: g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'research') });
  settle(g);
  use(g, 'cross');
  q = g.snapshot().pending;
  assert.deepEqual([q.minimum, q.maximum], [2, 2], 'Two different ones (JP Q&A クロスブレイクGX: never 340 to one, never 3).');
  restore(g, f);
  answer(g, [a.id, b.id]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[1].bench.map((m) => m.counters), [17, 17, 0], 'Each 170, no Weakness on the Bench.');
});

test('「选择对手战斗宝可梦所拥有的1个招式（除GX招式外）」: a GX attack is never offered', async () => {
  const f = await make([atk('shadow', null, [binding('cn.copyAttack@1', { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active',
    selector: { kind: 'pokemon' } }], excludeUser: false, coin: 'none', energy: 'ignore', excludeSpecialRules: ['GX'],
    special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }, 'copy')])], (defs) => {
    const m = def(defs, 'other').mechanics;
    m.ruleBox = true; m.tags = ['GX']; m.prizeCount = 2;
    m.attacks.push(atk('gx', 200, [], { attackId: 'other:gx', specialRule: 'GX' }));
  });
  const g = board(f, (s) => {
    water(s);
    const old = s.players[1].active; s.players[1].hand.push(...old.stack); s.players[1].active = bench(s, 1, 'other'); s.players[1].bench.pop();
  });
  use(g, 'shadow');
  assert.deepEqual(g.snapshot().pending.options.map((o) => JSON.parse(o)[1]), ['other:strike']);
});

test('attack.opponent-target 「对手选择对手自己的1只宝可梦。给该宝可梦造成90点伤害」: the opponent picks, a shielded one too', async () => {
  const stamp = (extra = {}) => ({ side: 'opponent', target: 'any', amount: 90, selection: { kind: 'exact', count: 1 }, options: {}, chooser: 'opponent', ...extra });
  const valid = (p) => handlers.get('cn.damage@1').validateParameters(clone(p));
  assert(valid(stamp()));
  for (const bad of [stamp({ side: 'own' }), stamp({ selection: { kind: 'all' } }), stamp({ selection: { kind: 'repeat', count: 2 } }),
    stamp({ chooser: 'self' })]) assert(!valid(bad), JSON.stringify(bad));
  assert.deepEqual(requireRule(CN_V20261019, 'attack.opponent-target').sourceOfTruth.map((r) => r.documentId), ['CN-advanced-3.1.0', 'JP-official-qa']);
  const f = await make([atk('stamp', null, [binding('cn.damage@1', stamp(), 'stamp')])], (defs) => {
    def(defs, 'other').mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    def(defs, 'other').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'damage',
      scope: 'self', from: 'opponent', categories: ['attack'], benchOnly: true } }, 'bench-shield'));
  });
  let shielded;
  const g = board(f, (s) => { water(s); shielded = bench(s, 1, 'other'); });
  use(g, 'stamp');
  const q = g.snapshot().pending;
  assert.equal(q.player, 1); assert.equal(q.ruleId, 'attack.opponent-target');
  assert.deepEqual(q.options.sort(), [g.snapshot().players[1].active.id, shielded.id].sort());
  restore(g, f);
  answer(g, [shielded.id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].bench[0].counters, 0, 'Chosen, but it takes no damage (JP Q&A ココロモリ「チャームスタンプ」×コスモガード).');
  assert.equal(s.players[1].active.counters, 0);
});

test('a failure check that requires a discard keeps its passed receipt while the attack waits for a later choice', async () => {
  const f = await make([atk('axe', 50, [toolDrop, binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10,
    selection: { kind: 'exact', count: 1 }, options: {} }, 'chip')], requires('tool'))]);
  let a;
  const g = board(f, (s) => { water(s); const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(t);
    a = bench(s, 1, 'other'); bench(s, 1, 'other'); });
  use(g, 'axe');
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [a.id]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[1].bench.find((m) => m.id === a.id).counters, 1);
  const forged = board(f, (s) => { water(s); const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(t);
    bench(s, 1, 'other'); bench(s, 1, 'other'); });
  use(forged, 'axe');
  const snap = clone(forged.snapshot()); snap.attack.execution.failureReceipt.passed = false;
  assert.throws(() => OfficialGame.restore(snap, { catalog: f.catalog }), (e) => e.code === 'invalid-attack-failure');
});

const deckTop3 = { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 3 } };
const hand3 = { handlerId: 'cn.opponentHand@1', parameters: { mode: 'opponentChooses', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 3 }, to: 'discard' } };
const setHand = (s, owner, ids) => { const p = s.players[owner]; p.deck.unshift(...p.hand.splice(0)); return ids.map((id) => hand(s, owner, id)); };

test('effects.choose-one-opponent 「对手将…牌库上方的3张卡牌，放于弃牌区。或者，对手选择…3张手牌，放于弃牌区」: the opponent picks', async () => {
  const valid = (p) => handlers.get('cn.chooseOne@1').validateParameters(clone(p));
  assert(valid({ options: [deckTop3, hand3], chooser: 'opponent' }));
  assert(!valid({ options: [deckTop3, hand3], chooser: 'self' }));
  assert.equal(requireRule(CN_V20261019, 'effects.choose-one-opponent').sourceOfTruth.length, 4);
  const f = await make([atk('choice', null, [binding('cn.chooseOne@1', { options: [deckTop3, hand3], chooser: 'opponent' }, 'choice')])]);
  let g = board(f, (s) => { water(s); setHand(s, 1, ['potion', 'research', 'water', 'water']); });
  let deck = g.snapshot().players[1].deck.length;
  use(g, 'choice');
  let q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.player, q.options, q.ruleId], ['choose-effect', 1, ['0', '1'], 'effects.choose-one-opponent']);
  restore(g, f);
  answer(g, ['1']);
  q = g.snapshot().pending;
  assert.equal(q.player, 1, 'The opponent picks the 3 cards too.');
  settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].hand.length, 2, 'One kept, one drawn at the start of the next turn.');
  assert.equal(s.players[1].deck.length, deck - 1);
  assert.equal(logs(s, 'effects.choose-one').at(-1).data.player, 1);
  // No hand: only the deck option can be picked (JP Q&A ベロベルト「ベロリンチョイス」).
  g = board(f, (s) => { water(s); setHand(s, 1, []); });
  deck = g.snapshot().players[1].deck.length;
  use(g, 'choice');
  assert.deepEqual(g.snapshot().pending.options, ['0']);
  answer(g, ['0']); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].deck.length, deck - 3 - 1, 'Three from the top (and the next turn\'s draw).');
});

test('effects.counted-condition 「查看对手的手牌，如果其中有能量的话，则使对手的战斗宝可梦陷入【麻痹】状态」', async () => {
  const energy = { kind: 'compare', left: { kind: 'movedCards', effectId: 'fixture:look', selector: { kind: 'energy' } }, relation: 'gt',
    right: { kind: 'literal', value: 0 } };
  const strobe = [binding('cn.countedHandLook@1', { mode: 'look' }, 'look'), binding('cn.when@1', { condition: energy,
    effect: { handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: 'paralyzed' } } }, 'if')];
  assert.equal(requireRule(CN_V20261019, 'effects.counted-condition').sourceOfTruth.length, 3);
  const f = await make([atk('strobe', 30, strobe)]);
  for (const [cards, paralyzed] of [[['research', 'water'], true], [['research', 'potion'], false], [[], false]]) {
    const g = board(f, (s) => { water(s); setHand(s, 1, cards); });
    use(g, 'strobe'); settle(g);
    const s = restore(g, f).snapshot();
    assert.equal(s.players[1].active.conditions.rotation === 'paralyzed', paralyzed, JSON.stringify(cards));
    assert.equal(s.players[1].active.counters, 3, 'The damage either way (JP Q&A ランターン「ストロボショック」).');
  }
  // Only the attack's own counted look: another entry's record, or a use-time condition, reads no looked-at cards.
  const guard = (attack) => withAttack(attack).then((d) => assert.throws(() => assertSupportedDefinition(catalogOf, d), (e) => e.code === 'unsupported-condition'));
  await guard(atk('other', 30, [strobe[0], binding('cn.when@1', { condition: { ...energy, left: { ...energy.left, effectId: 'fixture:else' } },
    effect: strobe[1].parameters.effect }, 'if')]));
  await guard(atk('use', 30, [strobe[0]], { failureCheck: { predicate: energy, sourceOfTruth: EVIDENCE } }));
});

const finish = (extra = {}) => ({ target: 'any', side: 'both', count: 1, excludeSelf: true, lowestRemainingHp: true, ...extra });

test('effects.knockout-lowest 「除这只宝可梦外，从双方场上所有宝可梦中，选择1只剩余HP最少的宝可梦，使其【昏厥】」: schema', () => {
  const valid = (p) => handlers.get('cn.knockOut@1').validateParameters(clone(p));
  assert(valid(finish())); assert(valid({ target: 'any', side: 'opponent', count: 1, lowestRemainingHp: true }));
  for (const bad of [finish({ count: 2 }), finish({ target: 'bench' }), { target: 'active', side: 'both' }, { target: 'active', side: 'own', excludeSelf: true },
    { target: 'self', lowestRemainingHp: true }]) assert(!valid(JSON.parse(JSON.stringify(bad))), JSON.stringify(bad));
  assert.deepEqual(requireRule(CN_V20261019, 'effects.knockout-lowest').sourceOfTruth.map((r) => r.documentId),
    ['CN-advanced-3.1.0', 'CN-advanced-3.1.0', 'JP-official-qa', 'JP-official-qa']);
});

test('the least remaining HP of both sides, never this Pokémon; the user picks one of a tie, its own included', async () => {
  const f = await make([atk('finish', null, [binding('cn.knockOut@1', finish(), 'ko')])], (defs) => {
    def(defs, 'evolution').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'effects',
      scope: 'self', from: 'opponent', categories: ['attack'] } }, 'shield'));
  });
  let mine, theirs, shielded;
  // This Pokémon has the least (10 HP left) but is excluded; one own and one opposing Pokémon tie at 20.
  let g = board(f, (s) => {
    water(s); s.players[0].active.counters = 9;
    mine = bench(s, 0, 'other'); mine.counters = 8; theirs = bench(s, 1, 'other'); theirs.counters = 8; bench(s, 1, 'evolution').counters = 1;
  });
  use(g, 'finish');
  const q = g.snapshot().pending;
  assert.deepEqual([q.player, [...q.options].sort()], [0, [mine.id, theirs.id].sort()]);
  restore(g, f);
  answer(g, [mine.id]); settle(g);
  let s = g.snapshot();
  assert(!s.players[0].bench.some((m) => m.id === mine.id), 'Its own Pokémon (JP Q&A ゲッコウガ「しとめる」).');
  assert(s.players[1].bench.some((m) => m.id === theirs.id));
  // A single least one is taken without a choice; protected from the effect, it stays.
  g = board(f, (s) => { water(s); shielded = bench(s, 1, 'evolution'); shielded.counters = 14; bench(s, 1, 'other'); });
  use(g, 'finish'); settle(g);
  s = g.snapshot();
  assert(s.players[1].bench.some((m) => m.id === shielded.id), 'Protected from the effect, the least one stays.');
  assert.equal(s.players[1].bench.length, 2);
  assert.equal(logs(s, 'effects.knockout').length, 0);
});

test('a lowest-HP Knock Out in a Trainer is usable while any matching Pokémon is in play', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.knockOut@1',
    { target: 'any', side: 'both', count: 1, lowestRemainingHp: true }, 'ko')]; });
  let potion;
  const g = board(f, (s) => { potion = hand(s, 0, 'potion'); s.players[0].active.counters = 5; });
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === potion));
  command(g, { type: 'playTrainer', cardId: potion }); settle(g);
  assert.equal(g.snapshot().players[0].active, null, 'Its own Active had the least.');
  const ctx = { source: { owner: 0, pokemonId: 'p' }, subject: { owner: 0, pokemon: { id: 'p' } } };
  assert.equal(handlers.get('cn.knockOut@1').canUse(ctx, finish()), false, 'Only this Pokémon there: nothing to choose.');
});

const toLost = binding('cn.attachedEnergy@1', { op: 'returnEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
  measure: 'units', quantity: { kind: 'exact', count: 2 }, chooser: 'source', to: 'lost' }, 'energy');
const crisis = (extra = []) => atk('crisis', 100, [toLost, binding('cn.attackKnockoutZone@1', {}, 'lost'), ...extra]);
// 「将这只宝可梦身上附着的2个能量放于放逐区」: both attached cards.
const crisisEnergy = (g) => { const q = g.snapshot().pending; assert.equal(q.kind, 'attached-energy'); answer(g, q.options); };

test('ko.attack-lost-zone 「将受到这个招式的伤害而昏厥的宝可梦以及放于其身上的所有卡牌放于放逐区」: every card, still a Knock Out', async () => {
  assert(handlers.get('cn.attackKnockoutZone@1').validateParameters({}));
  assert(!handlers.get('cn.attackKnockoutZone@1').validateParameters({ cards: 'all' }));
  assert.equal(requireRule(CN_V20261019, 'ko.attack-lost-zone').sourceOfTruth.length, 4);
  // Counters an effect of the same attack places are not its damage.
  const f = await make([crisis([binding('cn.counters@1', { side: 'opponent', target: 'bench', count: 10 }, 'counters')])]);
  let energy, tool, foe, spared, mine;
  const g = board(f, (s) => {
    mine = [water(s), water(s)];
    foe = s.players[1].active; energy = attached(s, 1, foe, 'water'); tool = hand(s, 1, 'tool'); s.players[1].hand.pop(); foe.tools.push(tool);
    spared = bench(s, 1, 'other'); bench(s, 1, 'other');
  });
  use(g, 'crisis'); crisisEnergy(g);
  assert.equal(g.snapshot().pending.kind, 'effect-target', 'The counters\' Benched Pokémon.');
  answer(g, [spared.id]); settle(g);
  const s = restore(g, f).snapshot(), p = s.players[1];
  for (const id of [...foe.stack, energy, tool]) assert(p.lost.includes(id), id);
  assert(p.discard.includes(spared.stack[0]), 'Knocked Out by the counters: the discard pile as usual.');
  assert.equal(s.players[0].prizes.length, 4, 'Both Knock Outs give their Prize cards.');
  for (const id of mine) assert(s.players[0].lost.includes(id));
  assert(logs(s, 'ko.lost-zone').some((e) => e.data.effects.length === 1 && e.data.cards === 'all'));
  // Only an attack has 「这个招式的伤害」.
  const item = clone(def(f.definitions, 'potion')); item.mechanics.effects = [binding('cn.attackKnockoutZone@1', {}, 'lost')];
  assert.throws(() => assertSupportedDefinition(catalogOf, item), (e) => e.code === 'unsupported-handler');
});

test('with a to-hand effect, the owner chooses which comes first; returned to the hand, the other cards still go to the Lost Zone', async () => {
  const immortal = binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', scope: 'self', cards: 'pokemon', to: 'hand', byOpponentAttack: true } }, 'immortal');
  const f = await make([crisis()], (defs) => {
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'base:immortal', name: '测试不朽', mode: 'continuous', usage: null,
      effects: [immortal], sourceOfTruth: EVIDENCE }];
  });
  for (const choice of ['hand', 'lost']) {
    let energy, foe;
    const g = board(f, (s) => { water(s); water(s); foe = s.players[1].active; energy = attached(s, 1, foe, 'water'); bench(s, 1, 'other'); });
    use(g, 'crisis'); crisisEnergy(g);
    const q = g.snapshot().pending;
    assert.deepEqual([q.kind, q.player, q.options], ['ko-zone', 1, ['hand', 'lost']]);
    const r = restore(g, f);
    for (const game of [g, r]) { answer(game, [choice]); settle(game); }
    assert.deepEqual(r.snapshot(), g.snapshot());
    const p = g.snapshot().players[1];
    assert(p[choice].includes(foe.stack[0]), choice);
    assert(p.lost.includes(energy), 'JP Q&A ロストクライシス×レスキューエネルギー.');
    if (choice === 'hand') assert(logs(g.snapshot(), 'ko.hand').at(-1).data.rest === 'lost');
  }
});

const swim = (extra = {}) => binding('cn.damageRedirect@1', { condition: { kind: 'compare', left: { kind: 'pokemonCount', side: 'opponent', zone: 'field',
  state: { energy: { providedTypes: ['Water'] } } }, relation: 'gt', right: { kind: 'literal', value: 0 } }, ...extra }, 'swim');

test('damage.redirect 「当对手的场上宝可梦身上附有【水】能量时，若希望，可将这个招式的伤害，给予对手的1只备战宝可梦而不是战斗宝可梦」', async () => {
  assert(handlers.get('cn.damageRedirect@1').validateParameters({}));
  assert(!handlers.get('cn.damageRedirect@1').validateParameters({ target: 'bench' }));
  assert.equal(requireRule(CN_V20261019, 'damage.redirect').sourceOfTruth.length, 2);
  const f = await make([atk('swim', 90, [swim()])], (defs) => {
    def(defs, 'other').mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    def(defs, 'base').mechanics.hp = 200;
    def(defs, 'base').mechanics.effects.push(binding('cn.modifier@1', { field: 'attackDamage', amount: 30, scope: 'self', targetSide: 'opponent',
      targetPosition: 'active' }, 'band'));
  });
  // Without Water Energy on the opponent's Pokémon, no choice: the Active Pokémon.
  let g = board(f, (s) => { water(s); bench(s, 1, 'other'); });
  use(g, 'swim'); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 12, '90 + 30.');
  let target;
  for (const pick of [true, false]) {
    g = board(f, (s) => { water(s); target = bench(s, 1, 'other'); attached(s, 1, target, 'water'); bench(s, 1, 'other'); });
    use(g, 'swim');
    const q = g.snapshot().pending;
    assert.deepEqual([q.kind, q.player, q.minimum, q.maximum, q.allowZero, q.ruleId], ['damage-redirect', 0, 0, 1, true, 'damage.redirect']);
    const r = restore(g, f);
    for (const game of [g, r]) { answer(game, pick ? [target.id] : []); settle(game); }
    assert.deepEqual(r.snapshot(), g.snapshot());
    const s = g.snapshot(), bench1 = s.players[1].bench.find((m) => m.id === target.id);
    // On the Bench: no Weakness, no Active-only +30 (JP Q&A ゴルダック「およぐ」×こだわりハチマキ).
    assert.deepEqual([s.players[1].active.counters, bench1.counters], pick ? [0, 9] : [12, 0]);
    assert.equal(logs(s, 'damage.redirect').at(-1).data.targetId, pick ? target.id : null);
  }
  // No Benched Pokémon: nothing to choose.
  g = board(f, (s) => { water(s); attached(s, 1, s.players[1].active, 'water'); });
  use(g, 'swim'); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 12);
});

test('damage.redirect: the record names an opposing Pokémon; only an attack\'s printed fixed damage, with no other step before it', async () => {
  const f = await make([atk('swim', 30, [binding('cn.damageRedirect@1', {}, 'swim'), binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10,
    selection: { kind: 'exact', count: 1 }, options: {} }, 'chip')])]);
  let target;
  const g = board(f, (s) => { water(s); target = bench(s, 1, 'other'); bench(s, 1, 'other'); });
  use(g, 'swim');
  // A board that no longer has the chosen Pokémon on the Bench cannot take the answer.
  const moved = clone(g.snapshot()), p = moved.players[1], i = p.bench.findIndex((m) => m.id === target.id);
  [p.active, p.bench[i]] = [p.bench[i], p.active];
  const r = OfficialGame.restore(moved, { catalog: f.catalog });
  assert.throws(() => answer(r, [target.id]), (e) => e.code === 'invalid-effect-target');
  answer(g, [target.id]);
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  restore(g, f);
  const forged = clone(g.snapshot());
  forged.attack.execution.effectCards[0].cards = [forged.players[0].active.stack[0]];
  forged.events.find((e) => e.ruleId === 'damage.effect-count').data.cards = [forged.players[0].active.stack[0]];
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  for (const bad of [atk('a', null, [swim()]), atk('b', 30, [swim(), binding('cn.countedHandLook@1', { mode: 'look' }, 'look')]),
    atk('c', 30, [swim(), binding('cn.damageValue@1', { expression: { kind: 'literal', value: 30 } }, 'formula')]),
    atk('d', 30, [swim(), binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10, selection: { kind: 'all' }, options: {},
      rolls: [{ key: 'flip', spec: { kind: 'fixed', count: 1 } }] }, 'chip')])])
    await assert.rejects(async () => check(await withAttack(bad)), (e) => e.code === 'unsupported-damage-redirect', bad.attackId);
  const item = clone(def(f.definitions, 'potion')); item.mechanics.effects = [swim()];
  assert.throws(() => assertSupportedDefinition(catalogOf, item), (e) => e.code === 'unsupported-effect-count');
});
