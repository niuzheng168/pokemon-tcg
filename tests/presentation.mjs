import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { CARDS, DECKS, loadDeck } from '../public/cards.js';
import { Game, Mon } from '../public/engine.js';
import {
  t, setLang, cardName, attackName, powerName, deckName, cardImage, imageLabel,
} from '../public/i18n.js';
import { CHINESE_CARDS, chineseTerm, missingScanFallback, registerMissingScan, configureResearchScans } from '../public/card-presentation.js';

await Promise.all(Object.keys(DECKS).map(loadDeck));
const originals = JSON.stringify(CARDS);
const glossary = JSON.parse(await readFile(new URL('../docs/zh-CN-terminology.json', import.meta.url), 'utf8'));
setLang('zh-CN');
assert.equal(Object.keys(CHINESE_CARDS).length, Object.keys(CARDS).length);
const nonTechnicalEnglish = (s) => String(s).replaceAll(/VMAX|VSTAR|VIP|GX|EX|ex|HP|HANDY505/g, '').match(/[A-Za-z]{3,}/);
for (const card of Object.values(CARDS)) {
  assert(!nonTechnicalEnglish(cardName(card)), `Card name still English: ${card.id}`);
  for (let i = 0; i < (card.attacks?.length || 0); i++) {
    assert(!nonTechnicalEnglish(attackName(card, i)), `Attack still English: ${card.id}/${i}`);
    const effect = CHINESE_CARDS[card.id]?.attacks[i]?.effect || '';
    for (const term of glossary.avoid) assert(!effect.includes(term), `Nonstandard rule term in imported effect: ${card.id}/${i}: ${term}`);
  }
  if (card.power) assert(!nonTechnicalEnglish(powerName(card)), `Power still English: ${card.id}`);
  const file = new URL('../public/' + cardImage(card), import.meta.url);
  try {
    await access(file);
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
    const fallback = missingScanFallback(cardImage(card));
    assert(fallback, `Missing unhandled card image: ${card.id}`);
    await access(new URL('../public/' + fallback, import.meta.url));
  }
  assert(imageLabel(card).includes('原卡图') || imageLabel(card).includes('非官方扫描')
    || imageLabel(card).includes('官网配图裁取，非原件'));
}
for (const [key, deck] of Object.entries(DECKS)) assert(!nonTechnicalEnglish(deckName(key, deck)), `Deck title still English: ${key}`);
assert.equal(chineseTerm('Mewtwo'), '超梦');
assert.equal(chineseTerm('notMewtwoSuffix'), 'notMewtwoSuffix');
assert.equal(chineseTerm('Base Set'), 'Base Set', 'Do not replace ordinary "Set" with an unrelated card name');
assert.equal(chineseTerm('TAG TEAM'), 'TAG TEAM');
assert.equal(chineseTerm('Pokémon TCG Academy'), 'Pokémon TCG Academy', 'Preserve accents in unrelated brands');
assert.equal(cardName(CARDS['sv10-19']), '火箭队的团珠蛛');
assert.equal(attackName(CARDS['sv10-19'], 0), '猛撞');
assert(!t('log.attack', { P: { $pl: 0 }, m: "Team Rocket's Tarountula", atk: 'Take Down' }).includes('Tarountula'));
assert(!t('act.evolve', { from: 'Pikachu', to: 'Raichu', s: { $slot: ['bench', 1] } }).includes('Pikachu'));
assert.equal(t('log.decks', { a: { $deck: 'ash', name: 'Ash' }, b: { $deck: 'brock', name: 'Brock' } }), '你使用小智的卡组，小茂使用小刚的卡组。');
for (const key of ['jungle', 'fossil', 'theme', 'base2', 'rocket', 'gym1', 'gym2', 'swshTheme', 'smTheme']) {
  for (const suffix of ['', '.sub']) assert(!nonTechnicalEnglish(t('deckgroup.' + key + suffix)), `Untranslated deck group: ${key}${suffix}`);
}

// The display adapter must not break the previously reproduced identity/evolution case.
let uid = 990000;
const bot = { chooseAction: async (_g, _p, actions) => actions.at(-1), choose: async (_g, _p, prompt) => prompt.options[0].id, setupBench: async () => [] };
const game = new Game({ decks: ['svl-mewtwo', 'svl-mewtwo'], controllers: [bot, bot], hooks: {} });
const [me, opponent] = game.players;
for (const p of game.players) { p.hand = []; p.prizes = p.deck.splice(-6); }
Object.assign(game, { current: me, turn: 5, phase: 'main' });
me.active = new Mon({ ...CARDS['sv10-19'], uid: uid++ }, 0);
opponent.active = new Mon({ ...CARDS['sv10-81'], uid: uid++ }, 0);
me.hand = [{ ...CARDS['sv10-20'], uid: uid++ }];
const energy = Object.values(CARDS).find((c) => c.kind === 'energy' && !c.special && c.energyType === 'Grass');
me.active.energy = [{ ...energy, uid: uid++ }];
assert(game.legalActions(me).some((a) => a.kind === 'evolve'));
await game.attack(me, 0);
assert.equal(opponent.active.damage, 30);
assert.equal(me.active.damage, 10);
assert.equal(JSON.stringify(CARDS), originals);
const scannedCard = Object.values(CARDS).find((card) => CHINESE_CARDS[card.id]?.scan);
assert(scannedCard);
assert(imageLabel(scannedCard).includes('原卡图'));
const missingUrl = cardImage(scannedCard);
assert(registerMissingScan(missingUrl));
assert(cardImage(scannedCard).includes('/zh-learning/'));
assert(imageLabel(scannedCard).includes('非官方扫描'));
const researchCard = Object.values(CARDS).find((card) => !CHINESE_CARDS[card.id]?.scan);
const researchUrl = '/api/research-card/' + '1'.repeat(64) + '.png';
assert.equal(configureResearchScans({ cards: { [researchCard.id]: { url: researchUrl, language: 'zh-Hans' } } }), false);
assert(!cardImage(researchCard).includes('/api/research-card/'));
assert(configureResearchScans({ local_only: true, redistribution_permitted: false,
  cards: { [researchCard.id]: { url: researchUrl, language: 'zh-Hans' } } }));
assert.equal(cardImage(researchCard), researchUrl);
assert(imageLabel(researchCard).includes('仅本地研究'));
assert(registerMissingScan(researchUrl).includes('/zh-learning/'));
assert(imageLabel(researchCard).includes('非官方扫描'));
setLang('en');
assert.equal(cardName(CARDS['sv10-19']), "Team Rocket's Tarountula");
assert.equal(attackName(CARDS['sv10-19'], 0), 'Take Down');
assert.equal(cardImage(CARDS['sv10-19']), CARDS['sv10-19'].img);
assert.equal(cardImage(scannedCard), scannedCard.img);
console.log(`Presentation checks passed: ${Object.keys(CARDS).length} cards, all attacks/powers/deck titles, local assets, Chinese logs, English toggle, and unchanged evolution/damage.`);
