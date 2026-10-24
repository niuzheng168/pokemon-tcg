// Synthetic definitions only. 「在这个回合，自己可以使用的支援者数量变为3张。（包括这张卡牌。）」, 「在下一个自己的回合，自己可以从手牌将任意张
// 能量附着于宝可梦身上。」, 「另外，当使用这张卡牌时，可将5张自己的手牌放于弃牌区。在这种情况下，在这个回合，即使自己已经使用过GX招式了，自己的
// 【水】宝可梦，依然可以使用GX招式。」 and 「在这个回合，自己的「X」，即使自己已经使用过GX招式，仍然可以使用GX招式。」 (trainer.supporter-limit,
// turn.energy-limit, attack.special-rule-reuse; JP official Q&A マチスの作戦, ハクリュー「りゅうのいのり」, カスミ&カンナ, ユリーカ).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const limit = (effect, duration = 'thisTurn') => ({ side: 'own', duration, effect: { op: 'playerLimit', ...effect } });
const surge = limit({ action: 'playSupporter', count: 3 });
const water = { kind: 'pokemon', types: ['Water'] };
const reuse = (targetSelector = water) => limit({ action: 'gxAttack', targetSelector });
const playable = (g, card, player = 0) => g.view(player).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const attacks = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'attack').map((a) => a.attackId);
const attachable = (g, card, player = 0) => g.view(player).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === card);
const play = (g, card) => { command(g, { type: 'playTrainer', cardId: card }); settle(g); };
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };
// Test-only deck shape: several copies of the synthetic Trainers.
const withCopies = async (transform) => {
  const f = await fixture(transform);
  f.deck.splice(20, 8, 'printing:research', 'printing:research', 'printing:potion', 'printing:potion', 'printing:poison', 'printing:poison',
    'printing:poison', 'printing:double');
  return f;
};
const fewerPrizes = (s, owner) => { s.players[owner].hand.push(s.players[owner].prizes.pop()); };

test('schema: a player limit is the user\'s own; Supporters need a count, a GX reuse may name its Pokémon', () => {
  const valid = handlers.get('cn.lastingPlayer@1').validateParameters;
  assert(valid(surge)); assert(valid(reuse())); assert(valid(limit({ action: 'gxAttack' })));
  assert(valid(limit({ action: 'attachEnergy' }, 'nextOwnTurn')));
  for (const bad of [{ ...surge, side: 'opponent' }, limit({ action: 'playSupporter' }), limit({ action: 'attachEnergy', count: 2 }),
    limit({ action: 'attachEnergy', targetSelector: water }), limit({ action: 'playSupporter', count: 1 }), limit({ action: 'retreat' })])
    assert(!valid(bad), JSON.stringify(bad));
});

// 'research' is 「马志士的作战策略」; 'potion' and 'poison' are made Supporters ('poison' draws: a second Poison of the same
// Pokémon would change nothing, status.no-change).
const strategy = () => withCopies((defs) => {
  def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', surge, 'surge')];
  def(defs, 'research').mechanics.condition = { prizesRemaining: 'moreThanOpponent' };
  def(defs, 'potion').mechanics.category = 'supporter'; def(defs, 'poison').mechanics.category = 'supporter';
  def(defs, 'poison').mechanics.effects = [binding('cn.draw@1', { count: 1 }, 'draw')];
});

test('「自己可以使用的支援者数量变为3张（包括这张卡牌）」: three in all this turn, then one again (JP Q&A マチスの作戦)', async () => {
  const f = await strategy();
  let ids;
  const g = board(f, (s) => {
    fewerPrizes(s, 1); s.players[0].active.counters = 3;
    ids = { surge: hand(s, 0, 'research'), again: hand(s, 0, 'research'), potion: hand(s, 0, 'potion'), poison: [hand(s, 0, 'poison'), hand(s, 0, 'poison')] };
  });
  assert(playable(g, ids.surge));
  play(g, ids.surge);
  assert(!playable(g, ids.again), 'A second one changes nothing.');
  play(g, ids.potion);
  assert(playable(g, ids.poison[0]));
  play(g, ids.poison[0]);
  assert(!playable(g, ids.poison[1]), 'Three Supporters, this card included.');
  assert(g.snapshot().playerOngoing.some((e) => e.player === 0 && e.effect.op === 'playerLimit' && e.effect.count === 3));
  restore(g, f);
  endTurn(g); endTurn(g);
  play(g, ids.poison[1]);
  assert(!playable(g, ids.again), 'Its own turn only: one Supporter again.');
  // Without it, the usual one; and not when its Prize condition fails.
  const plain = board(f, (s) => { fewerPrizes(s, 1); ids = { potion: hand(s, 0, 'poison'), poison: hand(s, 0, 'poison'), surge: hand(s, 0, 'research') }; });
  play(plain, ids.potion);
  assert(!playable(plain, ids.poison)); assert(!playable(plain, ids.surge));
  const behind = board(f, (s) => { ids = { surge: hand(s, 0, 'research') }; });
  assert(!playable(behind, ids.surge));
});

