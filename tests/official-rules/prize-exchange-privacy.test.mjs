// Real OfficialGame privacy regressions; all card definitions are synthetic.
// No new physical IDs, approvals, shared schemas, generators or host edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import { fixture, binding, board, hand, fixtureClock, command, answer } from './fixtures.mjs';

const RULE = 'effects.prize-exchange';
const clone = (value) => JSON.parse(JSON.stringify(value));
const names = ['other', 'evolution', 'water', 'water', 'double', 'tool'];
const action = (revealSelected) => ({
  op: 'exchangePrizes', selector: { kind: 'pokemon', stages: ['basic'] }, revealSelected,
});
const prizeEvent = (event) => event.ruleId === RULE;
const eventsOf = (snapshot, kind) => snapshot.events.filter((event) => prizeEvent(event) && event.data.kind === kind);
const publicFields = ['kind', 'id', 'player', 'sourceId', 'count', 'revealed'];
const ref = (s, id) => clone(s.cards[id]);

// Exact strings INCLUDING keys: p0c1 must not be confused with visible p0c10.
function strings(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key); strings(child, out);
    }
  }
  return out;
}
function ownJSON(record, key, value) {
  // "__proto__" is an ordinary own JSON field here, never a prototype edit.
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

const catalogs = new Map(), scenes = new Map();
async function scenario(owner = 0, reveal = false, selectedCount = 1, trainer = 'potion') {
  const key = `${owner}/${reveal}/${selectedCount}/${trainer}`;
  if (scenes.has(key)) return scenes.get(key);
  const catalogKey = `${reveal}/${trainer}`;
  if (!catalogs.has(catalogKey)) catalogs.set(catalogKey, fixture((defs) => {
    defs.find((definition) => definition.definitionId === trainer).mechanics.effects = [
      binding('cn.prizeExchange@1', action(reveal), 'privacy:prize-exchange'),
    ];
  }));
  const f = await catalogs.get(catalogKey);
  let sourceId, originalPrizes;
  const game = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    sourceId = hand(s, owner, trainer);
    const p = s.players[owner];
    p.deck.push(...p.prizes.splice(0));
    for (const definition of names) {
      const id = hand(s, owner, definition);
      p.hand.pop(); p.prizes.push(id);
    }
    originalPrizes = [...p.prizes];
    // Exclude legitimate prior setup/mulligan revelations from this oracle.
    s.events = [];
  });
  for (const viewer of [0, 1]) {
    const visible = strings(game.view(viewer));
    for (const id of originalPrizes) assert(!visible.has(id), `Fixture already exposes Prize ${id}`);
  }
  command(game, { type: 'playTrainer', cardId: sourceId });
  const pending = game.snapshot();
  assert.equal(pending.pending.kind, 'prize-exchange');
  assert.deepEqual(pending.pending.options, [originalPrizes[0]]);
  assert.equal(pending.pending.minimum, 0);
  const selected = selectedCount ? [originalPrizes[0]] : [];
  answer(game, selected);
  const after = game.snapshot();
  assert.equal(after.pending, null);
  assert.equal(after.phase, 'main');
  assert.equal(after.queue.length, 0, 'Every attack targets historical, fully completed records.');
  assert.equal(after.players[owner].prizes.length, originalPrizes.length);
  assert.deepEqual(after.cards, pending.cards, 'The fixture never rewrites a physical card.');
  for (const kind of ['requested', 'resolved', 'finished']) assert.equal(eventsOf(after, kind).length, 1);
  const finished = clone(eventsOf(after, 'finished')[0]);
  const result = { f, game, owner, reveal, selected, sourceId, originalPrizes, after, finished };
  scenes.set(key, result);
  return result;
}

