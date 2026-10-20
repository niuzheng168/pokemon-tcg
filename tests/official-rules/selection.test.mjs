import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionBounds, canSelectCount, SELECTION_RULE_IDS } from '../../public/rules/selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';

const choose = (extra) => selectionBounds({ kind: 'exact', count: 3, available: 5, ...extra });
const cases = [
  ['public exact', {}, [3]],
  ['public exact when insufficient', { available: 2 }, [2]],
  ['public exact when absent', { available: 0 }, [0]],
  ['public up to is not international 0..N', { kind: 'upTo' }, [1, 2, 3]],
  ['public any number', { kind: 'any' }, [0, 1, 2, 3, 4, 5]],
  ['public all', { kind: 'all' }, [5]],
  ['optional exact does not mean arbitrary smaller count', { optional: true }, [0, 3]],
  ['optional all does not mean any number', { kind: 'all', optional: true }, [0, 5]],
  ['filtered deck exact may fail to find', { zone: 'deck' }, [0, 1, 2, 3]],
  ['any card deck exact must select full count', { zone: 'deck', filter: 'anyCard' }, [3]],
  ['any card deck up to needs at least one', { kind: 'upTo', zone: 'deck', filter: 'anyCard' }, [1, 2, 3]],
  ['filtered own hand may select fewer (E-33)', { zone: 'ownHand' }, [0, 1, 2, 3]],
  ['any card own hand exact cannot fail to find', { zone: 'ownHand', filter: 'anyCard' }, [3]],
  ['filtered facedown prizes may select fewer (E-34)', { zone: 'ownFaceDownPrizes' }, [0, 1, 2, 3]],
  ['any card facedown prize exact must select count', { zone: 'ownFaceDownPrizes', filter: 'anyCard' }, [3]],
];
for (const [name, input, expected] of cases) {
  test(`CN selection: ${name}`, () => {
    const bounds = choose(input);
    const actual = Array.from({ length: 7 }, (_, n) => n).filter((n) => canSelectCount(bounds, n));
    assert.deepEqual(actual, expected);
    assert(bounds.trace.length);
    assert(bounds.trace.every((t) => t.rulesetId === 'CN/V20261019' && t.sourceOfTruth.length));
  });
}

test('all selection rules have registered official citations', () => {
  for (const id of SELECTION_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
});

test('invalid choices are not coerced to valid zero choices', () => {
  const bounds = choose({ kind: 'any' });
  for (const n of ['0', null, undefined, NaN, Infinity, -1, 0.5]) assert(!canSelectCount(bounds, n));
  assert.throws(() => choose({ available: -1 }), TypeError);
  assert.throws(() => choose({ kind: 'exact', count: '3' }), TypeError);
  assert.throws(() => choose({ zone: 'opponent-hand-without-reveal' }), TypeError);
  assert.throws(() => choose({ kind: 'some' }), TypeError);
  assert.throws(() => choose({ filter: 'guess' }), TypeError);
  assert.throws(() => choose({ optional: 1 }), TypeError);
  assert.throws(() => selectionBounds({ kind: 'any', available: 3 }, { id: 'US/V20261019' }), RangeError);
});
