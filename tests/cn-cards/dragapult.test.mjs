// Mechanism tests for every reviewed card of the 多龙巴鲁托ex / 黑夜魔灵 tournament
// deck (OmniTCG deck 676815), using the real approved release and real physical
// cards on hand-built boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateFormatDeck, getFormat } from '../../public/rules/engine.js';
import { createAI } from '../../public/cn/ai.js';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { DECKS, REVIEW_RECORDS, IMAGE_STORES, OPEN_FORMAT } from '../../catalog/zh-CN/V20261019/index.mjs';
import { DEFINITIONS, PRINTINGS, PRODUCTS } from '../../catalog/zh-CN/V20261019/dragapult.mjs';
import { BOLT, DECK, DRAGAPULT, STANDARD_FORMAT, reviewed, board, restore, settle, answer, command, play, attack, playable, events }
  from './helpers.mjs';

const pult = (seed) => reviewed(seed, [DRAGAPULT, DRAGAPULT], STANDARD_FORMAT);
const atk = (ctx, key, name) => `${ctx.id[key]}:${name}`;
const ability = (ctx, key, name) => `${ctx.id[key]}:${name}`;
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });
const uses = (g) => g.view(0).legalActions.filter((a) => a.type === 'useAbility');
const attacks = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'attack').map((a) => a.attackId);
const defOf = (s, id) => s.cards[id].definitionId;
const mon = (s, id) => s.players.flatMap((p) => [p.active, ...p.bench]).find((m) => m?.id === id);
const leavePrizes = (s, owner, remaining) => { const p = s.players[owner]; p.deck.unshift(...p.prizes.splice(remaining)); };
const line = (h, owner, mon, ...keys) => { for (const key of keys) h.evolve(owner, mon, key); return mon; };

test('deck 676815: 60 exact Standard printings with a recorded tournament source; ACE SPEC covers Special Energy', async () => {
  const ctx = await pult();
  const deck = DECKS['dragapult-676815'];
  assert.equal(DRAGAPULT.length, 60);
  assert.equal(getFormat(deck.format).id, 'standard');
  validateFormatDeck(ctx.catalog, DRAGAPULT, deck.format);
  const [source] = deck.sources;
  assert.equal(source.kind, 'tournament-deck-list');
  assert.match(source.url, /omnitcg\.top\/api\/v1\/jz\/deck\/676815$/);
  assert.deepEqual([source.deckCode, source.eventDate, source.placing, source.player], ['US7OqGYhKmTQCFu5pX', '2026-10-18', '1/248', 'SDR-R']);
  const counts = { pokemon: 0, trainer: 0, energy: 0 };
  for (const id of DRAGAPULT) counts[ctx.catalog.definitionFor(id).kind]++;
  assert.deepEqual(counts, { pokemon: 24, trainer: 28, energy: 8 });
  // 新冲天能量 and 顶尖捕捉器 share the one ACE SPEC slot.
  const twoAce = [...DRAGAPULT];
  twoAce[twoAce.indexOf('zh-Hans:CSV8C:203/207')] = 'zh-Hans:CSV7C:180/204';
  assert.throws(() => validateFormatDeck(ctx.catalog, twoAce, deck.format), /Grouped deck limit/);
});

