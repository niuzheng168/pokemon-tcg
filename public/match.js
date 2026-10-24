// The table UI (ui.js) on the CN/V20261019 official kernel. A Match drives an OfficialGame the way the old
// teaching engine drove the UI: it asks the controllers for each decision, dispatches it, then replays what the
// dispatch did as the UI's animation hooks while the board still shows the state before it, and finally swaps
// in the new board. Rules are decided only by the kernel; this file only translates.
//
// What the UI reads (the old engine's shape):
//   match.players[0] is you (kernel player 0), players[1] the opponent; phase 'setup' | 'main' | 'over';
//   turn, current (a player), winner (a player or 'draw'), winReason {text}, stadium {card}, allMons(p), opp(p).
//   Cards: {uid (number), iid (kernel instance id), id (printing), name, kind, img, type, hp, stage, attacks…}.
//   Pokémon: {id (number), mid (kernel id), card (top), stack, damage, hpLeft, maxHp, energy, tools, conditions()}.
// Controllers: human {chooseAction(match, p, actions) → action, choose(match, p, prompt) → answer};
//   cpu {decide(view, player) → kernel action}. The opponent only ever sees its own player view.
import { OfficialGame } from './rules/engine.js';
import { implementationTier } from './card-quality.js';
import { damageText } from './card-facts.js';
export { damageText };

export const ME = 0, OPP = 1;

const STAGE_NUM = { basic: 0, stage1: 1, stage2: 2 };
const uidOf = (iid) => { const m = /^p(\d)c(\d+)$/.exec(iid); return m ? Number(m[1]) * 100 + Number(m[2]) + 1 : 0; };
const monNum = (mid) => Number(String(mid).slice(1));
const who = (player) => (player === ME ? '你' : '小茂');
const DECK_ORDER = { top: '按选定顺序放回牌库上方', bottom: '按选定顺序放回牌库下方', same: '放回原处', shuffle: '放回后重洗了牌库', shuffleBottom: '洗切后放回牌库下方' };
const slug = (id) => id.split(':').at(-1);
const CONDITION_KEYS = { asleep: 'asleep', paralyzed: 'paralyzed', confused: 'confused' };
const COIN = (r) => (r === 'heads' ? '正面' : '反面');

// Choice titles by prompt kind (unknown kinds fall back to 请选择).
export const PROMPT_TITLE = {
  'choose-order': '你获得了决定权：选择先攻或后攻', 'setup-active': '选择你的战斗宝可梦',
  'setup-bench': '选择放于备战区的基础宝可梦', 'mulligan-bonus': '对手重抽了：选择额外抽取的张数',
  prize: '拿取1张奖赏卡', 'prize-slot': '选择奖赏卡', 'prize-destination': '选择放于弃牌区的奖赏卡（其余放入放逐区或加入手牌）', promote: '选择新的战斗宝可梦', 'retreat-energy': '选择撤退时放于弃牌区的能量',
  'retreat-target': '选择换到战斗场的备战宝可梦', 'tool-target': '选择放置宝可梦道具的宝可梦',
  'activation-cost': '使用条件：选择要放于弃牌区的卡牌', 'effect-target': '选择效果的对象', 'select-cards': '选择卡牌',
  'view-cards': '查看卡牌', 'inspect-deck': '选择牌库中的卡牌', 'deck-energy-recipient': '选择这张能量的去向',
  'hand-energy': '选择手牌中的能量', 'discard-energy': '选择弃牌区中的能量', 'energy-recipient': '选择附着能量的宝可梦',
  'incoming-energy-recipient': '选择附着能量的宝可梦', 'attached-energy': '选择宝可梦身上的能量',
  'optional-effect': '是否执行这项效果？', 'trigger-optional': '是否使用这项效果？', 'before-hand-optional': '是否使用这项效果？',
  'copy-attack': '选择要使用的招式', 'owned-attack': '选择招式', 'damage-targets': '选择受到伤害的宝可梦',
  'energy-destination': '选择转附能量的宝可梦', 'bench-trim': '备战宝可梦超过上限：选择放于弃牌区的宝可梦',
  'tool-trim': '宝可梦道具超过上限：选择放于弃牌区的道具',
  'transition-card': '选择卡牌', 'transition-target': '选择宝可梦', 'return-pokemon': '选择宝可梦',
  'counter-allocation': '以任意方式放置伤害指示物', 'counter-origin': '选择转放伤害指示物的宝可梦',
  'counter-count': '选择转放的伤害指示物数量', 'counter-destination': '选择接受伤害指示物的宝可梦', 'counter-place-count': '选择放置的伤害指示物数量', 'second-attack': '选择第2次使用的招式',
  'deck-top-count': '选择从牌库上方放于弃牌区的张数', 'count-source': '选择按其身上数量计算的宝可梦',
  'healing-targets': '选择回复的宝可梦', 'devolution-target': '选择退化的宝可梦', 'devolution-count': '选择退化的阶数',
  'prize-exchange': '选择卡牌', 'attack-payment': '选择支付招式所需的卡牌', 'checkup-placement': '选择放置的时机',
  'trigger-order': '选择效果的处理顺序', 'before-hand-order': '选择效果的处理顺序',
  'choose-effect': '选择要执行的效果（按卡面顺序）', 'draw-more': '是否继续抽取1张卡牌？', 'order-cards': '按从上到下的顺序依次选择卡牌', 'choose-deck': '选择查看哪一方的牌库', 'arrange-choice': '选择处理方式', 'cure-conditions': '选择要恢复的特殊状态',
  'ko-zone': '选择先处理的效果：【昏厥】的宝可梦的去向',
  janken: '与对手猜拳：选择要出的拳（对手看不到）', 'coin-face': '决定这次抛掷硬币第1枚的结果', 'coin-reflip': '是否无视这次抛掷硬币的所有结果，重新抛掷？',
};
const OPTION_TEXT = { first: '先攻', second: '后攻', perform: '执行', skip: '不执行', confirm: '确认',
  before: '在宝可梦检查之前', after: '在宝可梦检查之后', '@hand': '加入手牌',
  asleep: '睡眠', paralyzed: '麻痹', confused: '混乱', poisoned: '中毒', burned: '灼伤',
  own: '自己的牌库', opponent: '对手的牌库', continue: '继续抽取', stop: '停止抽取', arrange: '重新排列后放回牌库上方', shuffle: '放回牌库后重洗', shuffleBottom: '反面重洗后放回牌库下方',
  hand: '放回手牌', lost: '放于放逐区',
  rock: '石头', scissors: '剪刀', paper: '布', heads: '正面', tails: '反面', keep: '不重新抛掷' };
