// Mechanism tests for every reviewed card of 嗨皮组合 皮卡丘卡组 (CSVH1C), using
// the real approved release and real physical cards on hand-built boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OfficialGame, loadReviewedCatalogRelease, validateFormatDeck, getFormat } from '../../public/rules/engine.js';
import { TRUSTED_RELEASES, CN_RELEASE_ID } from '../../public/cn/trusted-releases.js';
import { createAI } from '../../public/cn/ai.js';
import { DECKS, DEFINITIONS as POOL, REVIEW_RECORDS, IMAGE_STORES } from '../../catalog/zh-CN/V20261019/index.mjs';
import { DEFINITIONS, PRINTINGS } from '../../catalog/zh-CN/V20261019/csvh1c.mjs';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { json, DECK, reviewed, board, restore, settle, answer, command, play, attack, playable, events, forceCoin } from './helpers.mjs';

const atk = (ctx, key, name) => `${ctx.id[key]}:${name}`;
const cardsOf = (s, owner, zone, ctx, key) => s.players[owner][zone].filter((id) => s.cards[id].definitionId === ctx.id[key]);

test('the installed pin admits exactly this reviewed release; the product deck is 60 exact printings, Open-legal but not Standard', async () => {
  const ctx = await reviewed();
  assert.equal(ctx.approval.releaseId, CN_RELEASE_ID);
  assert.equal(ctx.catalog.definitions().length, POOL.length);
  assert.equal(DEFINITIONS.length, 23);
  const deck = DECKS['csvh1c-pikachu'];
  assert.equal(DECK.length, 60);
  assert.equal(deck.cards.length, 23);
  for (const [printingId] of deck.cards) assert.match(printingId, /^zh-Hans:CSVH1C:(\d{3}\/059|LIG)$/);
  assert.deepEqual(deck.sources.map((s) => s.kind), ['official-product', 'wiki-deck-list']);
  assert.equal(getFormat(deck.format).id, 'open');
  validateFormatDeck(ctx.catalog, DECK, deck.format);
  assert.throws(() => validateFormatDeck(ctx.catalog, DECK, { region: 'CN', version: 'V20261019', id: 'standard' }),
    (e) => e.details?.reason === 'outside-pool', 'E/F-mark printings are outside the G/H/I/J Standard pool.');
  const tampered = json.replace('"hp": 190', '"hp": 200');
  assert.notEqual(tampered, json);
  await assert.rejects(() => loadReviewedCatalogRelease({ json: tampered, trustedReleases: TRUSTED_RELEASES }), /does not match|mismatch/);
  await assert.rejects(() => loadReviewedCatalogRelease({ json, trustedReleases: new Map() }), /approval/);
});

