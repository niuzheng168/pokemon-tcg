// Synthetic definitions only. 「选择自己手牌中的1张宝可梦，将该宝可梦的名字告诉对手后，反面朝上放置。由对手回答该宝可梦的HP。将反面朝上的宝可梦
// 翻到正面，如果正确的话，则对手从牌库上方抽取4张卡牌。如果不正确的话，则自己从牌库上方抽取4张卡牌。然后，将放置的卡牌放回自己手牌中。」,
// 「选择自己手牌中的1张宝可梦，将该宝可梦所拥有的招式名字告知对手后，反面朝上放置。由对手回答该宝可梦的名字。…」 and the attack
// 「将自己手牌中的1张宝可梦，翻成反面放置。然后，由对手回答该宝可梦的属性。再将该卡牌翻成正面，如果正确的话，则对手从牌库上方抽取4张卡牌。
// 如果不正确的话，则自己从牌库上方抽取4张卡牌。并将被放置的卡牌放回手牌。」 (effects.guess). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { validateGameCommand } from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.guess@1').validateParameters(clone(p));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
};
const like = (base, id, name, mechanics = {}) => ({ ...clone(base), definitionId: id, name, nameKey: id,
  mechanics: { ...clone(base.mechanics), ...mechanics } });
const trainer = (base, id, parameters) => ({ ...clone(base), definitionId: id, name: `测试${id}`, nameKey: id,
  mechanics: { category: 'supporter', effects: [binding('cn.guess@1', parameters, id)] } });
const ADDED = ['tyme', 'quiz', 'quiet', 'dual', 'base-ex', 'vu1', 'fossil'];

async function guessFixture() {
  const f = await fixture((defs) => {
    const base = def(defs, 'base'), research = def(defs, 'research');
    const strike = base.mechanics.attacks[0];
    base.mechanics.attacks.push({ attackId: 'base:question', name: '测试提问', cost: [], printedDamage: null,
      effects: [binding('cn.guess@1', { question: 'type', count: 4 }, 'question')], sourceOfTruth: EVIDENCE });
    defs.push(trainer(research, 'tyme', { hint: 'name', question: 'hp', count: 4 }),
      trainer(research, 'quiz', { hint: 'attackNames', question: 'name', count: 4 }),
      like(base, 'quiet', '测试无招式宝可梦', { attacks: [] }),
      like(base, 'dual', '测试双属性宝可梦', { hp: 70, types: ['Water', 'Fire'], attacks: [
        { ...strike, attackId: 'dual:splash', name: '测试水枪' }, { ...strike, attackId: 'dual:spark', name: '测试火花' }] }),
      like(base, 'base-ex', '测试宝可梦base ex', { hp: 200, attacks: [{ ...strike, attackId: 'base-ex:strike' }] }),
      like(base, 'vu1', '测试V-UNION', { stage: 'V-UNION', hp: 310, ruleBox: true, prizeCount: 3, tags: ['V', 'V-UNION'],
        attacks: [{ ...strike, attackId: 'vu1:strike' }], vUnion: { piece: 1, sourceOfTruth: EVIDENCE } }),
      like(base, 'fossil', '测试化石', { hp: 60, types: ['Colorless'], weakness: null, retreatCost: 0, attacks: [],
        itemCard: { leave: { from: 'field', to: 'discard' }, sourceOfTruth: EVIDENCE } }));
  });
  f.deck.splice(20, ADDED.length, ...ADDED.map((id) => `printing:${id}`));
  return f;
}
// Player 0's hand is exactly these cards (the rest go to the bottom of the deck).
const table = (f, ids, mutate = () => {}) => {
  const cards = {};
  const g = board(f, (s) => {
    const p = s.players[0];
    p.deck.unshift(...p.hand.splice(0));
    for (const id of ids) cards[id] = hand(s, 0, id);
    mutate(s);
  });
  return { g, cards };
};
const guessAnswer = (g, value, player = g.snapshot().pending.player, requestId = g.snapshot().pending.id) =>
  g.dispatch({ player, expectedRevision: g.snapshot().revision, action: { type: 'guessAnswer', requestId, answer: value } });
