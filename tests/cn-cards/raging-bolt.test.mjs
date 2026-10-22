// Mechanism tests for every reviewed card of the 猛雷鼓ex tournament deck
// (OmniTCG deck 679141), using the real approved release and real physical
// cards on hand-built boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateFormatDeck, getFormat } from '../../public/rules/engine.js';
import { createAI } from '../../public/cn/ai.js';
import { DECKS, REVIEW_RECORDS, IMAGE_STORES } from '../../catalog/zh-CN/V20261019/index.mjs';
import { DEFINITIONS, PRINTINGS, PRODUCTS } from '../../catalog/zh-CN/V20261019/raging-bolt.mjs';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { DECK_ENERGY_HAND } from '../../public/rules/deck-energy.js';
import { release, BOLT, DECK, STANDARD_FORMAT, reviewed, board, restore, settle, answer, command, play, attack, playable, events,
  fixtureClock } from './helpers.mjs';

const bolt = (seed) => reviewed(seed, [BOLT, BOLT], STANDARD_FORMAT);
const atk = (ctx, key, name) => `${ctx.id[key]}:${name}`;
const ability = (ctx, key, name) => `${ctx.id[key]}:${name}`;
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });
const uses = (g) => g.view(0).legalActions.filter((a) => a.type === 'useAbility');
const defOf = (s, id) => s.cards[id].definitionId;
const mon = (s, id) => s.players.flatMap((p) => [p.active, ...p.bench]).find((m) => m?.id === id);
const endTurn = (g, player) => { command(g, { type: 'endTurn' }, player); settle(g); };

test('deck 679141: 60 exact Standard printings with a recorded tournament source; one ACE SPEC per deck', async () => {
  const ctx = await bolt();
  const deck = DECKS['raging-bolt-679141'];
  assert.equal(BOLT.length, 60);
  assert.equal(getFormat(deck.format).id, 'standard');
  validateFormatDeck(ctx.catalog, BOLT, deck.format);
  validateFormatDeck(ctx.catalog, BOLT, { ...STANDARD_FORMAT, id: 'open' });
  const [source] = deck.sources;
  assert.equal(source.kind, 'tournament-deck-list');
  assert.match(source.url, /omnitcg\.top\/api\/v1\/jz\/deck\/679141$/);
  assert.equal(source.deckCode, '1YWQN15qdGfUr0xLTT');
  assert.deepEqual([source.eventDate, source.placing], ['2026-09-27', '1/256']);
  const counts = { pokemon: 0, trainer: 0, energy: 0 };
  for (const id of BOLT) counts[ctx.catalog.definitionFor(id).kind]++;
  assert.deepEqual(counts, { pokemon: 17, trainer: 31, energy: 12 });
  const twoAce = [...BOLT];
  twoAce[twoAce.indexOf('zh-Hans:CSV9C:207/208')] = 'zh-Hans:CSV7C:180/204';
  assert.throws(() => validateFormatDeck(ctx.catalog, twoAce, deck.format), /Grouped deck limit/);
  // Pikachu's Open-only deck still plays this deck in Open.
  validateFormatDeck(await release.catalogFor(DECK), DECK, { ...STANDARD_FORMAT, id: 'open' });
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
  const tags = Object.fromEntries(DEFINITIONS.map((d) => [d.nameKey, d.mechanics.tags]));
  assert.deepEqual([tags['raging-bolt-ex'], tags['raging-bolt'], tags['slither-wing'], tags['iron-leaves-ex'], tags['teal-mask-ogerpon-ex']],
    [['ex', 'Ancient'], ['Ancient'], ['Ancient'], ['ex', 'Future'], ['ex', 'Tera']]);
  assert.deepEqual(tags['earthen-vessel'], ['Ancient']);
});

