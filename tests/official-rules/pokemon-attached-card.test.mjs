// Synthetic definitions only. A Pokémon card that its own Ability attaches as another kind of card (pokemon.attached-card):
// 虫电宝「蓄电池」「如果这张卡牌在手牌中的话，则在自己的回合可以使用1次。将这张卡牌作为特殊能量附着于自己的「锹农炮虫（包含GX）」身上。
// 只要这张卡牌，被附着于宝可梦身上就可被视作2个【雷】能量。」 and 脱壳忍者「生命容器」「在自己的回合可以使用1次。将放于这只宝可梦身上的卡牌
// 全部放于弃牌区，将这只宝可梦作为「宝可梦道具」，放于自己的宝可梦身上。当放有这张卡牌的宝可梦【昏厥】时，对手拿取的奖赏卡将减少1张。」
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { attachedCard, currentCard, matchesCardSelector } from '../../public/rules/card-selection.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const BATTERY = { as: 'specialEnergy', recipient: { kind: 'pokemon', nameKeys: ['cannon'] }, units: [['Lightning'], ['Lightning']] };
const CONTAINER = { as: 'tool', effects: [{ handlerId: 'cn.prizeModifier@1', parameters: { effect: { op: 'prizeModifier', scope: 'self', amount: -1 } } }] };
const ability = (id, name, parameters, extra = {}) => ({ abilityId: `${id}:ability`, name, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `cn:ability:${id}`, limit: 1 },
  effects: [binding('cn.attachSelf@1', parameters, `${id}:attach`)], sourceOfTruth: EVIDENCE, ...extra });
// A synthetic Pokémon card like the fixture's 'other', under its own identity.
function pokemon(defs, id, mechanics = {}) {
  const d = clone(def(defs, 'other'));
  Object.assign(d, { definitionId: id, name: `测试${id}`, nameKey: id });
  d.mechanics = { ...d.mechanics, attacks: d.mechanics.attacks.map((a) => ({ ...a, attackId: `${id}:strike` })), ...mechanics };
  defs.push(d);
  return d;
}
// The opponent's Pokémon whose continuous Ability (「只要这只宝可梦在场上…」) is binding.
const lock = (id, binding) => (defs) => pokemon(defs, id, { abilities: [{ abilityId: `${id}:lock`, name: '测试锁', mode: 'continuous', usage: null,
  effects: [binding], sourceOfTruth: EVIDENCE }] });
async function withCards(more = () => {}, extra = []) {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 100, operator: 'fixed' };
    pokemon(defs, 'bug', { abilities: [ability('bug', '测试蓄电池', BATTERY, { zone: 'hand' })] });
    // 「每当从自己的手牌给这只宝可梦附着能量时，就恢复这只宝可梦的所有特殊状态」.
    pokemon(defs, 'cannon', { attacks: [{ attackId: 'cannon:shot', name: '测试电炮', cost: ['Lightning', 'Lightning'],
      printedDamage: { value: 100, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE }],
    abilities: [{ abilityId: 'cannon:spring', name: '测试清泉', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.cure@1', { side: 'own', target: 'self' }, 'spring')] }] });
    pokemon(defs, 'shell', { stage: 'stage1', evolvesFrom: 'base', hp: 40, abilities: [ability('shell', '测试生命容器', CONTAINER)] });
    more(defs);
  });
  f.deck.splice(20, 8 + extra.length, ...['bug', 'bug', 'cannon', 'cannon', 'shell', 'shell', 'shell', 'shell', ...extra].map((id) => `printing:${id}`));
  return f;
}
const legal = (g, type) => g.view(g.snapshot().current).legalActions.filter((a) => a.type === type);
const uses = (g, cardId) => legal(g, 'useAbility').filter((a) => a.cardId === cardId);
const inPlayUses = (g, m) => legal(g, 'useAbility').filter((a) => a.pokemonId === m.id);
// The card as it is where it is now.
const now = (g, f, id) => currentCard(g.snapshot(), f.catalog.definition(g.snapshot().cards[id].definitionId), id);
const take = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); return card; };
const toActive = (s, owner, m) => { const p = s.players[owner]; p.bench = p.bench.filter((x) => x !== m); p.bench.unshift(p.active); p.active = m; };

