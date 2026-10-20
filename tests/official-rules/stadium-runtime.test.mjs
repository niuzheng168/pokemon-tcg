// Real OfficialGame with reviewed SYNTHETIC definitions/printings only.
// A Prism marker or an E29 fixture does not approve any real Thunder Mountain
// printing, its other mechanics, imported metadata, or a production catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateEffectProgram } from '../../public/rules/schema-validators.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const selector = (extra = {}) => ({ kind: 'trainer', categories: ['stadium'], ...extra });
const discard = (side = 'either', selected = selector()) => ({ op: 'discardStadium', side, selector: selected });
const shield = (extra = {}) => ({
  op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary',
  from: 'all', categories: ['trainer'], trainerCategories: ['item', 'supporter'], trainerOrigins: ['hand'], ...extra,
});
const fee = () => ({ costId: 'stadium-fee', kind: 'discardHand', count: 1,
  selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE });
const logs = (s, ruleId, kind) => s.events.filter((e) => e.ruleId === ruleId &&
  (kind === undefined || e.data.kind === kind));
const partial = (s) => logs(s, 'effects.partial').filter((e) => e.data.operation === 'discardStadium');
const usages = (effects, paid = false) => ({
  abilityId: 'stadium-discard', name: '测试丢弃场地', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'stadium-discard', limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...(paid ? { costs: [fee()] } : {}),
});
const reviewed = (program, operations, extra = {}) => ({
  rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-stadium-runtime-v1',
  timing: 'resolve', sourceOfTruth: EVIDENCE, operations,
  validateParameters: (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0,
  execute: () => clone(program), ...extra,
});
async function make(action = discard(), {
  slot = 'trainer', trainer = 'potion', paid = false, protection = null, prism = false,
  draw = false, after = [], transform = () => {}, handlers = new Map(),
} = {}) {
  return fixture((defs) => {
    const effects = [binding('cn.discardStadium@1', action, 'stadium-body'), ...after];
    if (draw) effects.push(binding('cn.draw@1', { count: 1 }, 'stadium-independent-draw'));
    if (slot === 'trainer') {
      const m = defs.find((d) => d.definitionId === trainer).mechanics;
      m.effects = effects; if (paid) m.playCosts = [fee()];
    } else if (slot === 'ability') defs[0].mechanics.abilities.push(usages(effects, paid));
    else defs[0].mechanics.attacks[0].effects = effects;
    const d = defs.find((d) => d.definitionId === 'stadium');
    d.mechanics.effects = protection ? [binding('cn.stadiumProtection@1', { effect: protection }, 'stadium-self-shield')] : [];
    if (prism) { d.prismStar = { sourceOfTruth: EVIDENCE }; d.deckLimits.sameName = 1; }
    transform(defs);
  }, handlers);
}
function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  // Synthetic board preparation, not a discard effect. In particular, do not
  // put an incidental Prism Star from setup into an impossible discard zone.
  p.deck.unshift(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function putStadium(s, owner) {
  const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; return id;
}
function setup(f, {
  actor = 0, targetOwner = 1, slot = 'trainer', trainer = 'potion', paid = false,
  present = true, mutate = () => {},
} = {}) {
  const c = { actor, targetOwner, slot, trainer };
  c.g = board(f, (s) => {
    if (actor === 1) fixtureClock(s, [0, 1, 0, 1]);
    c.stadiumId = present ? putStadium(s, targetOwner) : null;
    c.pokemonId = s.players[actor].active.id;
    const ids = setHand(s, actor, [...(slot === 'trainer' ? [trainer] : []), ...(paid ? ['water'] : [])]);
    c.sourceId = slot === 'trainer' ? ids[0] : s.players[actor].active.stack.at(-1);
    c.feeId = paid ? ids.at(-1) : null;
    if (slot === 'attack') attached(s, actor, s.players[actor].active, 'water');
    mutate(s, c); s.events = [];
  });
  return c;
}
const useAction = (c) => c.slot === 'trainer' ? { type: 'playTrainer', cardId: c.sourceId } :
  c.slot === 'ability' ? { type: 'useAbility', pokemonId: c.pokemonId, abilityId: 'stadium-discard' } :
    { type: 'attack', attackId: 'base:strike' };
const offered = (g, c) => g.view(c.actor).legalActions.some((a) => c.slot === 'trainer' ?
  a.type === 'playTrainer' && a.cardId === c.sourceId : c.slot === 'ability' ?
    a.type === 'useAbility' && a.abilityId === 'stadium-discard' && a.pokemonId === c.pokemonId :
    a.type === 'attack' && a.attackId === 'base:strike');
function restored(g, f) {
  const before = g.snapshot(), input = clone(before), r = OfficialGame.restore(input, { catalog: f.catalog });
  assert.deepEqual(input, before); assert.deepEqual(r.snapshot(), before);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  const receipts = logs(before, 'selection.request', 'requested');
  assert(receipts.every((e) => e.visibility === 'private'));
  assert.equal(new Set(receipts.map((e) => e.data.request.id)).size, receipts.length);
  if (before.pending) {
    const receipt = receipts.filter((e) => e.data.request.id === before.pending.id);
    assert.equal(receipt.length, 1); assert.deepEqual(receipt[0].data.request, before.pending);
  }
  for (const viewer of [0, 1]) {
    assert(!g.view(viewer).events.some((e) => ['effects.execution', 'selection.request'].includes(e.ruleId)));
    assert(!Object.hasOwn(g.view(viewer), 'rng'));
  }
  assert.deepEqual(g.snapshot(), before); return r;
}
function run(g, f, action, player = g.snapshot().current) {
  const r = restored(g, f);
  command(g, action, player); command(r, action, player);
  assert.deepEqual(r.snapshot(), g.snapshot()); restored(g, f); return g;
}
function respond(g, f, selected) {
  const r = restored(g, f);
  answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot()); restored(g, f); return g;
}
function settleRestoring(g, f) {
  for (let n = 0; g.snapshot().pending; n++) {
    assert(n < 20, 'Finite fixture-choice guard, not an engine rule.');
    const q = g.snapshot().pending;
    respond(g, f, q.allowZero ? [] : q.options.slice(0, q.minimum));
  }
}
function atomic(g, fn) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn); assert.deepEqual(g.snapshot(), before);
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function conserved(s, original) {
  assert.deepEqual(s.cards, original.cards);
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'lost', 'prizes', 'resolving'].flatMap((z) => p[z]);
    ids.push(...[p.active, ...p.bench].filter(Boolean).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(s.cards).filter((id) => s.cards[id].owner === owner)));
  }
  assert.deepEqual(s.rng, original.rng);
}
function disposed(s, id, owner, zone = 'discard') {
  assert.equal(s.players[owner][zone].filter((x) => x === id).length, 1);
  assert(!s.players[owner][zone === 'lost' ? 'discard' : 'lost'].includes(id));
  assert(!s.players[1 - owner].discard.includes(id)); assert(!s.players[1 - owner].lost.includes(id));
}
function finalized(s, c) {
  if (c.slot === 'trainer') {
    disposed(s, c.sourceId, c.actor);
    assert(!s.players[c.actor].resolving.includes(c.sourceId));
    assert.equal(logs(s, 'turn.trainer', 'trainer-finished').filter((e) => e.data.cardId === c.sourceId).length, 1);
    assert.equal(s.players[c.actor].flags.supporter, c.trainer === 'research');
  } else if (c.slot === 'ability')
    assert.deepEqual(s.players[c.actor].active.used['stadium-discard'], [s.turn]);
}

