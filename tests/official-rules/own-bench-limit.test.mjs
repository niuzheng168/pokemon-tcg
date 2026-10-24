// Synthetic definitions only. 「这个特性只有当自己场上所有的宝可梦都是【恶】属性的场合才生效。能够放于自己备战区的【恶】宝可梦的数量变为8只，且
// 无法将其他属性的宝可梦放于自己场上。（当这个特性失效时，将备战宝可梦放于弃牌区，直到备战宝可梦的数量变为5只为止。）」 (bench.limit-own,
// effects.enter-lock; JP official Q&A ムゲンダイナVMAX「ムゲンゾーン」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, hand, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const notDark = { kind: 'pokemon', excludeTypes: ['Darkness'] };
const allDark = { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'field', selector: notDark }, relation: 'eq',
  right: { kind: 'literal', value: 0 } };
const limit = { op: 'benchLimit', scope: 'own', limit: 8, condition: allDark };
const lock = { op: 'playerRestriction', scope: 'own', actions: ['enterPlay'], cardSelector: notDark, condition: allDark };
const kind = (d, id, types, extra = {}) => ({ ...d, definitionId: id, nameKey: id, name: `测试${id}`,
  mechanics: { ...d.mechanics, types, attacks: d.mechanics.attacks.map((a) => ({ ...a, attackId: `${id}:strike` })), ...extra } });
const piece = (d, n) => ({ ...kind(d, `vu${n}`, ['Water'], { stage: 'V-UNION', hp: 310, ruleBox: true, prizeCount: 3, tags: ['V', 'V-UNION'],
  vUnion: { piece: n, sourceOfTruth: EVIDENCE } }), name: '测试V-UNION', nameKey: 'vu' });
// 'other' is the source (Darkness); 'base' a Darkness Basic; 'evolution' a Grass Stage 1 of it; 'dual' a Darkness/Metal Stage 1;
// 'grass' a Grass Basic. Test-only deck shape: enough Darkness Basics for an eight-Pokémon Bench, and the V-UNION pieces.
const zone = async (transform = () => {}) => {
  const f = await fixture((defs) => {
    const base = def(defs, 'base');
    def(defs, 'other').mechanics.types = ['Darkness']; base.mechanics.types = ['Darkness']; def(defs, 'evolution').mechanics.types = ['Grass'];
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:zone', name: '测试无极领域', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.benchLimit@1', { effect: limit }, 'limit'), binding('cn.playerRestriction@1', { effect: lock }, 'lock')] }];
    defs.push(kind(base, 'grass', ['Grass']), kind(def(defs, 'evolution'), 'dual', ['Darkness', 'Metal']),
      ...[1, 2, 3, 4].map((n) => piece(base, n)));
    base.deckLimits.sameName = null;
    transform(defs);
  });
  for (let i = 0; i < 10; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:base';
  f.deck.splice(30, 7, 'printing:grass', 'printing:dual', 'printing:vu1', 'printing:vu2', 'printing:vu3', 'printing:vu4', 'printing:grass');
  return f;
};
const cardTypes = (f, s, id) => f.catalog.definition(s.cards[id].definitionId).mechanics.types;
const fill = (s, owner, count, id = 'base') => Array.from({ length: count }, () => bench(s, owner, id));
const actionsOf = (g, type, player = 0) => g.view(player).legalActions.filter((a) => a.type === type);
// The board's Active is a Darkness 'base'; this puts another card there instead.
const activate = (s, owner, id) => { const p = s.players[owner], card = hand(s, owner, id); p.hand.pop(); p.hand.push(...p.active.stack); p.active.stack = [card]; };
const toDiscard = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(card); return card; };

test('schemas: an own-player limit with a condition; an enter lock names the Pokémon it locks out, and never as a turn-long player effect', () => {
  const benchLimit = (e) => handlers.get('cn.benchLimit@1').validateParameters({ effect: e });
  assert(benchLimit(limit)); assert(benchLimit({ op: 'benchLimit', scope: 'own', limit: 8 }));
  const restriction = (e) => handlers.get('cn.playerRestriction@1').validateParameters({ effect: e });
  assert(restriction(lock));
  const { cardSelector: _c, ...bare } = lock;
  assert(!restriction(bare), 'enterPlay needs the Pokémon it locks out.');
  assert(!restriction({ ...lock, actions: ['playItem'] }), 'A card selector only with enterPlay.');
  assert(!restriction({ ...lock, cardSelector: { kind: 'trainer' } }));
  const timed = (effect) => handlers.get('cn.lastingPlayer@1').validateParameters({ side: 'opponent', duration: 'nextOpponentTurn', effect });
  assert(timed({ op: 'playerRestriction', scope: 'all', actions: ['playItem'] }));
  assert(!timed({ op: 'playerRestriction', scope: 'all', actions: ['enterPlay'], cardSelector: notDark }));
});