test('every definition, effect and printing cites its own reviewed card face; local images still match when present', async () => {
  for (const d of DEFINITIONS) {
    const sources = [d.sourceOfTruth, ...(d.mechanics.attacks ?? []).map((a) => a.sourceOfTruth),
      ...(d.mechanics.abilities ?? []).map((a) => a.sourceOfTruth),
      ...[...(d.mechanics.effects ?? []), ...(d.mechanics.attacks ?? []).flatMap((a) => a.effects),
        ...(d.mechanics.abilities ?? []).flatMap((a) => a.effects)].map((b) => b.sourceOfTruth)];
    for (const list of sources) {
      assert.equal(list.length, 1);
      assert.equal(list[0].kind, 'official-card');
      assert.equal(list[0].url, 'https://www.pokemon.cn/tcg/product/15585.html');
      assert.match(list[0].locator, new RegExp(`SHA-256 [0-9a-f]{64}`));
      assert.match(list[0].locator, new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  for (const p of PRINTINGS) {
    assert.equal(p.series, 'scarlet-violet'); assert.equal(p.releasedOn, '2025-01-17');
    const record = REVIEW_RECORDS.find((r) => r.printingId === p.printingId);
    assert(p.definitionBindings[0].sourceOfTruth[0].locator.includes(record.image.sha256));
    const file = `${IMAGE_STORES[record.image.store]}/${record.image.path}`;
    const bytes = await readFile(file).catch(() => null);
    if (bytes) assert.equal(createHash('sha256').update(bytes).digest('hex'), record.image.sha256, file);
  }
});

test('皮卡丘ex 强劲伏特: 220 damage; tails discards every attached Energy from itself, heads keeps them', async () => {
  for (const result of ['heads', 'tails']) {
    const ctx = await reviewed();
    let energy;
    const g = board(ctx, ['pikachu-ex', 'thundurus'], (s, h) => { energy = h.energy(0, s.players[0].active, 3); h.coin(result); });
    attack(g, atk(ctx, 'pikachu-ex', 'topaz-bolt')); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[0].active.energy.length, result === 'tails' ? 0 : 3);
    assert.equal(energy.every((id) => s.players[0].discard.includes(id)), result === 'tails');
    assert.equal(events(g, 'effects.coin')[0].data.result, result);
    // 雷电云 HP120 is Knocked Out by 220 and replaced; the ex itself has no weakness interplay here.
    assert.equal(events(g, 'ko.boundary').filter((e) => e.data.kind === 'latched').length, 1);
  }
});

test('皮卡丘ex 皮卡拳 30, and a Knocked Out Pokémon ex gives two Prize cards', async () => {
  const ctx = await reviewed();
  const g = board(ctx, ['chinchou', 'pikachu-ex'], (s, h) => {
    h.energy(0, s.players[0].active, 1); s.players[1].active.counters = 18; h.bench(1, 'mareep');
  });
  attack(g, atk(ctx, 'chinchou', 'electro-ball')); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 4, 'Two Prize cards for a Pokémon ex.');
  assert.equal(s.players[1].active.stack.length, 1);
  const punch = await reviewed();
  const p = board(punch, ['pikachu-ex', 'mareep'], (state, h) => { h.energy(0, state.players[0].active, 1); });
  attack(p, atk(punch, 'pikachu-ex', 'pika-punch')); settle(p);
  assert.equal(p.snapshot().events.filter((e) => e.ruleId === 'ko.boundary' && e.data.kind === 'latched').length, 0);
  assert.equal(p.snapshot().players[1].active.counters, 3);
});

test('灯笼鱼 电球 hits 聒噪鸟 for double (weakness 雷×2); 聒噪鸟 resistance does not apply to Lightning', async () => {
  const ctx = await reviewed();
  const g = board(ctx, ['chinchou', 'chatot'], (s, h) => h.energy(0, s.players[0].active, 1));
  attack(g, atk(ctx, 'chinchou', 'electro-ball')); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('电灯怪 evolves from 灯笼鱼; 炫目光束 makes the hit Pokémon flip before attacking next turn, tails fails the attack', async () => {
  for (const result of ['heads', 'tails']) {
    const ctx = await reviewed();
    const g = board(ctx, ['chinchou', 'chinchou'], (s, h) => {
      h.evolve(0, s.players[0].active, 'lanturn'); h.energy(0, s.players[0].active, 2); h.energy(1, s.players[1].active, 1);
    });
    attack(g, atk(ctx, 'lanturn', 'dazzling-beam')); settle(g);
    const mid = g.snapshot();
    assert.equal(mid.current, 1); assert.equal(mid.players[1].active.counters, 4);
    assert.equal(mid.ongoing.filter((e) => e.effect.op === 'attackCheck').length, 1);
    forceCoin(mid, result);
    const r = OfficialGame.restore(mid, { catalog: ctx.catalog });
    const before = r.snapshot().players[0].active.counters;
    command(r, { type: 'attack', attackId: atk(ctx, 'chinchou', 'electro-ball') }, 1); settle(r);
    const check = events(r, 'attack.failure.imposed').at(-1);
    assert.equal(check.data.receipt.passed, result === 'heads');
    assert.equal(r.snapshot().players[0].active.counters - before, result === 'heads' ? 1 : 0);
  }
  const ctx = await reviewed();
  const g = board(ctx, ['chinchou', 'mareep'], (s, h) => { h.hand(0, 'lanturn'); });
  assert(g.view(0).legalActions.some((a) => a.type === 'evolve'), 'Ordinary evolution from 灯笼鱼 is available after the first turns.');
});

test('茸茸羊 电气发电机: once per turn per 茸茸羊, attaches one discarded Lightning Energy to a Benched Pokémon only', async () => {
  const ctx = await reviewed();
  let target;
  const g = board(ctx, ['mareep', 'chinchou'], (s, h) => {
    h.evolve(0, s.players[0].active, 'flaaffy'); target = h.bench(0, 'pikachu-ex'); h.discard(0, 'basic-lightning-energy', 2);
  });
  const use = () => g.view(0).legalActions.find((a) => a.type === 'useAbility');
  assert(use()); command(g, use(), 0);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'discard-energy'); assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
  answer(g, [q.options[0]]);
  const recipient = g.view(0).pending;
  assert.deepEqual(recipient.options, [target.id], 'Only Benched Pokémon may receive it.');
  answer(g, [target.id]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 1);
  assert(!use(), 'Once per turn for this 茸茸羊.');
  restore(g, ctx.catalog);
  const empty = board(await reviewed(), ['mareep', 'chinchou'], (s, h) => { h.evolve(0, s.players[0].active, 'flaaffy'); h.bench(0, 'mareep'); });
  assert(!empty.view(0).legalActions.some((a) => a.type === 'useAbility'), 'No Lightning Energy in the discard pile means no change.');
});

test('电飞鼠 电击: 30 damage; heads Paralyzes the opposing Active, tails does not', async () => {
  for (const result of ['heads', 'tails']) {
    const ctx = await reviewed();
    const g = board(ctx, ['emolga', 'thundurus'], (s, h) => { h.energy(0, s.players[0].active, 1); h.coin(result); });
    attack(g, atk(ctx, 'emolga', 'thundershock')); settle(g);
    const opp = g.snapshot().players[1].active;
    assert.equal(opp.counters, 3);
    assert.equal(opp.conditions.rotation, result === 'heads' ? 'paralyzed' : null);
    assert(!g.view(1).legalActions.some((a) => a.type === 'attack' || a.type === 'retreat') || result === 'tails');
  }
});

test('雷电云 辅助电光 may attach a Lightning Energy from hand to the Bench; 打雷 deals 130 and 30 to itself', async () => {
  const ctx = await reviewed();
  let target;
  const g = board(ctx, ['thundurus', 'pikachu-ex'], (s, h) => { h.energy(0, s.players[0].active, 1); target = h.bench(0, 'mareep'); h.hand(0, 'basic-lightning-energy'); });
  attack(g, atk(ctx, 'thundurus', 'assisting-flash'));
  const q = g.view(0).pending;
  assert.equal(q.kind, 'hand-energy'); assert.equal(q.allowZero, true, '若希望: the attachment can be declined.');
  answer(g, [q.options[0]]); answer(g, [target.id]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 1);
  assert.equal(g.snapshot().players[1].active.counters, 3);
  const ctx2 = await reviewed();
  const t = board(ctx2, ['thundurus', 'pikachu-ex'], (s, h) => h.energy(0, s.players[0].active, 3));
  attack(t, atk(ctx2, 'thundurus', 'thunder')); settle(t);
  assert.equal(t.snapshot().players[1].active.counters, 13);
  assert.equal(t.snapshot().players[0].active.counters, 3);
});

test('捷拉奥拉 疯狂伏特 deals 70 and 20 to itself; 活力头带 adds 10 to the opposing Active only, never to the recoil', async () => {
  for (const band of [false, true]) {
    const ctx = await reviewed();
    const g = board(ctx, ['zeraora', 'pikachu-ex'], (s, h) => { h.energy(0, s.players[0].active, 2); if (band) h.tool(0, s.players[0].active, 'vitality-band'); });
    attack(g, atk(ctx, 'zeraora', 'wild-volt')); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, band ? 8 : 7);
    assert.equal(g.snapshot().players[0].active.counters, 2);
  }
  const ctx = await reviewed();
  let band;
  const g = board(ctx, ['chinchou', 'mareep'], (s, h) => { [band] = h.hand(0, 'vitality-band'); });
  play(g, band);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'tool-target'); answer(g, [q.options[0]]); settle(g);
  assert.equal(g.snapshot().players[0].active.tools.length, 1);
});

