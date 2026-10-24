// Synthetic metadata and card-review records. These test corpus preparation, not card implementation/approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildEffectCorpus } from '../scripts/effect-corpus.mjs';
import { unitOf } from '../scripts/effect-units.mjs';
import { summarizeEffectGaps } from '../scripts/effect-gap-report.mjs';

const pokemon = { id: 'test:1', cardId: 'zh-Hans:TEST:001/010', kind: 'pokemon', name: '旧名', hp: 50, stage: 'basic',
  attacks: [{ name: '旧招式', cost: ['Lightning', 'Colorless'], damage: '10', text: '旧效果' }],
  abilities: [{ name: '旧特性', text: '旧特性文' }] };
const accepted = (fields) => ({ id: pokemon.id,
  accepted: Object.fromEntries(Object.entries(fields).map(([f, value]) => [f, { value }])) });

test('corpus prefers accepted identities, counts, names, costs and damage, including attacks missing from metadata', () => {
  const review = accepted({ name: '核对后名称', hp: '80', stage: 'Stage 1', 'attack.count': 2, 'ability.count': 0,
    'attack.0.name': '核对后招式', 'attack.0.cost': ['L', 'C'], 'attack.0.damage': '30+', 'attack.0.text': '核对后效果',
    'attack.1.name': '补回的招式', 'attack.1.cost': '火 无', 'attack.1.damage': '20', 'attack.1.text': '补回的效果' });
  const { units, cards } = buildEffectCorpus({ entries: [pokemon] }, [review]);
  assert.equal(cards, 1); assert.equal(units.length, 2);
  assert.ok(units.every((u) => u.kind === 'attack' && u.reviewed));
  const first = units.find((u) => u.attack.name === '核对后招式'), second = units.find((u) => u.attack.name === '补回的招式');
  assert.deepEqual(first.card, { name: '核对后名称', kind: 'pokemon', stage: 'stage1', hp: 80, category: undefined });
  assert.deepEqual(first.attack, { name: '核对后招式', cost: '雷无', damage: '30+' });
  assert.deepEqual(second.attack, { name: '补回的招式', cost: '火无', damage: '20' });
  assert.equal(first.uid, unitOf({ kind: first.kind, card: first.card, attack: first.attack, text: first.text }).uid);
});

test('accepted zero counts and empty effect text remove stale metadata effects rather than translating ghosts', () => {
  assert.deepEqual(buildEffectCorpus({ entries: [pokemon] }, [accepted({ 'attack.count': 0, 'ability.count': 0 })]).units, []);
  assert.deepEqual(buildEffectCorpus({ entries: [pokemon] }, [accepted({ 'attack.0.text': '', 'ability.0.text': null })]).units, []);
  assert.throws(() => buildEffectCorpus({ entries: [pokemon] }, [accepted({ 'attack.count': -1 })]), /invalid attack count/);
});

test('fallback text stays explicitly unreviewed and English energy names become printed glyphs', () => {
  const { units } = buildEffectCorpus({ entries: [pokemon] });
  assert.ok(units.every((u) => u.reviewed === false));
  assert.equal(units.find((u) => u.kind === 'attack').attack.cost, '雷无');
});

test('deduplication keeps distinct printing references once and ignores duplicate library records', () => {
  const card = { ...pokemon, attacks: [pokemon.attacks[0], pokemon.attacks[0]], abilities: [] };
  const other = { ...card, id: 'test:2', cardId: 'zh-Hans:TEST:002/010' };
  const duplicate = { ...card, id: 'test:dup', duplicateOf: pokemon.id };
  const { units, cards } = buildEffectCorpus({ entries: [card, other, duplicate] }, [accepted({ 'attack.0.text': '旧效果' })]);
  assert.equal(cards, 2); assert.equal(units.length, 1);
  assert.deepEqual(units[0].uses, [pokemon.cardId, other.cardId]);
  assert.equal(units[0].reviewed, true);
});

test('accepted Trainer name/category participates in identity; basic Energy is not an effect unit', () => {
  const trainer = { id: pokemon.id, cardId: pokemon.cardId, kind: 'trainer', name: '旧训练家', category: 'item', text: '旧效果' };
  const review = accepted({ name: '新训练家', category: 'supporter', card_text: '新效果' });
  const energy = { ...trainer, id: 'special', cardId: 'zh-Hans:TEST:E', kind: 'energy', category: 'special' };
  const basic = { ...energy, id: 'basic', cardId: 'zh-Hans:TEST:B', category: 'basic' };
  const { units } = buildEffectCorpus({ entries: [trainer, energy, basic] }, [review]);
  assert.equal(units.length, 2);
  const t = units.find((u) => u.kind === 'trainer');
  assert.equal(t.card.name, '新训练家'); assert.equal(t.card.category, 'supporter');
  assert.equal(t.uid, unitOf({ kind: t.kind, card: t.card, text: t.text }).uid);
  assert.ok(units.some((u) => u.kind === 'energy' && !u.reviewed));
});

