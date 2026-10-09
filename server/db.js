// ARTHA FLOW: the database layer.
//
// Plain exported functions, no class. One shared connection per process.
// JSON columns are parsed on the way out and stringified on the way in, so a
// caller only ever sees real objects. Column names are snake_case in sqlite
// and camelCase in JavaScript. The mapping happens here and nowhere else.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths come from import.meta.url, never from process.cwd(), so the CLI can be
// run from any folder.
// AFLOW_DB_PATH points the whole server at another database file. It is off by
// default, so normal use is unchanged. It exists so a test run can have its own
// file and never touch the real one, which matters on a machine where more than
// one agent is poking the same server.
export const DEFAULT_DB_PATH = process.env.AFLOW_DB_PATH
  ? fileURLToPath(new URL(process.env.AFLOW_DB_PATH, 'file://' + process.cwd() + '/'))
  : fileURLToPath(new URL('../data/flow.db', import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  input TEXT,
  cursor TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  name TEXT,
  iteration INTEGER,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  step_id INTEGER REFERENCES steps(id),
  node_id TEXT NOT NULL,
  system TEXT,
  prompt TEXT NOT NULL,
  expect TEXT NOT NULL DEFAULT 'text',
  schema_hint TEXT,
  answer TEXT,
  status TEXT NOT NULL,
  claimed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);

CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_prompts_status ON prompts(status);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_prompts_run ON prompts(run_id);

-- FORGE: cross-run state, per FORGE.md section 1. Three tables, same file,
-- no new store. See the FORGE block near the bottom of this file for the
-- functions that read and write these, every one of them wrapped in a single
-- BEGIN IMMEDIATE transaction, per FORGE.md section 6.

CREATE TABLE IF NOT EXISTS forge_claims (
  piece_id     TEXT NOT NULL,
  section      TEXT NOT NULL,
  agent        TEXT NOT NULL,
  status       TEXT NOT NULL,        -- open | claimed | drafted | settled
  claimed_at   TEXT,
  drafted_at   TEXT,
  settled_at   TEXT,
  attempt      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (piece_id, section)
);

CREATE TABLE IF NOT EXISTS forge_revision_rounds (
  piece_id     TEXT PRIMARY KEY,
  round_count  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ok',   -- ok | at_cap | over_cap
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS forge_concept_restarts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id     TEXT NOT NULL,
  status       TEXT NOT NULL,        -- active | queued | done
  started_at   TEXT,
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_forge_claims_piece ON forge_claims(piece_id);
CREATE INDEX IF NOT EXISTS idx_forge_restarts_status ON forge_concept_restarts(status);
CREATE INDEX IF NOT EXISTS idx_forge_restarts_piece ON forge_concept_restarts(piece_id);
`;

let db = null;
let dbPath = null;

/**
 * Open (or reopen) the database and make sure the schema is there.
 * Safe to call many times. Returns the raw DatabaseSync handle.
 */
export function openDb(filePath = DEFAULT_DB_PATH) {
  if (db && dbPath === filePath) return db;
  if (db) {
    try { db.close(); } catch { /* already closed, nothing to do */ }
    db = null;
  }
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  db = new DatabaseSync(filePath);
  // busy_timeout goes first. Setting the journal mode needs a moment of
  // exclusive access, so two processes opening the same file at the same
  // instant will collide, and without this one of them dies on the spot with
  // "database is locked". Found the hard way while racing two servers.
  db.exec('PRAGMA busy_timeout = 5000;');
  // WAL lets one writer and many readers work at the same time.
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  dbPath = filePath;
  return db;
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------
//
// Everything in here is additive and safe to run on a database that already
// holds real runs. We never drop, rename, or rewrite a column. A column that
// is already there is left alone, so an old flow.db keeps working and a new
// one gets the same shape.

/** Add a column if the table does not have it yet. Returns true if it was added. */
function ensureColumn(handle, table, column, ddl) {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => String(c.name) === column)) return false;
  handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

function migrate(handle) {
  // Added for the wait node: when a parked run should wake up again.
  ensureColumn(handle, 'runs', 'wake_at', 'TEXT');
  // Added for the run lock: which process is driving this run, and until when.
  ensureColumn(handle, 'runs', 'locked_by', 'TEXT');
  ensureColumn(handle, 'runs', 'lock_until', 'TEXT');
  // Added 2026-09-17, "make the agents visible": who answered a prompt, so a
  // run can show that a real agent (or a person) sat behind every step, not
  // an unnamed process. Set on the prompt when it is answered, and copied
  // onto the step it belongs to, so a step never needs a join to show it.
  ensureColumn(handle, 'prompts', 'actor', 'TEXT');
  ensureColumn(handle, 'steps', 'actor', 'TEXT');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_runs_wake ON runs(wake_at);');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at);');
}

/** Get the open handle, opening the default file if nobody opened one yet. */
export function getDb() {
  return db || openDb();
}

/** Close the connection. Mainly for tests and clean shutdown. */
export function closeDb() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
  dbPath = null;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function fromJson(text, fallback = null) {
  if (text === undefined || text === null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    // A broken JSON column should not take the whole server down. Hand back
    // the raw text so a human can see what went wrong.
    return { __unparsed: String(text) };
  }
}

function num(value) {
  // node:sqlite can hand back a BigInt for row ids. Runs and steps never get
  // near the safe integer limit, so a plain number is fine and much easier.
  return value === null || value === undefined ? null : Number(value);
}

function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// row mappers
// ---------------------------------------------------------------------------

function mapWorkflow(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    definition: fromJson(row.definition, {}),
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    workflowId: num(row.workflow_id),
    slug: row.slug,
    status: row.status,
    trigger: row.trigger,
    input: fromJson(row.input, {}),
    cursor: fromJson(row.cursor, null),
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    wakeAt: row.wake_at ?? null,
    lockedBy: row.locked_by ?? null,
    lockUntil: row.lock_until ?? null
  };
}

function mapStep(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    runId: num(row.run_id),
    nodeId: row.node_id,
    nodeType: row.node_type,
    name: row.name,
    iteration: row.iteration === null || row.iteration === undefined ? null : num(row.iteration),
    status: row.status,
    input: fromJson(row.input, null),
    output: fromJson(row.output, null),
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    actor: row.actor ?? null
  };
}

function mapPrompt(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    runId: num(row.run_id),
    stepId: row.step_id === null || row.step_id === undefined ? null : num(row.step_id),
    nodeId: row.node_id,
    system: row.system,
    prompt: row.prompt,
    expect: row.expect,
    schemaHint: row.schema_hint,
    answer: row.answer,
    status: row.status,
    claimedAt: row.claimed_at,
    retryCount: num(row.retry_count),
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    actor: row.actor ?? null
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    runId: row.run_id === null || row.run_id === undefined ? null : num(row.run_id),
    ts: row.ts,
    level: row.level,
    message: row.message,
    data: fromJson(row.data, null)
  };
}

// Build a SET clause from a camelCase patch object using an allow list, so a
// caller can never write a column we did not mean to expose.
function buildPatch(patch, allowed) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (column.json) value = toJson(value);
    if (column.bool) value = value ? 1 : 0;
    sets.push(`${column.name} = ?`);
    params.push(value === undefined ? null : value);
  }
  return { sets, params };
}

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

/**
 * Insert or update a workflow by slug. `definition` is the full workflow JSON.
 */
export function upsertWorkflow({ slug, name, description = null, definition, enabled = true }) {
  if (!slug) throw new Error('upsertWorkflow needs a slug');
  if (!definition) throw new Error(`upsertWorkflow needs a definition for "${slug}"`);
  const ts = nowIso();
  const existing = get('SELECT * FROM workflows WHERE slug = ?', [slug]);
  if (existing) {
    run(
      `UPDATE workflows SET name = ?, description = ?, definition = ?, enabled = ?, updated_at = ?
       WHERE slug = ?`,
      [name ?? existing.name, description, toJson(definition), enabled ? 1 : 0, ts, slug]
    );
  } else {
    run(
      `INSERT INTO workflows (slug, name, description, definition, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [slug, name ?? slug, description, toJson(definition), enabled ? 1 : 0, ts, ts]
    );
  }
  return getWorkflowBySlug(slug);
}

