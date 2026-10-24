// Synthetic definitions only. A later step that depends on the exact cards or Pokémon an earlier step moved (effects.moved-cards,
// attack.copy, effects.attach, II.E-19):
// 「将自己的1张手牌放于弃牌区。然后，从牌库上方抽取2张卡牌。如果被放于弃牌区的卡牌是能量的话，则再抽取2张卡牌。」
// 「将自己牌库上方的1张卡牌放于弃牌区，如果该卡牌是能量的话，则追加造成90点伤害。然后，将放于弃牌区的能量附着于这只宝可梦身上。」
// 「将自己牌库上方5张卡牌放于弃牌区，追加造成其中宝可梦张数×60点伤害。然后，将任意数量的被放于弃牌区的【火】宝可梦，放于备战区。」
// 「将自己牌库上方1张卡牌放于弃牌区，如果那张卡牌是宝可梦（除「拥有规则的宝可梦」外）的话，则选择那只宝可梦所拥有的1个招式，作为这个招式使用。」
// 「查看对手的手牌。若希望，将其中的1张宝可梦，放于弃牌区。在这种情况下，选择该宝可梦所拥有的1个招式（除GX招式外），作为这个招式使用。」
// 「将自己的战斗宝可梦与备战宝可梦互换。然后，选择被换入备战区的宝可梦身上附着的任意数量的能量，转附于新的战斗宝可梦身上。」
// 「将自己弃牌区中的2张【恶】属性的「宝可梦GX・EX」，放于备战区。如果追加附有1个能量的话，则给新出场的宝可梦身上，各附着2张弃牌区中的能量。」
// The fixture Pokémon are all 【水】, so the printed types read 【水】 here. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { copyCandidates } from '../../public/rules/attack-copy.js';
import { assertEffectProgram, bindMovedEffect, expandEffectStep } from '../../public/rules/effects.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.thenMoved@1').validateParameters(clone(p));
const cards = (parameters) => ({ handlerId: 'cn.cards@1', parameters: { reveal: false, lookTop: null, shuffleAfter: false, ...parameters } });
const draw = (count) => ({ handlerId: 'cn.draw@1', parameters: { count } });
const MILL = 'fixture:mill';
const discardOne = cards({ from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 } });
const roller = { first: discardOne, next: draw(2), use: 'count', ifMoved: { selector: { kind: 'energy' }, effect: draw(2) } };
const attachSelf = { handlerId: 'cn.attachDiscard@1', parameters: { type: null, category: 'any', count: 1, benchOnly: false, optional: false, target: 'self' } };
const takeBack = { counted: MILL, next: attachSelf, use: 'cards' };
const revive = (selector) => cards({ from: 'discard', to: 'bench', selector, quantity: { kind: 'any' } });
const anyStage = { kind: 'pokemon', types: ['Water'], stages: ['basic', 'stage1', 'stage2'] };
const copy = (side, extra = {}) => ({ handlerId: 'cn.copyAttack@1', parameters: { op: 'copyAttack',
  origins: [{ side, zone: 'discard', selector: { kind: 'pokemon', ruleBox: false } }], excludeUser: false, coin: 'none', energy: 'ignore',
  special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE }, ...extra } });
const millTop = (side = 'own', extra = {}) => ({ handlerId: 'cn.discardDeckTop@1', parameters: { side, count: 1, ...extra } });
const inspire = { first: millTop(), next: copy('own'), use: 'cards' };
const lookDiscard = (to = 'discard') => ({ handlerId: 'cn.opponentHand@1',
  parameters: { mode: 'look', selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 }, to, optional: true } });
