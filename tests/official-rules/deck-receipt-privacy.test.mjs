import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, fixtureClock,
} from './fixtures.mjs';

// Real OfficialGame privacy regression for the stage17 full-deck receipt leak.
// All card data is synthetic. This file does not approve any actual printing.
const clone = (value) => JSON.parse(JSON.stringify(value));
const requested = (event) => event.ruleId === 'effects.search' && event.data.kind === 'requested';
const receipts = (snapshot) => snapshot.events.filter(requested);
const inspection = () => ({
  op: 'inspectDeck', lookTop: 2, selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 1 }, revealSelected: false,
  remainder: { mode: 'shuffleToBottom' },
});
const attachment = () => ({
  op: 'attachDeckEnergy', lookTop: 2,
  selector: { kind: 'energy', category: 'basic', types: ['Water'] },
  quantity: { kind: 'exact', count: 2 },
  recipient: { position: 'active', selector: { kind: 'pokemon' } },
  distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: false,
});
function use(game) {
  const s = game.snapshot(), actor = s.current;
  return command(game, { type: 'useAbility', pokemonId: s.players[actor].active.id, abilityId: 'privacy:deck' });
}

// Check exact strings, including object keys, rather than substring matching:
// p0c1 must not be mistaken for a leak merely because p0c10 is legitimately seen.
function strings(value, result = new Set()) {
  if (typeof value === 'string') result.add(value);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      result.add(key); strings(child, result);
    }
  }
  return result;
}
function assertPrivateProjection(view, originalDeck, uninspected, hostReceipt) {
  assert(!view.events.some(requested), 'Host requested receipts never enter player history.');
  for (const key of ['rng', 'queue', 'cards', 'deckChoice'])
    assert(!Object.hasOwn(view, key), `Player projection must not include host ${key}.`);
  assert(!Object.hasOwn(view.pending ?? {}, 'deckChoice'));
  const visible = strings(view);
  for (const id of uninspected) assert(!visible.has(id), `An uninspected physical card ID leaked: ${id}`);
  assert(!visible.has(JSON.stringify(originalDeck)), 'No encoded full-deck ordering may be returned.');
  assert(!JSON.stringify(view).includes(JSON.stringify(hostReceipt)), 'No full host receipt may be nested in a projection.');
}

async function scenario(operation = 'inspectDeck', actor = 0) {
  const action = operation === 'inspectDeck' ? inspection() : attachment();
  const handlerId = operation === 'inspectDeck' ? 'cn.inspectDeck@1' : 'cn.attachDeckEnergy@1';
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities.push({
      abilityId: 'privacy:deck', name: '测试牌库回执隐私', mode: 'activated',
      usage: { period: 'unlimited', scope: 'pokemon', key: 'privacy:deck', limit: null },
      effects: [binding(handlerId, action)], sourceOfTruth: EVIDENCE,
    });
  });
  const game = board(f, (s) => {
    if (actor === 1) fixtureClock(s, [0, 1, 0, 1]);
    // Isolate this operation from any legitimate prior mulligan revelations.
    // This synthetic board has no outstanding receipts or historical KO events.
    s.events = [];
    const p = s.players[actor];
    // Preparation may have taken different mulligan compensation as shared
    // fixtures evolve. Construct this regression's exact 46-card deck rather
    // than depend on how many cards happened to remain after that preparation.
    for (const zone of ['hand', 'discard', 'lost']) {
      while (p.deck.length < 46 && p[zone].length) p.deck.push(p[zone].pop());
    }
    assert(p.deck.length >= 46, 'The synthetic board must have enough non-field, non-Prize cards.');
    p.hand.push(...p.deck.splice(0, p.deck.length - 46));
    // Both operations have the same known two-card window and 44 genuinely
    // uninspected cards. Reorder existing physical cards, never create new IDs.
    const window = p.deck.filter((id) => s.cards[id].definitionId === 'water').slice(0, 2);
    assert.equal(window.length, 2);
    p.deck = p.deck.filter((id) => !window.includes(id)).concat([...window].reverse());
  });
  const original = game.snapshot(), originalDeck = [...original.players[actor].deck];
  const window = originalDeck.slice(-2).reverse(), uninspected = originalDeck.slice(0, -2);
  assert.equal(originalDeck.length, 46);
  assert.equal(uninspected.length, 44);
  for (const viewer of [0, 1]) {
    const before = strings(game.view(viewer));
    assert(uninspected.every((id) => !before.has(id)), 'Fixture cannot start with prior knowledge of hidden IDs.');
  }
  use(game);
  const stages = [{ name: 'selection', snapshot: game.snapshot() }];
  if (operation === 'inspectDeck') answer(game, [window[0]]);
  else {
    answer(game, window);
    stages.push({ name: 'allocation:0', snapshot: game.snapshot() });
    answer(game, [game.snapshot().players[actor].active.id]);
    stages.push({ name: 'allocation:1', snapshot: game.snapshot() });
    answer(game, [game.snapshot().players[actor].active.id]);
  }
  assert.equal(game.snapshot().pending, null);
  stages.push({ name: 'completed', snapshot: game.snapshot() });
  return { f, game, actor, originalDeck, window, uninspected, stages };
}

