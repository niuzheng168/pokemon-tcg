// Recorded games from the table (server/app.mjs /api/matches), replayed on the kernel to reproduce a reported problem.
//   npm run match -- list [--user <name>] [--limit 20]
//   npm run match -- show <id> [--at <n>] [--raw] [--out state.json]
//       replays the game move by move (the move, then what the log showed for it); --at n stops after move n and
//       prints the whole board, both hands, flags, the pending choice and each player's legal moves, and the table's
//       choice window for player 0 (title, cards shown, options); --raw also prints the kernel events; --out writes
//       the kernel snapshot there (OfficialGame.restore it in a regression test)
//   npm run match -- export <id> --out record.json      the record as GET /api/matches/:id returns it
//   npm run match -- reports [--limit 20]               the bug reports from the table, newest first
//   npm run match -- resolve --file <bug report> --notes notes.json [--commit <rev>]
//       writes the report's resolution: the notes ({repro, rootCause, fix, tests, verify}) with the fix commit's hash
//       and title (git, default HEAD); show --file and reports print it
// --db <file> (or $DB_PATH) picks the database, as for the server; --file <file> reads a record instead: an export, a
// file of the replay directory ($REPLAY_DIR) or a bug report ($BUG_REPORT_DIR, --dir for another directory), which
// `show --file` prints first and replays up to the move reported unless --at says otherwise.
// Moves are numbered from 1 in the game as it stands at the end (undone moves are dropped, replay.js effectiveMoves);
// administrators' 调试台 edits are moves too, shown with their command;
// each is checked against the state hash the browser recorded, so a replay that no longer matches says so.
import { parseArgs } from 'node:util';
import { join, dirname, basename } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { openStore } from '../server/store.mjs';
import { bugReports } from '../server/record-files.mjs';
import { ROOT, loadRelease } from '../server/catalog.mjs';
import { CN_RELEASE_ID } from '../public/cn/trusted-releases.js';
import { replayMatch, effectiveMoves } from '../public/replay.js';
import { Match } from '../public/match.js';

const { values: opt, positionals: [command, idArg] } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string', default: process.env.DB_PATH || join(ROOT, '.data', 'accounts.db') },
  file: { type: 'string' },
  dir: { type: 'string', default: process.env.BUG_REPORT_DIR || join(ROOT, '.data', 'bug-reports') },
  user: { type: 'string' },
  limit: { type: 'string', default: '20' },
  at: { type: 'string' },
  raw: { type: 'boolean', default: false },
  out: { type: 'string' },
  notes: { type: 'string' },
  commit: { type: 'string', default: 'HEAD' },
} });

const release = await loadRelease();
const presentation = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8')).cards;

async function loadRecord(id) {
  if (opt.file) return JSON.parse(await readFile(opt.file, 'utf8'));
  const store = openStore(opt.db);
  try {
    const match = store.getMatch(Number(id));
    if (!match) throw new Error(`No match #${id} in ${opt.db}.`);
    return { match, steps: store.matchSteps(match.id) };
  } finally {
    store.close();
  }
}

// Names for the ids in a command or a choice: cards (p0c12) by their printing, Pokémon in play (m3) by their top card.
function namer(game, catalog) {
  const s = game.snapshot(), name = (id) => catalog.definition(s.cards[id].definitionId).name;
  const mons = new Map(s.players.flatMap((p, owner) => [p.active, ...p.bench].filter(Boolean)
    .map((m, i) => [m.id, `${name(m.stack.at(-1))}·P${owner}${i ? `备战${i}` : '战斗'}`])));
  return (value) => JSON.stringify(value).replace(/"(p\dc\d+|m\d+)"/g, (all, id) =>
    s.cards[id] ? `${id}«${name(id)}»` : mons.has(id) ? `${id}«${mons.get(id)}»` : all);
}

function board(game, catalog) {
  const s = game.snapshot(), name = (id) => catalog.definition(s.cards[id].definitionId).name;
  const names = (ids) => ids.map((id) => `${id}«${name(id)}»`).join(' ') || '—';
  const conditions = (m) => Object.entries(m.conditions ?? {}).filter(([, v]) => v != null && v !== false);
  const mon = (m) => m ? `${m.id} ${name(m.stack.at(-1))} 伤害${m.counters * 10} 能量[${m.energy.map(name).join('、')}]` +
    `${m.tools.length ? ` 道具[${m.tools.map(name).join('、')}]` : ''}` +
    `${conditions(m).length ? ` 状态${JSON.stringify(Object.fromEntries(conditions(m)))}` : ''}` : '—';
  const out = [`turn ${s.turn}, current P${s.current}, first P${s.first}, phase ${s.phase}, revision ${s.revision}` +
    `${s.stadium ? `, stadium ${s.stadium}«${name(s.stadium)}»` : ''}${s.result ? `, result ${JSON.stringify(s.result)}` : ''}`];
  s.players.forEach((p, i) => {
    out.push(`P${i}: deck ${p.deck.length}, prizes ${p.prizes.length}, turns ${p.turns}, flags ${JSON.stringify(p.flags)}`,
      `  active ${mon(p.active)}`, ...p.bench.map((m, j) => `  bench${j + 1} ${mon(m)}`),
      `  hand ${names(p.hand)}`, `  discard ${names(p.discard)}`);
  });
  const describe = namer(game, catalog);
  if (s.pending) out.push(`pending P${s.pending.player} ${s.pending.kind} options ${describe(s.pending.options)}`);
  for (const player of [0, 1]) {
    const legal = game.view(player).legalActions;
    if (legal.length) out.push(`legal P${player}:`, ...legal.map((a) => `  ${describe(a)}`));
  }
  if (s.playerOngoing.length) out.push(`player effects ${JSON.stringify(s.playerOngoing)}`);
  return out.join('\n');
}

