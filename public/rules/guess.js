/**
 * effects.guess 「选择自己手牌中的1张宝可梦，（将该宝可梦的名字／该宝可梦所拥有的招式名字告知对手后，）反面朝上放置。由对手回答该宝可梦的
 * HP／名字／属性。将反面朝上的宝可梦翻到正面，如果正确的话，则对手…。如果不正确的话，则自己…。然后，将放置的卡牌放回自己手牌中。」
 *
 * Card facts only: which hand card may be set aside, what its user tells, and whether an answer is right. The host moves the
 * card, asks both players, draws and logs. The opponent's answer domain is the command schema's (urn:pokemon-tcg:effect-program
 * #/$defs/guessAnswer), never a list built from the catalog: a game's catalog holds both decks, so such a list would show the
 * opponent the user's deck.
 */
import { printedCard } from './card-selection.js';

// A Pokémon card in the hand whose told hint and asked property can be read there. An Item played as a Pokémon (pokemon.item-card)
// is an Item in the hand. JP Q&A カツラのクイズショー: a Pokémon V-UNION card out of play shows only its name and type — no attack
// names (nor HP) to tell or to answer; ヤレユータン「けんじゃのといかけ」: its type is.
export function guessableCard(definition, { hint, question }) {
  const card = printedCard(definition);
  if (card.kind !== 'pokemon') return false;
  if (card.mechanics.stage === 'V-UNION' && (hint === 'attackNames' || question === 'hp')) return false;
  return hint !== 'attackNames' || card.mechanics.attacks.length > 0;
}

// What the user tells before setting the card face down (a printed hint): its name, or the names of all its printed attacks.
export const guessHint = (definition, hint) => hint === 'name' ? { name: definition.name, nameKey: definition.nameKey } :
  { attackNames: definition.mechanics.attacks.map((a) => a.name) };

// Right when it is the printed HP, the card name (「X」 and 「X GX」「X V」「X ex」 are different names), or one of its types.
export function guessCorrect(definition, question, answer) {
  if (question === 'hp') return answer.hp === definition.mechanics.hp;
  return question === 'name' ? answer.name === definition.nameKey : definition.mechanics.types.includes(answer.type);
}