test('every new definition and printing cites its own card face and product; local images still match when present', async () => {
  for (const d of DEFINITIONS) {
    const lists = [d.sourceOfTruth, ...(d.mechanics.attacks ?? []).map((a) => a.sourceOfTruth),
      ...(d.mechanics.abilities ?? []).map((a) => a.sourceOfTruth),
      ...[...(d.mechanics.effects ?? []), ...(d.mechanics.attacks ?? []).flatMap((a) => a.effects),
        ...(d.mechanics.abilities ?? []).flatMap((a) => a.effects)].map((b) => b.sourceOfTruth)];
    for (const list of lists) {
      assert.equal(list.length, 1); assert.equal(list[0].kind, 'official-card');
      assert(Object.values(PRODUCTS).some((p) => p.url === list[0].url));
      assert.match(list[0].locator, new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  for (const p of PRINTINGS) {
    const record = REVIEW_RECORDS.find((r) => r.printingId === p.printingId);
    const product = PRODUCTS[p.setCode];
    assert.deepEqual([p.series, p.releasedOn, record.product], [product.series, product.releasedOn, product.url]);
    assert(p.definitionBindings[0].sourceOfTruth[0].locator.includes(record.image.sha256));
    const bytes = await readFile(`${IMAGE_STORES[record.image.store]}/${record.image.path}`).catch(() => null);
    if (bytes) assert.equal(createHash('sha256').update(bytes).digest('hex'), record.image.sha256);
  }
  const byKey = Object.fromEntries(DEFINITIONS.map((d) => [d.nameKey, d]));
  assert.deepEqual(byKey['dragapult-ex'].mechanics.tags, ['ex', 'Tera']);
  assert.deepEqual([byKey['dragapult-ex'].mechanics.basicAncestor.nameKey, byKey.dusknoir.mechanics.basicAncestor.nameKey], ['dreepy', 'duskull']);
  assert.deepEqual(byKey['neo-upper-energy'].deckLimits.groups.map((g) => g.maximum), [1]);
});

test('多龙奇 侦察指令: look at the top 2, take 1 into hand, the other goes to the bottom; once per turn', async () => {
  const ctx = await pult();
  let drak, top;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    drak = line(h, 0, h.bench(0, 'dreepy'), 'drakloak');
    top = [h.top(0, 'iono'), h.top(0, 'budew')];
  });
  const size = g.snapshot().players[0].deck.length;
  use(g, drak.id, ability(ctx, 'drakloak', 'recon-directive'));
  assert.deepEqual([...g.view(0).pending.options].sort(), [...top].sort());
  answer(g, [top[0]]); settle(g);
  const s = g.snapshot();
  assert(s.players[0].hand.includes(top[0]));
  assert.equal(s.players[0].deck[0], top[1], 'The remaining card is now the bottom card.');
  assert.equal(s.players[0].deck.length, size - 1);
  assert(!uses(g).some((a) => a.pokemonId === drak.id));
});

test('多龙巴鲁托ex 幻影潜袭: 200 to the Active, then 6 counters spread over the Bench; 太晶 stops Bench attack damage only', async () => {
  const ctx = await pult();
  let a, b;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    const active = line(h, 0, s.players[0].active, 'drakloak', 'dragapult-ex');
    h.attach(0, active, 'basic-fire-energy', 'basic-psychic-energy');
    a = h.bench(1, 'duskull'); b = h.bench(1, 'budew');
  });
  attack(g, atk(ctx, 'dragapult-ex', 'phantom-dive'));
  const q = g.view(0).pending;
  assert.equal(q.kind, 'counter-allocation');
  assert.equal(q.counterAllocation.total, 6);
  command(g, { type: 'allocateCounters', requestId: q.id, allocations: [{ pokemonId: a.id, count: 3 }, { pokemonId: b.id, count: 3 }] }, 0);
  settle(g);
  const s = g.snapshot();
  assert(events(g, 'attack.order').some((e) => e.data.damage === 200));
  assert.equal(mon(s, b.id), undefined, '30 HP 含羞苞 is Knocked Out by 3 counters.');
  assert.equal(s.players[1].active.id, a.id);
  assert.equal(s.players[1].active.counters, 3);
  assert.equal(s.players[0].prizes.length, 4, 'Two Knock Outs: the Active and the Benched 含羞苞.');
  // 太晶: 吉雉鸡ex's 100 to a Benched 多龙巴鲁托ex is prevented.
  let benched;
  const t = board(ctx, ['fezandipiti-ex', 'dreepy'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-fire-energy', 'basic-psychic-energy', 'luminous-energy');
    benched = line(h, 1, h.bench(1, 'dreepy'), 'drakloak', 'dragapult-ex');
  });
  attack(t, atk(ctx, 'fezandipiti-ex', 'cruel-arrow'));
  answer(t, [benched.id]); settle(t);
  assert.equal(mon(t.snapshot(), benched.id).counters, 0);
});

test('夜巡灵 渡魂 benches up to 3 夜巡灵 from the discard pile, and only 夜巡灵', async () => {
  const ctx = await pult();
  let dusk;
  const g = board(ctx, ['duskull', 'dreepy'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-psychic-energy');
    dusk = h.discard(0, 'duskull'); h.discard(0, 'dreepy');
  });
  attack(g, atk(ctx, 'duskull', 'come-and-get-you'));
  assert.deepEqual(g.view(0).pending.options, dusk);
  answer(g, dusk); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench.map((m) => m.stack[0]), dusk);
});