const hypnosis = { first: lookDiscard(), next: copy('opponent', { excludeSpecialRules: ['GX'] }), use: 'cards' };
const swapOwn = { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'active' } };
const moveTo = (side = 'own', op = 'moveEnergy') => ({ handlerId: 'cn.attachedEnergy@1', parameters: { op, side, from: 'any', selector: { kind: 'energy' },
  providedTypes: null, measure: 'cards', quantity: { kind: 'any' }, chooser: 'source',
  ...(op === 'moveEnergy' ? { recipient: { position: 'active', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' } : {}) } });
const scramble = { first: swapOwn, next: moveTo(), use: 'pokemon' };
const extra = { kind: 'compare', left: { kind: 'extraEnergy', energyType: null }, relation: 'gte', right: lit(1) };
const eachTwo = { handlerId: 'cn.attachDiscard@1', parameters: { type: null, category: 'any', count: 2, exact: true, distribution: 'perRecipient',
  benchOnly: false, optional: false } };
const union = { first: cards({ from: 'discard', to: 'bench', selector: { kind: 'pokemon', types: ['Water'] }, quantity: { kind: 'exact', count: 2 } }),
  next: eachTwo, use: 'pokemon', condition: extra };
const pile = (s, owner, zone, ids) => ids.map((id) => { const c = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(c); return c; });
const formula = (expression) => binding('cn.damageValue@1', { expression }, 'formula');
const moved = (selector) => ({ kind: 'movedCards', effectId: MILL, selector });
async function attackWith(effects, transform = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
    transform(defs);
  });
}
function attack(f, mutate, policy, energies = 1) {
  const g = board(f, (s) => { mutate(s); for (let i = 0; i < energies; i++) attached(s, 0, s.players[0].active, 'water'); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, policy);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const events = g.snapshot().events.slice(from);
  return { g, events, damage: events.filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')).reduce((n, e) => n + e.data.damage, 0) };
}

test('schema: what may be bound to the cards or Pokémon an earlier step moved', () => {
  for (const p of [roller, takeBack, { counted: MILL, next: revive(anyStage), use: 'cards' }, inspire, hypnosis, scramble, union,
    { first: millTop('opponent'), next: copy('opponent'), use: 'cards' },
    { first: cards({ from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' }, lookTop: 1 }), next: copy('own'), use: 'cards' }])
    assert(valid(p), JSON.stringify(p));
  for (const bad of [
    { ...takeBack, first: discardOne }, { next: attachSelf, use: 'cards' }, // exactly one of first and counted
    { ...takeBack, use: 'count' }, { ...takeBack, use: 'pokemon' }, { ...takeBack, optional: true },
    { ...takeBack, next: cards({ from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' } }) }, // another zone
    { ...takeBack, next: cards({ from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'all' }, side: 'opponent' }) },
    { ...takeBack, next: { ...attachSelf, handlerId: 'cn.attachHand@1' } },
    { ...roller, ifMoved: { selector: { kind: 'energy' }, effect: draw(0) } }, { ...roller, first: draw(0) },
    { first: cards({ from: 'discard', to: 'bench', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 } }), next: eachTwo, use: 'pokemon',
      ifMoved: roller.ifMoved }, // a kind of card, not of Pokémon
    { ...inspire, use: 'count' }, { ...inspire, next: copy('opponent') }, { ...inspire, optional: true }, { ...inspire, condition: extra },
    { ...inspire, ifMoved: roller.ifMoved }, { counted: MILL, next: copy('own'), use: 'cards' }, { ...inspire, first: millTop('own', { to: 'lost' }) },
    { ...inspire, first: cards({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'all' }, lookTop: 1 }) },
    { ...hypnosis, first: lookDiscard('deckShuffle') }, { first: millTop('opponent'), next: copy('opponent', { chooser: 'opponent' }), use: 'cards' },
    { ...inspire, next: copy('own', { among: 'moved' }) }, { ...inspire, next: copy('own', { coin: 'never' }) },
    { ...inspire, next: copy('own', { origins: [{ side: 'own', zone: 'field', selector: { kind: 'pokemon' } }] }) },
    { ...scramble, next: { handlerId: 'cn.counters@1', parameters: { side: 'own', target: 'any', count: 1 } } },
    { ...scramble, next: moveTo('opponent') }, { ...scramble, next: moveTo('own', 'discardEnergy') },
  ]) assert(!valid(bad), JSON.stringify(bad));
  assert(handlers.get('cn.attachDiscard@1').validateParameters(clone(eachTwo.parameters)));
  assert(!handlers.get('cn.attachDiscard@1').validateParameters({ ...eachTwo.parameters, distribution: 'everyRecipient' }));
  assert(handlers.get('cn.copyAttack@1').validateParameters(clone(hypnosis.next.parameters)));
  for (const bad of [{ excludeSpecialRules: [] }, { excludeSpecialRules: ['TAG TEAM'] }, { among: ['x'] }])
    assert(!handlers.get('cn.copyAttack@1').validateParameters({ ...clone(inspire.next.parameters), ...bad }), JSON.stringify(bad));
  assert.equal(handlers.get('cn.thenMoved@1').canUse({}, takeBack), true, 'A counted first part is the attack\'s own record.');
});

test('the step machine: a condition, the holders a move takes from, and a moved card\'s kind', () => {
  const pool = { op: 'attachDiscard', type: null, count: 1, benchOnly: false, optional: false, among: 'moved' };
  const when = (effect) => ({ op: 'when', condition: extra, effect });
  assert.deepEqual(bindMovedEffect({ kind: 'thenMoved', next: when(pool), use: 'cards' }, ['x']).effect.among, ['x']);
  assert.equal(bindMovedEffect({ kind: 'thenMoved', next: when({ op: 'draw', count: 2 }), use: 'count', path: 'count' }, ['a', 'b']).effect.count, 4);
  assert.equal(bindMovedEffect({ kind: 'thenMoved', next: when({ ...cards({ from: 'deck', to: 'hand', selector: { kind: 'pokemon' },
    quantity: { kind: 'upTo', count: 1 } }).parameters, op: 'cards' }), use: 'count', path: 'quantity' }, ['a', 'b']).effect.quantity.count, 2);
  const move = { op: 'moveEnergy', ...moveTo().parameters };
  assert.deepEqual(bindMovedEffect({ kind: 'thenMoved', next: move, use: 'pokemon', origin: true }, ['m1']),
    { op: 'bound', pokemon: ['m1'], origin: true, effect: move });
  const kind = { op: 'ifMoved', among: 'moved', selector: { kind: 'energy' }, effect: { op: 'draw', count: 2 } };
  assert.deepEqual(bindMovedEffect({ kind: 'thenMoved', next: { op: 'draw', count: 2 }, use: 'count', path: 'count', ifMoved: kind }, ['c1']),
    { op: 'sequence', steps: [{ op: 'draw', count: 2 }, { ...kind, among: ['c1'] }] });
  const program = { op: 'thenMoved', first: { op: 'recordedCards', effectId: MILL }, next: move, use: 'pokemon', origin: true, ifMoved: kind };
  assert.deepEqual(expandEffectStep({ action: program, frames: [] }).frames, [{ kind: 'thenMoved', next: move, use: 'pokemon', origin: true, ifMoved: kind }]);
  assert.deepEqual(expandEffectStep({ action: { op: 'bound', pokemon: ['m1'], origin: true, effect: move }, frames: [] }).frames,
    [{ kind: 'bound', pokemon: ['m1'], origin: true }]);
  assert.throws(() => assertEffectProgram([program], ['thenMoved', 'recordedCards', 'moveEnergy', 'draw']), /ifMoved/);
  assert.doesNotThrow(() => assertEffectProgram([program], ['thenMoved', 'recordedCards', 'moveEnergy', 'draw', 'ifMoved']));
  const step = { action: { ...kind, among: ['c1'] }, frames: [] };
  assert.deepEqual(advanceEffectExecution({ id: 'program1', index: 0, step }, { ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: 'program1', index: 0, mode: 'optional', performed: true } }).step, { action: kind.effect, frames: [] });
});

test('「将自己的1张手牌放于弃牌区。然后，抽取2张。如果被放于弃牌区的卡牌是能量的话，则再抽取2张」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.thenMoved@1', roller, 'roll')];
    // ローラースケーター Q&A: a ◇ Energy goes to the Lost Zone instead, and still draws 2 more.
    const star = def(defs, 'double'); star.prismStar = { sourceOfTruth: EVIDENCE }; star.deckLimits.sameName = 1;
  });
  const run = (kept) => {
    let card, chosen;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); chosen = hand(s, 0, kept); });
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: card });
    assert.equal(g.snapshot().pending.kind, 'select-cards');
    assert.deepEqual(restore(g, f).view(0), g.view(0));
    answer(g, [chosen]); settle(g);
    const s = g.snapshot();
    assert.deepEqual(restore(g, f).snapshot(), s);
    return { drawn: s.players[0].hand.length - (before - 2), s, chosen };
  };
  assert.equal(run('water').drawn, 4);
  assert.equal(run('potion').drawn, 2);
  const star = run('double');
  assert.equal(star.drawn, 4);
  assert(star.s.players[0].lost.includes(star.chosen), 'The ◇ card went to the Lost Zone, not the discard pile.');
  assert(star.s.events.some((e) => e.ruleId === 'effects.moved-cards' && e.data.met === true));
  // ローラースケーター Q&A: with only this card in hand, it cannot be played.
  let only;
  const g = board(f, (s) => { const p = s.players[0]; p.deck.push(...p.hand.splice(0)); only = hand(s, 0, 'research'); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === only));
});