test('聒噪鸟 循环抽取 discards one hand card, then draws two; with an empty hand it draws nothing', async () => {
  for (const cards of [['nemona', 'switch'], []]) {
    const ctx = await reviewed();
    let ids = [];
    const g = board(ctx, ['chatot', 'mareep'], (s, h) => { h.energy(0, s.players[0].active, 1); ids = h.hand(0, ...cards); });
    const deck = g.snapshot().players[0].deck.length;
    attack(g, atk(ctx, 'chatot', 'cycle-draw'));
    if (cards.length) { assert.equal(g.view(0).pending.kind, 'select-cards'); answer(g, [ids[1]]); }
    settle(g);
    const p = g.snapshot().players[0];
    assert.equal(p.hand.length, cards.length ? 3 : 0);
    assert.equal(p.deck.length, deck - (cards.length ? 2 : 0));
  }
});

test('能量输送 reveals one Basic Energy from the deck into hand and shuffles; 巢穴球 benches a Basic Pokémon', async () => {
  const ctx = await reviewed();
  let search, ball;
  const g = board(ctx, ['mareep', 'chinchou'], (s, h) => { [search, ball] = h.hand(0, 'energy-search', 'nest-ball'); });
  play(g, search);
  let q = g.view(0).pending;
  assert.equal(q.kind, 'select-cards');
  assert(q.options.every((id) => g.snapshot().cards[id].definitionId === ctx.id['basic-lightning-energy']));
  answer(g, [q.options[0]]); settle(g);
  assert.equal(cardsOf(g.snapshot(), 0, 'hand', ctx, 'basic-lightning-energy').length, 1);
  assert(events(g, 'effects.search').some((e) => e.data.revealed?.length === 1));
  play(g, ball);
  q = g.view(0).pending;
  assert(q.options.every((id) => ctx.catalog.definition(g.snapshot().cards[id].definitionId).mechanics.stage === 'basic'));
  answer(g, [q.options[0]]); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 1);
  const full = board(await reviewed(), ['mareep', 'chinchou'], (s, h) => {
    [ball] = h.hand(0, 'nest-ball'); for (const key of ['chinchou', 'chinchou', 'emolga', 'thundurus', 'zeraora']) h.bench(0, key);
  });
  assert(!playable(full, ball), 'A full Bench cannot look through the deck (C-11).');
});

