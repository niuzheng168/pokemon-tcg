// Synthetic definitions only. 「若这个招式的伤害将对手的宝可梦昏厥，则多获得1张奖赏卡。若额外附有7个能量，则改为多获得3张。」,
// 「如果因这个招式的伤害，对手的宝可梦【昏厥】的话，则在下一个对手的回合，这只宝可梦不会受到招式的伤害和效果影响。」,
// 「当自己的剩余奖赏卡张数为6张时，因身上放有这张卡牌的「究极异兽」的招式的伤害，而导致对手战斗场上的「宝可梦GX・EX」【昏厥】时，则多拿取1张
// 奖赏卡。」 and 「身上附着了这张卡牌的宝可梦，受到对手宝可梦的招式的伤害而【昏厥】时，对手拿取的奖赏卡将减少1张。对战中，自己的「遗赠能量」的
// 这个效果，只会生效1次。」 (ko.prize-modifier, ko.prize-modifier-once, effects.knockout-condition). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, start, command, settle, attached, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const extraPrizes = (count) => ({ handlerId: 'cn.extraPrizes@1', parameters: { count } });
// 「若额外附有7个能量，则改为多获得3张」.
const beastGame = { condition: { kind: 'compare', left: { kind: 'extraEnergy', energyType: null }, relation: 'gte', right: lit(7) },
  effect: extraPrizes(3), otherwise: extraPrizes(1) };

async function make({ attack = [], damage = 100, transform = () => {} } = {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:bite', name: '测试咬碎', cost: ['Water'],
      printedDamage: damage === null ? null : { value: damage, operator: 'fixed' }, effects: attack, sourceOfTruth: EVIDENCE });
    transform(defs);
  });
}
function knockOut(f, mutate = () => {}, energies = 1) {
  const g = board(f, (s) => {
    for (let i = 0; i < energies; i++) attached(s, 0, s.players[0].active, 'water');
    bench(s, 1, 'other'); mutate(s);
  });
  command(g, { type: 'attack', attackId: 'base:bite' });
  return g;
}
const taken = (g, owner = 0) => { settle(g); return 6 - g.snapshot().players[owner].prizes.length; };
const equip = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };

test('「若…则多获得1张奖赏卡。若额外附有7个能量，则改为多获得3张」: cn.extraPrizes@1 as a condition\'s result, attacks only', async () => {
  assert(handlers.get('cn.when@1').validateParameters(clone(beastGame)));
  assert(handlers.get('cn.when@1').validateParameters({ condition: beastGame.condition, effects: [extraPrizes(1), { handlerId: 'cn.draw@1', parameters: { count: 1 } }] }));
  assert(!handlers.get('cn.when@1').validateParameters({ ...clone(beastGame), effect: { handlerId: 'cn.extraPrizes@1', parameters: { count: 0 } } }));
  for (const [id, p] of [['cn.then@1', { first: extraPrizes(1), next: { handlerId: 'cn.draw@1', parameters: { count: 1 } } }],
    ['cn.coin@1', { outcome: 'heads', effect: extraPrizes(1) }], ['cn.optional@1', { effect: extraPrizes(1) }]])
    assert(!handlers.get(id).validateParameters(p), `${id}: not a static leaf elsewhere`);
  const f = await make({ attack: [binding('cn.when@1', beastGame, 'beast')] });
  for (const [energies, prizes] of [[1, 2], [7, 2], [8, 4]]) {
    const g = knockOut(f, () => {}, energies);
    if (energies === 8) assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
    assert.equal(taken(g), prizes, `${energies - 1} extra Energy`);
  }
  const tough = await make({ attack: [binding('cn.when@1', beastGame, 'beast')], damage: 50 });
  assert.equal(taken(knockOut(tough, () => {}, 8)), 0, 'No Knock Out, no Prize card.');
  const board = { ...beastGame, condition: { kind: 'stadiumInPlay', owner: 'any' } };
  const trainer = await make({ transform: (defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.when@1', board, 'beast')]; } });
  assert.throws(() => start(trainer), /Unimplemented or undeclared/);
  const stadium = await make({ transform: (defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.stadiumUse@1',
    { key: 'beast', effect: { handlerId: 'cn.when@1', parameters: board } }, 'use')]; } });
  assert.throws(() => start(stadium), /Unimplemented or undeclared/);
});

const shield = (channel, extra = {}) => binding('cn.lasting@1', { side: 'own', target: 'self',
  effect: { op: 'protection', channel, useRule: 'ordinary', scope: 'all', from: 'opponent', categories: ['attack'] },
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true, ifDamageKnockedOut: true, ...extra }, `shield-${channel}`);
async function accelerate(effects = [shield('damage'), shield('effects')], damage = 50) {
  return make({ attack: effects, damage, transform: (defs) => {
    for (const id of ['base', 'other']) def(defs, id).mechanics.attacks[0].effects = [binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' }, 'poison')];
  } });
}
// The opponent's next turn: its Active Pokémon attacks this one.
function retaliate(g, attackId = 'other:strike') {
  settle(g);
  command(g, { type: 'attack', attackId }); settle(g);
  return g.snapshot().players[0].active;
}

test('「如果因这个招式的伤害，对手的宝可梦【昏厥】的话，则在下一个对手的回合，…不会受到招式的伤害和效果影响」', async () => {
  const lasting = (p) => handlers.get('cn.lasting@1').validateParameters(p);
  assert(lasting(clone(shield('damage').parameters)));
  assert(!lasting({ ...clone(shield('damage').parameters), effect: { op: 'suppression', channel: 'abilities', scope: 'all' } }));
  assert(!lasting({ ...clone(shield('damage').parameters), ifDamageKnockedOut: false }));
  const f = await accelerate();
  const foe = (s) => { s.players[1].active.counters = 5; attached(s, 1, s.players[1].bench[0], 'water'); };
  let g = knockOut(f, foe);
  settle(g);
  const s = g.snapshot();
  assert.equal(s.current, 1); assert.equal(s.ongoing.length, 2); assert.deepEqual(s.ongoing[0].knockedOutBy.attack.attackId, 'base:bite');
  assert.deepEqual(restore(g, f).snapshot(), s);
  const forged = clone(s); forged.ongoing[0].knockedOutBy.from = -1;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }));
  let me = retaliate(g);
  assert.equal(me.counters, 0); assert.equal(me.conditions.poison, null, 'Neither the damage nor the effect.');
  // こんじょう-like: damaged, still in play — no Knock Out, no protection (JP Q&A アーマーガア「アクセレート」×ハリテヤマ).
  g = knockOut(f, (s) => { attached(s, 1, s.players[1].active, 'water'); });
  me = retaliate(g, 'base:strike');
  assert.equal(me.counters, 2 + 1, '20 damage, and poisoned: 1 more counter at the checkup.'); assert.equal(me.conditions.poison, 1);
  // A Knock Out by counters this attack's effect placed is not one by its damage.
  const counters = await accelerate([binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }, 'counters'), shield('damage')], null);
  g = knockOut(counters, foe);
  me = retaliate(g);
  assert.equal(me.counters, 2 + 1);
  const item = await make({ transform: (defs) => { def(defs, 'potion').mechanics.effects = [shield('damage')]; } });
  assert.throws(() => start(item), /Only an attack/);
});

