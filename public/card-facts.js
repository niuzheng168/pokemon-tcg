// Read-only display facts from the pinned index. No handlers, approvals or
// executable catalog are synthesized here. Presentation supplies printed prose
// and images only; it cannot alter identity, costs, limits, tiers or legality.
export const damageText = (printed) => printed ? `${printed.value}${({ fixed: '', plus: '+', minus: '-', times: '×' })[printed.operator] ?? ''}` : '';
const slug = (id) => id.split(':').at(-1);

export function indexedCards(index, presentation = {}) {
  const names = new Map(index.entries.map((e) => [e.card.nameKey, e.card.name]));
  return index.entries.map((e) => {
    const m = e.card, p = e.printing, info = presentation[e.printingId] ?? {}, texts = info.texts ?? {};
    const attack = (a) => ({ name: a.name, cost: [...a.cost], damage: damageText(a.printedDamage), text: texts[slug(a.attackId)] ?? '' });
    return { id: e.printingId, name: m.name, kind: m.kind, setCode: p.setCode, setName: null, number: p.number,
      series: p.series, releasedOn: p.releasedOn, mark: p.regulationMark, rarity: null, illustrator: null,
      stage: m.stage?.toLowerCase() ?? null, types: m.kind === 'energy' && m.category !== 'basic' ? [] : [...m.types],
      hp: m.hp, evolvesFrom: m.evolvesFrom ? names.get(m.evolvesFrom) ?? m.evolvesFrom : null,
      weakness: m.weakness && { type: m.weakness.type, value: `${m.weakness.operation === 'multiply' ? '×' : '+'}${m.weakness.value}` },
      resistance: m.resistance && { type: m.resistance.type, value: `-${m.resistance.value}` }, retreat: m.retreatCost,
      attacks: m.attacks.map(attack), abilities: m.abilities.map((a) => ({ name: a.name, text: texts[slug(a.abilityId)] ?? '' })),
      text: texts.card ?? '', rule: [texts.tera, texts.rule].filter(Boolean).join('\n'), category: m.category,
      mechanic: m.tags.includes('ex') ? 'ex' : null, labels: m.tags.filter((x) => x !== 'ex'),
      review: e.tier === 'reviewed' ? 'reviewed' : info.textReview ?? 'machine-image-checked',
      image: info.image ?? null, thumb: info.image ?? null };
  });
}

export function overlayIndexedCards(cards, index, presentation) {
  const checked = indexedCards(index, presentation), byId = new Map(checked.map((c) => [c.id, c]));
  const known = new Set(cards.map((c) => c.id));
  return [...cards.map((c) => {
    const fact = byId.get(c.id);
    return fact ? { ...c, ...fact, setName: c.setName, rarity: c.rarity, illustrator: c.illustrator,
      image: c.image ?? fact.image, thumb: c.thumb ?? fact.thumb, mechanic: c.mechanic ?? fact.mechanic,
      labels: [...new Set([...c.labels, ...fact.labels])] } : c;
  }), ...checked.filter((c) => !known.has(c.id))];
}
