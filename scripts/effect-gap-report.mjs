// Read-only model diagnostics: section numbers refer to the TRANSLATOR'S handler reference, not official rules.
// Referenced gaps overlap; they are leads for auditing existing builder/kernel capabilities, never new approvals.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MODELS = ['astra', 'sol'];
const TITLES = {
  1: '构造器、费用、可选效果与 then 组合', 2: '伤害前顺序与共用掷币结果', 3: '持续时间',
  4: '条件式非伤害效果与未支持的状态读取', 5: '多次掷币与掷币后的非伤害效果',
  6: '对手手牌／牌库／弃牌区及额外抽牌', 7: '指定牌库位置、放逐区与奖赏操作',
  8: '特殊能量、跨玩家移动、道具、状态恢复及额外行动', 9: '按对方属性等条件的修正与保护',
  10: '触发事件及特性发动条件', 11: '竞技场行动与有条件的能量选项', uncited: '未提取到明确的 §5 条目',
};

export function summarizeEffectGaps(units, checks, reasons = new Map()) {
  const byUid = new Map(checks.map((r) => [r.uid, r]));
  if (byUid.size !== checks.length || new Set(units.map((u) => u.uid)).size !== units.length
    || byUid.size !== units.length || units.some((u) => !byUid.has(u.uid)))
    throw new Error('Corpus/check unit sets differ; rerun effect_translate.py check before reporting.');
  const statuses = { accepted: 0, 'both-unsupported': 0, review: 0 }, byKind = {};
  const printings = new Map(), byStatus = Object.fromEntries(Object.keys(statuses).map((s) => [s, new Set()]));
  const gaps = new Map();
  for (const unit of units) {
    const check = byUid.get(unit.uid);
    const accepted = check.accepted === true && check.agree === true
      && MODELS.every((m) => check[m]?.status === 'ok' && check[m]?.valid === true);
    const status = accepted ? 'accepted'
      : MODELS.every((m) => check[m]?.status === 'unsupported') ? 'both-unsupported' : 'review';
    statuses[status]++;
    byKind[unit.kind] ??= { accepted: 0, 'both-unsupported': 0, review: 0 };
    byKind[unit.kind][status]++;
    for (const id of new Set(unit.uses)) {
      if (!printings.has(id)) printings.set(id, new Set());
      printings.get(id).add(status); byStatus[status].add(id);
    }
    if (status !== 'both-unsupported') continue;
    const sections = new Set();
    for (const reason of reasons.get(unit.uid) ?? [])
      for (const match of String(reason).matchAll(/§\s*5(?:\s*[.．]\s*|\s*第\s*|\s*[(（]\s*)(\d+)/g))
        if (Object.hasOwn(TITLES, match[1])) sections.add(match[1]);
    if (!sections.size) sections.add('uncited');
    for (const section of sections) {
      if (!gaps.has(section)) gaps.set(section, { units: new Set(), printings: new Set() });
      const gap = gaps.get(section); gap.units.add(unit.uid);
      for (const id of unit.uses) gap.printings.add(id);
    }
  }
  return {
    units: units.length, statuses, byKind, referencedPrintings: printings.size,
    printingsByStatus: Object.fromEntries(Object.entries(byStatus).map(([s, ids]) => [s, ids.size])),
    allEffectsAcceptedPrintingIds: [...printings].filter(([, s]) => s.size === 1 && s.has('accepted')).map(([id]) => id).sort(),
    gaps: [...gaps].map(([section, g]) => ({ section, title: TITLES[section], units: g.units.size, printings: g.printings.size }))
      .sort((a, b) => b.printings - a.printings || b.units - a.units || a.section.localeCompare(b.section)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url)), base = join(root, '.data/effect-translation');
  const { values } = parseArgs({ options: { out: { type: 'string', default: join(base, 'gap-report.json') } } });
  const jsonl = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const corpusText = await readFile(join(base, 'corpus.jsonl'), 'utf8'), checkText = await readFile(join(base, 'checks-corpus.jsonl'), 'utf8');
  const units = jsonl(corpusText), checks = jsonl(checkText), reasons = new Map();
  for (const check of checks.filter((c) => MODELS.every((m) => c[m]?.status === 'unsupported'))) {
    const lines = [];
    for (const model of MODELS) {
      const { result } = JSON.parse(await readFile(join(base, 'out', model, `${check.uid}.json`), 'utf8'));
      lines.push(...(result.reasons ?? []));
    }
    reasons.set(check.uid, lines);
  }
  const summary = summarizeEffectGaps(units, checks, reasons);
  const index = JSON.parse(await readFile(join(root, '.data/card-library/index.json'), 'utf8'));
  const reviews = new Map(jsonl(await readFile(join(root, '.data/card-review/review.jsonl'), 'utf8')).map((r) => [r.id, r]));
  const reviewed = new Set(index.entries.filter((e) => !e.duplicateOf && reviews.get(e.id)?.conflicts.length === 0).map((e) => e.cardId));
  const release = JSON.parse(await readFile(join(root, 'public/data/cn/V20261019/release.json'), 'utf8'));
  const implemented = new Set(release.printings.map((p) => p.printingId));
  const report = {
    schema: 'cn-effect-gap-report/1', generatedOn: new Date().toISOString().slice(0, 10),
    corpusSha256: createHash('sha256').update(corpusText).digest('hex'),
    checksSha256: createHash('sha256').update(checkText).digest('hex'),
    ...summary,
    unimplementedReviewedCandidates: summary.allEffectsAcceptedPrintingIds.filter((id) => reviewed.has(id) && !implemented.has(id)),
    warning: 'Model-reference citation counts overlap and are not an independent capability audit. Candidates still need static fields, special-rule gates, semantic review and simulations.',
  };
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ units: report.units, statuses: report.statuses, byKind: report.byKind,
    candidatePrintings: report.unimplementedReviewedCandidates.length, gaps: report.gaps, output: values.out }, null, 2));
}