export function listWorkflows() {
  return all('SELECT * FROM workflows ORDER BY name ASC').map(mapWorkflow);
}

export function getWorkflowBySlug(slug) {
  return mapWorkflow(get('SELECT * FROM workflows WHERE slug = ?', [slug]));
}

export function getWorkflowById(id) {
  return mapWorkflow(get('SELECT * FROM workflows WHERE id = ?', [id]));
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export function createRun({ workflowId, slug, status = 'queued', trigger = 'api', input = {}, cursor = null }) {
  const ts = nowIso();
  const res = run(
    `INSERT INTO runs (workflow_id, slug, status, trigger, input, cursor, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workflowId, slug, status, trigger, toJson(input), toJson(cursor), ts]
  );
  return getRun(num(res.lastInsertRowid));
}

export function getRun(id) {
  return mapRun(get('SELECT * FROM runs WHERE id = ?', [id]));
}

export function listRuns({ status = null, slug = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (slug) { where.push('slug = ?'); params.push(slug); }
  const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(Number(limit) || 50, 500)));
  return all(sql, params).map(mapRun);
}

const RUN_FIELDS = {
  status: { name: 'status' },
  trigger: { name: 'trigger' },
  input: { name: 'input', json: true },
  cursor: { name: 'cursor', json: true },
  error: { name: 'error' },
  startedAt: { name: 'started_at' },
  endedAt: { name: 'ended_at' },
  wakeAt: { name: 'wake_at' },
  lockedBy: { name: 'locked_by' },
  lockUntil: { name: 'lock_until' }
};

/** Patch a run. Only the fields in the patch object are touched. */
export function updateRun(id, patch = {}) {
  const { sets, params } = buildPatch(patch, RUN_FIELDS);
  if (!sets.length) return getRun(id);
  params.push(id);
  run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, params);
  return getRun(id);
}

export function countRunsByStatus(status) {
  const row = get('SELECT COUNT(*) AS n FROM runs WHERE status = ?', [status]);
  return num(row.n);
}

/** Newest run for a workflow slug, or null. Used by the workflow list view. */
export function lastRunForSlug(slug) {
  return mapRun(get('SELECT * FROM runs WHERE slug = ? ORDER BY id DESC LIMIT 1', [slug]));
}

/**
 * Runs parked on a wait node whose wake time has passed.
 *
 * This is the whole reason wake_at is a column and not a setTimeout. Kill the
 * server halfway through a three day wait, start it again, and this query
 * still finds the run.
 */
export function dueTimerRuns(asOf = nowIso(), limit = 50) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500));
  return all(
    `SELECT * FROM runs
     WHERE status = 'waiting_on_timer' AND wake_at IS NOT NULL AND wake_at <= ?
     ORDER BY wake_at ASC LIMIT ?`,
    [asOf, capped]
  ).map(mapRun);
}

// ---------------------------------------------------------------------------
// run locks
// ---------------------------------------------------------------------------
//
// An in memory Map only guards one process. Two servers pointed at the same
// flow.db could both resume the same parked run and double every step after
// it. The lock lives in the database instead, so the guard holds across
// processes. It is one conditional UPDATE, which sqlite makes atomic, so the
// loser sees changes = 0 and walks away.
//
// Every lock has an expiry. A process that dies holding one does not block the
// run for ever, it just blocks it until lock_until passes.

export const DEFAULT_LOCK_MS = 5 * 60 * 1000;

/**
 * Try to take the lock on a run. Returns true if we got it.
 * The same owner asking again renews its own lock instead of failing.
 */
export function acquireRunLock(runId, owner, ttlMs = DEFAULT_LOCK_MS) {
  const now = nowIso();
  const until = new Date(Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_LOCK_MS)).toISOString();
  const res = run(
    `UPDATE runs SET locked_by = ?, lock_until = ?
     WHERE id = ? AND (locked_by IS NULL OR lock_until IS NULL OR lock_until <= ? OR locked_by = ?)`,
    [String(owner), until, runId, now, String(owner)]
  );
  return Number(res.changes) === 1;
}

/** Push the expiry out while we are still working. Returns true if we still hold it. */
export function renewRunLock(runId, owner, ttlMs = DEFAULT_LOCK_MS) {
  const until = new Date(Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_LOCK_MS)).toISOString();
  const res = run(
    'UPDATE runs SET lock_until = ? WHERE id = ? AND locked_by = ?',
    [until, runId, String(owner)]
  );
  return Number(res.changes) === 1;
}

/** Give the lock back. Only the holder can, so a late release cannot steal it. */
export function releaseRunLock(runId, owner) {
  const res = run(
    'UPDATE runs SET locked_by = NULL, lock_until = NULL WHERE id = ? AND locked_by = ?',
    [runId, String(owner)]
  );
  return Number(res.changes) === 1;
}

/** Who holds the lock right now, or null if nobody does. */
export function getRunLock(runId) {
  const row = get('SELECT locked_by, lock_until FROM runs WHERE id = ?', [runId]);
  if (!row || !row.locked_by) return null;
  if (row.lock_until && row.lock_until <= nowIso()) return null;
  return { lockedBy: row.locked_by, lockUntil: row.lock_until };
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

export function createStep({ runId, nodeId, nodeType, name = null, iteration = null, status = 'running', input = null, startedAt = null }) {
  const res = run(
    `INSERT INTO steps (run_id, node_id, node_type, name, iteration, status, input, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, nodeId, nodeType, name, iteration, status, toJson(input), startedAt ?? nowIso()]
  );
  return getStep(num(res.lastInsertRowid));
}

export function getStep(id) {
  return mapStep(get('SELECT * FROM steps WHERE id = ?', [id]));
}

const STEP_FIELDS = {
  status: { name: 'status' },
  name: { name: 'name' },
  iteration: { name: 'iteration' },
  input: { name: 'input', json: true },
  output: { name: 'output', json: true },
  error: { name: 'error' },
  startedAt: { name: 'started_at' },
  endedAt: { name: 'ended_at' },
  actor: { name: 'actor' }
};

export function updateStep(id, patch = {}) {
  const { sets, params } = buildPatch(patch, STEP_FIELDS);
  if (!sets.length) return getStep(id);
  params.push(id);
  run(`UPDATE steps SET ${sets.join(', ')} WHERE id = ?`, params);
  return getStep(id);
}

export function listSteps(runId) {
  return all('SELECT * FROM steps WHERE run_id = ? ORDER BY id ASC', [runId]).map(mapStep);
}

// ---------------------------------------------------------------------------
// prompts, the Claude bridge queue
// ---------------------------------------------------------------------------

export function createPrompt({ runId, stepId = null, nodeId, system = null, prompt, expect = 'text', schemaHint = null }) {
  if (!prompt) throw new Error(`createPrompt needs prompt text (node ${nodeId})`);
  const res = run(
    `INSERT INTO prompts (run_id, step_id, node_id, system, prompt, expect, schema_hint, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
    [runId, stepId, nodeId, system, prompt, expect, schemaHint, nowIso()]
  );
  return getPrompt(num(res.lastInsertRowid));
}

export function getPrompt(id) {
  return mapPrompt(get('SELECT * FROM prompts WHERE id = ?', [id]));
}

/**
 * The oldest prompt still waiting, or null. Stale claims are released first,
 * so a prompt that somebody claimed and then dropped comes back by itself.
 */
export function nextWaitingPrompt() {
  releaseStaleClaims();
  return mapPrompt(get("SELECT * FROM prompts WHERE status = 'waiting' ORDER BY id ASC LIMIT 1"));
}

/**
 * Mark a prompt claimed so two callers never work the same one.
 * Returns the prompt, or null if somebody else got there first.
 */
export function claimPrompt(id) {
  const res = run(
    "UPDATE prompts SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'waiting'",
    [nowIso(), id]
  );
  if (Number(res.changes) === 0) return null;
  return getPrompt(id);
}

// Who answers a prompt when nobody names one. Written into every prompt so a
// run never shows a blank "who did this", even for the oldest rows.
export const DEFAULT_ACTOR = 'claude:session';

/**
 * Store the answer and mark the prompt answered. Null if it was not open.
 * `actor` names who or what answered it, for example "claude:session" (the
 * default, set by the CLI and the API when nothing is given) or a specific
 * agent name from `aflow answer <id> --actor <name>`. Also copied onto the
 * step this prompt belongs to, added 2026-09-17 ("make the agents visible"),
 * so the run status API can show it without a join.
 */
export function answerPrompt(id, answer, actor = DEFAULT_ACTOR) {
  const who = typeof actor === 'string' && actor.trim() ? actor.trim() : DEFAULT_ACTOR;
  const res = run(
    `UPDATE prompts SET answer = ?, status = 'answered', answered_at = ?, actor = ?
     WHERE id = ? AND status IN ('waiting', 'claimed')`,
    [String(answer ?? ''), nowIso(), who, id]
  );
  if (Number(res.changes) === 0) return null;
  const row = getPrompt(id);
  if (row && row.stepId) {
    run('UPDATE steps SET actor = ? WHERE id = ?', [who, row.stepId]);
  }
  return row;
}

/** Give up on a prompt. The reason is kept in the answer column. */
export function failPrompt(id, reason = 'failed') {
  run(
    "UPDATE prompts SET status = 'failed', answer = ?, answered_at = ? WHERE id = ?",
    [String(reason), nowIso(), id]
  );
  return getPrompt(id);
}

/**
 * Put a prompt back in the queue and count the retry. Used when Claude sent an
 * answer that could not be parsed as the JSON the node asked for.
 */
export function requeuePrompt(id) {
  run(
    `UPDATE prompts SET status = 'waiting', claimed_at = NULL, answered_at = NULL,
     retry_count = retry_count + 1 WHERE id = ?`,
    [id]
  );
  return getPrompt(id);
}

export function listPrompts({ runId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (runId) { where.push('run_id = ?'); params.push(runId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM prompts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id ASC LIMIT ?`;
  params.push(Math.max(1, Math.min(Number(limit) || 200, 1000)));
  return all(sql, params).map(mapPrompt);
}

export function countWaitingPrompts() {
  releaseStaleClaims();
  const row = get("SELECT COUNT(*) AS n FROM prompts WHERE status = 'waiting'");
  return num(row.n);
}

/**
 * A prompt sitting in claimed for longer than the cutoff goes back to waiting,
 * so a Claude session that died does not block the queue forever.
 */
export function releaseStaleClaims(maxMinutes = 10) {
  const cutoff = new Date(Date.now() - maxMinutes * 60 * 1000).toISOString();
  const res = run(
    "UPDATE prompts SET status = 'waiting', claimed_at = NULL WHERE status = 'claimed' AND claimed_at < ?",
    [cutoff]
  );
  return Number(res.changes);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export function addEvent({ runId = null, level = 'info', message, data = null }) {
  const res = run(
    'INSERT INTO events (run_id, ts, level, message, data) VALUES (?, ?, ?, ?, ?)',
    [runId, nowIso(), level, String(message ?? ''), toJson(data)]
  );
  return mapEvent(get('SELECT * FROM events WHERE id = ?', [num(res.lastInsertRowid)]));
}

export function listEvents(runId, limit = 500) {
  const capped = Math.max(1, Math.min(Number(limit) || 500, 5000));
  if (runId === null || runId === undefined) {
    return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [capped]).map(mapEvent).reverse();
  }
  return all('SELECT * FROM events WHERE run_id = ? ORDER BY id ASC LIMIT ?', [runId, capped]).map(mapEvent);
}

/** How many events a run has. Used so a capped list can say what it left out. */
export function countEvents(runId = null) {
  const row = runId === null || runId === undefined
    ? get('SELECT COUNT(*) AS n FROM events')
    : get('SELECT COUNT(*) AS n FROM events WHERE run_id = ?', [runId]);
  return num(row.n);
}

/**
 * The newest events for a run, handed back oldest first.
 *
 * listEvents takes the first N, which on a long run means the tail is missing,
 * and the tail is the part that says how it ended. This takes the last N and
 * flips them, so the reader always sees the end.
 */
export function listRecentEvents(runId, limit = 500) {
  const capped = Math.max(1, Math.min(Number(limit) || 500, 5000));
  if (runId === null || runId === undefined) {
    return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [capped]).map(mapEvent).reverse();
  }
  return all('SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?', [runId, capped])
    .map(mapEvent)
    .reverse();
}

/**
 * Delete events older than a cutoff. The events table only ever grows, and on
 * a machine running follow up sequences every day that is a file that quietly
 * turns into gigabytes. Default is 30 days.
 */
export function trimEvents(days = 30) {
  const safeDays = Math.max(1, Number(days) || 30);
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const res = run('DELETE FROM events WHERE ts < ?', [cutoff]);
  return Number(res.changes);
}

/**
 * Prompts that have been sitting open for too long.
 *
 * A claimed prompt releases itself after ten minutes, but a waiting one sits
 * there for ever. Nobody is coming, the run is parked behind it, and the
 * inbox count climbs. This finds them so a sweeper can close them.
 */
export function stalePrompts(maxHours = 24, limit = 200) {
  // Fractions are allowed on purpose. Half an hour is a sensible setting for
  // somebody sitting at the keyboard, and a tiny value makes this testable.
  let hours = Number(maxHours);
  if (!Number.isFinite(hours) || hours <= 0) hours = 24;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const capped = Math.max(1, Math.min(Number(limit) || 200, 1000));
  return all(
    `SELECT * FROM prompts
     WHERE status IN ('waiting', 'claimed') AND created_at < ?
     ORDER BY id ASC LIMIT ?`,
    [cutoff, capped]
  ).map(mapPrompt);
}

// ---------------------------------------------------------------------------
// FORGE: cross-run state for parallel dispatch (FORGE.md)
// ---------------------------------------------------------------------------
//
// Every function below that checks something and then writes based on that
// check is one BEGIN IMMEDIATE transaction, start to finish, with no await
// anywhere inside it. That is the whole guard FORGE.md section 6 names: a
// check and a write that are not the same transaction is not a real cap, it
// is a race waiting for two things to land close enough together. node:sqlite
// is synchronous end to end, so a function built this way genuinely cannot
// interleave with another call in this process, and BEGIN IMMEDIATE takes
// sqlite's one write lock at the start (not at the first write), which is
// what closes the same window across two separate processes sharing one
// flow.db file.

/**
 * Run fn inside BEGIN IMMEDIATE on the shared connection. fn must be
 * synchronous and must not call anything that awaits. Rolls back and
 * rethrows on any error, so a half finished check-then-act never sticks.
 */
function withImmediate(fn) {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
  } catch (err) {
    try { conn.exec('ROLLBACK'); } catch { /* nothing left to roll back */ }
    throw err;
  }
  conn.exec('COMMIT');
  return result;
}

