// Synthetic mechanism boards exercise the machine builder and the exact certified text programs, not real-card
// approvals. The final tests independently exercise real committed/released cards with explicitly fixture decks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { certifyEffectText, certifyCandidate } from '../../scripts/effect-certificates.mjs';
import { mechanismEffectProof } from '../../scripts/effect-mechanism-certificates.mjs';
import { reviewedEffectProof, reviewedProgramEvidence } from '../../scripts/reviewed-effect-certificates.mjs';
import { buildEffectGold } from '../../scripts/effect-gold.mjs';
import { machinePokemon, machineTrainer, machineSpecialEnergy, libraryEvidence, bindMachineEffects }
  from '../../catalog/zh-CN/V20261019/machine.mjs';
import { fixture, board, bench, attached, hand, command, settle, answer, fixtureClock } from '../official-rules/fixtures.mjs';
import { OfficialGame } from '../../public/rules/game.js';
import { randomIndex } from '../../public/rules/random.js';
import { loadRelease } from '../../server/catalog.mjs';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { createAI } from '../../public/cn/ai.js';
import { OPEN_FORMAT } from '../../catalog/zh-CN/V20261019/index.mjs';
import effects from '../../catalog/zh-CN/V20261019/library/machine/effects.json' with { type: 'json' };

const ev = libraryEvidence({ dir: 'TEST/001', mik: 'TEST/001' });
const u = (text, kind = 'attack', extra = {}) => ({ kind, text, card: { name: '机制测试', category: 'item' },
  attack: { name: '机制招式', cost: '', damage: '20' }, ...extra });
const certified = (unit) => {
  const key = 'cn:ability:machine-test';
  const proof = certifyEffectText(unit, key) ?? reviewedEffectProof(unit, key) ?? mechanismEffectProof(unit, key, certifyEffectText);
  assert.ok(proof, unit.text);
  const checked = certifyCandidate(unit, proof.result, proof.result, key);
  assert.ok(checked, unit.text); return checked.result;
};
const face = { name: '机制测试', nameKey: 'base', stage: 'basic', type: '水', hp: 300, weakness: null, resistance: null,
  retreat: 1, ruleBox: null, tags: [] };
async function attackFixture(text, damage = 20) {
  return fixture((defs) => {
    const printed = damage === null ? '' : typeof damage === 'number' ? String(damage)
      : `${damage.value}${{ plus: '+', times: '×', minus: '-', fixed: '' }[damage.operator]}`;
    defs[0] = machinePokemon('base', { ...face, resolveProgramEvidence: reviewedProgramEvidence,
      attacks: [{ name: '机制招式', cost: '', damage, translation: certified(u(text, 'attack', {
        attack: { name: '机制招式', damage: printed, cost: '' },
      })) }] }, ev);
  });
}
function attack(game) { command(game, { type: 'attack', attackId: 'base:a1' }, 0); settle(game); }
function roundtrip(game, catalog) { assert.deepEqual(OfficialGame.restore(game.snapshot(), { catalog }).snapshot(), game.snapshot()); }
function forceCoin(s, face) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (face === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}

test('unit-local IDs bind to the correct attack, all evidence is expanded and unknown name/cross-unit placeholders fail', () => {
  const r = { effects: [['cost', 'cn.countedEnergyDiscard@1', { effectId: 'DEF:a:cost', evidence: 'CARD_EVIDENCE', names: ['NAME:测试'] }]] };
  const bound = bindMachineEffects('cn:test', 'a2', r, ev, (n) => n === '测试' ? 'test' : null);
  assert.equal(bound[0].effectId, 'cn:test:a2:cost');
  assert.equal(bound[0].parameters.effectId, 'cn:test:a2:cost');
  assert.deepEqual(bound[0].parameters.evidence, ev);
  assert.deepEqual(bound[0].parameters.names, ['test']);
  assert.throws(() => bindMachineEffects('cn:test', 'a2', r, ev), /Unresolved effect name/);
  assert.throws(() => bindMachineEffects('cn:test', 'b1', r, ev), /cross-unit/);
  assert.equal(r.effects[0][2].effectId, 'DEF:a:cost', 'Never mutate the source/cached translation.');
});

