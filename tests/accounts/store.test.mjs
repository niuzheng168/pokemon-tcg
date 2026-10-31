// The accounts store (server/store.mjs) on node:sqlite. Node v24.1.0's node:sqlite binds a repeated numbered parameter
// (`?1 … ?1`) out of range (SQLITE_RANGE), which broke the match list on that version: every statement the store
// prepares takes anonymous `?` parameters only, and the match list keeps its behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, hashPassword } from '../../server/store.mjs';

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

test('coach permission defaults off for every role, is explicit, and updates existing sessions without changing roles', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const player = await store.createUser({ username: 'player', password: 'player-pass-1' });
  const admin = await store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  const coached = await store.createUser({ username: 'coached', password: 'coached-pass-1', coachEnabled: true });
  assert.deepEqual([player.coachEnabled, admin.coachEnabled, coached.coachEnabled], [false, false, true]);
  const token = store.createSession(player.id);
  store.setCoachEnabled(player.id, true);
  assert.equal(store.sessionUser(token).coachEnabled, true);
  assert.equal((await store.checkPassword('player', 'player-pass-1')).coachEnabled, true);
  assert.equal(store.listUsers().find((u) => u.id === player.id).coachEnabled, true);
  assert.equal(store.userById(player.id).role, 'user', 'Coach permission does not make an administrator.');
  store.setRole(player.id, 'admin');
  store.setCoachEnabled(player.id, false);
  assert.equal(store.sessionUser(token).coachEnabled, false);
  assert.equal(store.userByName('player').role, 'admin', 'The role does not restore coach permission.');
  assert.throws(() => store.setCoachEnabled(player.id, 'true'), TypeError);
  await assert.rejects(store.createUser({ username: 'invalid', password: 'valid-pass-1', coachEnabled: 1 }), TypeError);
});

test('an old database gains opt-in coach permission without losing accounts; grants survive reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cn-coach-migration-'));
  let store;
  try {
    const path = join(dir, 'accounts.db'), password = await hashPassword('existing-pass-1');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      created_at TEXT NOT NULL, last_login_at TEXT
    )`);
    const insert = old.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)');
    insert.run('existing-admin', password, 'admin', '2026-10-01T00:00:00.000Z');
    insert.run('existing-player', password, 'user', '2026-10-02T00:00:00.000Z');
    old.close();
    store = openStore(path);
    assert.deepEqual(store.listUsers().map((u) => [u.username, u.role, u.coachEnabled]),
      [['existing-admin', 'admin', false], ['existing-player', 'user', false]]);
    assert.equal((await store.checkPassword('EXISTING-ADMIN', 'existing-pass-1')).createdAt, '2026-10-01T00:00:00.000Z');
    const admin = store.userByName('existing-admin'), token = store.createSession(admin.id);
    store.setCoachEnabled(admin.id, true);
    store.close();
    store = openStore(path);
    assert.equal(store.sessionUser(token).coachEnabled, true);
    assert.equal(store.userByName('existing-player').coachEnabled, false);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PvP coaching is separately opt-in, migrates existing coach accounts, and persists grants and revocations', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cn-pvp-coach-')), path = join(dir, 'accounts.db');
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = openStore(path);
  t.after(() => store.close());
  const player = await store.createUser({ username: 'player', password: 'player-pass-1', coachEnabled: true });
  const admin = await store.createUser({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  const token = store.createSession(player.id);
  store.close();
  // The previous release already had CPU coach access, but not PvP access.
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE users DROP COLUMN pvp_coach_enabled');
  old.close();
  store = openStore(path);
  assert.deepEqual(store.listUsers().map((u) => [u.coachEnabled, u.pvpCoachEnabled]), [[true, false], [false, false]]);
  store.setPvpCoachEnabled(player.id, true);
  store.setCoachEnabled(player.id, false);
  assert.deepEqual([store.sessionUser(token).coachEnabled, store.sessionUser(token).pvpCoachEnabled], [false, true]);
  assert.equal((await store.checkPassword('player', 'player-pass-1')).pvpCoachEnabled, true);
  store.close();
  store = openStore(path);
  assert.equal(store.userByName('player').pvpCoachEnabled, true);
  store.setPvpCoachEnabled(player.id, false);
  assert.equal(store.sessionUser(token).pvpCoachEnabled, false);
  assert.equal(store.userById(admin.id).pvpCoachEnabled, false);
  const pvpOnly = await store.createUser({ username: 'pvp-only', password: 'player-pass-1', pvpCoachEnabled: true });
  assert.deepEqual([pvpOnly.role, pvpOnly.coachEnabled, pvpOnly.pvpCoachEnabled], ['user', false, true]);
  assert.throws(() => store.setPvpCoachEnabled(player.id, 'true'), TypeError);
  await assert.rejects(store.createUser({ username: 'invalid-pvp', password: 'valid-pass-1', pvpCoachEnabled: 1 }), TypeError);
});
