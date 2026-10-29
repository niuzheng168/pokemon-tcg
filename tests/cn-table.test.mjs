// The table UI on the official kernel (public/match.js, public/ui.js): full games through the Match driver with the
// CPU engine on both sides, and the interface text every move, choice and log line needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReviewedGame, OfficialGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { createAI } from '../public/cn/ai.js';
import { Match, ME, OPP, PROMPT_TITLE } from '../public/match.js';
import { STRINGS, RULES } from '../public/i18n/zh-CN.js';
import { fixture, binding, board, command, answer, hand, fixtureClock } from './official-rules/fixtures.mjs';
import { reviewed, board as cardBoard, DECK, BOLT, DRAGAPULT } from './cn-cards/helpers.mjs';
import { LEVELS } from '../ai/agents.mjs';
import { REASON_CODES } from '../ai/reasons.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const release = await loadRelease();
const meta = JSON.parse(await read('public/data/cn/V20261019/decks.json'));
const deckList = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));

test('every interface text the table asks for exists', async () => {
  const src = (await read('public/ui.js')) + (await read('public/match.js'));
  const html = await read('public/index.html');
  const keys = new Set([
    ...[...src.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/\[\s*'((?:tip|why|coach|ui|ex|now)\.[^']+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-html|-title|-aria)?="([^"]+)"/g)].map((m) => m[1]),
  ]);
  // Families built at run time.
  for (const k of ['attack', 'energy', 'evolve', 'bench', 'trainer', 'stadium', 'retreat']) keys.add('group.' + k);
  for (const k of ['first', 'effect', 'multi', 'burn', 'sleep', 'confusion', 'attack']) keys.add('coin.why.' + k);
  for (const k of ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned']) keys.add('st.' + k).add('stx.' + k);
  for (const k of ['weakness', 'resistance', 'counters']) keys.add('note.' + k);
  for (const d of meta.decks) keys.add('format.' + d.format.id).add('deckgroup.' + d.format.id).add(`deckgroup.${d.format.id}.sub`);
  for (const level of LEVELS) keys.add(`lvl.${level.level}.d`);
  for (const code of REASON_CODES) keys.add('adv.' + code);
  for (const where of ['local', 'remote']) keys.add('eng.where.' + where);
  const missing = [...keys].filter((k) => !k.endsWith('.') && !(k in STRINGS));
  assert.deepEqual(missing, []);
  assert.match(RULES, /猜拳/);
  assert.match(RULES, /掷硬币/);
});

// An Energy that provides one of several types (e.g. any type) shows as ★ on the table (match.js).
test('the release types all have names and icons', async () => {
  const css = await read('public/style.css');
  const { catalog } = await createReviewedGame({ release,
    decks: [deckList(meta.decks[1]), deckList(meta.decks[2])], seed: [1, 2, 3, 4], format: meta.decks[1].format, matchMode: 'normal' });
  const types = new Set(catalog.definitions().flatMap((d) => d.kind === 'pokemon' ? d.mechanics.types : d.kind === 'energy' ? d.mechanics.baseUnits.filter((u) => u.length === 1).flat() : []));
  for (const type of types) {
    assert.ok(STRINGS['type.' + type], `type.${type}`);
    assert.ok(css.includes(`.ei-${type} `), `.ei-${type}`);
  }
});

