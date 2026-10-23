// Independent text-to-program checks. The real snapshot is tested without local model outputs or paid APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../catalog/zh-CN/V20261019/library/machine/effects.json' with { type: 'json' };
import ledger from '../catalog/zh-CN/V20261019/library/machine/effect-reviews.json' with { type: 'json' };
import { certifyEffectText, certifyCandidate, canonicalEffectResult } from '../scripts/effect-certificates.mjs';
import { unitOf } from '../scripts/effect-units.mjs';
import { REVIEW_FAMILY, reviewLedger, reviewedConsensusProof } from '../scripts/effect-review-certificates.mjs';
import { check } from '../scripts/effect-validate.mjs';
import { checkMachineRuleBox, applyRuleBoxOverride } from '../scripts/machine-rule-boxes.mjs';

const unit = (text, kind = 'attack', extra = {}) => ({ kind, text, card: { name: '测试', category: 'item' },
  attack: { name: '测试', cost: '水', damage: '20' }, ...extra });
const params = (u) => certifyEffectText(u)?.result.effects[0][2];

test('draw, recoil, healing and Special Conditions read the full text and the exact amount/side', () => {
  assert.deepEqual(params(unit('从自己的牌库上方抽取3张卡牌。')), { count: 3 });
  assert.deepEqual(params(unit('给这只宝可梦也造成30点伤害。')), {
    side: 'own', target: 'self', amount: 30, selection: { kind: 'all' }, options: {},
  });
  assert.deepEqual(params(unit('回复这只宝可梦「30」HP。')), { target: 'self', amount: 30 });
  for (const [name, condition] of [['睡眠', 'asleep'], ['麻痹', 'paralyzed'], ['混乱', 'confused'], ['中毒', 'poisoned'], ['灼伤', 'burned']])
    assert.deepEqual(params(unit(`使对手的战斗宝可梦陷入【${name}】状态。`)), { side: 'opponent', condition });
  assert.equal(certifyEffectText(unit('给对手也造成30点伤害。')), null);
});

test('coins, temporary damage prevention, attack/retreat locks and switch ownership stay distinct', () => {
  assert.deepEqual(params(unit('抛掷1次硬币如果为反面，则使对手的战斗宝可梦陷入【麻痹】状态。')), {
    outcome: 'tails', effect: { handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: 'paralyzed' } },
  });
  assert.deepEqual(params(unit('在下一个对手的回合，这只宝可梦所受到的招式的伤害「-30」。')), {
    side: 'own', target: 'self', effect: { op: 'modifier', field: 'defenseDamage', amount: -30, scope: 'all' },
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
  });
  assert.equal(params(unit('在下一个自己的回合，这只宝可梦无法使用招式。')).duration, 'nextOwnTurn');
  assert.deepEqual(params(unit('在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。')).effect.actions, ['retreat']);
  assert.deepEqual(params(unit('选择对手的1只备战宝可梦，将其与战斗宝可梦互换。')), { side: 'opponent', chooser: 'self', affected: 'selected' });
  assert.deepEqual(params(unit('将自己的战斗宝可梦与备战宝可梦互换。')), { side: 'own', chooser: 'self', affected: 'active' });
  const coins = params(unit('抛掷3次硬币，造成正面次数×20伤害。'));
  assert.equal(coins.rolls[0].spec.count, 3); assert.equal(coins.expression.left.value, 20);
  assert.deepEqual(params(unit('给对手所有备战宝可梦，也各造成20伤害。')).selection, { kind: 'all' });
});

test('searches distinguish exact/up-to, visible discard recovery, hidden search, bench deployment and shuffling', () => {
  assert.deepEqual(params(unit('选择自己牌库中最多2张【基础】宝可梦，放于备战区。并重洗牌库。')), {
    from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
    quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true,
  });
  assert.deepEqual(params(unit('选择自己弃牌区中的1张基本能量，在给对手看过之后，加入手牌。')), {
    from: 'discard', to: 'hand', selector: { kind: 'energy', category: 'basic' },
    quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false,
  });
  assert.equal(params(unit('选择自己弃牌区中最多2张支援者，放回牌库并重洗牌库。')).shuffleAfter, true);
  for (const text of ['选择自己牌库中的1张宝可梦，放于备战区。并重洗牌库。',
    '选择自己牌库中的1张宝可梦，在给对手看过之后，加入手牌。',
    '选择对手牌库中的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。'])
    assert.equal(certifyEffectText(unit(text)), null, text);
});

