// effects.copy-supporter 「将该支援者的效果，作为这张卡牌／这个招式的效果使用」: where a copy chooses its Supporter card, and
// which use conditions of the chosen card a copy cannot judge.
export const SUPPORTER_COPY_RULE_IDS = Object.freeze(['effects.copy-supporter']);

// The player and zone the printed text names: the opponent's hand, the user's own hand, or the opponent's discard pile.
export const copyHolder = (owner, action) => action.from === 'ownHand' ? owner : 1 - owner;
export const copyZone = (action) => action.from === 'opponentDiscard' ? 'discard' : 'hand';

// 「这张卡牌，只有在自己的手牌只剩这1张时才可使用」「…其他手牌的数量在4张以下…」「（如果自己的手牌仅有这1张卡牌的话，则无法使用…）」:
// the encoded count includes this card in its user's hand. A copied card is not in the copying player's hand, and the
// JP rulings answer by the printed wording (カツラの一発勝負: never; エリカのおもてなし: the hand as it is), which the count
// alone cannot tell apart.
export function readsOwnHand(node) {
  if (Array.isArray(node)) return node.some(readsOwnHand);
  if (!node || typeof node !== 'object') return false;
  return node.kind === 'zoneCount' && node.side === 'own' && node.zone === 'hand' || Object.values(node).some(readsOwnHand);
}