test('native Stadium discard/protection have strict distinct card-subject contracts; Prism metadata is explicit and same-name one', async () => {
  const core = createCoreHandlers(), drop = core.get('cn.discardStadium@1'), protect = core.get('cn.stadiumProtection@1');
  assert(drop); assert(protect); assert.equal(drop.timing, 'resolve'); assert.equal(protect.timing, 'continuous');
  for (const side of ['either', 'own', 'opponent']) {
    const a = discard(side); assert(drop.validateParameters(a)); assert(validateEffectProgram([a]));
    assert.deepEqual(drop.execute({}, a), [a]);
  }
  for (const a of [
    { side: 'either', selector: selector() }, discard('all'), discard('either', { kind: 'any' }),
    discard('either', { kind: 'trainer', categories: ['item', 'stadium'] }),
    { ...discard(), target: 'self' }, { ...discard(), count: 1 }, { ...discard(), approved: true },
    discard('either', { ...selector(), pokemonId: 'not-a-stadium-pokemon' }),
    discard('either', selector({ nameKeys: ['测试 雷霆台◇'] })),
  ]) assert.equal(drop.validateParameters(a), false);
  for (const useRule of ['ordinary', 'CN.E29']) {
    const effect = shield({ useRule }); assert(protect.validateParameters({ effect }));
    assert.deepEqual(protect.execute({}, { effect }), [effect]);
  }
  for (const category of ['trainer', 'attack', 'ability', 'energy']) {
    const effect = { op: 'stadiumProtection', scope: 'self', channel: 'effects',
      useRule: 'ordinary', from: 'all', categories: [category] };
    assert(protect.validateParameters({ effect }));
  }
  for (const effect of [
    shield({ op: 'protection' }), shield({ scope: 'own' }), shield({ channel: 'damage' }),
    shield({ useRule: 'CN.E29', categories: ['attack'] }),
    shield({ useRule: 'CN.E29', trainerOrigins: ['field'] }),
    shield({ useRule: 'CN.E29', trainerCategories: ['stadium'] }),
    { ...shield(), pokemonId: 'invented' }, { ...shield(), hp: 100 },
  ]) assert.equal(protect.validateParameters({ effect }), false);
  const f = await make(discard(), { prism: true });
  assert.deepEqual(f.catalog.definition('stadium').prismStar, { sourceOfTruth: EVIDENCE });
  assert.equal(f.catalog.definition('stadium').deckLimits.sameName, 1);
  for (const prismStar of [true, {}, { sourceOfTruth: [] }, { sourceOfTruth: EVIDENCE, approved: true }])
    await assert.rejects(() => fixture((defs) => {
      const d = defs.find((d) => d.definitionId === 'stadium'); d.prismStar = prismStar; d.deckLimits.sameName = 1;
    }));
  await assert.rejects(() => fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').prismStar = { sourceOfTruth: EVIDENCE };
  }), /Invalid normalized/);
});