test('Ability mode/usage/Active condition and Energy units are independent of model spellings', () => {
  const u = unit('如果这只宝可梦在战斗场上的话，则在自己的回合可以使用1次。从自己的牌库上方抽取1张卡牌。', 'ability',
    { ability: { name: '测试特性' } });
  const r = certifyEffectText(u, 'cn:ability:test').result;
  assert.equal(r.mode, 'activated'); assert.deepEqual(r.condition, { sourceActive: true });
  assert.deepEqual(r.usage, { period: 'turn', scope: 'pokemon', key: 'cn:ability:test', limit: 1 });
  assert.equal(certifyEffectText(u), null);
  assert.deepEqual(certifyEffectText(unit('这张卡牌，可被视作2个【无】能量。', 'energy')).result.baseUnits, [['Colorless'], ['Colorless']]);
  assert.equal(certifyEffectText(unit('在自己的回合可以使用1次。从自己的牌库上方抽取1张卡牌。如果已经使用其他的「测试」则不能使用。', 'ability'), 'key'), null);
});

test('no partial certification: extra clauses, optionality, wrong side/amount or a single disagreeing model fail closed', () => {
  const u = unit('从自己的牌库上方抽取2张卡牌。'), good = certifyEffectText(u).result;
  assert.ok(certifyCandidate(u, good, good));
  for (const suffix of ['然后，令这只宝可梦昏厥。', '在下一个自己的回合无法使用招式。'])
    assert.equal(certifyCandidate({ ...u, text: u.text + suffix }, good, good), null);
  assert.equal(certifyEffectText(unit('若希望，可从自己的牌库上方抽取2张卡牌。')), null);
  const bad = structuredClone(good); bad.effects[0][2].count = 1;
  assert.equal(certifyCandidate(u, good, bad), null);
  assert.equal(certifyCandidate(u, { status: 'unsupported' }, good), null);
  assert.equal(certifyEffectText(unit('给这只宝可梦也造成30伤害。', 'trainer')), null);
  assert.equal(certifyEffectText(unit('从自己牌库上方抽取2张卡牌。', 'trainer', { card: { category: 'tool' } })), null);
});

test('canonical comparison alpha-renames only local references/rolls, not arbitrary keys, ordering or parameters', () => {
  const r = { status: 'ok', effects: [
    ['discard', 'cn.countedEnergyDiscard@1', { count: 1 }],
    ['damage', 'cn.damageValue@1', { expression: { kind: 'effectCards', effectId: 'DEF:a:discard' } }],
  ] };
  const renamed = structuredClone(r); renamed.effects[0][0] = 'cost'; renamed.effects[1][2].expression.effectId = 'DEF:a:cost';
  assert.equal(canonicalEffectResult(r), canonicalEffectResult(renamed));
  renamed.effects[1][2].expression.effectId = 'DEF:a:missing';
  assert.notEqual(canonicalEffectResult(r), canonicalEffectResult(renamed));
  const coin = certifyEffectText(unit('抛掷3次硬币，造成正面次数×20伤害。')).result;
  const other = structuredClone(coin); other.effects[0][2].rolls[0].key = 'x'; other.effects[0][2].expression.right.key = 'x';
  assert.equal(canonicalEffectResult(coin), canonicalEffectResult(other));
  other.effects[0][2].expression.right.key = 'missing';
  assert.notEqual(canonicalEffectResult(coin), canonicalEffectResult(other));
  assert.notEqual(canonicalEffectResult({ status: 'ok', effects: [], condition: { key: 'a' } }),
    canonicalEffectResult({ status: 'ok', effects: [], condition: { key: 'b' } }));
});