// Your side plays the CPU engine's move from your own view, so a full game runs without a browser.
async function play(mine, theirs, seed, stats) {
  const format = mine.format.id === theirs.format.id ? mine.format : { ...mine.format, id: 'open' };
  const { game, catalog } = await createReviewedGame({ release,
    decks: [deckList(mine), deckList(theirs)], seed, format, matchMode: 'normal' });
  const ai = createAI(catalog);
  const count = (k) => { stats[k] = (stats[k] ?? 0) + 1; };
  const human = {
    async chooseAction(m, p, actions) {
      assert.equal(p, m.players[ME]);
      for (const a of actions) {
        count('act:' + a.kind);
        assert.ok(STRINGS[a.label.key], a.label.key);
        if (a.card) assert.ok(a.card.name && a.card.kind !== 'unknown', `${a.kind} names its card`);
      }
      const want = JSON.stringify(ai(game.view(ME), ME));
      const move = actions.find((a) => JSON.stringify(a.cmd) === want);
      assert.ok(move, `the table offers the CPU's move ${want}`);
      return move;
    },
    async choose(m, p, prompt) {
      count('prompt:' + prompt.kind);
      assert.ok(PROMPT_TITLE[prompt.kind], `a title for ${prompt.kind}`);
      for (const o of prompt.options) assert.ok(o.card || o.mon || o.label || o.back, `${prompt.kind} option ${o.id} is shown`);
      if (prompt.alloc) for (const target of prompt.alloc.targets) assert.ok(target.mon, 'allocation targets are on the board');
      const a = ai(game.view(ME), ME);
      return a.type === 'allocateCounters' ? { allocations: a.allocations } : a.selected;
    },
  };
  const cpu = {
    async decide(view, player) {
      assert.equal(player, OPP);
      assert.ok(!Array.isArray(view.players[ME].hand), 'the opponent never sees your hand');
      return ai(view, player);
    },
  };
  let opening = null;
  const hooks = { onOpening: ({ winner }) => { opening = winner; }, onError: (e) => { throw e; } };
  for (const h of ['onBench', 'onEvolve', 'onAttach', 'onTrainer', 'onAttack', 'onHit', 'onAttackEnd', 'onCoin', 'onKnockout', 'onPrize', 'onOppPrize'])
    hooks[h] = (x) => {
      count('hook:' + h);
      if (h === 'onHit') assert.ok(x.n >= 0 && Number.isInteger(x.to), 'a hit has a target and an amount');
    };
  hooks.onLog = (e) => { assert.ok(e.text && !e.text.includes('undefined'), e.text); };
  hooks.onMoveDone = ({ quiet }) => count(quiet ? 'quiet' : 'loud');
  const m = new Match({ game, catalog, presentation: meta.cards, decks: [mine.id, theirs.id], controllers: [human, cpu], hooks });
  await m.run();
  assert.ok(opening === 0 || opening === 1, 'the opening shows who decides first or second');
  assert.equal(m.phase, 'over');
  assert.ok(m.winReason.text);
  // A save restores to the same table.
  const restored = OfficialGame.restore(structuredClone(game.snapshot()), { catalog });
  assert.deepEqual(restored.view(ME), game.view(ME));
  return m;
}

test('full games on the table driver, each deck on your side', { timeout: 300_000 }, async () => {
  const stats = {};
  const decks = Object.fromEntries(meta.decks.map((d) => [d.id, d]));
  for (const [a, b, seed] of [['dragapult-676815', 'raging-bolt-679141', [1, 2, 3, 4]],
    ['raging-bolt-679141', 'csvh1c-pikachu', [5, 6, 7, 8]], ['csvh1c-pikachu', 'dragapult-676815', [9, 9, 9, 9]]]) {
    const m = await play(decks[a], decks[b], seed, stats);
    assert.ok(m.turn > 2, `${a} vs ${b} lasted more than the first turns`);
  }
  for (const k of ['act:end', 'act:energy', 'act:attack', 'act:bench', 'act:trainer', 'hook:onAttack', 'hook:onHit', 'hook:onAttackEnd', 'quiet', 'loud'])
    assert.ok(stats[k] > 0, `${k} happened`);
});

// effects.guess on the table (synthetic definitions only): the asked opponent's prompt, the CPU's answer from its own view
// (the hint and the cards shown so far, never the catalog's other deck), and the log lines.
test('a face-down guess: the asked prompt, the CPU answer and the log', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.guess@1', { hint: 'name', question: 'hp', count: 4 }, 'guess')];
  });
  let card, mon;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); mon = hand(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: card });
  const m = new Match({ game: g, catalog: f.catalog, presentation: {}, decks: [null, null], controllers: [] });
  assert.equal(m.prompt(g.view(ME)).title, '选择手牌中的1张宝可梦反面朝上放置（也可以不选）：对手将回答它的HP');
  answer(g, [mon]);
  const view = g.view(OPP), prompt = m.prompt(view);
  assert.equal(prompt.title, '回答反面朝上放置的宝可梦：回答它的HP');
  assert.deepEqual(prompt.guess, { question: 'hp', tell: 'name', hint: { name: '测试宝可梦other', nameKey: 'other' } });
  const action = createAI(f.catalog)(view, OPP);
  assert.deepEqual(action, { type: 'guessAnswer', requestId: view.pending.id, answer: { hp: 70 } });
  g.dispatch({ player: OPP, expectedRevision: view.revision, action });
  m.index(g.view(ME));
  assert.deepEqual(g.view(ME).events.filter((e) => e.ruleId === 'effects.guess').map((e) => m.eventLine(e)), [null,
    '你将手牌中的1张宝可梦反面朝上放置，告知名字「测试宝可梦other」；由小茂回答它的HP。',
    '小茂回答HP 70；翻开的是「测试宝可梦other」，回答错误。', '你将「测试宝可梦other」放回手牌。']);
});