async function showMatch(id) {
  const record = await loadRecord(id);
  const { match, steps } = record;
  if (record.description !== undefined) { // a bug report (server/record-files.mjs)
    console.log(`问题报告 ${record.id}  ${record.user?.username}  ${record.createdAt}  ${record.replay ? '回放中' : '对局中'} 第 ${record.move} 步` +
      `  turn ${record.turn}\n${record.description}\npage ${record.page ?? '—'}` +
      `${record.matchId ? `\n回放到这一步（可从这里接管）：/play/?replay=${record.matchId}&at=${record.move ?? 0}` : ''}`);
    const r = record.resolution;
    if (r) console.log(`已处理 ${r.resolvedAt}  ${r.status}  ${r.commit.slice(0, 7)} ${r.title}\n原因：${r.rootCause}` +
      `${r.verify ? `\n验证：${r.verify}` : ''}`);
    if (!match) return;
    opt.at ??= record.move === null ? undefined : String(record.move);
  }
  const setup = match.setup, counts = {};
  for (const s of steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
  console.log(`对局 #${match.id}  ${match.username}  ${match.createdAt}  ${match.status}  turn ${match.turn}  result ${JSON.stringify(match.result)}`);
  console.log(`build ${JSON.stringify(match.build)}  browser ${match.userAgent}`);
  console.log(`release ${setup.releaseId}${setup.releaseId === CN_RELEASE_ID ? '' : ` (this checkout: ${CN_RELEASE_ID})`}  seed ${JSON.stringify(setup.seed)}` +
    `  format ${setup.format.id}  ${setup.matchMode}${setup.takeover ? `  taken over from #${setup.takeover.match} at move ${setup.takeover.move}` : ''}`);
  setup.decks.forEach((d, i) => console.log(`P${i} ${d.name} (${d.id})`));
  console.log(`steps ${steps.length} ${JSON.stringify(counts)}`);
  for (const s of steps.filter((x) => ['rewind', 'rejected', 'error', 'edit'].includes(x.type))) {
    const { seq, type, key: _k, at: _a, state: _s, lines: _l, hash: _h, ...rest } = s;
    console.log(`  seq ${seq} ${type} ${JSON.stringify(rest)}`);
  }
  const { problems } = effectiveMoves(steps);
  for (const p of problems) console.log(`  ⚠ seq ${p.seq}: ${p.text}`);
  console.log('---');

  const until = opt.at === undefined ? Infinity : Number(opt.at);
  let table = null, seen = 0, before = null;
  const report = await replayMatch({ release, setup, steps, until,
    onMove: (move, game, { hash }) => {
      console.log(`#${move.revision + 1} [seq ${move.seq}] ${move.type === 'edit' ? `调试台 ${move.command}` : `P${move.player} ${before(move.action)}`}` +
        `${hash !== move.hash ? `  ⚠ state ${hash} ≠ recorded ${move.hash}` : ''}`);
      if (move.type === 'edit') {
        for (const line of move.lines ?? []) console.log(`    ${line}`);
        // An edit may have turned a card into another: name every card afresh.
        table.known.clear(); table.cards.clear();
        for (const c of Object.values(game.snapshot().cards)) table.remember(c);
      }
      table.index(game.view(0));
      table.index(game.view(1));
      const events = game.snapshot().events;
      for (const e of events.slice(seen)) {
        const text = table.eventLine(e);
        if (text) console.log(`    ${text}`);
        if (opt.raw) console.log(`      · ${e.ruleId} ${e.visibility} ${JSON.stringify(e.data)}`);
      }
      seen = events.length;
      before = namer(game, table.catalog);
    },
    onStart: (game, catalog) => {
      // Every card is named in this log, including the ones its player never showed.
      table = new Match({ game, catalog, presentation, decks: setup.decks.map((d) => d.id), controllers: [], hooks: {} });
      for (const c of Object.values(game.snapshot().cards)) table.remember(c);
      table.index(game.view(1));
      const events = game.snapshot().events;
      for (const e of events) { const text = table.eventLine(e); if (text) console.log(`    ${text}`); }
      seen = events.length;
      before = namer(game, catalog);
    } });
  const { game, catalog, played, moves, diverged, failed } = report;
  console.log('---');
  console.log(`replayed ${played} of ${moves.length} moves${diverged ? `; ⚠ first differs from the record at #${diverged.revision + 1} (seq ${diverged.seq})` : '; every recorded state matches'}`);
  if (failed) console.log(`⚠ #${failed.move.revision + 1} (seq ${failed.move.seq}) refused: ${failed.error.message}`);
  if (opt.at !== undefined || failed) console.log(board(game, catalog));
  // The choice window the table opens for player 0 there, from what the player has seen: for a problem in the window
  // rather than in the rules.
  if ((opt.at !== undefined || failed) && game.view(0).pending) {
    const seen = new Match({ game, catalog, presentation, decks: setup.decks.map((d) => d.id), controllers: [], hooks: {} });
    const p = seen.prompt(game.view(0)), name = (o) => o.label ?? o.mon?.card.name ?? o.card?.name ?? (o.back ? '（反面）' : o.id);
    const shown = p.lookedAt.map((c) => `${c.name}${p.placing.includes(c.uid) ? '［当前］' : ''}${p.placed.has(c.uid) ? ` → ${p.placed.get(c.uid)}` : ''}`);
    console.log(`牌桌选择框：${p.title}${p.source ? `（来自「${p.source.name}」）` : ''}\n` +
      `${shown.length ? `  显示的卡（${shown.length}）：${shown.join('，')}\n` : ''}  选项：${p.options.map(name).join('，')}`);
  }
  if (opt.out) {
    await writeFile(opt.out, JSON.stringify(game.snapshot()) + '\n');
    console.log(`snapshot (revision ${game.snapshot().revision}) → ${opt.out}`);
  }
}

if (command === 'list') {
  const store = openStore(opt.db);
  const user = opt.user ? store.userByName(opt.user) : null;
  if (opt.user && !user) throw new Error(`No user named ${opt.user}.`);
  for (const m of store.listMatches(user?.id ?? null, Number(opt.limit)))
    console.log(`#${m.id}\t${m.createdAt}\t${m.username}\t${m.setup.decks[0].name} vs ${m.setup.decks[1].name}\t${m.status}\tturn ${m.turn}` +
      `\tsteps ${m.steps}${m.result ? `\twinner ${m.result.winner ?? 'draw'} (${m.result.reason})` : ''}`);
  store.close();
} else if (command === 'show' && (idArg || opt.file)) {
  await showMatch(idArg);
} else if (command === 'export' && idArg && opt.out) {
  await writeFile(opt.out, JSON.stringify(await loadRecord(idArg)) + '\n');
  console.log(`match #${idArg} → ${opt.out}`);
} else if (command === 'reports') {
  const files = (await readdir(opt.dir).catch(() => [])).filter((f) => f.startsWith('bug-') && f.endsWith('.json')).sort().reverse();
  for (const f of files.slice(0, Number(opt.limit))) {
    const r = JSON.parse(await readFile(join(opt.dir, f), 'utf8'));
    console.log(`${join(opt.dir, f)}\n  ${r.createdAt}  ${r.user?.username}  ${r.matchId ? `#${r.matchId}` : '无对局记录'}` +
      `${r.move === null ? '' : ` 第 ${r.move} 步`}${r.replay ? '（回放中）' : ''}` +
      `${r.resolution ? `  [${r.resolution.status} ${r.resolution.commit.slice(0, 7)}]` : ''}  ${r.description.split('\n')[0].slice(0, 100)}`);
  }
  if (!files.length) console.log(`No bug reports in ${opt.dir}.`);
} else if (command === 'resolve' && opt.file && opt.notes) {
  const notes = JSON.parse(await readFile(opt.notes, 'utf8'));
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const resolution = { status: 'fixed', resolvedAt: new Date().toISOString(),
    commit: git('rev-parse', '--verify', `${opt.commit}^{commit}`), title: git('log', '-1', '--format=%s', opt.commit), ...notes };
  const id = basename(opt.file, '.json');
  await bugReports({ dir: dirname(opt.file) }).resolve(id, resolution);
  console.log(`${id}: ${resolution.status} ${resolution.commit.slice(0, 7)} ${resolution.title}`);
} else {
  console.log('Usage: npm run match -- list [--user <name>] | show <id> [--at <n>] [--raw] [--out state.json] | export <id> --out <file>' +
    ' | reports [--dir <dir>] | resolve --file <bug report> --notes <notes.json> [--commit <rev>]' +
    '  [--db <file> | --file <record or bug report>]');
  process.exitCode = 1;
}