const NUMBER_KINDS = { 'mulligan-bonus': '张', 'counter-count': '个', 'counter-place-count': '个', 'devolution-count': '阶', 'deck-top-count': '张' };
const REASON = { ordinary: '奖赏卡已全部拿取，或对手场上已没有宝可梦。', deckout: '回合开始时牌库无牌可抽。',
  concede: '一方认输。', simultaneous: '双方同时满足胜利条件。', effect: '卡牌效果决定了这场对战的胜负。' };

// A dispatch whose events are all of these revealed nothing new: your own undo may take it back.
const QUIET = new Set(['turn.bench', 'turn.energy', 'turn.evolve', 'turn.tool', 'pokemon.types', 'energy.requirement']);
// Events that belong to an attack while the arena is open.
const ATTACK_EVENTS = new Set(['attack.used', 'attack.order', 'energy.requirement', 'damage.expression', 'damage.effect-count',
  'damage.counters', 'damage.counter-distribution', 'damage.coins', 'effects.coin', 'attack.failure.self', 'attack.failure.imposed',
  'energy.attached-selection', 'effects.partial', 'pokemon.types', 'status.confusion', 'attack.copy', 'effects.heal', 'effects.heal-results',
  'effects.janken', 'effects.coin-reflip', 'effects.coin-choice']);

export class Match {
  constructor({ game, catalog, presentation, decks, controllers, hooks = {} }) {
    Object.assign(this, { game, catalog, presentation, decks, controllers, hooks });
    this.known = new Map();    // instance id → {printingId, definitionId}, from what player 0 has seen
    this.cards = new Map();    // instance id → card model (identity never changes)
    this.monNames = new Map(); // kernel Pokémon id → {name, owner, position}, kept after it leaves play
    this.modern = true;
    this.build(game.view(ME));
  }

  // ---------------- Board model ----------------
  snapshot() { return this.game.snapshot(); }
  allMons(p) { return [p.active, ...p.bench].filter(Boolean); }
  opp(p) { return this.players[1 - p.idx]; }

  remember(card) { if (card?.instanceId && card.definitionId) this.known.set(card.instanceId, card); }
  index(view) {
    for (const e of view.events) {
      const d = e.data ?? {};
      for (const card of [...(d.cards ?? []), ...(d.revealed ?? []), d.placed, d.card].filter((x) => x?.instanceId)) this.remember(card);
    }
    view.players.forEach((p, owner) => {
      if (Array.isArray(p.hand)) p.hand.forEach((c) => this.remember(c));
      p.discard.forEach((c) => this.remember(c)); p.lost.forEach((c) => this.remember(c));
      (p.prizes.faceUp ?? []).forEach((x) => this.remember(x.card));
      [p.active, ...p.bench].forEach((m, i) => {
        if (!m || m.faceDown) return;
        [...m.stack, ...m.energy, ...m.tools].forEach((c) => this.remember(c));
        this.monNames.set(m.id, { name: this.card(m.stack.at(-1).instanceId).name, owner, position: i === 0 ? '战斗' : `备战${i}` });
      });
    });
    if (view.stadium) this.remember(view.stadium);
    const q = view.pending;
    if (q) {
      [...(q.cards ?? []), ...(q.lookedAt ?? []), ...(q.energy ?? []).map((x) => x.card), ...(q.attacks ?? []).map((x) => x.card)].forEach((c) => this.remember(c));
      q.payment?.groups.forEach((g) => g.choices.forEach((c) => this.remember(c.card)));
      Object.values(q.faceUpSlots ?? {}).forEach((c) => this.remember(c));
    }
  }

