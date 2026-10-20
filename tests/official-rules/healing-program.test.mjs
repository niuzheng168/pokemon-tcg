// Deterministic regressions for the two healing continuation P1 reports.
// Real OfficialGame, synthetic catalog only; no card approvals or trace mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, playerView } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, hand, bench, attached, command, answer, settle } from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const spec = () => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 1 }, amount: 10, discardHealedEnergy: false,
});
const contains = (value, needle) => value === needle || !!value && typeof value === 'object' &&
  Object.values(value).some((child) => contains(child, needle));
function visit(value, fn) {
  if (!value || typeof value !== 'object') return;
  fn(value);
  for (const child of Object.values(value)) visit(child, fn);
}
function fieldPath(root, name, predicate = () => true) {
  const queue = [{ value: root, path: [] }];
  while (queue.length) {
    const { value, path } = queue.shift();
    if (!value || typeof value !== 'object') continue;
    if (Object.hasOwn(value, name) && predicate(value[name])) return [...path, name];
    for (const [key, child] of Object.entries(value)) queue.push({ value: child, path: [...path, key] });
  }
  assert.fail(`Actual host record has no ${name} field matching its declared contract.`);
}
const at = (root, path) => path.reduce((v, key) => v[key], root);
function setAt(root, path, value) {
  at(root, path.slice(0, -1))[path.at(-1)] = value;
}
const pause = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['optional', 'draw'],
  validateParameters: (p) => Object.keys(p).length === 0,
  execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }],
};
const thenHeal = {
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  operations: ['then', 'healPokemon', 'discardEnergy', 'draw'],
  validateParameters: (p) => p.op === 'healPokemon',
  execute: (_ctx, p) => [{ op: 'then', first: p, next: { op: 'draw', count: 1 } }],
};
async function make(mode = 'native', recover = false, extend = () => {}) {
  return fixture((defs) => {
    const own = binding(mode === 'then' ? 'fixture:peer-then' : 'cn.healPokemon@1', spec(), 'program:potion');
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = mode === 'gated' ?
      [binding('fixture:peer-pause', {}, 'program:pause'), own] : [own];
    // An independently valid binding on another card must not authorize this source.
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [
      binding('cn.healPokemon@1', spec(), 'program:research'),
    ];
    if (recover) defs[0].mechanics.abilities.push({
      abilityId: 'recover-source', name: '测试取回来源', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'recover-source', limit: 1 },
      sourceOfTruth: EVIDENCE, effects: [binding('cn.cards@1', {
        from: 'discard', to: 'hand', selector: { kind: 'trainer', nameKeys: ['potion'] },
        quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false,
      }, 'program:recover')],
    });
    extend(defs);
  }, new Map([['fixture:peer-pause', pause], ['fixture:peer-then', thenHeal]]));
}
function setup(f) {
  let sourceId, target;
  const g = board(f, (s) => {
    sourceId = hand(s, 0, 'potion'); target = s.players[0].active.id;
    s.players[0].active.counters = 5; attached(s, 0, s.players[0].active, 'water');
    bench(s, 0, 'other').counters = 4; bench(s, 0, 'other').counters = 3;
  });
  const before = g.snapshot();
  command(g, { type: 'playTrainer', cardId: sourceId });
  return { g, sourceId, target, before };
}
function conservation(s, cards) {
  assert.deepEqual(s.cards, cards);
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'prizes', 'lost', 'resolving'].flatMap((z) => p[z]);
    ids.push(...[p.active, ...p.bench].filter(Boolean).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(cards).filter((id) => cards[id].owner === owner)));
  }
}
function restore(g, f) {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  return r;
}
function reject(g, f, mutate, label) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)], bad = clone(saved);
  mutate(bad); const originalBad = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), undefined, label);
  assert.deepEqual(bad, originalBad, `${label}: restore must reject, not repair the supplied state.`);
  assert.deepEqual(g.snapshot(), saved); assert.deepEqual([g.view(0), g.view(1)], views);
  conservation(g.snapshot(), saved.cards);
}
function request(s) {
  const id = s.pending.data.healingChoice.id;
  const entries = s.events.filter((e) => e.ruleId === 'effects.heal-results' && e.data.kind === 'requested' && e.data.id === id);
  assert.equal(entries.length, 1); return entries[0];
}
function token(s) {
  const id = s.pending.data.programId;
  assert.equal(typeof id, 'string', 'An actual healing-bearing program must retain its opaque host token.');
  assert(id.length > 0); return id;
}
function trace(s, id = token(s)) {
  const entries = s.events.map((event, index) => ({ event, index })).filter(({ event }) =>
    event.visibility === 'private' && contains(event.data, id));
  const scheduled = entries.find(({ event }) => event.data.kind === 'scheduled');
  const opened = entries.find(({ event }) => event.data.kind === 'opened');
  assert(scheduled, 'Actual scheduled trace required.'); assert(opened, 'Actual opened trace required.');
  assert.equal(scheduled.event.ruleId, opened.event.ruleId);
  return { id, scheduled, opened,
    entries: entries.filter(({ event }) => event.ruleId === scheduled.event.ruleId) };
}

