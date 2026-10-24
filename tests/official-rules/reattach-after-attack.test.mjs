// Synthetic definitions only. 「只要这张卡牌，被附着于宝可梦身上，就被视作1个【无】能量。」
// 「如果因为身上附着了这张卡牌的宝可梦所使用的招式的效果，而导致这张卡牌被放于弃牌区的话，则在处理完招式的伤害和效果后，将这张卡牌附着回原来的宝可梦身上。」
// (energy.reattach-after-attack). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const discardEnergy = (from = 'self', side = 'own', quantity = { kind: 'exact', count: 1 }) => ({ op: 'discardEnergy', side, from,
  selector: { kind: 'energy' }, providedTypes: null, measure: 'cards', quantity, chooser: 'source' });
// The fixture's Special Energy becomes this card.
const boomerang = (defs) => {
  def(defs, 'double').mechanics = { category: 'special', baseUnits: [['Colorless']], effects: [binding('cn.reattachAfterAttack@1', {}, 'boomerang')] };
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
};
const withAttack = (effects, more = () => {}) => fixture((defs) => { boomerang(defs); defs[0].mechanics.attacks[0].effects = effects; more(defs); });
const attack = (g, pick) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, (q) => pick(q) ?? (q.allowZero ? [] : q.options.slice(0, q.minimum))); };
const reattached = (s) => s.events.filter((e) => e.ruleId === 'energy.reattach-after-attack');

test('the rule cites the attack sequence; the handler is a Special Energy\'s own continuous text', async () => {
  assert(requireRule(CN_V20261019, 'energy.reattach-after-attack').sourceOfTruth.length >= 2);
  const h = handlers.get('cn.reattachAfterAttack@1');
  assert.deepEqual([h.timing, h.validateParameters({}), h.validateParameters({ to: 'hand' })], ['continuous', true, false]);
  const tool = await fixture((defs) => { def(defs, 'tool').mechanics.effects = [binding('cn.reattachAfterAttack@1', {}, 'boomerang')]; });
  assert.throws(() => board(tool), /Special Energy/);
});

test('discarded by its holder\'s own attack: attached back to that Pokémon after the damage and effects; another Energy is not', async () => {
  const f = await withAttack([binding('cn.attachedEnergy@1', discardEnergy(), 'toss')]);
  let card, water, mon;
  const g = board(f, (s) => { mon = s.players[0].active; water = attached(s, 0, mon, 'water'); card = attached(s, 0, mon, 'double'); });
  attack(g, (q) => q.options.includes(card) ? [card] : null);
  const s = g.snapshot(), m = s.players[0].active;
  assert.equal(m.id, mon.id);
  assert.deepEqual([m.energy.includes(card), m.energy.includes(water), s.players[0].discard.includes(card)], [true, true, false]);
  assert.equal(s.players[1].active.counters, 2, 'The damage was dealt.');
  const order = s.events.map((e) => e.ruleId);
  const discarded = s.events.findIndex((e) => e.ruleId === 'energy.attached-selection' && e.data.energyId === card && e.data.discarded);
  assert(discarded >= 0 && discarded < order.indexOf('energy.reattach-after-attack'));
  assert.deepEqual(reattached(s).map((e) => [e.data.player, e.data.cardId, e.data.pokemonId, e.data.effectId]),
    [[0, card, mon.id, 'fixture:boomerang']]);
  assert.equal(s.attack, null);
  restore(g, f);
  // The Basic Energy chosen instead stays in the discard pile.
  const h = board(f, (s) => { mon = s.players[0].active; water = attached(s, 0, mon, 'water'); card = attached(s, 0, mon, 'double'); });
  attack(h, (q) => q.options.includes(water) ? [water] : null);
  assert(h.snapshot().players[0].discard.includes(water));
  assert.deepEqual(reattached(h.snapshot()), []);
});