function mapForgeClaim(row) {
  if (!row) return null;
  return {
    pieceId: row.piece_id,
    section: row.section,
    agent: row.agent,
    status: row.status,
    claimedAt: row.claimed_at,
    draftedAt: row.drafted_at,
    settledAt: row.settled_at,
    attempt: num(row.attempt)
  };
}

/**
 * Create the "open" row for one section of one piece, if it is not there yet.
 * Call this once per section the moment a piece enters the pipeline
 * (FORGE.md 1.1). Safe to call again: it never overwrites an existing row, so
 * a resumed run re-declaring its sections does not reset anything already
 * claimed or settled.
 */
export function ensureForgeClaim({ pieceId, section, agent }) {
  if (!pieceId || !section || !agent) throw new Error('ensureForgeClaim needs pieceId, section, and agent');
  run(
    `INSERT INTO forge_claims (piece_id, section, agent, status, attempt)
     VALUES (?, ?, ?, 'open', 1)
     ON CONFLICT(piece_id, section) DO NOTHING`,
    [pieceId, section, agent]
  );
  return getForgeClaim(pieceId, section);
}

export function getForgeClaim(pieceId, section) {
  return mapForgeClaim(get('SELECT * FROM forge_claims WHERE piece_id = ? AND section = ?', [pieceId, section]));
}