test('every committed candidate retains its full identity, semantic certificate, model provenance and executable shape', () => {
  const families = {}, reviews = reviewLedger(ledger);
  for (const row of snapshot.units) {
    const { uid, ...identity } = row.unit;
    assert.equal(uid, unitOf(identity).uid);
    const proof = row.family === REVIEW_FAMILY ? reviewedConsensusProof(row.unit, row.result, reviews)
      : certifyCandidate(row.unit, row.result, row.result, row.result.usage?.key);
    assert.equal(proof?.family, row.family, uid);
    assert.deepEqual(proof.reviewed, row.reviewed, uid);
    assert.equal(check(row.unit, row.result).valid, true, uid);
    assert.deepEqual(row.models.map((m) => m.alias), ['astra', 'sol']);
    for (const m of row.models) assert.match(m.resultSha256, /^[a-f0-9]{64}$/);
    families[row.family] = (families[row.family] ?? 0) + 1;
  }
  assert.deepEqual(families, snapshot.families);
  assert.ok(snapshot.units.length > 0);
});

test('whole-card gate reads both rule boxes, even when metadata forgot Tera/ACE SPEC or an effect was certified', () => {
  const reads = (a, b = a) => [{ rule_text: a }, { rule_text: b }];
  const mon = { kind: 'pokemon', name: '测试ex' }, prize = 'ex规则：当宝可梦ex昏厥时，对手将拿取2张奖赏卡。';
  assert.equal(checkMachineRuleBox(mon, reads(prize)).valid, true);
  for (const text of ['', `${prize}太晶：只要这只宝可梦处于备战区，就不会受到招式的伤害。`,
    '当宝可梦ex昏厥时，对手将拿取3张奖赏卡。', '当宝可梦ex□□时，对手将拿取2张奖赏卡。'])
    assert.equal(checkMachineRuleBox(mon, reads(prize, text)).valid, false);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '普通宝可梦' }, reads('')).valid, true);
  assert.equal(checkMachineRuleBox(mon, [{ rule_text: prize }]).valid, false);
  const item = { kind: 'trainer', name: '测试', category: 'item' }, reminder = '在自己的回合可以使用任意张物品卡。';
  assert.equal(checkMachineRuleBox(item, reads(reminder)).valid, true);
  assert.equal(checkMachineRuleBox(item, reads(`在1副卡组中只能放入1张ACE SPEC卡。${reminder}`)).valid, false);
  assert.equal(checkMachineRuleBox({ ...item, aceSpec: true }, reads(`在1副卡组中只能放入1张ACE SPEC卡。${reminder}`)).valid, true);
  assert.equal(checkMachineRuleBox({ ...item, aceSpec: true }, reads(reminder)).valid, false);
  assert.equal(checkMachineRuleBox({ kind: 'energy', name: '测试' }, reads('')).valid, true);
  assert.equal(checkMachineRuleBox({ kind: 'energy', name: '测试' }, reads('棱镜之星规则')).valid, false);
  const tera = '太晶：只要这只宝可梦，处于备战区，就不会受到招式的伤害。';
  assert.deepEqual(checkMachineRuleBox(mon, reads(tera + prize)), { valid: true, features: { tera: true } });
  assert.equal(checkMachineRuleBox(mon, reads(prize, tera + prize)).valid, false);
  assert.equal(checkMachineRuleBox(mon, reads(tera.replace('太晶：', '') + prize)).valid, false);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试V' }, reads(tera + prize)).valid, false);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试V' }, reads('宝可梦V昏厥时，对手多拿2张奖赏卡。')).valid, false);
  for (const suffix of ['□', '◇', '+']) assert.equal(checkMachineRuleBox(mon, reads(prize + suffix)).valid, false);
  assert.equal(checkMachineRuleBox(mon, reads(prize.replace('2张', '+2张'))).valid, false);
  for (const [name, text] of [['测试GX', 'GX规则：当宝可梦GX昏厥时，对手将拿取2张奖赏卡。'], ['甲&乙GX', 'TAG TEAM规则：当TAG TEAM昏厥时，对手将拿取3张奖赏卡。'],
    ['测试VSTAR', 'VSTAR规则：宝可梦VSTAR昏厥时，对手将拿取2张奖赏卡。']])
    assert.equal(checkMachineRuleBox({ kind: 'pokemon', name }, reads(text)).valid, true, name);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '甲&乙GX' }, reads('当TAG TEAM昏厥时，对手将拿取2张奖赏卡。')).valid, false);
  const tool = { kind: 'trainer', name: '测试', category: 'tool' };
  for (const text of ['在自己的回合，可以将任意张宝可梦道具卡，放于自己的宝可梦身上。每只宝可梦身上只可以放1张宝可梦道具卡，并保持附加状态。',
    `宝可梦道具可以附着在自己的宝可梦身上。每只宝可梦身上只可以附着1张宝可梦道具，并保持附着状态。${reminder}`, reminder, ''])
    assert.equal(checkMachineRuleBox(tool, reads(text)).valid, true, text);
  assert.equal(checkMachineRuleBox(tool, reads('在自己的回合只可以使用1张支援者卡。')).valid, false);
  const stadium = { kind: 'trainer', name: '测试', category: 'stadium' };
  assert.equal(checkMachineRuleBox(stadium, reads('在自己的回合，只可以将1张竞技场卡放到战斗区旁。如果有别的名称的竞技场卡被放入场上，则将此卡放入弃牌区。')).valid, true);
  assert.equal(checkMachineRuleBox(stadium, reads('在自己的回合可以将1张竞技场卡放于战斗场旁。如果有别的竞技场卡被放于场上的话，则将此卡放于弃牌区。无法将同名的竞技场卡放于场上。')).valid, true);
  assert.equal(checkMachineRuleBox(stadium, reads(reminder)).valid, false);
  // Wordings of the same reminders both readers use; a Radiant Pokémon's deck-limit rule.
  assert.equal(checkMachineRuleBox({ kind: 'trainer', name: '测试', category: 'supporter' }, reads('在自己的回合中仅可使用1张支援者卡。', '在自己的回合只可以使用1张支援者')).valid, true);
  assert.equal(checkMachineRuleBox(tool, reads('在自己的回合可以将任意张宝可梦道具卡给予自己的宝可梦身上。每只宝可梦身上只可以给予1张宝可梦道具卡，并保持其状态。')).valid, true);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试V' }, reads('V规则：当宝可梦V昏厥时，对手将拿走2张奖赏卡。')).valid, true);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试V' }, reads('V规则：当宝可梦V昏厥时，对手多拿取2张奖赏卡。')).valid, false);
  const radiant = { kind: 'pokemon', name: '光辉测试' };
  assert.equal(checkMachineRuleBox(radiant, reads('光辉宝可梦规则：1副卡组中只限放入1张光辉宝可梦卡。', '光辉宝可梦规则：1副卡组中只可放入1张光辉宝可梦。')).valid, true);
  assert.equal(checkMachineRuleBox(radiant, reads('光辉宝可梦规则：1副卡组中只限放入2张光辉宝可梦卡。')).valid, false);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试' }, reads('光辉宝可梦规则：1副卡组中只限放入1张光辉宝可梦卡。')).valid, false);
});

