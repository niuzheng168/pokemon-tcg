// Quality is a fact of the pinned definition AND printing, never a library/presentation claim. A machine-checked
// reprint of a hand-reviewed definition remains machine quality. This describes review, not format legality.
export const IMPLEMENTATION_NAMES = Object.freeze({ reviewed: '人工审核', machine: '机器实现' });

export function implementationTier(catalog, printingId) {
  if (!catalog.hasPrinting(printingId)) return null;
  return catalog.printing(printingId).identityReview === 'machine'
    || catalog.definitionFor(printingId).implementation.tier === 'machine' ? 'machine' : 'reviewed';
}

// Match records store the distinct printings, not hand/private state. Derive this on the server; a client cannot
// relabel machine cards as reviewed. Unknown cards are explicit so diagnostic records cannot claim manual review.
export function implementationSummary(catalog, printingIds) {
  const groups = { reviewed: [], machine: [], unimplemented: [] };
  for (const id of [...new Set(printingIds)].sort()) groups[implementationTier(catalog, id) ?? 'unimplemented'].push(id);
  return {
    tiers: Object.keys(groups).filter((key) => groups[key].length),
    machinePrintings: groups.machine, unimplementedPrintings: groups.unimplemented,
  };
}
