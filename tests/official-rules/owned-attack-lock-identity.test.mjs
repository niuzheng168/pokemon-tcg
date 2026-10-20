// Synthetic OfficialGame identity fixtures only, never real-card approval.
// Selection owns a physical printed ref. It is NOT an attackId-wide or
// international same-name ban. Unreviewed direct same-name source competition
// stays needsRuling; C-18 content does not rename its outer declaration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, attached, command, answer, settle,
} from './fixtures.mjs';

const RULE = 'attack.owned-lock';
const SOURCE = 'identity:source';
const ALPHA = 'identity:alpha';
const BETA = 'identity:beta';
const EVO_ALPHA = 'identity:evolution-alpha';
const EVO_BETA = 'identity:evolution-beta';
const clone = (value) => JSON.parse(JSON.stringify(value));
const option = ({ instanceId, attackId }) => JSON.stringify([instanceId, attackId]);
const spec = () => ({
  op: 'disableOwnedAttack', side: 'opponent', target: 'active', duration: 'nextOpponentTurn',
  clearOnBench: true, clearOnEvolution: true,
});
const lockBinding = (id = 'identity:lock') => binding('cn.disableOwnedAttack@1', spec(), id);
const printedAttack = (attackId, name, extra = {}) => ({
  attackId, name, cost: [], printedDamage: { value: 10, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE,
  ...extra,
});
const grant = (origins) => ({
  op: 'attackGrant', scope: 'self', targetSelector: { kind: 'pokemon' }, origins, excludeUser: false,
});
const grantAbility = (origins) => ({
  abilityId: 'identity:grant', name: '测试额外招式许可', mode: 'continuous', usage: null,
  effects: [binding('cn.attackGrant@1', grant(origins), 'identity:grant')], sourceOfTruth: EVIDENCE,
});
const copy = (origins, attackIds) => ({
  op: 'copyAttack', origins, excludeUser: false, coin: 'none', energy: 'ignore',
  special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE }, ...(attackIds ? { attackIds } : {}),
});
const origin = (zone, side = 'own', extra = {}) => ({
  side, zone, selector: { kind: 'pokemon' }, ...extra,
});

async function make(transform = () => {}) {
  return fixture((defs) => {
    defs[0].mechanics.attacks = [printedAttack(SOURCE, '测试现场禁用', {
      cost: ['Water'], printedDamage: { value: 0, operator: 'fixed' }, effects: [lockBinding()],
    })];
    defs[1].mechanics.attacks = [
      printedAttack(ALPHA, '测试卡面甲'), printedAttack(BETA, '测试卡面乙'),
    ];
    defs[2].mechanics.attacks = [
      printedAttack(EVO_ALPHA, '测试进化顶卡甲'), printedAttack(EVO_BETA, '测试进化顶卡乙'),
    ];
    transform(defs);
  });
}

function heldTool(s, owner, mon) {
  const id = hand(s, owner, 'tool'); s.players[owner].hand.pop(); mon.tools.push(id); return id;
}

function setup(f, { owner = 0, evolved = false, mutate = () => {} } = {}) {
  const ids = { owner, recipient: 1 - owner };
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    const p = s.players[ids.recipient], actor = s.players[owner].active;
    let target = p.active;
    if (evolved) {
      const id = hand(s, ids.recipient, 'evolution'); p.hand.pop(); target.stack.push(id);
    } else {
      target = bench(s, ids.recipient, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = target;
    }
    attached(s, owner, actor, 'water');
    Object.assign(ids, { actorId: actor.id, actorCardId: actor.stack.at(-1),
      targetId: target.id, topCardId: target.stack.at(-1), lowerCardId: target.stack[0] });
    mutate(s, { actor, target, ...ids });
  });
  return { g, f, ...ids };
}

function restore(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  return r;
}

function declare(c) {
  command(c.g, { type: 'attack', attackId: SOURCE }, c.owner);
}

