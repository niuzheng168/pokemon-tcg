// Accounts, login sessions and saved decks in one SQLite file (node:sqlite: no dependencies).
//   users     username (case-insensitive, unique), scrypt password hash, role user | admin
//   sessions  SHA-256 of the cookie token (a stolen database file holds no usable session), expiry
//   decks     a player's saved list: name, format, cards [[printingId, count], …] as JSON
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_DAYS = 30;
export const ROLES = ['user', 'admin'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('standard', 'open')),
  cards TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id);
`;

const now = () => new Date().toISOString();
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}
// Compared against when a username does not exist, so a wrong name takes as long as a wrong password.
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'));

const publicUser = (row) => row && { id: row.id, username: row.username, role: row.role, createdAt: row.created_at, lastLoginAt: row.last_login_at };
const publicDeck = (row) => row && { id: row.id, name: row.name, format: row.format, cards: JSON.parse(row.cards), createdAt: row.created_at, updatedAt: row.updated_at };

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const sql = {
    userByName: q('SELECT * FROM users WHERE username = ?'),
    userById: q('SELECT * FROM users WHERE id = ?'),
    insertUser: q('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)'),
    setPassword: q('UPDATE users SET password = ? WHERE id = ?'),
    setRole: q('UPDATE users SET role = ? WHERE id = ?'),
    touchLogin: q('UPDATE users SET last_login_at = ? WHERE id = ?'),
    deleteUser: q('DELETE FROM users WHERE id = ?'),
    listUsers: q(`SELECT u.*, (SELECT COUNT(*) FROM decks d WHERE d.user_id = u.id) AS deck_count
      FROM users u ORDER BY u.created_at, u.id`),
    countAdmins: q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    insertSession: q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    purgeSessions: q('DELETE FROM sessions WHERE expires_at <= ?'),
    listDecks: q('SELECT * FROM decks WHERE user_id = ? ORDER BY updated_at DESC, id DESC'),
    getDeck: q('SELECT * FROM decks WHERE user_id = ? AND id = ?'),
    countDecks: q('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?'),
    insertDeck: q('INSERT INTO decks (user_id, name, format, cards, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    updateDeck: q('UPDATE decks SET name = ?, format = ?, cards = ?, updated_at = ? WHERE user_id = ? AND id = ?'),
    deleteDeck: q('DELETE FROM decks WHERE user_id = ? AND id = ?'),
  };

  return {
    // ---- users ----
    async createUser({ username, password, role = 'user' }) {
      if (!ROLES.includes(role)) throw new RangeError(`Unknown role: ${role}`);
      const { lastInsertRowid } = sql.insertUser.run(username, await hashPassword(password), role, now());
      return publicUser(sql.userById.get(lastInsertRowid));
    },
    userByName: (username) => publicUser(sql.userByName.get(username)),
    userById: (id) => publicUser(sql.userById.get(id)),
    // The user when the password matches, otherwise null; a missing name costs the same hash as a wrong password.
    async checkPassword(username, password) {
      const row = sql.userByName.get(username);
      const ok = await verifyPassword(password, row?.password ?? DUMMY_HASH);
      return ok && row ? publicUser(row) : null;
    },
    async setPassword(id, password) { sql.setPassword.run(await hashPassword(password), id); },
    setRole(id, role) {
      if (!ROLES.includes(role)) throw new RangeError(`Unknown role: ${role}`);
      sql.setRole.run(role, id);
    },
    deleteUser: (id) => sql.deleteUser.run(id).changes > 0,
    listUsers: () => sql.listUsers.all().map((row) => ({ ...publicUser(row), decks: row.deck_count })),
    countAdmins: () => sql.countAdmins.get().n,

    // ---- sessions: the cookie carries a random token, the database only its hash ----
    createSession(userId) {
      const token = randomBytes(32).toString('base64url'), at = new Date();
      sql.purgeSessions.run(at.toISOString());
      sql.insertSession.run(tokenHash(token), userId, at.toISOString(), new Date(at.getTime() + SESSION_DAYS * 864e5).toISOString());
      sql.touchLogin.run(at.toISOString(), userId);
      return token;
    },
    sessionUser: (token) => (token ? publicUser(sql.sessionUser.get(tokenHash(token), now())) : null),
    deleteSession: (token) => { sql.deleteSession.run(tokenHash(token)); },
    // Signs a user out everywhere, except (optionally) the session that asked.
    deleteUserSessions: (userId, keepToken = '') => { sql.deleteUserSessions.run(userId, keepToken ? tokenHash(keepToken) : ''); },

    // ---- decks ----
    listDecks: (userId) => sql.listDecks.all(userId).map(publicDeck),
    getDeck: (userId, id) => publicDeck(sql.getDeck.get(userId, id)),
    countDecks: (userId) => sql.countDecks.get(userId).n,
    createDeck(userId, { name, format, cards }) {
      const at = now();
      const { lastInsertRowid } = sql.insertDeck.run(userId, name, format, JSON.stringify(cards), at, at);
      return publicDeck(sql.getDeck.get(userId, lastInsertRowid));
    },
    updateDeck(userId, id, { name, format, cards }) {
      if (!sql.updateDeck.run(name, format, JSON.stringify(cards), now(), userId, id).changes) return null;
      return publicDeck(sql.getDeck.get(userId, id));
    },
    deleteDeck: (userId, id) => sql.deleteDeck.run(userId, id).changes > 0,

    close: () => db.close(),
  };
}