test('schema: cn.attachSelf@1 is a Special Energy with what it provides or a Tool with its effects, by a Pokémon\'s own activated Ability', async () => {
  const valid = (p) => handlers.get('cn.attachSelf@1').validateParameters(p);
  assert(valid(BATTERY)); assert(valid(CONTAINER)); assert(valid({ ...CONTAINER, recipient: { kind: 'pokemon' } }));
  for (const bad of [{ as: 'specialEnergy' }, { ...BATTERY, effects: CONTAINER.effects }, { as: 'tool' }, { ...CONTAINER, units: BATTERY.units },
    { as: 'tool', effects: [{ handlerId: 'cn.prizeModifier@1', parameters: { effect: { op: 'prizeModifier', scope: 'self' } } }] },
    { as: 'tool', effects: [{ handlerId: 'cn.modifier@1', parameters: { field: 'hp', amount: 50, scope: 'self' } }] }])
    assert(!valid(bad), JSON.stringify(bad));
  const f = await withCards(), shell = f.catalog.definition('shell'), bug = f.catalog.definition('bug');
  const guard = (id, mutate) => { const d = clone(f.catalog.definition(id)); mutate(d); return () => assertSupportedDefinition(f.catalog, d); };
  assert.doesNotThrow(guard('shell', () => {})); assert.doesNotThrow(guard('bug', () => {}));
  for (const [id, mutate] of [
    ['shell', (d) => { d.mechanics.abilities[0].zone = 'hand'; }], // a Tool from the hand
    ['bug', (d) => { delete d.mechanics.abilities[0].zone; }], // a Special Energy from play
    ['bug', (d) => { d.mechanics.abilities[0].zone = 'discard'; }],
    ['shell', (d) => { d.mechanics.abilities[0].mode = 'triggered'; }],
    ['shell', (d) => { d.mechanics.abilities.push({ ...d.mechanics.abilities[0], abilityId: 'shell:again' }); }],
    ['shell', (d) => { d.mechanics.abilities[0].effects.push({ ...d.mechanics.abilities[0].effects[0], effectId: 'fixture:twice' }); }],
    ['shell', (d) => { d.mechanics.attacks[0].effects = [binding('cn.attachSelf@1', CONTAINER, 'strike')]; }],
    // A Tool printing it as the Ability its holder may use.
    ['tool', (d) => { d.mechanics.grantedAbilities = [ability('tool', '测试', CONTAINER)]; }],
  ]) assert.throws(guard(id, mutate), /attaches itself/, `${id} ${mutate}`);
  // Out of play the card itself; attached, the card it is attached as (one face per card).
  assert.equal(attachedCard(f.catalog.definition('base')), null); assert.equal(attachedCard(f.catalog.definition('tool')), null);
  assert.equal(attachedCard(bug), attachedCard(bug));
  assert(matchesCardSelector(attachedCard(bug), { kind: 'energy', category: 'special' }) && !matchesCardSelector(bug, { kind: 'energy' }));
  assert.deepEqual(attachedCard(bug).mechanics.baseUnits, BATTERY.units);
  assert(matchesCardSelector(attachedCard(shell), { kind: 'trainer', categories: ['tool'] }) && !matchesCardSelector(attachedCard(shell), { kind: 'pokemon' }));
  assert.deepEqual(attachedCard(shell).mechanics.effects.map((b) => b.handlerId), ['cn.prizeModifier@1']);
});

test('「将这张卡牌作为特殊能量附着于自己的「X」身上…被视作2个【雷】能量」: from the hand onto X only, 2 Lightning, not the turn\'s attachment', async () => {
  const f = await withCards();
  let card, cannon, water;
  const g = board(f, (s) => { cannon = bench(s, 0, 'cannon'); toActive(s, 0, cannon); bench(s, 0, 'other'); card = hand(s, 0, 'bug'); water = hand(s, 0, 'water');
    cannon.conditions.rotation = 'asleep'; });
  const use = { type: 'useAbility', cardId: card, abilityId: 'bug:ability' };
  assert.deepEqual(uses(g, card), [use]);
  assert(!legal(g, 'attachEnergy').some((a) => a.cardId === card), 'In the hand it is a Pokémon card.');
  assert(legal(g, 'bench').some((a) => a.cardId === card));
  command(g, use);
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'energy-recipient'); assert.deepEqual(s.pending.options, [cannon.id], 'Only the printed Pokémon.');
  restore(g, f);
  answer(g, [cannon.id]); settle(g);
  s = g.snapshot();
  assert.deepEqual(s.players[0].active.energy, [card]); assert(!s.players[0].hand.includes(card));
  assert.equal(s.players[0].flags.energy, false);
  assert.equal(s.players[0].active.conditions.rotation, null, 'Energy attached from the hand: 「从手牌…附着能量时」 follows.');
  assert(legal(g, 'attachEnergy').some((a) => a.cardId === water), 'The turn\'s Energy attachment is still there (JP Q&A デンヂムシ).');
  assert.deepEqual(g.view(0).players[0].active.effective.energies.map((e) => e.units), [[['Lightning'], ['Lightning']]]);
  assert(legal(g, 'attack').some((a) => a.attackId === 'cannon:shot'));
  assert(matchesCardSelector(now(g, f, card), { kind: 'energy', category: 'special' }));
  assert.equal(s.players[0].bench.length, 2, 'Not a Benched Pokémon.');
  assert(s.events.some((e) => e.ruleId === 'pokemon.attached-card' && e.data.as === 'specialEnergy' && e.data.pokemonId === cannon.id));
  restore(g, f);
  // Without the printed Pokémon there is nowhere to attach it.
  const none = board(f, (s) => { card = hand(s, 0, 'bug'); });
  assert.deepEqual(uses(none, card), []);
});

