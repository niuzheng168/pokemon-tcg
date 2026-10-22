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
  for (const k of [0, 1, 2, 3, 4]) keys.add('win.' + k);
  for (const k of ['cpu', 'jev', 'local']) keys.add(`eng.${k}.t`).add(`eng.${k}.d`);
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
