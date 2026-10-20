/**
 * JSON-value equality for the offline schema compiler's const/enum helper.
 * A plain and a null-prototype record can describe the same JSON value.
 * Do not use constructors, valueOf/toString/toJSON or invoke property getters.
 * This is software validation infrastructure, not a Pokemon battle rule.
 */
const plain = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const scalar = (value) => value === null || ['string', 'boolean'].includes(typeof value) ||
  typeof value === 'number' && Number.isFinite(value);

function equal(a, b, left, right) {
  if (scalar(a) || scalar(b)) return scalar(a) && scalar(b) && a === b;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || left.has(a) || right.has(b)) return false;
  const array = Array.isArray(a);
  if (array !== Array.isArray(b) || (array ?
    Object.getPrototypeOf(a) !== Array.prototype || Object.getPrototypeOf(b) !== Array.prototype : !plain(a) || !plain(b))) return false;
  const keys = Reflect.ownKeys(a), other = Reflect.ownKeys(b);
  if (keys.length !== other.length || array && (a.length !== b.length || keys.length !== a.length + 1)) return false;
  left.add(a); right.add(b);
  try {
    if (array) {
      for (let i = 0; i < a.length; i++) {
        const x = Object.getOwnPropertyDescriptor(a, String(i)), y = Object.getOwnPropertyDescriptor(b, String(i));
        if (!x || !y || !x.enumerable || !y.enumerable || !Object.hasOwn(x, 'value') || !Object.hasOwn(y, 'value') ||
            !equal(x.value, y.value, left, right)) return false;
      }
    } else for (const key of keys) {
      if (typeof key !== 'string') return false;
      const x = Object.getOwnPropertyDescriptor(a, key), y = Object.getOwnPropertyDescriptor(b, key);
      if (!x.enumerable || !y || !y.enumerable || !Object.hasOwn(x, 'value') || !Object.hasOwn(y, 'value') ||
          !equal(x.value, y.value, left, right)) return false;
    }
    return true;
  } finally { left.delete(a); right.delete(b); }
}

export default function jsonEqual(a, b) {
  try { return equal(a, b, new Set(), new Set()); }
  catch { return false; } // Reflection failure (e.g. a revoked proxy) is not equality.
}