const guesses = (view, kind) => view.events.filter((e) => e.ruleId === 'effects.guess' && e.data.kind === kind).map((e) => e.data);
const handSize = (g, player) => g.snapshot().players[player].hand.length;
// The cards each player drew between the reveal and the card going back.
const drawnByGuess = (g) => {
  const events = g.snapshot().events, from = events.findLastIndex((e) => e.ruleId === 'effects.guess' && e.data.kind === 'revealed');
  const to = events.findLastIndex((e) => e.ruleId === 'effects.guess' && e.data.kind === 'returned');
  assert(from >= 0 && to > from);
  return [0, 1].map((player) => events.slice(from, to).filter((e) => e.ruleId === 'effects.draw' && e.data.player === player)
    .reduce((n, e) => n + e.data.count, 0));
};

test('schemas and rule: hint, question and count; the answer command takes a value of the whole domain', () => {
  assert(requireRule(CN_V20261019, 'effects.guess').sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'));
  for (const p of [{ hint: 'name', question: 'hp', count: 4 }, { hint: 'attackNames', question: 'name', count: 4 }, { question: 'type', count: 4 },
    { hint: 'attackNames', question: 'hp', count: 1 }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ hint: 'name', question: 'name', count: 4 }, { question: 'type' }, { question: 'type', count: 0 }, { question: 'stage', count: 4 },
    { hint: 'type', question: 'hp', count: 4 }, { question: 'type', count: 4, extra: true }]) assert(!valid(p), JSON.stringify(p));
  const cmd = (answer) => validateGameCommand({ player: 1, expectedRevision: 0, action: { type: 'guessAnswer', requestId: 'q1', answer } });
  for (const a of [{ hp: 10 }, { hp: 340 }, { name: 'pikachu-ex' }, { type: 'Dragon' }]) assert(cmd(a), JSON.stringify(a));
  for (const a of [{ hp: 0 }, { hp: 15 }, { hp: '120' }, { name: '皮卡丘' }, { type: 'Fighting', hp: 10 }, { type: 'Light' }, {}])
    assert(!cmd(a), JSON.stringify(a));
});

test('「将该宝可梦的名字告诉对手后，反面朝上放置。由对手回答该宝可梦的HP」: the opponent sees the name, never the card; right → the opponent draws', async () => {
  const f = await guessFixture();
  const { g, cards } = table(f, ['tyme', 'dual', 'vu1', 'fossil', 'water', 'base']);
  const before = [handSize(g, 0), handSize(g, 1)];
  command(g, { type: 'playTrainer', cardId: cards.tyme });
  let q = g.snapshot().pending;
  // A V-UNION card out of play has no HP to read; an Item played as a Pokémon is an Item in the hand.
  assert.equal(q.kind, 'guess-card'); assert.equal(q.player, 0);
  assert.deepEqual([...q.options].sort(), [cards.dual, cards.base].sort());
  assert.deepEqual([q.minimum, q.maximum, q.allowZero], [0, 1, true]);
  assert.deepEqual(g.view(0).pending.guess, { question: 'hp', tell: 'name' });
  restore(g, f); answer(g, [cards.dual]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'guess-answer'); assert.equal(q.player, 1);
  assert(g.snapshot().players[0].resolving.includes(cards.dual) && !g.snapshot().players[0].hand.includes(cards.dual));
  const asked = g.view(1);
  assert.deepEqual(asked.pending.guess, { question: 'hp', tell: 'name', hint: { name: '测试双属性宝可梦', nameKey: 'dual' } });
  assert.deepEqual([asked.pending.options, asked.pending.minimum, asked.pending.maximum], [[], 0, 0]);
  assert.equal(asked.players[0].hand.count, before[0] - 2);
  assert(!JSON.stringify(asked).includes(`"${cards.dual}"`), 'The face-down card is never in the opponent\'s view.');
  assert.deepEqual(guesses(asked, 'told'), [{ kind: 'told', effectId: 'fixture:tyme', player: 0, question: 'hp',
    hint: { name: '测试双属性宝可梦', nameKey: 'dual' } }]);
  assert.deepEqual(guesses(asked, 'setAside'), []);
  assert.equal(guesses(g.view(0), 'setAside')[0].card.instanceId, cards.dual, 'Its owner knows which card it is.');
  assert.equal(g.view(0).pending, null);
  const r = restore(g, f);
  // Only the asked opponent answers, with a value of the asked kind.
  assert.throws(() => answer(r, []), (e) => e.code === 'wrong-choice');
  assert.throws(() => guessAnswer(r, { hp: 70 }, 0), (e) => e.code === 'wrong-choice');
  assert.throws(() => guessAnswer(r, { hp: 70 }, 1, 'q-other'), (e) => e.code === 'wrong-choice');
  assert.throws(() => guessAnswer(r, { type: 'Water' }), (e) => e.code === 'invalid-choice');
  guessAnswer(g, { hp: 70 });
  assert.equal(g.snapshot().pending, null);
  const s = g.snapshot();
  assert.equal(handSize(g, 1), before[1] + 4, 'Right: the opponent draws 4.');
  assert.equal(handSize(g, 0), before[0] - 1, 'The user draws nothing; the card is back in the hand.');
  assert(s.players[0].hand.includes(cards.dual) && !s.players[0].resolving.length);
  assert(s.players[0].discard.includes(cards.tyme));
  for (const viewer of [0, 1]) {
    const shown = guesses(g.view(viewer), 'revealed')[0];
    assert.deepEqual([shown.answer, shown.correct, shown.card.instanceId, shown.card.definitionId], [{ hp: 70 }, true, cards.dual, 'dual']);
  }
  // The draw comes before the card goes back.
  assert.deepEqual(drawnByGuess(g), [0, 4]);
});