function prompt(g, owner, targetId, refs) {
  const saved = g.snapshot(), q = saved.pending, choice = q?.data.ownedAttackChoice;
  assert.equal(q?.kind, 'owned-attack');
  assert.equal(q.player, owner); assert.equal(q.ruleId, RULE); assert.equal(q.id, choice.id);
  assert.deepEqual(q.options, refs.map(option), 'Literal expected physical top-card refs, in printed order.');
  assert.deepEqual(choice.candidates, refs);
  assert.deepEqual(choice.target, { pokemonId: targetId, topCardId: refs[0].instanceId });
  assert.equal(choice.owner, 1 - owner);
  assert.equal(q.minimum, 1); assert.equal(q.maximum, 1); assert.equal(q.allowZero, false);
  return { saved, q, choice };
}

function select(g, f, ref) {
  const r = restore(g, f);
  answer(r, [option(ref)]); settle(r);
  return r;
}

function appliedLock(g, choiceId, ref) {
  const s = g.snapshot();
  const receipt = s.events.filter((e) => e.ruleId === RULE && e.data.kind === 'applied' && e.data.id === choiceId);
  assert.equal(receipt.length, 1); assert.equal(receipt[0].data.performed, true);
  assert.deepEqual(receipt[0].data.selected, [ref]);
  const entries = s.ongoing.filter((entry) => entry.ownedAttackLockId === choiceId);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.deepEqual(entry.effect, { op: 'ownedAttackRestriction', scope: 'all', reference: ref });
  assert.equal(entry.id, receipt[0].data.entryId);
  return entry;
}

function atomicAnswer(g, selected) {
  const before = g.snapshot();
  assert.throws(() => answer(g, selected));
  assert.deepEqual(g.snapshot(), before, 'An identity not in this printed window cannot change any state.');
}

const attackActions = (g, owner) => g.view(owner).legalActions.filter((a) => a.type === 'attack');
const unresolved = (error) => error?.name === 'EngineError' && error.code === 'unresolved-owned-attack-identity';

test('the real owned window excludes Tool, granted Bench and lower-stack attacks without filtering Energy, quotas or an existing printed lock', async () => {
  const extras = {};
  const f = await make((defs) => {
    const target = defs[2].mechanics;
    target.ruleBox = true;
    target.attacks[0].cost = ['Fire', 'Fire', 'Fire']; target.attacks[0].specialRule = 'GX';
    target.attacks[1].cost = ['Metal', 'Metal']; target.attacks[1].specialRule = 'VSTAR';
    target.effects = [binding('cn.restriction@1', { effect: {
      op: 'restriction', scope: 'self', actions: ['attack'], attackIds: [EVO_ALPHA],
    } }, 'identity:existing-printed-lock')];
    target.abilities = [grantAbility([
      origin('bench', 'own', { selector: { kind: 'pokemon', nameKeys: ['other'] } }),
      origin('evolution', 'own', { subject: 'user' }),
    ])];
    const tool = defs.find((d) => d.definitionId === 'tool');
    tool.mechanics.effects = [];
    tool.mechanics.grantedAttacks = [printedAttack('identity:tool-only', '测试道具独有招式')];
  });
  const c = setup(f, { evolved: true, mutate: (s, { target, recipient }) => {
    extras.tool = heldTool(s, recipient, target);
    extras.bench = bench(s, recipient, 'other').stack.at(-1);
    s.players[recipient].gxUsed = true; s.players[recipient].vstarUsed = true;
  } });
  // Do not derive the oracle from attacksFor(), copyCandidates(), current
  // legalActions or any production owned-window helper.
  const refs = [{ instanceId: c.topCardId, attackId: EVO_ALPHA }, { instanceId: c.topCardId, attackId: EVO_BETA }];
  declare(c);
  const { choice, saved } = prompt(c.g, c.owner, c.targetId, refs);
  assert.equal(saved.players[c.recipient].active.energy.length, 0);
  assert.equal(saved.players[c.recipient].gxUsed, true); assert.equal(saved.players[c.recipient].vstarUsed, true);
  for (const ref of [
    { instanceId: extras.tool, attackId: 'identity:tool-only' },
    { instanceId: extras.bench, attackId: ALPHA },
    { instanceId: c.lowerCardId, attackId: SOURCE },
  ]) atomicAnswer(c.g, [option(ref)]);
  const r = select(c.g, f, refs[0]), entry = appliedLock(r, choice.id, refs[0]);
  assert.equal(entry.targetId, c.targetId); restore(r, f);
  assert.deepEqual(r.snapshot().cards, saved.cards);
});