test('「…如果该卡牌是能量的话，则追加造成90点伤害。然后，将放于弃牌区的能量附着于这只宝可梦身上」: after damage, that card only', async () => {
  const f = await attackWith([binding('cn.countedDeckTop@1', { side: 'own', count: 1 }, 'mill'),
    formula({ kind: 'choose', condition: { kind: 'compare', left: moved({ kind: 'energy' }), relation: 'gt', right: lit(0) }, ifTrue: lit(130), ifFalse: lit(40) }),
    binding('cn.thenMoved@1', takeBack, 'take')], (defs) => { const star = def(defs, 'double'); star.prismStar = { sourceOfTruth: EVIDENCE }; star.deckLimits.sameName = 1; });
  let top, old;
  const water = attack(f, (s) => { [old] = pile(s, 0, 'discard', ['water']); [top] = pile(s, 0, 'deck', ['water']); });
  assert.equal(water.damage, 130);
  const s = water.g.snapshot();
  assert(s.players[0].active.energy.includes(top) && s.players[0].discard.includes(old), 'Only the card this attack put there.');
  const damageAt = water.events.findIndex((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
  assert(water.events.findIndex((e) => e.ruleId === 'turn.energy' && e.data.cardId === top) > damageAt, 'Attached after the damage (セキタンザンVMAX Q&A).');
  const potion = attack(f, (s) => { pile(s, 0, 'discard', ['water']); [top] = pile(s, 0, 'deck', ['potion']); });
  assert.equal(potion.damage, 40);
  assert(!potion.events.some((e) => e.ruleId === 'turn.energy'), 'Not an Energy: nothing is attached, not even an older one.');
  // セキタンザンVMAX Q&A: a ◇ Energy adds the damage but went to the Lost Zone, so it is not attached.
  const star = attack(f, (s) => { [top] = pile(s, 0, 'deck', ['double']); });
  assert.equal(star.damage, 130);
  assert(star.g.snapshot().players[0].lost.includes(top) && !star.events.some((e) => e.ruleId === 'turn.energy'));
  const empty = attack(f, (s) => { const p = s.players[0]; for (const id of p.deck.splice(0)) p[s.cards[id].definitionId === 'double' ? 'lost' : 'discard'].push(id); });
  assert.equal(empty.damage, 40);
  assert(empty.events.some((e) => e.ruleId === 'effects.execution' && e.data.moved?.length === 0) && !empty.events.some((e) => e.ruleId === 'turn.energy'),
    'Nothing recorded: the next part does not run.');
});

test('「…追加造成其中宝可梦张数×60点伤害。然后，将任意数量的被放于弃牌区的【火】宝可梦，放于备战区」', async () => {
  const run = async (selector, pick) => {
    const f = await attackWith([binding('cn.countedCards@1', { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' },
      reveal: false, lookTop: 5, shuffleAfter: false }, 'mill'),
    formula({ kind: 'add', terms: [lit(10), { kind: 'multiply', left: lit(60), right: moved({ kind: 'pokemon' }) }] }),
    binding('cn.thenMoved@1', { counted: MILL, next: revive(selector), use: 'cards' }, 'revive')]);
    let top, old, offered;
    const r = attack(f, (s) => { [old] = pile(s, 0, 'discard', ['base']); top = pile(s, 0, 'deck', ['other', 'evolution', 'water', 'potion', 'other']); },
      (q) => q.data.action.to === 'bench' ? (offered = q.options, pick(q.options)) : q.options.slice(0, q.minimum));
    return { ...r, top, old, offered };
  };
  const all = await run(anyStage, (options) => options);
  assert.equal(all.damage, 190);
  assert.deepEqual([...all.offered].sort(), [all.top[0], all.top[1], all.top[4]].sort(), 'Only the Pokémon this attack discarded; an older one stays.');
  const s = all.g.snapshot();
  assert.deepEqual(s.players[0].bench.map((m) => m.stack[0]).sort(), [...all.offered].sort(), 'シャンデラ Q&A: an Evolution Pokémon too.');
  assert(s.players[0].discard.includes(all.old));
  const none = await run(anyStage, () => []);
  assert.equal(none.g.snapshot().players[0].bench.length, 0, '「任意数量」: none at all (シャンデラ Q&A).');
  const basic = await run({ kind: 'pokemon', types: ['Water'] }, (options) => options);
  assert.deepEqual([...basic.offered].sort(), [basic.top[0], basic.top[4]].sort(), 'II.C-11: without printed stages, Basic Pokémon only.');
});

test('a counted first part is this attack\'s own counted discard into its user\'s discard pile', async () => {
  const counted = (p) => binding('cn.countedCards@1', { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' },
    reveal: false, lookTop: 1, shuffleAfter: false, ...p }, 'mill');
  const take = binding('cn.thenMoved@1', takeBack, 'take');
  for (const effects of [[take], [counted({ from: 'discard', to: 'lost', lookTop: null }), take],
    [binding('cn.countedDeckTop@1', { side: 'both', count: 1 }, 'mill'), take], [binding('cn.discardDeckTop@1', { side: 'own', count: 1 }, 'mill'), take],
    [binding('cn.countedEnergyDiscard@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
      measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' }, 'mill'), take]]) {
    const f = await attackWith(effects);
    assert.throws(() => start(f), (e) => e.code === 'unsupported-effect-count', JSON.stringify(effects.map((b) => b.handlerId)));
  }
  const trainer = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [take]; });
  assert.throws(() => start(trainer), (e) => e.code === 'unsupported-effect-count');
  const copying = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', inspire, 'inspire')]; });
  assert.throws(() => start(copying), /Unimplemented or undeclared/, 'A copy is part of an attack.');
  const fine = await attackWith([counted({}), take]);
  assert.doesNotThrow(() => start(fine));
});

test('「将牌库上方1张卡牌放于弃牌区，如果那张卡牌是宝可梦（除「拥有规则的宝可梦」外）的话，则选择那只宝可梦所拥有的1个招式」', async () => {
  const f = await attackWith([binding('cn.thenMoved@1', inspire, 'inspire')], (defs) => {
    def(defs, 'evolution').mechanics.attacks.push({ attackId: 'evolution:fail', name: '测试失败', cost: ['Water'], printedDamage: { value: 90, operator: 'fixed' },
      effects: [], failureCheck: { predicate: { kind: 'not', condition: { kind: 'stadiumInPlay', owner: 'any' } }, sourceOfTruth: EVIDENCE }, sourceOfTruth: EVIDENCE });
    def(defs, 'evolution').mechanics.attacks.push({ attackId: 'evolution:stadium', name: '测试竞技场', cost: ['Water'], printedDamage: { value: 70, operator: 'fixed' },
      effects: [], condition: { predicate: { kind: 'stadiumInPlay', owner: 'any' } }, sourceOfTruth: EVIDENCE });
  });
  let top, old, offered;
  const pick = (id) => (q) => q.kind === 'copy-attack' ? (offered = q.options, [q.options.find((o) => JSON.parse(o)[1] === id)]) : q.options.slice(0, q.minimum);
  const other = attack(f, (s) => { [old] = pile(s, 0, 'discard', ['other']); [top] = pile(s, 0, 'deck', ['other']); }, pick('other:strike'));
  assert.deepEqual(offered, [JSON.stringify([top, 'other:strike'])], 'Only the card just discarded, not one already there.');
  assert.equal(other.damage, 20);
  assert(other.g.snapshot().players[0].discard.includes(old));
  offered = null;
  const energy = attack(f, (s) => { [top] = pile(s, 0, 'deck', ['water']); });
  assert.equal(offered, null);
  assert.equal(energy.damage, 0);
  // A copied attack that fails, or whose own use condition is unmet (ヤドキング Q&A), ends the attack; the discarded card stays discarded.
  for (const id of ['evolution:fail', 'evolution:stadium']) {
    const ended = attack(f, (s) => { [top] = pile(s, 0, 'deck', ['evolution']); }, pick(id));
    const s = ended.g.snapshot();
    assert.equal(ended.damage, 0, id);
    assert(s.players[0].discard.includes(top) && s.attack === null && s.current === 1, id);
  }
  assert(attack(f, (s) => { pile(s, 0, 'deck', ['evolution']); }, pick('evolution:stadium')).events
    .some((e) => e.ruleId === 'attack.copy' && e.data.kind === 'condition' && e.data.met === false));
  const met = attack(f, (s) => { const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id; pile(s, 0, 'deck', ['evolution']); },
    pick('evolution:stadium'));
  assert.equal(met.damage, 50, 'Its use condition met: it is used as this attack (70, −20 from the fixture Stadium).');
  // The pending copy choice survives a snapshot round trip.
  const g = board(f, (s) => { pile(s, 0, 'deck', ['other']); attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('「查看对手的手牌。若希望，将其中的1张宝可梦，放于弃牌区。在这种情况下，选择该宝可梦所拥有的1个招式（除GX招式外）」', async () => {
  const f = await attackWith([binding('cn.thenMoved@1', hypnosis, 'hypnosis')]);
  let theirs, offered;
  const take = attack(f, (s) => { [theirs] = pile(s, 1, 'hand', ['other']); pile(s, 1, 'discard', ['other']); },
    (q) => q.kind === 'select-cards' ? [theirs] : q.kind === 'copy-attack' ? (offered = q.options, [q.options[0]]) : q.options.slice(0, q.minimum));
  assert.deepEqual(offered, [JSON.stringify([theirs, 'other:strike'])]);
  assert.equal(take.damage, 20);
  assert(take.g.snapshot().players[1].discard.includes(theirs));
  offered = null;
  const decline = attack(f, (s) => { pile(s, 1, 'hand', ['other']); }, (q) => q.kind === 'select-cards' ? [] : q.options.slice(0, q.minimum));
  assert.equal(offered, null);
  assert.equal(decline.damage, 0);
  // Candidates: the moved cards of that player, even one a rule put into the Lost Zone (カラマネロ Q&A), never a GX attack.
  const definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  definitions.gx = { ...clone(definitions.other), definitionId: 'gx', mechanics: { ...clone(definitions.other.mechanics),
    attacks: [...clone(definitions.other.mechanics.attacks), { attackId: 'gx:big', specialRule: 'GX' }] } };
  const ctx = { source: { owner: 0, pokemonId: 'a' }, definitions, effectivePokemon: {}, state: {
    players: [{ active: null, bench: [], discard: [] }, { active: null, bench: [], discard: ['older'] }],
    cards: { lost: { definitionId: 'gx', owner: 1 }, mine: { definitionId: 'other', owner: 0 }, older: { definitionId: 'other', owner: 1 } } } };
  assert.deepEqual(copyCandidates(ctx, { ...hypnosis.next.parameters, among: ['lost', 'mine'] }), [{ instanceId: 'lost', attackId: 'other:strike' }]);
  assert.equal(copyCandidates(ctx, { ...hypnosis.next.parameters, among: ['lost'], excludeSpecialRules: undefined }).length, 2);
  // An unbound program pool is refused, never read as no restriction.
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  const bad = g.snapshot();
  bad.queue.unshift({ op: 'effect-choice', data: { action: { ...hypnosis.next.parameters, among: 'moved' }, frames: [], source: { owner: 0 } } });
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
});

test('「将自己的战斗宝可梦与备战宝可梦互换。然后，选择被换入备战区的宝可梦身上附着的任意数量的能量，转附于新的战斗宝可梦身上」', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', scramble, 'scramble')]; });
  let card, mine, incoming, unrelated, spare;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); mine = [attached(s, 0, s.players[0].active, 'water'), attached(s, 0, s.players[0].active, 'double')];
    incoming = bench(s, 0, 'other'); unrelated = bench(s, 0, 'base'); spare = attached(s, 0, unrelated, 'water');
  });
  const outgoing = g.snapshot().players[0].active.id;
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, [incoming.id]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'attached-energy');
  assert.deepEqual([...q.options].sort(), [...mine].sort(), 'Only the Energy of the Pokémon just switched to the Bench.');
  assert.deepEqual(g.view(0).pending.energy.map((e) => e.card.instanceId).sort(), [...mine].sort());
  assert.deepEqual(restore(g, f).view(0), g.view(0));
  answer(g, mine);
  assert.deepEqual(g.snapshot().pending.options, [incoming.id], 'To the new Active Pokémon.');
  settle(g, (q) => q.options.slice(0, Math.max(1, q.minimum)));
  const s = g.snapshot();
  assert.deepEqual([...s.players[0].active.energy].sort(), [...mine].sort());
  assert.equal(s.players[0].active.id, incoming.id);
  assert.equal(s.players[0].bench.find((m) => m.id === outgoing).energy.length, 0);
  assert.deepEqual(s.players[0].bench.find((m) => m.id === unrelated.id).energy, [spare]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  // 「…放于备战区。然后，将…能量转附于该宝可梦身上」: without a switch, the bound Pokémon is the recipient, not the holder.
  const g2 = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: cards({ from: 'discard', to: 'bench',
    selector: { kind: 'pokemon', types: ['Water'] }, quantity: { kind: 'exact', count: 1 } }), next: { handlerId: 'cn.attachedEnergy@1', parameters: {
    ...moveTo().parameters, quantity: { kind: 'exact', count: 1 }, recipient: { position: 'any', selector: { kind: 'pokemon' } } } }, use: 'pokemon' }, 'refuel')]; });
  const r = board(g2, (s) => { card = hand(s, 0, 'potion'); pile(s, 0, 'discard', ['other']); mine = [attached(s, 0, s.players[0].active, 'water')];
    unrelated = bench(s, 0, 'base'); });
  command(r, { type: 'playTrainer', cardId: card }); settle(r, (q) => q.kind === 'energy-destination' ? (incoming = q.options, q.options) : q.options.slice(0, Math.max(1, q.minimum)));
  const fresh = r.snapshot().players[0].bench.find((m) => m.id !== unrelated.id);
  assert.deepEqual(incoming, [fresh.id], 'Only the Pokémon just put onto the Bench receives it.');
  assert.deepEqual(fresh.energy, mine);
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); incoming = bench(s, 0, 'other'); });
  command(none, { type: 'playTrainer', cardId: card }); answer(none, [incoming.id]); answer(none, []);
  assert.equal(none.snapshot().pending, null, '「任意数量」: none moved.');
  assert.equal(none.snapshot().players[0].active.energy.length, 0);
});