function restoredViews(context, snapshot) {
  const restored = OfficialGame.restore(clone(snapshot), { catalog: context.f.catalog });
  assert.deepEqual(restored.snapshot(), snapshot, 'A valid private receipt remains portable host state.');
  return [restored.view(0), restored.view(1)];
}

test('P1 regression: looking at the top two reveals none of the other 44 IDs/order to either actor, including actor one', async () => {
  for (const actor of [0, 1]) {
    const c = await scenario('inspectDeck', actor), pending = c.stages[0].snapshot;
    const host = receipts(pending);
    assert.equal(host.length, 1);
    assert.equal(host[0].visibility, 'private', 'Owner-only is not private enough for a complete deck-order receipt.');
    assert.deepEqual(host[0].data.deck, c.originalDeck, 'Host retains the complete original order for restore checks.');
    assert.deepEqual(host[0].data.window, c.window);
    assert.equal(pending.pending.player, actor);
    const views = restoredViews(c, pending);
    assert.deepEqual(views[actor].pending.lookedAt.map((card) => card.instanceId), c.window);
    assert.equal(views[1 - actor].pending, null);
    for (const view of views) assertPrivateProjection(view, c.originalDeck, c.uninspected, host[0]);
    const opponentStrings = strings(views[1 - actor]);
    assert(c.window.every((id) => !opponentStrings.has(id)), 'The opponent must not receive even the two-card private window.');
  }
});

test('completed inspection history keeps its full receipt host-only without hiding legitimate public summaries or the selected own hand card', async () => {
  for (const actor of [0, 1]) {
    const c = await scenario('inspectDeck', actor), complete = c.stages.at(-1).snapshot;
    const host = receipts(complete);
    assert.equal(host.length, 1);
    assert.equal(host[0].visibility, 'private');
    assert.deepEqual(host[0].data.deck, c.originalDeck);
    const views = restoredViews(c, complete);
    assert(views[actor].players[actor].hand.some((card) => card.instanceId === c.window[0]));
    assert(views[actor].events.some((e) => e.ruleId === 'effects.search' && e.data.kind === 'resolved'));
    assert(views[1 - actor].events.some((e) => e.ruleId === 'effects.search' && e.data.kind === 'resolved'));
    for (const view of views) {
      assert.equal(view.pending, null);
      assertPrivateProjection(view, c.originalDeck, c.uninspected, host[0]);
    }
    const opponentStrings = strings(views[1 - actor]);
    assert(c.window.every((id) => !opponentStrings.has(id)), 'Unrevealed hand selection must stay private after completion.');
  }
});