test('「在下一个自己的回合，自己可以从手牌将任意张能量附着于宝可梦身上」: any number, special Energy too, only that turn (JP Q&A ハクリュー)', async () => {
  const f = await withCopies((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0];
    a.printedDamage = null; a.effects = [binding('cn.lastingPlayer@1', limit({ action: 'attachEnergy' }, 'nextOwnTurn'), 'prayer')];
  });
  let cards;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    cards = [hand(s, 0, 'water'), hand(s, 0, 'water'), hand(s, 0, 'double'), hand(s, 0, 'water')];
    hand(s, 1, 'water'); hand(s, 1, 'water');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const foe = g.snapshot().players[1].hand.filter((id) => g.snapshot().cards[id].definitionId === 'water');
  command(g, { type: 'attachEnergy', cardId: foe[0], pokemonId: g.snapshot().players[1].active.id }, 1); settle(g);
  assert(!attachable(g, foe[1], 1), 'Not the opponent, and not during the opponent\'s turn.');
  endTurn(g);
  const me = g.snapshot().players[0].active.id;
  for (const card of cards.slice(0, 3)) { command(g, { type: 'attachEnergy', cardId: card, pokemonId: me }); settle(g); }
  assert(attachable(g, cards[3]));
  assert(g.snapshot().playerOngoing.some((e) => e.player === 0 && e.effect.op === 'playerLimit' && e.effect.action === 'attachEnergy'));
  restore(g, f);
  endTurn(g); endTurn(g);
  assert(attachable(g, cards[3]));
  command(g, { type: 'attachEnergy', cardId: cards[3], pokemonId: me }); settle(g);
  assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy'), 'One a turn again.');
});

// 'research' is 「小霞&科拿」; 'base' (Water) and 'other' have a GX attack.
const misty = () => withCopies((defs) => {
  const d = def(defs, 'research');
  d.mechanics.effects = [
    binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'energy', category: 'basic', types: ['Water'] },
      quantity: { kind: 'upTo', count: 3 }, reveal: true, lookTop: null, shuffleAfter: true }, 'search'),
    binding('cn.ifPaid@1', { effect: leaf('cn.lastingPlayer@1', reuse()) }, 'reuse'),
  ];
  d.mechanics.optionalPlayCosts = [{ costId: 'extra', kind: 'discardHand', count: 5, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }];
  def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', surge, 'surge')];
  def(defs, 'potion').mechanics.category = 'supporter';
  for (const id of ['base', 'other']) {
    const m = def(defs, id).mechanics; m.attacks[0].specialRule = 'GX'; m.ruleBox = true; m.prizeCount = 2; m.tags = ['GX'];
  }
});
const pay = (g, card, discard) => {
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.kind, 'activation-cost');
  answer(g, discard.map((id) => paymentOptionId('extra', id))); settle(g);
};

test('「即使自己已经使用过GX招式了，自己的【水】宝可梦，依然可以使用GX招式」: this turn only, and using it still counts (JP Q&A カスミ&カンナ)', async () => {
  const f = await misty();
  let card, discard;
  const g = board(f, (s) => {
    s.players[0].gxUsed = true; attached(s, 0, s.players[0].active, 'water');
    card = hand(s, 0, 'research'); discard = [1, 2, 3, 4, 5].map(() => hand(s, 0, 'water'));
  });
  assert.deepEqual(attacks(g), []);
  pay(g, card, discard);
  assert.deepEqual(attacks(g), ['base:strike']);
  restore(g, f);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[0].gxUsed, true); assert.equal(g.snapshot().players[1].active.counters, 2);
  assert(g.snapshot().events.some((e) => e.ruleId === 'attack.used'));
  endTurn(g);
  assert.deepEqual(attacks(g), [], 'Not on a later turn.');
});

test('before any GX attack, or with the same effect already this turn, nothing may be discarded for it', async () => {
  const f = await misty();
  let ids;
  const fresh = board(f, (s) => { ids = [hand(s, 0, 'research'), ...[1, 2, 3, 4, 5].map(() => hand(s, 0, 'water'))]; });
  command(fresh, { type: 'playTrainer', cardId: ids[0] });
  assert.notEqual(fresh.snapshot().pending?.kind, 'activation-cost', 'No GX attack used yet: nothing to change.');
  const twice = board(f, (s) => {
    s.players[0].gxUsed = true;
    ids = [hand(s, 0, 'potion'), hand(s, 0, 'research'), hand(s, 0, 'research'), ...[1, 2, 3, 4, 5].map(() => hand(s, 0, 'water'))];
    fewerPrizes(s, 1);
  });
  play(twice, ids[0]);
  pay(twice, ids[1], ids.slice(3));
  command(twice, { type: 'playTrainer', cardId: ids[2] });
  assert.notEqual(twice.snapshot().pending?.kind, 'activation-cost', 'Already in effect (JP Q&A マチスの作戦→カスミ&カンナ).');
});