test('猛雷鼓ex 极雷轰: discard any number of own Basic Energy from any Pokémon; 70 × the actual count. 飞溅咆哮 draws 6 after discarding the hand', async () => {
  const ctx = await bolt();
  let bench, energy;
  const g = board(ctx, ['raging-bolt-ex', 'teal-mask-ogerpon-ex'], (s, h) => {
    energy = h.attach(0, s.players[0].active, 'basic-lightning-energy', 'basic-fighting-energy');
    bench = h.bench(0, 'raging-bolt'); energy.push(...h.attach(0, bench, 'basic-grass-energy'));
    h.bench(1, 'mew-ex');
  });
  const prizes = g.snapshot().players[0].prizes.length;
  attack(g, atk(ctx, 'raging-bolt-ex', 'bellowing-thunder'));
  const q = g.view(0).pending;
  assert.equal(q.kind, 'attached-energy'); assert.equal(q.minimum, 0);
  assert.deepEqual([...q.options].sort(), [...energy].sort());
  answer(g, energy); settle(g);
  const s = g.snapshot();
  assert.deepEqual(events(g, 'attack.order').map((e) => e.data.damage), [210]);
  assert.equal(s.players[0].prizes.length, prizes - 2, 'Knocked Out the 210 HP Pokémon ex: 2 Prizes.');
  assert(energy.every((id) => s.players[0].discard.includes(id)));
  // 飞溅咆哮
  const h = board(ctx, ['raging-bolt-ex', 'teal-mask-ogerpon-ex'], (s, x) => {
    x.attach(0, s.players[0].active, 'basic-lightning-energy'); x.hand(0, 'nest-ball', 'crispin');
  });
  const handBefore = h.snapshot().players[0].hand;
  attack(h, atk(ctx, 'raging-bolt-ex', 'bursting-roar')); settle(h);
  const after = h.snapshot().players[0];
  assert(handBefore.every((id) => after.discard.includes(id)));
});

test('猛雷鼓 落雷风暴 hits 1 opposing Pokémon for 30 × its own Energy; 龙之头击 is a plain 130', async () => {
  const ctx = await bolt();
  let target;
  const g = board(ctx, ['raging-bolt', 'mew-ex'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-lightning-energy', 'basic-fighting-energy', 'basic-grass-energy');
    target = h.bench(1, 'squawkabilly-ex');
  });
  attack(g, atk(ctx, 'raging-bolt', 'thundering-bolt'));
  assert.equal(g.view(0).pending.kind, 'damage-targets');
  answer(g, [target.id]); settle(g);
  assert.equal(mon(g.snapshot(), target.id).counters, 9, '3 Energy × 30 to a Benched Pokémon, no Weakness (雷) applied.');
});

test('厄诡椪 碧草面具ex: 碧草之舞 attaches a Basic Grass Energy from hand to itself, then draws; 太晶 blocks Bench attack damage; 万叶阵雨 counts both Actives', async () => {
  const ctx = await bolt();
  let og, grass;
  const g = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    og = h.bench(0, 'teal-mask-ogerpon-ex'); [grass] = h.hand(0, 'basic-grass-energy'); h.hand(0, 'basic-lightning-energy');
  });
  const size = g.snapshot().players[0].hand.length;
  use(g, og.id, ability(ctx, 'teal-mask-ogerpon-ex', 'teal-dance'));
  assert.deepEqual(g.view(0).pending.options, [grass], 'Only Basic Grass Energy.');
  answer(g, [grass]); settle(g);
  assert.deepEqual(mon(g.snapshot(), og.id).energy, [grass]);
  assert.equal(g.snapshot().players[0].hand.length, size);
  assert.equal(uses(g).some((a) => a.pokemonId === og.id), false, 'Once per turn.');
  // 太晶: Fezandipiti's 100 to the Benched Ogerpon is prevented.
  let benched;
  const t = board(ctx, ['fezandipiti-ex', 'mew-ex'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-grass-energy');
    benched = h.bench(1, 'teal-mask-ogerpon-ex');
  });
  attack(t, atk(ctx, 'fezandipiti-ex', 'cruel-arrow'));
  assert(t.view(0).pending.options.includes(benched.id), 'It can still be chosen.');
  answer(t, [benched.id]); settle(t);
  assert.equal(mon(t.snapshot(), benched.id).counters, 0);
  // 万叶阵雨: 30 + 30 × (3 own + 2 opposing Active Energy) = 180.
  const w = board(ctx, ['teal-mask-ogerpon-ex', 'raging-bolt-ex'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-grass-energy');
    h.attach(1, s.players[1].active, 'basic-lightning-energy', 'basic-fighting-energy');
  });
  attack(w, atk(ctx, 'teal-mask-ogerpon-ex', 'myriad-leaf-shower')); settle(w);
  assert.deepEqual(events(w, 'attack.order').map((e) => e.data.damage), [180]);
});

