// Checks translated effects (scripts/effect_translate.py) against the kernel: each result is put on a stand-in card
// of its kind (a Pokémon with the attack, Ability or rule box; the Trainer; the Special Energy) and must pass the
// kernel's own definition checks — schema, handler parameters, placement, formulas — and the game-load guard, as a
// reviewed card would. An attack result may carry failureCheck, an Ability result costs, either specialRule (GX/VSTAR,
// on a stand-in with that rule box), and an entry a fourth element { trigger?, activationCosts? }; the builder adds the
// card's evidence to each.
//   node scripts/effect-validate.mjs < results.jsonl > checks.jsonl
// Input lines {uid, unit, result}; output lines {uid, valid, error?}. Placeholders: DEF… (this card's definition id),
// NAME:<printed name> (a name key), CARD_EVIDENCE (the card's evidence).
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { definitionBuilder, cardEvidence, RULESET } from '../catalog/zh-CN/V20261019/common.mjs';
import { PRODUCT } from '../catalog/zh-CN/V20261019/csvh1c.mjs';
import { assertExecutableDefinition, canonicalDefinition } from '../public/rules/card-schema.js';
import { createCoreHandlers } from '../public/rules/handlers.js';
import { assertSupportedDefinition } from '../public/rules/game.js';
import { reviewedProgramEvidence } from './reviewed-effect-certificates.mjs';

const handlers = createCoreHandlers();
const d = definitionBuilder(PRODUCT, ['tests/effect-translation']);
const card = { setCode: 'TEST', number: '001/001', name: '测试卡', nameKey: 'test-card', mark: 'H',
  image: { store: 'library_v1', path: 'zh-Hans/TEST/001/test.png', sha256: '0'.repeat(64), origin: 'https://example.invalid/test.png' } };
const evidence = cardEvidence(PRODUCT, card);
const nameKey = (name) => `n-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;

function fill(value, id) {
  if (value === 'CARD_EVIDENCE') return evidence;
  if (typeof value === 'string' && value.startsWith('REVIEWED_EVIDENCE:')) {
    const policy = reviewedProgramEvidence(value.slice(18));
    if (!policy) throw new TypeError('Unknown reviewed policy evidence.');
    return policy;
  }
  if (Array.isArray(value)) return value.map((x) => fill(x, id));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, id)]));
  if (typeof value === 'string' && value.startsWith('NAME:')) return nameKey(value.slice(5));
  // Pipeline-generated named reference from a reviewed cross-unit certificate. This is only a stand-in schema check;
  // the whole-card builder must still find exactly one attack of that printed name, at its actual position.
  if (typeof value === 'string' && value.startsWith('ATTACK:')) return `${id}:a`;
  if (typeof value === 'string' && (value === 'DEF' || value.startsWith('DEF:'))) return id + value.slice(3);
  return value;
}

const DAMAGE = { '+': 'plus', '×': 'times', x: 'times', '-': 'minus' };
function damage(text) {
  const m = /^(\d+)([+×x-])?$/.exec((text ?? '').trim());
  if (!m) return null;
  return m[2] ? { value: Number(m[1]), operator: DAMAGE[m[2]] } : Number(m[1]);
}
const glyphs = (cost) => [...(cost ?? '')].filter((c) => '草火水雷超斗恶钢龙妖无'.includes(c)).join('');

// The definition a unit's result makes. Keys: attack `a`, Ability `b`; entries keep their own keys.
export function standIn(unit, result) {
  const kind = unit.kind;
  const id = `cn:${kind === 'trainer' ? 'trainer' : kind === 'energy' ? 'energy' : 'pokemon'}:test-card:test-001`;
  const r = fill(result, id), effects = r.effects ?? [];
  const pokemon = (m) => d.pokemon(card, id, { stage: 'basic', hp: 100, type: '无', retreat: 1, attacks: [],
    ...(r.specialRule ? { ruleBox: r.specialRule } : {}), ...m });
  switch (kind) {
    case 'attack':
      return pokemon({ attacks: [{ key: 'a', name: unit.attack.name, cost: glyphs(unit.attack.cost), damage: damage(unit.attack.damage), effects,
        ...(r.failureCheck ? { failureCheck: r.failureCheck } : {}), ...(r.specialRule ? { specialRule: r.specialRule } : {}) }] });
    case 'ability':
      return pokemon({ abilities: [{ key: 'b', name: unit.ability.name, mode: r.mode, usage: r.usage ?? null,
        ...(r.trigger ? { trigger: r.trigger } : {}), ...(r.condition ? { condition: r.condition } : {}), ...(r.endsTurn ? { endsTurn: true } : {}),
        ...(r.costs ? { costs: r.costs } : {}), ...(r.specialRule ? { specialRule: r.specialRule } : {}), effects }] });
    case 'rule':
      return pokemon({ rules: r.rules ?? [] });
    case 'trainer':
      return d.trainer(card, id, unit.card.category, effects, r.playCosts ?? null, { ...(r.condition ? { condition: r.condition } : {}),
        ...(r.firstTurnUse ? { firstTurnUse: true } : {}), ...(r.endsTurn ? { endsTurn: true } : {}), aceSpec: !!r.aceSpec });
    case 'energy':
      return d.specialEnergy(card, id, r.baseUnits, effects);
    default:
      throw new TypeError(`Unknown unit kind ${kind}`);
  }
}

export function check(unit, result) {
  if (result?.status !== 'ok') return { valid: false, error: 'not translated' };
  try {
    const def = standIn(unit, result);
    assertExecutableDefinition(def, { ruleset: RULESET, approvedDefinitions: new Map([[def.definitionId, canonicalDefinition(def)]]), handlers });
    // The game-load guard too: a card the kernel accepts but a game would refuse to start with is not executable.
    assertSupportedDefinition({ handler: (handlerId) => handlers.get(handlerId) }, def);
    return { valid: true };
  } catch (error) {
    // Schema errors: the first few instance paths and messages, so a failure says where.
    const detail = (error.errors ?? []).slice(0, 3).map((e) => `${e.instancePath} ${e.message}`).join('; ');
    return { valid: false, error: `${error.message ?? error}${detail ? ` (${detail})` : ''}`.slice(0, 500) };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const { uid, unit, result } = JSON.parse(line);
    process.stdout.write(JSON.stringify({ uid, ...check(unit, result) }) + '\n');
  }
}