test('while every own Pokémon is Darkness: an eight-Pokémon Bench for its player only, and no other type enters by hand', async () => {
  const f = await zone();
  let ids;
  const g = board(f, (s) => {
    bench(s, 0, 'other'); fill(s, 0, 4); fill(s, 1, 5);
    ids = { dark: hand(s, 0, 'base'), grass: hand(s, 0, 'grass'), evolution: hand(s, 0, 'evolution'), dual: hand(s, 0, 'dual') };
    hand(s, 1, 'base');
  });
  assert.equal(g.view(0).players[0].benchLimit, 8); assert.equal(g.view(0).players[1].benchLimit, 5, 'Its own player only.');
  const benched = actionsOf(g, 'bench').map((a) => a.cardId);
  assert(benched.includes(ids.dark) && !benched.includes(ids.grass), 'A Darkness Basic, never the Grass one.');
  assert(!actionsOf(g, 'evolve').some((a) => a.cardId === ids.evolution), 'Nor evolving into a Grass Pokémon (JP Q&A アリアドス).');
  assert(actionsOf(g, 'evolve').some((a) => a.cardId === ids.dual), 'A Pokémon that is also Darkness may (JP Q&A キリキザン).');
  command(g, { type: 'evolve', cardId: ids.dual, pokemonId: actionsOf(g, 'evolve').find((a) => a.cardId === ids.dual).pokemonId }); settle(g);
  assert.equal(g.view(0).players[0].benchLimit, 8, 'Still working.');
  command(g, { type: 'bench', cardId: ids.dark }); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 6);
  assert.deepEqual(actionsOf(g, 'bench', 1), [], 'The opponent stays at five (and it is not their turn).');
  restore(g, f);
});

test('not every own Pokémon Darkness: the Ability does nothing — five, and any type enters', async () => {
  const f = await zone();
  let grass;
  const g = board(f, (s) => { activate(s, 0, 'grass'); bench(s, 0, 'other'); fill(s, 0, 4); grass = hand(s, 0, 'grass'); });
  assert.equal(g.view(0).players[0].benchLimit, 5, 'A Grass Active.');
  assert.deepEqual(actionsOf(g, 'bench'), []);
  const h = board(f, (s) => { activate(s, 0, 'grass'); bench(s, 0, 'other'); grass = hand(s, 0, 'grass'); });
  assert(actionsOf(h, 'bench').some((a) => a.cardId === grass));
});

test('effects of either player cannot put another type onto that player\'s field (JP Q&A ジュペッタ「あかいまなこ」)', async () => {
  const deckBench = { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'upTo', count: 2 },
    reveal: false, lookTop: null, shuffleAfter: true };
  const f = await zone((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', deckBench, 'nest')];
    def(defs, 'poison').mechanics.effects = [binding('cn.cards@1', { from: 'discard', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
      quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false, side: 'opponent' }, 'eyes')];
  });
  let ball;
  const g = board(f, (s) => { bench(s, 0, 'other'); ball = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: ball });
  const q = g.snapshot().pending, s = g.snapshot();
  assert.equal(q.kind, 'select-cards');
  assert(s.players[0].deck.some((id) => s.cards[id].definitionId === 'grass'));
  assert(q.options.length && q.options.every((id) => cardTypes(f, s, id).includes('Darkness')), 'Only the Darkness Basics in the deck.');
  answer(g, q.options.slice(0, 2)); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 3);
  // The opponent's own effect choosing a Grass Basic from this player's discard pile.
  let eyes;
  const h = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    bench(s, 0, 'other');
    toDiscard(s, 0, 'grass'); eyes = hand(s, 1, 'poison');
  });
  assert(!actionsOf(h, 'playTrainer', 1).some((a) => a.cardId === eyes), 'Its only possible choice is locked out: nothing would change.');
});

test('a V-UNION of another type is not assembled onto that Bench either', async () => {
  const f = await zone();
  const g = board(f, (s) => {
    bench(s, 0, 'other');
    for (const n of [1, 2, 3, 4]) toDiscard(s, 0, `vu${n}`);
  });
  assert.deepEqual(actionsOf(g, 'vUnion'), []);
  const h = board(f, (s) => { activate(s, 0, 'grass'); bench(s, 0, 'other'); for (const n of [1, 2, 3, 4]) toDiscard(s, 0, `vu${n}`); });
  assert.equal(actionsOf(h, 'vUnion').length, 1, 'Not working with a Grass Active.');
});

