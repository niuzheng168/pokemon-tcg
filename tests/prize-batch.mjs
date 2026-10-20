// Deterministic legacy-engine regression, not CN-card approval/conformance.
// Every card is a physical object from the two actual sixty-card decks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, Mon } from '../public/engine.js';
import { loadDeck } from '../public/cards.js';

await loadDeck('me-gengar');

const ordinaryBasic = (c) => c.kind === 'pokemon' && c.stage === 0 && !c.tags?.includes('ex') && !c.powerKind;
const megaGengar = (c) => c.kind === 'pokemon' && c.name === 'Mega Gengar ex';
const take = (p, predicate) => {
  const i = p.deck.findIndex(predicate); assert(i >= 0, 'Required physical fixture card must exist in the deck.');
  return p.deck.splice(i, 1)[0];
};
const physicalCards = (g, p) => [
  ...p.deck, ...p.hand, ...p.discard, ...p.prizes, ...p.lost,
  ...g.allMons(p).flatMap((m) => m.allCards()),
  ...(g.stadium?.owner === p.idx ? [g.stadium.card] : []),
];
function assertConserved(g, original) {
  for (const p of g.players) {
    const cards = physicalCards(g, p), identities = original[p.idx];
    assert.equal(cards.length, 60, `Player ${p.idx} must retain sixty original cards.`);
    assert.equal(new Set(cards).size, 60, 'No physical object may appear in two locations.');
    assert.equal(new Set(cards.map((c) => c.uid)).size, 60, 'No physical UID may appear in two locations.');
    for (const c of cards) {
      assert(identities.has(c), 'No cloned/replaced/invented card or cross-owner movement is allowed.');
      assert.equal(c.uid, identities.get(c), 'The original physical UID must remain unchanged.');
    }
  }
  assert.equal(new Set(g.players.flatMap((p) => physicalCards(g, p).map((c) => c.uid))).size, 120);
}

function scenario({ attackerIndex, bonus, sourceDies = true, sourcePresent = true, fullStacks = false, victimOnBench = false }) {
  const prompts = [], picked = [], logs = [];
  const controller = {
    choose: async (g, p, prompt) => {
      assert(['prize', 'promote'].includes(prompt.kind), `Unexpected nondeterministic action: ${prompt.kind}`);
      assert(prompt.options.length > 0); assertConserved(g, original);
      if (prompt.kind === 'prize') {
        assert.equal(prompt.options[0].id, '0', 'The fake controller always takes the first Prize.');
        prompts.push(p.idx);
      }
      return prompt.options[0].id;
    },
  };
  const g = new Game({ decks: ['me-gengar', 'me-gengar'], controllers: [controller, controller], hooks: {
    onPrize: (p, card) => { picked.push({ owner: p.idx, card }); assertConserved(g, original); },
    onUpdate: () => assertConserved(g, original),
    onLog: (event) => logs.push(event),
  } });
  // Constructor shuffling must not affect fixture identity, setup or choices.
  // Restore original allocation order without mocking Math.random or oracles.
  for (const p of g.players) p.deck.sort((a, b) => a.uid - b.uid);
  const original = g.players.map((p) => new Map(p.deck.map((c) => [c, c.uid])));
  assert(original.every((cards) => cards.size === 60));
  const attacker = g.players[attackerIndex], defender = g.players[1 - attackerIndex];
  const source = new Mon(take(attacker, ordinaryBasic), 0);
  const victim = new Mon(take(defender, megaGengar), 0);
  assert.equal(source.card.stage, 0); assert.equal(source.card.tags?.includes('ex') ?? false, false);
  assert.equal(source.card.prizes ?? 1, 1);
  assert.equal(victim.card.prizes, 3); assert(victim.card.tags.includes('Mega')); assert(victim.card.tags.includes('ex'));
  attacker.active = source;
  if (victimOnBench) {
    defender.active = new Mon(take(defender, ordinaryBasic), 0);
    defender.bench.push(victim);
    attacker.bench.push(new Mon(take(attacker, ordinaryBasic), 0));
  } else defender.active = victim;
  if (fullStacks) {
    const lower = take(defender, (c) => c.kind === 'pokemon' && c.name === 'Gastly');
    const middle = take(defender, (c) => c.kind === 'pokemon' && c.name === 'Haunter');
    victim.stack.unshift(lower, middle);
    for (const [p, m] of [[attacker, source], [defender, victim]]) {
      m.energy.push(take(p, (c) => c.kind === 'energy' && !c.special));
      m.tools.push({ card: take(p, (c) => c.kind === 'trainer' && c.ttype === 'tool'), expires: 100 });
      p.bench.push(new Mon(take(p, ordinaryBasic), 0));
    }
  }
  for (const p of g.players) p.prizes = p.deck.splice(-6);
  attacker.until.alteredPrize = bonus; g.current = attacker; g.phase = 'main'; g.turn = 5;
  g.koBy = sourcePresent ? source : null;
  source.damage = sourceDies ? source.maxHp : 0; victim.damage = victim.maxHp;
  assert.equal(g.ownerOf(source), attacker); assert.equal(attacker.prizes.length, 6); assert.equal(defender.prizes.length, 6);
  assertConserved(g, original);
  return { g, attacker, defender, source, victim, original, prompts, picked, logs };
}

