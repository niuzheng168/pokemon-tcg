// Original, clearly labelled learning faces when an exact Chinese scan is unavailable.
// Not a replacement for collecting authentic scans; never label these as official cards.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS, DECKS, loadDeck } from '../public/cards.js';
import { t, setLang, cardName, attackName, powerName, displayText } from '../public/i18n.js';
import { CHINESE_CARDS } from '../public/card-presentation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'public/img/zh-learning');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const colors = {
  Grass: '#297447', Fire: '#a8322d', Water: '#246caa', Lightning: '#916b03', Psychic: '#775196',
  Fighting: '#865034', Darkness: '#304858', Metal: '#4f6775', Dragon: '#776126', Colorless: '#656766',
};
function wrap(value, maxWidth) {
  const lines = [];
  let line = '', width = 0;
  for (const character of String(value)) {
    const size = /[\x00-\xff]/.test(character) ? 0.55 : 1;
    if (width + size > maxWidth) { lines.push(line); line = ''; width = 0; }
    line += character;
    width += size;
  }
  if (line) lines.push(line);
  return lines;
}
function text(value, x, y, size = 28, opts = '') {
  return `<text x="${x}" y="${y}" font-size="${size}" ${opts}>${esc(value)}</text>`;
}
function paragraph(value, x, y, width = 24, size = 27, limit = 8) {
  const lines = wrap(value, width);
  return lines.slice(0, limit).map((line, i) => text(i === limit - 1 && lines.length > limit ? line + '…' : line, x, y + i * (size + 13), size)).join('');
}
function effectText(attack) {
  const fx = attack.fx || {}, parts = [];
  if (fx.selfDamage) parts.push(t('fx.selfDamage', { n: fx.selfDamage }));
  if (fx.flipSelfDamage) parts.push(t('fx.flipSelfDamage', { n: fx.flipSelfDamage }));
  if (fx.status) parts.push(t('fx.status', { s: t('st.' + fx.status) }));
  if (fx.draw) parts.push(t('fx.draw', { n: fx.draw }));
  if (fx.heal) parts.push(t('fx.heal', { n: fx.heal }));
  if (fx.flipBonus) parts.push(t('fx.flipBonus', { n: fx.flipBonus }));
  if (fx.discard) parts.push(t('fx.discard', { n: fx.discard.n, t: t('type.' + fx.discard.type) }));
  if (fx.flipFail) parts.push(t('fx.flipFail'));
  if (fx.flipMulti) parts.push(t('fx.flipMulti', { n: fx.flipMulti, per: attack.base, max: fx.flipMulti * attack.base }));
  if (fx.plusSelfCounters) parts.push(t('fx.plusSelfCounters'));
  // Do not invent an effect summary for complex executable effects.
  if (Object.keys(fx).length && !parts.length) parts.push('另有招式效果，请查看旁边的完整说明。');
  return parts.join(' ');
}
function learningFace(card) {
  const accent = colors[card.type || card.energyType] || '#3a5b83';
  const kind = card.kind === 'pokemon' ? t('stage.' + card.stage) : card.kind === 'trainer' ? '训练家卡' : '能量卡';
  let content = '', y = 480;
  if (card.kind === 'pokemon' || card.attacks?.length) {
    if (card.power) {
      content += text((card.power.ability ? '特性：' : '经典能力：') + powerName(card), 60, y, 27, 'font-weight="700"');
      content += paragraph(t('pw.' + card.power.kind), 60, y + 42, 24, 25, 3);
      y += 170;
    }
    const slotHeight = Math.floor((906 - y) / card.attacks.length);
    card.attacks.forEach((attack, index) => {
      const compact = slotHeight < 170, size = compact ? 23 : 27;
      content += `<line x1="54" y1="${y - 30}" x2="686" y2="${y - 30}" stroke="#cfd8dc"/>`;
      content += text(attackName(card, index), 60, y + 12, 32, 'font-weight="800"');
      content += text(attack.damage || '—', 680, y + 12, 36, 'text-anchor="end" font-weight="800"');
      content += text('所需能量：' + attack.cost.map((type) => t('type.' + type)).join('、'), 60, y + 57, size);
      const effect = CHINESE_CARDS[card.id]?.attacks[index]?.effect;
      const safeEffect = effect && !/[{}]|-\{/.test(effect) ? displayText(effect) : effectText(attack);
      content += paragraph(safeEffect, 60, y + (compact ? 86 : 100), 24, compact ? 22 : 25, compact ? 1 : 3);
      y += slotHeight;
    });
  } else {
    const key = card.stadium || card.tool || card.tkind;
    const description = card.kind === 'trainer' ? t(`tr.${key}.what`)
      : card.special ? t(`ex.special.${card.special}`) : t('ex.energy', { t: t('type.' + card.energyType) });
    content += paragraph(description, 60, 500, 23, 29, 10);
  }
  const footer = card.kind === 'pokemon'
    ? `弱点：${card.weakness ? t('type.' + card.weakness) : '无'}　抗性：${card.resistance ? t('type.' + card.resistance) : '无'}　撤退：${card.retreat}`
    : '卡牌规则与使用限制请查看卡牌说明';
  const title = cardName(card);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="740" height="1034" viewBox="0 0 740 1034">
<title>${esc(title)} · 中文练习卡面，非官方扫描</title>
<defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset="1" stop-color="#172a42"/></linearGradient></defs>
<rect x="9" y="9" width="722" height="1016" rx="36" fill="#f4efdc" stroke="#c2ad61" stroke-width="15"/>
<g font-family="'Noto Sans CJK SC','Microsoft YaHei','PingFang SC',sans-serif" fill="#192d42">
${text(kind, 48, 68, 25)}
${card.hp ? text('HP ' + card.hp, 686, 70, 33, 'text-anchor="end" font-weight="800"') : ''}
${paragraph(title, 48, 126, 24, title.length > 17 ? 32 : 40, 2)}
<rect x="42" y="195" width="656" height="227" rx="20" fill="url(#g)"/>
<circle cx="370" cy="302" r="70" fill="none" stroke="#ffffff" stroke-opacity=".25" stroke-width="15"/>
${text(card.type ? t('type.' + card.type) : card.kind === 'energy' ? t('type.' + card.energyType) : '练习', 370, 325, 62, 'fill="#fff" font-weight="800" text-anchor="middle"')}
${text('中文练习卡面 · 非官方扫描', 370, 401, 22, 'fill="#fff" text-anchor="middle"')}
${content}
<rect x="37" y="928" width="666" height="70" rx="12" fill="#e6e6dc"/>
${text(footer, 51, 958, 22)}
${text('原版编号：' + card.id + ' · 完整效果以引擎及说明为准', 51, 988, 18)}
</g></svg>`;
}

await Promise.all(Object.keys(DECKS).map(loadDeck));
setLang('zh-CN');
await mkdir(directory, { recursive: true });
for (const card of Object.values(CARDS)) {
  await writeFile(join(directory, encodeURIComponent(card.id) + '.svg'), learningFace(card));
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({
  count: Object.keys(CARDS).length, generated: true,
  warning: '中文练习卡面，不是官方扫描；未计入下载图片数量。',
  source: '引擎数值与独立中文显示资料；不修改卡牌规则。',
}, null, 2));
console.log(`Generated ${Object.keys(CARDS).length} explicitly labelled Chinese learning faces.`);