test('Pokemon self shields cannot masquerade as Stadium-card protection, and Stadium self protection cannot migrate onto a Pokemon', async () => {
  for (const custom of [false, true]) for (const useRule of ['ordinary', 'CN.E29']) {
    const effect = { ...shield({ useRule }), op: 'protection' };
    const id = 'fixture:old-pokemon-self-provider';
    let executions = 0;
    const provider = reviewed([effect], ['protection'], { timing: 'continuous', execute: () => {
      executions++; return clone([effect]);
    } });
    const f = await fixture((defs) => {
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
        binding(custom ? id : 'cn.protection@1', custom ? {} : { effect }, 'old-pokemon-self-shield'),
      ];
    }, custom ? new Map([[id, provider]]) : new Map());
    if (custom) {
      assert.equal(f.catalog.handler(id).timing, 'continuous');
      assert.deepEqual(f.catalog.handler(id).operations, ['protection']);
      assert.equal(executions, 0);
    }
    assert.throws(() => board(f, (s) => putStadium(s, 0)), { code: 'unsupported-protection-subject' },
      `${custom ? 'dynamic provider' : 'native handler'}/${useRule}`);
    if (custom) assert(executions > 0,
      'The custom producer must actually run so this locks the dynamic output guard, not merely native admission.');
  }
  const misplaced = await fixture((defs) => defs[0].mechanics.effects.push(
    binding('cn.stadiumProtection@1', { effect: shield() }, 'misplaced-stadium-self')));
  assert.throws(() => board(misplaced));
});

test('both actors and physical Stadium owners obey either/own/opponent literally; a single matching card is discarded automatically to its owner', async () => {
  for (const actor of [0, 1]) for (const targetOwner of [0, 1]) for (const side of ['either', 'own', 'opponent']) {
    const a = discard(side), f = await make(a), c = setup(f, { actor, targetOwner }), before = c.g.snapshot();
    const matches = side === 'either' || (side === 'own') === (actor === targetOwner);
    assert.equal(offered(c.g, c), matches);
    if (!matches) {
      atomic(c.g, () => command(c.g, useAction(c), actor)); assert.deepEqual(c.g.snapshot(), before); continue;
    }
    run(c.g, f, useAction(c), actor);
    const after = c.g.snapshot(); assert.equal(after.stadium, null); assert.equal(after.pending, null);
    disposed(after, c.stadiumId, targetOwner); finalized(after, c); conserved(after, before);
    assert.equal(partial(after).length, 1); assert.equal(partial(after)[0].data.performed, true);
    const result = logs(after, 'effects.stadium-discard');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].data.subject, { kind: 'stadium', instanceId: c.stadiumId, owner: targetOwner, definitionId: 'stadium' });
    assert.equal(result[0].data.destination, 'discard'); assert.equal(result[0].data.performed, true);
    const body = logs(after, 'effects.execution', 'opened').find((e) => e.data.binding.handlerId === 'cn.discardStadium@1').data;
    assert.deepEqual(body.program, [a]); assert.equal(body.source.owner, actor); assert.equal(body.source.category, 'trainer');
    assert.equal(body.source.origin, 'hand'); assert.equal(body.source.pokemonId, null);
    assert.equal(logs(after, 'selection.request').length, 0, 'A lone Stadium is not a Pokemon target-selection prompt.');
  }
});