test('梦幻ex: 再起动 draws up to 3 cards in hand; 基因侵入 uses an attack of the opposing Active without its Energy', async () => {
  const ctx = await bolt();
  let mew;
  const g = board(ctx, ['raging-bolt', 'raging-bolt'], (s, h) => { mew = h.bench(0, 'mew-ex'); h.hand(0, 'nest-ball'); });
  use(g, mew.id, ability(ctx, 'mew-ex', 'restart')); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 3);
  assert.equal(uses(g).some((a) => a.pokemonId === mew.id), false, 'Hand already 3 and once per turn.');
  const c = board(ctx, ['mew-ex', 'raging-bolt'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-grass-energy'); h.bench(1, 'ditto');
  });
  attack(c, atk(ctx, 'mew-ex', 'genome-hacking'));
  const q = c.view(0).pending;
  assert.equal(q.kind, 'copy-attack');
  const headbutt = q.attacks.find((a) => a.name === '龙之头击');
  answer(c, [headbutt.optionId]); settle(c);
  assert(events(c, 'attack.order').some((e) => e.data.damage === 130));
  assert(events(c, 'ko.boundary').some((e) => e.data.kind === 'latched'), 'The 130 HP Active is Knocked Out.');
});

test('怒鹦哥ex: 英武重抽 only on the holder\'s first own turn and once per name; 鼓足干劲 attaches up to 2 to 1 Benched Pokémon', async () => {
  const ctx = await bolt();
  let second;
  const g = board(ctx, ['squawkabilly-ex', 'mew-ex'], (s, h) => {
    fixtureClock(s, [1, 0]); second = h.bench(0, 'squawkabilly-ex'); h.hand(0, 'nest-ball', 'crispin');
  });
  const handBefore = g.snapshot().players[0].hand;
  assert.equal(uses(g).length, 2);
  use(g, second.id, ability(ctx, 'squawkabilly-ex', 'squawk-and-seize')); settle(g);
  const s = g.snapshot();
  assert(handBefore.every((id) => s.players[0].discard.includes(id)));
  assert.equal(s.players[0].hand.length, 6);
  assert.deepEqual(uses(g), [], 'Another 英武重抽 cannot be used this turn.');
  const later = board(ctx, ['squawkabilly-ex', 'mew-ex']);
  assert.deepEqual(uses(later), []);
  let target, energies;
  const a = board(ctx, ['squawkabilly-ex', 'mew-ex'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-grass-energy'); target = h.bench(0, 'raging-bolt-ex'); h.bench(0, 'mew-ex');
    energies = [...h.discard(0, 'basic-lightning-energy'), ...h.discard(0, 'basic-fighting-energy')];
  });
  attack(a, atk(ctx, 'squawkabilly-ex', 'motivate'));
  answer(a, energies); answer(a, [target.id]); settle(a);
  assert.deepEqual([...mon(a.snapshot(), target.id).energy].sort(), [...energies].sort());
});

test('铁斑叶ex: 快速游标 switches itself in when played from hand, then moves any Energy; 棱镜利刃 locks its next own turn', async () => {
  const ctx = await bolt();
  let card, energies;
  const g = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [card] = h.hand(0, 'iron-leaves-ex'); h.bench(1, 'raging-bolt-ex');
    energies = h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-lightning-energy');
  });
  command(g, { type: 'bench', cardId: card });
  assert.equal(g.view(0).pending.kind, 'trigger-optional');
  answer(g, ['perform']);
  assert.equal(g.snapshot().players[0].active.stack[0], card);
  answer(g, energies); settle(g);
  const leaves = g.snapshot().players[0].active;
  assert.deepEqual([...leaves.energy].sort(), [...energies].sort());
  attack(g, atk(ctx, 'iron-leaves-ex', 'prism-edge')); settle(g);
  assert.deepEqual(events(g, 'attack.order').map((e) => e.data.damage), [180]);
  endTurn(g, 1);
  assert.equal(g.snapshot().current, 0);
  assert.equal(g.view(0).legalActions.some((a) => a.type === 'attack'), false, 'Locked during the next own turn.');
});