test('machine attack draws the exact count and printed damage remains automatic', async () => {
  const f = await attackFixture('从自己的牌库上方抽取2张卡牌。'), g = board(f);
  const before = g.snapshot().players[0].hand.length;
  attack(g);
  assert.equal(g.snapshot().players[0].hand.length, before + 2);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  roundtrip(g, f.catalog);
});

test('recoil hits the user separately; healing never heals the opposing Active', async () => {
  const f = await attackFixture('给这只宝可梦也造成30伤害。'), g = board(f);
  attack(g);
  assert.equal(g.snapshot().players[0].active.counters, 3);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  const h = await attackFixture('回复这只宝可梦「30」HP。'), healed = board(h, (s) => { s.players[0].active.counters = 5; });
  attack(healed);
  assert.equal(healed.snapshot().players[0].active.counters, 2);
  assert.equal(healed.snapshot().players[1].active.counters, 2);
  roundtrip(healed, h.catalog);
});

test('paralysis is applied to the opposing Active, with heads and tails tested independently', async () => {
  for (const face of ['heads', 'tails']) {
    const f = await attackFixture('抛掷1次硬币如果为正面，则使对手的战斗宝可梦陷入【麻痹】状态。');
    const g = board(f, (s) => forceCoin(s, face)); attack(g);
    assert.equal(g.snapshot().players[1].active.conditions.rotation, face === 'heads' ? 'paralyzed' : null);
    assert.equal(g.snapshot().players[0].active.conditions.rotation, null);
    assert.equal(g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin').data.result, face);
    roundtrip(g, f.catalog);
  }
  const f = await attackFixture('使对手的战斗宝可梦陷入【混乱】状态。'), g = board(f); attack(g);
  assert.equal(g.snapshot().players[1].active.conditions.rotation, 'confused');
});

test('coin formula uses all three flips and replaces, rather than adds to, the printed multiplier', async () => {
  const f = await attackFixture('抛掷3次硬币，造成正面次数×20伤害。', { value: 20, operator: 'times' });
  const g = board(f), rng = [...g.snapshot().rng];
  const heads = Array.from({ length: 3 }, () => randomIndex(rng, 2)).filter((v) => v === 0).length;
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, heads * 2);
  roundtrip(g, f.catalog);
});

test('guard applies during the next opposing turn, whereas attack and retreat locks affect only their named action', async () => {
  const f = await attackFixture('在下一个对手的回合，这只宝可梦所受到的招式的伤害「-30」。'), g = board(f);
  attack(g);
  command(g, { type: 'attack', attackId: 'base:a1' }, 1); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0, '20 damage minus 30 is zero.');
  const locked = await attackFixture('在下一个自己的回合，这只宝可梦无法使用招式。'), a = board(locked);
  attack(a); command(a, { type: 'endTurn' }, 1); settle(a);
  assert.equal(a.view(0).legalActions.some((x) => x.type === 'attack'), false);
  const retreat = await attackFixture('在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。');
  const b = board(retreat, (s) => { bench(s, 1, 'other'); attached(s, 1, s.players[1].active, 'water'); });
  attack(b);
  assert.equal(b.view(1).legalActions.some((x) => x.type === 'retreat'), false);
  assert.equal(b.view(1).legalActions.some((x) => x.type === 'attack'), true);
  roundtrip(b, retreat.catalog);
});