test('a prior real owned-lock receipt does not remove its printed attack from a second native selection', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [lockBinding('identity:first'), lockBinding('identity:second')];
  });
  const c = setup(f), refs = [{ instanceId: c.topCardId, attackId: ALPHA }, { instanceId: c.topCardId, attackId: BETA }];
  declare(c); const first = prompt(c.g, c.owner, c.targetId, refs);
  let g = restore(c.g, f); answer(g, [option(refs[0])]);
  const second = prompt(g, c.owner, c.targetId, refs);
  assert.notEqual(second.choice.id, first.choice.id); appliedLock(g, first.choice.id, refs[0]);
  g = select(g, f, refs[0]);
  appliedLock(g, first.choice.id, refs[0]); appliedLock(g, second.choice.id, refs[0]); restore(g, f);
  assert(!attackActions(g, c.recipient).some((a) => a.attackId === ALPHA));
  assert(attackActions(g, c.recipient).some((a) => a.attackId === BETA));
});

test('both copied source owners select the actual user’s opponent Active, retaining foreign content provenance and the exact selected top ref', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].name = '测试外层复制者';
    defs[0].mechanics.attacks[0].effects = [binding('cn.copyAttack@1',
      copy([origin('bench', 'opponent', { selector: { kind: 'pokemon', nameKeys: ['other'] } })], [ALPHA]),
      'identity:copy-lock')];
    defs[1].mechanics.attacks[0].effects = [lockBinding('identity:borrowed-lock')];
  });
  for (const owner of [0, 1]) {
    let borrowed;
    const c = setup(f, { owner, evolved: true, mutate: (s, { recipient }) => {
      borrowed = bench(s, recipient, 'other').stack.at(-1);
    } });
    declare(c); assert.equal(c.g.snapshot().pending.kind, 'copy-attack');
    let g = restore(c.g, f); answer(g, [option({ instanceId: borrowed, attackId: ALPHA })]);
    const refs = [{ instanceId: c.topCardId, attackId: EVO_ALPHA }, { instanceId: c.topCardId, attackId: EVO_BETA }];
    const p = prompt(g, owner, c.targetId, refs), source = p.q.data.source;
    assert.equal(p.saved.cards[borrowed].owner, c.recipient);
    assert.equal(source.owner, owner); assert.equal(source.cardOwner, owner);
    assert.equal(source.instanceId, c.actorCardId); assert.equal(source.pokemonId, c.actorId);
    assert.equal(source.attackId, SOURCE); assert.equal(p.choice.sourceId, c.actorCardId);
    assert.deepEqual(source.contentSource, { instanceId: borrowed, attackId: ALPHA });
    assert.equal(typeof source.copyId, 'string'); assert(source.copyId.length);
    g = select(g, f, refs[0]);
    const entry = appliedLock(g, p.choice.id, refs[0]);
    assert.deepEqual(entry.source, source); assert.equal(entry.targetId, c.targetId);
    assert.equal(entry.deadline.player, c.recipient); restore(g, f);
    assert(!attackActions(g, c.recipient).some((a) => a.attackId === EVO_ALPHA));
    assert(attackActions(g, c.recipient).some((a) => a.attackId === EVO_BETA));
  }
});

test('same attackId on a differently named Tool route does not inherit the selected native ref’s ban', async () => {
  const f = await make((defs) => {
    const tool = defs.find((d) => d.definitionId === 'tool'); tool.mechanics.effects = [];
    tool.mechanics.grantedAttacks = [printedAttack(ALPHA, '测试异名道具招式')];
  });
  let toolId;
  const c = setup(f, { mutate: (s, { target, recipient }) => { toolId = heldTool(s, recipient, target); } });
  declare(c);
  const ref = { instanceId: c.topCardId, attackId: ALPHA };
  const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: BETA }]);
  let g = select(c.g, f, ref); appliedLock(g, p.choice.id, ref);
  const available = attackActions(g, c.recipient).filter((a) => a.attackId === ALPHA);
  assert.equal(available.length, 1);
  assert.deepEqual(JSON.parse(available[0].referenceId), ['tool', toolId, ALPHA]);
  g = restore(g, f); command(g, available[0], c.recipient); settle(g);
  const used = g.snapshot().events.filter((e) => e.ruleId === 'attack.used' && e.data.kind === 'used').at(-1).data;
  assert.equal(used.source.instanceId, toolId); assert.equal(used.source.owner, c.recipient);
  assert.equal(g.snapshot().players[c.owner].active.counters, 1); restore(g, f);
});

