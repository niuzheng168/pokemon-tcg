// Synthetic definitions only. 「如果身上放有这张卡牌的宝可梦的弱点的属性，和对手的战斗宝可梦的属性相同的话，则身上放有这张卡牌的宝可梦所使用的
// 招式，给对手的战斗宝可梦造成的伤害「+30」。」 (damage.weakness-type); 「身上放有这张卡牌的「宝可梦VMAX」的最大HP会减少「100」点，当该宝可梦，
// 受到对手宝可梦的招式的伤害而【昏厥】时，对手拿取的奖赏卡将减少1张。（当将这张卡牌从手牌使出放于宝可梦身上时，如果会导致该宝可梦【昏厥】的话，
// 则无法放于该宝可梦身上。）」 (tools.hand-attach-except). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateCardDefinition } from '../../public/rules/schema-validators.js';
import { fixture, binding, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const toolOn = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };
const stadium = (s) => { const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id; };
const activeAs = (s, owner, id) => { const p = s.players[owner]; p.hand.push(...p.active.stack); p.active = bench(s, owner, id); p.bench.pop(); };
const property = (value) => [binding('cn.property@1', { effect: { op: 'property', field: 'weakness', value, scope: 'own' } }, 'weakness')];

const gloves = { field: 'attackDamage', amount: 30, scope: 'self', targetSide: 'opponent', targetPosition: 'active', otherTypeIsWeakness: true };
// The holder (Water, Weakness Fire) attacks for 20; 「other」 is a Grass and Fire Pokémon (Weakness Fire).
async function glovesFixture(weakness) {
  return fixture((defs) => {
    def(defs, 'tool').mechanics.effects = [binding('cn.modifier@1', gloves, 'gloves')];
    def(defs, 'other').mechanics.types = ['Grass', 'Fire'];
    if (weakness !== undefined) def(defs, 'stadium').mechanics.effects = property(weakness);
  });
}
function strikeWithGloves(f, opponent, withStadium = false) {
  const g = board(f, (s) => {
    toolOn(s, 0, s.players[0].active); attached(s, 0, s.players[0].active, 'water');
    if (opponent !== 'base') activeAs(s, 1, opponent);
    if (withStadium) stadium(s);
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  return { g, counters: g.snapshot().players[1].active.counters };
}

test('「弱点的属性，和对手的战斗宝可梦的属性相同的话」: a current type of the damaged Active against the holder\'s current Weakness', async () => {
  const valid = handlers.get('cn.modifier@1').validateParameters;
  assert(valid(gloves));
  for (const field of ['hp', 'retreat', 'defenseDamage']) assert(!valid({ field, amount: field === 'retreat' ? 1 : 30, scope: 'self', otherTypeIsWeakness: true }), field);
  assert(!valid({ ...gloves, otherTypeIsWeakness: false }));
  const f = await glovesFixture();
  assert.equal(strikeWithGloves(f, 'base').counters, 2, 'A Water Active is not the holder\'s Fire Weakness type.');
  const { g, counters } = strikeWithGloves(f, 'other');
  assert.equal(counters, 5, 'Grass and Fire: one of its types is the holder\'s Weakness type (属性相同 as in the Weakness step).');
  restore(g, f);
  // The holder's Weakness now: changed to Water by its own side's Stadium, or removed.
  const water = await glovesFixture({ type: 'Water', operation: 'multiply', value: 2 });
  assert.equal(strikeWithGloves(water, 'base', true).counters, 5, 'Weak to Water now: the Water Active matches; it keeps its own Fire Weakness.');
  assert.equal(strikeWithGloves(water, 'other', true).counters, 2, 'The printed Fire Weakness no longer counts.');
  const none = await glovesFixture(null);
  assert.equal(strikeWithGloves(none, 'other', true).counters, 2, 'No Weakness: no type can match.');
});

// The Tool lowers 「base」's maximum HP by 50, so it cannot be played onto a 「base」 with 50 HP or less remaining.
const except = { selector: { kind: 'pokemon', nameKeys: ['base'] }, state: { remainingHpAtMost: 50 } };
async function medalFixture(transform = () => {}) {
  return fixture((defs) => {
    Object.assign(def(defs, 'hp-tool').mechanics, { handAttachExcept: except, effects: [
      binding('cn.modifier@1', { field: 'hp', amount: -50, scope: 'self', targetSelector: except.selector }, 'medal'),
    ] });
    transform(defs);
  });
}
const medalIn = (g) => g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'hp-tool');
const playable = (g) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === medalIn(g));

test('「如果会导致该宝可梦【昏厥】的话，则无法放于该宝可梦身上」: only Pokémon its own decrease would not Knock Out, judged now', async () => {
  const card = (d) => validateCardDefinition(d);
  const f = await medalFixture();
  assert(card(f.catalog.definition('hp-tool')));
  assert(!card({ ...f.catalog.definition('potion'), mechanics: { ...f.catalog.definition('potion').mechanics, handAttachExcept: except } }), 'A Tool only.');
  assert(!card({ ...f.catalog.definition('hp-tool'), mechanics: { ...f.catalog.definition('hp-tool').mechanics, handAttachExcept: {} } }));
  let same, other;
  const g = board(f, (s) => {
    hand(s, 0, 'hp-tool'); s.players[0].active.counters = 5;
    same = bench(s, 0, 'base'); same.counters = 4; other = bench(s, 0, 'other'); other.counters = 9;
  });
  assert(playable(g));
  command(g, { type: 'playTrainer', cardId: medalIn(g) });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'tool-target');
  assert.deepEqual(q.options, [same.id, other.id], 'Not the Active 「base」 with 50 HP left; another name is not lowered.');
  const r = restore(g, f);
  settle(r, () => [same.id]);
  const placed = r.snapshot().players[0].bench.find((m) => m.id === same.id);
  assert.equal(placed.tools.length, 1);
  assert.equal(r.view(0).players[0].bench.find((m) => m.id === same.id).effective.maxHp, 50, 'Its own decrease applies once attached.');
  assert(r.snapshot().events.some((e) => e.ruleId === 'turn.tool'));
  restore(r, f);
});

test('no Pokémon it could go on: not playable, also while Tool effects are removed (JP Q&A); a Pokémon above the limit can take it', async () => {
  const f = await medalFixture();
  const g = board(f, (s) => { hand(s, 0, 'hp-tool'); s.players[0].active.counters = 5; });
  assert(!playable(g));
  assert.throws(() => command(g, { type: 'playTrainer', cardId: medalIn(g) }), /not legal/);
  const jammed = await medalFixture((defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }, 'jam')];
  });
  const blocked = board(jammed, (s) => { hand(s, 0, 'hp-tool'); stadium(s); s.players[0].active.counters = 5; });
  assert(!playable(blocked), 'Judged as printed: the removed decrease still names it.');
  const open = board(jammed, (s) => { hand(s, 0, 'hp-tool'); stadium(s); s.players[0].active.counters = 4; });
  command(open, { type: 'playTrainer', cardId: medalIn(open) }); settle(open);
  const active = open.snapshot().players[0].active;
  assert.equal(active.tools.length, 1);
  assert.equal(open.view(0).players[0].active.effective.maxHp, 100, 'Its effect is removed once attached.');
  restore(open, jammed);
});