test('an empty or nonmatching Stadium forbids a discard-only manual Trainer/Ability without consumption, while an attack still deals printed damage and draws', async () => {
  for (const absent of [false, true]) {
    const a = absent ? discard() : discard('either', selector({ nameKeys: ['not-the-stadium-name-key'] }));
    for (const [slot, trainer] of [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion']]) {
      const f = await make(a, { slot, trainer, paid: true }), c = setup(f, { slot, trainer, paid: true, present: !absent });
      const before = c.g.snapshot(); assert.equal(offered(c.g, c), false);
      atomic(c.g, () => command(c.g, useAction(c))); assert.deepEqual(c.g.snapshot(), before);
      assert.deepEqual(c.g.snapshot().events, []); conserved(c.g.snapshot(), before); restored(c.g, f);
    }
    const f = await make(a, { slot: 'attack', draw: true }), c = setup(f, { slot: 'attack', present: !absent });
    const before = c.g.snapshot(); run(c.g, f, useAction(c));
    const after = c.g.snapshot(); assert.equal(after.stadium, before.stadium);
    assert.equal(after.players[1].active.counters, 2);
    assert.deepEqual(after.players[0].deck, before.players[0].deck.slice(0, -1));
    assert.equal(partial(after).length, 1); assert.equal(partial(after)[0].data.performed, false);
    assert.equal(after.current, 1); conserved(after, before);
  }
});

test('the narrow Stadium selector uses immutable literal nameKey and printed name text, including spaces and the distinct diamond character', async () => {
  const cases = [
    [{ nameKeys: ['synthetic-stage'] }, true], [{ nameContains: '雷霆台◇' }, true],
    [{ nameKeys: ['stadium'] }, false], [{ nameContains: '雷霆台◆' }, false],
    [{ nameContains: '雷霆台 ' }, false], [{ nameKeys: ['wrong'], nameContains: '雷霆台◇' }, false],
  ];
  for (const [selected, matches] of cases) {
    const f = await make(discard('either', selector(selected)), { transform: (defs) => {
      const d = defs.find((d) => d.definitionId === 'stadium'); d.name = '测试 雷霆台◇'; d.nameKey = 'synthetic-stage';
    } }), c = setup(f), before = c.g.snapshot();
    assert.equal(offered(c.g, c), matches, JSON.stringify(selected));
    if (matches) {
      run(c.g, f, useAction(c)); disposed(c.g.snapshot(), c.stadiumId, 1);
      assert.equal(c.g.snapshot().players[1].lost.includes(c.stadiumId), false, 'The glyph alone is not Prism metadata.');
    } else atomic(c.g, () => command(c.g, useAction(c)));
    conserved(c.g.snapshot(), before);
  }
});

test('ordinary actual-source Stadium protection makes a native-only manual Item/Supporter/Ability unavailable without fees, quota, card, RNG or hypothetical logs', async () => {
  for (const [slot, trainer] of [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion']])
    for (const paid of [false, true]) {
      const protection = slot === 'trainer' ? shield({ from: 'opponent' }) :
        { op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary', from: 'opponent', categories: ['ability'] };
      const f = await make(discard(), { slot, trainer, paid, protection }), c = setup(f, { slot, trainer, paid });
      const before = c.g.snapshot();
      for (const viewer of [0, 1, 0]) c.g.view(viewer);
      assert.equal(offered(c.g, c), false); assert.deepEqual(c.g.snapshot(), before);
      atomic(c.g, () => command(c.g, useAction(c))); assert.deepEqual(c.g.snapshot(), before);
      assert.deepEqual(c.g.snapshot().events, []); conserved(c.g.snapshot(), before); restored(c.g, f);
    }
});

test('CN.E29 permits a hand Trainer’s blocked body without unlocking then; an independent real draw can also qualify an ordinary-blocked body', async () => {
  for (const trainer of ['potion', 'research']) for (const mode of ['native', 'then', 'independent']) {
    const a = discard(), program = [{ op: 'then', first: a, next: { op: 'draw', count: 3 } }];
    const id = 'fixture:stadium-e29-then', h = reviewed(program, ['then', 'discardStadium', 'draw'], {
      // Reviewed permission for this fixed synthetic E29 hand-Trainer program,
      // not a prediction that the first effect performs or its then can run.
      canUse: (ctx) => ctx.source.category === 'trainer' && ctx.source.origin === 'hand' && !!ctx.state.stadium,
    });
    const f = await make(a, {
      trainer, protection: shield({ useRule: mode === 'independent' ? 'ordinary' : 'CN.E29' }),
      draw: mode === 'independent', handlers: mode === 'then' ? new Map([[id, h]]) : new Map(),
      transform: (defs) => {
        if (mode === 'then') defs.find((d) => d.definitionId === trainer).mechanics.effects = [binding(id, {}, 'stadium-e29-whole-then')];
      },
    }), c = setup(f, { trainer }), before = c.g.snapshot();
    assert(offered(c.g, c)); run(c.g, f, useAction(c));
    const after = c.g.snapshot(); assert.equal(after.stadium, c.stadiumId); assert.equal(after.pending, null);
    assert.equal(partial(after).length, 1); assert.equal(partial(after)[0].data.performed, false);
    const count = mode === 'independent' ? 1 : 0;
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - count);
    assert.equal(logs(after, 'effects.draw').filter((e) => e.data.player === 0).length, count);
    assert(!after.players[1].discard.includes(c.stadiumId)); assert(!after.players[1].lost.includes(c.stadiumId));
    if (mode === 'then') {
      const starts = logs(after, 'effects.execution', 'opened');
      assert.equal(starts.length, 1); assert.deepEqual(starts[0].data.program, program);
    }
    finalized(after, c); conserved(after, before);
  }
});

test('Stadium shields match the actual source category/from/Trainer origin/category, while an attack shield blocks only the discard effect, not printed damage', async () => {
  for (const overrides of [
    { categories: ['attack'], trainerCategories: undefined, trainerOrigins: undefined },
    { from: 'own' }, { trainerOrigins: ['field'] }, { trainerCategories: ['supporter'] },
  ]) {
    const protection = shield(overrides);
    for (const key of Object.keys(protection)) if (protection[key] === undefined) delete protection[key];
    const f = await make(discard(), { protection }), c = setup(f), before = c.g.snapshot();
    assert(offered(c.g, c)); run(c.g, f, useAction(c));
    assert.equal(c.g.snapshot().stadium, null); disposed(c.g.snapshot(), c.stadiumId, 1); conserved(c.g.snapshot(), before);
  }
  for (const blocked of [false, true]) {
    const protection = blocked ? { op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary',
      from: 'opponent', categories: ['attack'] } : shield({ useRule: 'CN.E29', from: 'opponent' });
    const f = await make(discard(), { slot: 'attack', protection, draw: true }), c = setup(f, { slot: 'attack' });
    const before = c.g.snapshot(); run(c.g, f, useAction(c));
    const after = c.g.snapshot(); assert.equal(after.stadium, blocked ? c.stadiumId : null);
    assert.equal(after.players[1].active.counters, 2); assert.equal(partial(after)[0].data.performed, !blocked);
    assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
    if (!blocked) disposed(after, c.stadiumId, 1);
    conserved(after, before);
  }
});

test('a shared Stadium’s onUse source keeps physical cardOwner separate from the activator, uses field origin, and draws only for the activator', async () => {
  for (const actor of [0, 1]) for (const matches of [false, true]) {
    const targetOwner = 1 - actor, a = discard('opponent'), id = 'fixture:stadium-owned-use';
    const program = [a, { op: 'draw', count: 1 }];
    // A real independent draw qualifies this reviewed whole onUse program.
    // Do not infer completeness of a native-only useStadium no-change gate:
    // the host's older kind:stadium eligibility remains a separate boundary.
    const h = reviewed(program, ['discardStadium', 'draw'], {
      timing: 'onUse', usage: { period: 'turn', scope: 'player', key: 'stadium-owned-use', limit: 1 },
      canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0,
    });
    const protection = shield({ from: 'opponent', trainerCategories: ['stadium'], trainerOrigins: [matches ? 'field' : 'hand'] });
    const f = await fixture((defs) => {
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
        binding('cn.stadiumProtection@1', { effect: protection }, 'stadium-field-self'),
        binding(id, {}, 'stadium-owned-use'),
      ];
    }, new Map([[id, h]]));
    const c = setup(f, { actor, targetOwner, slot: 'ability' }), before = c.g.snapshot();
    assert(c.g.view(actor).legalActions.some((a) => a.type === 'useStadium'));
    run(c.g, f, { type: 'useStadium' }, actor);
    const after = c.g.snapshot(), start = logs(after, 'effects.execution', 'opened').find((e) => e.data.binding.handlerId === id).data;
    assert.equal(start.source.instanceId, c.stadiumId); assert.equal(start.source.owner, actor);
    assert.equal(start.source.cardOwner, targetOwner); assert.equal(start.source.category, 'trainer');
    assert.equal(start.source.origin, 'field'); assert.equal(start.source.pokemonId, null);
    assert.equal(after.stadium, matches ? c.stadiumId : null); assert.equal(partial(after)[0].data.performed, !matches);
    assert.equal(after.players[actor].deck.length, before.players[actor].deck.length - 1);
    assert.equal(after.players[targetOwner].deck.length, before.players[targetOwner].deck.length);
    assert.deepEqual(after.players[actor].used['stadium-owned-use'], [before.turn]);
    assert.equal(after.players[targetOwner].used['stadium-owned-use'], undefined);
    if (!matches) disposed(after, c.stadiumId, targetOwner);
    atomic(c.g, () => command(c.g, { type: 'useStadium' }, actor));
    conserved(after, before);
  }
});

test('an actual attached Energy trigger keeps category energy and field source origin distinct from its hand-origin attachment event', async () => {
  for (const blocked of [false, true]) {
    const protection = blocked ? { op: 'stadiumProtection', scope: 'self', channel: 'effects',
      useRule: 'ordinary', from: 'opponent', categories: ['energy'] } : shield({ from: 'opponent' });
    const f = await make(discard(), { protection, transform: (defs) => {
      defs.find((d) => d.definitionId === 'double').mechanics.effects = [{
        ...binding('cn.discardStadium@1', discard(), 'stadium-energy-reaction'),
        trigger: { event: 'energyAttached', subject: 'self', cardIsSource: true, origin: 'hand',
          optional: false, choiceOwner: 'source', scope: 'global' },
      }];
    } });
    let energy;
    const c = setup(f, { slot: 'ability', mutate: (s) => { [energy] = setHand(s, 0, ['double']); } });
    const before = c.g.snapshot();
    run(c.g, f, { type: 'attachEnergy', cardId: energy, pokemonId: c.pokemonId });
    const after = c.g.snapshot(), start = logs(after, 'effects.execution', 'opened')
      .find((e) => e.data.binding.effectId === 'fixture:stadium-energy-reaction').data;
    assert.equal(start.source.instanceId, energy); assert.equal(start.source.category, 'energy');
    assert.equal(start.source.owner, 0); assert.equal(start.source.pokemonId, c.pokemonId);
    assert.equal(start.source.origin, 'field'); assert.equal(start.event.origin, 'hand');
    assert.equal(after.stadium, blocked ? c.stadiumId : null);
    assert.equal(partial(after).length, 1); assert.equal(partial(after)[0].data.performed, !blocked);
    assert.deepEqual(after.players[0].active.energy, [energy]); assert.equal(after.players[0].flags.energy, true);
    if (!blocked) disposed(after, c.stadiumId, 1);
    conserved(after, before);
  }
});

test('ordinary replacement is not a shielded discard instruction; explicit Prism disposal goes to its original owner’s Lost Zone, never by name glyph inference', async () => {
  for (const mode of ['ordinary', 'glyph-only', 'prism']) for (const replace of [false, true]) {
    const protection = replace ? shield({ useRule: 'CN.E29' }) : null;
    const f = await make(discard(), { prism: mode === 'prism', protection, transform: (defs) => {
      if (mode !== 'ordinary') defs.find((d) => d.definitionId === 'stadium').name += '◇';
      if (replace) defs.find((d) => d.definitionId === 'poison').mechanics = { category: 'stadium', effects: [] };
    } });
    let replacement;
    const c = setup(f, { mutate: (s) => { if (replace) replacement = hand(s, 0, 'poison'); } }), before = c.g.snapshot();
    run(c.g, f, replace ? { type: 'playTrainer', cardId: replacement } : useAction(c));
    const after = c.g.snapshot(); assert.equal(after.stadium, replace ? replacement : null);
    disposed(after, c.stadiumId, 1, mode === 'prism' ? 'lost' : 'discard');
    if (replace) {
      assert.equal(after.players[0].flags.stadium, true);
      assert.equal(partial(after).length, 0, 'Ordinary replacement must not counterfeit a card-effect discard invocation.');
      assert(!after.players[0].discard.includes(replacement)); assert(!after.players[0].lost.includes(replacement));
    } else finalized(after, c);
    assert.equal(f.catalog.definition('stadium').prismStar !== undefined, mode === 'prism');
    conserved(after, before);
  }
});

test('discarding an HP-granting Stadium settles the existing KO boundary and records an effect cause, not attack damage', async () => {
  const f = await make(discard(), { transform: (defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'all' }, 'stadium-hp'),
    ];
  } });
  let victim, survivor;
  const c = setup(f, { mutate: (s) => {
    victim = s.players[1].active.id; s.players[1].active.counters = 12; survivor = bench(s, 1, 'other').id;
  } }), before = c.g.snapshot();
  assert.equal(c.g.view(0).players[1].active.effective.maxHp, 150);
  run(c.g, f, useAction(c)); settleRestoring(c.g, f);
  const after = c.g.snapshot(); assert.equal(after.stadium, null); assert.equal(after.players[1].active.id, survivor);
  assert.equal(after.players[0].prizes.length, before.players[0].prizes.length - 1);
  const ko = after.battleHistory.events.filter((e) => e.kind === 'ko' && e.pokemonId === victim);
  assert.equal(ko.length, 1); assert.equal(ko[0].cause.kind, 'effect');
  assert.equal(ko[0].cause.source.instanceId, c.sourceId); assert.equal(ko[0].cause.source.category, 'trainer');
  assert.equal(ko[0].cause.source.owner, 0); assert.equal(ko[0].cause.source.origin, 'hand');
  disposed(after, c.stadiumId, 1); finalized(after, c); conserved(after, before);
});