test('direct Energy attachment hides the host receipt throughout selection, each allocation prompt, and completed history', async () => {
  for (const actor of [0, 1]) {
    const c = await scenario('attachDeckEnergy', actor);
    assert.deepEqual(c.stages.map((s) => s.name), ['selection', 'allocation:0', 'allocation:1', 'completed']);
    for (const stage of c.stages) {
      const host = receipts(stage.snapshot);
      assert.equal(host.length, 1);
      assert.equal(host[0].visibility, 'private');
      assert.deepEqual(host[0].data.deck, c.originalDeck);
      const views = restoredViews(c, stage.snapshot);
      for (const view of views) assertPrivateProjection(view, c.originalDeck, c.uninspected, host[0]);
      assert.equal(views[1 - actor].pending, null);
      if (stage.name !== 'completed') {
        assert.deepEqual(views[actor].pending.lookedAt.map((card) => card.instanceId), c.window);
        assert.deepEqual(stage.snapshot.players[actor].deck, c.originalDeck, 'Allocation alone must not move the deck.');
      }
    }
    const complete = c.stages.at(-1).snapshot;
    const views = restoredViews(c, complete);
    for (const view of views) assert.deepEqual(
      view.players[actor].active.energy.map((card) => card.instanceId), c.window,
      'Actually attached cards are public; hiding the receipt must not hide the public attachment.');
  }
});

test('raw playerView defense excludes every deck receipt even when unvalidated pending/completed input labels it public or either owner', async () => {
  for (const operation of ['inspectDeck', 'attachDeckEnergy']) for (const actor of [0, 1]) {
    const c = await scenario(operation, actor);
    for (const stage of c.stages) for (const visibility of ['public', actor, 1 - actor]) {
      const raw = clone(stage.snapshot);
      receipts(raw).forEach((e) => { e.visibility = visibility; });
      const before = clone(raw);
      for (const viewer of [0, 1]) {
        // Deliberately bypass OfficialGame.restore/assertGameState to exercise
        // projection defense-in-depth, not just rejection by the state gate.
        const view = playerView(raw, c.f.catalog, viewer);
        assertPrivateProjection(view, c.originalDeck, c.uninspected, receipts(raw)[0]);
      }
      assert.deepEqual(raw, before, 'Projection neither trusts nor mutates the malformed visibility claim.');
    }
  }
});

test('restore rejects relabelled original-deck receipts in both outstanding work and completed history, without changing the caller snapshot', async () => {
  for (const operation of ['inspectDeck', 'attachDeckEnergy']) for (const actor of [0, 1]) {
    const c = await scenario(operation, actor);
    for (const stage of c.stages) for (const visibility of [actor, 1 - actor, 'public']) {
      const bad = clone(stage.snapshot);
      receipts(bad)[0].visibility = visibility;
      const before = clone(bad);
      assert.throws(() => OfficialGame.restore(bad, { catalog: c.f.catalog }),
        (error) => error.code === 'invalid-deck-choice',
        `${operation}/${stage.name}: a historical host receipt cannot be relabelled ${visibility}`);
      assert.deepEqual(bad, before);
    }
    assert.deepEqual(OfficialGame.restore(clone(c.game.snapshot()), { catalog: c.f.catalog }).snapshot(), c.game.snapshot());
  }
});

test('global history guard rejects an older receipt even when the current operation receipt remains correctly private', async () => {
  for (const actor of [0, 1]) {
    const c = await scenario('inspectDeck', actor);
    use(c.game);
    const pending = c.game.snapshot();
    assert.equal(receipts(pending).length, 2);
    assert.notEqual(receipts(pending)[0].data.id, pending.pending.data.deckChoice.id);
    assert.equal(receipts(pending)[1].data.id, pending.pending.data.deckChoice.id);
    answer(c.game, [pending.pending.options[0]]);
    const completed = c.game.snapshot();
    assert.equal(completed.pending, null);
    for (const snapshot of [pending, completed]) {
      assert(receipts(snapshot).every((e) => e.visibility === 'private'));
      for (const visibility of [actor, 'public']) {
        const bad = clone(snapshot);
        receipts(bad)[0].visibility = visibility;
        assert.equal(receipts(bad)[1].visibility, 'private');
        assert.throws(() => OfficialGame.restore(bad, { catalog: c.f.catalog }),
          (error) => error.code === 'invalid-deck-choice');
        for (const viewer of [0, 1])
          assert(!playerView(bad, c.f.catalog, viewer).events.some(requested),
            'Even an older mislabelled receipt must be removed by raw projection.');
      }
      const views = restoredViews(c, snapshot);
      assert(views.every((view) => !view.events.some(requested)));
    }
  }
});