test('the Special Energy it is: moved, it still gives 2 Lightning; returned to the hand or discarded, a Pokémon card again', async () => {
  const special = { side: 'own', from: 'any', selector: { kind: 'energy', category: 'special' }, providedTypes: null, measure: 'cards',
    quantity: { kind: 'exact', count: 1 }, chooser: 'source' };
  const f = await withCards((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', { ...special, op: 'moveEnergy',
      recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' }, 'switcher')];
    def(defs, 'poison').mechanics.effects = [binding('cn.attachedEnergy@1', { ...special, op: 'returnEnergy', to: 'hand' }, 'retrieve')];
    def(defs, 'research').mechanics.effects = [binding('cn.attachedEnergy@1', { ...special, op: 'discardEnergy' }, 'whisk')];
  });
  let card, cannon, other, item;
  const setup = (id) => board(f, (s) => { cannon = bench(s, 0, 'cannon'); toActive(s, 0, cannon); other = bench(s, 0, 'other');
    card = attached(s, 0, cannon, 'bug'); item = hand(s, 0, id); });
  // JP Q&A デンヂムシ×マルチつけかえ: onto a Pokémon other than X, still 2 Lightning.
  let g = setup('potion');
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  let s = g.snapshot();
  const holder = s.players[0].bench.find((m) => m.energy.includes(card));
  assert(holder && holder.id !== cannon.id); assert.deepEqual(s.players[0].active.energy, []);
  assert.deepEqual(g.view(0).players[0].bench.find((m) => m.id === holder.id).effective.energies.map((e) => e.units), [[['Lightning'], ['Lightning']]]);
  restore(g, f);
  // Back in the hand it is the Pokémon card, and its Ability can be used again.
  g = setup('poison');
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert(g.snapshot().players[0].hand.includes(card)); assert.equal(now(g, f, card).kind, 'pokemon');
  assert.deepEqual(uses(g, card).length, 1);
  // A Special Energy discarded (JP Q&A デンヂムシ×マホイップVMAX) is a Pokémon card in the discard pile.
  g = setup('research');
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  s = g.snapshot();
  assert(s.players[0].discard.includes(card) && matchesCardSelector(now(g, f, card), { kind: 'pokemon' }));
  assert.deepEqual(s.players[0].active.energy, []);
  restore(g, f);
});

test('its holder Knocked Out: the Special Energy goes to the discard pile with it (JP Q&A デンヂムシ×回収ネット)', async () => {
  const f = await withCards();
  let card;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); const cannon = bench(s, 1, 'cannon'); toActive(s, 1, cannon);
    card = attached(s, 1, cannon, 'bug'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert(s.players[1].discard.includes(card)); assert.equal(s.players[0].prizes.length, 5);
  assert.equal(now(g, f, card).kind, 'pokemon');
});

test('「如果这张卡牌在手牌中的话」: not under a Special Energy lock (JP Q&A ドンカラスGX／ムウマージ), a lock on this hand card, or onto a Pokémon that cannot take Energy from the hand', async () => {
  for (const binding_ of [
    binding('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['attachSpecialEnergy'], sourceActive: true } }, 'night'),
    binding('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playFromHand'],
      cardSelector: { kind: 'pokemon', nameKeys: ['bug'] } } }, 'cards'),
    binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'opponent', actions: ['attachFromHand'] } }, 'mud'),
  ]) {
    const f = await withCards(lock('warden', binding_), ['warden']);
    let card;
    const g = board(f, (s) => { const cannon = bench(s, 0, 'cannon'); toActive(s, 0, cannon); card = hand(s, 0, 'bug');
      toActive(s, 1, bench(s, 1, 'warden')); });
    assert.deepEqual(uses(g, card), [], binding_.effectId);
  }
});