test('discarding a current-type Stadium settles illegal Special Energy before the next binding’s target prompt', async () => {
  const f = await make(discard(), { after: [
    binding('cn.counters@1', { side: 'own', target: 'any', count: 1 }, 'stadium-after-removal'),
  ], transform: (defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types: ['Psychic'], scope: 'all' } }, 'stadium-types'),
    ];
    defs.find((d) => d.definitionId === 'double').mechanics.remainOn = { kind: 'pokemon', types: ['Psychic'] };
  } });
  let energy;
  const c = setup(f, { mutate: (s) => {
    energy = attached(s, 0, s.players[0].active, 'double'); bench(s, 0, 'other');
  } }), before = c.g.snapshot();
  assert.deepEqual(c.g.view(0).players[0].active.effective.types, ['Psychic']);
  run(c.g, f, useAction(c));
  const pending = c.g.snapshot(); assert.equal(pending.pending.kind, 'effect-target');
  assert.equal(pending.pending.data.action.op, 'counters'); assert.equal(pending.stadium, null);
  assert.deepEqual(c.g.view(0).players[0].active.effective.types, ['Water']);
  assert.deepEqual(pending.players[0].active.energy, []);
  assert.equal(pending.players[0].discard.filter((id) => id === energy).length, 1);
  assert.equal(logs(pending, 'energy.move').filter((e) => e.data.energyId === energy &&
    e.data.discarded === 'attachment-condition').length, 1);
  assert.equal(pending.players[0].flags.energy, before.players[0].flags.energy);
  respond(c.g, f, [c.pokemonId]); finalized(c.g.snapshot(), c); conserved(c.g.snapshot(), before);
});