// 'research' is a plain Supporter with the reuse; 'other' (Fire) has a GX attack too; 'tool' makes its holder Water.
const plainReuse = (targetSelector, transform = () => {}) => withCopies((defs) => {
  def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', reuse(targetSelector), 'reuse')];
  for (const id of ['base', 'other']) {
    const m = def(defs, id).mechanics; m.attacks[0].specialRule = 'GX'; m.ruleBox = true; m.prizeCount = 2; m.tags = ['GX'];
  }
  def(defs, 'other').mechanics.types = ['Fire']; def(defs, 'other').mechanics.attacks[0].cost = [];
  def(defs, 'tool').mechanics.effects = [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types: ['Water'], scope: 'self' } }, 'memory')];
  transform(defs);
});
// The board's Active is a 'base'; this puts another card there instead.
const activate = (s, owner, id) => { const p = s.players[owner], card = hand(s, owner, id); p.hand.pop(); p.hand.push(...p.active.stack); p.active.stack = [card]; };
const holdTool = (s, owner, m) => { const card = hand(s, owner, 'tool'); s.players[owner].hand.pop(); m.tools.push(card); };

test('only the printed Pokémon, by their current types (JP Q&A シルヴァディGX「ウォーターメモリ」, ユリーカ)', async () => {
  const f = await plainReuse(water);
  let card;
  const fire = board(f, (s) => { s.players[0].gxUsed = true; activate(s, 0, 'other'); card = hand(s, 0, 'research'); });
  play(fire, card);
  assert.deepEqual(attacks(fire), [], 'A Fire Pokémon is not one of them.');
  const memory = board(f, (s) => { s.players[0].gxUsed = true; activate(s, 0, 'other'); holdTool(s, 0, s.players[0].active); card = hand(s, 0, 'research'); });
  play(memory, card);
  assert.deepEqual(attacks(memory), ['other:strike'], 'A Pokémon that is Water now.');
  // 「自己的「X」」: that name only.
  const named = await plainReuse({ kind: 'pokemon', nameKeys: ['other'] });
  const zygarde = board(named, (s) => { s.players[0].gxUsed = true; activate(s, 0, 'other'); card = hand(s, 0, 'research'); });
  play(zygarde, card);
  assert.deepEqual(attacks(zygarde), ['other:strike']);
  const notNamed = board(named, (s) => { s.players[0].gxUsed = true; attached(s, 0, s.players[0].active, 'water'); card = hand(s, 0, 'research'); });
  play(notNamed, card);
  assert.deepEqual(attacks(notNamed), []);
});

test('「无法使用GX招式」 still applies (JP Q&A ラティオスGX「クリアビジョンGX」)', async () => {
  const f = await plainReuse(water, (defs) => {
    def(defs, 'other').mechanics.effects = [binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'opponent', actions: ['attack'],
      specialRules: ['GX'] } }, 'clear')];
  });
  let card;
  const g = board(f, (s) => { s.players[0].gxUsed = true; attached(s, 0, s.players[0].active, 'water'); activate(s, 1, 'other'); card = hand(s, 0, 'research'); });
  play(g, card);
  assert.deepEqual(attacks(g), []);
});

test('a GX attack used as this attack is one the reuse allows too (attack.copy-special-rule)', async () => {
  const copy = { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }], excludeUser: false,
    coin: 'none', energy: 'ignore', special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } };
  const f = await plainReuse(water, (defs) => {
    const a = def(defs, 'base').mechanics.attacks[0]; delete a.specialRule; a.printedDamage = null; a.effects = [binding('cn.copyAttack@1', copy, 'copy')];
  });
  let card;
  const g = board(f, (s) => { s.players[0].gxUsed = true; attached(s, 0, s.players[0].active, 'water'); activate(s, 1, 'other'); card = hand(s, 0, 'research'); });
  const before = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  play(g, card);
  command(g, { type: 'attack', attackId: 'base:strike' });
  const choice = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike');
  assert(choice); answer(g, [choice.optionId]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  command(before, { type: 'attack', attackId: 'base:strike' }); settle(before);
  assert.equal(before.snapshot().players[1].active.counters, 0, 'Without it the GX attack cannot be chosen.');
});