test('search reveals/retrieves exactly one card and bench deployment respects the printed up-to quantity', async () => {
  const f = await attackFixture('选择自己牌库中的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。'), g = board(f);
  const before = g.snapshot().players[0].hand.length; attack(g);
  // Hidden-zone searches permit failure; make an explicit successful selection in a second board.
  const successful = board(f); command(successful, { type: 'attack', attackId: 'base:a1' }, 0);
  settle(successful, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  assert.equal(successful.snapshot().players[0].hand.length, before + 1);
  const b = await attackFixture('选择自己牌库中最多2张【基础】宝可梦，放于备战区。并重洗牌库。'), deployed = board(b);
  command(deployed, { type: 'attack', attackId: 'base:a1' }, 0);
  settle(deployed, (q) => q.options.slice(0, Math.min(q.maximum, 2)));
  assert.equal(deployed.snapshot().players[0].bench.length, 2);
  roundtrip(deployed, b.catalog);
});

test('gust and own switch target different players, and all-bench damage does not hit the Active', async () => {
  for (const [text, side] of [['选择对手的1只备战宝可梦，将其与战斗宝可梦互换。', 1], ['将自己的战斗宝可梦与备战宝可梦互换。', 0]]) {
    const f = await attackFixture(text), g = board(f, (s) => { bench(s, side, 'other'); });
    const old = g.snapshot().players[side].active.id; attack(g);
    assert.notEqual(g.snapshot().players[side].active.id, old); roundtrip(g, f.catalog);
  }
  const f = await attackFixture('给对手所有备战宝可梦，也各造成20伤害。'), g = board(f, (s) => { bench(s, 1, 'other'); });
  attack(g); assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[1].bench[0].counters, 2);
});

test('activated machine Ability is once per Pokémon per turn, and the Active-only condition is executable', async () => {
  const text = '如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。从自己的牌库上方抽取1张卡牌。';
  const f = await fixture((defs) => {
    defs[0] = machinePokemon('base', { ...face, attacks: [{ name: '撞击', cost: '', damage: 20 }],
      abilities: [{ name: '机制特性', translation: certified(u(text, 'ability')) }] }, ev);
  });
  const g = board(f, (s) => { bench(s, 0, 'base'); }), before = g.snapshot().players[0].hand.length;
  const actions = g.view(0).legalActions.filter((a) => a.type === 'useAbility');
  assert.equal(actions.length, 1, 'The Benched copy cannot use the Active-only Ability.');
  command(g, actions[0], 0); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before + 1);
  assert.equal(g.view(0).legalActions.some((a) => a.type === 'useAbility'), false);
  roundtrip(g, f.catalog);
});

test('machine Trainer draws/shuffles in play and Special Energy provides two units, not two physical cards', async () => {
  const text = '将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。';
  const f = await fixture((defs) => {
    const i = defs.findIndex((d) => d.definitionId === 'research');
    defs[i] = machineTrainer('research', { name: '机制训练家', nameKey: 'research', category: 'supporter',
      translation: certified(u(text, 'trainer')) }, ev);
    const j = defs.findIndex((d) => d.definitionId === 'double');
    defs[j] = machineSpecialEnergy('double', { name: '机制能量', nameKey: 'double',
      translation: certified(u('这张卡牌，可被视作2个【无】能量。', 'energy')) }, ev);
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); attached(s, 0, s.players[0].active, 'double'); });
  command(g, { type: 'playTrainer', cardId: card }, 0); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 6);
  assert.equal(g.snapshot().players[0].active.energy.length, 1);
  assert.deepEqual(f.catalog.definition('double').mechanics.baseUnits, [['Colorless'], ['Colorless']]);
  roundtrip(g, f.catalog);
});

test('provided-unit discard, return and movement can select one double Energy card for two units', async () => {
  for (const ending of ['放于弃牌区', '放回手牌', '转附于备战宝可梦身上']) {
    const f = await attackFixture(`选择这只宝可梦身上附着的2个能量，${ending}。`);
    let double, water, recipient;
    const g = board(f, (s) => {
      double = attached(s, 0, s.players[0].active, 'double');
      water = attached(s, 0, s.players[0].active, 'water');
      recipient = bench(s, 0, 'other').id;
    });
    command(g, { type: 'attack', attackId: 'base:a1' }, 0);
    assert.ok(g.snapshot().pending.options.includes(double));
    answer(g, [double]); settle(g);
    const p = g.snapshot().players[0];
    assert.deepEqual(p.active.energy, [water]);
    const zone = ending === '放于弃牌区' ? p.discard : ending === '放回手牌' ? p.hand : p.bench.find((m) => m.id === recipient).energy;
    assert.ok(zone.includes(double)); roundtrip(g, f.catalog);
  }
});

