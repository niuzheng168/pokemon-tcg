// Mechanism tests for the milestone-3 batch-2 staple Trainers, on a test-only
// 60-card list of real reviewed printings (the 多龙巴鲁托ex list with staples
// swapped in). The list is a fixture, not a tournament deck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateFormatDeck } from '../../public/rules/engine.js';
import { REVIEW_RECORDS, IMAGE_STORES } from '../../catalog/zh-CN/V20261019/index.mjs';
import { DEFINITIONS, PRINTINGS, PRODUCTS, PRINTING as S } from '../../catalog/zh-CN/V20261019/staples.mjs';
import { PRINTING as D } from '../../catalog/zh-CN/V20261019/dragapult.mjs';
import { PRINTING as R } from '../../catalog/zh-CN/V20261019/raging-bolt.mjs';
import { DRAGAPULT, STANDARD_FORMAT, reviewed, board, restore, settle, answer, command, play, fixtureClock } from './helpers.mjs';

const swap = (list, from, to) => { const i = list.indexOf(from); assert(i >= 0, from); list[i] = to; };
const STAPLES = (() => {
  const list = [...DRAGAPULT];
  for (const [from, to] of [[D.pokePad, S.rareCandy], [D.pokePad, S.arven], [D.pokePad, S.braveryCharm], [D.pokePad, S.superRod],
    [D.counterCatcher, S.energySwitch], [D.counterCatcher, S.energyRetrieval], [D.counterCatcher, S.picnicBasket],
    [D.lillie, S.cyrano], [D.lillie, S.professorsResearch], [D.jammingTower, S.artazon], [D.jammingTower, S.gravityMountain],
    [D.neoUpper, S.secretBox], [R.ultraBall, S.switch]]) swap(list, from, to);
  return list;
})();
const staples = (seed) => reviewed(seed, [STAPLES, STAPLES], STANDARD_FORMAT);
const keyOf = (ctx, s, id) => ctx.catalog.definition(s.cards[id].definitionId).nameKey;
const mon = (s, id) => s.players.flatMap((p) => [p.active, ...p.bench]).find((m) => m?.id === id);
const maxHp = (g, owner, id) => { const p = g.view(owner).players[owner]; return [p.active, ...p.bench].find((m) => m.id === id).effective.maxHp; };
const line = (h, owner, m, ...keys) => { for (const key of keys) h.evolve(owner, m, key); return m; };
// Put real cards at the bottom of the deck (never on top, where a Prize swap could take them back).
const underDeck = (s, h, ...keys) => keys.map((key) => { const [id] = h.hand(0, key); s.players[0].hand.pop(); s.players[0].deck.unshift(id); return id; });
const optionKeys = (ctx, g) => [...new Set(g.view(0).pending.options.map((id) => keyOf(ctx, g.snapshot(), id)))].sort();

test('batch 2: 13 printings, each citing its own card face and product; the test list is Standard-legal with one ACE SPEC', async () => {
  const ctx = await staples();
  validateFormatDeck(ctx.catalog, STAPLES, STANDARD_FORMAT);
  for (const d of DEFINITIONS) for (const b of [d, ...d.mechanics.effects, ...(d.mechanics.playCosts ?? [])]) {
    assert.equal(b.sourceOfTruth.length, 1);
    assert(Object.values(PRODUCTS).some((p) => p.url === b.sourceOfTruth[0].url));
  }
  for (const p of PRINTINGS) {
    const record = REVIEW_RECORDS.find((r) => r.printingId === p.printingId);
    assert.equal(record.product, PRODUCTS[p.setCode].url);
    const bytes = await readFile(`${IMAGE_STORES[record.image.store]}/${record.image.path}`).catch(() => null);
    if (bytes) assert.equal(createHash('sha256').update(bytes).digest('hex'), record.image.sha256);
  }
  assert.equal(PRINTINGS.length, 13);
  // New printings of existing names bind the reviewed CSVH1C definitions.
  assert.equal(ctx.catalog.definitionFor(S.professorsResearch).definitionId, 'cn:trainer:professors-research');
  assert.equal(ctx.catalog.definitionFor(S.switch).definitionId, 'cn:trainer:switch');
});

