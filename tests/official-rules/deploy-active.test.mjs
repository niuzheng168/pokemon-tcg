// Synthetic definitions only. 「将这只宝可梦，以及放于其身上的所有卡牌，放回手牌。然后，若希望，可直接将自己手牌中的「莉莉艾的皮皮玩偶」放于战斗场。」
// (effects.deploy-active; JP Q&A ピッピ「にんぎょうへんげ」: one doll, into the vacated Active Spot, played as an Item so an Item lock stops it, no
// loss in between with an empty Bench). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardsMove } from '../../public/rules/card-selection.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const scoop = leaf('cn.fieldReturn@1', { op: 'returnPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
  to: 'hand', attachments: 'return', chooser: 'source', promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } });
const place = (selector = { kind: 'trainer', nameKeys: ['doll'] }) => leaf('cn.cards@1', { from: 'hand', to: 'active', selector,
  quantity: { kind: 'upTo', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false });
const doll = (defs) => ({ ...def(defs, 'base'), definitionId: 'doll', name: '测试玩偶', nameKey: 'doll', mechanics: { ...def(defs, 'base').mechanics,
  hp: 30, types: ['Colorless'], weakness: null, retreatCost: 0, attacks: [], prizeCount: 0,
  itemCard: { leave: { from: 'active', to: 'deckBottom' }, sourceOfTruth: EVIDENCE } } });
async function make(more = () => {}) {
  const f = await fixture((defs) => {
    defs.push(doll(defs));
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.then@1', { first: scoop, next: place() }, 'doll')];
    more(defs);
  });
  f.deck.splice(20, 2, 'printing:doll', 'printing:doll');
  return f;
}
// The attack, then 「将这只宝可梦…放回手牌」 (the user is the one Pokémon offered).
const use = (g) => { command(g, { type: 'attack', attackId: 'other:strike' }); answer(g, g.snapshot().pending.options); };
const clefairy = (s) => { const p = s.players[0], m = bench(s, 0, 'other'); p.bench = [p.active]; p.active = m; attached(s, 0, m, 'water'); return m; };

test('schema: only after a part that vacates the user\'s own Active Spot, one hand card', async () => {
  const then = handlers.get('cn.then@1').validateParameters, cards = handlers.get('cn.cards@1').validateParameters;
  assert(then({ first: scoop, next: place() }));
  assert(!cards(place().parameters), 'Not on its own.');
  assert(!then({ first: leaf('cn.draw@1', { count: 1 }), next: place() }));
  assert(!then({ first: { ...scoop, parameters: { ...scoop.parameters, side: 'opponent', chooser: 'holder' } }, next: place() }));
  assert(!then({ first: scoop, next: leaf('cn.cards@1', { ...place().parameters, quantity: { kind: 'upTo', count: 2 } }) }));
  assert(!then({ first: scoop, next: leaf('cn.cards@1', { ...place().parameters, from: 'discard' }) }));
  const f = await make();
  const [item, basic, stage1] = ['doll', 'base', 'evolution'].map((id) => f.catalog.definition(id));
  assert(matchesCardsMove(item, place().parameters) && matchesCardsMove(basic, place({ kind: 'pokemon' }).parameters));
  assert(!matchesCardsMove(stage1, place({ kind: 'pokemon' }).parameters), 'Only what is put into play as a Basic Pokémon.');
  assert(!matchesCardsMove({ ...item, mechanics: { ...item.mechanics, itemCard: { ...item.mechanics.itemCard, setupOnly: true } } }, place().parameters));
});

test('「然后，若希望，可直接将…「X」放于战斗场」: the doll fills the vacated Active Spot, nothing is promoted, an empty Bench is no loss', async () => {
  const f = await make();
  let user, toy;
  const g = board(f, (s) => { user = clefairy(s); const old = s.players[0].bench.pop(); s.players[0].hand.push(...old.stack); toy = hand(s, 0, 'doll'); });
  use(g);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.deepEqual([q.minimum, q.maximum], [0, 1], 'One doll at most, or none.');
  assert(q.options.includes(toy) && q.options.every((id) => g.snapshot().cards[id].definitionId === 'doll'));
  restore(g, f);
  answer(g, [toy]); settle(g);
  const s = g.snapshot(), p = s.players[0];
  assert.deepEqual(p.active.stack, [toy]); assert.deepEqual(s.vacancies, [null, null]);
  assert(p.hand.includes(user.stack[0]), 'The user went back to the hand with its cards.');
  assert.equal(s.result, null);
  const deploy = s.events.find((e) => e.ruleId === 'effects.deploy' && e.data.cardId);
  assert.deepEqual([deploy.data.from, deploy.data.to, deploy.data.cardId], ['hand', 'active', toy]);
  restore(g, f);
});

test('declined, or stopped by an Item lock: the Bench Pokémon is promoted as after any such return', async () => {
  const lock = binding('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playItem'] } }, 'lock');
  const f = await make((defs) => def(defs, 'evolution').mechanics.effects.push(lock));
  let benched;
  let g = board(f, (s) => { clefairy(s); benched = s.players[0].bench[0]; hand(s, 0, 'doll'); });
  use(g);
  answer(g, []);
  assert.equal(g.snapshot().pending.kind, 'promote');
  settle(g);
  assert.equal(g.snapshot().players[0].active.id, benched.id);
  g = board(f, (s) => { clefairy(s); benched = s.players[0].bench[0]; hand(s, 0, 'doll'); bench(s, 1, 'evolution'); });
  use(g);
  assert.equal(g.snapshot().pending.kind, 'promote', 'The doll is not offered.');
  settle(g);
  assert.equal(g.snapshot().players[0].active.id, benched.id);
});