test('not by another Pokémon\'s attack, a Trainer, or while Special Energy effects are gone (II.C-03 / Q&A: シンオウ神殿)', async () => {
  // The user's attack discarding it from a Benched Pokémon of theirs.
  const bench0 = await withAttack([binding('cn.attachedEnergy@1', discardEnergy('bench'), 'toss')]);
  let card;
  const g = board(bench0, (s) => { attached(s, 0, s.players[0].active, 'water'); card = attached(s, 0, bench(s, 0, 'other'), 'double'); });
  attack(g, () => null);
  assert(g.snapshot().players[0].discard.includes(card));
  assert.deepEqual(reattached(g.snapshot()), []);
  // The opponent's attack discarding it from the Defending Pokémon.
  const theirs = await withAttack([binding('cn.attachedEnergy@1', discardEnergy('active', 'opponent'), 'strip')]);
  const h = board(theirs, (s) => { attached(s, 0, s.players[0].active, 'water'); card = attached(s, 1, s.players[1].active, 'double'); });
  attack(h, () => null);
  assert(h.snapshot().players[1].discard.includes(card));
  assert.deepEqual(reattached(h.snapshot()), []);
  // An Item discarding it.
  const item = await fixture((defs) => { boomerang(defs); def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', discardEnergy('active'), 'hammer')]; });
  let potion;
  const i = board(item, (s) => { card = attached(s, 0, s.players[0].active, 'double'); potion = hand(s, 0, 'potion'); });
  command(i, { type: 'playTrainer', cardId: potion }); settle(i);
  assert(i.snapshot().players[0].discard.includes(card));
  // Special Energy effects removed by a Stadium.
  const shrine = await withAttack([binding('cn.attachedEnergy@1', discardEnergy(), 'toss')], (defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'specialEnergy', scope: 'all' } }, 'shrine')];
  });
  const j = board(shrine, (s) => { attached(s, 0, s.players[0].active, 'water'); card = attached(s, 0, s.players[0].active, 'double');
    s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); });
  attack(j, (q) => q.options.includes(card) ? [card] : null);
  assert(j.snapshot().players[0].discard.includes(card));
  assert.deepEqual(reattached(j.snapshot()), []);
  restore(j, shrine);
});

test('no longer in the discard pile, or its Pokémon gone, when the attack ends: it stays where it is', async () => {
  // 「…然后，将弃牌区中的1张特殊能量附着于备战宝可梦身上」 taking that very card.
  const moved = await withAttack([binding('cn.attachedEnergy@1', discardEnergy(), 'toss'),
    binding('cn.attachDiscard@1', { type: null, category: 'special', count: 1, benchOnly: true, optional: false }, 'recycle')]);
  let card, benched;
  const g = board(moved, (s) => { attached(s, 0, s.players[0].active, 'water'); card = attached(s, 0, s.players[0].active, 'double');
    benched = bench(s, 0, 'other'); s.players[0].discard.splice(0); });
  attack(g, (q) => q.options.includes(card) ? [card] : q.options.includes(benched.id) ? [benched.id] : null);
  let s = g.snapshot();
  assert(s.players[0].bench[0].energy.includes(card));
  assert.deepEqual(reattached(s), []);
  restore(g, moved);
  // 「…然后，将这只宝可梦以及放于其身上的所有卡牌，放回手牌」: the Pokémon is no longer in play.
  const gone = await withAttack([binding('cn.attachedEnergy@1', discardEnergy(), 'toss'),
    binding('cn.fieldReturn@1', { op: 'returnPokemon', side: 'own', target: 'active', selector: { kind: 'pokemon' },
      quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
      promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } }, 'leave')]);
  let mon;
  const h = board(gone, (s) => { mon = s.players[0].active; attached(s, 0, mon, 'water'); card = attached(s, 0, mon, 'double'); bench(s, 0, 'other'); });
  attack(h, (q) => q.options.includes(card) ? [card] : null);
  s = h.snapshot();
  assert(s.players[0].discard.includes(card) && s.players[0].hand.includes(mon.stack[0]));
  assert(![s.players[0].active, ...s.players[0].bench].some((m) => m?.id === mon.id));
  assert.deepEqual(reattached(s), []);
});