test('a different-name grant sharing the top native attackId stays usable even though grant.instanceId is that same top card', async () => {
  const f = await make((defs) => {
    defs[1].mechanics.attacks[0].attackId = EVO_ALPHA;
    defs[1].mechanics.attacks[0].name = '测试异名借用招式';
    defs[2].mechanics.abilities = [grantAbility([
      origin('bench', 'own', { selector: { kind: 'pokemon', nameKeys: ['other'] } }),
    ])];
  });
  let borrowed;
  const c = setup(f, { evolved: true, mutate: (s, { recipient }) => {
    borrowed = bench(s, recipient, 'other').stack.at(-1);
  } });
  declare(c);
  const ref = { instanceId: c.topCardId, attackId: EVO_ALPHA };
  const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: EVO_BETA }]);
  let g = select(c.g, f, ref); appliedLock(g, p.choice.id, ref);
  const available = attackActions(g, c.recipient).filter((a) => a.attackId === EVO_ALPHA);
  assert.equal(available.length, 1); assert.equal(JSON.parse(available[0].referenceId)[0], 'grant');
  g = restore(g, f); command(g, available[0], c.recipient); settle(g);
  const used = g.snapshot().events.filter((e) => e.ruleId === 'attack.grant' && e.data.kind === 'used').at(-1).data;
  assert.equal(used.source.instanceId, c.topCardId); assert.equal(used.source.owner, c.recipient);
  assert.equal(used.reference.instanceId, borrowed); assert.equal(used.reference.attackId, EVO_ALPHA);
  assert.notEqual(used.reference.instanceId, ref.instanceId);
  assert.equal(g.snapshot().players[c.owner].active.counters, 1); restore(g, f);
});

test('a permission route to precisely the selected printed ref is blocked alongside native use, without blocking another printed ref', async () => {
  const f = await make((defs) => {
    defs[1].mechanics.abilities = [grantAbility([origin('active', 'own', { subject: 'user' })])];
  });
  const c = setup(f); declare(c);
  const ref = { instanceId: c.topCardId, attackId: ALPHA };
  const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: BETA }]);
  const g = select(c.g, f, ref), view = g.view(c.recipient);
  appliedLock(g, p.choice.id, ref);
  const routes = view.players[c.recipient].active.effective.attackRequirements.filter((a) => a.attackId === ALPHA);
  assert.equal(routes.length, 2, 'Printed ownership and permission remain present; only declaration is locked.');
  assert.equal(routes.filter((a) => a.contentSource?.instanceId === c.topCardId).length, 1);
  assert(!view.legalActions.some((a) => a.type === 'attack' && a.attackId === ALPHA));
  assert.equal(view.legalActions.filter((a) => a.type === 'attack' && a.attackId === BETA).length, 2);
  assert.deepEqual(view.unresolvedActions ?? [], [], 'An exactly equal ref is resolved, not a same-name competing source.');
  restore(g, f);
});