test('「…放于备战区。如果追加附有1个能量的话，则给新出场的宝可梦身上，各附着2张弃牌区中的能量」', async () => {
  const f = await attackWith([binding('cn.thenMoved@1', union, 'union')]);
  const run = (energies, inDiscard, recipients) => {
    let fresh, offered = [];
    const g = board(f, (s) => {
      fresh = pile(s, 0, 'discard', ['other', 'other']); pile(s, 0, 'discard', inDiscard);
      for (let i = 0; i < energies; i++) attached(s, 0, s.players[0].active, 'water');
    });
    command(g, { type: 'attack', attackId: 'base:strike' });
    let turn = 0;
    settle(g, (q) => {
      if (q.kind === 'select-cards') return fresh;
      if (q.kind === 'discard-energy') { assert.equal(q.minimum, Math.min(4, inDiscard.length)); return q.options.slice(0, q.minimum); }
      if (q.kind === 'energy-recipient') {
        const mons = g.snapshot().players[0].bench.map((m) => m.id);
        offered.push(q.options.length);
        assert.deepEqual(restore(g, f).view(0), g.view(0));
        return [mons[recipients[turn++]]];
      }
      return q.options.slice(0, q.minimum);
    });
    const s = g.snapshot();
    assert.deepEqual(restore(g, f).snapshot(), s);
    return { s, offered, counts: s.players[0].bench.map((m) => m.energy.length) };
  };
  const full = run(2, ['water', 'water', 'double', 'water', 'water'], [0, 0, 1, 1]);
  assert.deepEqual(full.counts, [2, 2]);
  assert.deepEqual(full.offered, [2, 2, 1, 1], 'A Pokémon that already received 2 takes no more.');
  // ゲッコウガ&ゾロアークGX Q&A: with 2 Energy in the discard pile, 1 each or 2 on one.
  assert.deepEqual(run(2, ['water', 'double'], [0, 1]).counts, [1, 1]);
  assert.deepEqual(run(2, ['water', 'double'], [1, 1]).counts, [0, 2]);
  const plain = run(1, ['water', 'water'], []);
  assert.deepEqual(plain.counts, [0, 0], 'No extra Energy: benched, nothing attached.');
  assert(plain.s.events.some((e) => e.ruleId === 'effects.condition' && e.data.met === false));
});
