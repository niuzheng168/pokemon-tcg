// Synthetic definitions only. 「从自己的牌库中，选择1张从自己场上的1只【草】宝可梦进化而来的卡牌，放于该宝可梦身上进行进化。如果进化后该宝可梦为
// 【1阶进化】的话，则可以继续选择1张【2阶进化】使其进化。并重洗牌库。」, the Stadium 「双方玩家，每次在自己的回合有1次机会，可选择自己牌库中的1张，
// 从自己场上1只【基础】宝可梦进化而来的【1阶进化】宝可梦，放于那只宝可梦身上进行进化。如果进化了的话，则可以继续选择1张【2阶进化】宝可梦，使其进化。
// 并重洗牌库。（在自己最初的回合，以及在这个回合刚出场的【基础】宝可梦无法因此效果进化。）」 and the Supporter 「从自己的牌库中选择1张，从自己场上
// 1只宝可梦进化而来的「宝可梦GX」，放于该宝可梦身上进行进化。并重洗牌库。（对自己最初回合以及刚放出的宝可梦无法使用。） 另外，当使用这张卡牌时，可将
// 2张自己的手牌放于弃牌区。在这种情况下，将自己牌库中最多2张基本能量附着于进化后的宝可梦身上。」 (effects.evolve-bound). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const C12 = { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' };
const evolve = (extra = {}) => ({ op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon', types: ['Water'] }, from: 'deck',
  selector: { kind: 'pokemon' }, relation: 'ordinary', timing: C12, shuffleAfter: true, ...extra });
// The second evolution: the bound Pokémon if it is now a Stage 1, into a Stage 2, though it just evolved.
const again = evolve({ targetSelector: { kind: 'pokemon', stages: ['stage1'] }, selector: { kind: 'pokemon', stages: ['stage2'] },
  timing: { ...C12, evolvedThisTurn: 'allow' } });
const grow = { first: leaf('cn.pokemonTransition@1', evolve()), next: leaf('cn.pokemonTransition@1', again), use: 'pokemon' };
const forbid = { firstOwnTurn: 'forbid', enteredThisTurn: 'forbid', evolvedThisTurn: 'forbid' };
const tree = { first: leaf('cn.pokemonTransition@1', evolve({ targetSelector: { kind: 'pokemon', stages: ['basic'] },
  selector: { kind: 'pokemon', stages: ['stage1'] }, timing: forbid })),
next: leaf('cn.pokemonTransition@1', evolve({ targetSelector: { kind: 'pokemon' }, selector: { kind: 'pokemon', stages: ['stage2'] },
  timing: { ...forbid, evolvedThisTurn: 'allow' } })), use: 'pokemon' };
const gx = evolve({ targetSelector: { kind: 'pokemon' }, selector: { kind: 'pokemon', stages: ['stage1'] }, timing: forbid });
const energy = { op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'upTo', count: 2 },
  recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', remainder: 'shuffleDeck', reveal: false };
const redGreen = { effect: leaf('cn.thenMoved@1', { first: leaf('cn.pokemonTransition@1', gx), next: leaf('cn.attachDeckEnergy@1', energy),
  use: 'pokemon' }), otherwise: leaf('cn.pokemonTransition@1', gx) };
const cost = (count) => ({ costId: 'extra', kind: 'discardHand', count, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE });

// A Stage 2 evolving from 'evolution', and the deck holding Stage 1 and Stage 2 cards.
async function make(transform) {
  const f = await fixture((defs) => {
    const e = def(defs, 'evolution');
    defs.push({ ...e, definitionId: 'stage2', name: '测试2阶进化', nameKey: 'stage2', mechanics: { ...e.mechanics, stage: 'stage2',
      evolvesFrom: 'evolution', basicAncestor: { nameKey: 'base', sourceOfTruth: EVIDENCE } } });
    transform(defs);
  });
  for (const id of ['evolution', 'evolution', 'stage2', 'stage2']) f.deck[f.deck.indexOf('printing:water')] = `printing:${id}`;
  return f;
}
const pick = (g, id) => g.snapshot().pending.options.find((x) => g.snapshot().cards[x].definitionId === id);
const tops = (g, owner = 0) => { const p = g.snapshot().players[owner]; return [p.active, ...p.bench].map((m) => [m.id, m.stack.length]); };
const legal = (g, type) => g.view(g.snapshot().current).legalActions.filter((a) => a.type === type);