function assertProjection(view, c, viewer, label, extraSecrets = []) {
  assert.equal(view.pending, null, label);
  for (const key of ['cards', 'rng', 'queue', 'prizeChoice'])
    assert(!Object.hasOwn(view, key), `${label}: host ${key} escaped`);
  for (const p of view.players) assert.deepEqual(Object.keys(p.prizes), ['count'], label);
  const visible = strings(view);
  for (const id of c.originalPrizes.filter((id) => !c.selected.includes(id)))
    assert(!visible.has(id), `${label}: unselected Prize ID leaked to viewer ${viewer}: ${id}`);
  if (!c.reveal && viewer !== c.owner) for (const id of c.selected)
    assert(!visible.has(id), `${label}: unrevealed selected card leaked to opponent ${viewer}: ${id}`);
  for (const secret of [...extraSecrets, JSON.stringify(c.originalPrizes)])
    assert(!visible.has(secret), `${label}: encoded/nested private content escaped: ${secret}`);

  const shown = view.events.filter(prizeEvent);
  for (const event of shown) {
    assert.equal(event.visibility, 'public', `${label}: no owner-only or private Prize receipts`);
    assert.equal(event.data.kind, 'finished', `${label}: a host record was relabeled into public history`);
    assert.deepEqual(Object.keys(event).sort(), ['data', 'ruleId', 'visibility'], label);
    assert(Object.keys(event.data).every((key) => publicFields.includes(key)),
      `${label}: finished includes private/unknown fields`);
    // An invalid raw record may be omitted; it may never replace the legitimate
    // summary with forged card refs, identities, fields or disclosure policy.
    assert.deepEqual(event, c.finished, `${label}: unverified finished payload was projected`);
  }
  const history = strings(view.events);
  if (!c.reveal) for (const id of c.selected)
    assert(!history.has(id), `${label}: own-hand knowledge does not permit a hidden selection in history`);
  for (const key of ['choice', 'selected', 'prizes', 'lookedAt', '_private', '_hostReceipt']) {
    for (const event of shown) assert(!Object.hasOwn(event.data, key), `${label}: host field ${key} escaped`);
  }
}

function assertHistoricalForgery(c, mutate, label, extraSecrets = []) {
  const bad = clone(c.after);
  mutate(bad);
  const before = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: c.f.catalog }), undefined,
    `${label}: completed history must not authenticate a forged Prize event`);
  assert.deepEqual(bad, before, `${label}: restore must not repair/mutate the supplied snapshot`);
  for (const viewer of [0, 1]) {
    let view;
    assert.doesNotThrow(() => { view = playerView(bad, c.f.catalog, viewer); },
      `${label}: raw projection must safely filter the bad history`);
    assertProjection(view, c, viewer, label, extraSecrets);
  }
  assert.deepEqual(bad, before, `${label}: raw projection cannot rewrite history`);
  assert.deepEqual(c.game.snapshot(), c.after, `${label}: the legitimate game must be unchanged`);
}

test('valid zero/one exchanges preserve the exact public finished record for both actors, source categories and reveal policies', async () => {
  let checked = 0;
  for (const owner of [0, 1]) for (const reveal of [false, true]) for (const selectedCount of [0, 1])
    for (const trainer of ['potion', 'research']) {
      const c = await scenario(owner, reveal, selectedCount, trainer), s = c.after;
      const requested = eventsOf(s, 'requested')[0], resolved = eventsOf(s, 'resolved')[0], finished = c.finished;
      assert.equal(requested.visibility, 'private'); assert.equal(resolved.visibility, 'private');
      assert.equal(finished.visibility, 'public');
      assert.equal(finished.data.id, requested.data.id, 'Public summary is bound to its exact inspection.');
      assert.equal(finished.data.id, resolved.data.id);
      assert.equal(finished.data.player, owner); assert.equal(finished.data.sourceId, c.sourceId);
      assert.equal(finished.data.count, selectedCount);
      assert.deepEqual(requested.data.choice.prizes, c.originalPrizes);
      assert.deepEqual(resolved.data.selected, c.selected);
      assert.equal(Object.hasOwn(finished.data, 'revealed'), reveal);
      if (reveal) assert.deepEqual(finished.data.revealed, c.selected.map((id) => ref(s, id)));
      const restored = OfficialGame.restore(clone(s), { catalog: c.f.catalog });
      assert.deepEqual(restored.snapshot(), s);
      for (const viewer of [0, 1]) {
        assertProjection(restored.view(viewer), c, viewer, 'valid record');
        assert.deepEqual(restored.view(viewer).events.filter(prizeEvent), [finished],
          'Privacy defense must not hide a legitimate count, source or approved reveal.');
        assert.deepEqual(playerView(clone(s), c.f.catalog, viewer), restored.view(viewer));
      }
      checked++;
    }
  assert.equal(checked, 16);
});

test('P1 regression: historical requested/resolved renamed to finished or another kind cannot become public or owner-visible receipts', async () => {
  let checked = 0;
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const c = await scenario(owner, reveal);
    for (const originalKind of ['requested', 'resolved']) for (const forgedKind of ['finished', 'otherkind'])
      for (const visibility of ['public', 0, 1]) {
        const label = `${owner}/${reveal}/${originalKind}->${forgedKind}/${visibility}`;
        assertHistoricalForgery(c, (s) => {
          const event = eventsOf(s, originalKind)[0];
          event.data.kind = forgedKind; event.visibility = visibility;
        }, label);
        checked++;
      }
  }
  assert.equal(checked, 48);
});