export function listForgeClaims(pieceId) {
  return all('SELECT * FROM forge_claims WHERE piece_id = ? ORDER BY section ASC', [pieceId]).map(mapForgeClaim);
}

/**
 * The one atomic check-and-claim from FORGE.md section 2.1.
 *
 * hardReads lists the sections this section may not start ahead of. Every one
 * of them must already be "settled" or the claim is refused outright, nothing
 * written. This whole function is the single transaction: the read of the
 * hard deps and the write of the claim never split across an await, so two
 * agents racing for the same section cannot both read "open" and both win,
 * and a section cannot be claimed a beat before its real dependency settles.
 *
 * Returns one of:
 *   { ok: true, claim }
 *   { ok: false, reason: 'waiting_on_deps', waitingOn: [...] }
 *   { ok: false, reason: 'already_claimed', claim }
 *   { ok: false, reason: 'unknown_section' }   ensureForgeClaim was never called for this row
 */
export function tryClaimSection({ pieceId, section, agent, hardReads = [] }) {
  if (!pieceId || !section || !agent) throw new Error('tryClaimSection needs pieceId, section, and agent');
  return withImmediate(() => {
    if (hardReads.length) {
      const placeholders = hardReads.map(() => '?').join(', ');
      const rows = all(
        `SELECT section, status FROM forge_claims WHERE piece_id = ? AND section IN (${placeholders})`,
        [pieceId, ...hardReads]
      );
      // A hard read naming a section that has no forge_claims row at all is
      // not a section FORGE is tracking for this piece: it is written
      // sequentially, earlier in the workflow's own linear order (SCRIPT,
      // VISION, and so on), and the engine cannot even reach this claim call
      // before that node's step has already run. Only a section that IS
      // registered (part of this or another FORGE-managed batch) and is not
      // yet settled blocks the claim. This is what lets a batch declare
      // "reads SCRIPT" for documentation without FORGE needing a row for
      // every section in the whole pipeline, only the ones it actually gates.
      const byName = new Map(rows.map((r) => [r.section, r.status]));
      const waitingOn = hardReads.filter((s) => byName.has(s) && byName.get(s) !== 'settled');
      if (waitingOn.length) return { ok: false, reason: 'waiting_on_deps', waitingOn };
    }
    const existing = get('SELECT * FROM forge_claims WHERE piece_id = ? AND section = ?', [pieceId, section]);
    if (!existing) return { ok: false, reason: 'unknown_section' };
    if (existing.status !== 'open') return { ok: false, reason: 'already_claimed', claim: mapForgeClaim(existing) };
    run(
      `UPDATE forge_claims SET status = 'claimed', agent = ?, claimed_at = ?
       WHERE piece_id = ? AND section = ? AND status = 'open'`,
      [agent, nowIso(), pieceId, section]
    );
    return { ok: true, claim: getForgeClaim(pieceId, section) };
  });
}

