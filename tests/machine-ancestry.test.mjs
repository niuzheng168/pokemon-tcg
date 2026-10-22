import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStage1Parents } from '../scripts/machine-ancestry.mjs';

const entry = (id, extra = {}) => ({ id, kind: 'pokemon', name: 'metadata-name', stage: 'stage1', evolvesFrom: 'unchecked-parent', ...extra });
const fields = (name, stage, parent) => Object.fromEntries(Object.entries({ name, stage, evolves_from: parent }).map(([k, value]) => [k, { value }]));
const row = (id, accepted, extra = {}) => ({ id, image: true, kind: 'pokemon', conflicts: [], accepted, ...extra });
const resolve = (name) => ({ 呱头蛙: 'frogadier', 呱呱泡蛙: 'froakie', 别的基础: 'other',
  '呱 头 蛙': 'frogadier', '呱呱 泡蛙': 'froakie' }[name]);

test('ancestry uses checked names/stages/parents, not unchecked library fallbacks or Wiki disambiguation suffixes', () => {
  const es = [entry('good', { name: 'wrong metadata name' }), entry('bad', { name: '呱头蛙', evolvesFrom: '呱呱泡蛙（SV5a）' })];
  const rs = new Map([['good', row('good', fields('呱头蛙', 'Stage 1', '呱呱泡蛙'))],
    ['bad', row('bad', {}, { image: false, conflicts: [{ field: 'name' }] })]]);
  assert.deepEqual([...buildStage1Parents({ entries: es }, rs, resolve).get('frogadier')], ['froakie']);
});

test('every link needs all three accepted fields and an image, and an accepted Basic stage cannot be overruled by metadata', () => {
  const es = Array.from({ length: 6 }, (_, i) => entry(String(i), { name: '呱头蛙' }));
  const full = fields('呱头蛙', 'Stage 1', '呱呱泡蛙');
  const missing = ['name', 'stage', 'evolves_from'].map((key) => { const value = structuredClone(full); delete value[key]; return value; });
  const rs = new Map(es.map((e, i) => [e.id, row(e.id, i < 3 ? missing[i] : i === 3 ? fields('呱头蛙', 'Basic', '呱呱泡蛙') : full,
    i === 4 ? { image: false } : i === 5 ? { conflicts: [{ field: 'evolves_from' }] } : {})]));
  assert.equal(buildStage1Parents({ entries: es }, rs, resolve).size, 0);
});

test('aliases collapse only through the checked identity table; genuinely conflicting checked parents remain ambiguous', () => {
  const es = [entry('a'), entry('b'), entry('c')];
  const rs = new Map([['a', row('a', fields('呱头蛙', 'Stage 1', '呱呱泡蛙'))],
    ['b', row('b', fields('呱 头 蛙', '1阶进化', '呱呱 泡蛙'))], ['c', row('c', fields('呱头蛙', 'Stage 1', '别的基础'))]]);
  const alias = buildStage1Parents({ entries: es.slice(0, 2) }, rs, resolve);
  assert.deepEqual([...alias.get('frogadier')], ['froakie']);
  assert.deepEqual([...buildStage1Parents({ entries: es }, rs, resolve).get('frogadier')], ['froakie', 'other']);
});

test('non-Pokémon, duplicate records, unknown identities and missing review rows cannot manufacture evolution links', () => {
  const es = [entry('a', { kind: 'trainer' }), entry('b', { duplicateOf: 'a' }), entry('c'), entry('d')];
  const rs = new Map([['a', row('a', fields('呱头蛙', 'Stage 1', '呱呱泡蛙'))],
    ['b', row('b', fields('呱头蛙', 'Stage 1', '呱呱泡蛙'))], ['c', row('c', fields('unknown', 'Stage 1', '呱呱泡蛙'))]]);
  assert.equal(buildStage1Parents({ entries: es }, rs, resolve).size, 0);
});
