/**
 * LA FORJA — run-scoped temp root for the SQLite test harness.
 *
 * OWNER: Claude (test infrastructure).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * tests/helpers/testDb.ts used to reap its schema-template directory with a
 * `process.once('exit', ...)` hook. That hook never runs: Vitest tears its
 * workers down with an abrupt terminate, which does not fire `exit` handlers.
 * The per-test databases were fine — `teardown()` deletes those explicitly —
 * but every run left one ~170KB template directory behind in $TMPDIR forever.
 * Measured: 12 -> 13 -> 14 directories over two consecutive runs.
 *
 * A `globalTeardown` is the only hook Vitest guarantees after the workers are
 * gone, so the cleanup lives here instead.
 *
 * ---------------------------------------------------------------------------
 * WHY A RUN-SCOPED ROOT AND NOT A GLOB
 * ---------------------------------------------------------------------------
 * Deleting `$TMPDIR/forja-testdb-*` would also delete the databases of a second
 * run happening at the same time — a watch-mode session, or CI sharding on one
 * machine. Instead this creates ONE directory per run and hands its path to the
 * workers through `FORJA_TESTDB_ROOT`; the harness nests everything inside it,
 * and teardown removes exactly that subtree and nothing else.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function setup(): void {
  // Workers are spawned after globalSetup returns, so they inherit this.
  process.env.FORJA_TESTDB_ROOT = mkdtempSync(join(tmpdir(), 'forja-testdb-run-'));
}

export function teardown(): void {
  const root = process.env.FORJA_TESTDB_ROOT;
  if (root === undefined || root === '') return;
  rmSync(root, { recursive: true, force: true });
}