test('unmodified native program restores and heals exactly ten once without discarding Energy or rewriting physical cards', async () => {
  const f = await make(), { g, sourceId, target, before } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'healing-targets');
  const id = token(g.snapshot()); trace(g.snapshot(), id);
  const r = restore(g, f); answer(r, [target]); settle(r);
  const s = r.snapshot();
  assert.equal(s.players[0].active.counters, 4);
  assert.deepEqual(s.players[0].active.energy, before.players[0].active.energy);
  assert.equal(s.battleHistory.events.filter((e) => e.kind === 'heal').length, 1);
  assert.equal(s.players[0].discard.filter((x) => x === sourceId).length, 1);
  assert.deepEqual(s.rng, before.rng); conservation(s, before.cards); restore(r, f);
});

test('P1 coherent action plus requested journal cannot escalate amount, enable discard or substitute another selector', async () => {
  const f = await make(), { g } = setup(f);
  for (const [label, mutate] of [
    ['all-HP escalation', (a) => { a.amount = 'all'; }],
    ['unauthorized correlated Energy discard', (a) => { a.discardHealedEnergy = true; }],
    ['equivalent-window but unauthorized selector', (a) => { a.selector = { kind: 'pokemon', stages: ['basic'] }; }],
    ['combined escalation', (a) => { a.amount = 'all'; a.discardHealedEnergy = true; }],
  ]) reject(g, f, (s) => {
    mutate(s.pending.data.action); request(s).data.action = clone(s.pending.data.action);
  }, label);
});

test('P1 a duplicate queued leaf cannot replay the same program, with or without its healing choice', async () => {
  const f = await make(), { g } = setup(f);
  for (const deleteChoice of [false, true]) reject(g, f, (s) => {
    const d = clone(s.pending.data);
    if (deleteChoice) delete d.healingChoice;
    s.queue.unshift({ op: 'effect-choice', data: d });
  }, `Duplicate leaf; deleteChoice=${deleteChoice}`);
  reject(g, f, (s) => {
    const completion = clone(s.pending.data);
    s.queue.unshift({ op: 'draw-cards', data: {
      player: completion.source.owner, remaining: 1, drawn: 0, reason: 'effect',
      source: clone(completion.source), completion,
    } });
  }, 'A draw completion cannot hold a second reference to the pending program');
});