test('wrong → the user draws; choosing none (a hand choice of a printed kind) ends it with nothing', async () => {
  const f = await guessFixture();
  let { g, cards } = table(f, ['tyme', 'base', 'potion']);
  let before = [handSize(g, 0), handSize(g, 1)];
  command(g, { type: 'playTrainer', cardId: cards.tyme });
  answer(g, [cards.base]);
  guessAnswer(g, { hp: 110 });
  assert.equal(handSize(g, 0), before[0] - 1 + 4, 'Wrong: the user draws 4 and the card is back.');
  assert.equal(handSize(g, 1), before[1]);
  assert.deepEqual(guesses(g.view(1), 'revealed').map((e) => e.correct), [false]);
  ({ g, cards } = table(f, ['tyme', 'base', 'potion']));
  before = [handSize(g, 0), handSize(g, 1)];
  command(g, { type: 'playTrainer', cardId: cards.tyme });
  answer(g, []);
  assert.equal(g.snapshot().pending, null);
  assert.deepEqual([handSize(g, 0), handSize(g, 1)], [before[0] - 1, before[1]]);
  assert.deepEqual(guesses(g.view(1), 'told'), []);
  assert(g.snapshot().players[0].hand.includes(cards.base));
  // Only the asked opponent's answer resumes a guess; no guess is waiting now.
  assert.throws(() => guessAnswer(g, { hp: 10 }, 0, 'q1'), (e) => e.code === 'illegal-action');
});

test('「将该宝可梦所拥有的招式名字告知对手…由对手回答该宝可梦的名字」: every attack name is told; only the exact card name is right', async () => {
  const f = await guessFixture();
  const play = (pick, name) => {
    const { g, cards } = table(f, ['quiz', 'quiet', 'vu1', 'dual', 'base-ex']);
    const before = [handSize(g, 0), handSize(g, 1)];
    command(g, { type: 'playTrainer', cardId: cards.quiz });
    // No attack name to tell: a Pokémon without attacks, or a V-UNION card out of play (JP Q&A カツラのクイズショー).
    assert.deepEqual([...g.snapshot().pending.options].sort(), [cards.dual, cards['base-ex']].sort());
    answer(g, [cards[pick]]);
    const hint = g.view(1).pending.guess;
    guessAnswer(g, { name });
    return { g, hint, drawn: [handSize(g, 0) - before[0] + 1, handSize(g, 1) - before[1]] };
  };
  let { g, hint, drawn } = play('dual', 'dual');
  assert.deepEqual(hint, { question: 'name', tell: 'attackNames', hint: { attackNames: ['测试水枪', '测试火花'] } });
  assert.deepEqual(drawn, [0, 4]);
  ({ hint, drawn } = play('base-ex', 'base'));
  assert.deepEqual(hint.hint, { attackNames: ['测试撞击'] });
  assert.deepEqual(drawn, [4, 0], '「X」 is not the name of 「X ex」.');
  // Not playable without such a Pokémon in the hand.
  ({ g } = table(f, ['quiz', 'quiet', 'vu1', 'fossil']));
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer'));
});

