import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCardSelector, selectorQuantityClass, CARD_SELECTION_RULE_IDS } from '../../public/rules/card-selection.js';
import { validateCardsParameters } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const cards = (extra = {}) => ({
  from: 'deck', to: 'hand', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
  reveal: true, lookTop: null, shuffleAfter: true, ...extra,
});
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const use = (g) => command(g, { type: 'useAbility', abilityId: 'cards', pokemonId: g.snapshot().players[0].active.id });
const put = (s, owner, definitionId, zone) => {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); s.players[owner][zone].push(id); return id;
};
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const make = (p, mutate = () => {}) => fixture((defs) => {
  defs[0].mechanics.abilities.push(ability('cards', [binding('cn.cards@1', p)])); mutate(defs);
});

test('out-of-play selectors use reviewed printed fields, literal canonical names and native attack/Ability identities', async () => {
  for (const id of CARD_SELECTION_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const f = await fixture((defs) => { defs[0].mechanics.tags = ['RapidStrike']; defs[0].mechanics.abilities = [ability('printed', [binding('cn.draw@1', { count: 1 })])]; });
  const d = f.catalog.definition('base'), before = structuredClone(d);
  const selectors = [
    [{ kind: 'any' }, true], [{ kind: 'trainer' }, false], [{ kind: 'pokemon' }, true],
    [{ kind: 'pokemon', nameKeys: ['other'] }, false], [{ kind: 'pokemon', nameKeys: ['base'] }, true],
    [{ kind: 'pokemon', stages: ['basic'], types: ['Water'], printedHpAtMost: 100, ruleBox: false,
      tagsAll: ['RapidStrike'], attackIds: ['base:strike'], abilityIds: ['printed'] }, true],
    // 「拥有招式「X」的宝可梦」: the printed attack name, on whichever card it is printed.
    [{ kind: 'pokemon', attackNames: ['测试撞击'] }, true],
    ...[{ stages: ['stage1'] }, { types: ['Fire'] }, { printedHpAtMost: 90 }, { ruleBox: true },
      { tagsAll: ['RapidStrike', 'SingleStrike'] }, { attackIds: ['tool:granted'] }, { abilityIds: ['not-printed'] }, { attackNames: ['测试'] }]
      .map((extra) => [{ kind: 'pokemon', ...extra }, false]),
    [{ anyOf: [{ kind: 'energy', category: 'basic' }, { kind: 'pokemon', types: ['Water'] }] }, true],
    [{ anyOf: [{ kind: 'energy' }, { kind: 'trainer' }] }, false],
  ];
  for (const [s, expected] of selectors) assert.equal(matchesCardSelector(d, s), expected, JSON.stringify(s));
  // 「从「X」进化而来的卡牌」: the printed pre-evolution name.
  for (const [names, expected] of [[['base'], true], [['other'], false]])
    assert.equal(matchesCardSelector(f.catalog.definition('evolution'), { kind: 'pokemon', evolvesFromNameKeys: names }), expected);
  assert.equal(matchesCardSelector(d, { kind: 'pokemon', evolvesFromNameKeys: ['base'] }), false, 'A Basic Pokémon evolves from nothing.');
  for (const [selector, expected] of [
    [{ kind: 'trainer', categories: ['supporter'] }, true],
    [{ kind: 'trainer', categories: ['item'] }, false],
    [{ kind: 'trainer', nameContains: '弃手' }, true],
    [{ kind: 'trainer', nameContains: 'does-not-match' }, false],
  ]) assert.equal(matchesCardSelector(f.catalog.definition('research'), selector), expected);
  for (const [selector, expected] of [
    [{ kind: 'energy' }, true], [{ kind: 'energy', category: 'basic', types: ['Water'] }, true],
    [{ kind: 'energy', category: 'special' }, false], [{ kind: 'energy', category: 'basic', types: ['Fire'] }, false],
  ]) assert.equal(matchesCardSelector(f.catalog.definition('water'), selector), expected);
  assert.equal(selectorQuantityClass({ kind: 'any' }), 'anyCard');
  assert.equal(selectorQuantityClass({ kind: 'pokemon' }), 'specific');
  assert.equal(selectorQuantityClass(selectors.at(-1)[0]), 'specific');
  for (const s of [{}, { kind: 'pokemon', currentHpAtMost: 90 }, { kind: 'energy', types: ['Dragon'] },
    { kind: 'energy', types: ['Water'] }, { kind: 'energy', category: 'special', types: ['Colorless'] },
    { anyOf: [{ kind: 'any' }, { kind: 'pokemon' }] }, { kind: 'trainer', categories: [] }]) {
    assert.throws(() => matchesCardSelector(d, s), /Invalid reviewed/);
    assert.throws(() => selectorQuantityClass(s), /Invalid reviewed/);
  }
  assert(!matchesCardSelector(f.catalog.definition('double'), { kind: 'energy', category: 'basic', types: ['Colorless'] }),
    'An attached Special Energy provision must not masquerade as a named Basic Energy card.');
  assert.deepEqual(d, before);
});

test('full-deck search permits fail-to-find, reveals only selected cards, and shuffles even when zero are found', async () => {
  for (const reveal of [true, false]) for (const count of [0, 1]) {
    const f = await make(cards({ reveal }));
    let chosen;
    let g = board(f, (s) => { chosen = put(s, 0, 'other', 'deck'); });
    const before = g.snapshot();
    use(g);
    assert.equal(g.snapshot().pending.kind, 'select-cards');
    assert.equal(g.snapshot().pending.minimum, 0); assert(g.snapshot().pending.allowZero);
    assert.equal(g.view(0).pending.lookedAt.length, before.players[0].deck.length);
    assert(g.view(0).pending.cards.some((c) => c.instanceId === chosen));
    assert.equal(g.view(1).pending, null);
    assert(!JSON.stringify(g.view(1).events.slice(before.events.length)).includes(chosen));
    g = restore(g, f); answer(g, count ? [chosen] : []); settle(g);
    assert.equal(g.snapshot().players[0].hand.includes(chosen), !!count);
    const tail = g.snapshot().events.slice(before.events.length);
    const transfer = tail.find((e) => e.ruleId === 'effects.search');
    assert.equal(transfer.data.revealed?.length ?? 0, reveal ? count : 0);
    assert.equal(tail.filter((e) => e.ruleId === 'effects.shuffle').length, 1);
    assert.equal(g.snapshot().players[0].deck.length, before.players[0].deck.length - count);
    assert.notDeepEqual(g.snapshot().rng, before.rng);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('search with no eligible cards still offers private inspection, but public recovery with no target cannot be declared', async () => {
  const f = await make(cards({ selector: { kind: 'pokemon', printedHpAtMost: 0 } }));
  let g = board(f); use(g);
  assert.equal(g.snapshot().pending.kind, 'view-cards');
  assert(g.view(0).pending.lookedAt.length > 0); assert.deepEqual(g.view(0).pending.cards, []);
  assert.equal(g.view(1).pending, null);
  g = restore(g, f); answer(g, ['confirm']); settle(g);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle'));
  const publicFixture = await make(cards({ from: 'discard', selector: { kind: 'trainer', categories: ['supporter'] }, shuffleAfter: false }));
  const publicGame = board(publicFixture);
  assert(!publicGame.view(0).legalActions.some((a) => a.abilityId === 'cards'));
  const before = publicGame.snapshot(); assert.throws(() => use(publicGame), /not legal/); assert.deepEqual(publicGame.snapshot(), before);
});

test('any-card deck search must take the exact count; top-window inspection and invalid continuations remain bounded', async () => {
  const f = await make(cards({ selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, lookTop: 3, shuffleAfter: false }));
  let g = board(f), before = g.snapshot();
  use(g);
  assert.equal(g.snapshot().pending.minimum, 2);
  assert.deepEqual(g.view(0).pending.lookedAt.map((c) => c.instanceId), before.players[0].deck.slice(-3).reverse());
  assert.throws(() => answer(g, []), /Invalid selection/);
  assert.throws(() => answer(g, [g.snapshot().pending.options[0]]), /Invalid selection/);
  const saved = g.snapshot();
  for (const mutate of [
    (s) => { s.pending.data.lookedAt.pop(); },
    (s) => { s.pending.data.lookedAt[0] = s.players[1].deck[0]; },
  ]) { const s = structuredClone(saved); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /inspected card window/); }
  g = restore(g, f); answer(g, g.snapshot().pending.options.slice(0, 2)); settle(g);
  assert.deepEqual(g.snapshot().rng, before.rng);
  assert(!g.snapshot().events.slice(before.events.length).some((e) => e.ruleId === 'effects.shuffle'));
});

test('public exact/up-to versus filtered hand selection use different CN bounds, without counting the resolving Trainer itself', async () => {
  for (const from of ['discard', 'hand']) for (const kind of ['exact', 'upTo', 'any', 'all']) {
    const quantity = ['exact', 'upTo'].includes(kind) ? { kind, count: 2 } : { kind };
    const f = await make(cards({ from, to: 'deck', selector: { kind: 'energy', category: 'basic', types: ['Fire'] }, quantity }));
    f.deck.splice(-1, 1, 'printing:fire');
    let id;
    const g = board(f, (s) => { id = from === 'hand' ? hand(s, 0, 'fire') : put(s, 0, 'fire', 'discard'); });
    use(g);
    const q = g.snapshot().pending;
    const canZero = kind === 'any' || from === 'hand' && kind !== 'all';
    assert.equal(q.minimum, canZero ? 0 : 1);
    if (!canZero) assert.throws(() => answer(g, []), /Invalid selection/);
    answer(g, canZero ? [] : [id]); settle(g);
    assert.equal(g.snapshot().players[0][from].includes(id), canZero);
  }
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
    binding('cn.cards@1', cards({ from: 'hand', to: 'discard', selector: { kind: 'trainer', nameKeys: ['potion'] }, shuffleAfter: false })),
  ]);
  const g = board(f, (s) => hand(s, 0, 'potion'));
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'potion'));
});

