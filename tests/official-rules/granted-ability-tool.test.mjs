// Synthetic definitions only. 「身上放有这张卡牌的「宝可梦V」，可以使用这个【VSTAR】力量。」 with, printed below it,
// 「[特性] 星耀炼金术 在自己的回合可以使用。选择自己牌库中任意1张卡牌，加入手牌。并重洗牌库。[对战中，己方的【VSTAR】力量只能使用1次。]」
// (tools.granted-ability). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { releaseIndexEntry } from '../../public/rules/release-index.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, start } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const STAR = { period: 'unlimited', scope: 'pokemon', key: 'seal:star', limit: null };
const alchemy = (extra = {}) => ({ abilityId: 'seal:alchemy', name: '测试星耀炼金术', mode: 'activated', usage: STAR, specialRule: 'VSTAR',
  effects: [binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: true }, 'alchemy')], sourceOfTruth: EVIDENCE, ...extra });
// 'tool' prints the Ability for a 「宝可梦V」; 'other' is a Pokémon V with its own VSTAR Power.
const seal = (extra = {}, ability = alchemy()) => fixture((defs) => {
  Object.assign(def(defs, 'tool').mechanics, { effects: [], grantedAbilities: [ability],
    grantedAbilityHolder: { kind: 'pokemon', tagsAll: ['V'] }, ...extra });
  Object.assign(def(defs, 'other').mechanics, { tags: ['V'], ruleBox: true, prizeCount: 2, abilities: [{ abilityId: 'other:star',
    name: '测试自身VSTAR力量', mode: 'activated', usage: STAR, specialRule: 'VSTAR',
    effects: [binding('cn.draw@1', { count: 1 }, 'own-star')], sourceOfTruth: EVIDENCE }] });
  def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }, 'jam')];
  def(defs, 'hp-tool').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all' } }, 'mute')];
});
const equip = (s, m, owner = 0, id = 'tool') => { const t = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(t); return t; };
const asActive = (s, owner, id) => { const p = s.players[owner]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, owner, id)]; p.hand.pop(); };
const stadium = (s, owner = 1) => { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; };
const offers = (g) => g.view(0).legalActions.filter((a) => a.type === 'useAbility' && a.abilityId === 'seal:alchemy');