test('「由对手回答该宝可梦的属性」 as an attack: no hint; either type of a dual type is right; a V-UNION card can be chosen', async () => {
  const f = await guessFixture();
  const attack = (ids, pick, type) => {
    const { g, cards } = table(f, ids);
    const before = [handSize(g, 0), handSize(g, 1)];
    command(g, { type: 'attack', attackId: 'base:question' });
    if (pick === undefined) return { g, drawn: [handSize(g, 0) - before[0], handSize(g, 1) - before[1] - 1] };
    assert.deepEqual(g.view(0).pending.guess, { question: 'type' });
    answer(g, [cards[pick]]);
    assert.deepEqual(g.view(1).pending.guess, { question: 'type' });
    restore(g, f);
    guessAnswer(g, { type });
    settle(g);
    assert(g.snapshot().players[0].hand.includes(cards[pick]));
    return { g, drawn: drawnByGuess(g) };
  };
  assert.deepEqual(attack(['dual'], 'dual', 'Fire').drawn, [0, 4]);
  assert.deepEqual(attack(['dual'], 'dual', 'Water').drawn, [0, 4]);
  assert.deepEqual(attack(['dual'], 'dual', 'Grass').drawn, [4, 0]);
  // JP Q&A ヤレユータン「けんじゃのといかけ」: a V-UNION card's type can be answered.
  assert.deepEqual(attack(['vu1', 'fossil'], 'vu1', 'Water').drawn, [0, 4]);
  // No Pokémon in the hand: the attack is still used and nothing happens.
  const { g, drawn } = attack(['fossil', 'water'], undefined);
  assert.deepEqual(drawn, [0, 0]);
  assert.equal(g.snapshot().pending, null);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.partial' && e.data.operation === 'guess' && e.data.performed === false));
});

test('a Supporter guess needs a card in either deck; an empty deck draws nothing', async () => {
  const f = await guessFixture();
  const empty = (s, players) => { for (const i of players) s.players[i].discard.push(...s.players[i].deck.splice(0)); };
  let { g } = table(f, ['tyme', 'base'], (s) => empty(s, [0, 1]));
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer'));
  let cards;
  ({ g, cards } = table(f, ['tyme', 'base'], (s) => empty(s, [0])));
  const before = handSize(g, 0);
  command(g, { type: 'playTrainer', cardId: cards.tyme });
  answer(g, [cards.base]);
  guessAnswer(g, { hp: 10 });
  assert.equal(handSize(g, 0), before - 1, 'Wrong, but the user\'s deck is empty: nothing drawn, the card back.');
  assert(g.snapshot().players[0].hand.includes(cards.base));
});

test('restore keeps the face-down card set aside and the answer unasked', async () => {
  const f = await guessFixture();
  const { g, cards } = table(f, ['tyme', 'base']);
  command(g, { type: 'playTrainer', cardId: cards.tyme });
  answer(g, [cards.base]);
  let bad = g.snapshot();
  bad.players[0].resolving.splice(bad.players[0].resolving.indexOf(cards.base), 1); bad.players[0].hand.push(cards.base);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-guess');
  bad = g.snapshot(); bad.pending.data.guess.answer = { hp: 100 };
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-guess');
  bad = g.snapshot(); bad.queue.push({ op: 'effect-choice', data: clone(bad.pending.data) }); bad.pending = null;
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-guess');
  bad = g.snapshot(); bad.pending.kind = 'select-cards';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-guess');
});
