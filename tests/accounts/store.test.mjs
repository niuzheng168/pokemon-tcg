// The accounts store (server/store.mjs) on node:sqlite. Node v24.1.0's node:sqlite binds a repeated numbered parameter
// (`?1 … ?1`) out of range (SQLITE_RANGE), which broke the match list on that version: every statement the store
// prepares takes anonymous `?` parameters only, and the match list keeps its behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../server/store.mjs';

// The SQL with its string literals, quoted identifiers and comments left out (a ':' or '$' inside them is not a parameter).
const code = (sql) => sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');

test('every statement the store prepares takes anonymous ? parameters only (no ?NNN, :name, @name or $name)', () => {
  const prepared = [], prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) { prepared.push(sql); return prepare.call(this, sql, ...rest); };
  try { openStore(':memory:'); } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.ok(prepared.length > 20, 'the store prepares its statements when it opens');
  for (const sql of prepared) assert.doesNotMatch(code(sql), /\?\d|[:@$][A-Za-z_]/, sql);
  // The check itself: the old statement and named forms are caught; string literals are not parameters.
  assert.match(code('SELECT 1 WHERE ?1 IS NULL OR a = ?1 LIMIT ?2'), /\?\d/);
  assert.match(code('SELECT 1 WHERE a = :a OR b = @b OR c = $c'), /[:@$][A-Za-z_]/);
  assert.doesNotMatch(code("SELECT 1 WHERE role = 'a:b' AND x = ?"), /\?\d|[:@$][A-Za-z_]/);
});

test('listMatches: every player\'s with a null user, one player\'s otherwise; newest first, at most the limit', async () => {
  const store = openStore(':memory:');
  const a = await store.createUser({ username: 'alpha', password: 'alpha-pass-1' });
  const b = await store.createUser({ username: 'bravo', password: 'bravo-pass-1' });
  const made = [a, b, a, b, a].map((user, i) => store.createMatch(user.id, { setup: { game: i } }));
  const ids = (list) => list.map((m) => m.id);
  assert.deepEqual(ids(store.listMatches(null)), ids(made).reverse());
  assert.deepEqual(ids(store.listMatches(null, 3)), ids(made).reverse().slice(0, 3));
  assert.deepEqual(ids(store.listMatches(a.id)), [made[4].id, made[2].id, made[0].id]);
  assert.deepEqual(ids(store.listMatches(b.id, 1)), [made[3].id]);
  assert.deepEqual(store.listMatches(a.id).map((m) => m.username), ['alpha', 'alpha', 'alpha']);
  assert.deepEqual(store.listMatches(9999), []);
  assert.equal(store.listMatches(null)[0].steps, 0);
});
