// Synthetic definitions only. 「身上放有这张卡牌的「银伴战兽GX」，会变为【超】宝可梦」 and 「只要这只宝可梦身上放有「驱劲能量 未来」，这只宝可梦的属性
// 变为【斗】和【钢】2种」 (pokemon.types): the type layer reads printed card identities and physical attached cards only. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertPokemonTypesEffect } from '../../public/rules/pokemon-types.js';
import { fixture, binding, board, hand, bench } from './fixtures.mjs';

const def = (defs, id) => defs.find((d) => d.definitionId === id);
const types = (effect) => binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', scope: 'self', ...effect } }, `types-${Object.keys(effect).join('-')}`);
const attach = (s, owner, m, id, zone) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m[zone].push(card); return card; };

test('a printed card filter and an attached Energy card', async () => {
  const valid = (effect) => createCoreHandlers().get('cn.pokemonTypes@1').validateParameters({ effect: { op: 'pokemonTypes', types: ['Psychic'], scope: 'self', ...effect } });
  assert(valid({ targetCard: { kind: 'pokemon', nameKeys: ['other'] } }));
  assert(valid({ sourceEnergy: { kind: 'energy', nameKeys: ['double'] } }));
  assert(!valid({ targetCard: { kind: 'pokemon', types: ['Water'] } }), 'Not a current type.');
  assert(!valid({ sourceEnergy: { kind: 'trainer' } }));
  assert.throws(() => assertPokemonTypesEffect({ op: 'pokemonTypes', types: ['Psychic'], scope: 'self', targetCard: { kind: 'pokemon', types: ['Water'] } }));
  assert.throws(() => assertPokemonTypesEffect({ op: 'pokemonTypes', types: ['Psychic'], scope: 'self', sourceEnergy: { kind: 'pokemon' } }));
  assert.doesNotThrow(() => assertPokemonTypesEffect({ op: 'pokemonTypes', types: ['Psychic'], scope: 'self', sourceEnergy: { kind: 'energy' } }));
  const f = await fixture((defs) => {
    def(defs, 'tool').mechanics.effects = [types({ types: ['Psychic'], targetCard: { kind: 'pokemon', nameKeys: ['other'] } })];
    def(defs, 'base').mechanics.effects.push(types({ types: ['Fighting', 'Metal'], sourceEnergy: { kind: 'energy', nameKeys: ['double'] } }));
  });
  let held, plain;
  const g = board(f, (s) => {
    held = bench(s, 0, 'other'); attach(s, 0, held, 'tool', 'tools');
    plain = bench(s, 0, 'other');
    attach(s, 1, s.players[1].active, 'double', 'energy');
  });
  const v = g.view(0), mon = (owner, id) => [v.players[owner].active, ...v.players[owner].bench].find((m) => m.id === id);
  assert.deepEqual(mon(0, held.id).effective.types, ['Psychic']);
  assert.deepEqual(mon(0, plain.id).effective.types, ['Water']);
  assert.deepEqual(v.players[1].active.effective.types, ['Fighting', 'Metal']);
  assert.deepEqual(v.players[0].active.effective.types, ['Water'], 'No such Energy attached.');
  const k = board(f, (s) => { attach(s, 0, s.players[0].active, 'tool', 'tools'); });
  assert.deepEqual(k.view(0).players[0].active.effective.types, ['Water'], 'The Tool on another kind of Pokémon.');
});
