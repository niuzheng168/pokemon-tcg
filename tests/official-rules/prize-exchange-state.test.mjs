import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, board, hand, bench, attached, command, answer, settle } from './fixtures.mjs';

const action = { op: 'exchangePrizes', selector: { kind: 'energy', category: 'basic', types: ['Water'] }, revealSelected: false };
const copy = (v) => JSON.parse(JSON.stringify(v));

test('a synthetic before-hand source can exchange itself without its entry finalizer pulling it back out of Prizes', async () => {
  const f = await fixture((ds) => {
    ds.find((d) => d.definitionId === 'potion').mechanics.effects = [{
      ...binding('cn.prizeExchange@1', action),
      trigger: { event: 'beforeHand', origin: 'prizes', turn: 'either', drawReason: 'any', optional: true, afterUse: 'discard' },
    }];
  });
  let source;
  let g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; bench(s, 1, 'other');
    source = hand(s, 0, 'potion'); s.players[0].hand.pop();
    s.players[0].hand.push(s.players[0].prizes[0]); s.players[0].prizes[0] = source;
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']);
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  answer(g, ['perform']); assert.equal(g.snapshot().pending.kind, 'prize-exchange');
  assert.equal(g.snapshot().pending.data.source.origin, 'prizes');
  assert.equal(g.snapshot().pending.data.prizeChoice.completion.kind, 'entry');
  const chosen = g.snapshot().pending.options[0]; assert(chosen);
  // A real non-hand binding cannot bypass the completion guard by dropping its
  // entry context and finalizer together. Its original Prize origin is valid;
  // this is orphaned resolution work, not an impossible field-origin Item.
  const saved = g.snapshot(), orphan = copy(saved);
  orphan.pending.data.entry = null;
  orphan.queue = orphan.queue.filter((task) => task.data.entry?.id !== saved.pending.data.entry.id);
  const untouched = copy(orphan);
  assert.throws(() => OfficialGame.restore(orphan, { catalog: f.catalog }), { code: 'invalid-prize-exchange' });
  assert.deepEqual(orphan, untouched); assert.deepEqual(g.snapshot(), saved);
  g = OfficialGame.restore(copy(g.snapshot()), { catalog: f.catalog });
  answer(g, [chosen]); settle(g);
  assert(g.snapshot().players[0].prizes.includes(source));
  assert(!g.snapshot().players[0].discard.includes(source));
  assert(!g.snapshot().players[0].hand.includes(source));
  assert(g.snapshot().players[0].hand.includes(chosen));
  assert.equal(g.snapshot().players[0].prizes.length, 5, 'Only the actual KO award reduced the count, not the self-exchange.');
  assert.deepEqual(OfficialGame.restore(copy(g.snapshot()), { catalog: f.catalog }).snapshot(), g.snapshot());
});