test('P1 deleting or replacing programId cannot downgrade a healing leaf into untracked fresh work', async () => {
  const f = await make(), { g } = setup(f);
  reject(g, f, (s) => { delete s.pending.data.programId; }, 'Missing current program token');
  reject(g, f, (s) => { s.pending.data.programId = `${token(s)}-unknown`; }, 'Invented current program token');
  for (const replace of [false, true]) reject(g, f, (s) => {
    const d = clone(s.pending.data); delete d.healingChoice;
    if (replace) d.programId = `${token(s)}-fresh`;
    else delete d.programId;
    s.queue.unshift({ op: 'effect-choice', data: d });
  }, `Untracked queued leaf; replace=${replace}`);
  reject(g, f, (s) => {
    delete s.pending.data.healingChoice; delete s.pending.data.programId;
    s.pending.data.action = { op: 'draw', count: 1 };
  }, 'Changing the leaf op cannot hide the actual catalog binding’s healing declaration');
});

test('P1 sequence remaining and inserted then frames cannot graft extra heal/discard/draw work', async () => {
  const f = await make(), { g } = setup(f);
  for (const extra of [spec(), { ...spec(), amount: 'all', discardHealedEnergy: true }, { op: 'draw', count: 1 }])
    reject(g, f, (s) => {
      assert.equal(s.pending.data.frames[0].kind, 'sequence');
      s.pending.data.frames[0].remaining.push(clone(extra));
    }, `Unauthorized sequence work ${extra.op}/${extra.amount ?? ''}`);
  reject(g, f, (s) => { s.pending.data.frames.push({ kind: 'then', next: spec() }); }, 'Inserted then');
  reject(g, f, (s) => { s.pending.data.frames[0].performed = true; }, 'Forged performed transition');
});

test('a real compound program cannot alter its pending then continuation despite leaving the current heal unchanged', async () => {
  const f = await make('then'), { g } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'healing-targets'); restore(g, f);
  reject(g, f, (s) => {
    const frame = s.pending.data.frames.find((x) => x.kind === 'then'); assert(frame);
    frame.next = { op: 'draw', count: 2 };
  }, 'Modified legitimate then');
});

test('an unopened queued initial effect already needs its unique scheduled program token and cannot be cloned or stripped', async () => {
  const f = await make('gated'), { g } = setup(f);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const locate = (s) => {
    const index = s.queue.findIndex((t) => t.op === 'effect' && t.data.binding.handlerId === 'cn.healPokemon@1');
    assert(index >= 0); return index;
  };
  const original = g.snapshot().queue[locate(g.snapshot())];
  assert.equal(typeof original.data.programId, 'string');
  for (const strip of [false, true]) reject(g, f, (s) => {
    const queued = clone(s.queue[locate(s)]);
    if (strip) delete queued.data.programId;
    s.queue.unshift(queued);
  }, `Cloned initial effect; strip=${strip}`);
  reject(g, f, (s) => { delete s.queue[locate(s)].data.programId; }, 'Untracked original initial effect');
  reject(g, f, (s) => { s.queue[locate(s)].data.programId += '-invented'; }, 'Unscheduled initial effect');
  reject(g, f, (s) => { s.queue.splice(locate(s), 1); }, 'Orphaned scheduled program after dropping its unopened work');
});

test('every required scheduled/opened/advance trace record is singular and cannot be deleted or duplicated', async () => {
  const f = await make(), { g } = setup(f), info = trace(g.snapshot());
  assert(info.entries.length >= 2);
  for (const { event, index } of info.entries) {
    reject(g, f, (s) => { s.events.splice(index, 1); }, `Missing ${event.data.kind}`);
    reject(g, f, (s) => { s.events.push(clone(s.events[index])); }, `Duplicate ${event.data.kind}`);
  }
});

