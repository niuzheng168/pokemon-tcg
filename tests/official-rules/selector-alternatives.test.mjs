// Synthetic definitions only. Printed alternatives of Pokémon in one selector: 「宝可梦GX・EX」, 「「由克希」或「亚克诺姆」」
// (anyOf of Pokémon selectors), wherever a Pokémon selector is read. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { isKindSelector } from '../../public/rules/card-selection.js';
import { assertKindSelector } from '../../public/rules/battle-value.js';
import { assertPokemonHealingAction } from '../../public/rules/healing.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const either = { anyOf: [{ kind: 'pokemon', nameKeys: ['other'] }, { kind: 'pokemon', stages: ['stage1'] }] };
const tags = { anyOf: [{ kind: 'pokemon', tagsAll: ['GX'] }, { kind: 'pokemon', tagsAll: ['EX'] }] };

test('schemas and validators: alternatives of Pokémon only, at least two', () => {
  assert(isKindSelector(tags, 'pokemon') && isKindSelector({ kind: 'pokemon' }, 'pokemon'));
  for (const s of [{ anyOf: [{ kind: 'pokemon' }, { kind: 'trainer' }] }, { anyOf: [{ kind: 'pokemon' }] }, { kind: 'any' }, [tags], null])
    assert(!isKindSelector(s, 'pokemon'), JSON.stringify(s));
  assert.doesNotThrow(() => assertKindSelector(tags, 'pokemon'));
  assert.throws(() => assertKindSelector({ anyOf: [{ kind: 'pokemon' }, { kind: 'energy' }] }, 'pokemon'));
  for (const [id, p] of [
    ['cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected', selector: tags }],
    ['cn.knockOut@1', { target: 'active', side: 'opponent', selector: either }],
    ['cn.attachHand@1', { type: null, count: 1, benchOnly: false, optional: false, recipient: tags }],
    ['cn.lasting@1', { side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
      effect: { op: 'restriction', scope: 'all', actions: ['attack'], targetSelector: tags } }],
    ['cn.drawValue@1', { count: { kind: 'pokemonCount', side: 'own', zone: 'bench', selector: either } }]])
    assert(valid(id, p), id);
  assert(!valid('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected',
    selector: { anyOf: [{ kind: 'pokemon', tagsAll: ['GX'] }, { kind: 'trainer' }] } }));
  assert.doesNotThrow(() => assertPokemonHealingAction({ op: 'healPokemon', side: 'own', target: 'any', selector: tags, amount: 30,
    selection: { kind: 'all' }, discardHealedEnergy: false }));
  assert(valid('cn.distributeCounters@1', { op: 'distributeCounters', side: 'opponent', target: 'any', selector: tags, count: 5 }));
  assert(valid('cn.attachDeckEnergy@1', { op: 'attachDeckEnergy', lookTop: 5, selector: { kind: 'energy', category: 'basic' },
    quantity: { kind: 'upTo', count: 2 }, recipient: { position: 'bench', selector: tags }, distribution: 'separateRecipients',
    remainder: 'shuffleDeck', reveal: false }));
});

test('「选择对手的1只「X」或1阶进化备战宝可梦，将其与战斗宝可梦互换」 and a count of either kind', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected', selector: either }, 'catch')];
    def(defs, 'research').mechanics.effects = [binding('cn.drawValue@1', { count: { kind: 'pokemonCount', side: 'own', zone: 'bench', selector: either } }, 'count')];
  });
  let card, one, two;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); one = bench(s, 1, 'other'); two = bench(s, 1, 'evolution'); bench(s, 1, 'base'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.view(0).pending.options, [one.id, two.id]);
  answer(g, [two.id]); settle(g);
  assert.equal(g.snapshot().players[1].active.id, two.id);
  const h = board(f, (s) => { card = hand(s, 0, 'research'); bench(s, 0, 'other'); bench(s, 0, 'evolution'); bench(s, 0, 'base'); });
  const before = h.snapshot().players[0].hand.length;
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.equal(h.snapshot().players[0].hand.length, before - 1 + 2);
});
