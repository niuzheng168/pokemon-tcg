// Manages website accounts in the server's database (server/store.mjs), e.g. to create the first administrator.
//   npm run user -- add <name> [--admin] [--coach] [--pvp-coach]  password from $USER_PASSWORD, else asked (hidden) on the terminal
//   npm run user -- passwd <name>             same; signs the user out everywhere
//   npm run user -- role <name> user|admin
//   npm run user -- coach <name> on|off        permission is independent of role
//   npm run user -- pvp-coach <name> on|off    separate permission for coaching against another person
//   npm run user -- delete <name>
//   npm run user -- list
// --db <file> (or $DB_PATH) picks the database; the default is the server's (.data/accounts.db).
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { USERNAME, PASSWORD_MIN, PASSWORD_MAX } from '../server/app.mjs';
import { ROOT } from '../server/catalog.mjs';

const { values: opt, positionals: [command, name, arg] } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string', default: process.env.DB_PATH || join(ROOT, '.data', 'accounts.db') },
  admin: { type: 'boolean', default: false },
  coach: { type: 'boolean', default: false },
  'pvp-coach': { type: 'boolean', default: false },
} });

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('Set USER_PASSWORD or run on a terminal.'));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let text = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          return resolve(text);
        }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }
        text = ch === '\u007f' ? text.slice(0, -1) : text + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function password() {
  let pw = process.env.USER_PASSWORD;
  if (pw === undefined) {
    pw = await askHidden('Password: ');
    if (pw !== await askHidden('Again: ')) throw new Error('The passwords differ.');
  }
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new Error(`A password needs ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  return pw;
}

const store = openStore(opt.db);
const user = () => store.userByName(name) ?? (() => { throw new Error(`No user named ${name}.`); })();
try {
  if (command === 'list') {
    for (const u of store.listUsers()) console.log(`${u.id}\t${u.username}\t${u.role}\tcoach ${u.coachEnabled ? 'on' : 'off'}\tpvp-coach ${u.pvpCoachEnabled ? 'on' : 'off'}\tdecks ${u.decks}\tcreated ${u.createdAt}\tlast login ${u.lastLoginAt ?? '-'}`);
  } else if (command === 'add') {
    if (!USERNAME.test(name ?? '')) throw new Error('A username needs 2–20 letters, digits, _ or -.');
    if (store.userByName(name)) throw new Error(`${name} already exists.`);
    const u = await store.createUser({ username: name, password: await password(), role: opt.admin ? 'admin' : 'user',
      coachEnabled: opt.coach, pvpCoachEnabled: opt['pvp-coach'] });
    console.log(`Created ${u.role} ${u.username} in ${opt.db}.`);
  } else if (command === 'passwd') {
    const u = user();
    await store.setPassword(u.id, await password());
    store.deleteUserSessions(u.id);
    console.log(`Changed the password of ${u.username}; their sessions were signed out.`);
  } else if (command === 'role') {
    const u = user();
    store.setRole(u.id, arg);
    console.log(`${u.username} is now ${arg}.`);
  } else if (command === 'coach' || command === 'pvp-coach') {
    const u = user();
    if (!['on', 'off'].includes(arg)) throw new Error('Coach permission must be on or off.');
    if (command === 'coach') store.setCoachEnabled(u.id, arg === 'on');
    else store.setPvpCoachEnabled(u.id, arg === 'on');
    console.log(`${u.username}: ${command} ${arg}.`);
  } else if (command === 'delete') {
    store.deleteUser(user().id);
    console.log(`Deleted ${name} and their decks.`);
  } else {
    console.log('Usage: npm run user -- add|passwd|role|coach|pvp-coach|delete|list [name] [user|admin|on|off] [--admin] [--coach] [--pvp-coach] [--db file]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