test('when it stops working the Bench goes down to five at the next rule boundary; another source keeps it (JP Q&A)', async () => {
  const scoop = { op: 'returnPokemon', side: 'own', target: 'bench', selector: { kind: 'pokemon', nameKeys: ['other'] },
    quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source' };
  const f = await zone((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.fieldReturn@1', scoop, 'scoop')]; });
  let ball, sources;
  const g = board(f, (s) => {
    sources = [bench(s, 0, 'other')]; fill(s, 0, 7); ball = hand(s, 0, 'potion');
  });
  command(g, { type: 'playTrainer', cardId: ball });
  answer(g, [sources[0].id]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.minimum, 2); assert.equal(q.maximum, 2);
  restore(g, f);
  answer(g, q.options.slice(0, 2)); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 5);
  assert.equal(g.snapshot().players[1].prizes.length, 6, 'Not Knocked Out.');
  // Two sources: one leaving changes nothing.
  const h = board(f, (s) => {
    sources = [bench(s, 0, 'other'), bench(s, 0, 'other')]; fill(s, 0, 6); ball = hand(s, 0, 'potion');
  });
  command(h, { type: 'playTrainer', cardId: ball }); answer(h, [sources[0].id]); settle(h);
  assert.equal(h.snapshot().players[0].bench.length, 7);
});

test('its Active source Knocked Out: the Bench is trimmed before a new Active Pokémon is chosen (JP Q&A)', async () => {
  const f = await zone((defs) => { def(defs, 'base').mechanics.attacks[0].printedDamage.value = 100; });
  const g = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    activate(s, 0, 'other'); fill(s, 0, 8);
    attached(s, 1, s.players[1].active, 'water');
  });
  assert.equal(g.view(1).players[0].benchLimit, 8);
  command(g, { type: 'attack', attackId: 'base:strike' }, 1);
  const kinds = [];
  settle(g, (q) => { kinds.push(q.kind); return q.options.slice(0, q.minimum || 1); });
  assert(kinds.indexOf('bench-trim') >= 0 && kinds.indexOf('bench-trim') < kinds.indexOf('promote'), kinds.join());
  const s = g.snapshot();
  assert.equal(s.players[0].bench.length, 4, 'Trimmed to five, then one became the Active Pokémon.');
  assert.equal(s.players[1].prizes.length, 5);
});

test('nor by the card\'s own Ability, an Ability as it is drawn, or an effect evolving from the hand (JP Q&A メテノ, ジラーチ◇)', async () => {
  const rise = { abilityId: 'grass:rise', name: '测试复苏', mode: 'activated', zone: 'discard', sourceOfTruth: EVIDENCE,
    usage: { period: 'turn', scope: 'pokemon', key: 'rise', limit: 1 }, effects: [binding('cn.deploySelf@1', {}, 'rise')] };
  const drawn = { abilityId: 'grass:drawn', name: '测试首发进场', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
    trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'turnStart', optional: true, afterUse: 'hand' },
    effects: [binding('cn.deployIncoming@1', {}, 'drawn')] };
  const candy = { op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon' }, from: 'hand', selector: { kind: 'pokemon' },
    relation: 'ordinary', timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' }, shuffleAfter: false };
  const f = await zone((defs) => {
    def(defs, 'grass').mechanics.abilities = [rise, drawn];
    def(defs, 'potion').mechanics.effects = [binding('cn.pokemonTransition@1', candy, 'candy')];
  });
  let card, item;
  const locked = board(f, (s) => { bench(s, 0, 'other'); card = toDiscard(s, 0, 'grass'); item = hand(s, 0, 'potion'); hand(s, 0, 'evolution'); });
  assert(!locked.view(0).legalActions.some((a) => a.cardId === card), 'Its own Ability cannot put it onto that Bench.');
  assert(!actionsOf(locked, 'playTrainer').some((a) => a.cardId === item), 'Only a Grass Stage 1 to evolve into: nothing would change.');
  const open = board(f, (s) => {
    activate(s, 0, 'grass'); bench(s, 0, 'other'); bench(s, 0, 'base'); card = toDiscard(s, 0, 'grass'); item = hand(s, 0, 'potion'); hand(s, 0, 'evolution');
  });
  assert(open.view(0).legalActions.some((a) => a.cardId === card));
  assert(actionsOf(open, 'playTrainer').some((a) => a.cardId === item));
  const dual = board(f, (s) => { bench(s, 0, 'other'); item = hand(s, 0, 'potion'); hand(s, 0, 'dual'); });
  command(dual, { type: 'playTrainer', cardId: item }); settle(dual, (q) => q.options.slice(0, Math.max(1, q.minimum)));
  const evolvedTops = (g) => { const s = g.snapshot(); return [s.players[0].active, ...s.players[0].bench].map((m) => s.cards[m.stack.at(-1)].definitionId); };
  assert(evolvedTops(dual).includes('dual'), evolvedTops(dual).join());
  // Drawn at the start of the turn: not offered while locked; it goes to the hand.
  const draw = board(f, (s) => { bench(s, 0, 'other'); card = hand(s, 0, 'grass'); s.players[0].hand.pop(); s.players[0].deck.push(card); });
  command(draw, { type: 'endTurn' }); settle(draw); command(draw, { type: 'endTurn' }); settle(draw);
  const s = draw.snapshot();
  assert.equal(s.current, 0); assert(s.players[0].hand.includes(card)); assert(!s.events.some((e) => e.ruleId === 'trigger.before-hand' && e.data.performed));
  const free = board(f, (s) => { activate(s, 0, 'grass'); bench(s, 0, 'other'); card = hand(s, 0, 'grass'); s.players[0].hand.pop(); s.players[0].deck.push(card); });
  command(free, { type: 'endTurn' }); settle(free); command(free, { type: 'endTurn' });
  settle(free, (q) => q.kind === 'before-hand-optional' ? ['perform'] : q.options.slice(0, q.minimum));
  assert(free.snapshot().players[0].bench.some((m) => m.stack.includes(card)), 'Unlocked, it enters as it is drawn.');
});