test('神奇糖果 evolves a Basic straight into its Stage 2 from hand; not on the first own turn or a Pokémon that entered this turn', async () => {
  const ctx = await staples();
  let candy, noir;
  const g = board(ctx, ['duskull', 'dreepy'], (s, h) => { [candy, noir] = h.hand(0, 'rare-candy', 'dusknoir'); });
  const target = g.snapshot().players[0].active.id;
  play(g, candy);
  settle(g, (q) => q.options.includes(noir) ? [noir] : q.options.includes(target) ? [target] : q.options.slice(0, q.minimum));
  const s = g.snapshot();
  assert.deepEqual(s.players[0].active.stack.map((id) => keyOf(ctx, s, id)), ['duskull', 'dusknoir']);
  for (const mutate of [(s) => { fixtureClock(s, [1, 0]); }, (s) => { s.players[0].active.enteredTurn = s.turn; }]) {
    const blocked = board(ctx, ['duskull', 'dreepy'], (s, h) => { [candy] = h.hand(0, 'rare-candy', 'dusknoir'); mutate(s); });
    assert(!blocked.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === candy));
  }
  restore(g, ctx.catalog);
});

test('派帕 and 秘密箱 take one card of each printed kind', async () => {
  const ctx = await staples();
  let arven;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [arven] = h.hand(0, 'arven'); underDeck(s, h, 'rare-candy', 'super-rod', 'bravery-charm'); });
  play(g, arven);
  const categories = new Set(g.view(0).pending.options.map((id) => ctx.catalog.definition(g.snapshot().cards[id].definitionId).mechanics.category));
  assert.deepEqual([...categories].sort(), ['item', 'tool'], 'Only Items and Pokémon Tools are offered.');
  const s = g.snapshot(), find = (key) => s.pending.options.find((id) => keyOf(ctx, s, id) === key);
  assert.throws(() => answer(g, [find('rare-candy'), find('super-rod')]), (e) => e.code === 'invalid-card-selection');
  answer(g, [find('rare-candy'), find('bravery-charm')]); settle(g);
  assert.deepEqual(g.snapshot().players[0].hand.map((id) => keyOf(ctx, g.snapshot(), id)).sort(), ['bravery-charm', 'rare-candy']);

  let box, fee;
  const b = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [box, ...fee] = h.hand(0, 'secret-box', 'iono', 'budew', 'hawlucha');
    underDeck(s, h, 'ultra-ball', 'bravery-charm', 'iono', 'artazon');
  });
  play(b, box);
  settle(b, (q) => {
    if (q.kind === 'activation-cost') return q.options.slice(0, 3);
    const t = b.snapshot();
    const pick = ['ultra-ball', 'bravery-charm', 'iono', 'artazon'].map((key) => q.options.find((id) => keyOf(ctx, t, id) === key));
    return pick;
  });
  const after = b.snapshot();
  assert(fee.every((id) => after.players[0].discard.includes(id)));
  assert.deepEqual(after.players[0].hand.map((id) => keyOf(ctx, after, id)).sort(), ['artazon', 'bravery-charm', 'iono', 'ultra-ball']);
});

test('勇气护符 +50 HP only on a Basic; 重力山 -30 on every Stage 2 in play', async () => {
  const ctx = await staples();
  let pult;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    h.tool(0, s.players[0].active, 'bravery-charm');
    pult = line(h, 1, h.bench(1, 'dreepy'), 'drakloak', 'dragapult-ex');
    const [mountain] = h.hand(0, 'gravity-mountain'); s.players[0].hand.pop(); s.stadium = mountain;
  });
  assert.equal(maxHp(g, 0, g.snapshot().players[0].active.id), 120);
  assert.equal(maxHp(g, 1, pult.id), 290);
});