/** claimed -> drafted, the moment the write node's file write succeeds. */
export function markSectionDrafted(pieceId, section) {
  return withImmediate(() => {
    const existing = get('SELECT * FROM forge_claims WHERE piece_id = ? AND section = ?', [pieceId, section]);
    if (!existing || existing.status !== 'claimed') {
      return { ok: false, reason: existing ? `cannot draft from status "${existing.status}"` : 'unknown_section' };
    }
    run(
      "UPDATE forge_claims SET status = 'drafted', drafted_at = ? WHERE piece_id = ? AND section = ?",
      [nowIso(), pieceId, section]
    );
    return { ok: true, claim: getForgeClaim(pieceId, section) };
  });
}

/**
 * drafted (or claimed, for a section with no downstream hard reader inside
 * its own batch, FORGE.md section 2.3) -> settled. Settled is the durable,
 * cross-run fact that everything downstream may now treat this section as a
 * locked, binding input.
 */
export function markSectionSettled(pieceId, section) {
  return withImmediate(() => {
    const existing = get('SELECT * FROM forge_claims WHERE piece_id = ? AND section = ?', [pieceId, section]);
    // 2026-09-18 overnight: a rework loop (stage 5 -> stage 2 -> the 2b parallel node again) re
    // enters a parallel node whose section is already settled. Settling a settled section is a
    // no-op, not a failure; before this the whole run died with "cannot settle from status
    // settled" on the ARTHA fashion piece's first rework round (run 28).
    if (existing && existing.status === 'settled') {
      return { ok: true, claim: existing, already: true };
    }
    if (!existing || (existing.status !== 'drafted' && existing.status !== 'claimed')) {
      return { ok: false, reason: existing ? `cannot settle from status "${existing.status}"` : 'unknown_section' };
    }
    const ts = nowIso();
    run(
      `UPDATE forge_claims SET status = 'settled', settled_at = ?, drafted_at = COALESCE(drafted_at, ?)
       WHERE piece_id = ? AND section = ?`,
      [ts, ts, pieceId, section]
    );
    return { ok: true, claim: getForgeClaim(pieceId, section) };
  });
}