test('a complete static hand fee restores before/after the automatic Stadium leaf and is charged once across the later choice/finalizer', async () => {
  for (const slot of ['trainer', 'ability']) {
    const f = await make(discard(), { slot, paid: true, prism: slot === 'trainer', after: [
      binding('cn.counters@1', { side: 'own', target: 'any', count: 1 }, 'stadium-paid-followup'),
    ] });
    const c = setup(f, { actor: 1, targetOwner: 0, slot, paid: true, mutate: (s) => {
      attached(s, 1, s.players[1].active, 'water'); bench(s, 1, 'other');
    } }), before = c.g.snapshot();
    run(c.g, f, useAction(c), 1);
    const payment = c.g.snapshot().pending; assert.equal(payment.kind, 'activation-cost');
    assert.equal(payment.player, 1); assert.equal(c.g.snapshot().stadium, c.stadiumId);
    atomic(c.g, () => answer(c.g, []));
    const selected = [paymentOptionId('stadium-fee', c.feeId)];
    respond(c.g, f, selected);
    const choosing = c.g.snapshot(); assert.equal(choosing.pending.kind, 'effect-target'); assert.equal(choosing.stadium, null);
    assert.equal(choosing.pending.data.action.op, 'counters'); assert.equal(choosing.pending.data.source.owner, 1);
    disposed(choosing, c.stadiumId, 0, slot === 'trainer' ? 'lost' : 'discard');
    disposed(choosing, c.feeId, 1);
    assert.deepEqual(choosing.players[1].active.energy, before.players[1].active.energy);
    respond(c.g, f, [c.pokemonId]);
    const after = c.g.snapshot(); assert.equal(after.pending, null);
    assert.equal(logs(after, 'effects.activation-cost').length, 1);
    assert.equal(partial(after).length, 1); assert.equal(partial(after)[0].data.performed, true);
    disposed(after, c.feeId, 1); finalized(after, c); conserved(after, before);
    atomic(c.g, () => command(c.g, { type: 'answer', requestId: payment.id, selected }, 1));
  }
});