test('only a real same-name direct Tool/grant competitor raises the explicit CN identity ruling boundary, including an outer copying attack', async () => {
  for (const route of ['tool-copy', 'grant']) for (const enoughEnergy of [false, true]) {
    const f = await make((defs) => {
      if (route === 'tool-copy') {
        const tool = defs.find((d) => d.definitionId === 'tool'); tool.mechanics.effects = [];
        tool.mechanics.grantedAttacks = [printedAttack('identity:homonym-copy', '测试卡面甲', {
          cost: ['Water'],
          effects: [binding('cn.copyAttack@1', copy([origin('active')], [ALPHA]), 'identity:homonym-copy')],
        })];
      } else {
        defs[2].mechanics.attacks[0].name = '测试卡面甲';
        defs[2].mechanics.attacks[0].cost = ['Water'];
        defs[1].mechanics.abilities = [grantAbility([
          origin('discard', 'own', { selector: { kind: 'pokemon', nameKeys: ['evolution'] } }),
        ])];
      }
    });
    const c = setup(f, { mutate: (s, { target, recipient }) => {
      if (enoughEnergy) attached(s, recipient, target, 'water');
      if (route === 'tool-copy') heldTool(s, recipient, target);
      else {
        const id = hand(s, recipient, 'evolution'); s.players[recipient].hand.pop(); s.players[recipient].discard.push(id);
      }
    } });
    declare(c);
    const ref = { instanceId: c.topCardId, attackId: ALPHA };
    const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: BETA }]);
    const g = select(c.g, f, ref); appliedLock(g, p.choice.id, ref); restore(g, f);
    const before = g.snapshot(), view = g.view(c.recipient);
    const attackId = route === 'tool-copy' ? 'identity:homonym-copy' : EVO_ALPHA;
    const competingRoute = view.players[c.recipient].active.effective.attackRequirements.find((a) => a.attackId === attackId);
    assert(competingRoute, 'Insufficient Energy does not erase the actual printed/permission identity.');
    assert.equal(JSON.parse(competingRoute.referenceId)[0], route === 'tool-copy' ? 'tool' : 'grant');
    assert.equal(before.players[c.recipient].active.energy.length, enoughEnergy ? 1 : 0);
    assert.deepEqual(view.unresolvedActions ?? [], enoughEnergy ? [{
      type: 'attack', attackId, referenceId: competingRoute.referenceId,
      ruleId: RULE, code: 'unresolved-owned-attack-identity',
    }] : [], 'Only a competitor satisfying independent Energy legality reaches the identity-ruling boundary.');
    assert(!view.legalActions.some((a) => a.type === 'attack' && [ALPHA, attackId].includes(a.attackId)));
    assert(view.legalActions.some((a) => a.type === 'attack' && a.attackId === BETA));
    if (route === 'grant')
      assert(view.legalActions.some((a) => a.type === 'attack' && a.attackId === EVO_BETA),
        'A nonhomonymous grant remains normally legal, not swept into the ruling boundary.');
    assert.throws(() => command(g, { type: 'attack', attackId, referenceId: competingRoute.referenceId }, c.recipient),
      enoughEnergy ? unresolved : (error) => error?.code === 'illegal-action');
    assert.deepEqual(g.snapshot(), before, 'An unresolved or independently illegal identity cannot consume quotas, RNG or declaration state.');
  }
});

test('C-18 outer B may copy locked native A: selected content is not a new declaration of A', async () => {
  const f = await make((defs) => {
    defs[1].mechanics.attacks[1].effects = [
      binding('cn.copyAttack@1', copy([origin('active')], [ALPHA]), 'identity:B-copies-A'),
    ];
    defs[1].mechanics.attacks[1].printedDamage = null;
  });
  const c = setup(f); declare(c);
  const ref = { instanceId: c.topCardId, attackId: ALPHA };
  const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: BETA }]);
  let g = select(c.g, f, ref); appliedLock(g, p.choice.id, ref);
  const actions = attackActions(g, c.recipient);
  assert(!actions.some((a) => a.attackId === ALPHA));
  const outer = actions.find((a) => a.attackId === BETA); assert(outer);
  command(g, outer, c.recipient);
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  assert.deepEqual(g.snapshot().pending.data.copyChoice.candidates, [ref]);
  g = restore(g, f); answer(g, [option(ref)]); settle(g);
  const selected = g.snapshot().events.filter((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected').at(-1).data;
  assert.equal(selected.source.attackId, BETA); assert.equal(selected.source.owner, c.recipient);
  assert.deepEqual(selected.reference, ref);
  assert.equal(g.snapshot().players[c.recipient].active.facts.lastUsedAttack.attackId, BETA);
  assert.equal(g.snapshot().players[c.owner].active.counters, 1);
  restore(g, f);
});