test('「将放于这只宝可梦身上的卡牌全部放于弃牌区，将这只宝可梦作为「宝可梦道具」，放于自己的宝可梦身上」: every other card discarded, it leaves play', async () => {
  const f = await withCards();
  let mon, top, under, water, tool, other;
  const g = board(f, (s) => {
    mon = s.players[0].active; under = mon.stack[0]; top = take(s, 0, 'shell'); mon.stack.push(top);
    water = attached(s, 0, mon, 'water'); tool = take(s, 0, 'tool'); mon.tools.push(tool);
    mon.counters = 2; mon.conditions.rotation = 'asleep'; other = bench(s, 0, 'other');
  });
  const use = { type: 'useAbility', pokemonId: mon.id, abilityId: 'shell:ability' };
  assert.deepEqual(inPlayUses(g, mon), [use]);
  command(g, use);
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'tool-target'); assert.deepEqual(s.pending.options, [other.id], 'Another of its owner\'s Pokémon.');
  // A forged choice of a Pokémon that cannot take it (itself) is refused.
  const forged = clone(s), request = forged.events.find((e) => e.ruleId === 'selection.request' && e.data.request.id === forged.pending.id);
  for (const q of [forged.pending, request.data.request]) q.options.push(mon.id);
  const bad = OfficialGame.restore(forged, { catalog: f.catalog });
  assert.throws(() => answer(bad, [mon.id]), (e) => e.code === 'invalid-target');
  answer(g, [other.id]);
  s = g.snapshot();
  // The Active Spot it left is filled after the Ability (effects.field-return-promotion).
  assert.equal(s.pending.kind, 'promote'); assert.equal(s.players[0].active, null);
  restore(g, f);
  answer(g, [other.id]); settle(g);
  s = g.snapshot();
  const p = s.players[0];
  assert.equal(p.active.id, other.id); assert.deepEqual(p.active.tools, [top]);
  // JP Q&A ヌケニン: 進化前のツチニンのカードはどうなりますか？→トラッシュします。
  for (const id of [under, water, tool]) assert(p.discard.includes(id), id);
  assert(![p.active, ...p.bench].some((m) => m.id === mon.id), 'No longer a Pokémon in play.');
  assert(s.events.some((e) => e.ruleId === 'pokemon.attached-card' && e.data.as === 'tool' && e.data.from === mon.id &&
    e.data.discarded.length === 3));
  assert(s.events.some((e) => e.ruleId === 'effects.field-return' && e.data.pokemonId === other.id));
  assert.equal(s.players[1].prizes.length, 6, 'Not a Knock Out.');
  assert(matchesCardSelector(now(g, f, top), { kind: 'trainer', categories: ['tool'] }));
  assert.deepEqual(g.view(0).players[0].active.tools.map((c) => c.instanceId), [top]);
  // One Tool per Pokémon: it is that Tool (I.B-02).
  const h = board(f, (s) => { top = take(s, 0, 'shell'); s.players[0].active.tools.push(top); tool = hand(s, 0, 'tool'); });
  assert(!legal(h, 'playTrainer').some((a) => a.cardId === tool), 'No Pokémon with room for the Tool.');
  restore(g, f);
});