test('a reviewed counted-discard formula executes from attack two and counts Basic cards, not provided units', async () => {
  const row = buildEffectGold().units.find((g) => g.expected.effects?.some((e) => e[1] === 'cn.countedEnergyDiscard@1'));
  const f = await fixture((defs) => {
    defs[0] = machinePokemon('base', { ...face, attacks: [
      { name: '无关招式', cost: '', damage: 10 }, { name: row.unit.attack.name, cost: '', damage: { value: 70, operator: 'times' },
        translation: certified(row.unit) },
    ] }, ev);
  });
  let basics, special;
  const g = board(f, (s) => {
    basics = [attached(s, 0, s.players[0].active, 'water'), attached(s, 0, s.players[0].active, 'water')];
    special = attached(s, 0, s.players[0].active, 'double');
  });
  command(g, { type: 'attack', attackId: 'base:a2' }, 0);
  assert.ok(basics.every((c) => g.snapshot().pending.options.includes(c)));
  assert.equal(g.snapshot().pending.options.includes(special), false);
  answer(g, basics); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 14);
  assert.deepEqual(g.snapshot().players[0].active.energy, [special]);
  roundtrip(g, f.catalog);
});

test('independent stat formulas read actual energy units and the attacker counters including the printed base', async () => {
  const f = await attackFixture('追加造成对手战斗宝可梦身上附着的能量数量×50伤害。', { value: 30, operator: 'plus' });
  const g = board(f, (s) => {
    attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'double');
  });
  attack(g); assert.equal(g.snapshot().players[1].active.counters, 18);
  const h = await attackFixture('追加造成这只宝可梦身上放置的伤害指示物数量×10伤害。', { value: 20, operator: 'plus' });
  const other = board(h, (s) => { s.players[0].active.counters = 5; });
  attack(other); assert.equal(other.snapshot().players[1].active.counters, 7);
  roundtrip(other, h.catalog);
});

test('a separate damage packet hits only the selected Bench Pokémon, without a second automatic main packet', async () => {
  const f = await attackFixture('给对手的1只宝可梦，造成50点伤害。[备战宝可梦不计算弱点、抗性。]', null);
  let target;
  const g = board(f, (s) => { target = bench(s, 1, 'other').id; });
  command(g, { type: 'attack', attackId: 'base:a1' }, 0); answer(g, [target]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.equal(g.snapshot().players[1].bench.find((m) => m.id === target).counters, 5);
  roundtrip(g, f.catalog);
});

test('hand-bench triggers can be declined and draw only after acceptance; draw-until Abilities enforce once per turn', async () => {
  const text = '在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。从自己牌库上方抽取2张卡牌。';
  const f = await fixture((defs) => {
    defs[0] = machinePokemon('base', { ...face, attacks: [{ name: '撞击', cost: '', damage: 20 }],
      abilities: [{ name: '触发测试', translation: certified(u(text, 'ability', { ability: { name: '触发测试' } })) }] }, ev);
  });
  for (const perform of [true, false]) {
    let card;
    const g = board(f, (s) => {
      s.players[0].deck.unshift(...s.players[0].hand.splice(0)); card = hand(s, 0, 'base');
    });
    command(g, { type: 'bench', cardId: card }, 0);
    assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    roundtrip(g, f.catalog);
    assert.deepEqual(g.snapshot().pending.options, ['perform', 'skip']);
    answer(g, [perform ? 'perform' : 'skip']); settle(g);
    assert.equal(g.snapshot().players[0].hand.length, perform ? 2 : 0);
  }
  const h = await fixture((defs) => {
    const t = '在自己的回合可以使用1次。从牌库上方抽取卡牌，直到自己的手牌变为3张为止。';
    defs[0] = machinePokemon('base', { ...face, attacks: [{ name: '撞击', cost: '', damage: 20 }],
      abilities: [{ name: '抽牌测试', translation: certified(u(t, 'ability', { ability: { name: '抽牌测试' } })) }] }, ev);
  });
  const g = board(h, (s) => { s.players[0].deck.unshift(...s.players[0].hand.splice(0)); });
  command(g, g.view(0).legalActions.find((a) => a.type === 'useAbility'), 0); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 3);
  assert.equal(g.view(0).legalActions.some((a) => a.type === 'useAbility'), false);
  roundtrip(g, h.catalog);
});