test('original host kinds remain host-only in completed history, even when relabeled public, actor-only or opponent-only', async () => {
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const c = await scenario(owner, reveal);
    for (const kind of ['requested', 'resolved']) for (const visibility of ['public', 0, 1])
      assertHistoricalForgery(c, (s) => { eventsOf(s, kind)[0].visibility = visibility; },
        `host visibility ${owner}/${reveal}/${kind}/${visibility}`);
  }
});

test('extra and private-looking JSON payload fields cannot tunnel Prize IDs through any historical Prize event kind', async () => {
  let checked = 0;
  for (const owner of [0, 1]) {
    const c = await scenario(owner, false);
    const payloads = [
      ['choice', { prizes: c.originalPrizes }],
      ['selected', c.selected],
      ['prizes', c.originalPrizes],
      ['lookedAt', c.originalPrizes],
      ['_private', { snapshot: { prizes: c.originalPrizes, selected: c.selected } }],
      ['_hostReceipt', eventsOf(c.after, 'requested')[0]],
      ['encoded', JSON.stringify(c.originalPrizes)],
      ['__proto__', { prizes: c.originalPrizes }],
      ['constructor', { selected: c.selected }],
    ];
    for (const kind of ['requested', 'resolved', 'finished']) for (const [key, value] of payloads)
      for (const visibility of ['private', 'public', 0, 1]) {
        // requested.choice and resolved.selected already exist: test unknown
        // nesting instead of replacing an allowed original field in this group.
        const field = Object.hasOwn(eventsOf(c.after, kind)[0].data, key) ? `_extra_${key}` : key;
        assertHistoricalForgery(c, (s) => {
          const event = eventsOf(s, kind)[0];
          ownJSON(event.data, field, clone(value)); event.visibility = visibility;
        }, `extra payload ${owner}/${kind}/${field}/${visibility}`);
        checked++;
      }
  }
  assert.equal(checked, 216);
});

test('unknown JSON envelope fields on an otherwise valid public finished record are rejected and never cloned into raw views', async () => {
  for (const owner of [0, 1]) {
    const c = await scenario(owner, false);
    for (const key of ['choice', 'selected', '_private', '_hostReceipt', '__proto__']) {
      assertHistoricalForgery(c, (s) => {
        ownJSON(eventsOf(s, 'finished')[0], key, {
          prizes: c.originalPrizes, selected: c.selected, encoded: JSON.stringify(c.originalPrizes),
        });
      }, `extra envelope ${owner}/${key}`);
    }
  }
});

test('revealSelected false cannot be upgraded by injecting selected or unselected card refs into finished.revealed', async () => {
  for (const owner of [0, 1]) for (const selectedCount of [0, 1]) {
    const c = await scenario(owner, false, selectedCount);
    for (const visibility of ['public', 0, 1]) for (const revealed of [
      [], c.selected.map((id) => ref(c.after, id)), [ref(c.after, c.originalPrizes.at(-1))],
    ]) {
      assertHistoricalForgery(c, (s) => {
        const event = eventsOf(s, 'finished')[0];
        event.data.revealed = clone(revealed); event.visibility = visibility;
      }, `unauthorized reveal ${owner}/${selectedCount}/${visibility}`);
    }
  }
});

test('approved reveals must retain exact selected physical identity and printing/definition/owner, not forged public card refs', async () => {
  for (const owner of [0, 1]) {
    const c = await scenario(owner, true), hiddenId = c.originalPrizes.at(-1);
    const changes = [
      ['other Prize', (e) => { e.data.revealed = [ref(c.after, hiddenId)]; }],
      ['foreign Prize', (e) => { e.data.revealed = [ref(c.after, c.after.players[1 - owner].prizes[0])]; }],
      ['source card', (e) => { e.data.revealed = [ref(c.after, c.sourceId)]; }],
      ['missing reveal', (e) => { delete e.data.revealed; }],
      ['empty reveal', (e) => { e.data.revealed = []; }],
      ['duplicate reveal', (e) => { e.data.revealed.push(clone(e.data.revealed[0])); }],
      ['wrong owner', (e) => { e.data.revealed[0].owner = 1 - owner; }],
      ['wrong definition', (e) => { e.data.revealed[0].definitionId = 'PRIVATE:forged-definition'; }],
      ['wrong printing', (e) => { e.data.revealed[0].printingId = 'PRIVATE:forged-printing'; }],
      ['unknown nested field', (e) => { e.data.revealed[0]._private = { prizes: c.originalPrizes }; }],
      ['wrong count', (e) => { e.data.count = 0; }],
    ];
    for (const [name, change] of changes) {
      assertHistoricalForgery(c, (s) => { change(eventsOf(s, 'finished')[0]); },
        `forged approved reveal ${owner}/${name}`, ['PRIVATE:forged-definition', 'PRIVATE:forged-printing']);
    }
  }
});

