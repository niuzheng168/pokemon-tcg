// Units of effect translation (scripts/effect_translate.py): one per distinct printed effect, shared by every card that
// prints it. What makes two printings the same unit: an attack's text and printed damage (a 「30+」 formula includes
// its base), an Ability's name and text (usage keys and 「其他的「X」」 read the name), a Trainer's or Special Energy's
// name, category and text, a Pokémon's rule-box text.
import { createHash } from 'node:crypto';

export const clean = (text) => (text ?? '').normalize('NFKC').replace(/\s+/g, '');

export function identity(u) {
  switch (u.kind) {
    case 'attack': return ['attack', clean(u.attack.damage), clean(u.text)];
    case 'ability': return ['ability', clean(u.ability.name), clean(u.text)];
    case 'trainer': return ['trainer', u.card.category ?? '', clean(u.card.name), clean(u.text)];
    case 'energy': return ['energy', clean(u.card.name), clean(u.text)];
    case 'rule': return ['rule', clean(u.text)];
    default: throw new TypeError(`Unknown unit kind ${u.kind}`);
  }
}

export function unitOf(u) {
  return { uid: createHash('sha256').update(JSON.stringify(identity(u))).digest('hex').slice(0, 16), ...u };
}