test('咒怨炸弹: the user is Knocked Out and its counters can Knock Out too; both Prize trades happen together', async () => {
  const ctx = await pult();
  let noir, spare;
  const g = board(ctx, ['dreepy', 'munkidori'], (s, h) => {
    noir = line(h, 0, h.bench(0, 'duskull'), 'dusclops', 'dusknoir');
    spare = h.bench(1, 'budew');
  });
  use(g, noir.id, ability(ctx, 'dusknoir', 'cursed-blast'));
  answer(g, [g.snapshot().players[1].active.id]); settle(g);
  let s = g.snapshot();
  assert.equal(mon(s, noir.id), undefined, 'The user is Knocked Out.');
  assert.equal(s.players[1].active.id, spare.id, '13 counters Knocked Out the 110 HP 愿增猿.');
  assert.deepEqual([s.players[0].prizes.length, s.players[1].prizes.length], [5, 5]);
  assert(s.events.some((e) => e.ruleId === 'effects.knockout' && e.data.pokemonId === noir.id));
  // 彷徨夜灵 places 5: a Benched 30 HP 含羞苞 is Knocked Out.
  let clops, budew;
  const c = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    clops = line(h, 0, h.bench(0, 'duskull'), 'dusclops'); budew = h.bench(1, 'budew');
  });
  use(c, clops.id, ability(ctx, 'dusclops', 'cursed-blast'));
  answer(c, [budew.id]); settle(c);
  s = c.snapshot();
  assert.equal(mon(s, clops.id), undefined);
  assert.equal(mon(s, budew.id), undefined);
});

test('含羞苞 痒痒花粉 needs no Energy: 10 damage, and the opponent cannot play Items during the next turn', async () => {
  const ctx = await pult();
  let poffin, iono;
  const g = board(ctx, ['budew', 'dreepy'], (s, h) => { [poffin, iono] = h.hand(1, 'buddy-buddy-poffin', 'iono'); });
  attack(g, atk(ctx, 'budew', 'itchy-pollen')); settle(g);
  const s = g.snapshot();
  assert.equal(s.current, 1);
  assert.equal(s.players[1].active.counters, 1);
  const legal = g.view(1).legalActions.filter((a) => a.type === 'playTrainer').map((a) => a.cardId);
  assert(!legal.includes(poffin), 'Items are locked.');
  assert(legal.includes(iono), 'Supporters are not.');
});

test('愿增猿 亢奋脑力 needs an attached Energy providing 【恶】 and moves 1 to 3 counters to an opposing Pokémon', async () => {
  const ctx = await pult();
  let mk;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    mk = h.bench(0, 'munkidori'); h.attach(0, mk, 'luminous-energy'); s.players[0].active.counters = 5;
  });
  use(g, mk.id, ability(ctx, 'munkidori', 'adrena-brain'));
  answer(g, [g.snapshot().players[0].active.id]);
  assert.deepEqual(g.view(0).pending.options, ['1', '2', '3']);
  answer(g, ['2']); answer(g, [g.snapshot().players[1].active.id]); settle(g);
  assert.deepEqual([g.snapshot().players[0].active.counters, g.snapshot().players[1].active.counters], [3, 2]);
  // 超 Energy, or 夜光能量 beside another Special Energy (then only 【无】), does not satisfy 【恶】.
  for (const keys of [['basic-psychic-energy'], ['luminous-energy', 'neo-upper-energy']]) {
    const dry = board(ctx, ['dreepy', 'dreepy'], (s, h) => { h.attach(0, h.bench(0, 'munkidori'), ...keys); s.players[0].active.counters = 5; });
    assert.deepEqual(uses(dry), []);
  }
});

test('摔角鹰人 飞身入场 from hand: 1 counter on each of 2 chosen opposing Benched Pokémon (谢米 stops damage, not counters)', async () => {
  const ctx = await pult();
  let card, a, b, c;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [card] = h.hand(0, 'hawlucha'); a = h.bench(1, 'duskull'); b = h.bench(1, 'budew'); c = h.bench(1, 'shaymin');
  });
  command(g, { type: 'bench', cardId: card });
  assert.equal(g.view(0).pending.kind, 'trigger-optional');
  answer(g, ['perform']);
  assert.deepEqual([g.view(0).pending.minimum, g.view(0).pending.maximum], [2, 2]);
  answer(g, [b.id, c.id]); settle(g);
  const s = g.snapshot();
  assert.deepEqual([a, b, c].map((m) => mon(s, m.id).counters), [0, 1, 1]);
});