test('a visual rule-only correction is pinned to the original image and both read bytes and still passes the common gate', () => {
  const rows = [{ reading: { rule_text: 'old' }, sha256: 'a'.repeat(64) }, { reading: { rule_text: '□' }, sha256: 'b'.repeat(64) }];
  const override = { imageSha256: 'c'.repeat(64), readSha256: rows.map((r) => r.sha256), scope: 'rule_text',
    ruleText: '当宝可梦V昏厥时，对手将拿取2张奖赏卡。', reviewerId: 'test-only', reviewedOn: '2026-10-22' };
  const corrected = applyRuleBoxOverride(override.imageSha256, rows, override);
  assert.equal(checkMachineRuleBox({ kind: 'pokemon', name: '测试V' }, corrected).valid, true);
  assert.equal(rows[0].reading.rule_text, 'old');
  assert.deepEqual(applyRuleBoxOverride(override.imageSha256, rows), rows.map((r) => r.reading));
  for (const bad of [{ ...override, imageSha256: 'd'.repeat(64) }, { ...override, readSha256: ['d'.repeat(64), rows[1].sha256] },
    { ...override, scope: 'card' }, { ...override, reviewerId: null }])
    assert.throws(() => applyRuleBoxOverride(override.imageSha256, rows, bad), /Stale or malformed/);
});
