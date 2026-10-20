// Pinned CN E-29 p68–69 is an explicit use permission, not actual execution.
// These synthetic fixtures do not approve real cards or invent overlap rulings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, hand, bench } from './fixtures.mjs';

const e29 = (scope = 'own') => ({
  op: 'protection', useRule: 'CN.E29', channel: 'effects', scope, from: 'all',
  categories: ['trainer'], trainerCategories: ['item', 'supporter'], trainerOrigins: ['hand'],
});
const ordinary = (scope = 'own') => ({
  op: 'protection', useRule: 'ordinary', channel: 'effects', scope, from: 'all', categories: ['trainer'],
});
const counter = (target, id) => binding('cn.counters@1', { side: 'own', target, count: 1 }, id);
const fee = { costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'energy' }, sourceOfTruth: EVIDENCE };
const restore = (g, f) => {
  const before = g.snapshot(), r = OfficialGame.restore(structuredClone(before), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), before); return r;
};
const field = (execute) => ({
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'continuous', operations: ['protection'],
  validateParameters: (p) => Object.keys(p).length === 0, execute,
});
function onlyHand(s, names) {
  const p = s.players[0]; p.deck.push(...p.hand.splice(0));
  return names.map((name) => hand(s, 0, name));
}
const listed = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
const use = (g, id) => command(g, { type: 'playTrainer', cardId: id });
const choose = (g) => {
  while (g.snapshot().pending) {
    const q = g.snapshot().pending; assert.equal(q.kind, 'effect-target'); answer(g, [q.options[0]]);
  }
};

test('an unreviewed ordinary/E29 overlap is unresolved, not silently illegal or allowed; read-only qualification remains atomic', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: ordinary() }, 'ordinary'),
      binding('cn.protection@1', { effect: e29() }, 'E29'));
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [counter('active', 'counter')];
  });
  let sourceId;
  const g = board(f, (s) => { [sourceId] = onlyHand(s, ['potion']); });
  const before = g.snapshot();
  assert.throws(() => listed(g, sourceId), { code: 'unresolved-protection-use-overlap' });
  assert.throws(() => use(g, sourceId), { code: 'unresolved-protection-use-overlap' });
  assert.deepEqual(g.snapshot(), before); restore(g, f);
});

test('an unresolved candidate does not hide another unambiguously usable target, and its actual overlapping shields still prevent placement', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: ordinary('self') }, 'ordinary'),
      binding('cn.protection@1', { effect: e29('self') }, 'E29'));
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [counter('any', 'counter')];
  });
  let sourceId;
  const g = board(f, (s) => { [sourceId] = onlyHand(s, ['potion']); bench(s, 0, 'other'); });
  const before = g.snapshot(); assert.equal(listed(g, sourceId), true); assert.deepEqual(g.snapshot(), before);
  use(g, sourceId); answer(g, [before.players[0].active.id]); choose(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].bench[0].counters, 0);
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === sourceId).length, 1);
  restore(g, f);
});

test('another independent native binding may qualify the body before an unresolved first native leaf is rejected', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: ordinary('self') }, 'ordinary'),
      binding('cn.protection@1', { effect: e29('self') }, 'E29'));
    defs.find((d) => d.definitionId === 'potion').mechanics.effects =
      [counter('active', 'first'), counter('bench', 'second')];
  });
  let sourceId;
  const g = board(f, (s) => { [sourceId] = onlyHand(s, ['potion']); bench(s, 0, 'other'); });
  const before = g.snapshot(); assert.equal(listed(g, sourceId), true); assert.deepEqual(g.snapshot(), before);
  use(g, sourceId); choose(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].bench[0].counters, 1);
  assert.deepEqual(g.snapshot().rng, before.rng); restore(g, f);
});

