import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, binding, EVIDENCE, board, attached, command } from './fixtures.mjs';

const roll = { key: 'declared', spec: { kind: 'fixed', count: 1 } };
const packet = (rolls) => ({ op: 'damage', side: 'opponent', target: 'active', amount: 10,
  selection: { kind: 'all' }, options: {}, rolls });
const handler = (extra = {}) => ({
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'damage', operations: ['damage'],
  validateParameters: (p) => Object.keys(p).length === 0, execute: () => [packet([roll])], ...extra,
});
const make = (h) => fixture((ds) => {
  ds[0].mechanics.attacks[0].specialRule = 'GX';
  ds[0].mechanics.attacks[0].effects = [binding('fixture:guarded-coins', {})];
}, new Map([['fixture:guarded-coins', h]]));

test('unversioned/mismatched coin capabilities cannot be installed as ignored attack metadata', async () => {
  for (const extra of [
    { damageRolls: () => [] },
    { damageRolls: () => [], damageRollVersion: '1' },
    { capabilities: ['damage-rolls'], damageRollVersion: '1' },
    { capabilities: ['damage-rolls'], damageRollVersion: '2', damageRolls: () => [] },
    { capabilities: ['damage-rolls'], damageRollVersion: '1', damageRolls: () => [], timing: 'resolve' },
  ]) {
    const f = await make(handler(extra));
    assert.throws(() => board(f), { code: 'unsupported-handler' });
  }
});

test('a damage action without a declared coin capability cannot silently discard its roll instruction', async () => {
  const f = await make(handler()), g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  const before = g.snapshot();
  assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike' }), { code: 'invalid-damage-coins' });
  assert.deepEqual(g.snapshot(), before, 'No partial primary damage, RNG or GX use may be committed.');
});

test('version-one callbacks cannot replace the reviewed parameter plans or return malformed descriptions', async () => {
  for (const damageRolls of [() => [roll], () => [{ key: 'bad', spec: { kind: 'invalid' } }], () => null]) {
    const f = await make(handler({ damageRollVersion: '1', capabilities: ['damage-rolls'], damageRolls }));
    const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water')), before = g.snapshot();
    assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike' }), { code: 'invalid-damage-coins' });
    assert.deepEqual(g.snapshot(), before);
  }
});