test('电气发生器 looks at five, attaches up to two Basic Lightning Energy to Benched Lightning Pokémon, then shuffles', async () => {
  const ctx = await reviewed();
  let gen, target;
  const g = board(ctx, ['mareep', 'chinchou'], (s, h) => {
    [gen] = h.hand(0, 'electric-generator'); target = h.bench(0, 'pikachu-ex');
    h.top(0, 'basic-lightning-energy'); h.top(0, 'nemona'); h.top(0, 'basic-lightning-energy');
  });
  play(g, gen);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'inspect-deck'); assert.equal(q.lookedAt.length, 5); assert(q.maximum <= 2);
  answer(g, q.options.slice(0, 2));
  answer(g, [target.id]); answer(g, [target.id]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 2);
  assert(events(g, 'effects.shuffle').length >= 1);
  const none = board(await reviewed(), ['mareep', 'chinchou'], (s, h) => { [gen] = h.hand(0, 'electric-generator'); });
  assert(!playable(none, gen), 'No Benched Lightning Pokémon to receive Energy.');
});

test('健行鞋: take the looked-at top card, or discard it and draw one', async () => {
  for (const take of [true, false]) {
    const ctx = await reviewed();
    let shoes, top;
    const g = board(ctx, ['mareep', 'chinchou'], (s, h) => { [shoes] = h.hand(0, 'trekking-shoes'); h.top(0, 'nemona'); top = h.top(0, 'switch'); });
    play(g, shoes);
    assert.deepEqual(g.view(0).pending.options, [top]);
    answer(g, take ? [top] : []);
    if (!take) answer(g, [top]);
    settle(g);
    const p = g.snapshot().players[0];
    assert.equal(p.hand.includes(top), take);
    assert.equal(p.discard.includes(top), !take);
    assert.equal(cardsOf(g.snapshot(), 0, 'hand', ctx, 'nemona').length, take ? 0 : 1);
  }
});

test('高级球 requires discarding two other hand cards, then reveals any Pokémon from the deck', async () => {
  const ctx = await reviewed();
  let ball, fees;
  const g = board(ctx, ['mareep', 'chinchou'], (s, h) => { [ball, ...fees] = h.hand(0, 'ultra-ball', 'nemona', 'switch'); });
  assert(playable(g, ball));
  play(g, ball);
  assert.equal(g.view(0).pending.kind, 'activation-cost');
  answer(g, fees.map((id) => paymentOptionId('discard-2', id)));
  const q = g.view(0).pending;
  assert(q.options.every((id) => ctx.catalog.definition(g.snapshot().cards[id].definitionId).kind === 'pokemon'));
  const pick = q.options.find((id) => g.snapshot().cards[id].definitionId === ctx.id['pikachu-ex']);
  answer(g, [pick]); settle(g);
  const p = g.snapshot().players[0];
  assert(p.hand.includes(pick)); assert(fees.every((id) => p.discard.includes(id))); assert(p.discard.includes(ball));
  const short = board(await reviewed(), ['mareep', 'chinchou'], (s, h) => { [ball] = h.hand(0, 'ultra-ball', 'nemona'); });
  assert(!playable(short, ball), 'Only one other card cannot pay the two-card condition.');
});