test('a borrowed named cost reduction affects the named second attack, not the first attack', async () => {
  const row = buildEffectGold().units.find((g) => g.unit.kind === 'ability' && g.unit.text.includes('「血月」'));
  const f = await fixture((defs) => {
    defs[0] = machinePokemon('base', { ...face, attacks: ['无关招式', '血月'].map((name) => ({ name, cost: '无无无无无', damage: 100 })),
      abilities: [{ name: row.unit.ability.name, translation: certified(row.unit) }] }, ev);
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 0, s.players[0].active, 'water');
    s.players[1].deck.unshift(...s.players[1].prizes.splice(3));
  });
  const available = g.view(0).legalActions.filter((a) => a.type === 'attack').map((a) => a.attackId);
  assert.equal(available.includes('base:a1'), false); assert.equal(available.includes('base:a2'), true);
  command(g, { type: 'attack', attackId: 'base:a2' }, 0); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 10);
  roundtrip(g, f.catalog);
});

test('a separately checked Tera rule protects only Bench attack damage, not Active damage or counters', async () => {
  const f = await fixture((defs) => {
    defs[0] = machinePokemon('base', { ...face, ruleBox: 'ex', tera: true, attacks: [{ name: '机制攻击', cost: '', damage: 20,
      translation: { effects: [
        ['bench-damage', 'cn.damage@1', { side: 'opponent', target: 'bench', amount: 20, selection: { kind: 'all' }, options: {} }],
        ['bench-counters', 'cn.counters@1', { side: 'opponent', target: 'bench', count: 1 }],
      ] } }] }, ev);
  });
  let target;
  const g = board(f, (s) => { target = bench(s, 1, 'base').id; });
  assert.ok(f.catalog.definition('base').mechanics.tags.includes('Tera'));
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[1].bench.find((m) => m.id === target).counters, 1);
  roundtrip(g, f.catalog);
});