function mapRevisionRound(row) {
  if (!row) return null;
  return { pieceId: row.piece_id, roundCount: num(row.round_count), status: row.status, updatedAt: row.updated_at };
}

export function getRevisionRounds(pieceId) {
  return mapRevisionRound(get('SELECT * FROM forge_revision_rounds WHERE piece_id = ?', [pieceId]));
}

/**
 * Record one revision round for a piece and enforce the three-round cap
 * (revision.md, AGENT-SPEC.md section 3, FORGE.md section 5), as one atomic
 * check-then-write. Three rounds is "at_cap": that round is still allowed,
 * it is the one that hits the cap. A fourth attempt, from any run, any
 * session, any process, finds "over_cap" before it writes anything and is
 * refused.
 */
export function recordRevisionRound(pieceId) {
  if (!pieceId) throw new Error('recordRevisionRound needs a pieceId');
  return withImmediate(() => {
    run(
      `INSERT INTO forge_revision_rounds (piece_id, round_count, status, updated_at)
       VALUES (?, 0, 'ok', ?) ON CONFLICT(piece_id) DO NOTHING`,
      [pieceId, nowIso()]
    );
    const row = get('SELECT * FROM forge_revision_rounds WHERE piece_id = ?', [pieceId]);
    if (row.status === 'at_cap' || row.status === 'over_cap') {
      if (row.status === 'at_cap') {
        run("UPDATE forge_revision_rounds SET status = 'over_cap', updated_at = ? WHERE piece_id = ?", [nowIso(), pieceId]);
      }
      return { ok: false, status: 'over_cap', roundCount: num(row.round_count) };
    }
    const nextCount = num(row.round_count) + 1;
    const nextStatus = nextCount >= 3 ? 'at_cap' : 'ok';
    run(
      'UPDATE forge_revision_rounds SET round_count = ?, status = ?, updated_at = ? WHERE piece_id = ?',
      [nextCount, nextStatus, nowIso(), pieceId]
    );
    return { ok: true, status: nextStatus, roundCount: nextCount };
  });
}

