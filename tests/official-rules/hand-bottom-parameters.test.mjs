// Parameter/description contract only: execute() builds an effect program.
// Never run a game, allocate a count-sized array, or actually draw these counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import {
  validateHandBottomDrawParameters, validateDrawParameters, validateEffectProgram,
} from '../../public/rules/schema-validators.js';

const MAX_COUNT = 900719925474099;
const handlers = createCoreHandlers();
const context = (owner, held = false) => ({
  source: { owner },
  state: { players: [{ hand: owner === 0 && held ? ['held-card'] : [] },
    { hand: owner === 1 && held ? ['held-card'] : [] }] },
});

test('handBottomDraw accepts 0/1/effect-count maximum for either field and always emits an exact schema-valid program', () => {
  const h = handlers.get('cn.handBottomDraw@1');
  assert(h);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/handBottomDraw');
  for (const owner of [0, 1]) for (const side of ['own', 'opponent', 'both'])
    for (const ownDraw of [0, 1, MAX_COUNT]) for (const opponentDraw of [0, 1, MAX_COUNT]) {
      const parameters = Object.freeze({ side, ownDraw, opponentDraw });
      assert.equal(validateHandBottomDrawParameters(parameters), true);
      assert.equal(h.validateParameters(parameters), true);
      const program = h.execute(context(owner), parameters);
      assert.deepEqual(program, [{
        op: 'then', first: { op: 'shuffleHandToBottom', side },
        next: { op: 'sequence', steps: [
          { op: 'draw', player: owner, count: ownDraw },
          { op: 'draw', player: 1 - owner, count: opponentDraw },
        ] },
      }], 'Accepted counts must remain exact, not be clamped, defaulted or swapped.');
      assert.equal(validateEffectProgram(program), true, JSON.stringify(validateEffectProgram.errors));
      assert.deepEqual(parameters, { side, ownDraw, opponentDraw });
    }
});

test('handBottomDraw rejects each out-of-range/noninteger field before an invalid draw instruction can be admitted', () => {
  const h = handlers.get('cn.handBottomDraw@1');
  for (const field of ['ownDraw', 'opponentDraw']) for (const value of [
    MAX_COUNT + 1, Number.MAX_SAFE_INTEGER, 0.5, -1,
  ]) {
    const parameters = { side: 'both', ownDraw: 0, opponentDraw: 0, [field]: value };
    const label = `${field}=${value}`;
    assert.equal(validateHandBottomDrawParameters(parameters), false, label);
    assert.equal(h.validateParameters(parameters), false, label);
    assert.equal(validateEffectProgram([{ op: 'draw', player: 0, count: value }]), false, label);
    // Rejected descriptions are not passed to execute()/the game.
  }
});

test('draw and drawUntil share the effect-count maximum while preserving parameter minimum one; computed zero remains a valid draw action', () => {
  assert.equal(validateEffectProgram([{ op: 'draw', count: 0 }]), true);
  for (const handlerId of ['cn.draw@1', 'cn.drawUntil@1']) {
    const h = handlers.get(handlerId);
    assert(h);
    for (const owner of [0, 1]) for (const held of [false, true]) for (const count of [1, MAX_COUNT]) {
      const parameters = Object.freeze({ count });
      assert.equal(validateDrawParameters(parameters), true, `${handlerId}/${count}`);
      assert.equal(h.validateParameters(parameters), true, `${handlerId}/${count}`);
      const program = h.execute(context(owner, held), parameters);
      // drawUntil's hand size is read by the draw itself, whatever the hand when the program is built.
      assert.deepEqual(program, [handlerId === 'cn.drawUntil@1' ? { op: 'draw', untilHand: count } : { op: 'draw', count }]);
      assert.equal(validateEffectProgram(program), true, JSON.stringify(validateEffectProgram.errors));
      assert.deepEqual(parameters, { count });
    }
    for (const count of [0, -1, 0.5, MAX_COUNT + 1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(validateDrawParameters({ count }), false, `${handlerId}/${count}`);
      assert.equal(h.validateParameters({ count }), false, `${handlerId}/${count}`);
    }
  }
});
