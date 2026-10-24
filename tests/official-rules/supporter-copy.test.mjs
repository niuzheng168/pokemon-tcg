// Synthetic definitions only. 「查看对手的手牌。若希望，可选择其中1张支援者，将该支援者的效果，作为这张卡牌的效果使用。」 (a Supporter, and an
// attack printed with 「这张卡牌」), 「查看对手的手牌。若希望，可选择其中1张支援者，将该支援者的效果，作为这个招式的效果使用。」,
// 「查看对手的手牌。若希望，将其中的1张支援者，放于弃牌区。在这种情况下，将该支援者的效果，作为这个招式的效果使用。」,
// 「将自己手牌中的1张支援者放于弃牌区。然后，将该支援者的效果，作为这个招式的效果使用。」 and
// 「选择对手弃牌区中的1张支援者，将该支援者的效果，作为这个招式的效果使用。」 (effects.copy-supporter; JP official Q&A ナツメの暗示,
// ミミッキュ「なりすます」, ニンフィア「めくばせ」, バリヤード「そっくりショー」, ドーブル「そっくりなぞる」, ヤレユータン「さるしばい」); and
// 「只要这只宝可梦在战斗场上，对手手牌里的支援者的效果，都会变为「从自己的牌库上方抽取3张卡牌。」。」 (effects.supporter-replacement; JP
// official Q&A ダーテング「てんぐのかえだま」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { SUPPORTER_COPY_RULE_IDS, readsOwnHand } from '../../public/rules/supporter-copy.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const valid = createCoreHandlers().get('cn.copySupporter@1').validateParameters;
const cost = (count) => ({ costId: 'pay', kind: 'discardHand', count, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE });
const handCount = (relation, value) => ({ kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' }, relation, right: { kind: 'literal', value } });
const FORMS = {
  mime: { from: 'opponentHand', discard: false }, sylveon: { from: 'opponentHand', discard: true },
  mimikyu: { from: 'ownHand', discard: true }, oranguru: { from: 'opponentDiscard', discard: false },
};
const SUPPORTERS = {
  suggestion: { effects: [binding('cn.copySupporter@1', FORMS.mime, 'suggestion')] },
  'suggestion-end': { effects: [binding('cn.copySupporter@1', FORMS.mime, 'suggestion-end')], endsTurn: true },
  draw3: { effects: [binding('cn.draw@1', { count: 3 }, 'draw3')] },
  ender: { effects: [binding('cn.draw@1', { count: 1 }, 'ender')], endsTurn: true },
  gust: { effects: [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'gust')] },
  revenge: { effects: [binding('cn.draw@1', { count: 2 }, 'revenge')],
    condition: { predicate: { kind: 'historyFact', fact: 'previousOpponentKnockout', cause: 'any' } } },
  last: { effects: [binding('cn.draw@1', { count: 4 }, 'last')], condition: { predicate: handCount('eq', 1) } },
  strip: { effects: [binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'opponent', from: 'any', selector: { kind: 'energy' },
    providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }, 'strip')], playCosts: [cost(2)] },
  paired: { effects: [binding('cn.draw@1', { count: 1 }, 'paired'), binding('cn.ifPaid@1', { effect: leaf('cn.draw@1', { count: 2 }) }, 'paired-paid')],
    optionalPlayCosts: [cost(1)] },
  boomerang: { effects: [binding('cn.then@1', { first: leaf('cn.draw@1', { count: 1 }), next: leaf('cn.returnSelf@1', {}) }, 'boomerang')] },
  exchange: { effects: [binding('cn.prizeExchange@1', { op: 'exchangePrizes', selector: { kind: 'any' }, revealSelected: false }, 'exchange')] },
  recover: { effects: [binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'trainer', categories: ['supporter'] },
    quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }, 'recover')] },
  plan: { effects: [binding('cn.turnEndEffect@1', { effect: leaf('cn.drawUntil@1', { count: 8 }) }, 'plan')] },
  hex: { effects: [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }, 'hex')] },
};
const attack = (key, effects, cost = []) => ({ attackId: `base:${key}`, name: `测试复制${key}`, cost, printedDamage: null, effects, sourceOfTruth: EVIDENCE });
const ability = (id, effects) => ({ abilityId: id, name: `测试${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE });
async function copyFixture(transform = () => {}, extra = {}) {
  const f = await fixture((defs) => {
    const research = defs.find((d) => d.definitionId === 'research');
    for (const [id, mechanics] of Object.entries({ ...SUPPORTERS, ...extra }))
      defs.push({ ...clone(research), definitionId: id, name: `测试${id}`, nameKey: id, mechanics: { category: 'supporter', ...clone(mechanics) } });
    defs[0].mechanics.attacks.push(...Object.entries(FORMS).map(([key, form]) => attack(key, [binding('cn.copySupporter@1', form, key)])));
    // 「选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用」 copying the opponent's own copy attack.
    defs[0].mechanics.attacks.push(attack('mew', [binding('cn.copyAttack@1', { op: 'copyAttack',
      origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }], excludeUser: false, coin: 'none', energy: 'ignore',
      attackIds: ['other:mime'], special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }, 'mew')]));
    defs[1].mechanics.attacks.push({ ...attack('mime', [binding('cn.copySupporter@1', FORMS.mime, 'other-mime')]), attackId: 'other:mime' });
    transform(defs);
  });
  const deck = [...f.deck.filter((id) => id !== 'printing:water'), ...Object.keys({ ...SUPPORTERS, ...extra }).flatMap((id) => [`printing:${id}`, `printing:${id}`])];
  while (deck.length < 60) deck.push('printing:water');
  return { ...f, deck };
}
const setHand = (s, owner, ids) => {
  const p = s.players[owner]; p.deck.push(...p.hand.splice(0));
  return ids.map((id) => hand(s, owner, id));
};
const into = (s, owner, zone, ids) => ids.map((id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card; });
const opponentActive = (s, id) => {
  const p = s.players[1], m = bench(s, 1, id); p.bench.pop(); p.bench.push(p.active); p.active = m; return m;
};
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const play = (g, card) => command(g, { type: 'playTrainer', cardId: card });
const use = (g, key) => command(g, { type: 'attack', attackId: `base:${key}` });
const logs = (s, ruleId, kind) => s.events.filter((e) => e.ruleId === ruleId && (!kind || e.data.kind === kind));
const turnEnds = (s, player) => logs(s, 'turn.end').filter((e) => e.data.player === player).length;

test('effects.copy-supporter: the printed forms, a strict descriptor and its placements', async () => {
  for (const id of SUPPORTER_COPY_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  for (const form of Object.values(FORMS)) assert(valid(form));
  for (const bad of [{ from: 'ownHand', discard: false }, { from: 'opponentDiscard', discard: true }, { from: 'deck', discard: false },
    { from: 'opponentHand' }, { ...FORMS.mime, op: 'copySupporter' }, { ...FORMS.mime, optional: true }]) assert(!valid(bad));
  // Only an attack, or a Trainer that looks at the opponent's hand, copies.
  for (const transform of [
    (defs) => { defs[0].mechanics.abilities = [ability('copy', [binding('cn.copySupporter@1', FORMS.mime)])]; },
    (defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.copySupporter@1', FORMS.mimikyu)]; },
  ]) {
    const f = await fixture(transform);
    assert.throws(() => board(f), /Unimplemented or undeclared/);
  }
  // A use condition read from the user's own hand counts the card itself there.
  assert(readsOwnHand({ kind: 'all', conditions: [{ kind: 'stadiumInPlay', owner: 'any' }, handCount('gte', 2)] }));
  assert(!readsOwnHand({ kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'discard' }, relation: 'gte', right: { kind: 'literal', value: 2 } }));
  assert(!readsOwnHand({ kind: 'compare', left: { kind: 'zoneCount', side: 'opponent', zone: 'hand' }, relation: 'eq', right: { kind: 'literal', value: 1 } }));
  assert(!readsOwnHand(undefined));
});

test('「查看对手的手牌。若希望，可选择其中1张支援者…作为这张卡牌的效果使用」: a look, an optional choice, the effect is this Trainer\'s', async () => {
  const f = await copyFixture();
  let card, target, gust;
  // No opponent's hand: nothing to look at, so the card cannot be used (JP Q&A ナツメの暗示).
  assert(!playable(board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); setHand(s, 1, []); }), card));
  // A hand without a Supporter is still looked at.
  const look = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); setHand(s, 1, ['potion', 'water']); });
  assert(playable(look, card)); play(look, card);
  assert.equal(look.snapshot().pending.kind, 'view-cards');
  assert.equal(look.view(0).pending.lookedAt.length, 2);
  restore(look, f); settle(look);
  assert(look.snapshot().players[0].discard.includes(card));
  assert.equal(logs(look.snapshot(), 'effects.copy-supporter').length, 0);
  // With Supporters there: choose one; the chosen card stays in the opponent's hand.
  const g = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [target, gust] = setHand(s, 1, ['draw3', 'gust', 'water']); });
  play(g, card);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'copy-supporter'); assert.equal(q.ruleId, 'effects.copy-supporter');
  assert.deepEqual([...q.options].sort(), [target, gust].sort()); assert(q.allowZero);
  assert.equal(g.view(0).pending.lookedAt.length, 3); assert.equal(g.view(1).pending, null);
  restore(g, f); answer(g, [target]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].hand.length, 3, 'The copying player draws 3.');
  assert(s.players[1].hand.includes(target) && s.players[0].discard.includes(card));
  const [selected] = logs(s, 'effects.copy-supporter', 'selected');
  assert.deepEqual(selected.data.reference, { instanceId: target });
  assert.equal(selected.data.source.instanceId, card); assert.equal(selected.data.source.category, 'trainer');
  assert(logs(s, 'effects.partial').some((e) => e.data.copyId === selected.data.id && e.data.contentSource.instanceId === target));
  // It is not playing the chosen Supporter (JP Q&A ナツメの暗示＋キョウの罠).
  assert.deepEqual(s.battleHistory.events.filter((e) => e.kind === 'supporterPlayed').map((e) => e.cardId), [card]);
  restore(g, f);
  // Declining copies nothing.
  const none = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); setHand(s, 1, ['draw3']); });
  play(none, card); answer(none, []);
  assert.equal(none.snapshot().players[0].hand.length, 0);
  assert.equal(logs(none.snapshot(), 'effects.copy-supporter').length, 0);
});

test('「自己的回合结束」 of a copied Supporter ends the turn after the copying Trainer, once; an attack ends it anyway (JP Q&A ダイゴの決断)', async () => {
  const f = await copyFixture();
  let card, ender;
  const g = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [ender] = setHand(s, 1, ['ender']); });
  play(g, card); answer(g, [ender]);
  let s = g.snapshot();
  assert.equal(turnEnds(s, 0), 1); assert.equal(s.current, 1);
  assert(s.players[0].discard.includes(card), 'The Trainer finished before the turn ended.');
  const turnEnd = s.events.findIndex((e) => e.ruleId === 'turn.end' && e.data.player === 0);
  assert(s.events.findIndex((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-finished') < turnEnd);
  // A Trainer that itself ends the turn ends it once.
  const both = board(f, (s) => { [card] = setHand(s, 0, ['suggestion-end']); [ender] = setHand(s, 1, ['ender']); });
  play(both, card); answer(both, [ender]); settle(both);
  s = both.snapshot();
  assert.equal(turnEnds(s, 0), 1); assert.equal(s.current, 1); assert.equal(s.players[1].turns, 3);
  // In an attack the turn ends as after any attack.
  const hit = board(f, (s) => { [ender] = setHand(s, 1, ['ender']); });
  use(hit, 'mime'); answer(hit, [ender]); settle(hit);
  s = hit.snapshot();
  assert.equal(turnEnds(s, 0), 1); assert.equal(s.current, 1); assert.equal(s.players[1].turns, 3);
});

test('an attack copies: the effect is the attack\'s own, and a lock on playing Supporters from the hand does not stop it (JP Q&A カブトプス)', async () => {
  const f = await copyFixture((defs) => defs[1].mechanics.effects.push(binding('cn.playerRestriction@1', {
    effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playSupporter'], sourceActive: true } }, 'fossil-lock')));
  let card, gust, benched;
  const g = board(f, (s) => {
    opponentActive(s, 'other'); benched = bench(s, 1, 'evolution');
    [card] = setHand(s, 0, ['suggestion']); [gust] = setHand(s, 1, ['gust', 'water']);
  });
  assert(!playable(g, card), 'The Supporter itself is locked.');
  use(g, 'mime');
  assert.equal(g.snapshot().pending.kind, 'copy-supporter'); assert.deepEqual(g.snapshot().pending.options, [gust]);
  restore(g, f); answer(g, [gust]);
  const q = g.snapshot().pending;
  assert.equal(q.data.source.category, 'attack'); assert.deepEqual(q.data.source.contentSource, { instanceId: gust });
  restore(g, f); settle(g, (q) => q.options.includes(benched.id) ? [benched.id] : q.allowZero ? [] : q.options.slice(0, q.minimum));
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, benched.id);
  assert(s.players[1].hand.includes(gust));
});

test('「若希望，将其中的1张支援者，放于弃牌区。在这种情况下…」: discarded first; the chosen card\'s own 「这张「X」」 does not move (JP Q&A カヒリ／グラジオ)', async () => {
  const f = await copyFixture();
  let boomerang, exchange;
  const g = board(f, (s) => { setHand(s, 0, []); [boomerang, exchange] = setHand(s, 1, ['boomerang', 'exchange', 'water']); });
  const prizes = clone(g.snapshot().players[0].prizes);
  use(g, 'sylveon'); answer(g, [boomerang]); settle(g);
  let s = g.snapshot();
  assert(s.players[1].discard.includes(boomerang) && !s.players[1].hand.includes(boomerang));
  assert.equal(s.players[0].hand.length, 1, 'It draws; the discarded card stays in its owner\'s discard pile.');
  assert(logs(s, 'effects.copy-supporter', 'selected')[0].data.discarded);
  restore(g, f);
  // A copied exchange with 「这张「X」」 does nothing at all, not even the look at the Prizes.
  const swap = board(f, (s) => { setHand(s, 0, []); [, exchange] = setHand(s, 1, ['boomerang', 'exchange']); });
  use(swap, 'sylveon'); answer(swap, [exchange]); settle(swap);
  s = swap.snapshot();
  assert(s.players[1].discard.includes(exchange));
  assert.deepEqual(s.players[0].prizes.length, prizes.length); assert.equal(s.players[0].hand.length, 0);
  assert(!logs(s, 'effects.prize-exchange').length);
  // An attack can look at an empty hand: nothing there, nothing copied.
  const empty = board(f, (s) => { setHand(s, 1, []); });
  use(empty, 'sylveon'); settle(empty);
  assert(logs(empty.snapshot(), 'effects.partial').some((e) => e.data.operation === 'copySupporter' && !e.data.performed));
  assert(!logs(empty.snapshot(), 'effects.opponent-hand').length);
  // Declining discards nothing.
  const keep = board(f, (s) => { [boomerang] = setHand(s, 1, ['boomerang']); });
  use(keep, 'sylveon'); answer(keep, []); settle(keep);
  assert(keep.snapshot().players[1].hand.includes(boomerang));
  // A copying Trainer's 「这张「X」」 is not that Trainer either.
  let card;
  const trainer = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [boomerang] = setHand(s, 1, ['boomerang']); });
  play(trainer, card); answer(trainer, [boomerang]); settle(trainer);
  s = trainer.snapshot();
  assert(s.players[0].discard.includes(card) && !s.players[0].hand.includes(card));
  assert(s.players[1].hand.includes(boomerang));
  assert(logs(s, 'effects.partial').some((e) => e.data.operation === 'returnSelf' && !e.data.performed));
});

test('「将自己手牌中的1张支援者放于弃牌区。然后…」: the user may choose none (II.E-33); the effect is used from the discard pile (JP Q&A ルザミーネ)', async () => {
  const f = await copyFixture();
  let recover, draw3, last;
  const g = board(f, (s) => { [recover, draw3, last] = setHand(s, 0, ['recover', 'draw3', 'last', 'water']); });
  use(g, 'mimikyu');
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'copy-supporter'); assert.equal(q.minimum, 0); assert(q.allowZero);
  assert.deepEqual([...q.options].sort(), [recover, draw3, last].sort());
  assert.deepEqual(g.view(0).pending.cards.map((c) => c.instanceId).sort(), [recover, draw3, last].sort());
  // A copied hand-size use condition is not judged (JP Q&A カツラの一発勝負／エリカのおもてなし answer by wording).
  assert.throws(() => answer(restore(g, f), [last]), (e) => e.code === 'unresolved-copy-condition');
  answer(g, [recover]);
  const pick = g.snapshot().pending;
  assert(pick.options.includes(recover), 'The discarded card itself can be taken back.');
  restore(g, f); answer(g, [recover]); settle(g);
  assert(g.snapshot().players[0].hand.includes(recover));
  // Choosing none does nothing.
  const none = board(f, (s) => { [draw3] = setHand(s, 0, ['draw3']); });
  use(none, 'mimikyu'); answer(none, []); settle(none);
  assert(none.snapshot().players[0].hand.includes(draw3));
  assert(logs(none.snapshot(), 'effects.partial').some((e) => e.data.operation === 'copySupporter' && !e.data.performed));
  // Without a Supporter in hand there is nothing to choose.
  const empty = board(f, (s) => { setHand(s, 0, ['water']); });
  use(empty, 'mimikyu'); settle(empty);
  assert.equal(empty.snapshot().players[0].hand.length, 1);
});

test('「选择对手弃牌区中的1张支援者」: a required public choice; its own condition must hold (JP Q&A メロコ), its 「自己」 is the user (アカネ)', async () => {
  const f = await copyFixture();
  let revenge, draw3;
  const g = board(f, (s) => { setHand(s, 0, []); [revenge, draw3] = into(s, 1, 'discard', ['revenge', 'draw3']); });
  use(g, 'oranguru');
  const q = g.snapshot().pending;
  assert.equal(q.minimum, 1); assert(!q.allowZero);
  restore(g, f); answer(g, [revenge]); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, 0, 'No Knock Out last turn: the copied condition does not hold.');
  assert.equal(logs(s, 'effects.copy-supporter', 'unused').length, 1);
  assert(s.players[1].discard.includes(revenge));
  const other = board(f, (s) => { setHand(s, 0, []); [, draw3] = into(s, 1, 'discard', ['revenge', 'draw3']); });
  use(other, 'oranguru'); answer(other, [draw3]); settle(other);
  assert.equal(other.snapshot().players[0].hand.length, 3);
  // A required choice among only unjudgeable conditions is refused before anything happens.
  const stuck = board(f, (s) => { into(s, 1, 'discard', ['last']); });
  assert.throws(() => use(stuck, 'oranguru'), (e) => e.code === 'unresolved-copy-condition');
  // Nothing there: the attack copies nothing.
  const empty = board(f);
  use(empty, 'oranguru'); settle(empty);
  assert(logs(empty.snapshot(), 'effects.partial').some((e) => e.data.operation === 'copySupporter' && !e.data.performed));
});

test('a copied play cost is the user\'s: paid only when it can be and the effect could change something, then always (JP Q&A プルメリ／ヒガナの決意／ルミタン)', async () => {
  const f = await copyFixture();
  let strip, energy, extra;
  // The opponent's Pokémon have no Energy: nothing is paid and nothing happens.
  const bare = board(f, (s) => { setHand(s, 0, ['water', 'water', 'potion']); [strip] = setHand(s, 1, ['strip']); });
  use(bare, 'mime'); answer(bare, [strip]); settle(bare);
  assert.equal(bare.snapshot().players[0].hand.length, 3); assert.equal(logs(bare.snapshot(), 'effects.copy-supporter', 'unused').length, 1);
  // One card in hand cannot pay 2.
  const poor = board(f, (s) => { setHand(s, 0, ['water']); [strip] = setHand(s, 1, ['strip']); attached(s, 1, s.players[1].active, 'water'); });
  use(poor, 'mime'); answer(poor, [strip]); settle(poor);
  assert.equal(poor.snapshot().players[0].hand.length, 1); assert.equal(poor.snapshot().players[1].active.energy.length, 1);
  // Able to pay and to discard an Energy: the payment is required.
  const g = board(f, (s) => {
    setHand(s, 0, ['water', 'water', 'potion']); [strip] = setHand(s, 1, ['strip']);
    energy = attached(s, 1, s.players[1].active, 'water'); extra = attached(s, 1, s.players[1].active, 'double');
  });
  use(g, 'mime'); answer(g, [strip]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'activation-cost'); assert.equal(q.minimum, 2); assert.equal(q.maximum, 2); assert(!q.allowZero);
  assert.equal(g.view(0).pending.payment.source.instanceId, strip);
  restore(g, f);
  const paid = g.snapshot().players[0].hand.filter((id) => g.snapshot().cards[id].definitionId === 'water');
  answer(g, paid.map((id) => paymentOptionId('pay', id)));
  const choice = g.snapshot().pending;
  assert.equal(choice.data.payment.kind, 'copy'); assert.equal(choice.data.payment.sourceId, strip);
  restore(g, f); answer(g, [energy]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[1].active.energy, [extra]); assert(paid.every((id) => s.players[0].discard.includes(id)));
  assert(s.players[1].hand.includes(strip));
});

test('a copied optional play cost is the user\'s choice; only then its paid part (JP Q&A グズマ&ハラ)', async () => {
  const f = await copyFixture();
  let paired, card;
  const g = board(f, (s) => { setHand(s, 0, ['water', 'potion']); [paired] = setHand(s, 1, ['paired']); });
  use(g, 'mime'); answer(g, [paired]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'activation-cost'); assert(q.allowZero); assert(g.view(0).pending.payment.optional);
  const decline = restore(g, f); answer(decline, []); settle(decline);
  assert.equal(decline.snapshot().players[0].hand.length, 3, 'Only the unpaid draw of 1.');
  answer(g, [q.options[0]]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 1 + 1 + 2, 'One kept card, the draw of 1 and the paid draw of 2.');
  // A Trainer copy pays the same way.
  const trainer = board(f, (s) => { [card] = setHand(s, 0, ['suggestion', 'water']); [paired] = setHand(s, 1, ['paired']); });
  play(trainer, card); answer(trainer, [paired]);
  const pay = trainer.snapshot().pending;
  answer(trainer, [pay.options[0]]); settle(trainer);
  assert.equal(trainer.snapshot().players[0].hand.length, 3);
  assert(trainer.snapshot().players[0].discard.includes(card));
});

test('a copied 「使用了这张卡牌的回合结束时」 is recorded for this turn; a copied effect can Knock Out with its copy provenance', async () => {
  const f = await copyFixture();
  let plan, hex, benched;
  const g = board(f, (s) => { setHand(s, 0, []); [plan] = setHand(s, 1, ['plan']); });
  use(g, 'mime'); answer(g, [plan]);
  let s = g.snapshot();
  assert.equal(logs(s, 'effects.turn-end').filter((e) => e.data.recorded).length, 1);
  settle(g);
  s = g.snapshot();
  assert.equal(s.current, 1); assert.equal(s.players[0].hand.length, 8, 'Drawn at the end of the attacking turn.');
  const ko = board(f, (s) => { [hex] = setHand(s, 1, ['hex']); benched = bench(s, 1, 'other'); });
  use(ko, 'mime'); answer(ko, [hex]);
  answer(ko, [ko.snapshot().players[1].active.id]);
  s = ko.snapshot();
  assert.equal(s.pending.kind, 'prize');
  restore(ko, f);
  const fact = s.battleHistory.events.find((e) => e.kind === 'ko');
  assert.deepEqual(fact.cause.source.contentSource, { instanceId: hex }); assert.equal(fact.cause.source.category, 'attack');
  settle(ko, (q) => q.kind === 'promote' ? [benched.id] : q.allowZero ? [] : q.options.slice(0, q.minimum));
  assert.equal(ko.snapshot().players[1].active.id, benched.id);
  restore(ko, f);
});

test('copies compose: a copied copy, and a copy inside a copied attack, keep their whole provenance', async () => {
  const f = await copyFixture();
  let card, theirs, draw3, gust, benched;
  // The opponent's own 「…作为这张卡牌的效果使用」 copied: it looks at the same opponent's hand again.
  const g = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [theirs, draw3] = setHand(s, 1, ['suggestion', 'draw3']); });
  play(g, card); answer(g, [theirs]);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'copy-supporter'); assert.deepEqual(q.data.source.contentSource, { instanceId: theirs });
  restore(g, f); answer(g, [draw3]); settle(g);
  const s = g.snapshot(), [outer, inner] = logs(s, 'effects.copy-supporter', 'selected');
  assert.equal(inner.data.source.copyId, outer.data.id); assert.equal(s.players[0].hand.length, 3);
  restore(g, f);
  // 「选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用」 → the opponent's copy attack → their hand's Supporter.
  const mew = board(f, (s) => { opponentActive(s, 'other'); benched = bench(s, 1, 'base'); [gust] = setHand(s, 1, ['gust']); });
  use(mew, 'mew'); settle(mew, (q) => q.kind === 'copy-attack' ? [q.options[0]] : q.kind === 'copy-supporter' ? [gust] :
    q.options.includes(benched.id) ? [benched.id] : q.allowZero ? [] : q.options.slice(0, q.minimum));
  const after = mew.snapshot();
  assert.equal(after.players[1].active.id, benched.id);
  const [selected] = logs(after, 'effects.copy-supporter', 'selected');
  assert.equal(selected.data.source.contentSource.attackId, 'other:mime');
});

test('a copy does not run a copied card\'s before-hand part', async () => {
  const f = await copyFixture(() => {}, { arrival: { effects: [
    { ...binding('cn.draw@1', { count: 5 }, 'arrival-hand'), trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' } },
    binding('cn.draw@1', { count: 1 }, 'arrival')] } });
  let arrival;
  // The user's own copies of that card are out of reach of the draw.
  const g = board(f, (s) => { setHand(s, 0, []); into(s, 0, 'discard', ['arrival', 'arrival']); [arrival] = setHand(s, 1, ['arrival']); });
  use(g, 'mime'); answer(g, [arrival]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 1);
});

test('a copy\'s saved choice, cost and provenance cannot be edited', async () => {
  const f = await copyFixture();
  const rejects = (s, code) => assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === code);
  const reseal = (s) => { s.events.find((e) => e.ruleId === 'selection.request' && e.data.request.id === s.pending.id).data.request = clone(s.pending); };
  let card, draw3, water, strip, energy;
  const g = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [draw3, water] = setHand(s, 1, ['draw3', 'water']); });
  play(g, card);
  const looked = g.snapshot(); looked.players[1].hand.reverse();
  rejects(looked, 'invalid-card-selection');
  // Only a Supporter of that zone can be chosen, whatever the saved prompt offers.
  const offered = g.snapshot(); offered.pending.options.push(water); reseal(offered);
  assert.throws(() => answer(OfficialGame.restore(offered, { catalog: f.catalog }), [water]), (e) => e.code === 'invalid-card-selection');
  // A paid copy: its request, receipt and copied source stay those of the actual choice.
  const paid = board(f, (s) => {
    setHand(s, 0, ['water', 'water', 'potion']); [strip] = setHand(s, 1, ['strip']);
    energy = attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'double');
  });
  use(paid, 'mime'); answer(paid, [strip]);
  const request = paid.snapshot();
  const other = clone(request); other.pending.data.activation.sourceId = card; rejects(other, 'invalid-activation');
  const used = clone(request), selected = used.events.find((e) => e.ruleId === 'effects.copy-supporter');
  used.events.push({ ...clone(selected), data: { kind: 'used', id: selected.data.id, player: 0, paid: false } });
  rejects(used, 'invalid-activation');
  answer(paid, request.pending.options.filter((id) => request.cards[JSON.parse(id)[1]].definitionId === 'water'));
  const running = paid.snapshot();
  assert(running.pending.options.includes(energy));
  const receipt = clone(running); receipt.pending.data.payment.sourceId = card; rejects(receipt, 'invalid-payment-receipt');
  const content = clone(running); content.events.find((e) => e.ruleId === 'effects.copy-supporter').data.source.attackId = 'base:strike';
  rejects(content, 'invalid-effect-source');
  const binding = clone(running); binding.pending.data.source.effectId = 'fixture:draw3'; rejects(binding, 'invalid-effect-source');
  const receiptId = clone(running); receiptId.pending.data.source.copyId = 'supporter-unknown'; rejects(receiptId, 'invalid-effect-source');
  restore(paid, f);
});

// effects.supporter-replacement 「只要这只宝可梦在战斗场上，对手手牌里的支援者的效果，都会变为「从自己的牌库上方抽取3张卡牌。」。」
const SWAP = { op: 'handSupporterEffect', scope: 'opponent', sourceActive: true, replacement: leaf('cn.draw@1', { count: 3 }) };
const continuous = (abilityId, effects) => ({ abilityId, name: '测试替身', mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const CATCHER = { catcher: { category: 'item', effects: [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'catcher')] } };
async function tenguFixture(effects = [binding('cn.handSupporterEffect@1', { effect: SWAP }, 'tengu')]) {
  const f = await copyFixture((defs) => {
    const other = defs.find((d) => d.definitionId === 'other');
    defs.push({ ...clone(other), definitionId: 'tengu', name: '测试替身宝可梦', nameKey: 'tengu',
      mechanics: { ...clone(other.mechanics), abilities: [continuous('tengu:double', effects)] } });
  }, CATCHER);
  const deck = [...f.deck]; deck.splice(deck.indexOf('printing:water'), 2, 'printing:tengu', 'printing:tengu');
  return { ...f, deck };
}
const activeTengu = (s, owner) => { const p = s.players[owner], m = bench(s, owner, 'tengu'); p.bench.pop(); p.bench.push(p.active); p.active = m; return m; };
const replacements = (s) => logs(s, 'effects.supporter-replacement', 'replaced');
const scheduled = (s, copyId) => s.events.filter((e) => e.ruleId === 'effects.execution' && e.data.kind === 'scheduled' && e.data.source.copyId === copyId);

test('effects.supporter-replacement: a strict descriptor, only on a Pokémon', async () => {
  assert(requireRule(CN_V20261019, 'effects.supporter-replacement').sourceOfTruth.length);
  const ok = createCoreHandlers().get('cn.handSupporterEffect@1').validateParameters;
  assert(ok({ effect: SWAP }));
  const { sourceActive: _active, ...always } = SWAP;
  for (const bad of [{ ...SWAP, scope: 'own' }, always, { ...SWAP, replacement: leaf('cn.draw@1', { count: 0 }) },
    { ...SWAP, replacement: leaf('cn.heal@1', { target: 'any', amount: 30 }) }, { ...SWAP, extra: true }]) assert(!ok({ effect: bad }));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'tool').mechanics.effects = [binding('cn.handSupporterEffect@1', { effect: SWAP })];
  });
  assert.throws(() => board(f), /Unimplemented or undeclared/);
});

test('「对手手牌里的支援者的效果，都会变为「从自己的牌库上方抽取3张卡牌。」」: still played as that Supporter, with only the draw (JP Q&A てんぐのかえだま)', async () => {
  const f = await tenguFixture();
  let card, second, tengu;
  const g = board(f, (s) => { [card, second] = setHand(s, 0, ['gust', 'draw3']); tengu = activeTengu(s, 1); });
  assert(playable(g, card)); play(g, card);
  const s = g.snapshot();
  assert.equal(s.pending, null, 'No switch choice (ポケモンごっこ).');
  assert.equal(s.players[0].hand.length, 4); assert.equal(s.players[1].active.id, tengu.id);
  assert(s.players[0].discard.includes(card));
  const [changed] = replacements(s);
  assert.deepEqual(changed.data.reference, { instanceId: tengu.stack[0], effectId: 'fixture:tengu' });
  assert.equal(changed.data.cardId, card); assert.equal(changed.data.source.instanceId, card);
  const [run] = scheduled(s, changed.data.id);
  assert.equal(run.data.binding.handlerId, 'cn.draw@1'); assert.deepEqual(run.data.binding.parameters, { count: 3 });
  assert.deepEqual(run.data.source.contentSource, changed.data.reference); assert.equal(run.data.source.category, 'trainer');
  // It is still that Supporter played from the hand (JP Q&A シバ／ハブネーク): the turn's Supporter is used.
  assert.deepEqual(s.battleHistory.events.filter((e) => e.kind === 'supporterPlayed').map((e) => e.cardId), [card]);
  assert(!playable(g, second));
  restore(g, f);
  // Not while it is Benched, nor for its own player's Supporters.
  for (const mutate of [(s) => { bench(s, 1, 'tengu'); }, (s) => { activeTengu(s, 0); bench(s, 1, 'base'); }]) {
    const n = board(f, (s) => { [card] = setHand(s, 0, ['gust']); mutate(s); });
    play(n, card);
    assert.equal(n.snapshot().pending.kind, 'effect-target'); assert.equal(replacements(n.snapshot()).length, 0);
  }
});

test('a changed Supporter has no condition, cost, optional cost or 「自己的回合结束」, and needs a card to draw (JP Q&A ブルーの探索／グズマ&ハラ／ダイゴの決断／ダンデ)', async () => {
  const f = await tenguFixture();
  let card;
  for (const key of ['revenge', 'last', 'strip', 'paired', 'ender']) {
    const g = board(f, (s) => { [card] = setHand(s, 0, [key, 'water']); activeTengu(s, 1); });
    assert(playable(g, card), key); play(g, card);
    const s = g.snapshot();
    assert.equal(s.pending, null, key); assert.equal(s.current, 0, key);
    assert.equal(s.players[0].hand.length, 4, key); assert.equal(s.players[0].discard.length, 1, key);
  }
  // Without the change these cannot be played from that hand.
  for (const key of ['revenge', 'last', 'strip']) assert(!playable(board(f, (s) => { [card] = setHand(s, 0, [key, 'water']); }), card), key);
  // An empty deck: the changed effect could change nothing.
  const empty = (tengu) => board(f, (s) => {
    [card] = setHand(s, 0, ['gust']); s.players[0].discard.push(...s.players[0].deck.splice(0));
    if (tengu) activeTengu(s, 1); else bench(s, 1, 'base');
  });
  assert(!playable(empty(true), card)); assert(playable(empty(false), card));
});

test('the change is fixed as the Supporter is used (JP Q&A グリーンの戦略／グズマ)', async () => {
  const f = await tenguFixture();
  let plan, catcher, tengu, benched;
  // Played as changed: the drawing at the end of the turn is not part of it, also when the Pokémon leaves the Active Spot.
  const changed = board(f, (s) => { [plan, catcher] = setHand(s, 0, ['plan', 'catcher']); tengu = activeTengu(s, 1); benched = s.players[1].bench[0]; });
  play(changed, plan); play(changed, catcher); answer(changed, [benched.id]);
  assert.equal(changed.snapshot().players[1].active.id, benched.id);
  command(changed, { type: 'endTurn' }); settle(changed);
  assert.equal(changed.snapshot().players[0].hand.length, 3);
  // Played as printed: the Pokémon moving to the Active Spot later changes nothing.
  const printed = board(f, (s) => { [plan, catcher] = setHand(s, 0, ['plan', 'catcher']); tengu = bench(s, 1, 'tengu'); });
  play(printed, plan); play(printed, catcher); answer(printed, [tengu.id]);
  assert.equal(printed.snapshot().players[1].active.id, tengu.id);
  command(printed, { type: 'endTurn' }); settle(printed);
  assert.equal(printed.snapshot().players[0].hand.length, 8);
  assert.equal(replacements(printed.snapshot()).length, 0);
});

test('a copy of a changed Supporter left in the hand runs the change; one discarded first runs its own effect (JP Q&A ナツメの暗示／ミミッキュ)', async () => {
  const f = await tenguFixture();
  let card, gust, last, ender, revenge, tengu;
  // The copying player's own Active changes the opponent's hand: a hand-size condition no longer matters.
  const g = board(f, (s) => { [card] = setHand(s, 0, ['suggestion']); [gust, last, ender] = setHand(s, 1, ['gust', 'last', 'ender']); tengu = activeTengu(s, 0); });
  play(g, card);
  assert.deepEqual([...g.snapshot().pending.options].sort(), [gust, last, ender].sort());
  const copies = [gust, last, ender].map((id) => { const c = restore(g, f); answer(c, [id]); return c.snapshot(); });
  for (const s of copies) {
    assert.equal(s.pending, null); assert.equal(s.current, 0, 'A changed 「自己的回合结束」 does not end the turn.');
    assert.equal(s.players[0].hand.length, 3);
    const [selected] = logs(s, 'effects.copy-supporter', 'selected'), [changed] = replacements(s);
    assert.deepEqual(changed.data.source, selected.data.source);
    const [run] = scheduled(s, changed.data.id);
    assert.equal(run.data.source.instanceId, card); assert.deepEqual(run.data.source.contentSource, { instanceId: tengu.stack[0], effectId: 'fixture:tengu' });
    assert.equal(logs(s, 'effects.copy-supporter', 'used').length, 1);
  }
  const back = clone(copies[0]);
  assert.deepEqual(OfficialGame.restore(back, { catalog: f.catalog }).snapshot(), copies[0]);
  // An attack that copies from that hand.
  const attack = board(f, (s) => { [gust] = setHand(s, 1, ['gust']); activeTengu(s, 0); bench(s, 1, 'base'); setHand(s, 0, []); });
  command(attack, { type: 'attack', attackId: 'other:mime' }); answer(attack, [gust]); settle(attack);
  const after = attack.snapshot();
  assert.equal(after.players[0].hand.length, 3); assert.equal(replacements(after)[0].data.source.category, 'attack');
  // A card discarded from the hand first is no longer in that hand: its own condition is judged.
  const own = board(f, (s) => { [revenge] = setHand(s, 0, ['revenge']); activeTengu(s, 1); });
  use(own, 'mimikyu'); answer(own, [revenge]); settle(own);
  assert.equal(logs(own.snapshot(), 'effects.copy-supporter', 'unused').length, 1); assert.equal(replacements(own.snapshot()).length, 0);
  assert.equal(own.snapshot().players[0].hand.length, 0);
});

test('two changes of one Supporter, and an edited change, are refused', async () => {
  const twice = await tenguFixture([binding('cn.handSupporterEffect@1', { effect: SWAP }, 'tengu'),
    binding('cn.handSupporterEffect@1', { effect: { ...SWAP, replacement: leaf('cn.draw@1', { count: 2 }) } }, 'tengu-2')]);
  let card, gust, strip, tengu;
  const g = board(twice, (s) => { [card] = setHand(s, 0, ['gust']); activeTengu(s, 1); });
  assert.throws(() => g.view(0), (e) => e.code === 'unresolved-supporter-replacement');
  // A saved copy cannot claim a change that is not an approved changing Ability.
  const f = await tenguFixture();
  const rejects = (s) => assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-source');
  const paid = board(f, (s) => {
    setHand(s, 0, ['water', 'water', 'potion']); [strip] = setHand(s, 1, ['strip']); tengu = bench(s, 0, 'tengu');
    attached(s, 1, s.players[1].active, 'water');
  });
  use(paid, 'mime'); answer(paid, [strip]);
  answer(paid, paid.snapshot().pending.options.filter((id) => paid.snapshot().cards[JSON.parse(id)[1]].definitionId === 'water'));
  const running = paid.snapshot();
  for (const reference of [{ instanceId: tengu.stack[0], effectId: 'fixture:other' }, { instanceId: strip, effectId: 'fixture:strip' }]) {
    const forged = clone(running), source = forged.pending.data.source, id = 'replaced-forged';
    forged.events.push({ ruleId: 'effects.supporter-replacement', visibility: 'public',
      data: { kind: 'replaced', id, cardId: strip, source: clone(logs(running, 'effects.copy-supporter', 'selected')[0].data.source), reference } });
    source.contentSource = reference; source.copyId = id;
    rejects(forged);
  }
  void gust; void card;
});
