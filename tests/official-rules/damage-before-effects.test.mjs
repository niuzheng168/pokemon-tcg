// Synthetic definitions only. 「将这只宝可梦，以及放于其身上的所有卡牌，放回自己的牌库并重洗牌库。如果追加附有【火】【水】【雷】能量各1个
// 的话，则给对手的3只宝可梦，各造成110点伤害。[备战宝可梦不计算弱点、抗性。][对战中，己方的GX招式只能使用1次。]」 (attack.damage-before-effects:
// the damage is dealt in I.A-01 step 4, while this Pokémon and its cards are in play; the printed return is a step 5 effect — JP Q&A
// れんげきウーラオスVMAX「キョダイレンゲキ」×ジュラルドンVMAX「まてんろう」／バリヤード「ものまねバリア」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const scoop = binding('cn.fieldReturn@1', { op: 'returnPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' },
  quantity: { kind: 'exact', count: 1 }, to: 'deckShuffle', attachments: 'return', chooser: 'source',
  promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } }, 'scoop');
const legend = binding('cn.damage@1', { side: 'opponent', target: 'any', amount: 110, options: {},
  selection: { kind: 'exact', count: { kind: 'choose', condition: { kind: 'compare',
    left: { kind: 'extraEnergy', energyTypes: ['Fire', 'Water', 'Lightning'] }, relation: 'gte', right: lit(1) }, ifTrue: lit(3), ifFalse: lit(0) } } },
'legend');
async function make() {
  const f = await fixture((defs) => {
    defs.push({ ...clone(def(defs, 'fire')), definitionId: 'lightning', name: '测试基本雷能量', nameKey: 'lightning',
      mechanics: { category: 'basic', baseUnits: [['Lightning']], effects: [] } });
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.hp = 500;
    def(defs, 'other').mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:legend', name: '测试穹天传说GX', cost: ['Colorless'], printedDamage: null,
      specialRule: 'GX', effects: [scoop, legend], sourceOfTruth: EVIDENCE });
  });
  f.deck.splice(-2, 2, 'printing:fire', 'printing:lightning');
  return f;
}
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
// Player 0's Active has `energies` and the +30 Tool, a Benched Pokémon to replace it; player 1 has 「other」 in the Active Spot and three
// Benched Pokémon.
function setup(f, energies) {
  return board(f, (s) => {
    const m = s.players[0].active;
    for (const id of energies) attached(s, 0, m, id);
    m.tools.push(hand(s, 0, 'tool')); s.players[0].hand.pop();
    bench(s, 0, 'other');
    const p = s.players[1];
    p.hand.push(...p.active.stack); p.active = bench(s, 1, 'other'); p.bench.pop();
    for (const id of ['base', 'base', 'other']) bench(s, 1, id);
  });
}

test('rule: CN I.A-01 steps 4—5 with the JP Q&A on a printed discard before the damage', () => {
  const rule = requireRule(CN_V20261019, 'attack.damage-before-effects');
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.section.includes('I.A-01')));
  assert.equal(rule.sourceOfTruth.filter((s) => s.documentId === 'JP-official-qa').length, 2);
});

test('「…放回自己的牌库并重洗牌库。如果追加附有…，则给对手的3只宝可梦，各造成110点伤害」: the damage first, by a user still in play', async () => {
  const f = await make();
  const g = setup(f, ['water', 'fire', 'lightning', 'water']);
  const user = g.snapshot().players[0].active, cards = [...user.stack, ...user.energy, ...user.tools];
  command(g, { type: 'attack', attackId: 'base:legend' });
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'damage-targets');
  assert.equal(s.pending.minimum, 3);
  assert.equal(s.players[0].active.id, user.id, 'Step 4: the user and its cards are still in play while the targets are chosen.');
  assert.equal(s.players[0].gxUsed, true);
  const r = restore(g, f);
  answer(r, [s.players[1].active.id, s.players[1].bench[0].id, s.players[1].bench[1].id]);
  s = r.snapshot();
  // Its Tool (+30 to its attacks' damage) still counts, and its Water type meets the Active's Weakness (none on the Bench).
  assert.equal(s.players[1].active.counters, 28);
  assert.deepEqual(s.players[1].bench.map((m) => m.counters), [14, 14, 0]);
  // Step 5: then it goes back with every attached card, the deck is shuffled, and its owner replaces it.
  assert.equal(s.pending.kind, 'return-pokemon');
  answer(r, [user.id]); s = r.snapshot();
  assert.equal(s.pending.kind, 'promote'); assert.equal(s.pending.player, 0);
  assert(cards.every((id) => s.players[0].deck.includes(id)));
  const shuffled = s.events.findIndex((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0);
  assert(shuffled > s.events.findLastIndex((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')));
  answer(restore(r, f), s.pending.options);
  settle(r);
  assert.equal(r.snapshot().players[0].active.id, s.players[0].bench[0].id);
});

test('without one extra 【火】【水】【雷】 Energy each: no target is chosen, no damage; it still goes back', async () => {
  const f = await make();
  const g = setup(f, ['water', 'fire', 'lightning']);
  const user = g.snapshot().players[0].active;
  command(g, { type: 'attack', attackId: 'base:legend' });
  assert.equal(g.snapshot().pending.kind, 'return-pokemon', 'No damage-targets prompt: one unit pays the cost.');
  answer(g, [user.id]);
  const s = g.snapshot();
  assert.equal(s.pending.kind, 'promote');
  assert.equal(s.players[1].active.counters + s.players[1].bench.reduce((n, m) => n + m.counters, 0), 0);
  assert(user.stack.every((id) => s.players[0].deck.includes(id)));
  assert.equal(s.players[0].gxUsed, true);
});