test('C-11: Bench-full search cannot inspect or shuffle; deployment keeps the real origin and reserves selected cards', async () => {
  const f = await make(cards({ to: 'bench', quantity: { kind: 'exact', count: 2 }, selector: { kind: 'pokemon', stages: ['basic'] } }),
    (defs) => {
      defs[0].mechanics.attacks[0].effects = [binding('cn.cards@1', cards({ to: 'bench' }), 'attack-cards')];
      defs[1].mechanics.abilities.push(ability('deck-entry', [binding('cn.draw@1', { count: 1 })], {
        mode: 'triggered', usage: null,
        trigger: { event: 'bench', subject: 'self', origin: 'deck', optional: true, choiceOwner: 'source', scope: 'global' },
      }));
    });
  f.deck.splice(-4, 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  let first, second;
  let g = board(f, (s) => { first = put(s, 0, 'other', 'deck'); second = put(s, 0, 'base', 'deck'); });
  use(g); answer(g, [first, second]);
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  assert(g.snapshot().players[0].resolving.includes(second));
  assert(!g.snapshot().players[0].deck.includes(second), 'A triggered draw cannot steal another already-selected card.');
  const saved = g.snapshot();
  const frame = saved.queue.find((t) => t.op === 'effect-choice' && t.data.stage === 'cards-move');
  const broken = structuredClone(saved);
  const at = broken.queue.find((t) => t.op === 'effect-choice' && t.data.stage === 'cards-move');
  at.data.index = at.data.chosen.length + 1;
  assert.throws(() => OfficialGame.restore(broken, { catalog: f.catalog }), /Reserved selected cards/);
  assert.equal(frame.data.index, 1);
  g = restore(g, f); answer(g, ['perform']); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === second));
  assert(!g.snapshot().players[0].hand.includes(second));
  const full = board(f, (s) => {
    for (const id of ['base', 'base', 'other', 'other', 'other']) bench(s, 0, id);
    attached(s, 0, s.players[0].active, 'water');
  });
  assert(!full.view(0).legalActions.some((a) => a.abilityId === 'cards'));
  const before = full.snapshot();
  command(full, { type: 'attack', attackId: 'base:strike' }); settle(full);
  assert(!full.snapshot().events.slice(before.events.length).some((e) => e.ruleId === 'effects.search' || e.ruleId === 'effects.shuffle'));
});