test('public summaries require the exact original request/resolved pair, identity, owner, source and selected count after completion', async () => {
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const c = await scenario(owner, reveal);
    const mutations = [
      ['missing request', (s) => { s.events = s.events.filter((e) => !(prizeEvent(e) && e.data.kind === 'requested')); }],
      ['missing resolved', (s) => { s.events = s.events.filter((e) => !(prizeEvent(e) && e.data.kind === 'resolved')); }],
      ['duplicate request', (s) => { s.events.push(clone(eventsOf(s, 'requested')[0])); }],
      ['duplicate resolved', (s) => { s.events.push(clone(eventsOf(s, 'resolved')[0])); }],
      ['duplicate finished', (s) => { s.events.push(clone(eventsOf(s, 'finished')[0])); }],
      ['malformed private request', (s) => { eventsOf(s, 'requested')[0].data.choice.prizes = null; }],
      ['malformed private resolved', (s) => { eventsOf(s, 'resolved')[0].data.selected = null; }],
      ['request choice id', (s) => { eventsOf(s, 'requested')[0].data.choice.id = 'other-inspection'; }],
      ['request choice source', (s) => { eventsOf(s, 'requested')[0].data.choice.sourceId = c.originalPrizes.at(-1); }],
      ['finished id', (s) => { eventsOf(s, 'finished')[0].data.id = 'unrelated-inspection'; }],
      ['finished source', (s) => { eventsOf(s, 'finished')[0].data.sourceId = c.originalPrizes.at(-1); }],
      ['finished owner', (s) => { eventsOf(s, 'finished')[0].data.player = 1 - owner; }],
      ['finished count', (s) => { eventsOf(s, 'finished')[0].data.count = 0; }],
      ['resolved selection outside original window', (s) => { eventsOf(s, 'resolved')[0].data.selected = [c.sourceId]; }],
      ['resolved identity', (s) => { eventsOf(s, 'resolved')[0].data.id = 'unrelated-inspection'; }],
      ['resolved source', (s) => { eventsOf(s, 'resolved')[0].data.sourceId = c.originalPrizes.at(-1); }],
      ['resolved player', (s) => { eventsOf(s, 'resolved')[0].data.player = 1 - owner; }],
      ['resolved completion id', (s) => { eventsOf(s, 'resolved')[0].data.completion.id = 'other-completion'; }],
      ['resolved completion kind', (s) => { eventsOf(s, 'resolved')[0].data.completion.kind = 'entry'; }],
    ];
    for (const [name, mutate] of mutations)
      assertHistoricalForgery(c, mutate, `triple binding ${owner}/${reveal}/${name}`);
  }
});

test('a coherent-looking reveal still rejects selected IDs with a foreign or missing physical owner in the claimed original window', async () => {
  for (const owner of [0, 1]) for (const reveal of [false, true]) {
    const c = await scenario(owner, reveal);
    const foreign = c.after.players[1 - owner].prizes[0];
    for (const id of [foreign, 'PRIVATE:missing-physical-prize']) {
      assertHistoricalForgery(c, (s) => {
        // Keep window membership and the public summary internally consistent,
        // so the requested physical-owner check—not an unrelated mismatch—
        // must reject this forged selection.
        eventsOf(s, 'requested')[0].data.choice.prizes[0] = id;
        eventsOf(s, 'resolved')[0].data.selected = [id];
        if (reveal) eventsOf(s, 'finished')[0].data.revealed = [s.cards[id] ? ref(s, id) : {
          instanceId: id, printingId: 'PRIVATE:missing-printing',
          definitionId: 'PRIVATE:missing-definition', owner,
        }];
      }, `physical selected owner ${owner}/${reveal}/${id}`, [
        foreign, 'PRIVATE:missing-physical-prize', 'PRIVATE:missing-printing', 'PRIVATE:missing-definition',
      ]);
    }
  }
});