test('real inherited replacement keeps the original lock/ref/receipt across restore, including another physical card of the same approved definition', async () => {
  for (const sameDefinition of [false, true]) {
    const replacementDefinition = sameDefinition ? 'other' : 'base';
    const f = await make((defs) => {
      defs[1].mechanics.abilities = [{
        abilityId: 'identity:inherit', name: '测试继承替换', mode: 'activated',
        usage: { period: 'turn', scope: 'pokemon', key: 'identity:inherit', limit: 1 },
        effects: [binding('cn.pokemonTransition@1', {
          op: 'inheritPokemon', target: 'self', targetSelector: { kind: 'pokemon' },
          from: 'hand', selector: { kind: 'pokemon', nameKeys: [replacementDefinition] },
          relation: sameDefinition ? 'sameName' : 'any', to: 'discard',
        }, 'identity:inherit')], sourceOfTruth: EVIDENCE,
      }];
      if (!sameDefinition) defs[0].mechanics.attacks.push(
        printedAttack(ALPHA, '测试异名继承招式甲'), printedAttack(BETA, '测试异名继承招式乙'));
    });
    let replacement;
    const c = setup(f, { mutate: (s, { recipient, target }) => {
      replacement = hand(s, recipient, replacementDefinition);
      attached(s, recipient, target, 'water');
    } });
    assert.notEqual(replacement, c.topCardId);
    declare(c);
    const ref = { instanceId: c.topCardId, attackId: ALPHA };
    const p = prompt(c.g, c.owner, c.targetId, [ref, { instanceId: c.topCardId, attackId: BETA }]);
    let g = select(c.g, f, ref);
    const originalLock = appliedLock(g, p.choice.id, ref), original = g.snapshot();
    const history = original.events.filter((e) => e.ruleId === RULE && e.data.id === p.choice.id);
    command(g, { type: 'useAbility', pokemonId: c.targetId, abilityId: 'identity:inherit' }, c.recipient);
    assert.equal(g.snapshot().pending.kind, 'transition-target');
    g = restore(g, f); answer(g, [c.targetId]);
    assert.equal(g.snapshot().pending.kind, 'transition-card');
    assert(g.snapshot().pending.options.includes(replacement));
    g = restore(g, f); answer(g, [replacement]); settle(g);
    const after = g.snapshot(), target = after.players[c.recipient].active;
    assert.equal(target.id, c.targetId); assert.equal(target.stack.at(-1), replacement);
    assert.equal(after.cards[replacement].definitionId, replacementDefinition);
    assert.equal(after.cards[c.topCardId].definitionId === after.cards[replacement].definitionId, sameDefinition);
    assert(after.players[c.recipient].discard.includes(c.topCardId));
    assert.deepEqual(target.energy, original.players[c.recipient].active.energy);
    assert.deepEqual(appliedLock(g, p.choice.id, ref), originalLock,
      'Inheritance must not clear, retarget, rewrite or re-date the original attached lock.');
    assert.deepEqual(after.events.filter((e) => e.ruleId === RULE && e.data.id === p.choice.id), history);
    const proof = after.events.filter((e) => e.ruleId === 'effects.inherit' &&
      e.data.pokemonId === c.targetId && e.data.fromCardId === c.topCardId && e.data.toCardId === replacement);
    assert.equal(proof.length, 1, 'The changed live top is justified by an actually executed inheritance edge.');
    assert.deepEqual(after.cards, original.cards); assert.deepEqual(after.rng, original.rng);
    const r = restore(g, f), view = r.view(c.recipient);
    assert.deepEqual(view.unresolvedActions ?? [], []);
    assert.equal(view.legalActions.some((a) => a.type === 'attack' && a.attackId === ALPHA), !sameDefinition,
      'Same approved definition/attack remains locked; another definition reusing that ID with a different name does not.');
    assert(view.legalActions.some((a) => a.type === 'attack' && a.attackId === BETA));
    const missingProof = clone(after);
    missingProof.events = missingProof.events.filter((e) => !(e.ruleId === 'effects.inherit' &&
      e.data.pokemonId === c.targetId && e.data.fromCardId === c.topCardId && e.data.toCardId === replacement));
    assert.throws(() => OfficialGame.restore(missingProof, { catalog: f.catalog }),
      (error) => error?.code === 'invalid-owned-attack-lock',
      'Matching a definition alone cannot authorize an unjournaled physical top replacement.');
    assert.deepEqual(g.snapshot(), after);
  }
});
