# Paused handoff — 2026-10-22 UTC

> **已恢复（2026-10-22）**：Claude 接手后在原样保留的工作树上重跑全部验证并通过、统一文档后提交，结果见 [STATUS §14](STATUS.md)。下文保留暂停时的原始记录。

**Stopped at the user's request. The full-card-pool goal is not complete.**
No further implementation, commit, push, merge, or deployment should be inferred
from this checkpoint. Resume only when requested.

## Workspace and preserved state

- Working tree: `/home/zhn/pokemon-tcg-cn`
- Branch: `feature/cn-full-card-pool`
- The original `/home/zhn/pokemon-tcg` checkout is not the active implementation tree.
- Last committed/pushed baseline: `8d2cca8`
  (`Record cache-free verification of certified CN effects`), following `781efcf`
  (`Certify complete effect texts and expand CN pool to 3272 printings`).
- The second-wave implementation, generated snapshots, tests, and draft
  documentation remain **uncommitted in the working tree**. Preserve them.
- No merge to `main`, no deployment, and no new paid model/API requests.
- Task-owned final validation process trees were stopped. A subsequent process
  check found no remaining Node/npm/Playwright/Vite processes in this worktree.

## Current generated checkpoint

These are generated implementation counts, **not a claim of completed validation
or of completing all 13,706 printings**.

| Item | Current checkpoint |
| --- | ---: |
| Target physical printings | 13,706 |
| Released executable printings | 4,021 |
| Released definitions | 1,890 |
| Hand-reviewed definitions / printings | 78 / 83 |
| Machine-tier definitions / printings | 1,812 / 3,938 |
| Machine printings using reviewed definitions | 835 |
| Machine printings using machine definitions | 3,103 |
| Additional printings / definitions versus committed baseline | 749 / 422 |
| Certified effect units / families | 924 / 50 |
| Explicitly excluded printings | 9,685 |
| Standard-legal / Open-legal released printings | 2,293 / 3,822 |
| Content-addressed shards | 128 |

Machine report:
`catalog/zh-CN/V20261019/library/machine/report.json`.
Exclusion inventory:
`catalog/zh-CN/V20261019/library/machine/exclusions.json`.
Pipeline: `certified-effect-programs-strict-reprints-v4`.

```text
active release: cn-v20261019-mixed-pool-v2
manifest pin:   9f1b1abbbd7fbe2763d68554efd0f65b402b1303270b5314323066231a7984af
protocol:       CN-game-dev-25
schemaSha256:   fe47132d64d94f4856227f4e1449e551cda37f77766b361be35074c53730e782
kernelSha256:   37ce14c5ef75b0ceefead24267154c2e6259174c8629062500c0d9c39289153c
```

The core runtime/schema was not changed in this wave. Current manifest size is
48,847 B; index 3,955,249 B (122,340 B with Brotli quality 5); all shards total
8,149,341 B, largest 466,132 B. Existing wire-size budgets remain unchanged.

## Work completed in the uncommitted second wave

1. **Reviewed-program reuse with provenance.**
   Added `scripts/reviewed-effect-certificates.mjs`; refactored
   `scripts/effect-gold.mjs` into an importable pure builder without changing its
   legacy generated output. Programs retain source printing, definition hash,
   and test provenance. Reuse requires exact full text and appropriate category;
   it does not inherit whole-card review status, identity, limits, or legality.
   Unsupported binding contracts are rejected rather than partially exported.

2. **Independent complete-text mechanism certification.**
   Added `scripts/effect-mechanism-certificates.mjs` for checked energy
   discard/return/move, energy-unit versus physical-card counts, counted damage
   formulas, extra damage packets, counters, draw-until, Stadium discard, and
   supported activated/triggered Ability envelopes. Both model outputs must agree
   with the independent expected native program. Extra clauses and incorrect
   timing, quantities, types, sides, optionality, and shared coin scope reject.

3. **Safe references, evidence, and fingerprints.**
   Updated effect certification, validation, and machine builders to resolve
   own-definition, unique named-attack, and narrowly scoped reviewed-policy
   references. Bloodmoon's named attack is not assumed to be attack slot one.
   Official policy evidence remains distinct from machine-printing identity.
   Fixed fingerprint normalization so counted-result references retain which
   effect they read; semantic references no longer disappear with envelope IDs.

4. **Checked rule boxes and Tera behavior.**
   Added complete-text Tera rule recognition and actual Bench-only protection
   against attack damage, not effects/counters or Active damage.
   Rule-text cleanup preserves potentially meaningful symbols instead of
   erasing unreadable boxes into valid text. Added five narrowly scoped,
   image/hash-backed V/ex rule-text corrections after inspecting full cards and
   enlarged rule boxes; these are not whole-card manual promotions.