// Both sides lose a Pokémon at once (彷徨夜灵「咒怨炸弹」 Knocks Out its user too; recorded match #2): the log gives each
// Knocked Out Pokémon's Prize cards, and each of your Prize choices says which Knock Out it is for and what the opponent takes.
test('a double Knock Out: the Prize cards each Knock Out gives, and why you take yours', async () => {
  const blast = (ctx) => `${ctx.id.dusclops}:cursed-blast`;
  // The opponent's turn, so you take yours first: 5 counters on your 皮卡丘ex (140 of 190 HP already).
  const ctx = await reviewed(undefined, [DECK, DRAGAPULT]);
  let clops;
  const g = cardBoard(ctx, ['pikachu-ex', 'dreepy'], (s, h) => {
    s.players[ME].active.counters = 14;
    h.bench(ME, 'chinchou');
    clops = h.evolve(OPP, h.bench(OPP, 'duskull'), 'dusclops');
    fixtureClock(s, [0, 1, 0, 1, 0, 1]);
  });
  const m = new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: [null, null], controllers: [] });
  command(g, { type: 'useAbility', pokemonId: clops.id, abilityId: blast(ctx) });
  answer(g, [g.snapshot().players[ME].active.id]);
  m.index(g.view(ME));
  assert.deepEqual(g.view(ME).events.filter((e) => e.ruleId === 'ko.boundary').map((e) => m.eventLine(e)), [
    '你的「皮卡丘ex」昏厥了。', '小茂的「彷徨夜灵」昏厥了。', '因你的「皮卡丘ex」昏厥，小茂将拿取2张奖赏卡。', '因小茂的「彷徨夜灵」昏厥，你将拿取1张奖赏卡。']);
  assert.deepEqual(m.prompt(g.view(ME)).why, ['小茂的「彷徨夜灵」昏厥了：你拿取1张奖赏卡。', '你的「皮卡丘ex」也昏厥了：小茂拿取2张奖赏卡。']);
  // A table opened at this choice (a reload) never saw them in play, and names them all the same.
  const reloaded = new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: [null, null], controllers: [] });
  assert.deepEqual(reloaded.prompt(g.view(ME)).why, m.prompt(g.view(ME)).why);

  // Your turn: the opponent takes theirs first, then you take 2 for their 多龙巴鲁托ex (270 of 320 HP), one at a time.
  const ctx2 = await reviewed(undefined, [DRAGAPULT, DRAGAPULT]);
  let mine;
  const b = cardBoard(ctx2, ['dreepy', 'dragapult-ex'], (s, h) => {
    s.players[OPP].active.counters = 27;
    h.bench(OPP, 'dreepy');
    mine = h.evolve(ME, h.bench(ME, 'duskull'), 'dusclops');
  });
  const t = new Match({ game: b, catalog: ctx2.catalog, presentation: meta.cards, decks: [null, null], controllers: [] });
  command(b, { type: 'useAbility', pokemonId: mine.id, abilityId: blast(ctx2) });
  answer(b, [b.snapshot().players[OPP].active.id]);
  assert.equal(b.snapshot().pending.player, OPP);
  answer(b, ['0']);
  const why = [];
  for (const slot of ['0', '0']) {
    t.index(b.view(ME));
    why.push(t.prompt(b.view(ME)).why);
    answer(b, [slot]);
  }
  assert.deepEqual(why, [1, 2].map((n) => [`小茂的「多龙巴鲁托ex」昏厥了：你拿取2张奖赏卡（第${n}张）。`, '你的「彷徨夜灵」也昏厥了：小茂拿取1张奖赏卡。']));
});

