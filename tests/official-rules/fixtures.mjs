// Synthetic specification fixtures ONLY; never installed as approved real cards.
import { createCardCatalog } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting } from '../../public/rules/card-schema.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { OfficialGame } from '../../public/rules/game.js';
import { emptyConditions } from '../../public/rules/conditions.js';
import { createBattleHistory, recordBattleTurn } from '../../public/rules/battle-history.js';

export const RULESET = { region: 'CN', version: 'V20261019' };
export const EVIDENCE = [{
  sourceId: 'fixture-not-a-real-card', kind: 'official-card', url: 'https://www.pokemon.cn/',
  locator: 'TEST ONLY: synthetic rule fixture, not an actual official card or approval',
}];
export const binding = (handlerId, parameters, effectId = handlerId) => ({
  effectId: `fixture:${effectId}`, handlerId, parameters, sourceOfTruth: EVIDENCE,
});
const base = (id, name, kind, mechanics) => ({
  schemaVersion: '1.0.0', definitionId: id, ruleset: RULESET, name, nameKey: id, kind,
  sourceOfTruth: EVIDENCE, implementation: { status: 'verified', testIds: ['fixture:test'] },
  deckLimits: { sameName: 4, groups: [] }, mechanics,
});
const pokemon = (id, hp = 100) => base(id, `测试宝可梦${id}`, 'pokemon', {
  stage: 'basic', evolvesFrom: null, hp, types: ['Water'],
  weakness: { type: 'Fire', operation: 'multiply', value: 2 }, resistance: null, retreatCost: 1,
  attacks: [{ attackId: `${id}:strike`, name: '测试撞击', cost: ['Water'],
    printedDamage: { value: 20, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE }],
  abilities: [], ruleBox: false, prizeCount: 1, tags: [], effects: [],
});

export async function fixture(transform = () => {}, extraHandlers = new Map()) {
  const definitions = [
    pokemon('base'), pokemon('other'),
    base('evolution', '测试进化宝可梦', 'pokemon', {
      ...pokemon('evolution', 150).mechanics, stage: 'stage1', evolvesFrom: 'base',
    }),
    base('water', '测试基本水能量', 'energy', { category: 'basic', baseUnits: [['Water']], effects: [] }),
    base('fire', '测试基本火能量', 'energy', { category: 'basic', baseUnits: [['Fire']], effects: [] }),
    base('double', '测试双重能量', 'energy', { category: 'special', baseUnits: [['Colorless'], ['Colorless']], effects: [] }),
    base('research', '测试弃手抽牌', 'trainer', { category: 'supporter', effects: [
      binding('cn.discardHand@1', {}), binding('cn.draw@1', { count: 7 }),
    ] }),
    base('potion', '测试伤药', 'trainer', { category: 'item', effects: [binding('cn.heal@1', { target: 'any', amount: 30 })] }),
    base('tool', '测试增伤道具', 'trainer', { category: 'tool', effects: [binding('cn.modifier@1',
      { field: 'attackDamage', amount: 30, scope: 'self' })] }),
    base('hp-tool', '测试HP道具', 'trainer', { category: 'tool', effects: [binding('cn.modifier@1',
      { field: 'hp', amount: 50, scope: 'self' })] }),
    base('stadium', '测试竞技场', 'trainer', { category: 'stadium', effects: [binding('cn.modifier@1',
      { field: 'defenseDamage', amount: -20, scope: 'all' })] }),
    base('poison', '测试中毒物品', 'trainer', { category: 'item', effects: [binding('cn.condition@1',
      { side: 'opponent', condition: 'poisoned', poisonCounters: 4 })] }),
  ];
  definitions.filter((d) => ['water', 'fire'].includes(d.definitionId)).forEach((d) => { d.deckLimits.sameName = null; });
  transform(definitions);
  const handlers = new Map([...createCoreHandlers(), ...extraHandlers]);
  const printings = definitions.map((d, i) => ({
    schemaVersion: '1.0.0', printingId: `printing:${d.definitionId}`, game: 'tcg', language: 'zh-Hans',
    setCode: 'TEST-NOT-A-REAL-SET', number: `${i + 1}/999`, regulationMark: 'G', identityReview: 'verified',
    definitionBindings: [{ ruleset: RULESET, definitionId: d.definitionId, sourceOfTruth: EVIDENCE }], metadataRefs: [],
  }));
  const approvedDefinitions = new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)]));
  const approvedPrintings = new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)]));
  const catalog = await createCardCatalog({ ruleset: RULESET, definitions, printings, approvedDefinitions, approvedPrintings, handlers });
  const deck = ['base', 'base', 'other', 'other', 'evolution', 'double', 'research', 'potion', 'tool', 'hp-tool', 'stadium', 'poison']
    .map((id) => `printing:${id}`);
  while (deck.length < 60) deck.push('printing:water');
  return { catalog, definitions, handlers, deck, seed: [123, 456, 789, 10], ruleset: RULESET };
}

