import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../server/store.mjs';

const exec = promisify(execFile), script = fileURLToPath(new URL('../../scripts/user-admin.mjs', import.meta.url));

test('the account CLI creates and toggles coach permission independently of role, without printing passwords', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cn-user-admin-')), db = join(dir, 'accounts.db');
  const env = { ...process.env, USER_PASSWORD: 'private-test-pass-1' };
  const run = (...args) => exec(process.execPath, [script, ...args, '--db', db], { env });
  const user = (name) => {
    const store = openStore(db);
    try { return store.userByName(name); } finally { store.close(); }
  };
  try {
    const made = await run('add', 'coached', '--coach');
    assert.doesNotMatch(made.stdout, /private-test-pass-1|scrypt/);
    assert.deepEqual([user('coached').role, user('coached').coachEnabled], ['user', true]);
    await run('add', 'admin', '--admin');
    assert.equal(user('admin').coachEnabled, false);
    await run('coach', 'admin', 'on');
    assert.equal(user('admin').coachEnabled, true);
    await run('coach', 'coached', 'off');
    assert.equal(user('coached').coachEnabled, false);
    await assert.rejects(run('coach', 'coached', 'true'), /Coach permission must be on or off/);
    await assert.rejects(run('coach', 'missing', 'on'), /No user named missing/);
    await run('add', 'pvp-only', '--pvp-coach');
    assert.deepEqual([user('pvp-only').coachEnabled, user('pvp-only').pvpCoachEnabled], [false, true]);
    assert.equal(user('admin').pvpCoachEnabled, false);
    await run('pvp-coach', 'admin', 'on');
    assert.deepEqual([user('admin').coachEnabled, user('admin').pvpCoachEnabled], [true, true]);
    await run('pvp-coach', 'pvp-only', 'off');
    assert.equal(user('pvp-only').pvpCoachEnabled, false);
    await assert.rejects(run('pvp-coach', 'admin', 'true'), /Coach permission must be on or off/);
    await assert.rejects(run('pvp-coach', 'missing', 'on'), /No user named missing/);
    const listed = (await run('list')).stdout;
    assert.match(listed, /coached\tuser\tcoach off/);
    assert.match(listed, /admin\tadmin\tcoach on\tpvp-coach on/);
    assert.doesNotMatch(listed, /private-test-pass-1|scrypt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