test('E-36 empty-hand return still shuffles a nonempty deck before dependent drawing; one-card and empty shuffles differ', async () => {
  const program = [{ op: 'then', first: { op: 'cards', ...cards({
    from: 'hand', to: 'deck', selector: { kind: 'any' }, quantity: { kind: 'all' },
  }) }, next: { op: 'draw', count: 1 } }];
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['then', 'cards', 'draw'],
    validateParameters: (p) => Object.keys(p).length === 0, canUse: () => true, execute: () => structuredClone(program) };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('cards', [binding('fixture:return-draw', {})])),
    new Map([['fixture:return-draw', h]]));
  for (const remaining of [0, 1]) {
    const g = board(f, (s) => {
      const p = s.players[0]; p.discard.push(...p.hand.splice(0)); p.discard.push(...p.deck.splice(0, p.deck.length - remaining));
    });
    const before = g.snapshot(); use(g); settle(g);
    assert.equal(g.snapshot().players[0].hand.length, remaining);
    assert.deepEqual(g.snapshot().rng, before.rng);
    assert.equal(g.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'effects.shuffle').length, remaining);
  }
});

test('a Bench entry effect can fill the last slot; remaining reserved cards return safely instead of disappearing', async () => {
  const f = await make(cards({ to: 'bench', quantity: { kind: 'exact', count: 2 } }), (defs) => {
    defs[1].mechanics.abilities.push(ability('fill-from-hand', [binding('cn.cards@1', cards({
      from: 'hand', to: 'bench', selector: { kind: 'pokemon', nameKeys: ['base'] },
      quantity: { kind: 'exact', count: 1 }, shuffleAfter: false,
    }), 'fill')], { mode: 'triggered', usage: null, trigger: {
      event: 'bench', origin: 'deck', subject: 'self', optional: false, scope: 'global', choiceOwner: 'source',
    } }));
  });
  f.deck.splice(-4, 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  let first, second, filler;
  const g = board(f, (s) => {
    bench(s, 0, 'base'); bench(s, 0, 'other'); bench(s, 0, 'other');
    const reserve = (definitionId) => {
      const id = hand(s, 0, definitionId); s.players[0].hand.pop(); s.players[0].resolving.push(id); return id;
    };
    first = reserve('other'); filler = reserve('base'); second = reserve('base');
    for (const [id, zone] of [[first, 'deck'], [second, 'deck'], [filler, 'hand']]) {
      s.players[0].resolving.splice(s.players[0].resolving.indexOf(id), 1); s.players[0][zone].push(id);
    }
  });
  use(g); answer(g, [first, second]);
  assert.equal(g.snapshot().pending.data.action.from, 'hand');
  answer(g, [filler]); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 5);
  assert(g.snapshot().players[0].deck.includes(second));
  assert(!g.snapshot().players[0].resolving.includes(second));
  assert(!g.snapshot().players[0].bench.some((m) => m.stack[0] === second));
});

