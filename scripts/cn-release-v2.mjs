// Committed authoring data only; no NAS, model caches or v1 generated bundle.
import { buildReleaseV2 } from './release-v2.mjs';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';
import * as released from '../catalog/zh-CN/V20261019/release-pool.mjs';

export function buildCNReleaseV2() {
  const review = (tier) => ({
    reviewId: `cn-v20261019-${tier}-${tier === 'reviewed' ? reviewed.REVIEWED_ON : released.REVIEWED_ON}`,
    reviewerId: tier === 'reviewed' ? 'cn-card-face-review' : 'cn-machine-pipeline',
    reviewedOn: tier === 'reviewed' ? reviewed.REVIEWED_ON : released.REVIEWED_ON,
    testIds: [...(tier === 'reviewed' ? reviewed.TEST_IDS : released.TEST_IDS)],
    sourceOfTruth: reviewed.PRODUCTS.map((p) => ({
      sourceId: `cn-product:${p.id}`, kind: 'official-card', url: p.url,
      locator: `${p.name}：官方商品页（发售日 ${p.releasedOn}，${p.series} 系列）。` +
        (tier === 'reviewed' ? '人工审核卡池的商品来源；逐卡卡面来源保留在定义与印刷中。'
          : '包内人工对照卡的商品来源，不证明机器印刷已人工审查；机器层的卡牌库证据、质量层和测试分别保留在每条记录中。'),
      observedOn: p.pageObservation.retrievedOn,
    })),
  });
  return buildReleaseV2({ releaseId: 'cn-v20261019-mixed-pool-v2', ruleset: reviewed.RULESET,
    definitions: released.DEFINITIONS, printings: released.PRINTINGS,
    reviews: [
      { tier: 'reviewed', review: review('reviewed') },
      { tier: 'machine', review: review('machine'),
        pipeline: { id: released.MACHINE_REPORT.pipeline, inputSha256: released.MACHINE_REPORT.reviewSha256,
          // Aliases of the two independently run Foundry readers, not invented model version IDs.
          models: ['astra', 'sol'],
          gold: { scope: 'card-review fields against the 83 hand-reviewed printings', total: 691, matched: 691 } } },
    ] });
}