// 異兽法宝: an Ultra Beast holder's own attack, the opponent's Active Pokémon-GX/EX, exactly 6 Prize cards left.
const bringer = (extra = {}) => ({ effect: { op: 'prizeModifier', scope: 'opponent', amount: 1, activeOnly: true, byOwnAttack: true,
  attackerSelector: { kind: 'pokemon', tagsAll: ['Ultra Beast'] },
  targetSelector: { anyOf: [{ kind: 'pokemon', tagsAll: ['GX'] }, { kind: 'pokemon', tagsAll: ['EX'] }] },
  condition: { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'prizes' }, relation: 'eq', right: lit(6) }, ...extra } });
async function beasts(spec = bringer(), attack = []) {
  return make({ attack, transform: (defs) => {
    def(defs, 'base').mechanics.tags = ['Ultra Beast'];
    Object.assign(def(defs, 'other').mechanics, { tags: ['GX'], ruleBox: true, prizeCount: 2 });
    def(defs, 'tool').mechanics.effects = [binding('cn.prizeModifier@1', spec, 'bringer')];
  } });
}
// The opponent's Active Pokémon is a Pokémon-GX; ours holds the Tool.
const gxFoe = (s) => {
  const p = s.players[1], gx = bench(s, 1, 'other');
  p.bench.splice(p.bench.indexOf(gx), 1); p.bench.push(p.active); p.active = gx;
};