test('host trace records remain hidden for either viewer even after their kind is renamed and visibility is forged', async () => {
  const f = await make(), { g } = setup(f), s = g.snapshot(), info = trace(s);
  for (const owner of [0, 1]) assert(!contains(g.view(owner), info.id), 'No execution token in a player projection.');
  for (const { index } of info.entries) for (const visibility of ['public', 0, 1]) {
    reject(g, f, (bad) => {
      bad.events[index].visibility = visibility;
      bad.events[index].data.kind = `renamed-${bad.events[index].data.kind}`;
    }, `Renamed visible trace ${index}/${visibility}`);
    const bad = clone(s), marker = `fixture:private-program-sentinel:${index}:${visibility}`;
    bad.events[index].visibility = visibility; bad.events[index].data.kind = 'unknown-visible-kind';
    bad.events[index].data.leakMarker = marker;
    for (const viewer of [0, 1]) {
      const view = playerView(bad, f.catalog, viewer);
      assert(!contains(view, marker), 'Filtering protects the entire trace rule, not a finite list of known kind strings.');
      assert(!contains(view, info.id), 'Malformed trace metadata cannot expose a host program token.');
    }
  }
});

test('native opened program is independently bound to immutable catalog parameters, not a coherently edited public/private journal', async () => {
  const f = await make(), { g } = setup(f), info = trace(g.snapshot());
  const path = fieldPath(info.opened.event.data, 'program', Array.isArray);
  reject(g, f, (s) => {
    s.pending.data.action.amount = 'all'; s.pending.data.action.discardHealedEnergy = true;
    request(s).data.action = clone(s.pending.data.action);
    setAt(s.events[info.opened.index].data, path, [clone(s.pending.data.action)]);
  }, 'Native program plus current/public action all forged consistently');
});

test('opened binding/source metadata cannot borrow an independently valid binding from another physical card', async () => {
  const f = await make(), { g } = setup(f), info = trace(g.snapshot());
  const other = clone(f.catalog.definition('research').mechanics.effects[0]);
  reject(g, f, (s) => {
    let bindingChanges = 0;
    for (const { index } of info.entries) visit(s.events[index].data, (v) => {
      if (Object.hasOwn(v, 'binding')) { v.binding = clone(other); bindingChanges++; }
      if (v.source?.instanceId === s.pending.data.source.instanceId) v.source.effectId = other.effectId;
    });
    assert(bindingChanges > 0, 'Mutate the actual nested catalog-binding receipt, not an invented extra field.');
    s.pending.data.source.effectId = other.effectId;
    request(s).data.source.effectId = other.effectId;
  }, 'Coherently borrowed foreign-card binding');
});

test('origin/local metadata cannot be detached from the original opened execution', async () => {
  const f = await make(), { g } = setup(f), info = trace(g.snapshot());
  reject(g, f, (s) => {
    s.pending.data.source.origin = 'field'; request(s).data.source.origin = 'field';
  }, 'Coherent public origin laundering');
  reject(g, f, (s) => {
    const opened = s.events[info.opened.index].data;
    assert.equal(typeof opened.local, 'boolean'); opened.local = !opened.local;
  }, 'Changed original execution lane');
  reject(g, f, (s) => {
    s.events[info.scheduled.index].data.origin = 'reaction';
    s.events[info.opened.index].data.origin = 'reaction';
  }, 'A native heal cannot borrow deferred-reaction origin');
});

test('coherently changing every current origin receipt cannot launder a hand-played Item past hand-only effect protection', async () => {
  const f = await make('native', false, (defs) => {
    defs[1].mechanics.effects = [binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: 'all', categories: ['trainer'], trainerOrigins: ['hand'],
    } }, 'program:hand-protection')];
  });
  const { g } = setup(f), saved = g.snapshot(), target = saved.players[0].bench[0].id;
  const normal = restore(g, f); answer(normal, [target]); settle(normal);
  assert.equal(normal.snapshot().players[0].bench[0].counters, 4, 'The actual hand-origin Item is blocked.');
  assert.equal(normal.snapshot().battleHistory.events.filter((e) => e.kind === 'heal').length, 0);
  reject(g, f, (s) => {
    const sourceId = s.pending.data.source.instanceId;
    s.pending.data.source.origin = 'field';
    let changed = 0;
    for (const event of s.events) if (['effects.execution', 'effects.heal-results'].includes(event.ruleId) &&
        event.data.source?.instanceId === sourceId) {
      event.data.source.origin = 'field'; changed++;
    }
    assert(changed >= 3, 'Forge the real schedule, open and public requested source together.');
  }, 'Coherent impossible field-origin Item');
});