test('月月熊 赫月ex: 血月 costs 1 【无】 less per Prize card the opponent has taken, deals 240 and locks the next own turn', async () => {
  const ctx = await pult();
  const blood = atk(ctx, 'bloodmoon-ursaluna-ex', 'blood-moon');
  const fresh = board(ctx, ['bloodmoon-ursaluna-ex', 'dreepy'], (s, h) => { h.attach(0, s.players[0].active, 'basic-fire-energy', 'basic-psychic-energy'); });
  assert(!attacks(fresh).includes(blood));
  const g = board(ctx, ['bloodmoon-ursaluna-ex', 'dreepy'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-fire-energy', 'basic-psychic-energy'); leavePrizes(s, 1, 3); h.bench(1, 'duskull');
  });
  assert(attacks(g).includes(blood), 'The opponent took 3 Prize cards: 5 - 3 = 2.');
  attack(g, blood); settle(g);
  assert(events(g, 'attack.order').some((e) => e.data.damage === 240));
  command(g, { type: 'endTurn' }, 1); settle(g);
  assert.equal(g.snapshot().current, 0);
  assert(!attacks(g).includes(blood), 'Locked during the next own turn.');
});

test('谢米 花之纱幔: opposing attack damage to own Benched Pokémon without a Rule Box is prevented; Rule Box Pokémon still take it', async () => {
  const ctx = await pult();
  for (const [key, expected] of [['duskull', 0], ['latias-ex', 10]]) {
    let target;
    const g = board(ctx, ['fezandipiti-ex', 'dreepy'], (s, h) => {
      h.attach(0, s.players[0].active, 'basic-fire-energy', 'basic-psychic-energy', 'luminous-energy');
      h.bench(1, 'shaymin'); target = h.bench(1, key);
    });
    attack(g, atk(ctx, 'fezandipiti-ex', 'cruel-arrow'));
    answer(g, [target.id]); settle(g);
    assert.equal(mon(g.snapshot(), target.id).counters, expected);
  }
});

test('items: 友好宝芬 (Basic, HP 70 or less, to the Bench), 宝可平板 (no Rule Box), 反击捕捉器 (only when behind on Prize cards)', async () => {
  const ctx = await pult();
  let card;
  const p = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [card] = h.hand(0, 'buddy-buddy-poffin'); });
  play(p, card);
  const keys = (g) => [...new Set(g.view(0).pending.options.map((id) => ctx.catalog.definition(defOf(g.snapshot(), id)).nameKey))].sort();
  assert.deepEqual(keys(p), ['budew', 'dreepy', 'duskull', 'hawlucha']);
  const offered = p.view(0).pending.options;
  const picks = [offered.find((id) => defOf(p.snapshot(), id) === ctx.id.budew), offered.find((id) => defOf(p.snapshot(), id) === ctx.id.hawlucha)];
  answer(p, picks); settle(p);
  assert.deepEqual(p.snapshot().players[0].bench.map((m) => m.stack[0]).sort(), [...picks].sort());
  assert.deepEqual(events(p, 'damage.counters'), [], 'Benched by an effect, not played from hand: no 飞身入场.');

  const pad = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [card] = h.hand(0, 'poke-pad'); });
  play(pad, card);
  const padKeys = keys(pad);
  assert(!padKeys.some((k) => k.endsWith('-ex')), 'No Pokémon with a Rule Box.');
  assert(['drakloak', 'dusknoir', 'shaymin', 'munkidori'].every((k) => padKeys.includes(k)));

  let gust, target;
  const even = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [gust] = h.hand(0, 'counter-catcher'); target = h.bench(1, 'budew'); });
  assert(!playable(even, gust));
  const behind = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [gust] = h.hand(0, 'counter-catcher'); target = h.bench(1, 'budew'); leavePrizes(s, 1, 4); });
  play(behind, gust); answer(behind, [target.id]); settle(behind);
  assert.equal(behind.snapshot().players[1].active.id, target.id);
});