  card(iid) {
    if (this.cards.has(iid)) return this.cards.get(iid);
    const ref = this.known.get(iid);
    if (!ref) return { uid: uidOf(iid), iid, name: '一张卡', kind: 'unknown', img: null, attacks: [], texts: {} };
    const d = this.catalog.definition(ref.definitionId), m = d.mechanics, info = this.presentation[ref.printingId] ?? {};
    const card = { uid: uidOf(iid), iid, id: ref.printingId, defId: d.definitionId, nameKey: d.nameKey, name: d.name, kind: d.kind,
      img: info.image ?? null, texts: info.texts ?? {}, setCode: info.setCode, number: info.number, mark: info.mark,
      implementation: implementationTier(this.catalog, ref.printingId),
      aceSpec: d.deckLimits.groups.some((g) => g.key === 'cn-ace-spec'), attacks: [] };
    if (d.kind === 'pokemon') {
      const from = m.evolvesFrom && this.catalog.definitions().find((x) => x.nameKey === m.evolvesFrom);
      Object.assign(card, { type: m.types[0], types: m.types, hp: m.hp, stage: STAGE_NUM[m.stage] ?? m.stage, stageKey: m.stage,
        evolvesFrom: from?.name ?? m.evolvesFrom ?? null, weakness: m.weakness, resistance: m.resistance, retreat: m.retreatCost,
        ruleBox: m.ruleBox, prizes: m.prizeCount, tags: m.tags,
        attacks: m.attacks.map((a) => ({ id: a.attackId, slug: slug(a.attackId), name: a.name, cost: a.cost,
          damage: damageText(a.printedDamage), base: a.printedDamage?.value ?? 0, fx: {} })),
        abilities: m.abilities.map((a) => ({ id: a.abilityId, slug: slug(a.abilityId), name: a.name })) });
    } else if (d.kind === 'trainer') {
      Object.assign(card, { ttype: m.category, tkind: d.nameKey, stadium: m.category === 'stadium', tool: m.category === 'tool',
        tags: m.tags ?? [], attacks: (m.grantedAttacks ?? []).map((a) => ({ id: a.attackId, name: a.name, cost: a.cost,
          damage: damageText(a.printedDamage), base: a.printedDamage?.value ?? 0, fx: {} })),
        abilities: (m.grantedAbilities ?? []).map((a) => ({ id: a.abilityId, slug: slug(a.abilityId), name: a.name })) });
    } else {
      const units = m.baseUnits.flat();
      Object.assign(card, { special: m.category === 'special' ? d.nameKey : null,
        energyType: m.category === 'basic' ? units[0] : units.length === 1 ? units[0] : 'Colorless' });
    }
    this.cards.set(iid, card);
    return card;
  }

  mon(m, owner, i) {
    if (m.faceDown) return { id: -(owner * 10 + i + 1), mid: null, facedown: true, card: { uid: 0, attacks: [], texts: {} },
      damage: 0, hpLeft: 0, maxHp: 0, energy: [], tools: [], energyTypes: [], payTypes: [], status: {}, effects: {}, conditions: () => [] };
    const stack = m.stack.map((c) => this.card(c.instanceId)), top = stack.at(-1), e = m.effective, c = m.conditions;
    const status = { asleep: c.rotation === 'asleep', paralyzed: c.rotation === 'paralyzed', confused: c.rotation === 'confused',
      poisoned: c.poison != null, burned: !!c.burned };
    const provided = e.energies.flatMap((x) => x.units.map((u) => (u.length === 1 ? u[0] : 'Colorless')));
    return { id: monNum(m.id), mid: m.id, card: top, stack, name: top.name, counters: m.counters, damage: m.counters * 10,
      hpLeft: e.currentHp, maxHp: e.maxHp, retreat: e.retreatCost, types: e.types,
      energy: m.energy.map((x) => this.card(x.instanceId)), tools: m.tools.map((x) => ({ card: this.card(x.instanceId) })),
      energyTypes: provided, payTypes: provided, status, effects: {},
      conditions: () => [...(c.rotation ? [CONDITION_KEYS[c.rotation]] : []), ...(status.poisoned ? ['poisoned'] : []), ...(status.burned ? ['burned'] : [])] };
  }

  player(p, idx) {
    return { idx, deckKey: this.decks?.[idx],
      hand: Array.isArray(p.hand) ? p.hand.map((c) => this.card(c.instanceId)) : Array.from({ length: p.hand.count }, () => null),
      deck: { length: p.deckCount }, prizes: Array.from({ length: p.prizes.count }, (_, i) => {
        const up = p.prizes.faceUp?.find((x) => x.index === i);
        return up ? this.card(up.card.instanceId) : null;
      }),
      discard: p.discard.map((c) => this.card(c.instanceId)), lost: p.lost.map((c) => this.card(c.instanceId)),
      active: p.active ? this.mon(p.active, idx, 0) : null, bench: p.bench.map((m, i) => this.mon(m, idx, i + 1)),
      benchLimit: p.benchLimit, turns: p.turns, flags: {} };
  }

  build(view) {
    this.index(view);
    this.view = view;
    this.phase = view.result ? 'over' : view.phase === 'setup' ? 'setup' : 'main';
    this.turn = view.turn;
    this.players = view.players.map((p, idx) => this.player(p, idx));
    this.current = view.current == null ? null : this.players[view.current];
    this.first = view.first;
    this.format = view.format;
    this.stadium = view.stadium ? { card: this.card(view.stadium.instanceId), owner: view.stadium.owner } : null;
    this.winner = view.result ? (view.result.winner == null ? 'draw' : this.players[view.result.winner]) : null;
    this.winReason = view.result ? { text: this.reason(view) } : null;
  }

  reason(view) {
    const r = view.result;
    if (r.reason === 'ordinary' && r.winner != null) {
      const loser = view.players[1 - r.winner], winner = view.players[r.winner];
      if (!loser.active && !loser.bench.length) return `${who(1 - r.winner)}的场上已没有宝可梦。`;
      if (winner.prizes.count === 0) return `${who(r.winner)}拿取了全部奖赏卡。`;
    }
    if (r.reason === 'deckout' && r.winner != null) return `${who(1 - r.winner)}在回合开始时牌库无牌可抽。`;
    return REASON[r.reason] ?? r.reason;
  }

  monLabel(mid) {
    const m = this.monNames.get(mid);
    return m ? `${m.name}（${m.owner === ME ? '我方' : '对手'}${m.position}）` : '宝可梦';
  }
  monById(mid) { return this.players.flatMap((p) => this.allMons(p)).find((m) => m.mid === mid) ?? null; }

