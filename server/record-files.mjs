// Match records and bug reports as files, each kind in a directory of its own (server/main.mjs: --replay-dir or
// $REPLAY_DIR, --bug-report-dir or $BUG_REPORT_DIR), so they can be read, copied and kept without the database.
//   <replay dir>/match-<id>-<started>.json      what GET /api/matches/:id returns, {match, steps}; rewritten after every
//                                                batch of steps (npm run match -- show --file replays it)
//   <bug-report dir>/bug-<at>-match-<id>.json   a report from the table (POST /api/bug-reports): what the player wrote,
//                                                where the game was (the move, the kernel state, the log as shown) and
//                                                the game's whole record as above, {…, match, steps}; once it is dealt
//                                                with, its resolution after the description (npm run match -- resolve)
// <started> is the match's createdAt: a new database writing to the same directory numbers its games from 1 again and
// must not overwrite an older game's file.
import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, ''); // 2026-10-25T14:30:12.345Z → 20261025T143012Z
export const matchFileName = (match) => `match-${match.id}-${stamp(match.createdAt)}.json`;

export function matchFiles({ dir, store }) {
  const writes = new Map(); // match id → its latest write, which the next one waits for
  async function write(id) {
    const match = store.getMatch(id);
    if (!match) return;
    const file = join(dir, matchFileName(match));
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ match, steps: store.matchSteps(id) }));
    await rename(`${file}.tmp`, file); // a reader never sees half a file
  }
  // Writes the match's file from the database as it is now, once a write of it still under way is done.
  function save(id) {
    const next = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => write(id));
    writes.set(id, next);
    const done = () => { if (writes.get(id) === next) writes.delete(id); };
    next.then(done, done);
    return next;
  }
  // Files for the games that have none yet (played before this directory was set); returns how many were written.
  async function backfill() {
    const have = new Set(await readdir(dir).catch(() => []));
    let written = 0;
    for (const m of store.matchStarts()) {
      if (have.has(matchFileName(m))) continue;
      await save(m.id);
      written++;
    }
    return written;
  }
  return { dir, save, backfill };
}

// One field per line, the log one entry per line and the resolution indented, so the top of the file reads as the
// report; the kernel state and the record stay compact.
function reportText(report) {
  const value = (key, v) => key === 'log' && Array.isArray(v) && v.length
    ? `[\n${v.map((line) => `    ${JSON.stringify(line)}`).join(',\n')}\n  ]`
    : key === 'resolution' ? JSON.stringify(v, null, 2).replace(/\n/g, '\n  ') : JSON.stringify(v);
  return `{\n${Object.entries(report).map(([key, v]) => `  ${JSON.stringify(key)}: ${value(key, v)}`).join(',\n')}\n}\n`;
}

export function bugReports({ dir }) {
  return {
    dir,
    // Writes the report as a new file, never over another; returns its id (the file name without .json).
    async save(report) {
      await mkdir(dir, { recursive: true });
      const base = `bug-${stamp(report.createdAt)}-${report.matchId ? `match-${report.matchId}` : 'no-match'}`;
      for (let i = 1; ; i++) {
        const id = i === 1 ? base : `${base}-${i}`;
        try {
          await writeFile(join(dir, `${id}.json`), reportText({ id, ...report }), { flag: 'wx' });
          return id;
        } catch (error) {
          if (error.code !== 'EEXIST' || i >= 100) throw error;
        }
      }
    },
    // Writes what was found and done (repro steps, root cause, fix, commit…) into the report, right after its
    // description; a later resolution replaces it. The rest of the report is kept as it was.
    async resolve(id, resolution) {
      const file = join(dir, `${id}.json`);
      const { resolution: _old, ...report } = JSON.parse(await readFile(file, 'utf8'));
      const fields = Object.entries(report), at = fields.findIndex(([key]) => key === 'description') + 1;
      fields.splice(at, 0, ['resolution', resolution]);
      await writeFile(`${file}.tmp`, reportText(Object.fromEntries(fields)));
      await rename(`${file}.tmp`, file);
    },
  };
}