async function checkBatch(options) {
  const f = scenario(options), { g, attacker, defender, source, victim, original, prompts, picked } = f;
  const before = g.players.map((p) => [...p.prizes]);
  const sourceCards = [...source.allCards()], victimCards = [...victim.allCards()];
  // Independent regression oracle: printed Mega=3, ordinary Basic=1.
  // Do NOT call prizeValue/swshPrizeBonus or infer expectations from the result.
  const extra = options.bonus && options.sourcePresent !== false && !options.victimOnBench ? 1 : 0;
  const attackerTakes = 3 + extra, defenderTakes = options.sourceDies === false ? 0 : 1;
  await g.handleKOs(attacker);
  assert.equal(before[attacker.idx].length - attacker.prizes.length, attackerTakes,
    `Mega Gengar ex must give 3${extra ? '+1' : ''} Prizes even when its opposing source leaves in the same batch.`);
  assert.equal(before[defender.idx].length - defender.prizes.length, defenderTakes);
  assert.deepEqual(prompts, [...Array(attackerTakes).fill(attacker.idx), ...Array(defenderTakes).fill(defender.idx)],
    'The turn player chooses all their Prizes first; both owners receive their locked batch awards.');
  for (const [p, count] of [[attacker, attackerTakes], [defender, defenderTakes]]) {
    assert.deepEqual(picked.filter((x) => x.owner === p.idx).map((x) => x.card), before[p.idx].slice(0, count));
    assert.deepEqual(p.prizes, before[p.idx].slice(count));
    assert.deepEqual(p.hand, before[p.idx].slice(0, count));
  }
  assert(victimCards.every((c) => defender.discard.includes(c)));
  assert(!g.allMons(defender).includes(victim));
  if (options.sourceDies !== false) {
    assert(sourceCards.every((c) => attacker.discard.includes(c)));
    assert.equal(g.ownerOf(source), undefined, 'The former attacker really left play; a surviving source is not masking the regression.');
  } else {
    assert.equal(g.ownerOf(source), attacker); assert.equal(attacker.active, source);
    assert(sourceCards.every((c) => !attacker.discard.includes(c)));
  }
  assertConserved(g, original);
  return f;
}

// Owner0 is removed before the opposing Mega; owner1 is removed afterwards.
// Mirroring the physical owners catches both processing-order dependencies.
for (const attackerIndex of [0, 1]) for (const bonus of [false, true]) for (const sourceDies of [true, false]) {
  test(`legacy batch owner${attackerIndex}, altered=${bonus}, sourceDies=${sourceDies}: exact physical awards`, async () => {
    const { g, attacker, defender, logs } = await checkBatch({ attackerIndex, bonus, sourceDies });
    if (sourceDies) {
      assert.equal(g.winner, 'draw', 'With no surviving Pokémon on either side, the draw is decided after awarding both sides.');
      assert.equal(g.phase, 'over');
    } else {
      assert.equal(g.winner, attacker); assert.equal(g.phase, 'over');
      assert.equal(defender.active, null);
    }
    const win = logs.findIndex((e) => e.kind === 'win');
    const prizes = logs.map((e, i) => ({ e, i })).filter(({ e }) => ['log.prize', 'log.prizeCard'].includes(e.key));
    assert(win >= 0); assert(prizes.length > 0); assert(prizes.every(({ i }) => i < win));
  });
}

for (const attackerIndex of [0, 1]) {
  test(`legacy batch owner${attackerIndex}: real evolution stack/Energy/Tool cards conserve 60 each through KO and promotion`, async () => {
    const { g, attacker, defender, source, victim } = await checkBatch({
      attackerIndex, bonus: true, sourceDies: true, fullStacks: true,
    });
    assert.equal(g.winner, null); assert.equal(g.phase, 'main');
    assert(attacker.active && defender.active); assert.notEqual(attacker.active, source); assert.notEqual(defender.active, victim);
    assert.equal(victim.stack.length, 3); assert.equal(victim.energy.length, 1); assert.equal(victim.tools.length, 1);
  });

  test(`legacy batch owner${attackerIndex}: a retained Altered Creation flag without an attack source grants no extra Prize`, async () => {
    const { attacker, source, g } = await checkBatch({ attackerIndex, bonus: true, sourceDies: true, sourcePresent: false });
    assert.equal(attacker.until.alteredPrize, true); assert.equal(g.koBy, null); assert.equal(g.ownerOf(source), undefined);
  });

  test(`legacy batch owner${attackerIndex}: Altered Creation does not add a Prize for a Mega knocked out on the Bench`, async () => {
    const { g, attacker, defender } = await checkBatch({
      attackerIndex, bonus: true, sourceDies: true, victimOnBench: true,
    });
    assert.equal(g.winner, null); assert(attacker.active && defender.active);
  });
}
