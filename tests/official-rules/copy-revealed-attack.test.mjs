// Synthetic definitions only. 「将对手牌库上方10张卡牌翻到正面。若希望，可以选择其中的宝可梦所拥有的1个招式，作为这个招式使用。将翻到正面的卡牌
// 放回牌库并重洗牌库。」 (attack.copy-revealed: all of a smaller deck is turned face up; the cards go back and the deck is shuffled before the
// chosen attack is used, which may be this same attack again — JP Q&A ロケット団のペルシアンex「こうまんしれい」; no Energy needed, II.C-18).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { copyCandidates } from '../../public/rules/attack-copy.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { fixture, binding, EVIDENCE, board, command, settle, answer, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const DECK = { side: 'opponent', zone: 'deck', lookTop: 10, selector: { kind: 'pokemon' } };
// (an `undefined` in `extra` drops that parameter)
const haughty = (extra = {}) => clone({ op: 'copyAttack', origins: [DECK], excludeUser: false, coin: 'none', energy: 'ignore', optional: true,
  special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE }, ...extra });
const attack = (attackId, damage, extra = {}) => ({ attackId, name: `测试${attackId}`, cost: ['Water'],
  printedDamage: damage === null ? null : { value: damage, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE, ...extra });
async function make() {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    def(defs, 'base').mechanics.attacks.push(attack('base:haughty', null, { cost: ['Colorless', 'Colorless'],
      effects: [binding('cn.copyAttack@1', haughty(), 'haughty')] }),
    // The same instruction over the user's own deck top 2, without 「若希望」.
    attack('base:own', null, { cost: ['Colorless'], effects: [binding('cn.copyAttack@1',
      haughty({ origins: [{ ...DECK, side: 'own', lookTop: 2 }], optional: undefined }), 'own')] }));
    def(defs, 'other').mechanics.attacks.push(attack('other:gx', 100, { specialRule: 'GX' }),
      attack('other:big', 60, { cost: ['Water', 'Water', 'Water'] }),
      // 「这个招式，只有在这只宝可梦身上放置有伤害指示物时才可使用」
      attack('other:hurt', 30, { condition: { predicate: { kind: 'pokemonIs', who: 'self', state: { damaged: true } } } }));
  });
}
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
// Puts these cards of `owner` on top of that player's deck, the first given uppermost.
function stackTop(s, owner, ids) {
  for (const id of [...ids].reverse()) { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].deck.push(card); }
}
const WATERS = (n) => Array(n).fill('water');
// Player 0's Active 「测试宝可梦base」 has two Water Energy; player 1's deck has `top` uppermost.
function setup(f, top, mutate = () => {}) {
  return board(f, (s) => {
    for (let i = 0; i < 2; i++) attached(s, 0, s.players[0].active, 'water');
    stackTop(s, 1, top);
    mutate(s);
  });
}
const offered = (g) => g.snapshot().pending?.kind === 'copy-attack' ? g.view(0).pending.attacks.map((a) => a.attackId) : null;
const choose = (g, attackId) => answer(g, [g.view(0).pending.attacks.find((a) => a.attackId === attackId).optionId]);
const after = (g, from, ruleId) => g.snapshot().events.slice(from).filter((e) => e.ruleId === ruleId);
const dealt = (g, from) => after(g, from, 'attack.order').filter((e) => Object.hasOwn(e.data, 'damage')).reduce((n, e) => n + e.data.damage, 0);
const indexOf = (g, from, test) => g.snapshot().events.slice(from).findIndex(test);
const use = (g, attackId = 'base:haughty') => { const from = g.snapshot().events.length; command(g, { type: 'attack', attackId }); return from; };

test('schema and rule: a deck origin with lookTop, alone, never in a permission; 「若希望」 only there', () => {
  const rule = requireRule(CN_V20261019, 'attack.copy-revealed');
  assert(rule.sourceOfTruth.some((s) => s.section.includes('II.C-18')));
  assert.equal(rule.sourceOfTruth.filter((s) => s.documentId === 'JP-official-qa').length, 2);
  const valid = (p) => handlers.get('cn.copyAttack@1').validateParameters(clone(p));
  assert(valid(haughty()));
  assert(valid(haughty({ optional: undefined, origins: [{ ...DECK, side: 'own' }] })));
  for (const bad of [haughty({ origins: [{ ...DECK, lookTop: undefined }] }), haughty({ origins: [{ ...DECK, side: 'either' }] }),
    haughty({ origins: [{ ...DECK, subject: 'user' }] }), haughty({ origins: [{ ...DECK, lookTop: 0 }] }),
    haughty({ origins: [DECK, { side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }] }), haughty({ chooser: 'opponent' }),
    haughty({ optional: undefined, origins: [{ side: 'opponent', zone: 'active', lookTop: 10, selector: { kind: 'pokemon' } }] }),
    haughty({ origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }] }), haughty({ optional: false })])
    assert(!valid(bad), JSON.stringify(bad));
  assert(!handlers.get('cn.attackGrant@1').validateParameters({ op: 'attackGrant', scope: 'self', targetSelector: { kind: 'pokemon' },
    origins: [DECK], excludeUser: false }), 'A permission is over attacks owned now.');
});