export function answer(game, selected) {
  const s = game.snapshot(), q = s.pending;
  if (!q) throw new Error('No pending fixture choice.');
  return game.dispatch({ player: q.player, expectedRevision: s.revision, action: { type: 'answer', requestId: q.id, selected } });
}
export function settle(game, policy = (q) => q.allowZero ? [] : q.options.slice(0, q.minimum)) {
  for (let i = 0; game.snapshot().pending; i++) {
    if (i > 200) throw new Error('Test policy did not settle choices (test guard, not an engine rule).');
    const q = game.snapshot().pending;
    answer(game, policy(q));
  }
}
export function command(game, action, player = game.snapshot().current) {
  return game.dispatch({ player, expectedRevision: game.snapshot().revision, action });
}
export function start(f, seed = f.seed) {
  const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed });
  settle(game);
  return game;
}

function take(s, owner, definitionId) {
  const p = s.players[owner];
  for (const zone of ['deck', 'hand', 'discard', 'lost']) {
    const i = p[zone].findIndex((id) => s.cards[id].definitionId === definitionId);
    if (i >= 0) return p[zone].splice(i, 1)[0];
  }
  const i = p.prizes.findIndex((id) => s.cards[id].definitionId === definitionId);
  if (i >= 0 && p.deck.length) { const id = p.prizes[i]; p.prizes[i] = p.deck.pop(); return id; }
  throw new Error(`No fixture card available: ${definitionId}`);
}
export function hand(s, owner, id) { const card = take(s, owner, id); s.players[owner].hand.push(card); return card; }
export function attached(s, owner, mon, id) { const card = take(s, owner, id); mon.energy.push(card); return card; }
export function bench(s, owner, id) {
  const m = { id: `m${++s.serial}`, stack: [take(s, owner, id)], energy: [], tools: [], counters: 0,
    conditions: emptyConditions(), enteredTurn: 0, evolvedTurn: 0, used: {}, facts: {} };
  s.players[owner].bench.push(m);
  return m;
}
// Explicit synthetic turn history for a test board, never a production migration.
export function fixtureClock(s, players = [0, 1, 0, 1, 0]) {
  s.turn = players.length; s.first = players[0] ?? null; s.current = players.at(-1) ?? null;
  s.nextPlayer = s.current === null ? 0 : 1 - s.current;
  for (const owner of [0, 1]) s.players[owner].turns = players.filter((p) => p === owner).length;
  s.battleHistory = players.reduce((history, player, i) =>
    recordBattleTurn(history, { turn: i + 1, player }), createBattleHistory());
}
export function board(f, mutate = () => {}) {
  const game = start(f), s = game.snapshot();
  for (const [owner, p] of s.players.entries()) {
    for (const m of [p.active, ...p.bench].filter(Boolean)) p.hand.push(...m.stack, ...m.energy, ...m.tools);
    p.active = null; p.bench = [];
    p.active = bench(s, owner, 'base'); p.bench.pop();
  }
  fixtureClock(s); s.phase = 'main';
  mutate(s);
  return OfficialGame.restore(s, { catalog: f.catalog });
}