// 赤松 on the table (问题报告 bug-20261026T123330Z-match-6): once the two Energy are chosen, each choice of where one goes
// names that Energy and shows the chosen cards, not the deck again; the last card with only one place left is not asked.
test('赤松: each Energy destination names its card, and the forced last one is not asked', async () => {
  const ctx = await reviewed(undefined, [BOLT, BOLT]);
  const run = async (first) => {
    let crispin, wing;
    const g = cardBoard(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => { [crispin] = h.hand(ME, 'crispin'); wing = h.bench(ME, 'slither-wing'); });
    command(g, { type: 'playTrainer', cardId: crispin });
    const s = g.snapshot(), find = (key) => s.players[ME].deck.find((id) => s.cards[id].definitionId === ctx.id[key]);
    const picked = [find('basic-lightning-energy'), find('basic-fighting-energy')];
    answer(g, picked);
    const prompts = [];
    const human = {
      async choose(m, p, prompt) { prompts.push(prompt); return prompts.length === 1 ? first(g) : prompt.options[0].id; },
      async chooseAction(m) { m.stopped = true; },
    };
    const m = new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: [null, null], controllers: [human, null],
      hooks: { onError: (e) => { throw e; } } });
    await m.run({ resume: true });
    const uid = (id) => m.card(id).uid;
    for (const prompt of prompts) assert.deepEqual(prompt.lookedAt.map((c) => c.uid), picked.map(uid), 'the chosen cards, not the deck');
    return { g, m, wing, picked, prompts, uid };
  };

  // 雷 to the Active Pokémon: 斗 can only go to the hand, which is done without a second question.
  const toActive = await run((g) => g.snapshot().players[ME].active.id);
  const [q] = toActive.prompts;
  assert.equal(toActive.prompts.length, 1);
  assert.equal(q.title, '选择「基本雷能量」的去向');
  assert.deepEqual(q.placing, [toActive.uid(toActive.picked[0])]);
  assert.deepEqual([...q.placed], []);
  assert.deepEqual(q.options.map((o) => o.label ?? o.mon.card.name), ['猛雷鼓ex', '爬地翅', '加入手牌']);
  const after = toActive.g.snapshot().players[ME];
  assert.ok(after.active.energy.includes(toActive.picked[0]) && after.hand.includes(toActive.picked[1]));

  // 雷 to the hand: 斗 is asked, among the Pokémon only, with 雷's destination shown.
  const toHand = await run(() => '@hand');
  assert.equal(toHand.prompts.length, 2);
  const second = toHand.prompts[1];
  assert.equal(second.title, '选择「基本斗能量」的去向');
  assert.deepEqual(second.placing, [toHand.uid(toHand.picked[1])]);
  assert.deepEqual([...second.placed], [[toHand.uid(toHand.picked[0]), '加入手牌']]);
  assert.ok(second.options.every((o) => o.mon));
  assert.ok(toHand.g.snapshot().players[ME].active.energy.includes(toHand.picked[1]));
});

// Pokémon of the same name on the table (问题报告 bug-20261029T120054Z-match-6: two 猛雷鼓ex, three 厄诡椪 碧草面具ex): a
// Pokémon to choose says where it is and carries what is attached to it, and an Energy chosen from several Pokémon
// (「极雷轰」) says which one it is on. Energy all on one Pokémon (paying the Retreat Cost) needs no such words.
test('Pokémon of the same name: each choice says where it is and what is attached', async () => {
  const ctx = await reviewed(undefined, [BOLT, BOLT]);
  const make = () => cardBoard(ctx, ['raging-bolt-ex', 'raging-bolt-ex'], (s, h) => {
    h.attach(ME, s.players[ME].active, 'basic-lightning-energy', 'basic-fighting-energy', 'basic-grass-energy');
    h.attach(ME, h.bench(ME, 'teal-mask-ogerpon-ex'), 'basic-grass-energy');
    h.attach(ME, h.bench(ME, 'raging-bolt-ex'), 'basic-fighting-energy');
    h.attach(ME, h.bench(ME, 'teal-mask-ogerpon-ex'), 'basic-grass-energy', 'basic-grass-energy');
    h.bench(ME, 'teal-mask-ogerpon-ex');
  });
  const table = (g) => new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: [null, null], controllers: [] });

  const retreat = make();
  command(retreat, { type: 'retreat' });
  const paying = table(retreat).prompt(retreat.view(ME));
  assert.equal(paying.kind, 'retreat-energy');
  assert.ok(paying.options.every((o) => o.card && !o.on));
  answer(retreat, retreat.view(ME).pending.options);
  const target = table(retreat).prompt(retreat.view(ME));
  assert.equal(target.kind, 'retreat-target');
  assert.deepEqual(target.options.map((o) => [o.mon.name, o.place, o.mon.energy.map((c) => c.energyType)]), [
    ['厄诡椪 碧草面具ex', '我方备战1', ['Grass']], ['猛雷鼓ex', '我方备战2', ['Fighting']],
    ['厄诡椪 碧草面具ex', '我方备战3', ['Grass', 'Grass']], ['厄诡椪 碧草面具ex', '我方备战4', []]]);

  const thunder = make();
  command(thunder, { type: 'attack', attackId: `${ctx.id['raging-bolt-ex']}:bellowing-thunder` });
  const energy = table(thunder).prompt(thunder.view(ME));
  assert.equal(energy.kind, 'attached-energy');
  assert.deepEqual(energy.options.map((o) => [o.card.name, o.on.place, o.on.mon.name]), [
    ['基本雷能量', '我方战斗', '猛雷鼓ex'], ['基本斗能量', '我方战斗', '猛雷鼓ex'], ['基本草能量', '我方战斗', '猛雷鼓ex'],
    ['基本草能量', '我方备战1', '厄诡椪 碧草面具ex'], ['基本斗能量', '我方备战2', '猛雷鼓ex'],
    ['基本草能量', '我方备战3', '厄诡椪 碧草面具ex'], ['基本草能量', '我方备战3', '厄诡椪 碧草面具ex']]);
});