function mapConceptRestart(row) {
  if (!row) return null;
  return { id: num(row.id), pieceId: row.piece_id, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at };
}

/** No more than this many concept restarts may be "active" at once, queue wide, regardless of client. */
export const CONCEPT_RESTART_CAP = 2;

/**
 * Start a concept restart for a piece, or queue it behind the cap, whichever
 * the current count of active restarts across the whole fleet allows.
 * Queue level, not piece level, on purpose (FORGE.md section 1.3): one
 * atomic count-then-insert, so two IDEA_WRONG verdicts landing in the same
 * moment cannot both slip past a cap of two.
 */
export function startConceptRestart(pieceId) {
  if (!pieceId) throw new Error('startConceptRestart needs a pieceId');
  return withImmediate(() => {
    const activeCount = num(get("SELECT COUNT(*) AS n FROM forge_concept_restarts WHERE status = 'active'").n);
    const ts = nowIso();
    if (activeCount < CONCEPT_RESTART_CAP) {
      const res = run(
        "INSERT INTO forge_concept_restarts (piece_id, status, started_at) VALUES (?, 'active', ?)",
        [pieceId, ts]
      );
      return { ok: true, status: 'active', id: num(res.lastInsertRowid), activeCount: activeCount + 1 };
    }
    const res = run(
      "INSERT INTO forge_concept_restarts (piece_id, status, started_at) VALUES (?, 'queued', ?)",
      [pieceId, ts]
    );
    return { ok: false, status: 'queued', id: num(res.lastInsertRowid), activeCount };
  });
}