test('「将对手牌库上方10张卡牌翻到正面。若希望，可以选择…」: both see them; they stay on top until the choice; no Energy needed', async () => {
  const f = await make();
  const g = setup(f, ['water', 'other', 'water', 'evolution', ...WATERS(6), 'base']);
  const deck = g.snapshot().players[1].deck, top = deck.slice(-10).reverse();
  const from = use(g);
  const [shown] = after(g, from, 'effects.reveal');
  assert.equal(shown.visibility, 'public');
  assert.deepEqual(shown.data.cardIds, top, 'The top 10, the top first; the 11th card is not shown.');
  assert.deepEqual(offered(g), ['other:strike', 'other:gx', 'other:big', 'other:hurt', 'evolution:strike']);
  const q = g.view(0).pending;
  assert.equal(q.minimum, 0); assert.equal(q.allowZero, true);
  assert.deepEqual(q.lookedAt.map((c) => c.instanceId), top, 'Every face-up card, not only the Pokémon offered.');
  assert.deepEqual(g.snapshot().players[1].deck, deck, 'Nothing has moved yet.');
  const r = restore(g, f);
  choose(r, 'other:big');
  // The cards go back and the deck is shuffled first; then 「测试other:big」 (three Water, the user has two) is used as this attack.
  assert.deepEqual(after(r, from, 'effects.reveal')[1].data.moved, top.map((cardId) => ({ cardId, to: 'deck' })));
  settle(r);
  const shuffled = indexOf(r, from, (e) => e.ruleId === 'effects.shuffle' && e.data.player === 1);
  const hit = indexOf(r, from, (e) => e.ruleId === 'attack.order' && e.data.damage > 0);
  assert(shuffled >= 0 && shuffled < hit);
  assert.equal(dealt(r, from), 60);
  // A face-up card cannot be changed, nor the deck under it, while the choice waits.
  for (const mutate of [(s) => { s.players[1].deck.push(s.players[1].deck.shift()); },
    (s) => { s.pending.data.copyChoice.revealed.reverse(); }, (s) => { delete s.pending.data.copyChoice.revealed; }]) {
    const s = g.snapshot(); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === 'invalid-copy-choice');
  }
});

test('「若希望」: choosing none still puts them back and shuffles; no Pokémon among them, no choice', async () => {
  const f = await make();
  const none = setup(f, ['other', ...WATERS(9)]), from = use(none);
  answer(none, []);
  assert.equal(after(none, from, 'effects.shuffle').length, 1);
  assert.equal(dealt(none, from), 0);
  assert.equal(none.snapshot().current, 1, 'The attack is over.');
  const waters = setup(f, WATERS(10)), next = use(waters);
  assert.equal(offered(waters), null);
  assert.deepEqual(after(waters, next, 'effects.reveal').map((e) => e.data.cardIds?.length ?? e.data.moved.length), [10, 10]);
  assert.equal(after(waters, next, 'effects.shuffle').length, 1);
  assert.equal(waters.snapshot().current, 1);
});

test('JP Q&A: a deck of 9 or fewer is turned face up as it is; an empty deck shows nothing', async () => {
  const f = await make();
  const short = setup(f, ['water', 'other', 'water'], (s) => { const p = s.players[1]; p.discard.push(...p.deck.splice(0, p.deck.length - 3)); });
  const from = use(short);
  assert.equal(after(short, from, 'effects.reveal')[0].data.cardIds.length, 3);
  assert.deepEqual(offered(short), ['other:strike', 'other:gx', 'other:big', 'other:hurt']);
  choose(short, 'other:strike'); settle(short);
  assert.equal(dealt(short, from), 20);
  const empty = setup(f, [], (s) => { const p = s.players[1]; p.discard.push(...p.deck.splice(0)); });
  const next = use(empty);
  assert.equal(offered(empty), null);
  assert.deepEqual(after(empty, next, 'effects.reveal'), []);
  assert.deepEqual(after(empty, next, 'effects.shuffle'), []);
});