test('schema: an evolution reports the Pokémon it evolved; a Stadium use and a paid part may be one bound pair', () => {
  const moved = handlers.get('cn.thenMoved@1').validateParameters;
  assert(moved(grow));
  assert(moved({ ...grow, next: leaf('cn.attachDeckEnergy@1', energy) }));
  assert(!moved({ ...grow, first: leaf('cn.pokemonTransition@1', evolve({ target: 'bench', each: true })) }), 'Not one search per Pokémon.');
  assert(!moved({ ...grow, next: leaf('cn.pokemonTransition@1', { op: 'devolvePokemon', side: 'own', target: 'any', targetSelector: { kind: 'pokemon' },
    selection: { kind: 'exact', count: 1 }, layers: { kind: 'exact', count: 1 }, to: 'hand', chooser: 'source' }) }));
  assert(!moved({ ...grow, first: leaf('cn.pokemonTransition@1', { op: 'inheritPokemon', target: 'any', targetSelector: { kind: 'pokemon' },
    from: 'hand', selector: { kind: 'pokemon' }, relation: 'sameName', to: 'hand' }) }));
  const use = handlers.get('cn.stadiumUse@1').validateParameters;
  assert(use({ key: 'fixture:tree', effect: leaf('cn.thenMoved@1', tree) }));
  assert(!use({ key: 'fixture:tree', effect: leaf('cn.thenMoved@1', { ...tree, first: leaf('cn.draw@1', { count: 1 }) }) }));
  assert(!use({ key: 'fixture:tree', effect: leaf('cn.thenMoved@1', { counted: 'x:a:mill', next: leaf('cn.attachDiscard@1',
    { type: null, count: 1, benchOnly: false, optional: false, target: 'self' }), use: 'cards' }) }), 'No attack\'s counted entry.');
  assert(!use({ key: 'fixture:tree', effect: leaf('cn.thenMoved@1', { first: leaf('cn.discardDeckTop@1', { side: 'own', count: 1 }),
    next: leaf('cn.copyAttack@1', { op: 'copyAttack', origins: [{ side: 'own', zone: 'discard', selector: { kind: 'pokemon' } }], excludeUser: false,
      coin: 'none', energy: 'ignore', special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }), use: 'cards' }) }), 'No copy.');
  const paid = handlers.get('cn.ifPaid@1').validateParameters;
  assert(paid(redGreen));
  assert(paid({ effect: redGreen.effect }));
  assert(!paid({ ...redGreen, otherwise: leaf('cn.pokemonTransition@1', { ...gx, timing: C12 }) }), 'Otherwise is the same first part.');
  assert(!paid({ ...redGreen, effect: leaf('cn.thenMoved@1', { ...redGreen.effect.parameters, use: 'cards' }) }));
});