test('card review: a library Item is a Tool only by a same-name MIK Tool record and 「宝可梦道具」 in both whole-card readings', () => {
  // scripts/card_review.py mik_tool_label (accepted category rule 'mik-tool+reading'), on synthetic readings and records.
  const tool = { cardType: 'Tool', name: '测试手套' }, label = { rule_text: '宝可梦道具可以附着在自己的宝可梦身上。在自己的回合可以使用任意张物品卡。' };
  const cases = [
    ['trainer', 'item', '测试手套', [label, { card_text: '宝可梦道具\n效果' }], [tool]],
    ['trainer', 'item', '测试手套', [label, label], [null, { ...tool, name: '测试 手套' }]],
    ['trainer', 'item', '测试手套', [label, { card_text: '效果' }], [tool]],
    ['trainer', 'item', '测试手套', [label, null], [tool]],
    ['trainer', 'item', '测试手套', [label], [tool]],
    ['trainer', 'item', '测试手套', [label, label], [{ ...tool, cardType: 'Item' }]],
    ['trainer', 'item', '测试手套', [label, label], [{ ...tool, name: '老大的指令' }]],
    ['trainer', 'item', '测试手套', [label, label], [null]],
    ['trainer', 'supporter', '测试手套', [label, label], [tool]],
    ['trainer', 'tool', '测试手套', [label, label], [tool]],
    ['pokemon', null, '测试手套', [label, label], [tool]],
  ];
  const py = 'import json, sys; sys.path.insert(0, "scripts"); import card_review as c\n'
    + 'print(json.dumps([c.mik_tool_label(*x) for x in json.load(sys.stdin)]))';
  const run = spawnSync('python3', ['-c', py], { cwd: new URL('..', import.meta.url), input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [true, true, false, false, false, false, false, false, false, false, false]);
});

test('a Tool\'s printed attack and Ability belong to its unit: the library\'s attack with unreviewed text, a visual reading with checked text', () => {
  const tm = { id: 'tm', cardId: 'zh-Hans:TEST:TM', kind: 'trainer', name: '测试学习器', category: 'tool', text: '可以使用这张卡牌上的招式。',
    attacks: [{ name: '测试招式', cost: ['Colorless', 'Colorless'], damage: '280', text: '招式说明。' }] };
  const [unit] = buildEffectCorpus({ entries: [tm] }).units;
  assert.equal(unit.text, '可以使用这张卡牌上的招式。\n\n【无】【无】 测试招式 280\n招式说明。');
  assert.equal(unit.reviewed, false);
  assert.deepEqual(buildEffectCorpus({ entries: [{ ...tm, text: '' }] }).units, [], 'No rule text: no attack-only unit.');
  // Checked text: the card review's own attack fields only (none here), never the library's.
  const checked = { id: tm.id, accepted: { card_text: { value: '可以使用这张卡牌上的招式。' } } };
  assert.equal(buildEffectCorpus({ entries: [tm] }, [checked]).units[0].text, '可以使用这张卡牌上的招式。');
  const seal = { id: 'seal', cardId: 'zh-Hans:TEST:SEAL', kind: 'trainer', name: '测试封印石', category: 'tool', text: '', attacks: [],
    image: { sha256: 'b'.repeat(64) } };
  const review = { id: 'seal', accepted: { card_text: { value: '可以使用这个VSTAR力量。' } } };
  const skills = { ['b'.repeat(64)]: { imageSha256: 'b'.repeat(64), scope: 'printed_ability', reviewerId: 'test', reviewedOn: '2026-10-24',
    cardText: '可以使用这个VSTAR力量。', abilities: [{ name: '测试特性', text: '特性说明。' }] } };
  const [power] = buildEffectCorpus({ entries: [seal] }, [review], skills).units;
  assert.equal(power.text, '可以使用这个VSTAR力量。\n\n[特性] 测试特性\n特性说明。');
  assert.equal(power.reviewed, true);
  assert.throws(() => buildEffectCorpus({ entries: [seal] }, [{ id: 'seal', accepted: { card_text: { value: '改过的规则。' } } }], skills),
    /Stale or malformed printed-skill override/);
});

test('gap counts distinguish units from printing coverage and count overlapping citations without duplication', () => {
  const ok = { status: 'ok', valid: true }, no = { status: 'unsupported', valid: false };
  const units = [
    { uid: 'a', kind: 'trainer', uses: ['p1', 'p1', 'p2'] },
    { uid: 'b', kind: 'attack', uses: ['p2', 'p3'] },
    { uid: 'c', kind: 'ability', uses: ['p4'] },
  ];
  const checks = [
    { uid: 'a', accepted: true, agree: true, astra: ok, sol: ok },
    { uid: 'b', accepted: false, agree: true, astra: no, sol: no },
    { uid: 'c', accepted: false, agree: false, astra: ok, sol: no },
  ];
  const report = summarizeEffectGaps(units, checks, new Map([['b', ['§5.4: 条件', '§5第4项与§5.1']]]));
  assert.deepEqual(report.statuses, { accepted: 1, 'both-unsupported': 1, review: 1 });
  assert.deepEqual(report.printingsByStatus, { accepted: 2, 'both-unsupported': 2, review: 1 });
  assert.equal(report.referencedPrintings, 4);
  assert.deepEqual(report.allEffectsAcceptedPrintingIds, ['p1']);
  assert.equal(report.gaps.length, 2);
  assert.ok(report.gaps.every((g) => g.units === 1 && g.printings === 2));
});

test('gap reporting rejects stale checks instead of silently counting a new corpus as already accepted', () => {
  assert.throws(() => summarizeEffectGaps([{ uid: 'new', uses: [] }], [{ uid: 'old' }]), /unit sets differ/);
  assert.throws(() => summarizeEffectGaps([], [{ uid: 'old' }, { uid: 'old' }]), /unit sets differ/);
});