for (const hasKnownAlternative of [false, true])
  test(`dynamic complete-payment search preserves an unresolved ruling unless another payment is known usable (${hasKnownAlternative})`, async () => {
    const h = field((ctx) => {
      const paidWater = ctx.state.players[ctx.source.owner].discard.some((id) => ctx.state.cards[id].definitionId === 'water');
      return paidWater && hasKnownAlternative ? [e29()] : [ordinary(), e29()];
    });
    const f = await fixture((defs) => {
      defs[0].mechanics.effects.push(binding('fixture:mixed', {}));
      Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics,
        { playCosts: [fee], effects: [counter('active', 'counter')] });
    }, new Map([['fixture:mixed', h]]));
    let sourceId, unresolvedFee, knownFee;
    let g = board(f, (s) => {
      const p = s.players[0]; p.deck.push(...p.discard.splice(0));
      [sourceId, unresolvedFee, knownFee] = onlyHand(s, hasKnownAlternative ? ['potion', 'double', 'water'] : ['potion', 'double']);
    });
    const before = g.snapshot();
    if (!hasKnownAlternative) {
      assert.throws(() => listed(g, sourceId), { code: 'unresolved-protection-use-overlap' });
      assert.deepEqual(g.snapshot(), before); return;
    }
    assert.equal(listed(g, sourceId), true); assert.deepEqual(g.snapshot(), before);
    use(g, sourceId); g = restore(g, f);
    const unpaid = g.snapshot();
    assert.throws(() => answer(g, [paymentOptionId('fee', unresolvedFee)]), { code: 'unresolved-protection-use-overlap' });
    assert.deepEqual(g.snapshot(), unpaid);
    answer(g, [paymentOptionId('fee', knownFee)]); choose(g);
    const after = g.snapshot();
    assert.equal(after.players[0].active.counters, 0, 'E29 permission is not actual counter placement.');
    assert.equal(after.players[0].discard.filter((id) => id === knownFee).length, 1);
    assert(after.players[0].hand.includes(unresolvedFee));
    assert.equal(after.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
    assert.deepEqual(after.rng, before.rng); restore(g, f);
  });

test('a failed post-payment provider is propagated rather than misreported as a false eligibility proof', async () => {
  const sentinel = new Error('post-payment provider failed');
  const h = field((ctx) => {
    if (ctx.state.players[ctx.source.owner].discard.some((id) => ctx.state.cards[id].definitionId === 'water')) throw sentinel;
    return [ordinary()];
  });
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('fixture:failure', {}));
    Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics,
      { playCosts: [fee], effects: [counter('active', 'counter')] });
  }, new Map([['fixture:failure', h]]));
  let sourceId;
  const g = board(f, (s) => {
    s.players[0].deck.push(...s.players[0].discard.splice(0)); [sourceId] = onlyHand(s, ['potion', 'water']);
  });
  const before = g.snapshot();
  assert.throws(() => listed(g, sourceId), (error) => error === sentinel);
  assert.deepEqual(g.snapshot(), before);
});

test('native and custom field-card self protection is explicitly unsupported, not silently treated as a Pokemon self shield', async () => {
  for (const custom of [false, true]) {
    const h = field(() => [e29('self')]);
    const f = await fixture((defs) => {
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [custom ?
        binding('fixture:stadium-self', {}) : binding('cn.protection@1', { effect: e29('self') })];
    }, custom ? new Map([['fixture:stadium-self', h]]) : new Map());
    assert.throws(() => board(f, (s) => {
      const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
    }), { code: 'unsupported-protection-subject' });
  }
});

test('a Stadium may still be the SOURCE of a continuous E29 Pokemon shield without pretending the Stadium is its own Pokemon subject', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects =
      [binding('cn.protection@1', { effect: e29('own') })];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [counter('active', 'counter')];
  });
  let sourceId;
  const g = board(f, (s) => {
    [sourceId] = onlyHand(s, ['potion']);
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
  });
  const before = g.snapshot(); assert.equal(listed(g, sourceId), true); assert.deepEqual(g.snapshot(), before);
  use(g, sourceId); choose(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().stadium, before.stadium); restore(g, f);
});