test('古剑豹: 埋入雪中 discards the Stadium in play when played from hand; 冰柱环 returns 1 attached Energy to hand', async () => {
  const ctx = await bolt();
  let card, stadium;
  const g = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [card] = h.hand(0, 'chien-pao'); [stadium] = h.hand(1, 'area-zero-underdepths');
    s.players[1].hand.splice(s.players[1].hand.indexOf(stadium), 1); s.stadium = stadium;
  });
  command(g, { type: 'bench', cardId: card }); answer(g, ['perform']); settle(g);
  assert.equal(g.snapshot().stadium, null);
  assert(g.snapshot().players[1].discard.includes(stadium));
  // This deck has no Basic Water Energy; 梦幻ex copies 冰柱环 without its Energy (II.C-18).
  let energies;
  const a = board(ctx, ['mew-ex', 'chien-pao'], (s, h) => {
    energies = h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-lightning-energy');
    h.bench(1, 'ditto');
  });
  attack(a, atk(ctx, 'mew-ex', 'genome-hacking'));
  answer(a, [a.view(0).pending.attacks.find((x) => x.name === '冰柱环').optionId]);
  assert.equal(a.view(0).pending.kind, 'attached-energy');
  assert.deepEqual([...a.view(0).pending.options].sort(), [...energies].sort(), 'Energy attached to this Pokémon (the user).');
  answer(a, [energies[2]]); settle(a);
  assert(a.snapshot().players[0].hand.includes(energies[2]));
  assert(events(a, 'attack.order').some((e) => e.data.damage === 120));
});

test('吉雉鸡ex: 化危为吉 needs one of the holder\'s Pokémon Knocked Out in the opponent\'s last turn; 残忍箭矢 hits a Bench without Weakness', async () => {
  const ctx = await bolt();
  let fez, victim;
  const g = board(ctx, ['raging-bolt-ex', 'fezandipiti-ex'], (s, h) => {
    fixtureClock(s, [0, 1, 0, 1]);
    fez = h.bench(0, 'fezandipiti-ex'); victim = h.bench(0, 'ditto');
    h.attach(1, s.players[1].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-grass-energy');
  });
  assert.equal(g.snapshot().current, 1);
  attack(g, atk(ctx, 'fezandipiti-ex', 'cruel-arrow'));
  answer(g, [victim.id]); settle(g);
  assert.equal(g.snapshot().current, 0);
  const offered = uses(g).filter((a) => a.abilityId === ability(ctx, 'fezandipiti-ex', 'flip-the-script'));
  assert.deepEqual(offered.map((a) => a.pokemonId), [fez.id]);
  const size = g.snapshot().players[0].hand.length;
  use(g, fez.id, offered[0].abilityId); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, size + 3);
  const quiet = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { h.bench(0, 'fezandipiti-ex'); });
  assert.deepEqual(uses(quiet), []);
});

test('拉帝亚斯ex 天际线 erases every own Basic Pokémon\'s Retreat cost while it is in play', async () => {
  const ctx = await bolt();
  const g = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { h.bench(0, 'latias-ex'); h.bench(0, 'mew-ex'); });
  assert.equal(g.view(0).players[0].active.effective.retreatCost, 0);
  assert(g.view(0).legalActions.some((a) => a.type === 'retreat'));
  const without = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { h.bench(0, 'mew-ex'); });
  assert.equal(without.view(0).players[0].active.effective.retreatCost, 3);
  // No Psychic Energy in this deck: 梦幻ex copies 无限之刃, so the lock falls on the user.
  const a = board(ctx, ['mew-ex', 'latias-ex'], (s, h) => {
    h.attach(0, s.players[0].active, 'basic-grass-energy', 'basic-grass-energy', 'basic-lightning-energy');
    h.bench(1, 'raging-bolt-ex');
  });
  attack(a, atk(ctx, 'mew-ex', 'genome-hacking'));
  answer(a, [a.view(0).pending.attacks.find((x) => x.name === '无限之刃').optionId]); settle(a);
  assert(events(a, 'attack.order').some((e) => e.data.damage === 200));
  endTurn(a, 1);
  assert.equal(a.snapshot().current, 0);
  assert.equal(a.view(0).legalActions.some((x) => x.type === 'attack'), false);
});