test('explicit face-down shuffle supports either player and all three zones, including legitimate single-card shuffling', async () => {
  for (const side of ['own', 'opponent']) for (const zone of ['hand', 'prizes', 'deck']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('cards', [binding('cn.shuffle@1', { side, zone })])));
    const g = board(f), owner = side === 'own' ? 0 : 1;
    const before = g.snapshot(), original = [...before.players[owner][zone]].sort();
    use(g); settle(g);
    assert.deepEqual([...g.snapshot().players[owner][zone]].sort(), original);
    const e = g.snapshot().events.filter((event) => event.ruleId === 'effects.shuffle').at(-1);
    assert(e); assert.equal(e.data.player, owner); assert.equal(e.data.zone, zone);
    const projected = g.view(1).events.filter((event) => event.ruleId === 'effects.shuffle').at(-1);
    assert(projected); assert.equal(projected.data.cards, undefined, 'Shuffling must not publish card fronts or permutations.');
  }
});

test('card selection parameter schemas reject silent no-op moves, unknown predicates and missing shuffle semantics', () => {
  assert(validateCardsParameters(cards()));
  for (const p of [cards({ from: 'hand' }), cards({ from: 'discard', to: 'discard' }),
    cards({ to: 'bench', selector: { kind: 'any' } }), cards({ shuffleAfter: false }),
    cards({ lookTop: 0 }), cards({ selector: { kind: 'pokemon', hp: 100 } }), { ...cards(), op: 'cards' }])
    assert(!validateCardsParameters(p), JSON.stringify(p));
});