test('a real released Greninja ex evolves from Froakie with Rare Candy after the accepted ancestry fix', async () => {
  const release = await loadRelease(), index = await release.index(), open = (e) => e.formats.some((f) => f.format.id === 'open' && f.legal);
  const basic = index.entries.find((e) => e.printingId === 'zh-Hans:CSVSC:015/066');
  const evolved = index.entries.find((e) => e.printingId === 'zh-Hans:CSVSC:017/066');
  const candy = index.entries.find((e) => e.card.name === '神奇糖果' && e.tier === 'reviewed' && open(e));
  const energy = index.entries.find((e) => e.card.kind === 'energy' && e.card.category === 'basic' && e.card.types.includes('Water') && open(e));
  assert.ok(basic && evolved && candy && energy && open(basic) && open(evolved));
  const deck = [basic, evolved, candy].flatMap((p) => Array(4).fill(p.printingId)).concat(Array(48).fill(energy.printingId));
  const { game, catalog } = await createReviewedGame({ release, decks: [deck, deck], seed: [7, 8, 9, 10], format: OPEN_FORMAT, matchMode: 'normal' });
  assert.equal(catalog.definitionFor(evolved.printingId).mechanics.basicAncestor.nameKey, basic.card.nameKey);
  assert.equal(catalog.definitionFor(evolved.printingId).implementation.tier, 'machine');
  settle(game);
  const s = game.snapshot();
  for (const [owner, p] of s.players.entries()) {
    for (const m of [p.active, ...p.bench].filter(Boolean)) p.hand.push(...m.stack, ...m.energy, ...m.tools);
    p.active = null; p.bench = [];
    p.active = bench(s, owner, basic.definitionId); p.bench.pop();
    p.deck.unshift(...p.hand.splice(0));
  }
  fixtureClock(s); s.phase = 'main';
  const item = hand(s, 0, candy.definitionId); hand(s, 0, evolved.definitionId);
  const g = OfficialGame.restore(s, { catalog }), oldId = s.players[0].active.id;
  command(g, { type: 'playTrainer', cardId: item }, 0);
  settle(g, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  const now = g.snapshot(), active = now.players[0].active;
  assert.equal(active.id, oldId); assert.equal(active.stack.length, 2);
  assert.equal(now.cards[active.stack.at(-1)].definitionId, evolved.definitionId);
  roundtrip(g, catalog);
});

test('released effect cards keep machine quality and complete CPU games restore deterministically', async () => {
  const release = await loadRelease(), index = await release.index();
  const available = index.entries.filter((e) => e.tier === 'machine' && e.definitionId.startsWith('cn:machine:')
    && e.card.kind === 'pokemon' && e.card.stage === 'basic'
    && !e.card.ruleBox && e.formats.some((f) => f.format.id === 'open' && f.legal));
  const byPrinting = new Map(effects.units.flatMap((e) => e.unit.uses.map((id) => [id, e.family])));
  const usedNames = new Set(), samples = [];
  for (const family of ['draw', 'recoil', 'condition', 'coin-condition', 'guard', 'coin-damage']) {
    const p = available.find((p) => byPrinting.get(p.printingId) === family && !usedNames.has(p.card.nameKey)
      && p.card.attacks.some((a) => a.cost.every((t) => ['Lightning', 'Colorless'].includes(t))));
    assert.ok(p, `A real released ${family} printing must be exercised.`);
    usedNames.add(p.card.nameKey); samples.push(p);
  }
  // Explicit simulation fixtures, not a claimed tournament or product decklist.
  for (const seed of [[3, 1, 4, 1], [7, 8, 9, 10], [19, 23, 31, 47]]) {
    const deck = [...samples.flatMap((p) => Array(4).fill(p.printingId)), ...Array(36).fill('zh-Hans:CSVE1C:LIG')];
    let { game, catalog } = await createReviewedGame({ release, decks: [deck, deck], seed, format: OPEN_FORMAT, matchMode: 'normal' });
    for (const p of samples) {
      const d = catalog.definitionFor(p.printingId);
      assert.equal(d.implementation.tier, 'machine');
      assert.ok(d.implementation.testIds.includes('tests/cn-cards/machine-effects.test.mjs'));
      assert.ok(d.mechanics.attacks.some((a) => a.effects.length > 0));
    }
    const ai = createAI(catalog);
    for (let steps = 0; !game.snapshot().result; steps++) {
      assert.ok(steps < 4000, 'Certified-effects fixture game terminates.');
      const s = game.snapshot(), player = s.pending?.player ?? s.current, view = game.view(player);
      const before = game.snapshot(), action = ai(view, player);
      const restored = OfficialGame.restore(before, { catalog });
      game.dispatch({ player, expectedRevision: view.revision, action });
      restored.dispatch({ player, expectedRevision: view.revision, action });
      assert.deepEqual(restored.snapshot(), game.snapshot(), 'Every move replays from the exact same saved state.');
      if (steps === 20) {
        const saved = await restoreReviewedGame({ release, snapshot: game.snapshot() });
        assert.deepEqual(saved.game.snapshot(), game.snapshot()); game = saved.game;
      }
    }
  }
});
