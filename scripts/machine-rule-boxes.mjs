// Whole-card guard separate from attack/Ability translation. The original field review did not compare rule_text.
// A complete effect unit therefore cannot authorize omitting an unread/extra printed rule box. Do not infer Tera
// from type/name or trust the sparse library labels; both full-image readers must carry only modelled rules.
import { ruleBoxOf, RULE_BOXES } from '../catalog/zh-CN/V20261019/common.mjs';
// Formatting punctuation is not game text, but +/−/×/◇ and unread boxes may be. Never erase them into a valid rule.
const clean = (s) => String(s ?? '').normalize('NFKC').replace(/[\s\p{P}]/gu, '');
// Each category reminder in the wordings both readers were seen to use; a dropped trailing 「卡」 is the same reminder.
const ITEM = '(?:在)?自己的回合(?:时)?(?:(?:可以|可|能够|能)?使用任意张物品(?:卡)?|物品卡(?:可以|可)使用任意张)';
// I.B-02: a Pokémon Tool's reminder; Sword & Shield and earlier Tools also print the Item one (「物品」 at the top).
const KEEP = '并保持(?:附(?:加|着)(?:的)?|其)状态';
const TOOL = `(?:在自己的回合可以将任意张宝可梦道具卡(?:放于|给予)自己的宝可梦身上每只宝可梦身上(?:只|仅)(?:可以|可)(?:放|给予)1张宝可梦道具卡${KEEP}` +
  `|(?:宝可梦道具)?宝可梦道具可以附着在自己的宝可梦身上每只宝可梦身上(?:只|仅)(?:可以|可)附着1张宝可梦道具${KEEP})`;
// I.B-04: one Stadium per turn; another Stadium replaces it; not one of the same name.
const STADIUM = '在自己的回合(?:只)?可(?:以)?将1张竞技场卡放(?:到|于)战斗(?:区|场|场区)(?:旁|域)?如果(?:有)?(?:将)?别的(?:名称的)?竞技场卡被?放(?:入|于)场上' +
  '(?:的话|时)?则将此卡放(?:入|于)弃牌区(?:无法将同名的竞技场卡放于场上)?';
const GENERAL = {
  item: new RegExp(`^${ITEM}$`),
  supporter: /^(?:在)?自己的回合(?:中)?(?:只|仅)(?:可以|可|能够|能)?使用1张支援者(?:卡)?$/,
  tool: new RegExp(`^(?:${TOOL}(?:${ITEM})?|${ITEM})$`),
  stadium: new RegExp(`^${STADIUM}$`),
};
export function checkMachineRuleBox({ name, kind, category, aceSpec = false }, readings) {
  if (!Array.isArray(readings) || readings.length !== 2 || readings.some((r) => !r || !Object.hasOwn(r, 'rule_text')))
    return { valid: false, reason: 'missing full-image rule-box readings' };
  const rb = kind === 'pokemon' ? ruleBoxOf(name) : null;
  const features = [];
  for (const reading of readings) {
    let text = clean(reading.rule_text);
    if (kind === 'pokemon') {
      const tera = /(?:太晶(?:规则)?)?只要这只宝可梦处于备战区就不会受到招式的伤害/;
      const match = tera.exec(text);
      features.push({ tera: !!match, explicitTera: match?.[0].startsWith('太晶') ?? false });
      if (match) {
        if (rb !== 'ex') return { valid: false, reason: 'Tera rule without a supported ex identity' };
        text = text.replace(tera, '');
      }
      if (!rb && !text) continue;
      // The Radiant rule is the deck limit the builder already gives it (one Radiant Pokémon per deck).
      if (rb === 'Radiant' && /^光辉宝可梦规则1副(?:卡组|牌组|套牌)中只(?:限|可|可以|能)放入1张光辉宝可梦(?:卡)?$/.test(text)) continue;
      if (rb && ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'].includes(rb)) {
        // 「TAG TEAM规则：当TAG TEAM昏厥时…」 names the card kind without 「宝可梦」; older EX cards head the box 「宝可梦EX规则」.
        const id = rb.replace(' ', ''), pokemon = rb === 'TAG TEAM' ? '(?:宝可梦)?' : '宝可梦';
        const re = new RegExp(`^(?:(?:宝可梦)?${id}规则)?(?:当)?(?:这只)?${pokemon}${id}(?:被)?(?:昏厥|击倒)时对手(?:将)?(?:拿取|拿走|获得|获取|取得)${RULE_BOXES[rb].prizeCount}张奖赏卡$`);
        if (re.test(text)) continue;
      }
      return { valid: false, reason: 'unrecognized or additional Pokemon rule box' };
    }
    if (kind === 'trainer') {
      if (aceSpec) {
        const ace = /^在(?:1副)?(?:套牌|牌组|卡组)中只(?:可以|可|能够|能)(?:放入|加入)1张ACESPEC卡/;
        if (!ace.test(text)) return { valid: false, reason: 'ACE SPEC rule unread or inconsistent' };
        text = text.replace(ace, '');
      }
      // An empty category reminder adds no executable effect. ACE SPEC is never an optional reminder.
      if (!text || GENERAL[category]?.test(text)) continue;
      return { valid: false, reason: 'unrecognized or additional Trainer rule box' };
    }
    if (kind === 'energy' && !aceSpec && !text) continue;
    return { valid: false, reason: 'unrecognized or additional Energy rule box' };
  }
  if (kind === 'pokemon' && (features[0].tera !== features[1].tera
    || features[0].tera && !features.some((f) => f.explicitTera)))
    return { valid: false, reason: 'Tera rule-box readings disagree or lack an explicit Tera label' };
  return { valid: true, ...(features[0]?.tera ? { features: { tera: true } } : {}) };
}

// A narrow visual correction never upgrades the rest of a machine card to hand-reviewed. Exact image and raw-read
// digests make it inapplicable after any source change; the corrected text still has to pass the same rule gate.
export function applyRuleBoxOverride(imageSha256, rows, override) {
  if (!override) return rows.map((r) => r.reading);
  if (override.imageSha256 !== imageSha256 || override.scope !== 'rule_text'
    || !override.reviewerId || !override.reviewedOn || typeof override.ruleText !== 'string'
    || rows.length !== 2 || override.readSha256?.length !== 2
    || rows.some((r, i) => r.sha256 !== override.readSha256[i]))
    throw new Error('Stale or malformed visual rule-box override.');
  return rows.map((r) => ({ ...r.reading, rule_text: override.ruleText }));
}
