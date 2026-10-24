// Match records (server/app.mjs /api/matches) played again on the kernel. A record holds the game's setup
// {releaseId, seed, format, matchMode, decks: [{id, name, cards}]} and its steps in order; the kernel is deterministic,
// so the same setup and the same dispatches give the same game. Used by the table's replay (ui.js ?replay=<id>) and by
// scripts/match.mjs.
//   step {type: 'action', player, revision, action, hash}   a dispatch made on that kernel revision; hash: the state after
//   step {type: 'rewind', revision, reason}                   back to a saved state (undo, or a reload of the page)
//   step {type: 'rejected', player, revision, action, error}  a dispatch the kernel refused (the state did not change)
//   step {type: 'error', message, stack}                      a browser error during the game
//   step {type: 'snapshot', revision, state}                  the full kernel state (at the end of the game)
//   step {type: 'end', result}
import { createReviewedGame } from './rules/engine.js';

// FNV-1a over the state's JSON: the browser and Node build the state with the same code, so equal states give equal text.
// The catalog id is left out: a re-issued release (any kernel change re-pins it) that plays the same keeps every hash.
export function stateHash(snapshot) {
  const text = JSON.stringify({ ...snapshot, catalogId: undefined });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// The dispatches of the game as it stands at the end of the record: every dispatch moves the kernel one revision on,
// so move r is the one made on revision r; a rewind to revision r takes back the moves made from r on. A dispatch on
// an earlier revision without a rewind before it (a lost step) is taken as one; a gap is reported.
export function effectiveMoves(steps) {
  const moves = [], problems = [];
  for (const step of steps) {
    if (step.type === 'rewind') moves.length = Math.min(moves.length, step.revision);
    if (step.type !== 'action') continue;
    if (step.revision < moves.length) {
      problems.push({ seq: step.seq, text: `dispatch on revision ${step.revision} without a rewind (at ${moves.length})` });
      moves.length = step.revision;
    } else if (step.revision > moves.length) {
      problems.push({ seq: step.seq, text: `dispatch on revision ${step.revision}, but the record reaches only ${moves.length}` });
      break;
    }
    moves.push(step);
  }
  return { moves, problems };
}

// The server's steps followed by the ones a saved game still holds unsent ({key, step}, recorder.js), each once.
export function mergeSteps(stored, pending = []) {
  const keys = new Set(stored.map((s) => s.key));
  return [...stored, ...pending.filter((p) => !keys.has(p.key)).map((p, i) => ({ seq: stored.length + i + 1, key: p.key, ...p.step }))];
}

export function newGame({ release, setup }) {
  if (setup.releaseId !== release.releaseId) throw new Error('Recorded release differs from this checkout; use the original build.');
  const expectedApproval = setup.clientApproval ?? setup.approval;
  if (!expectedApproval) throw new Error('Recorded game has no approved subset identity; use the original build or inspect it as a diagnostic record.');
  return createReviewedGame({ release, expectedApproval, decks: setup.decks.map((d) => d.cards), seed: setup.seed,
    format: setup.format, matchMode: setup.matchMode });
}

// Replays the first `until` moves (all by default). Stops at a dispatch the kernel refuses; `diverged` is the first move
// whose state differs from the one the browser recorded (the code changed since, or the record is not this game).
export async function replayMatch({ release, setup, steps, until = Infinity, onStart, onMove }) {
  const { game, catalog, approval, compatibility } = await newGame({ release, setup });
  const { moves, problems } = effectiveMoves(steps);
  onStart?.(game, catalog);
  let played = 0, diverged = null, failed = null;
  for (const move of moves.slice(0, until)) {
    try {
      game.dispatch({ player: move.player, expectedRevision: move.revision, action: move.action });
    } catch (error) {
      failed = { move, error };
      break;
    }
    played++;
    const hash = move.hash ? stateHash(game.snapshot()) : null;
    if (move.hash && hash !== move.hash && !diverged) diverged = move;
    onMove?.(move, game, { hash });
  }
  return { game, catalog, approval, compatibility, moves, played, problems, diverged, failed };
}