5. **Auditable generation and ancestry fix.**
   Added per-printing exclusions, target-count conservation, provenance
   revalidation, definition-ID collision rejection, and accepted-ancestry input
   hashing. Added `scripts/machine-ancestry.mjs`: evolution parents require
   image-backed accepted name/stage/parent fields, never unchecked raw metadata.
   This fixed a false Greninja ex exclusion caused by an unchecked parent-name
   suffix. The latest build adds that one printing/definition to the previously
   fully tested 4,020-printing checkpoint.

6. **Tests and release artifacts.**
   Added reviewed-certificate, mechanism-certificate, and ancestry unit suites.
   Expanded real released-card tests for counted costs, formulas, damage
   packets, trigger acceptance/decline, named references, Tera protection, and
   Greninja ex evolution through Rare Candy. Updated machine release inventory
   checks, library expectations, package test wiring, generated catalogs,
   release index/shards, and trusted pin.

## Validation: what passed versus what remains unverified

### Completed successfully before the final ancestry change

For the **4,020-printing / 1,889-definition** checkpoint:

- `npm test`: **1,651 passed**, no skips or cancellations.
- Playwright: **12/12 passed**.
- Official-rule coverage: **100% lines/functions, 98.97% branches**.
- Focused machine effect/release tests: **25/25 passed**.
- All original 3,272 released printings retained their exact subset catalog
  identity. All three original preset saves restored under the new manifest
  with identical catalog/snapshot and explicit `manifestChanged=true`.
- All prior 1,390 machine definitions and 3,189 machine printings compared
  canonically unchanged against HEAD.
- Eight official source hashes, merged-data freshness, byte-identical rebuild
  of the 5,762-unit corpus, and v2 preview write/check with three decks passed.

Logs retained locally:
`/tmp/pokemon-programs-final-npm.log`,
`/tmp/pokemon-programs-final-ui.log`,
`/tmp/pokemon-programs-final-coverage.log`,
`/tmp/pokemon-programs-runtime.log`.

### Completed after the final ancestry change

- `npm run test:effect-corpus`: **35/35 passed**, including four ancestry tests.
- Regenerated the **4,021-printing / 1,890-definition** release and merged view
  (88 entries, zero stale), and refreshed the local card-library index.
- Targeted released Greninja ex/Rare Candy test passed: actual released
  Froakie/Greninja identities, legal fixture admission, skip-Stage-1 evolution,
  stack/identity assertions, and exact save/restore.

### Final exact-worktree validation was stopped; not a clean pass

The final second run was in progress when the user requested a stop:

- `/tmp/pokemon-programs-final2-npm.log`: partial official-rule run reports
  **1,454 passed, 0 failed, 2 cancelled**; the cancelled files are
  `effect-execution.test.mjs` and `no-change-healing-runtime.test.mjs`, with
  “Promise resolution is still pending but the event loop has already resolved”.
  The full chained test command did not complete successfully.
- `/tmp/pokemon-programs-final2-ui.log`: only the setup test is recorded as
  passed; no final browser-suite result.
- `/tmp/pokemon-programs-final2-coverage.log`: incomplete, with an unsuccessful
  `triggers.test.mjs` file entry and no final coverage report.

These interruption-era errors have **not been diagnosed**. Do not automatically
attribute them to cancellation, and do not report this run as passing.
No test suite was restarted after the stop request.

There has been **no fresh-clone validation of this uncommitted second wave**.
The earlier fresh-clone success documented in STATUS §13 applies only to the
committed 3,272-printing baseline.

## Documentation caveat

README, RELEASE, RELEASE-V2-PROPOSAL, and EFFECT-TRANSLATION-GAPS contain
partially updated second-wave drafts with the earlier 4,020 / 1,889 / 9,686
counts. They were not reconciled after the final ancestry fix. This handoff and
the generated report distinguish the latest checkpoint from passed validation.
STATUS §13 remains a historical record of the committed first wave.

## If the user requests resumption

1. Inspect the preserved worktree and this handoff first. Diagnose/rerun the
   interrupted exact-worktree tests, browser checks, and coverage; do not assume
   their prior checkpoint results certify the latest code.
2. Recheck prior-record/catalog-ID/save compatibility, official hashes, merged
   freshness, corpus/preview reproducibility, and whitespace for the final build.
3. Reconcile draft documentation and STATUS, then commit/push only the feature
   branch after validation. Perform clean-clone checks for that committed wave.
   Do not merge `main` or deploy.
4. Continue the remaining 9,685 excluded printings with explicit complete-text
   certification and actual semantic/replay tests. Prioritize verified shared
   builder/reference gaps versus genuinely missing kernel mechanisms; preserve
   strict evidence tiers and full rule-box gates.
5. Keep old model caches; do not unnecessarily retranslate or spend API credits.
   Before large further growth, deduplicate index facts by definition instead of
   increasing wire budgets. Shared composition must not eagerly evaluate
   state-dependent effects before earlier effects change state.

This checkpoint intentionally leaves unfinished work unfinished.