test('爬地翅: 踏平 discards the opponent\'s top deck card; 烫伤怒涛 deals 120, 90 to itself and Burns', async () => {
  const ctx = await bolt();
  const g = board(ctx, ['slither-wing', 'raging-bolt-ex'], (s, h) => { h.attach(0, s.players[0].active, 'basic-fighting-energy', 'basic-fighting-energy'); });
  const top = g.snapshot().players[1].deck.at(-1);
  attack(g, atk(ctx, 'slither-wing', 'stomp')); settle(g);
  assert(g.snapshot().players[1].discard.includes(top));
  const b = board(ctx, ['slither-wing', 'raging-bolt-ex'], (s, h) => { h.attach(0, s.players[0].active, 'basic-fighting-energy', 'basic-fighting-energy'); });
  attack(b, atk(ctx, 'slither-wing', 'burning-turbulence')); settle(b);
  const s = b.snapshot();
  assert.equal(s.players[0].active.counters, 9);
  assert.equal(s.players[1].active.counters >= 12, true);
  assert(events(b, 'attack.order').some((e) => e.data.damage === 120));
});

test('百变怪 变身启动: only Active on the first own turn; a deck Basic other than 百变怪 takes its place', async () => {
  const ctx = await bolt();
  const g = board(ctx, ['ditto', 'mew-ex'], (s) => fixtureClock(s, [0]));
  const old = g.snapshot().players[0].active;
  use(g, old.id, ability(ctx, 'ditto', 'transformative-start'));
  const q = g.view(0).pending, s0 = g.snapshot();
  assert(q.options.every((id) => s0.cards[id].definitionId !== ctx.id.ditto && ctx.catalog.definition(s0.cards[id].definitionId).mechanics.stage === 'basic'));
  const bolts = q.options.filter((id) => defOf(s0, id) === ctx.id['raging-bolt-ex']);
  answer(g, [bolts[0]]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].active.stack, [bolts[0]]);
  assert(s.players[0].discard.includes(old.stack[0]));
  const later = board(ctx, ['ditto', 'mew-ex']);
  assert.deepEqual(uses(later), []);
});