test('schema: a Tool\'s printed Ability is an activated one with explicit usage, and its holder kind needs it', async () => {
  const tool = (extra) => fixture((defs) => Object.assign(def(defs, 'tool').mechanics, extra));
  await assert.rejects(tool({ grantedAbilityHolder: { kind: 'pokemon', tagsAll: ['V'] } }));
  await assert.rejects(fixture((defs) => { def(defs, 'potion').mechanics.grantedAbilities = [alchemy()]; }));
  for (const wrong of [{ mode: 'continuous', usage: null }, { usage: null }, { zone: 'hand' },
    { costs: [{ costId: 'c', kind: 'discardHand', count: 1, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }] }])
    await assert.rejects(tool({ grantedAbilities: [alchemy(wrong)] }));
  await assert.rejects(tool({ grantedAbilities: [alchemy({ usage: { ...STAR, limit: 1 } })] }), /matching explicit limit/);
  await assert.rejects(tool({ grantedAbilities: [alchemy({ usage: { period: 'turn', scope: 'pokemon', key: 'k', limit: null } })] }), /matching explicit limit/);
  await assert.rejects(tool({ grantedAbilities: [alchemy(), alchemy()] }), /Duplicate attack\/Ability identity/);
  // Its effects are an activated Ability's: a game does not start with a continuous one.
  const held = await tool({ grantedAbilities: [alchemy({ effects: [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' }, 'hold')] })] });
  assert.throws(() => start(held), /handler timing/);
});

test('「身上放有这张卡牌的「宝可梦V」，可以使用这个【VSTAR】力量」: only that holder, on its owner\'s turn, once per game', async () => {
  const f = await seal();
  assert.deepEqual(releaseIndexEntry(f.catalog, 'printing:tool', 'test').card.abilities, [{ abilityId: 'seal:alchemy', name: '测试星耀炼金术' }]);
  let tool;
  let g = board(f, (s) => { tool = equip(s, s.players[0].active); });
  assert.deepEqual(offers(g), [], 'Not a Pokémon V.');
  g = board(f, (s) => { asActive(s, 0, 'other'); tool = equip(s, s.players[0].active); });
  const active = g.snapshot().players[0].active.id;
  assert.deepEqual(offers(g), [{ type: 'useAbility', pokemonId: active, abilityId: 'seal:alchemy', toolId: tool }]);
  // Not the holder's own Ability: it is used through the Tool, and the holder's effective Abilities are only its printed one.
  assert.throws(() => command(g, { type: 'useAbility', pokemonId: active, abilityId: 'seal:alchemy' }), /not legal/);
  assert.deepEqual(g.view(0).players[0].active.effective.abilities.map((a) => a.abilityId), ['other:star']);
  const before = g.snapshot().players[0];
  command(g, offers(g)[0]);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, before.hand.length + 1);
  assert.equal(s.players[0].deck.length, before.deck.length - 1);
  assert(s.players[0].vstarUsed);
  assert(s.events.some((e) => e.ruleId === 'ability.usage' && e.data.toolId === tool && e.data.pokemonId === active));
  assert.deepEqual(restore(g, f).snapshot(), s);
  // The one VSTAR Power of the game is spent: neither this nor the holder's own can be used again.
  assert.deepEqual(offers(g), []);
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'other:star'));
  command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.view(1).legalActions.filter((a) => a.type === 'useAbility'), [], 'Not on the opponent\'s turn.');
  command(g, { type: 'endTurn' }, 1); settle(g);
  assert.deepEqual(offers(g), []);
  // A Benched holder may use it too.
  g = board(f, (s) => { const m = bench(s, 0, 'other'); tool = equip(s, m); });
  assert.equal(offers(g)[0].pokemonId, g.snapshot().players[0].bench[0].id);
});

test('JP Q&A: the holder\'s own VSTAR Power first leaves no VSTAR Power, this one included', async () => {
  const f = await seal();
  const g = board(f, (s) => { asActive(s, 0, 'other'); equip(s, s.players[0].active); });
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'other:star' }); settle(g);
  assert(g.snapshot().players[0].vstarUsed);
  assert.deepEqual(offers(g), []);
});

test('JP Q&A: removing the holder\'s Abilities does not stop it; removing the Tool\'s effects does', async () => {
  const f = await seal();
  // 'hp-tool' on the opponent's Active removes every in-play Ability.
  let g = board(f, (s) => { asActive(s, 0, 'other'); equip(s, s.players[0].active); equip(s, s.players[1].active, 1, 'hp-tool'); });
  assert.equal(offers(g).length, 1);
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'other:star'), 'The holder\'s own Ability is removed.');
  g = board(f, (s) => { asActive(s, 0, 'other'); equip(s, s.players[0].active); stadium(s); });
  assert.deepEqual(offers(g), []);
});

test('a limited printed Ability counts the holder\'s uses; its effects need something to change', async () => {
  const { specialRule, ...once } = alchemy({ usage: { period: 'turn', scope: 'pokemon', key: 'seal:once', limit: 1 } });
  const f = await seal({}, once);
  const g = board(f, (s) => { asActive(s, 0, 'other'); equip(s, s.players[0].active); });
  command(g, offers(g)[0]); settle(g);
  assert(!g.snapshot().players[0].vstarUsed);
  assert.deepEqual(offers(g), [], 'Once this turn.');
  const empty = board(f, (s) => { asActive(s, 0, 'other'); equip(s, s.players[0].active); s.players[0].hand.push(...s.players[0].deck.splice(0)); });
  assert.deepEqual(offers(empty), [], 'An empty deck: nothing to put into the hand.');
});
