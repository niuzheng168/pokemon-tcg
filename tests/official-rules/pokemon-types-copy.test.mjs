import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCandidates } from '../../public/rules/attack-copy.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, bench, hand, attached, command, answer, settle } from './fixtures.mjs';

const action = (zone, type) => ({
  op: 'copyAttack', origins: [{ side: 'opponent', zone, selector: { kind: 'pokemon', types: [type] } }],
  excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
});

test('copy origin selectors use current types for top in-play Pokémon, but printed types for discarded/evolution cards', async () => {
  const f = await fixture((ds) => {
    ds[0].mechanics.types = ['Darkness']; ds[2].mechanics.types = ['Water'];
    ds[1].mechanics.types = ['Darkness'];
  });
  const ctx = { source: { owner: 0, pokemonId: 'actor' },
    definitions: Object.fromEntries(f.catalog.definitions().map((d) => [d.definitionId, d])),
    effectivePokemon: { p: { types: ['Psychic'] } },
    state: { players: [
      { active: null, bench: [], discard: [] },
      { active: { id: 'p', stack: ['lower', 'top'] }, bench: [], discard: ['discarded'] },
    ], cards: { lower: { definitionId: 'base' }, top: { definitionId: 'evolution' }, discarded: { definitionId: 'other' } } },
  };
  const before = structuredClone(ctx);
  for (const zone of ['field', 'active']) {
    assert.deepEqual(copyCandidates(ctx, action(zone, 'Psychic')), [{ instanceId: 'top', attackId: 'evolution:strike' }]);
    assert.deepEqual(copyCandidates(ctx, action(zone, 'Water')), []);
  }
  assert.deepEqual(copyCandidates(ctx, action('discard', 'Psychic')), []);
  assert.deepEqual(copyCandidates(ctx, action('discard', 'Darkness')), [{ instanceId: 'discarded', attackId: 'other:strike' }]);
  assert.deepEqual(copyCandidates(ctx, action('evolution', 'Psychic')), []);
  assert.deepEqual(copyCandidates(ctx, action('evolution', 'Darkness')), [{ instanceId: 'lower', attackId: 'base:strike' }]);
  const missing = structuredClone(ctx); delete missing.effectivePokemon;
  assert.throws(() => copyCandidates(missing, action('active', 'Psychic')));
  assert.deepEqual(copyCandidates(missing, action('evolution', 'Darkness')), [{ instanceId: 'lower', attackId: 'base:strike' }]);
  assert.deepEqual(ctx, before);
});

test('a real C-18 selection can find a currently Psychic opponent whose immutable face is Darkness, without borrowing its type Ability', async () => {
  const f = await fixture((ds) => {
    ds[0].mechanics.attacks[0].printedDamage = null;
    ds[0].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', action('field', 'Psychic'))];
    ds[1].mechanics.types = ['Darkness'];
    ds[1].mechanics.abilities.push({
      abilityId: 'dual', name: '测试当前超属性', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', scope: 'self', types: ['Psychic'] } })],
    });
    ds[1].mechanics.attacks[0].printedDamage.value = 30;
  });
  let target;
  let g = board(f, (s) => {
    const p = s.players[1], old = p.active, incoming = bench(s, 1, 'other');
    p.bench.splice(p.bench.indexOf(incoming), 1); p.bench.push(old); p.active = incoming; target = incoming.id;
    attached(s, 0, s.players[0].active, 'water');
    // A discarded same-name card is not a Psychic match.
    const id = hand(s, 1, 'other'); p.hand.pop(); p.discard.push(id);
  });
  const before = g.snapshot();
  assert.deepEqual(g.view(0).players[1].active.effective.types, ['Psychic']);
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  assert.equal(g.view(0).pending.attacks.length, 1);
  assert.equal(g.view(0).pending.attacks[0].card.definitionId, 'other');
  g = OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
  answer(g, [g.snapshot().pending.options[0]]); settle(g);
  assert.equal(g.snapshot().players[1].active.id, target);
  assert.equal(g.snapshot().players[1].active.counters, 3);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Water']);
  assert.deepEqual(f.catalog.definition('other').mechanics.types, ['Darkness']);
  assert.deepEqual(g.snapshot().cards, before.cards);
});