test('「因身上放有这张卡牌的「究极异兽」的招式的伤害…对手战斗场上的「宝可梦GX・EX」…剩余奖赏卡张数为6张时」: byOwnAttack', async () => {
  const valid = (p) => handlers.get('cn.prizeModifier@1').validateParameters(p);
  assert(valid(bringer())); assert(!valid(bringer({ byOwnAttack: undefined })), 'attackerSelector reads an attacker the effect names');
  assert(valid({ effect: { op: 'prizeModifier', scope: 'self', amount: -1, byOwnAttack: true } }));
  const f = await beasts();
  assert.equal(taken(knockOut(f, (s) => { equip(s, 0, s.players[0].active); gxFoe(s); })), 3, '2 + 1.');
  assert.equal(taken(knockOut(f, (s) => { equip(s, 0, s.players[0].active); gxFoe(s); s.players[0].hand.push(s.players[0].prizes.pop()); })), 1 + 2,
    'Five Prize cards left, two taken (JP Q&A ビーストブリンガー).');
  assert.equal(taken(knockOut(f, (s) => { equip(s, 0, s.players[0].active); })), 1, 'Not a Pokémon-GX.');
  assert.equal(taken(knockOut(f, (s) => { equip(s, 0, bench(s, 0, 'base')); gxFoe(s); })), 2, 'Another Pokémon\'s attack.');
  const notBeast = await beasts(bringer({ attackerSelector: { kind: 'pokemon', nameKeys: ['evolution'] } }));
  assert.equal(taken(knockOut(notBeast, (s) => { equip(s, 0, s.players[0].active); gxFoe(s); })), 2, 'The holder is not an 「究极异兽」.');
  const spread = await beasts(bringer(), [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'all' }, options: {} })]);
  const g = board(spread, (s) => {
    attached(s, 0, s.players[0].active, 'water'); equip(s, 0, s.players[0].active);
    bench(s, 1, 'other'); bench(s, 1, 'base');
  });
  command(g, { type: 'attack', attackId: 'base:bite' });
  assert.equal(taken(g), 4, 'The Benched Pokémon-GX gives no extra card (JP Q&A ビーストブリンガー).');
  const stadium = await make({ transform: (defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.prizeModifier@1', bringer(), 'bringer')]; } });
  assert.throws(() => start(stadium), /A Stadium has no Pokémon/);
});

// 遗赠能量: a Special Energy whose reduction applies once per game for its player.
const legacy = { effect: { op: 'prizeModifier', scope: 'self', amount: -1, byOpponentAttack: true, oncePerGame: 'legacy-energy' } };
async function legacyGame(transform = () => {}, attack = []) {
  return make({ attack, transform: (defs) => {
    Object.assign(def(defs, 'base').mechanics, { prizeCount: 2, ruleBox: true });
    def(defs, 'double').mechanics.effects = [binding('cn.prizeModifier@1', legacy, 'legacy')];
    def(defs, 'double').deckLimits.sameName = null;
    transform(defs);
  } });
}
async function withLegacy(transform, attack) {
  const f = await legacyGame(transform, attack);
  f.deck = f.deck.map((id, i) => i >= 50 ? 'printing:double' : id);
  return f;
}
const used = (g, owner = 1) => g.snapshot().players[owner].used['ko.prize-modifier-once:legacy-energy'];

test('「对战中，自己的「遗赠能量」的这个效果，只会生效1次」: one reduction for the player\'s whole game', async () => {
  const valid = (p) => handlers.get('cn.prizeModifier@1').validateParameters(p);
  assert(valid(legacy)); assert(!valid({ effect: { ...legacy.effect, oncePerGame: '' } }));
  const f = await withLegacy();
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'double');
    attached(s, 1, bench(s, 1, 'base'), 'double');
  });
  const turn = g.snapshot().turn;
  command(g, { type: 'attack', attackId: 'base:bite' });
  assert.equal(taken(g), 1, '2 − 1.');
  assert.deepEqual(used(g), [turn]);
  assert(g.snapshot().events.some((e) => e.ruleId === 'ko.prize-modifier-once' && e.data.key === 'legacy-energy'));
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  command(g, { type: 'endTurn' }); settle(g);
  command(g, { type: 'attack', attackId: 'base:bite' });
  assert.equal(taken(g), 3, 'Its second Legacy Energy no longer reduces anything.');
  // Two on one Pokémon: one reduction.
  assert.equal(taken(knockOut(f, (s) => { attached(s, 1, s.players[1].active, 'double'); attached(s, 1, s.players[1].active, 'double'); })), 1);
  // Another effect takes every Prize away: the Legacy Energy still counted as applied (JP Q&A レガシーエネルギー×メガゲンガーex).
  const shielded = await withLegacy((defs) => { def(defs, 'tool').mechanics.effects = [binding('cn.prizeModifier@1',
    { effect: { op: 'prizeModifier', scope: 'self', none: true } }, 'none')]; });
  const h = knockOut(shielded, (s) => { attached(s, 1, s.players[1].active, 'double'); equip(s, 1, s.players[1].active); });
  assert.equal(taken(h), 0); assert(used(h));
});

test('a once-only reduction is not applied when nothing counted it, and not guessed between two Knock Outs', async () => {
  const f = await withLegacy();
  // Knocked Out in the checkup by poison, not by the opponent's attack: not applied.
  const g = board(f, (s) => {
    attached(s, 1, s.players[1].active, 'double'); bench(s, 1, 'other');
    s.players[1].active.counters = 9; s.players[1].active.conditions.poison = 1;
  });
  command(g, { type: 'endTurn' }); settle(g);
  assert.equal(6 - g.snapshot().players[0].prizes.length, 2); assert.equal(used(g), undefined);
  const spread = await withLegacy(() => {}, [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'all' }, options: {} })]);
  assert.throws(() => knockOut(spread, (s) => {
    attached(s, 1, s.players[1].active, 'double'); attached(s, 1, s.players[1].bench[0], 'double');
  }), (e) => e.code === 'unresolved-prize-once');
  assert.equal(taken(knockOut(spread, (s) => { attached(s, 1, s.players[1].active, 'double'); })), 2 + 1 - 1, 'Only one of them has it.');
});