test('厉害钓竿, 能量回收, 能量转移 and 野餐篮', async () => {
  const ctx = await staples();
  let rod, returned;
  const r = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [rod] = h.hand(0, 'super-rod');
    returned = [...h.discard(0, 'dreepy'), ...h.discard(0, 'basic-psychic-energy'), ...h.discard(0, 'luminous-energy'), ...h.discard(0, 'iono')];
  });
  play(r, rod);
  assert.deepEqual([...r.view(0).pending.options].sort(), [...returned.slice(0, 2)].sort(), 'Only Pokémon and Basic Energy.');
  answer(r, returned.slice(0, 2)); settle(r);
  assert(returned.slice(0, 2).every((id) => r.snapshot().players[0].deck.includes(id)));

  let retrieval, energies;
  const e = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [retrieval] = h.hand(0, 'energy-retrieval');
    energies = [...h.discard(0, 'basic-fire-energy', 2), ...h.discard(0, 'basic-psychic-energy')];
  });
  play(e, retrieval);
  assert.equal(e.view(0).pending.maximum, 2);
  answer(e, energies.slice(0, 2)); settle(e);
  assert(energies.slice(0, 2).every((id) => e.snapshot().players[0].hand.includes(id)));

  let sw, fire, benched;
  const m = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [sw] = h.hand(0, 'energy-switch'); [fire] = h.attach(0, s.players[0].active, 'basic-fire-energy');
    h.attach(0, s.players[0].active, 'luminous-energy'); benched = h.bench(0, 'duskull');
  });
  play(m, sw);
  assert.deepEqual(m.view(0).pending.options, [fire], 'Only Basic Energy.');
  answer(m, [fire]); settle(m, (q) => q.options.includes(benched.id) ? [benched.id] : q.options.slice(0, q.minimum));
  assert.deepEqual(mon(m.snapshot(), benched.id).energy, [fire]);

  let basket, foe;
  const p = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [basket] = h.hand(0, 'picnic-basket'); s.players[0].active.counters = 4; foe = s.players[1].active; foe.counters = 2;
  });
  play(p, basket); settle(p);
  assert.deepEqual([p.snapshot().players[0].active.counters, p.snapshot().players[1].active.counters], [1, 0]);
});

test('深钵镇: each player once per own turn benches a Basic without a Rule Box; 席蓝 finds only Pokémon ex', async () => {
  const ctx = await staples();
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => { const [a] = h.hand(1, 'artazon'); s.players[1].hand.pop(); s.stadium = a; });
  command(g, { type: 'useStadium' });
  const keys = optionKeys(ctx, g);
  assert(keys.length && keys.every((k) => !k.endsWith('-ex')), 'No Pokémon with a Rule Box.');
  answer(g, [g.view(0).pending.options[0]]); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 1);
  assert(!g.view(0).legalActions.some((a) => a.type === 'useStadium'));
  let cyrano;
  const c = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [cyrano] = h.hand(0, 'cyrano'); });
  play(c, cyrano);
  assert.deepEqual(optionKeys(ctx, c), ['bloodmoon-ursaluna-ex', 'dragapult-ex', 'fezandipiti-ex', 'latias-ex']);
  assert.equal(c.view(0).pending.maximum, 3);
});

test('the CPU completes a full game with the staple list, restoring identically', async () => {
  const { createAI } = await import('../../public/cn/ai.js');
  const ctx = await staples([6, 2, 8, 3]);
  const ai = createAI(ctx.catalog);
  for (let steps = 0; !ctx.game.snapshot().result; steps++) {
    if (steps > 2000) assert.fail('The CPU game must terminate.');
    const s = ctx.game.snapshot(), player = s.pending ? s.pending.player : s.current;
    const view = ctx.game.view(player);
    ctx.game.dispatch({ player, expectedRevision: view.revision, action: ai(view, player) });
  }
  assert.deepEqual(restore(ctx.game, ctx.catalog).snapshot(), ctx.game.snapshot());
});