test('a normal finalizer requires its own current completion token, public declaration and resolution escrow', async () => {
  const f = await fixture((ds) => { ds.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.prizeExchange@1', action)]; });
  let source;
  const g = board(f, (s) => { source = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: source });
  const saved = g.snapshot(), finish = (s) => s.queue.find((t) => t.op === 'finish-trainer');
  const opened = (s) => s.events.find((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open');
  for (const mutate of [
    (s) => { finish(s).data.completionId = 'old-completion'; s.pending.data.prizeChoice.completion.id = 'old-completion'; },
    (s) => { opened(s).visibility = 'private'; },
    (s) => { opened(s).data.turn--; },
    (s) => { opened(s).data.cardId = s.players[0].prizes[0]; },
    (s) => { s.events.push(copy(opened(s))); },
    (s) => {
      // Pretending this resolving Item came from the field cannot bypass the
      // hand-played finalizer guard and obtain a different completion route.
      s.pending.data.source.origin = 'field';
      s.events.find((e) => e.ruleId === 'effects.prize-exchange' && e.data.kind === 'requested').data.source.origin = 'field';
      s.queue = s.queue.filter((t) => t.op !== 'finish-trainer');
    },
    (s) => {
      const p = s.players[0]; p.resolving.splice(p.resolving.indexOf(source), 1); p.hand.push(source);
      s.pending.data.prizeChoice = undefined;
    },
  ]) {
    const bad = copy(saved); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(g.snapshot(), saved);
  }
});

test('self-exchange is not deployable from a Pokémon Ability or a retained Tool even with a self-approved fixture catalog', async () => {
  for (const kind of ['pokemon', 'tool']) {
    const f = await fixture((ds) => {
      if (kind === 'pokemon') ds[0].mechanics.abilities.push({
        abilityId: 'invalid-exchange', name: '测试非法来源', mode: 'activated',
        usage: { period: 'unlimited', scope: 'pokemon', key: 'invalid-exchange', limit: null },
        sourceOfTruth: ds[0].sourceOfTruth, effects: [binding('cn.prizeExchange@1', action)],
      });
      else ds.find((d) => d.definitionId === 'tool').mechanics.effects = [binding('cn.prizeExchange@1', action)];
    });
    assert.throws(() => board(f), { code: 'unsupported-handler' });
  }
});

test('ordinary non-exchange Trainer choices reject duplicated or removed finalizers before accepting a restored snapshot', async () => {
  const f = await fixture();
  let source;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion');
    s.players[0].active.counters = 2; bench(s, 0, 'other').counters = 1;
  });
  command(g, { type: 'playTrainer', cardId: source });
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  const saved = g.snapshot(), finish = (s) => s.queue.find((t) => t.op === 'finish-trainer');
  for (const mutate of [
    (s) => { s.queue.push(copy(finish(s))); },
    (s) => { const duplicate = copy(finish(s)); duplicate.data.completionId += ':duplicate'; s.queue.push(duplicate); },
    (s) => {
      const duplicate = copy(finish(s)); duplicate.data.cardId = s.players[0].prizes[0]; s.queue.push(duplicate);
    },
    (s) => { s.queue = s.queue.filter((t) => t.op !== 'finish-trainer'); },
  ]) {
    const bad = copy(saved); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), { code: 'invalid-trainer-finish' });
    assert.deepEqual(g.snapshot(), saved);
  }
  const restored = OfficialGame.restore(copy(saved), { catalog: f.catalog });
  answer(g, [g.snapshot().players[0].active.id]);
  answer(restored, [restored.snapshot().players[0].active.id]);
  assert.deepEqual(restored.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === source).length, 1);
});

test('a Trainer draw paused in a nested before-hand window retains its outer discard finalizer', async () => {
  const f = await fixture((ds) => {
    ds.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.draw@1', { count: 1 })];
    const incoming = ds.find((d) => d.definitionId === 'poison').mechanics.effects[0];
    incoming.trigger = { event: 'beforeHand', origin: 'draw', turn: 'either', drawReason: 'effect', optional: true, afterUse: 'hand' };
  });
  let source;
  const g = board(f, (s) => {
    source = hand(s, 0, 'research');
    const incoming = hand(s, 0, 'poison');
    s.players[0].hand.splice(s.players[0].hand.indexOf(incoming), 1); s.players[0].deck.push(incoming);
  });
  command(g, { type: 'playTrainer', cardId: source });
  const saved = g.snapshot();
  assert.equal(saved.pending.kind, 'before-hand-optional');
  assert(saved.queue.some((t) => t.op === 'draw-cards' && t.data.completion?.source.instanceId === source));
  const bad = copy(saved); bad.queue = bad.queue.filter((t) => t.op !== 'finish-trainer');
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), { code: 'invalid-trainer-finish' });
  const restored = OfficialGame.restore(copy(saved), { catalog: f.catalog });
  answer(g, ['skip']); answer(restored, ['skip']);
  assert.deepEqual(restored.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[0].discard.filter((id) => id === source).length, 1);
});
