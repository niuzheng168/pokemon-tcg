import { deepFreeze } from '../../registry.js';

// Reviewed against the actual official HTML, not a search-result name list.
// Names identify printed CN cards. Parenthetical character/illustration labels
// are NOT part of 博士的研究 / 老大的指令's same-name identity.
const standardLatestText = [
  '宝可梦捕捉器', '宝可梦交替', '宝可装置3.0', '宝可梦中心的姐姐', '博士的研究', '裁判',
  '超级球', '巢穴球', '反击捕捉器', '反击增幅器', '粉碎之锤', '改造之锤', '高级球',
  '活力头带', '讲究腰带', '精灵球', '老大的指令', '能量回收', '能量输送', '能量再利用',
  '能量转移', '朋友手册', '伤药', '神奇糖果', '西餐厨师', '学习装置',
];
const common = {
  region: 'CN', version: 'V20261019', ruleset: { region: 'CN', version: 'V20261019' },
  snapshotOn: '2026-10-19', effectiveOn: '2026-09-16', reviewedOn: '2026-10-20',
  sourceOfTruth: [{ documentId: 'CN-formats-20260916', section: '标准赛制／开放赛制（2026年9月16日更新）' }],
};
export const CN_FORMATS_V20261019 = deepFreeze([
  {
    ...common, id: 'standard', ruleId: 'deck.format.standard', deckSize: 60,
    regulationMarks: ['G', 'H', 'I', 'J'],
    basicEnergyTypes: ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'],
    latestTextNames: standardLatestText,
  },
  {
    ...common, id: 'open', ruleId: 'deck.format.open', deckSize: 60,
    series: ['sun-moon', 'sword-shield', 'scarlet-violet'],
    basicEnergyTypes: ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy'],
    latestTextNames: [
      ...standardLatestText, '捕虫少年', '离洞绳', '谜之化石', '模仿少女', '能量签', '千金小姐',
    ],
    bannedCards: [
      { kind: 'pokemon', name: '玛夏多', abilityName: '破罐破摔' },
      { kind: 'trainer', name: '阿塞萝拉' },
      { kind: 'trainer', name: '全满药' },
    ],
  },
]);