test('items: 高级球 (30thC printing), 大地容器, 夜间担架, 宝可装置3.0, 朋友手册, 超级能量回收 and the ACE SPEC 顶尖捕捉器', async () => {
  const ctx = await bolt();
  // 高级球: the 30thC face binds the same reviewed definition as CSVH1C 044.
  const compared = await release.catalogFor(['zh-Hans:30thC:101/103', 'zh-Hans:CSVH1C:044/059']);
  assert.equal(compared.definitionFor('zh-Hans:30thC:101/103').definitionId, compared.definitionFor('zh-Hans:CSVH1C:044/059').definitionId);
  let ball, fee;
  const u = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [ball, ...fee] = h.hand(0, 'ultra-ball', 'crispin', 'pal-pad'); });
  play(u, ball); answer(u, fee.map((id) => paymentOptionId('discard-2', id)));
  assert.equal(u.view(0).pending.kind, 'select-cards');
  // 大地容器: discard 1, up to 2 Basic Energy revealed into hand.
  let vessel, cost;
  const v = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [vessel, cost] = h.hand(0, 'earthen-vessel', 'pal-pad'); });
  play(v, vessel); answer(v, [paymentOptionId('discard-1', cost)]);
  const vq = v.view(0).pending;
  assert.equal(vq.maximum, 2);
  answer(v, vq.options.slice(0, 2)); settle(v);
  assert(events(v, 'effects.search').some((e) => e.data.revealed?.length === 2));
  // 夜间担架: one Pokémon OR one Basic Energy.
  let stretcher, pk, en;
  const n = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [stretcher] = h.hand(0, 'night-stretcher'); [pk] = h.discard(0, 'ditto'); [en] = h.discard(0, 'basic-grass-energy'); h.discard(0, 'crispin');
  });
  play(n, stretcher);
  const nq = n.view(0).pending;
  assert.deepEqual([...nq.options].sort(), [pk, en].sort()); assert.equal(nq.maximum, 1);
  answer(n, [pk]); settle(n);
  assert(n.snapshot().players[0].hand.includes(pk));
  // 宝可装置3.0: top 7, one Supporter.
  let gear, sup;
  const p = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [gear] = h.hand(0, 'pokegear-3-0'); sup = h.top(0, 'crispin'); });
  play(p, gear);
  const pq = p.view(0).pending;
  assert.equal(pq.lookedAt.length, 7); assert(pq.options.includes(sup));
  answer(p, [sup]); settle(p);
  assert(p.snapshot().players[0].hand.includes(sup));
  // 朋友手册: up to 2 Supporters back into the deck.
  let pad, sups;
  const q2 = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [pad] = h.hand(0, 'pal-pad'); sups = [...h.discard(0, 'crispin'), ...h.discard(0, 'bosss-orders')]; });
  play(q2, pad); answer(q2, sups); settle(q2);
  assert(sups.every((id) => q2.snapshot().players[0].deck.includes(id)));
  // 超级能量回收: Energy discarded to pay its own cost is not eligible.
  let sr, paid, old;
  const r = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [sr, ...paid] = h.hand(0, 'superior-energy-retrieval', 'basic-grass-energy', 'basic-fighting-energy');
    old = h.discard(0, 'basic-lightning-energy', 2);
  });
  play(r, sr); answer(r, paid.map((id) => paymentOptionId('discard-2', id)));
  assert.deepEqual([...r.view(0).pending.options].sort(), [...old].sort());
  // 顶尖捕捉器: opponent's switch, then own switch; unusable without an opposing Bench.
  let catcher, theirs, mine;
  const c = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [catcher] = h.hand(0, 'prime-catcher'); mine = h.bench(0, 'mew-ex'); theirs = h.bench(1, 'ditto'); });
  play(c, catcher); answer(c, [theirs.id]); answer(c, [mine.id]); settle(c);
  assert.deepEqual([c.snapshot().players[1].active.id, c.snapshot().players[0].active.id], [theirs.id, mine.id]);
  const none = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [catcher] = h.hand(0, 'prime-catcher'); h.bench(0, 'mew-ex'); });
  assert.equal(playable(none, catcher), false);
});

test('supporters: 奥琳博士的气魄 (古代 only, one each, then draw 3), 赤松 (distinct types, one to hand), 老大的指令, 裁判 (30thDC)', async () => {
  const ctx = await bolt();
  let sada, wing, og, discarded;
  const g = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [sada] = h.hand(0, 'professor-sadas-vitality'); wing = h.bench(0, 'slither-wing'); og = h.bench(0, 'teal-mask-ogerpon-ex');
    discarded = [...h.discard(0, 'basic-lightning-energy'), ...h.discard(0, 'basic-fighting-energy'), ...h.discard(0, 'basic-grass-energy')];
  });
  const size = g.snapshot().players[0].hand.length;
  play(g, sada);
  answer(g, discarded.slice(0, 2));
  const targets = g.view(0).pending.options;
  assert.deepEqual([...targets].sort(), [g.snapshot().players[0].active.id, wing.id].sort(), 'Only 古代 Pokémon.');
  answer(g, [g.snapshot().players[0].active.id]); answer(g, [wing.id]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, size - 1 + 3);
  assert.equal(mon(g.snapshot(), og.id).energy.length, 0);
  // 赤松
  let crispin;
  const c = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [crispin] = h.hand(0, 'crispin'); });
  play(c, crispin);
  const s = c.snapshot(), deck = s.players[0].deck;
  const pickL = deck.find((id) => defOf(s, id) === ctx.id['basic-lightning-energy']);
  const pickL2 = deck.filter((id) => defOf(s, id) === ctx.id['basic-lightning-energy'])[1];
  const pickF = deck.find((id) => defOf(s, id) === ctx.id['basic-fighting-energy']);
  assert.throws(() => answer(c, [pickL, pickL2]));
  answer(c, [pickL, pickF]);
  assert(c.view(0).pending.options.includes(DECK_ENERGY_HAND));
  answer(c, [DECK_ENERGY_HAND]); answer(c, [c.snapshot().players[0].active.id]); settle(c);
  assert(c.snapshot().players[0].hand.includes(pickL));
  assert(c.snapshot().players[0].active.energy.includes(pickF));
  // 老大的指令
  let boss, theirs;
  const b = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [boss] = h.hand(0, 'bosss-orders'); theirs = h.bench(1, 'ditto'); });
  play(b, boss); answer(b, [theirs.id]); settle(b);
  assert.equal(b.snapshot().players[1].active.id, theirs.id);
  // 裁判 (30thDC): both hands into decks, each draws 4.
  let judge;
  const j = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    const p = s.players[0];
    const id = s.players[0].deck.find((x) => s.cards[x].printingId === 'zh-Hans:30thDC:037/040');
    p.deck.splice(p.deck.indexOf(id), 1); p.hand.push(id); judge = id; h.hand(1, 'crispin', 'pal-pad');
  });
  play(j, judge); settle(j);
  assert.deepEqual(j.snapshot().players.map((p) => p.hand.length), [4, 4]);
});

