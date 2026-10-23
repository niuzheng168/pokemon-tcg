// Synthetic definitions only. 「如果这只宝可梦身上放有「X」的话，则双方场上【火】宝可梦的特性，全部消除」 (the physical Tool card,
// I.B-02) and 「…的特性（除「X」外），全部消除」 (an Ability printed with that name on any card). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSuppressionEffect } from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, bench, hand } from './fixtures.mjs';

const spec = (extra = {}) => ({ op: 'suppression', channel: 'abilities', scope: 'all', ...extra });
const ability = (id, name, effects) => ({ abilityId: id, name, mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const boost = (id, name) => ability(id, name, [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' }, id)]);
const present = (g, owner, i = 0) => (i ? g.view(owner).players[owner].bench[i - 1] : g.view(owner).players[owner].active)
  .effective.abilities.map((a) => a.present);

test('schema: printed Ability names and the source Tool are Ability-channel / Trainer-only', () => {
  assert(validateSuppressionEffect(spec({ exceptAbilityNames: ['暗夜振翼'], sourceTool: { kind: 'trainer', nameKeys: ['capsule'] } })));
  assert(!validateSuppressionEffect(spec({ channel: 'tools', exceptAbilityNames: ['X'] })));
  assert(!validateSuppressionEffect(spec({ exceptAbilityNames: [] })));
  assert(!validateSuppressionEffect(spec({ sourceTool: { kind: 'pokemon' } })));
});

test('「如果这只宝可梦身上放有「测试增伤道具」的话，则双方场上【火】宝可梦的特性，全部消除」', async () => {
  const f = await fixture((defs) => {
    const other = defs.find((d) => d.definitionId === 'other');
    other.mechanics.abilities = [ability('other:awaken', '测试觉醒', [binding('cn.suppression@1',
      { effect: spec({ type: 'Fire', sourceTool: { kind: 'trainer', nameKeys: ['tool'] } }) }, 'awaken')])];
    const base = defs.find((d) => d.definitionId === 'base');
    base.mechanics.types = ['Fire']; base.mechanics.abilities = [boost('base:boost', '测试强化')];
  });
  const run = (tool) => board(f, (s) => {
    const m = bench(s, 0, 'other');
    if (tool) { m.tools.push(hand(s, 0, tool)); s.players[0].hand.pop(); }
  });
  assert.deepEqual([present(run(null), 0), present(run(null), 1)], [[true], [true]], 'No Tool: nothing is removed.');
  assert.deepEqual([present(run('hp-tool'), 0), present(run('hp-tool'), 1)], [[true], [true]], 'Another Tool.');
  const g = run('tool');
  assert.deepEqual([present(g, 0), present(g, 1)], [[false], [false]], 'Both sides\' Fire Pokémon.');
  assert.deepEqual(present(g, 0, 1), [true], 'The holder is a Water Pokémon.');
});

test('「双方场上【基础】宝可梦的特性（除「测试锁」外），全部消除」 spares that name on every card, including other copies', async () => {
  const lock = (id) => ability(id, '测试锁', [binding('cn.suppression@1', { effect: spec({ stage: 'basic', exceptAbilityNames: ['测试锁'] }) }, id)]);
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [lock('other:lock')];
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [lock('base:lock'), boost('base:boost', '测试强化')];
  });
  const g = board(f, (s) => { bench(s, 0, 'other'); });
  assert.deepEqual(present(g, 0), [true, false]);
  assert.deepEqual(present(g, 1), [true, false]);
  assert.deepEqual(present(g, 0, 1), [true]);
});

test('「对手场上的身上放置有伤害指示物的宝可梦（除宝可梦【ex】外）的特性，全部消除」', async () => {
  assert(validateSuppressionEffect(spec({ damaged: true, excludeTags: ['ex'] })));
  assert(!validateSuppressionEffect(spec({ damaged: false })));
  assert(!validateSuppressionEffect(spec({ excludeTags: [] })));
  const make = (tags) => fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [ability('other:lock', '测试锁', [binding('cn.suppression@1',
      { effect: spec({ scope: 'opponent', damaged: true, excludeTags: ['ex'] }) }, 'lock')])];
    const base = defs.find((d) => d.definitionId === 'base');
    base.mechanics.abilities = [boost('base:boost', '测试强化')]; base.mechanics.tags = tags;
  });
  const f = await make([]);
  const run = (fixture, counters) => board(fixture, (s) => { bench(s, 0, 'other'); for (const p of s.players) p.active.counters = counters; });
  assert.deepEqual(present(run(f, 0), 1), [true], 'Undamaged.');
  assert.deepEqual(present(run(f, 2), 1), [false], 'Damaged.');
  assert.deepEqual(present(run(f, 2), 0), [true], 'Only the opponent\'s.');
  assert.deepEqual(present(run(await make(['ex']), 2), 1), [true], 'A Pokémon ex keeps its Ability.');
});
