// Small, data-only identity for saves/records. Review prose stays in the pinned
// manifest instead of being copied into every save, upload and match-list row.
// This is NOT approval: restoration always independently admits the subset.
export function releaseIdentity(receipt) {
  const { schemaVersion, releaseId, manifestSha256, catalogId, kernelSha256, schemaSha256, rulesSha256,
    tiers, shards, printingIds } = receipt;
  return structuredClone({ schemaVersion, releaseId, manifestSha256, catalogId, kernelSha256, schemaSha256, rulesSha256,
    tiers, shards, printingIds });
}