test('宝可梦交替 switches the own Active; 宝可梦捕捉器 brings up an opposing Benched Pokémon only on heads', async () => {
  const ctx = await reviewed();
  let sw, bench;
  const g = board(ctx, ['mareep', 'chinchou'], (s, h) => { [sw] = h.hand(0, 'switch'); bench = h.bench(0, 'pikachu-ex'); });
  play(g, sw); answer(g, [bench.id]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, bench.id);
  for (const result of ['heads', 'tails']) {
    const c = await reviewed();
    let catcher, target;
    const gg = board(c, ['mareep', 'chinchou'], (s, h) => { [catcher] = h.hand(0, 'pokemon-catcher'); target = h.bench(1, 'pikachu-ex'); h.coin(result); });
    play(gg, catcher);
    if (result === 'heads') answer(gg, [target.id]);
    settle(gg);
    assert.equal(gg.snapshot().players[1].active.id === target.id, result === 'heads');
    assert(gg.snapshot().players[0].discard.includes(catcher));
  }
  const lone = board(await reviewed(), ['mareep', 'chinchou'], (s, h) => { [sw] = h.hand(0, 'pokemon-catcher'); });
  assert(!playable(lone, sw), 'No opposing Bench: the Catcher cannot change anything.');
});

test('裁判, 短裤小子, 妮莫, 博士的研究 and 希嘉娜的决心 draw exactly as printed', async () => {
  const run = async (key, setup, check) => {
    const ctx = await reviewed();
    let card, rest;
    const g = board(ctx, ['mareep', 'chinchou'], (s, h) => { [card, ...rest] = h.hand(0, key, ...setup.hand); setup.board?.(s, h); });
    const before = g.snapshot();
    play(g, card);
    if (setup.pay) answer(g, rest.slice(0, 2).map((id) => paymentOptionId('discard-2', id)));
    settle(g);
    check(g.snapshot(), before, rest);
  };
  await run('judge', { hand: ['nemona', 'switch'], board: (s, h) => h.hand(1, 'nest-ball') }, (s) => {
    assert.deepEqual(s.players.map((p) => p.hand.length), [4, 4]);
  });
  await run('youngster', { hand: ['nemona'] }, (s, before) => {
    assert.equal(s.players[0].hand.length, 5);
    assert.equal(s.players[0].deck.length, before.players[0].deck.length + 1 - 5);
    assert.deepEqual(s.players[1].hand, before.players[1].hand);
  });
  await run('nemona', { hand: ['switch'] }, (s) => assert.equal(s.players[0].hand.length, 4));
  await run('professors-research', { hand: ['switch', 'nest-ball'] }, (s, before, rest) => {
    assert.equal(s.players[0].hand.length, 7); assert(rest.every((id) => s.players[0].discard.includes(id)));
  });
  await run('cynthias-resolve', { hand: ['switch', 'nest-ball', 'nemona'], pay: true,
    board: (s, h) => { h.bench(1, 'mareep'); h.bench(1, 'emolga'); } }, (s, before, rest) => {
    assert.equal(s.players[0].hand.length, 1 + 3, 'The kept card plus one per opposing in-play Pokémon (3).');
    assert(rest.slice(0, 2).every((id) => s.players[0].discard.includes(id)));
  });
});

test('basic Lightning Energy provides Lightning, and 15 copies are legal in one deck', async () => {
  const ctx = await reviewed();
  const energy = ctx.catalog.definition(ctx.id['basic-lightning-energy']);
  assert.deepEqual(energy.mechanics.baseUnits, [['Lightning']]);
  assert.equal(energy.deckLimits.sameName, null);
  assert.equal(DECK.filter((id) => id === 'zh-Hans:CSVH1C:LIG').length, 15);
});

test('CPU-vs-CPU full games terminate with a legal result and restore exactly mid-game', async () => {
  for (const seed of [[1, 2, 3, 4], [21, 5, 8, 13], [99, 98, 97, 96]]) {
    const { game, catalog } = await reviewed(seed);
    const decide = createAI(catalog);
    let steps = 0, current = game;
    for (;;) {
      const s = current.snapshot();
      if (s.result) break;
      const player = s.pending ? s.pending.player : s.current;
      const view = current.view(player);
      current.dispatch({ player, expectedRevision: view.revision, action: decide(view, player) });
      if (++steps === 40) {
        const copy = restore(current, catalog);
        assert.deepEqual(copy.snapshot(), current.snapshot());
        current = copy;
      }
      assert(steps < 1500, 'CPU game guard.');
    }
    const result = current.snapshot().result;
    assert(['ordinary', 'deckout', 'simultaneous'].includes(result.reason));
    assert([0, 1, null].includes(result.winner));
  }
});
