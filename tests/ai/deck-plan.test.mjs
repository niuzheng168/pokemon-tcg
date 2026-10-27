// Deck plans (ai/deck-plan.mjs): a written strategy (scripts/ai-deck-strategy.mjs) reaches the plan in its terms, names
// the list does not play left out; a list without one, and of another archetype, plays with the inferred plan only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRelease } from '../../server/catalog.mjs';
import { DECK_POOL } from '../../ai/decks.mjs';

const listKey = (cards) => cards.map(([p, n]) => `${p}×${n}`).sort().join();
const bolt = DECK_POOL['raging-bolt-679141'], other = DECK_POOL['csvh1c-clefairy'];
process.env.AI_DECK_STRATEGIES = join(mkdtempSync(join(tmpdir(), 'strategies-')), 'strategies.json');
writeFileSync(process.env.AI_DECK_STRATEGIES, JSON.stringify({ decks: { bolt: { list: listKey(bolt.cards), archetype: null, strategy: {
  attackers: [{ name: '猛雷鼓ex', role: 'main' }, { name: '吉雉鸡ex', role: 'finisher' }, { name: '厄诡椪 碧草面具ex', role: 'secondary' }, { name: '喷火龙ex', role: 'main' }],
  turn2Board: [{ name: '猛雷鼓ex', count: 5 }, { name: '厄诡椪 碧草面具ex', count: 2 }, { name: '喷火龙ex', count: 1 }],
  searchPriority: ['厄诡椪 碧草面具ex', '喷火龙ex', '猛雷鼓ex'], discardFirst: ['零之大空洞'],
  energy: { ammo: 'field', attach: [{ name: '猛雷鼓ex' }] },
} } } }));
const { deckPlan } = await import('../../ai/deck-plan.mjs');

test('a written strategy reaches the plan: attackers, the turn-2 board as the goal, orders as scores', async () => {
  const release = await loadRelease(), catalog = await release.catalogFor([...bolt.cards, ...other.cards].map(([p]) => p));
  const key = (name) => catalog.definitionFor(bolt.cards.find(([p]) => catalog.definitionFor(p).name === name)[0]).nameKey;
  const { strategy } = deckPlan(catalog, bolt.cards);
  // Only a main attacker is one the plan builds for; a card the list does not play is left out.
  assert.deepEqual(strategy.attackers, [key('猛雷鼓ex')]);
  // No more of a card than the list plays (three).
  assert.deepEqual(strategy.goal, [{ nameKey: key('猛雷鼓ex'), count: 3 }, { nameKey: key('厄诡椪 碧草面具ex'), count: 2 }]);
  assert.equal(strategy.ammo, 'any');
  assert.deepEqual(strategy.search, { [key('厄诡椪 碧草面具ex')]: 1, [key('猛雷鼓ex')]: 0.5 });
  assert.deepEqual(strategy.discard, { [key('零之大空洞')]: 1 });
  assert.deepEqual(strategy.attach, { [key('猛雷鼓ex')]: 1 });
  assert.equal(deckPlan(catalog, other.cards).strategy, null);
});