  // Whether a player has played a Trainer of this kind (supporter, stadium…) this turn: the events since the last
  // turn ended.
  playedThisTurn(player, ttype) {
    const events = this.view.events, start = events.findLastIndex((e) => e.ruleId === 'turn.end') + 1;
    return events.slice(start).some((e) => e.data?.player === player &&
      ((e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open') || e.ruleId === 'turn.stadium') && this.card(e.data.cardId).ttype === ttype);
  }

  // A rule the player is under now that stops this kind of play (e.g. 痒痒花粉: no Items from the hand next turn).
  lockedFrom(player, action) {
    return this.view.playerOngoing.some((e) => e.player === player && e.active && e.effect.actions?.includes(action));
  }

  // ---------------- Your moves and choices ----------------
  // One move per legal action. A Pokémon Tool becomes one move per Pokémon it can go on (asked by the kernel
  // right after it is played), so it can be dragged onto that Pokémon like Energy.
  actions(view) {
    const out = [];
    view.legalActions.forEach((cmd, i) => {
      const key = 'a' + i, base = { key, cmd };
      const mon = (mid) => this.monById(mid);
      switch (cmd.type) {
        case 'endTurn': out.push({ ...base, kind: 'end', label: { key: 'act.end' } }); break;
        case 'bench': { const card = this.card(cmd.cardId); out.push({ ...base, kind: 'bench', card, label: { key: 'act.bench', params: { c: card.name } } }); break; }
        case 'evolve': {
          const card = this.card(cmd.cardId), target = mon(cmd.pokemonId);
          out.push({ ...base, kind: 'evolve', card, target, label: { key: 'act.evolve', params: { c: card.name, m: this.monLabel(cmd.pokemonId) } } });
          break;
        }
        case 'attachEnergy': {
          const card = this.card(cmd.cardId), target = mon(cmd.pokemonId);
          out.push({ ...base, kind: 'energy', card, target, label: { key: 'act.energy', params: { c: card.name, m: this.monLabel(cmd.pokemonId) } } });
          break;
        }
        case 'playTrainer': {
          const card = this.card(cmd.cardId);
          const targets = card.tool ? this.probe(view, cmd, 'tool-target') : null;
          if (targets?.length) targets.forEach((mid, j) => out.push({ ...base, key: `${key}.${j}`, kind: 'trainer', card, ttype: card.ttype,
            target: mon(mid), follow: { kind: 'tool-target', option: mid },
            label: { key: 'act.tool', params: { c: card.name, m: this.monLabel(mid) } } }));
          // trainer.joint-play: N cards of this name played together.
          else if (cmd.jointCardIds) out.push({ ...base, kind: 'trainer', card, ttype: card.ttype,
            label: { key: 'act.trainerJoint', params: { c: card.name, n: cmd.jointCardIds.length + 1 } } });
          else out.push({ ...base, kind: 'trainer', card, ttype: card.ttype, label: { key: 'act.trainer', params: { c: card.name } } });
          break;
        }
        case 'retreat': {
          const active = this.players[ME].active;
          out.push({ ...base, kind: 'retreat', target: active, label: { key: 'act.retreat', params: { n: active?.retreat ?? 0 } } });
          break;
        }
        case 'vUnion': { const card = this.card(cmd.cardIds[0]); out.push({ ...base, kind: 'bench', card, label: { key: 'act.vunion', params: { c: card?.name ?? '' } } }); break; }
        case 'leavePlay': out.push({ ...base, kind: 'power', target: mon(cmd.pokemonId), label: { key: 'act.leave', params: { m: this.monLabel(cmd.pokemonId) } } }); break;
        case 'recallCard': { const card = this.card(cmd.cardId); out.push({ ...base, kind: 'trainer', card, label: { key: 'act.recall', params: { c: card?.name ?? '' } } }); break; }
        case 'useStadium': out.push({ ...base, kind: 'stadium', card: this.stadium?.card, label: { key: 'act.stadium', params: { c: this.stadium?.card.name ?? '' } } }); break;
        case 'useAbility': {
          if (cmd.cardId) { // An Ability used from hand or the discard pile.
            const card = this.card(cmd.cardId), ability = card?.abilities?.find((a) => a.id === cmd.abilityId);
            out.push({ ...base, kind: 'power', card, label: { key: 'act.ability', params: { a: ability?.name ?? '', m: card?.name ?? '' } } });
            break;
          }
          // A Tool's printed Ability (tools.granted-ability) is named on that Tool.
          const target = mon(cmd.pokemonId), ability = (cmd.toolId ? this.card(cmd.toolId) : target?.card)?.abilities?.find((a) => a.id === cmd.abilityId);
          out.push({ ...base, kind: 'power', target, label: { key: 'act.ability', params: { a: ability?.name ?? '', m: this.monLabel(cmd.pokemonId) } } });
          break;
        }
        case 'attack': {
          const active = this.players[ME].active;
          const atk = active?.card.attacks.find((a) => a.id === cmd.attackId) ?? this.grantedAttack(cmd.attackId);
          out.push({ ...base, kind: 'attack', atk, label: { key: atk?.damage ? 'act.attackDmg' : 'act.attack', params: { a: atk?.name ?? '', d: atk?.damage ?? '' } } });
          break;
        }
        default: out.push({ ...base, kind: 'trainer', label: { key: 'act.other', params: { t: cmd.type } } });
      }
    });
    return out;
  }

  grantedAttack(attackId) {
    for (const def of this.catalog.definitions()) {
      const a = [...(def.mechanics.attacks ?? []), ...(def.mechanics.grantedAttacks ?? [])].find((x) => x.attackId === attackId);
      if (a) return { id: a.attackId, name: a.name, cost: a.cost, damage: damageText(a.printedDamage), base: a.printedDamage?.value ?? 0, fx: {} };
    }
    return null;
  }

  // The first choice an action would ask for, worked out on a throwaway copy. Used only for a Tool's own targets
  // (your Pokémon), never for anything hidden.
  probe(view, cmd, kind) {
    try {
      const copy = OfficialGame.restore(structuredClone(this.game.snapshot()), { catalog: this.catalog });
      copy.dispatch({ player: ME, expectedRevision: view.revision, action: cmd });
      const q = copy.view(ME).pending;
      return q?.kind === kind ? [...q.options] : null;
    } catch { return null; }
  }

  prompt(view) {
    const q = view.pending;
    const source = q.effect ? this.card(q.effect.sourceId) : q.payment ? this.card(q.payment.source.instanceId) : null;
    const title = q.payment?.optional ? '可选：选择要放于弃牌区的卡牌（不选则不执行「在这种情况下」的效果）' :
      q.payment?.groups.some((g) => g.kind === 'lostHand') ? '使用条件：选择要放于放逐区的卡牌' :
      q.kind === 'coin-reflip' && q.coins ? `${PROMPT_TITLE[q.kind]}（这次的结果：${q.coins.results.map(COIN).join('、')}）` : PROMPT_TITLE[q.kind] ?? '请选择';
    return { kind: q.kind, id: q.id, title, source, min: q.minimum, max: q.maximum,
      allowZero: q.allowZero, options: q.options.map((id) => this.option(id, q)),
      lookedAt: (q.lookedAt ?? []).map((c) => this.card(c.instanceId)),
      alloc: q.counterAllocation ? { total: q.counterAllocation.total,
        targets: q.counterAllocation.targets.map((x) => ({ id: x.pokemonId, mon: this.monById(x.pokemonId), counters: x.counters })) } : null,
      raw: q };
  }

  option(id, q) {
    const pay = q.payment?.groups.flatMap((g) => g.choices).find((c) => c.optionId === id);
    if (pay) return { id, card: this.card(pay.card.instanceId) };
    const copied = q.attacks?.find((a) => a.optionId === id);
    if (copied) return { id, label: `${copied.name}${copied.printedDamage ? `（${damageText(copied.printedDamage)}）` : ''}` };
    if (/^m\d+$/.test(id)) { const mon = this.monById(id); return mon ? { id, mon } : { id, label: this.monLabel(id) }; }
    if (this.known.has(id)) return { id, card: this.card(id) };
    // A Prize position: its card only when that Prize is face up.
    if (q.kind === 'prize' || q.kind === 'prize-slot') return q.faceUpSlots?.[id] ? { id, card: this.card(q.faceUpSlots[id].instanceId) } : { id, back: true };
    if (NUMBER_KINDS[q.kind]) return { id, label: `${id}${NUMBER_KINDS[q.kind]}` };
    if (q.kind === 'choose-effect') return { id, label: `卡面第${Number(id) + 1}个效果` };
    if (q.kind === 'second-attack' && id !== 'skip') return { id, label: this.grantedAttack(id)?.name ?? id };
    if (q.kind === 'coin-reflip' && id !== 'keep') return { id, label: `重新抛掷（${q.coins?.reflip?.[id] ? this.card(q.coins.reflip[id]).name : id}）` };
    return { id, label: OPTION_TEXT[id] ?? id };
  }

  // ---------------- The game loop ----------------
  actor() {
    const v0 = this.game.view(ME);
    if (v0.result) return null;
    if (v0.pending || v0.legalActions.length) return ME;
    const v1 = this.game.view(OPP);
    if (v1.pending || v1.legalActions.length) return OPP;
    throw new Error('Neither player has a decision to make.');
  }

  // resume: a restored game, whose opening was already shown.
  async run({ resume = false } = {}) {
    this.stopped = false;
    const opening = this.game.view(ME).events.find((e) => e.ruleId === 'setup.order' && 'decisionWinner' in (e.data ?? {}));
    if (opening && !resume) {
      await this.hooks.onOpening?.({ winner: opening.data.decisionWinner });
      // What happened before the first decision (who won the right to choose) goes to the log after the show.
      for (const e of this.game.view(ME).events) { const text = this.eventLine(e); if (text) this.hooks.onLog?.({ text, kind: 'sys' }); }
    }
    this.hooks.onCheckpoint?.(this);
    for (let actor = this.actor(); actor !== null && !this.stopped; actor = this.actor()) {
      const view = this.game.view(actor);
      if (actor === ME) {
        if (view.pending) {
          const answer = await this.controllers[ME].choose(this, this.players[ME], this.prompt(view));
          if (this.stopped) return;
          await this.apply(ME, view.revision, answer?.allocations
            ? { type: 'allocateCounters', requestId: view.pending.id, allocations: answer.allocations }
            : { type: 'answer', requestId: view.pending.id, selected: [].concat(answer ?? []) });
        } else {
          const move = await this.controllers[ME].chooseAction(this, this.players[ME], this.actions(view));
          if (this.stopped) return;
          await this.apply(ME, view.revision, move.cmd, move);
          const next = this.game.view(ME).pending;
          // A Tool dropped on a Pokémon answers the kernel's "which Pokémon" question itself.
          if (move.follow && next?.kind === move.follow.kind && next.options.includes(move.follow.option))
            await this.apply(ME, this.game.view(ME).revision, { type: 'answer', requestId: next.id, selected: [move.follow.option] });
        }
      } else {
        const action = await this.controllers[OPP].decide(view, OPP);
        if (this.stopped) return;
        if (!action) throw new Error('The CPU found no action.');
        await this.apply(OPP, view.revision, action);
      }
      this.hooks.onCheckpoint?.(this);
    }
    if (!this.stopped) this.hooks.onGameOver?.(this);
  }

  // onDispatch / onError see every dispatch the kernel takes or refuses (the game's record, ui.js).
  async apply(player, revision, action, move = null) {
    const before = this.game.view(ME);
    try {
      this.game.dispatch({ player, expectedRevision: revision, action });
    } catch (error) {
      this.hooks.onError?.(error, player, { revision, action });
      if (player !== ME) throw error;
      return;
    }
    this.hooks.onDispatch?.({ player, revision, action });
    const after = this.game.view(ME);
    const events = after.events.slice(before.events.length);
    await this.replay(before, after, events);
    if (player === ME) this.hooks.onMoveDone?.({ move, quiet: !after.pending && events.every((e) => QUIET.has(e.ruleId)) });
  }

  // ---------------- Replaying a dispatch as animations ----------------
  async replay(before, after, events) {
    const H = this.hooks;
    this.index(after);
    const handBefore = new Set(before.players[ME].hand.map((c) => c.instanceId));
    const newHand = after.players[ME].hand.filter((c) => !handBefore.has(c.instanceId)).map((c) => this.card(c.instanceId));
    const countersBefore = new Map(before.players.flatMap((p) => [p.active, ...p.bench]).filter((m) => m && !m.faceDown).map((m) => [m.id, m]));
    const countersAfter = new Map(after.players.flatMap((p) => [p.active, ...p.bench]).filter((m) => m && !m.faceDown).map((m) => [m.id, m.counters]));
    const placed = (mid) => {
      const b = countersBefore.get(mid);
      if (!b) return 0;
      const a = countersAfter.get(mid);
      return a == null ? Math.max(1, Math.ceil(b.effective.currentHp / 10)) : Math.max(0, a - b.counters);
    };
    let arena = false, prizeCards = newHand.slice();
    const closeArena = async () => { if (!arena) return; arena = false; this.build(after); await H.onAttackEnd?.(); };
    const coins = async (results, why, params = {}) => {
      let so = 0;
      for (const r of results) { await H.onCoin?.({ h: r === 'heads', why: results.length > 1 ? 'multi' : why, params: { ...params, so } }); if (r === 'heads') so++; }
    };
    for (const e of events) {
      const d = e.data ?? {};
      if (arena && !ATTACK_EVENTS.has(e.ruleId)) await closeArena();
      const line = this.eventLine(e);
      if (line) H.onLog?.({ text: line, kind: e.ruleId === 'ko.boundary' && d.kind === 'latched' ? 'ko' : d.player === ME ? 'you' : d.player === OPP ? 'opp' : 'sys' });
      switch (e.ruleId) {
        case 'turn.bench': H.onBench?.({ p: d.player, card: this.card(d.cardId) }); break;
        case 'turn.evolve':
          await H.onEvolve?.({ p: d.player, mon: monNum(d.pokemonId), from: this.card(d.fromCardId), to: this.card(d.cardId) }); break;
        case 'turn.energy': case 'turn.tool':
          if (!d.byEffect) await H.onAttach?.({ p: d.player, mon: monNum(d.pokemonId), card: this.card(d.cardId) }); break;
        case 'turn.trainer': if (d.kind === 'trainer-open') await H.onTrainer?.({ p: d.player, card: this.card(d.cardId) }); break;
        case 'turn.stadium': await H.onTrainer?.({ p: d.player, card: this.card(d.cardId) }); break;
        case 'attack.used': {
          if (d.kind !== 'used') break;
          const attacker = countersBefore.get(d.source.pokemonId), target = before.players[1 - d.player].active;
          const card = attacker && this.card(attacker.stack.at(-1).instanceId);
          const atk = card?.attacks.find((a) => a.id === d.source.attackId) ?? this.grantedAttack(d.source.attackId);
          if (attacker && target && !target.faceDown) {
            await H.onAttack?.({ p: d.player, from: monNum(attacker.id), to: monNum(target.id), atk: atk?.name ?? '', type: card?.type ?? 'Colorless' });
            arena = true;
          }
          break;
        }
        case 'attack.order': {
          const notes = (d.calculation ?? []).flatMap((s) => s.ruleId === 'damage.weakness' && s.after > s.before ? ['weakness']
            : s.ruleId === 'damage.resistance' && s.after < s.before ? ['resistance'] : []);
          await H.onHit?.({ from: monNum(d.pokemonId), to: monNum(d.targetId), n: d.damage, notes });
          break;
        }
        case 'damage.counters':
          if (d.removed) await H.onHit?.({ from: null, to: monNum(d.to), n: d.removed * 10, notes: ['counters'] });
          else if (d.targetId && placed(d.targetId)) await H.onHit?.({ from: null, to: monNum(d.targetId), n: placed(d.targetId) * 10, notes: ['counters'] });
          break;
        case 'damage.counter-distribution':
          if (d.kind === 'resolved') for (const u of d.updates ?? []) if (u.placedCounters)
            await H.onHit?.({ from: null, to: monNum(u.pokemonId), n: u.placedCounters * 10, notes: ['counters'] });
          break;
        case 'effects.coin': await coins([d.result], 'effect'); break;
        case 'effects.coin-reflip': await coins(d.discarded, 'attack'); break;
        case 'status.burn': case 'status.sleep': case 'status.confusion':
          if ('heads' in d) await coins([d.heads ? 'heads' : 'tails'], e.ruleId.split('.')[1]); break;
        case 'attack.failure.self': case 'attack.failure.imposed': await coins(d.receipt?.results ?? [], 'attack'); break;
        case 'damage.coins': if (d.kind === 'rolled') await coins(d.receipt?.results ?? [], 'attack'); break;
        case 'ko.boundary':
          if (d.kind === 'latched') H.onKnockout?.({ owner: d.item.owner, mon: monNum(d.item.id) });
          else if (d.taken && d.player === ME) { const card = prizeCards.shift(); if (card) await H.onPrize?.(this.players[ME], card, d.remaining); }
          else if (d.taken) H.onOppPrize?.();
          break;
        default: break;
      }
    }
    await closeArena();
    this.build(after);
    H.onUpdate?.(this);
  }

  eventLine(e) {
    const d = e.data ?? {}, name = (id) => `「${this.card(id).name}」`, mon = (id) => `「${this.monLabel(id)}」`;
    switch (e.ruleId) {
      case 'setup.order': return 'decisionWinner' in d ? `${who(d.decisionWinner)}获得了决定先攻后攻的权利。` : `${who(d.chooser)}选择了${d.first === d.chooser ? '先攻' : '后攻'}；${who(d.first)}先攻。`;
      case 'setup.mulligan': return `${who(d.player)}的起手没有基础宝可梦，展示手牌后重抽${d.shared ? '（双方同时）' : ''}。`;
      case 'effects.draw': return d.count ? `${who(d.player)}抽了${d.count}张牌。` : null;
      case 'turn.trainer': return d.kind !== 'trainer-open' ? null : d.jointCardIds ? `${who(d.player)}同时使用了${d.jointCardIds.length + 1}张${name(d.cardId)}。` :
        `${who(d.player)}使用了${name(d.cardId)}。`;
      case 'turn.bench': return `${who(d.player)}将${name(d.cardId)}放于备战区。`;
      case 'turn.evolve': return `${who(d.player)}将${name(d.fromCardId)}进化为${name(d.cardId)}。`;
      case 'turn.energy': return `${who(d.player)}为${mon(d.pokemonId)}附着了${name(d.cardId)}${d.byEffect ? '（效果）' : ''}。`;
      case 'turn.tool': return `${who(d.player)}为${mon(d.pokemonId)}放置了${name(d.cardId)}。`;
      case 'turn.stadium': return `${who(d.player)}使出了竞技场${name(d.cardId)}。`;
      case 'ability.usage': {
        const m = this.monById(d.pokemonId), ability = (d.toolId ? this.card(d.toolId) : m?.card)?.abilities?.find((a) => a.id === d.abilityId);
        return `${who(d.player)}使用了${mon(d.pokemonId)}的特性${ability ? `「${ability.name}」` : ''}。`;
      }
      case 'attack.used': {
        if (d.kind !== 'used') return null;
        const atk = this.grantedAttack(d.source.attackId);
        return `${who(d.player)}的${mon(d.source.pokemonId)}使用了招式${atk ? `「${atk.name}」` : ''}。`;
      }
      case 'attack.order': return `对${mon(d.targetId)}造成${d.damage}伤害。`;
      case 'effects.coin': return `抛掷硬币：${COIN(d.result)}${d.result === d.required ? '，执行后续效果' : '，不执行后续效果'}。`;
      case 'effects.janken': return d.kind === 'result' ? `猜拳：${who(d.player)}出${OPTION_TEXT[d.hands[d.player]]}，${who(1 - d.player)}出${OPTION_TEXT[d.hands[1 - d.player]]}${
        d.result === 'tie' ? '，平手，再来一次' : d.result === 'win' ? `，${who(d.player)}赢了` : `，${who(1 - d.player)}赢了`}。` : null;
      case 'effects.coin-reflip': return `${who(d.player)}无视了这次抛掷硬币的结果（${d.discarded.map(COIN).join('、')}），重新抛掷。`;
      case 'effects.coin-choice': return d.face ? `${who(d.player)}决定第1枚硬币为${COIN(d.face)}。` : null;
      case 'tools.attack-tails': return `${name(d.cardId)}：这个回合结束时将抽取卡牌。`;
      case 'effects.condition': return `效果条件${d.met ? '成立' : '不成立'}。`;
      case 'status.cure': return `${mon(d.targetId)}的${d.conditions.map((c) => OPTION_TEXT[c]).join('、')}状态恢复了。`;
      case 'effects.deck-order': {
        const end = (at) => (at === 'top' || at === 'deckTop' ? '上方' : '下方');
        if ('looked' in d) return `${who(d.player)}牌库${end(d.from)}的${d.looked}张卡牌被查看。`;
        if (d.result) return `${who(d.player)}牌库${end(d.from)}的${d.count}张卡牌${DECK_ORDER[d.result]}。`;
        return d.to ? `${who(d.player)}将${d.count}张卡牌放回牌库${end(d.to)}。` : null;
      }
      case 'attack.failure.self': case 'attack.failure.imposed':
        return `招式判定掷币：${(d.receipt?.results ?? []).map(COIN).join('、')} → ${d.receipt?.passed ? '招式照常使用' : '招式失败'}。`;
      case 'status.burn': return 'heads' in d ? `灼伤检查掷币：${d.heads ? '正面，灼伤恢复' : '反面'}。` : d.counters ? `${mon(d.pokemonId ?? d.targetId)}因灼伤被放置${d.counters}个伤害指示物。` : null;
      case 'status.poison': return d.counters ? `${mon(d.pokemonId ?? d.targetId)}因中毒被放置${d.counters}个伤害指示物。` : null;
      case 'status.sleep': return 'heads' in d ? `睡眠检查掷币：${d.heads ? '正面，醒来了' : '反面，仍在睡眠'}。` : null;
      case 'status.confusion': return 'heads' in d ? `混乱掷币：${d.heads ? '正面' : '反面，招式失败'}。` : null;
      case 'status.paralysis': return d.pokemonId ? `${mon(d.pokemonId)}的麻痹恢复了。` : null;
      case 'status.clear': return d.to ? `${mon(d.to)}换到了战斗场。` : null;
      case 'ko.boundary':
        if (d.kind === 'latched') return `${name(d.item.topCardId)}昏厥了。`;
        if (d.taken) return `${who(d.player)}拿取了${d.taken}张奖赏卡（剩余${d.remaining}张）。`;
        return null;
      case 'ko.prize-destination': return d.discarded?.length || d.lost?.length ? `${who(d.player)}拿取的奖赏卡${[[d.discarded, '放于弃牌区'], [d.lost, '放入放逐区']]
        .filter(([cards]) => cards?.length).map(([cards, to]) => `${cards.map((c) => name(c.instanceId)).join('、')}${to}`).join('，')}。` : null;
      case 'effects.knockout': return `${mon(d.pokemonId)}因效果昏厥。`;
      case 'effects.field-return': return `${who(d.player)}的${name(d.pokemonCards.at(-1))}${d.to === 'discard' ? '被放于弃牌区' : d.to === 'hand' ? '回到手牌' :
        d.to === 'deckTop' ? '放回牌库上方' : ['deckBottom', 'shuffleBottom'].includes(d.to) ? '放回牌库下方' : '放回牌库'}。`;
      case 'effects.attached-return': return `${mon(d.pokemonId)}身上的卡牌放回牌库。`;
      case 'ko.hand': return `${mon(d.pokemonId)}回到手牌。`;
      case 'damage.counters': return d.removed ? `从${mon(d.from)}转放${d.removed}个伤害指示物到${mon(d.to)}。` :
        d.targetId ? `${mon(d.targetId)}身上被放置了伤害指示物。` : null;
      case 'damage.counter-distribution': return d.kind === 'resolved' ? (d.updates ?? []).filter((u) => u.placedCounters)
        .map((u) => `${mon(u.pokemonId)}身上被放置了${u.placedCounters}个伤害指示物。`).join('') || null : null;
      case 'effects.heal': return d.targetId ? `${mon(d.targetId)}回复了${d.amount ? `${d.amount}HP` : 'HP'}。` : null;
      case 'ko.promote': return `${who(d.player)}将${mon(d.pokemonId)}放到战斗场。`;
      case 'turn.end': return `${who(d.player)}的回合结束。`;
      case 'effects.switch': return `${mon(d.targetId)}被换到战斗场。`;
      case 'effects.hand-deck': return `${who(d.player)}将${d.count}张手牌放回牌库并重洗牌库。`;
      case 'effects.discard': return d.effectId ? `${who(d.player)}将手牌放于弃牌区。` : null;
      case 'effects.deploy': return d.cardId ? `${who(d.player)}将${name(d.cardId)}放于备战区。` : d.count ? `${who(d.player)}将${d.count}张宝可梦放于备战区。` : null;
      case 'effects.attach': return d.energyId ? `${name(d.energyId)}附着于${mon(d.pokemonId)}。` : null;
      case 'energy.attached-selection': return d.discarded ? `${name(d.energyId)}被放于弃牌区。` : null;
      case 'effects.search': return d.revealed?.length && d.player !== undefined ? `${who(d.player)}展示并加入手牌：${d.revealed.map((c) => this.card(c.instanceId).name).join('、')}。` :
        d.kind === 'to-hand' && d.card ? `${who(d.player)}将${name(d.card.instanceId)}加入手牌。` : null;
      case 'effects.return': return d.revealed?.length ? `${who(d.player)}将${d.revealed.map((c) => this.card(c.instanceId).name).join('、')}${d.to === 'deck' ? '放回牌库' : '加入手牌'}。` : null;
      case 'energy.move': return `${name(d.energyId)}转附于${mon(d.to)}。`;
      case 'energy.return': return `${name(d.energyId)}回到手牌。`;
      case 'effects.stadium-discard': return d.performed ? `竞技场${name(d.subject.instanceId)}被放于弃牌区。` : null;
      case 'effects.deck-top-discard': return `${who(d.player)}牌库上方的${(d.cards ?? []).map((c) => name(c.instanceId)).join('') || '0张卡牌'}被放于弃牌区。`;
      case 'effects.replace': return `${name((d.discarded ?? d.lost)[0])}${d.lost ? '被放于放逐区' : '被放于弃牌区'}，${name(d.placed.instanceId)}放于其原先的位置。`;
      case 'effects.deck-bottom-discard': return `${who(d.player)}牌库下方的${(d.cards ?? []).map((c) => name(c.instanceId)).join('') || '0张卡牌'}被放于弃牌区。`;
      case 'bench.limit': return `${who(d.player)}因备战区上限将${name(d.discarded[0])}放于弃牌区。`;
      case 'win.simultaneous': case 'win.concede': return '对局结束。';
      default: return null;
    }
  }

  stop() { this.stopped = true; }
}
