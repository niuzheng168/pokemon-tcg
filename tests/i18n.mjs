import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { STRINGS as EN } from '../public/i18n/en.js';
import { STRINGS as ZH, RULES } from '../public/i18n/zh-CN.js';
import { STRINGS as LANDING_ZH } from '../web/i18n/zh-CN.js';
import { LANGS, RULES_HTML, getLang, setLang, normalizeLanguage, t, cardName } from '../public/i18n.js';
import { CARDS, loadDeck } from '../public/cards.js';

const root = new URL('../', import.meta.url);
const glossary = JSON.parse(await readFile(new URL('docs/zh-CN-terminology.json', root)));
const params = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort(), 'Complete, explicit Chinese dictionary');
for (const [key, value] of Object.entries(ZH)) {
  assert.equal(typeof value, 'string', key);
  assert(EN[key] === '' || value.trim(), `Empty translation: ${key}`);
  assert.deepEqual(params(value), params(EN[key]), `Parameter mismatch: ${key}`);
  assert(!/<(?:script|iframe)|\bon\w+\s*=|javascript:/i.test(value), `Unsafe translation HTML: ${key}`);
  for (const term of glossary.avoid) assert(!value.includes(term), `${key}: replace ${term} with the official simplified term`);
}
for (const term of glossary.avoid) assert(!RULES.includes(term), `Rules still contain ${term}`);
for (const term of ['抗性', '竞技场卡', '宝可梦检查', '伤害指示物', '战斗场', '备战区']) {
  assert(RULES.includes(term), `Rules missing official term ${term}`);
}
assert(RULES.includes('data-dice-chart'));
assert.deepEqual(params(RULES), ['classic', 'modern']);
assert(!/抗性.{0,16}减少 30/.test(ZH['rule.resistance']), 'Do not teach a fixed resistance as a universal official rule');
assert.equal(ZH['ui.stadium'], '竞技场');
assert.equal(ZH['type.Fighting'], '斗');
assert.equal(ZH['coin.h'], '正面');
assert.equal(ZH['coin.t'], '反面');
assert.equal(getLang(), 'zh-CN');
for (const lang of LANGS) assert(RULES_HTML[lang], `No rules for ${lang}`);
for (const [input, output] of [['zh', 'zh-CN'], ['ZH_cn', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['en-US', 'en'], ['ja-JP', 'ja'], ['xx', null], [null, null]]) {
  assert.equal(normalizeLanguage(input), output);
}
assert.equal(t('ui.turn', { n: 3 }), '第 3 回合');
assert.equal(t('fx.selfDamage', { n: 10 }), '对自身也造成 10 伤害。');
assert.equal(t('log.coin', { h: { $coin: true } }), '硬币：正面。');
assert.equal(t('ui.turn', { n: 1 }), '第 1 回合');
assert.equal(setLang('not-a-locale'), false);
assert.equal(getLang(), 'zh-CN');
setLang('en');
assert.equal(t('ui.rules'), EN['ui.rules']);
setLang('zh-Hans');
assert.equal(t('ui.rules'), '怎么玩');
assert.equal(cardName({ kind: 'energy', energyType: 'Grass' }), '草能量');
await loadDeck('svl-mewtwo');
const before = JSON.stringify(CARDS['sv10-19']);
assert.equal(cardName(CARDS['sv10-19']), '火箭队的团珠蛛');
setLang('en');
assert.equal(cardName(CARDS['sv10-19']), "Team Rocket's Tarountula");
setLang('zh-CN');
assert.equal(CARDS['sv10-19'].attacks[0].fx.selfDamage, 10);
assert.equal(JSON.stringify(CARDS['sv10-19']), before, 'Translation must not mutate engine cards');

// Read only the landing dictionary; no browser/network is needed for this coverage check.
const landingSource = await readFile(new URL('web/landing.js', root), 'utf8');
const start = landingSource.indexOf('export const STRINGS =');
const end = landingSource.indexOf('\nconst LANGS', start);
const sandbox = { ZH_CN: LANDING_ZH };
vm.runInNewContext(landingSource.slice(start, end).replace('export const STRINGS', 'globalThis.strings'), sandbox);
assert.deepEqual(Object.keys(LANDING_ZH).sort(), Object.keys(sandbox.strings.en).sort(), 'Landing coverage');
for (const key of Object.keys(LANDING_ZH)) {
  assert.deepEqual(params(LANDING_ZH[key]), params(sandbox.strings.en[key]), `Landing parameters: ${key}`);
  for (const term of glossary.avoid) assert(!LANDING_ZH[key].includes(term), `Landing ${key}: ${term}`);
}
assert(LANDING_ZH['dl.text'].includes('不包含本分支的汉化'), 'Do not claim upstream DMGs contain our translation');
for (const filename of ['public/index.html', 'web/index.html']) {
  const html = await readFile(new URL(filename, root), 'utf8');
  assert(html.includes('lang="zh-CN"'));
  assert(html.includes('data-lang="zh-CN"'));
}
console.log(`i18n checks passed: ${Object.keys(ZH).length} game strings, ${Object.keys(LANDING_ZH).length} landing strings, placeholders, official terminology, rules, locale switching and engine identity`);