/**
 * Finish an active restart. If a queued one is waiting and there is now room
 * under the cap, promote the oldest queued row to active in the same
 * transaction, so the cap actually cycles instead of leaving queued work
 * stuck for good.
 */
export function finishConceptRestart(id) {
  return withImmediate(() => {
    const res = run(
      "UPDATE forge_concept_restarts SET status = 'done', finished_at = ? WHERE id = ? AND status = 'active'",
      [nowIso(), id]
    );
    if (Number(res.changes) === 0) return { ok: false, reason: 'not_active' };
    const activeCount = num(get("SELECT COUNT(*) AS n FROM forge_concept_restarts WHERE status = 'active'").n);
    let promoted = null;
    if (activeCount < CONCEPT_RESTART_CAP) {
      const next = get("SELECT * FROM forge_concept_restarts WHERE status = 'queued' ORDER BY id ASC LIMIT 1");
      if (next) {
        run("UPDATE forge_concept_restarts SET status = 'active', started_at = ? WHERE id = ?", [nowIso(), next.id]);
        promoted = num(next.id);
      }
    }
    return { ok: true, promoted };
  });
}

/**
 * Finish every "active" concept restart row for one piece, so a piece that reaches a real
 * terminal point (approved, or killed by the round cap) always frees the slot it holds,
 * instead of the cap only ever filling and never cycling (FORGE.md section 1.3's queued-row
 * promotion). Safe on a piece that never restarted: finds nothing, returns
 * { ok: true, finished: 0 }, never throws.
 */
export function finishConceptRestartsForPiece(pieceId) {
  if (!pieceId) throw new Error('finishConceptRestartsForPiece needs a pieceId');
  const rows = all("SELECT id FROM forge_concept_restarts WHERE piece_id = ? AND status = 'active'", [pieceId]);
  const results = rows.map((row) => finishConceptRestart(num(row.id)));
  return { ok: true, finished: results.length, results };
}

export function listConceptRestarts({ pieceId = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (pieceId) { where.push('piece_id = ?'); params.push(pieceId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM forge_concept_restarts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
  return all(sql, params).map(mapConceptRestart);
}
