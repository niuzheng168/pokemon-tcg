// Synthetic source/accepted card faces: no new card text or identity is approved by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesReprintFields } from '../../scripts/machine-reprint.mjs';

const card = {
  name: '测试', kind: 'pokemon', hp: 70, type: '雷', stage: '基础', weakness: { type: '斗', value: '×2' },
  resistance: { type: '钢', value: '-20' }, retreat: 1,
  attacks: [{ name: '撞击', cost: ['无'], damage: '20' }],
};
const accepted = Object.fromEntries(Object.entries({
  name: '测试', hp: '70', type: '雷', stage: 'basic', evolves_from: null, weakness: { type: '斗', value: '×2' },
  resistance: { type: '钢', value: '-20' }, retreat: 1, 'attack.count': 1, 'attack.0.name': '撞击', 'attack.0.cost': '无',
  'attack.0.damage': '20', 'attack.0.text': null, 'ability.count': 0, mark: 'G',
}).map(([key, value]) => [key, { value }]));

test('a reprint inherits only when all static and effect fields match, independently of its own printed mark', () => {
  assert.equal(matchesReprintFields(card, { kind: 'pokemon' }, accepted), true);
  assert.equal(matchesReprintFields({ ...card, hp: '70', mark: 'J' }, { kind: 'pokemon' }, accepted), true);
  for (const change of [
    (c) => { delete c.weakness.value; }, (c) => { c.weakness.type = '火'; }, (c) => { c.weakness.value = '×3'; },
    (c) => { delete c.resistance.value; }, (c) => { c.resistance = null; },
    (c) => { c.retreat = 2; }, (c) => { delete c.retreat; }, (c) => { c.hp = 80; }, (c) => { c.type = '水'; },
    (c) => { c.stage = '1阶进化'; c.evolvesFrom = '前一阶段'; }, (c) => { c.name = '另一个测试'; },
    (c) => { c.attacks[0].cost = ['雷']; }, (c) => { c.attacks[0].damage = '30'; },
    (c) => { c.attacks[0].text = '不能省略的效果'; }, (c) => { c.attacks = []; },
    (c) => { c.abilities = [{ name: '特性', text: '不能省略的特性' }]; },
  ]) {
    const changed = structuredClone(card); change(changed);
    assert.equal(matchesReprintFields(changed, { kind: 'pokemon' }, accepted), false);
  }
});

test('Trainer reprints also need the same category, full source text and name', () => {
  const source = { name: '测试物品', kind: 'trainer', text: ['甲。\\n乙。'] };
  const peer = { name: { value: '测试物品' }, card_text: { value: '甲。乙。' } };
  assert.equal(matchesReprintFields(source, { kind: 'trainer', category: 'item' }, peer, 'item'), true);
  assert.equal(matchesReprintFields(source, { kind: 'trainer', category: 'supporter' }, peer, 'item'), false);
  assert.equal(matchesReprintFields({ ...source, text: ['甲。'] }, { kind: 'trainer', category: 'item' }, peer, 'item'), false);
});