test('「放于自己的宝可梦身上」: from the Bench, onto another Pokémon with room for a Tool only; a Tool lock does not stop it (JP Q&A ヌケニン×ムウマージ)', async () => {
  const f = await withCards((defs) => {
    pokemon(defs, 'rack', { abilities: [{ abilityId: 'rack:cassette', name: '测试双卡带', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.toolCapacity@1', { effect: { op: 'toolCapacity', scope: 'self', count: 2 } }, 'rack')] }] });
    lock('warden', binding('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playTool'] } }, 'chaos'))(defs);
  }, ['rack', 'warden']);
  let shell, top, active;
  const shellOnBench = (s) => { shell = bench(s, 0, 'base'); top = take(s, 0, 'shell'); shell.stack.push(top); };
  // Alone, or beside a Pokémon whose one Tool space is taken: nowhere to go.
  const full = board(f, (s) => { shellOnBench(s); active = s.players[0].active; active.tools.push(take(s, 0, 'tool')); });
  assert.deepEqual(inPlayUses(full, shell), []);
  const alone = board(f, (s) => { const p = s.players[0]; shellOnBench(s); toActive(s, 0, shell); p.hand.push(...p.bench[0].stack); p.bench = []; });
  assert.deepEqual(inPlayUses(alone, shell), []);
  // A Pokémon that may hold 2 Tools takes it beside its one; from the Bench nothing is promoted.
  const g = board(f, (s) => { shellOnBench(s); active = bench(s, 0, 'rack'); toActive(s, 0, active); active.tools.push(take(s, 0, 'tool'));
    toActive(s, 1, bench(s, 1, 'warden')); });
  command(g, { type: 'useAbility', pokemonId: shell.id, abilityId: 'shell:ability' });
  const options = g.snapshot().pending.options;
  assert(options.includes(active.id) && !options.includes(shell.id), 'Not onto itself.');
  answer(g, [active.id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].active.id, active.id); assert.equal(s.players[0].active.tools.at(-1), top);
  assert(!s.players[0].bench.some((m) => m.id === shell.id));
  restore(g, f);
});

test('「当放有这张卡牌的宝可梦【昏厥】时，对手拿取的奖赏卡将减少1张」: a Tool effect, added to the other Prize changes, at least 0', async () => {
  const f = await withCards((defs) => {
    pokemon(defs, 'rack', { abilities: [{ abilityId: 'rack:cassette', name: '测试双卡带', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.toolCapacity@1', { effect: { op: 'toolCapacity', scope: 'self', count: 2 } }, 'rack')] }] });
    pokemon(defs, 'big', { ruleBox: true, prizeCount: 2, tags: ['ex'] });
    lock('jam', binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'opponent' } }, 'jam'))(defs);
  }, ['rack', 'big', 'jam']);
  const ko = (holder, shells, more = () => {}) => {
    let cards;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      const m = bench(s, 1, holder); toActive(s, 1, m); bench(s, 1, 'other');
      cards = Array.from({ length: shells }, () => take(s, 1, 'shell')); m.tools.push(...cards);
      more(s);
    });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const s = g.snapshot();
    // The holder's cards go to the discard pile, the Tool a Pokémon card there.
    assert(cards.every((id) => s.players[1].discard.includes(id) && now(g, f, id).kind === 'pokemon'));
    restore(g, f);
    return 6 - s.players[0].prizes.length;
  };
  assert.equal(ko('other', 1), 0);
  // JP Q&A ヌケニン×ゲノセクトGX: two on one Pokémon, no Prize card.
  assert.equal(ko('rack', 2), 0);
  assert.equal(ko('big', 1), 1);
  // JP Q&A ヌケニン×アバゴーラ: while Tool effects are removed it does not apply.
  assert.equal(ko('other', 1, (s) => { bench(s, 0, 'jam'); }), 1);
});

test('the Tool it is: discarded or returned to the hand as a Tool (JP Q&A ヌケニン×パンプジン／マギアナ), a Pokémon card there', async () => {
  const tools = { side: 'own', target: 'any', quantity: { kind: 'exact', count: 1 }, selector: { kind: 'trainer', categories: ['tool'] } };
  const f = await withCards((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.discardTools@1', tools, 'pumpkin')];
    def(defs, 'poison').mechanics.effects = [binding('cn.discardTools@1', { ...tools, to: 'hand' }, 'dressup')];
  });
  let top, item, base;
  const setup = (id) => board(f, (s) => { base = bench(s, 0, 'base'); base.enteredTurn = 1; top = take(s, 0, 'shell'); s.players[0].active.tools.push(top);
    item = hand(s, 0, id); });
  let g = setup('potion');
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert(g.snapshot().players[0].discard.includes(top)); assert.deepEqual(g.snapshot().players[0].active.tools, []);
  assert(matchesCardSelector(now(g, f, top), { kind: 'pokemon', stages: ['stage1'] }));
  g = setup('poison');
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert(g.snapshot().players[0].hand.includes(top));
  assert(legal(g, 'evolve').some((a) => a.cardId === top && a.pokemonId === base.id), 'In the hand it is the Stage 1 Pokémon card.');
  restore(g, f);
});

test('a Knock Out that keeps only Pokémon cards (to the hand, to the Lost Zone): it is no Pokémon card there and is discarded (JP Q&A ヌケニン×ギルガルド)', async () => {
  const zone = (id, effect) => lock(id, binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', cards: 'pokemon', ...effect } }, id));
  const f = await withCards((defs) => { zone('blade', { scope: 'self', to: 'hand', byOpponentAttack: true })(defs); zone('void', { scope: 'opponent' })(defs); },
    ['blade', 'void']);
  for (const [holder, more, kept] of [['blade', () => {}, 'hand'], ['other', (s) => { bench(s, 0, 'void'); }, 'lost']]) {
    let top, m;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); m = bench(s, 1, holder); toActive(s, 1, m);
      top = take(s, 1, 'shell'); m.tools.push(top); more(s); });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const s = g.snapshot();
    assert(s.players[1][kept].includes(m.stack[0]), holder); assert(s.players[1].discard.includes(top), holder);
    assert.equal(s.players[0].prizes.length, 6, 'One fewer Prize card.');
  }
});
