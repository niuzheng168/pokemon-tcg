import { CN_V20261019 } from './zh-CN/V20261019.js';

export { RuleViolation } from './registry.js';
export { CN_V20261019 };

const rulesets = new Map([[CN_V20261019.id, CN_V20261019]]);

export function getRuleset({ region, version } = {}) {
  const ruleset = rulesets.get(`${region}/${version}`);
  if (!ruleset) throw new RangeError(`Unsupported ruleset: ${region}/${version}. No locale/latest fallback is allowed.`);
  return ruleset;
}

export function listRulesets() {
  return [...rulesets.values()].map(({ id, region, version, reviewedOn }) => ({ id, region, version, reviewedOn }));
}