// A choice among looked-at cards (巢穴球 searches the whole deck, 宝可装置3.0 looks at the top 7) is one list on the table:
// each card that is not an option says why, in the words of the condition the effect prints (its card selector).
test('a search says why each other looked-at card cannot be picked', async () => {
  const search = async (decks, active, key, mutate = () => {}) => {
    const ctx = await reviewed(undefined, decks);
    let card;
    const g = cardBoard(ctx, [active, active], (s, h) => { [card] = h.hand(ME, key); mutate(h); });
    command(g, { type: 'playTrainer', cardId: card });
    const m = new Match({ game: g, catalog: ctx.catalog, presentation: meta.cards, decks: [null, null], controllers: [] });
    const q = g.view(ME).pending, prompt = m.prompt(g.view(ME)), offered = prompt.options.map((o) => o.card.uid);
    assert.ok(offered.length && offered.every((uid) => prompt.lookedAt.some((c) => c.uid === uid)), key);
    assert.deepEqual([...prompt.unpickable.keys()], prompt.lookedAt.map((c) => c.uid).filter((uid) => !offered.includes(uid)), key);
    return { m, q, prompt, reasons: [...new Set(prompt.unpickable.values())] };
  };
  const nest = await search([DECK, DECK], 'pikachu-ex', 'nest-ball');
  assert.deepEqual(nest.reasons, ['只能选择基础宝可梦']); // to the Bench: Basic Pokémon (II.C-11)
  assert.deepEqual((await search([DECK, DECK], 'pikachu-ex', 'electric-generator', (h) => h.bench(ME, 'chinchou'))).reasons, ['只能选择基本【雷】能量']);
  assert.deepEqual((await search([BOLT, BOLT], 'raging-bolt-ex', 'pokegear-3-0')).reasons, ['只能选择支援者']);
  assert.deepEqual((await search([DRAGAPULT, DRAGAPULT], 'dreepy', 'buddy-buddy-poffin')).reasons, ['只能选择HP在「70」及以下的基础宝可梦']);
  assert.deepEqual((await search([DRAGAPULT, DRAGAPULT], 'dreepy', 'poke-pad')).reasons, ['只能选择宝可梦（除「拥有规则的宝可梦」外）']);
  // No worded condition: only that this effect cannot take the card.
  const { m, q, prompt } = nest;
  assert.deepEqual([...new Set(m.unpickable({ ...q, effect: { ...q.effect, effectId: 'unknown' } }, prompt.options, prompt.lookedAt).values())],
    ['「巢穴球」的效果不能选择这张卡牌']);
  assert.equal(m.selectorText({ kind: 'pokemon', types: ['Grass'] }, true), '【草】基础宝可梦');
  assert.equal(m.selectorText({ anyOf: [{ kind: 'pokemon', tagsAll: ['ex'] }, { kind: 'energy', category: 'basic', types: ['Lightning'] }] }),
    '宝可梦ex或基本【雷】能量');
  assert.equal(m.selectorText({ kind: 'trainer', categories: ['item', 'tool'] }), '物品或宝可梦道具');
  assert.equal(m.selectorText({ kind: 'pokemon', stages: ['stage1', 'stage2', 'VMAX', 'VSTAR'], excludeTags: ['Fusion Strike'] }), '进化宝可梦（除「汇流」宝可梦外）');
  assert.equal(m.selectorText({ kind: 'pokemon', typesFrom: 'opponentField' }), null); // read only when the effect resolves
});
