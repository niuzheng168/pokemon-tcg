// Reviewed playbooks into ai/deck-playbooks.json, which the language-model opponent and coach read (ai/llm-player.mjs) and
// the start page shows (the deck-playbook skill, .claude/skills/deck-playbook). Each file is { deck, sections: [{ title,
// points: [{ text, src }] }], review: { issues, fixed, dropped, … } }; only the sections, the review record and the date
// are kept. A re-checked playbook (review.recheck2, the skill's step 7) carries its earlier review record itself; a new
// one replacing an older playbook keeps the old record under review.earlier.
//   node scripts/playbook-merge.mjs <playbook.json>… [--checked-on 2026-10-29]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals: files } = parseArgs({ allowPositionals: true, options: { 'checked-on': { type: 'string', default: new Date().toISOString().slice(0, 10) } } });
const target = new URL('../ai/deck-playbooks.json', import.meta.url), all = JSON.parse(readFileSync(target, 'utf8'));
for (const file of files) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (!d.deck || !Array.isArray(d.sections) || !d.review) throw new Error(`${file}: not a reviewed playbook ({deck, sections, review})`);
  const points = d.sections.flatMap((s) => s.points);
  if (points.some((x) => typeof x.text !== 'string' || !x.text.trim())) throw new Error(`${file}: a point without text`);
  const before = all.decks[d.deck];
  const replaced = before && before.checkedOn !== values['checked-on'] && !d.review.recheck2 && !d.review.earlier;
  all.decks[d.deck] = { checkedOn: values['checked-on'], review: replaced ? { ...d.review, earlier: { checkedOn: before.checkedOn, ...before.review } } : d.review,
  sections: d.sections.map(({ title, points: p }) => ({ title, points: p.map(({ text, src }) => ({ text, src: src ?? [] })) })) };
  console.log(`${d.deck}: ${d.sections.length} sections, ${points.length} points, ${points.reduce((n, x) => n + x.text.length, 0)} characters`);
}
writeFileSync(target, `${JSON.stringify(all, null, 1)}\n`);