test('an already completed program token cannot be borrowed by another use of the same physical Item in the same turn', async () => {
  const f = await make('native', true), { g, sourceId, target } = setup(f);
  const first = g.snapshot(), oldToken = token(first);
  answer(g, [target]); settle(g);
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'recover-source' });
  answer(g, [sourceId]); settle(g); command(g, { type: 'playTrainer', cardId: sourceId });
  const current = g.snapshot(); assert.equal(current.turn, first.turn);
  assert.notEqual(token(current), oldToken); assert.equal(current.pending.data.source.instanceId, sourceId);
  reject(g, f, (s) => { s.pending.data.programId = oldToken; }, 'Completed program reused for same source');
  reject(g, f, (s) => {
    s.queue.unshift({ op: 'effect-choice', data: clone(first.pending.data) });
  }, 'Started old program replayed behind a new prompt');
  const r = restore(g, f); answer(r, [target]); settle(r);
  assert.equal(r.snapshot().players[0].active.counters, 3, 'Only two genuinely declared uses heal twice.');
  assert.equal(r.snapshot().players[0].discard.filter((id) => id === sourceId).length, 1);
  conservation(r.snapshot(), current.cards);
});

test('copied child and suspended parent programs cannot alias tokens, graft frames or borrow the other catalog binding', async () => {
  const copy = {
    op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
  };
  const program = [{ op: 'sequence', steps: [copy, { ...spec(), target: 'self', selection: { kind: 'all' } }] }];
  const handler = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
    operations: ['sequence', 'copyAttack', 'healPokemon', 'discardEnergy'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => clone(program),
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
    defs[0].mechanics.attacks[0].effects = [binding('fixture:peer-copy', {}, 'program:copy-parent')];
    defs[1].mechanics.attacks[0].printedDamage = { value: 0, operator: 'fixed' };
    defs[1].mechanics.attacks[0].effects = [binding('cn.healPokemon@1', spec(), 'program:copy-child')];
  }, new Map([['fixture:peer-copy', handler]]));
  const g = board(f, (s) => {
    const p = s.players[1], old = p.active, replacement = bench(s, 1, 'other');
    p.bench.pop(); p.active = replacement; p.hand.push(...old.stack, ...old.energy, ...old.tools);
    s.players[0].active.counters = 5; attached(s, 0, s.players[0].active, 'water');
    bench(s, 0, 'other').counters = 3;
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  answer(g, [option.optionId]); assert.equal(g.snapshot().pending.kind, 'healing-targets');
  const saved = g.snapshot(), childId = token(saved), parentId = saved.attack.copies[0].continuation.programId;
  assert.equal(typeof parentId, 'string'); assert.notEqual(childId, parentId);
  const child = trace(saved, childId), parent = trace(saved, parentId); restore(g, f);
  reject(g, f, (s) => { s.pending.data.programId = parentId; }, 'Child cannot resume parent token');
  reject(g, f, (s) => { s.attack.copies[0].continuation.programId = childId; }, 'Suspended parent cannot borrow child token');
  reject(g, f, (s) => { delete s.attack.copies[0].continuation.programId; }, 'A suspended tracked invocation cannot become untracked');
  reject(g, f, (s) => {
    s.queue.unshift({ op: 'effect-choice', data: clone(s.attack.copies[0].continuation) });
  }, 'Suspended and queued work cannot both retain one token');
  reject(g, f, (s) => {
    s.attack.copies[0].continuation.frames.push({ kind: 'then', next: spec() });
  }, 'Suspended continuation frame graft');
  reject(g, f, (s) => {
    s.events[child.opened.index].data.binding = clone(parent.opened.event.data.binding);
  }, 'Borrowed parent binding for copied child');
});