test('「如果进化后该宝可梦为【1阶进化】的话，则可以继续选择1张【2阶进化】使其进化」: only that Pokémon, though it just evolved', async () => {
  const f = await make((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.thenMoved@1', grow, 'grow')]; });
  let mon, stage1;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mon = bench(s, 0, 'base'); stage1 = bench(s, 0, 'evolution'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'transition-target'); assert(q.options.includes(mon.id) && q.options.includes(stage1.id));
  answer(g, [mon.id]);
  answer(g, [pick(g, 'evolution')]);
  q = restore(g, f).snapshot().pending;
  assert.equal(q.kind, 'transition-target');
  assert.deepEqual(q.options, [mon.id], 'The other Stage 1 is not the Pokémon that evolved.');
  answer(g, [mon.id]);
  // A saved second search keeps its bound Pokémon.
  const saved = clone(g.snapshot());
  saved.pending.data.transition = { pokemonId: stage1.id, topCardId: stage1.stack[0] };
  assert.throws(() => OfficialGame.restore(saved, { catalog: f.catalog }), /transition/);
  answer(g, [pick(g, 'stage2')]); settle(g);
  const s = g.snapshot(), evolved = s.players[0].bench.find((m) => m.id === mon.id);
  assert.deepEqual(evolved.stack.map((id) => s.cards[id].definitionId), ['base', 'evolution', 'stage2']);
  assert.equal(s.players[0].bench.find((m) => m.id === stage1.id).stack.length, 1);
  assert(s.events.filter((e) => e.ruleId === 'effects.shuffle' && e.data.zone === 'deck').length >= 2, 'Each search shuffles the deck.');
  restore(g, f);
});

test('a Stage 1 becoming a Stage 2, a declined or failed first search: no second evolution', async () => {
  const f = await make((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.thenMoved@1', grow, 'grow')]; });
  let stage1;
  let g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); stage1 = bench(s, 0, 'evolution'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  answer(g, [stage1.id]); answer(g, [pick(g, 'stage2')]);
  assert.notEqual(g.snapshot().pending?.kind, 'transition-target', 'Now a Stage 2: nothing more.');
  settle(g);
  assert.equal(g.snapshot().players[0].bench[0].stack.length, 2);
  g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'base'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  answer(g, [g.snapshot().players[0].bench[0].id]); answer(g, []);
  assert.notEqual(g.snapshot().pending?.kind, 'transition-target', 'Nothing evolved.');
  settle(g);
  assert.deepEqual(tops(g).map(([, n]) => n), [1, 1]);
});

test('Stadium 「如果进化了的话，则可以继续…」: not on the first turn or a Basic put into play this turn; the second only on that Pokémon', async () => {
  const f = await make((defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.stadiumUse@1', { key: 'fixture:tree', effect: leaf('cn.thenMoved@1', tree) }, 'tree')];
  });
  const inPlay = (s) => { const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id; };
  assert.equal(legal(board(f, (s) => { inPlay(s); fixtureClock(s, [0]); }), 'useStadium').length, 0, 'Not on one\'s own first turn.');
  assert.equal(legal(board(f, (s) => { inPlay(s); s.players[0].active.enteredTurn = s.turn; }), 'useStadium').length, 0, 'Put into play this turn.');
  let mon, stage1;
  const g = board(f, (s) => { inPlay(s); mon = bench(s, 0, 'base'); stage1 = bench(s, 0, 'evolution'); });
  command(g, { type: 'useStadium' });
  assert(!g.snapshot().pending.options.includes(stage1.id), 'Only Basic Pokémon first.');
  answer(g, [mon.id]); answer(g, [pick(g, 'evolution')]);
  const q = restore(g, f).snapshot().pending;
  assert.deepEqual(q.options, [mon.id]);
  answer(g, [mon.id]); answer(g, [pick(g, 'stage2')]); settle(g);
  assert.equal(g.snapshot().players[0].bench.find((m) => m.id === mon.id).stack.length, 3);
  assert.equal(legal(g, 'useStadium').length, 0, 'Once per turn.');
});

test('Supporter: the evolved Pokémon gets the deck Energy only when the optional discard was paid', async () => {
  const f = await make((defs) => {
    const d = def(defs, 'research');
    d.mechanics.effects = [binding('cn.ifPaid@1', redGreen, 'evolve')]; d.mechanics.optionalPlayCosts = [cost(2)];
  });
  let card, mon, extra;
  const setup = (s) => { card = hand(s, 0, 'research'); extra = [hand(s, 0, 'potion'), hand(s, 0, 'poison')]; mon = bench(s, 0, 'base'); };
  const entered = (s) => { setup(s); for (const m of [s.players[0].active, ...s.players[0].bench]) m.enteredTurn = s.turn; };
  assert(!legal(board(f, entered), 'playTrainer').some((a) => a.cardId === card), 'Not on Pokémon put into play this turn.');
  const g = board(f, setup);
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.kind, 'activation-cost');
  const declined = restore(g, f);
  answer(declined, []); answer(declined, [mon.id]); answer(declined, [pick(declined, 'evolution')]); settle(declined);
  let m = declined.snapshot().players[0].bench[0];
  assert.deepEqual([m.stack.length, m.energy.length], [2, 0]);
  answer(g, extra.map((id) => paymentOptionId('extra', id)));
  answer(g, [mon.id]); answer(g, [pick(g, 'evolution')]);
  let q = restore(g, f).snapshot().pending;
  assert.equal(q.kind, 'inspect-deck');
  answer(g, q.options.slice(0, 2));
  q = g.snapshot().pending;
  assert.equal(q.kind, 'deck-energy-recipient'); assert.deepEqual(q.options, [mon.id], 'Only the evolved Pokémon.');
  restore(g, f);
  answer(g, [mon.id]); settle(g);
  m = g.snapshot().players[0].bench[0];
  assert.deepEqual([m.stack.length, m.energy.length], [2, 2]);
  restore(g, f);
});

test('cost proofs: a deck evolution and a bound pair whose first part has one', async () => {
  const pair = (from) => ({ first: leaf('cn.pokemonTransition@1', evolve({ from, shuffleAfter: from === 'deck' })),
    next: leaf('cn.attachDeckEnergy@1', energy), use: 'pokemon' });
  for (const [from, ok] of [['deck', true], ['hand', false]]) {
    const f = await make((defs) => {
      const d = def(defs, 'potion');
      d.mechanics.effects = [binding('cn.thenMoved@1', pair(from), 'pair')]; d.mechanics.playCosts = [cost(1)];
    });
    if (ok) {
      let card;
      const g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'poison'); });
      assert(legal(g, 'playTrainer').some((a) => a.cardId === card));
    } else assert.throws(() => board(f), /cost/);
  }
  // A first part with an unconditional proof (a Bench search).
  const f = await make((defs) => {
    const d = def(defs, 'potion');
    d.mechanics.effects = [binding('cn.thenMoved@1', { first: leaf('cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
      quantity: { kind: 'upTo', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true }), next: leaf('cn.attachDeckEnergy@1', energy), use: 'pokemon' },
    'bench')];
    d.mechanics.playCosts = [cost(1)];
  });
  for (let i = 0; i < 2; i++) f.deck[f.deck.indexOf('printing:water')] = 'printing:base';
  let card, paid, mon;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); paid = hand(s, 0, 'poison'); });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, [paymentOptionId('extra', paid)]);
  answer(g, [g.snapshot().pending.options[0]]);
  mon = g.snapshot().players[0].bench.at(-1);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'inspect-deck'); answer(g, q.options.slice(0, 1));
  assert.deepEqual(g.snapshot().pending.options, [mon.id], 'Only the Pokémon put onto the Bench.');
  settle(g);
});