test('零之大空洞: eight Benched with a 太晶 Pokémon in play; losing it trims to five, the holder first', async () => {
  const ctx = await bolt();
  let zero, og;
  const g = board(ctx, ['teal-mask-ogerpon-ex', 'mew-ex'], (s, h) => {
    [zero] = h.hand(0, 'area-zero-underdepths');
    for (const key of ['raging-bolt-ex', 'raging-bolt-ex', 'mew-ex', 'ditto', 'slither-wing']) h.bench(0, key);
    h.hand(0, 'latias-ex', 'chien-pao');
  });
  assert.equal(g.view(0).players[0].benchLimit, 5);
  play(g, zero); settle(g);
  assert.equal(g.view(0).players[0].benchLimit, 8);
  assert(g.view(0).legalActions.some((a) => a.type === 'bench'));
  for (const a of g.view(0).legalActions.filter((x) => x.type === 'bench')) command(g, a);
  settle(g, (q) => q.kind === 'trigger-optional' ? ['skip'] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[0].bench.length, 7);
  // The only 太晶 Pokémon is Knocked Out: Bench back to five, no Prizes for the trimmed ones.
  const k = board(ctx, ['teal-mask-ogerpon-ex', 'raging-bolt-ex'], (s, h) => {
    fixtureClock(s, [0, 1, 0, 1]);
    const id = h.hand(0, 'area-zero-underdepths')[0]; s.players[0].hand.pop(); s.stadium = id;
    for (const key of ['raging-bolt-ex', 'raging-bolt', 'mew-ex', 'ditto', 'slither-wing', 'latias-ex', 'chien-pao']) h.bench(0, key);
    s.players[0].active.counters = 20;
    h.attach(1, s.players[1].active, 'basic-lightning-energy', 'basic-fighting-energy');
  });
  attack(k, atk(ctx, 'raging-bolt-ex', 'bellowing-thunder'));
  answer(k, k.view(1).pending.options.slice(0, 1));
  const q = k.snapshot().pending;
  assert.deepEqual([q.kind, q.player, q.minimum], ['bench-trim', 0, 2]);
  settle(k);
  assert.equal(k.snapshot().players[0].bench.length, 4, 'Five remain, then one is promoted.');
  assert.equal(events(k, 'bench.limit').length, 2);
});

test('the CPU completes full Standard games with this deck (mirror and against the 嗨皮 deck), restoring identically', async () => {
  for (const [decks, format, seed] of [[[BOLT, BOLT], STANDARD_FORMAT, [3, 1, 4, 1]], [[BOLT, DECK], { ...STANDARD_FORMAT, id: 'open' }, [2, 7, 1, 8]]]) {
    const ctx = await reviewed(seed, decks, format);
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