test('JP Q&A: 「こうまんしれい」 among them is used again after they are shuffled back', async () => {
  const f = await make();
  // Player 1's deck is just these two cards: both are turned face up each time.
  const g = setup(f, ['base', 'other'], (s) => { const p = s.players[1]; p.discard.push(...p.deck.splice(0, p.deck.length - 2)); });
  const from = use(g);
  choose(g, 'base:haughty');
  const shown = (e) => e.ruleId === 'effects.reveal' && !!e.data.cardIds;
  assert.equal(after(g, from, 'effects.reveal').filter((e) => e.data.cardIds).length, 2, 'Turned face up a second time, as this attack.');
  const shuffled = indexOf(g, from, (e) => e.ruleId === 'effects.shuffle' && e.data.player === 1);
  assert(shuffled > indexOf(g, from, shown) && shuffled < g.snapshot().events.slice(from).findLastIndex(shown));
  assert.equal(after(g, from, 'attack.copy').find((e) => e.data.kind === 'selected').data.reference.attackId, 'base:haughty');
  assert.equal(g.snapshot().attack.copies.length, 1, 'The second choice is made inside the copied 「こうまんしれい」.');
  const r = restore(g, f);
  choose(r, 'other:strike'); settle(r);
  assert.equal(dealt(r, from), 20);
  assert.equal(after(r, from, 'effects.shuffle').length, 2);
  assert.equal(r.snapshot().current, 1);
});

test('a GX attack among them is the user\'s GX use; a used-up GX attack is not offered', async () => {
  const f = await make();
  const g = setup(f, ['other', ...WATERS(9)]), from = use(g);
  choose(g, 'other:gx'); settle(g);
  assert.equal(dealt(g, from), 100);
  assert.equal(g.snapshot().players[0].gxUsed, true);
  const spent = setup(f, ['other', ...WATERS(9)], (s) => { s.players[0].gxUsed = true; });
  use(spent);
  assert.deepEqual(offered(spent), ['other:strike', 'other:big', 'other:hurt']);
});

test('a chosen attack\'s own use condition is judged when used, after the shuffle; unmet, the attack ends (attack.copy)', async () => {
  const f = await make();
  const unmet = setup(f, ['other', ...WATERS(9)]), from = use(unmet);
  choose(unmet, 'other:hurt');
  assert.equal(after(unmet, from, 'effects.shuffle').length, 1);
  assert(after(unmet, from, 'attack.copy').some((e) => e.data.kind === 'condition' && e.data.met === false));
  settle(unmet);
  assert.equal(dealt(unmet, from), 0);
  const met = setup(f, ['other', ...WATERS(9)], (s) => { s.players[0].active.counters = 2; }), next = use(met);
  choose(met, 'other:hurt'); settle(met);
  assert.equal(dealt(met, next), 30);
});

test('the user\'s own deck top, without 「若希望」: a choice must be made', async () => {
  const f = await make();
  const g = setup(f, [], (s) => stackTop(s, 0, ['water', 'other'])), from = use(g, 'base:own');
  assert.equal(after(g, from, 'effects.reveal')[0].data.player, 0);
  assert.deepEqual(offered(g), ['other:strike', 'other:gx', 'other:big', 'other:hurt']);
  assert.equal(g.snapshot().pending.minimum, 1);
  choose(g, 'other:strike'); settle(g);
  assert.equal(after(g, from, 'effects.shuffle')[0].data.player, 0);
  assert.equal(dealt(g, from), 20);
  // The pure candidate list reads only the cards given as face up.
  const s = g.snapshot(), ctx = { source: { owner: 0, pokemonId: s.players[0].active.id }, definitions: f.catalog.definitionRecord(), state: s };
  const other = s.players[0].deck.find((id) => s.cards[id].definitionId === 'other');
  assert.deepEqual(copyCandidates(ctx, haughty({ origins: [{ ...DECK, side: 'own' }] }), [other]).map((r) => r.attackId),
    ['other:strike', 'other:gx', 'other:big', 'other:hurt']);
  assert.deepEqual(copyCandidates(ctx, haughty({ origins: [{ ...DECK, side: 'own' }] }), []), []);
});