test('II.D-04 p44: fixed synthetic Special-Energy and Stadium parts are independent, and a partially performed sequence unlocks then', async () => {
  const energyPart = { op: 'discardEnergy', side: 'opponent', from: 'any',
    selector: { kind: 'energy', category: 'special' }, providedTypes: null, measure: 'cards',
    quantity: { kind: 'exact', count: 1 }, chooser: 'source' };
  const stadiumPart = discard('opponent');
  const program = [{ op: 'then', first: { op: 'sequence', steps: [energyPart, stadiumPart] },
    next: { op: 'draw', count: 1 } }];
  const id = 'fixture:stadium-d04-independent';
  const h = reviewed(program, ['then', 'sequence', 'discardEnergy', 'discardStadium', 'draw'], {
    canUse: (ctx) => {
      const { source, state, definitions } = ctx;
      const definition = (cardId) => definitions[state.cards[cardId].definitionId];
      if (source.category !== 'trainer' || source.origin !== 'hand' ||
          definition(source.instanceId).mechanics.category !== 'item') return false;
      // Reviewed proof ONLY for this fixed program/fixture: one opposing
      // Special Energy OR the opposing Stadium can change. Its optional
      // shields are static native self/effects/ordinary hand-Item shields;
      // there are no dynamic providers, suppression, costs or E29 overlaps.
      // This is not synthesis of arbitrary programs or all-native eligibility.
      const blocked = (d, handlerId, op) => d.mechanics.effects.some((b) => {
        if (b.handlerId !== handlerId) return false;
        const e = b.parameters.effect;
        return e.op === op && e.scope === 'self' && e.channel === 'effects' && e.useRule === 'ordinary' &&
          e.from === 'opponent' && e.categories.includes('trainer') &&
          e.trainerCategories.includes('item') && e.trainerOrigins.includes('hand');
      });
      const opponent = state.players[1 - source.owner];
      const energyCanChange = [opponent.active, ...opponent.bench].filter(Boolean).some((m) =>
        m.energy.some((cardId) => definition(cardId).kind === 'energy' &&
          definition(cardId).mechanics.category === 'special') &&
        !blocked(definition(m.stack.at(-1)), 'cn.protection@1', 'protection'));
      const stadiumCanChange = state.stadium !== null && state.cards[state.stadium].owner === 1 - source.owner &&
        definition(state.stadium).kind === 'trainer' && definition(state.stadium).mechanics.category === 'stadium' &&
        !blocked(definition(state.stadium), 'cn.stadiumProtection@1', 'stadiumProtection');
      return energyCanChange || stadiumCanChange;
    },
  });
  const cases = [
    { name: 'onlyEnergy', energy: true, stadium: false },
    { name: 'onlyStadium', energy: false, stadium: true },
    { name: 'both', energy: true, stadium: true },
    { name: 'oneBlockedEnergy', energy: true, stadium: true, blocked: 'energy' },
    { name: 'oneBlockedStadium', energy: true, stadium: true, blocked: 'stadium' },
  ];
  for (const spec of cases) {
    const protection = shield({ from: 'opponent', trainerCategories: ['item'] });
    const f = await make(stadiumPart, {
      protection: spec.blocked === 'stadium' ? protection : null,
      transform: (defs) => {
        defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(id, {}, 'stadium-d04-independent')];
        if (spec.blocked === 'energy') defs[0].mechanics.effects.push(binding('cn.protection@1',
          { effect: { ...protection, op: 'protection' } }, 'stadium-d04-energy-shield'));
      },
      handlers: new Map([[id, h]]),
    });
    let special, basic;
    const c = setup(f, { present: spec.stadium, mutate: (s) => {
      const target = s.players[1].active;
      basic = attached(s, 1, target, 'water');
      if (spec.energy) special = attached(s, 1, target, 'double');
    } }), before = c.g.snapshot();
    const energyPerformed = spec.energy && spec.blocked !== 'energy';
    const stadiumPerformed = spec.stadium && spec.blocked !== 'stadium';
    assert(energyPerformed || stadiumPerformed);
    assert(offered(c.g, c), `${spec.name}: this fixed program does not require both resource classes to be present/unblocked.`);
    assert.deepEqual(c.g.snapshot(), before, 'The fixed-program canUse proof is readonly.');
    run(c.g, f, useAction(c));
    if (spec.energy) {
      const choosing = c.g.snapshot(), q = choosing.pending;
      assert.equal(q.kind, 'attached-energy'); assert.equal(q.player, 0);
      assert.deepEqual(q.data.action, energyPart); assert.deepEqual(q.options, [special]);
      assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
      assert.equal(choosing.stadium, before.stadium, 'The second independent part has not executed before the Energy answer.');
      assert.deepEqual(choosing.players[1].active.energy, before.players[1].active.energy);
      assert.equal(c.g.view(1).pending, null);
      respond(c.g, f, [special]); // Protected Energy is still a legitimate choice.
    }
    const after = c.g.snapshot();
    assert.equal(after.pending, null);
    assert.equal(after.stadium, stadiumPerformed ? null : before.stadium);
    assert(after.players[1].active.energy.includes(basic), 'A basic Energy is never substituted for the printed Special-Energy part.');
    if (spec.energy) {
      assert.equal(after.players[1].active.energy.includes(special), !energyPerformed);
      if (energyPerformed) disposed(after, special, 1);
      else assert(!after.players[1].discard.includes(special));
    }
    if (stadiumPerformed) disposed(after, c.stadiumId, 1);
    else if (spec.stadium) assert(!after.players[1].discard.includes(c.stadiumId));
    const results = logs(after, 'effects.partial').filter((e) => e.data.effectId === 'fixture:stadium-d04-independent');
    assert.deepEqual(results.map((e) => ({ operation: e.data.operation, performed: e.data.performed })), [
      { operation: 'discardEnergy', performed: energyPerformed },
      { operation: 'discardStadium', performed: stadiumPerformed },
      { operation: 'draw', performed: true },
    ], `${spec.name}: either performed part makes the aggregate first sequence true, not an all-parts AND.`);
    assert.deepEqual(after.players[0].deck, before.players[0].deck.slice(0, -1));
    assert.deepEqual(after.players[0].hand, [before.players[0].deck.at(-1)]);
    assert.equal(logs(after, 'effects.draw').filter((e) => e.data.player === 0 && e.data.count === 1).length, 1);
    const starts = logs(after, 'effects.execution', 'opened');
    assert.equal(starts.length, 1); assert.deepEqual(starts[0].data.program, program);
    assert.deepEqual(f.catalog.definition('potion').mechanics.effects.map((b) => b.handlerId), [id],
      'Both independent parts and their dependent then stay inside one reviewed whole-program binding.');
    finalized(after, c); conserved(after, before); restored(c.g, f);
  }
});