test('supporters: 奇树 (both hands to the bottom, draw own remaining Prize cards), 莉莉艾的决心 (6, or 8 with 6 Prize cards)', async () => {
  const ctx = await pult();
  let card, mine, theirs;
  const g = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    [card, ...mine] = h.hand(0, 'iono', 'budew', 'shaymin'); theirs = h.hand(1, 'iono', 'poke-pad', 'duskull');
    leavePrizes(s, 0, 4); leavePrizes(s, 1, 2);
  });
  play(g, card); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[0].hand.length, s.players[1].hand.length], [4, 2]);
  assert.deepEqual([...s.players[0].deck.slice(0, 2)].sort(), [...mine].sort(), 'The old hand is under the deck.');
  assert.deepEqual([...s.players[1].deck.slice(0, 3)].sort(), [...theirs].sort());
  for (const [remaining, drawn] of [[6, 8], [5, 6]]) {
    const l = board(ctx, ['dreepy', 'dreepy'], (s, h) => { [card] = h.hand(0, 'lillies-determination', 'budew'); leavePrizes(s, 0, remaining); });
    play(l, card); settle(l);
    assert.equal(l.snapshot().players[0].hand.length, drawn);
  }
});

test('阻碍之塔: Pokémon Tools of both players have no effect while it is in play', async () => {
  const ctx = await reviewed([5, 6, 7, 8], [DECK, DRAGAPULT], OPEN_FORMAT);
  for (const [tower, damage] of [[false, 40], [true, 30]]) {
    const g = board(ctx, ['pikachu-ex', 'shaymin'], (s, h) => {
      h.energy(0, s.players[0].active); h.tool(0, s.players[0].active, 'vitality-band');
      if (tower) { const [id] = h.hand(1, 'jamming-tower'); s.players[1].hand.splice(s.players[1].hand.indexOf(id), 1); s.stadium = id; }
    });
    attack(g, atk(ctx, 'pikachu-ex', 'pika-punch')); settle(g);
    assert.deepEqual(events(g, 'attack.order').map((e) => e.data.damage), [damage]);
  }
});

test('夜光能量 is 1 all-type Energy unless another Special Energy is attached; 新冲天能量 is 2 all-type on a Stage 2, else 1 【无】', async () => {
  const ctx = await pult();
  let m;
  const one = board(ctx, ['dreepy', 'dreepy'], (s, h) => { h.attach(0, s.players[0].active, 'luminous-energy'); });
  assert.deepEqual(one.view(0).players[0].active.effective.energies.map((e) => e.units), [[ENERGY_TYPES]]);
  assert(attacks(one).includes(atk(ctx, 'dreepy', 'petty-grudge')));
  const two = board(ctx, ['dreepy', 'dreepy'], (s, h) => { h.attach(0, s.players[0].active, 'luminous-energy', 'luminous-energy'); });
  assert.deepEqual(two.view(0).players[0].active.effective.energies.map((e) => e.units), [[['Colorless']], [['Colorless']]]);
  assert.deepEqual(attacks(two), [], 'Two 【无】 cannot pay 【超】.');
  const low = board(ctx, ['dreepy', 'dreepy'], (s, h) => { h.attach(0, s.players[0].active, 'neo-upper-energy'); });
  assert.deepEqual(low.view(0).players[0].active.effective.energies.map((e) => e.units), [[['Colorless']]]);
  const high = board(ctx, ['dreepy', 'dreepy'], (s, h) => {
    m = line(h, 0, s.players[0].active, 'drakloak', 'dragapult-ex'); h.attach(0, m, 'neo-upper-energy');
  });
  assert.deepEqual(high.view(0).players[0].active.effective.energies.map((e) => e.units), [[ENERGY_TYPES, ENERGY_TYPES]]);
  assert(attacks(high).includes(atk(ctx, 'dragapult-ex', 'phantom-dive')), 'One card pays 【火】【超】.');
});

test('the CPU completes full Standard games with this deck (mirror and against 猛雷鼓ex), restoring identically', async () => {
  for (const [decks, seed] of [[[DRAGAPULT, DRAGAPULT], [3, 1, 4, 1]], [[DRAGAPULT, BOLT], [2, 7, 1, 8]]]) {
    const ctx = await reviewed(seed, decks, STANDARD_FORMAT);
    const ai = createAI(ctx.catalog);
    for (let steps = 0; !ctx.game.snapshot().result; steps++) {
      if (steps > 2000) assert.fail('The CPU game must terminate.');
      const s = ctx.game.snapshot(), player = s.pending ? s.pending.player : s.current;
      const view = ctx.game.view(player);
      ctx.game.dispatch({ player, expectedRevision: view.revision, action: ai(view, player) });
    }
    assert.deepEqual(restore(ctx.game, ctx.catalog).snapshot(), ctx.game.snapshot());
  }
});
