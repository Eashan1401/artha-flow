// ARTHA FLOW REST API. Every route lives here.
//
// Rules that apply to the whole file:
//   - Everything is JSON, in and out.
//   - An error is a real HTTP status plus { error: { message, code } }.
//     Never a 200 with a problem hidden inside it.
//   - We read the body as JSON whatever the content type says, because
//     `curl -d '{"a":1}'` sends form encoded by default and we still want it to work.
//
// This module takes db, engine, nodes and ws as arguments instead of importing them.
// That keeps the routes testable on their own while the engine is still being built.

import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// A prompt sitting in claimed longer than this goes back to waiting on its own.
export const CLAIM_STALE_MS = 10 * 60 * 1000;

// A prompt nobody ever answers is worse than a claimed one, because nothing
// releases it. The run behind it stays parked and the inbox count climbs for
// ever. After this long we close it and fail the run with a plain reason.
export const PROMPT_MAX_AGE_HOURS = Number(process.env.AFLOW_PROMPT_MAX_AGE_HOURS || 24);
export const PROMPT_EXPIRY_EVERY_MS = Number(process.env.AFLOW_PROMPT_EXPIRY_MS || 5 * 60 * 1000);

// The events table only grows. Keep a month, drop the rest.
export const EVENT_KEEP_DAYS = Number(process.env.AFLOW_EVENT_KEEP_DAYS || 30);
export const RETENTION_EVERY_MS = Number(process.env.AFLOW_RETENTION_MS || 6 * 60 * 60 * 1000);

// GET /api/runs/:id used to load every event row a run ever wrote into one
// response. A long loop makes that megabytes. Send the newest slice instead
// and say how many were left out.
export const RUN_EVENT_LIMIT = 500;
export const RUN_EVENT_MAX = 5000;

// Server sent events: a comment line every 20 seconds keeps the connection
// from being dropped by anything in the middle.
export const SSE_HEARTBEAT_MS = 20_000;

// How many answers one batch may carry. A loop over 50 leads is the case this
// exists for, and 500 leaves plenty of room without letting one request sit
// there writing for a minute.
export const MAX_BATCH_ANSWERS = 500;

/**
 * Start a repeating background job.
 * The first pass runs shortly after boot, not a whole period later, so a
 * server that has been down for a week cleans up as soon as it is back.
 * Both timers are unref'd, so they never hold the process open.
 */
function startInterval(everyMs, fn, label, firstDelayMs = 5000) {
  const tick = () => {
    try {
      fn();
    } catch (err) {
      console.error('[' + label + '] failed: ' + (err && err.message ? err.message : err));
    }
  };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, Math.max(1000, Number(everyMs) || 60_000));
  if (typeof first.unref === 'function') first.unref();
  if (typeof timer.unref === 'function') timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ------------------------------------------------- cross origin protection
//
// The Host header check in index.js does not stop a web page. Any tab the owner
// has open can run fetch('http://127.0.0.1:7717/api/...'). The browser sets
// Host itself, so that guard passes. With a simple content type there is no
// preflight to fail either. CORS then stops the attacker READING the reply,
// but the write already happened: a workflow file written to disk, a run
// started, on his machine, from any page on the internet.
//
// Two locks, either one is enough on its own:
//
//   1. Origin. A browser always sends it on fetch, always sets it truthfully,
//      and cannot be talked out of it. No Origin at all means the caller is
//      not a browser, which is curl and the CLI, and those must keep working
//      because that is how Claude drives this thing.
//   2. Content type. A cross origin request can only avoid a preflight while
//      it uses text/plain, form encoding, or multipart. We refuse all three
//      from anything browser shaped, so such a request has to be preflighted,
//      and we answer no preflight and send no CORS headers at all.
//
// We never send Access-Control-Allow-Origin. There is no legitimate cross
// origin caller of this API.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Content types a browser can send cross origin without a preflight.
const SIMPLE_TYPES = new Set(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);

// text/plain and multipart have no business here from any caller.
const NEVER_TYPES = new Set(['text/plain', 'multipart/form-data']);

function ourPort() {
  return String(Number(process.env.AFLOW_PORT || 7717));
}

function portOf(hostHeader) {
  const m = /:(\d+)$/.exec(String(hostHeader || ''));
  return m ? m[1] : '';
}

/**
 * Is this request from a browser?
 * Origin is set on every cross origin fetch. Sec-Fetch-* is sent by every
 * current browser on every request and cannot be set by page script. Neither
 * is ever sent by curl unless somebody types it in on purpose.
 */
function looksLikeBrowser(req) {
  const h = req.headers;
  return h.origin !== undefined ||
    h['sec-fetch-mode'] !== undefined ||
    h['sec-fetch-site'] !== undefined ||
    h['sec-fetch-dest'] !== undefined;
}

/** True when the Origin header is our own page, or there is no Origin at all. */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;      // not a browser: curl, the CLI
  if (!origin || origin === 'null') return false;  // a sandboxed frame or a file:// page

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host)) return false;

  // The port has to be ours. We accept the port this very request came in on
  // as well, because the browser fills Host in itself and a page cannot forge
  // it, so a match there means same origin whatever AFLOW_PORT says.
  const port = parsed.port || '80';
  const hostPort = portOf(req.headers.host);
  return port === ourPort() || (hostPort !== '' && port === hostPort);
}

function hasBody(req) {
  const len = Number(req.headers['content-length'] || 0);
  return len > 0 || req.headers['transfer-encoding'] !== undefined;
}

/**
 * Check the content type of a request that carries a body.
 * Returns null when it is fine, or [status, code, message] when it is not.
 *
 * Strict for anything browser shaped: application/json or nothing doing.
 * A caller that is plainly not a browser may still post form encoded or with
 * no type at all, because `curl -d '{"a":1}'` does exactly that and the
 * contract's own definition of done is written that way. Set AFLOW_STRICT_JSON=1
 * to require application/json from every caller, browser or not.
 */
export function contentTypeProblem(req) {
  if (!hasBody(req)) return null;
  const raw = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (raw === 'application/json') return null;

  if (NEVER_TYPES.has(raw)) {
    return [415, 'unsupported_media_type',
      'This API only takes application/json. ' + raw + ' is not accepted.'];
  }
  if (looksLikeBrowser(req) || process.env.AFLOW_STRICT_JSON === '1') {
    return [415, 'unsupported_media_type',
      'A request with a body must send Content-Type: application/json.' +
      (raw ? ' This one sent ' + raw + '.' : ' This one sent none.')];
  }
  if (SIMPLE_TYPES.has(raw) || raw === '') return null;  // curl and the CLI
  return [415, 'unsupported_media_type',
    'This API only takes application/json. ' + raw + ' is not accepted.'];
}

/** An error we meant to send. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------------ helpers

/** Read the first key that exists. The db layer may hand back snake_case or camelCase. */
function val(row, ...keys) {
  if (!row) return undefined;
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** Parse a value that may already be an object, or may still be a JSON string. */
function maybeJson(v) {
  if (typeof v !== 'string') return v === undefined ? null : v;
  const t = v.trim();
  if (!t) return null;
  if (t[0] !== '{' && t[0] !== '[' && t[0] !== '"') return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function normRun(row) {
  if (!row) return null;
  return {
    id: val(row, 'id', 'run_id', 'runId'),
    slug: val(row, 'slug') ?? null,
    workflowId: val(row, 'workflowId', 'workflow_id') ?? null,
    status: val(row, 'status') ?? null,
    trigger: val(row, 'trigger') ?? null,
    input: maybeJson(val(row, 'input')),
    error: val(row, 'error') ?? null,
    startedAt: val(row, 'startedAt', 'started_at') ?? null,
    endedAt: val(row, 'endedAt', 'ended_at') ?? null,
    // Set only while a run is parked on a wait node. The UI can show when it
    // will pick itself back up.
    wakeAt: val(row, 'wakeAt', 'wake_at') ?? null
  };
}

function normStep(row) {
  if (!row) return null;
  return {
    id: val(row, 'id'),
    runId: val(row, 'runId', 'run_id') ?? null,
    nodeId: val(row, 'nodeId', 'node_id') ?? null,
    nodeType: val(row, 'nodeType', 'node_type') ?? null,
    name: val(row, 'name') ?? null,
    iteration: row.iteration === undefined ? null : row.iteration,
    status: val(row, 'status') ?? null,
    input: maybeJson(val(row, 'input')),
    output: maybeJson(val(row, 'output')),
    error: val(row, 'error') ?? null,
    startedAt: val(row, 'startedAt', 'started_at') ?? null,
    endedAt: val(row, 'endedAt', 'ended_at') ?? null,
    // "make the agents visible", 2026-09-17: who answered the prompt behind
    // this step, set by db.answerPrompt and copied here from the same
    // column, so no join is needed to show it.
    actor: val(row, 'actor') ?? null
  };
}

// ---------------------------------------------------------------------------
// "make the agents visible", 2026-09-17
// ---------------------------------------------------------------------------
//
// Every node in a workflow file can carry `config.role` (the agent role card
// that owns this step, for example "why-analyst") and `config.desk` (a plain
// English name for the job, for example "Layer 5, owned content and
// performance, why analyst"). Both may hold a template, {{ item.role }}
// being the normal case inside an each loop, and both are already resolved
// by the engine's own render() when it fills in the rest of the node's
// config, so a step's stored `input` (its rendered config) already carries
// the real strings once the step has run. A step that never got that far
// (still queued, or the workflow was edited after this run started) falls
// back to the raw, unrendered text from the workflow file, which is still
// readable and still names the right role card.
//
// A regex is enough for "the output file path if the answer names one": the
// convention across every workflow is that Claude's answer text or a step's
// own JSON output states the real path it wrote, and every one of those
// paths lives under clients/. This is read only, it does not touch disk.
const OUTPUT_FILE_RE = /clients\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+/;

function findOutputFile(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = OUTPUT_FILE_RE.exec(text);
  return m ? m[0].replace(/[.,;:)]+$/, '') : null;
}

/** A short, human readable verdict for a mechanical (non-claude) step. */
function checkResultFor(step) {
  const out = step.output;
  if (step.nodeType === 'filter') {
    if (!out) return null;
    return out.passed === true ? 'passed' : out.passed === false ? 'blocked' : null;
  }
  if (step.nodeType === 'shell-json') {
    if (!out) return null;
    if (out.json && typeof out.json.pass === 'boolean') return out.json.pass ? 'PASS' : 'FAIL';
    if (out.json && typeof out.json.stage === 'string') return out.json.stage;
    if (typeof out.exitCode === 'number') return out.exitCode === 0 ? 'ok' : `exit ${out.exitCode}`;
    return null;
  }
  if (step.status === 'failed') return 'failed';
  return null;
}

/**
 * Add desk, role, the output file path, and a check result to every step of
 * one run, reading the workflow definition for the role card and desk name,
 * and the run's own steps and prompts for what actually happened.
 *
 * Additive only: every existing field on a step is untouched, this only adds
 * new keys. A run whose workflow no longer exists (deleted, renamed) still
 * gets its steps back, just without desk or role.
 */
function enrichSteps(steps, def, prompts) {
  const nodesById = new Map();
  if (def && Array.isArray(def.nodes)) {
    for (const n of def.nodes) if (n && n.id) nodesById.set(n.id, n);
  }
  const promptByStepId = new Map();
  for (const p of prompts || []) {
    if (p.stepId !== null && p.stepId !== undefined) promptByStepId.set(p.stepId, p);
  }
  return steps.map((step) => {
    const node = nodesById.get(step.nodeId) || null;
    const rendered = step.input && typeof step.input === 'object' ? step.input : null;
    const rawCfg = node && node.config ? node.config : null;
    const desk = (rendered && rendered.desk) || (rawCfg && rawCfg.desk) || null;
    const role = (rendered && rendered.role) || (rawCfg && rawCfg.role) || null;
    // "skills on the desks", 2026-09-17: same rendered-then-raw fallback as
    // desk/role above. config.skills is a list of "skill (provenance tag)"
    // strings. Empty list means no skill is wired
    // to this desk today, which is itself a real, checkable finding, not a
    // missing field, so it is always an array, never null.
    const skillsRaw = (rendered && rendered.skills) || (rawCfg && rawCfg.skills) || [];
    const skills = Array.isArray(skillsRaw) ? skillsRaw : [];
    const prompt = promptByStepId.get(step.id) || null;
    const actor = step.actor || (prompt && prompt.actor) || null;
    const outputFile =
      findOutputFile(prompt && prompt.answer) ||
      findOutputFile(step.output && step.output.text) ||
      findOutputFile(JSON.stringify(step.output || ''));
    return {
      ...step,
      desk,
      role,
      skills,
      actor,
      outputFile,
      checkResult: checkResultFor(step)
    };
  });
}

function normEvent(row) {
  if (!row) return null;
  return {
    id: val(row, 'id'),
    runId: val(row, 'runId', 'run_id') ?? null,
    ts: val(row, 'ts') ?? null,
    level: val(row, 'level') ?? 'info',
    message: val(row, 'message') ?? '',
    data: maybeJson(val(row, 'data'))
  };
}

function normPrompt(row) {
  if (!row) return null;
  return {
    id: val(row, 'id'),
    runId: val(row, 'runId', 'run_id') ?? null,
    stepId: val(row, 'stepId', 'step_id') ?? null,
    nodeId: val(row, 'nodeId', 'node_id') ?? null,
    system: val(row, 'system') ?? null,
    prompt: val(row, 'prompt') ?? '',
    expect: val(row, 'expect') ?? 'text',
    schemaHint: val(row, 'schemaHint', 'schema_hint') ?? null,
    answer: val(row, 'answer') ?? null,
    status: val(row, 'status') ?? null,
    claimedAt: val(row, 'claimedAt', 'claimed_at') ?? null,
    retryCount: val(row, 'retryCount', 'retry_count') ?? 0,
    createdAt: val(row, 'createdAt', 'created_at') ?? null,
    answeredAt: val(row, 'answeredAt', 'answered_at') ?? null,
    actor: val(row, 'actor') ?? null
  };
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  if (res.req && res.req.method === 'HEAD') return res.end();
  res.end(text);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { message, code } });
}

/** Read the request body and parse it as JSON. An empty body is an empty object. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'body_too_large', 'Request body is bigger than 5 MB.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      throw new ApiError(400, 'bad_body', 'Body must be a JSON object.');
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'bad_json', 'Body is not valid JSON.');
  }
}

/** An age in hours, said the way a person would say it. */
function sayAge(hours) {
  const h = Number(hours) || 0;
  if (h >= 1) return Math.round(h * 10) / 10 + (h === 1 ? ' hour' : ' hours');
  const minutes = h * 60;
  if (minutes >= 1) return Math.round(minutes) + (Math.round(minutes) === 1 ? ' minute' : ' minutes');
  return Math.max(1, Math.round(minutes * 60)) + ' seconds';
}

/** Bytes in a form a person can read at a glance. */
function humanBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[i];
}

function asInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, 'bad_id', name + ' must be a whole number greater than zero.');
  }
  return n;
}

function callIf(db, name, ...args) {
  if (typeof db[name] !== 'function') return undefined;
  return db[name](...args);
}

// ------------------------------------------------------------------ the API

/**
 * Build the API handler.
 *
 * deps:
 *   db        the module from server/db.js
 *   dbHandle  whatever openDb() returned, used only by the reaper fallback
 *   engine    the module from server/engine.js
 *   nodes     the module from server/nodes/index.js, or null if it is not there yet
 *   ws        the websocket hub, used to push events the API itself creates
 *   version   string for /api/health
 *   startedAt Date.now() at boot, for uptimeSec
 *   root      absolute path of the artha-flow folder
 */
export function createApi(deps) {
  const { db, engine, ws, version, startedAt, root } = deps;

  // Background jobs. They are started here because createApi is the one thing
  // the server always builds at boot, and they all need db and engine, which
  // arrive as arguments. Every timer is unref'd, so a test process can still
  // exit. Set AFLOW_NO_SWEEPERS=1 to keep them switched off.
  const stopSweepers = deps.sweepers === false || process.env.AFLOW_NO_SWEEPERS === '1'
    ? () => {}
    : startBackgroundJobs();

  function startBackgroundJobs() {
    const stops = [];

    // Wake runs parked on a wait node. The wake time lives in the database, so
    // this picks up runs that were parked before the server was restarted.
    if (typeof engine.startTimerSweeper === 'function') {
      stops.push(engine.startTimerSweeper({ everyMs: Number(process.env.AFLOW_TIMER_TICK_MS || 1000) }));
    }

    // Close prompts nobody ever answered, and fail the runs stuck behind them.
    stops.push(startInterval(PROMPT_EXPIRY_EVERY_MS, () => {
      const closed = expireStalePrompts();
      if (closed > 0) console.log('[expiry] closed ' + closed + ' prompt(s) nobody answered');
    }, 'prompt expiry'));

    // Trim old events, so the database does not grow for ever.
    stops.push(startInterval(RETENTION_EVERY_MS, () => {
      const gone = trimOldEvents();
      if (gone > 0) console.log('[retention] removed ' + gone + ' event row(s) past the keep window');
    }, 'retention'));

    return () => { for (const stop of stops) { try { stop(); } catch { /* already stopped */ } } };
  }

  // ---------------------------------------------------------- shared bits

  function countByStatus(status) {
    try {
      if (typeof db.countRunsByStatus === 'function') return Number(db.countRunsByStatus(status)) || 0;
      return (callIf(db, 'listRuns', { status, limit: 500 }) || [])
        .filter((r) => val(r, 'status') === status).length;
    } catch {
      return 0;
    }
  }

  function waitingPrompts() {
    try {
      if (typeof db.countWaitingPrompts === 'function') return Number(db.countWaitingPrompts()) || 0;
      const rows = callIf(db, 'listPrompts', { status: 'waiting' }) || [];
      // We filter again in case listPrompts ignores the filter argument.
      return rows.filter((p) => (p.status || '') === 'waiting').length;
    } catch {
      return 0;
    }
  }

  // A run that was cancelled or already failed has no use for an answer. Its prompts
  // must not keep coming back to Claude for ever, so we skip them here.
  const DEAD_RUN = new Set(['cancelled', 'failed', 'done']);

  function promptIsLive(row) {
    const runId = val(row, 'runId', 'run_id');
    if (!runId) return true;
    try {
      const run = callIf(db, 'getRun', runId);
      if (!run) return true;
      return !DEAD_RUN.has(String(val(run, 'status')));
    } catch {
      return true;
    }
  }

  function pendingPrompts() {
    const rows = callIf(db, 'listPrompts', { status: 'waiting' }) || [];
    return rows
      .filter((p) => (p.status || '') === 'waiting')
      .filter(promptIsLive)
      .map(normPrompt)
      .sort((a, b) => Number(a.id) - Number(b.id)); // newest last, as the contract says
  }

  /** Push an event to the websocket and, when we can, into the events table. */
  function emit(event) {
    try {
      ws.broadcast(event);
    } catch {
      // A broken socket must never break an API call.
    }
  }

  function record(runId, level, message, data) {
    try {
      callIf(db, 'addEvent', { runId, level, message, data: data ?? null });
    } catch {
      // If the events table refuses the row we still carry on. The websocket already has it.
    }
  }

  /** Mark a run failed and say so everywhere. Used when a resume blows up. */
  function failRun(runId, message) {
    const now = new Date().toISOString();
    try {
      callIf(db, 'updateRun', runId, { status: 'failed', error: message, endedAt: now });
    } catch {
      // Nothing else we can do here. The event below is still the record.
    }
    record(runId, 'error', message);
    emit({ type: 'run.failed', runId, error: message, at: now });
  }

  /**
   * Store one answer. No resume, that is a separate step, because a batch has
   * to write every answer down before it starts moving any run.
   *
   * Returns { ok: true, runId } or { ok: false, status, code, message }. It
   * never throws for a bad prompt, so a batch can carry on past one bad item.
   */
  function storeAnswer(promptId, answer, actor) {
    const id = Number(promptId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, status: 400, code: 'bad_id', message: 'promptId must be a whole number greater than zero.' };
    }
    if (typeof answer !== 'string' || answer.length === 0) {
      return { ok: false, status: 400, code: 'bad_answer', message: 'answer must be a string with something in it.' };
    }
    const row = callIf(db, 'getPrompt', id);
    if (!row) {
      return { ok: false, status: 404, code: 'prompt_not_found', message: 'No prompt with id ' + id + '.' };
    }
    const status = val(row, 'status');
    if (status === 'answered') {
      return { ok: false, status: 409, code: 'prompt_already_answered', message: 'Prompt ' + id + ' was already answered.' };
    }
    if (status === 'failed') {
      return { ok: false, status: 409, code: 'prompt_failed', message: 'Prompt ' + id + ' is marked failed, so it cannot take an answer.' };
    }
    const runId = Number(val(row, 'runId', 'run_id'));
    // Who answered it. "make the agents visible": the caller names itself,
    // for example --actor "claude:artefact-strategist" from a spawned agent's
    // own aflow call, or the default when nothing is given.
    const who = typeof actor === 'string' && actor.trim() ? actor.trim() : 'claude:session';

    // If this throws, the caller gets a real error and nothing resumed.
    callIf(db, 'answerPrompt', id, answer, who);

    emit({ type: 'prompt.answered', runId, promptId: id, actor: who });
    record(runId, 'info', 'Prompt ' + id + ' answered by ' + who + '.');
    return { ok: true, runId, promptId: id };
  }

  /**
   * Carry the run on in the background. The HTTP answer must not wait for a
   * whole run to finish. A failure in here must never disappear: it becomes an
   * event and the run is marked failed.
   */
  function scheduleResume(runId, promptId) {
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => {
          if (typeof engine.resumeRun !== 'function') {
            throw new Error('The engine has no resumeRun, so the run cannot carry on.');
          }
          return engine.resumeRun(runId);
        })
        .catch((err) => {
          const message = 'Resume of run ' + runId + ' failed after prompt ' + promptId + ': ' +
            (err && err.message ? err.message : String(err));
          failRun(runId, message);
        });
    });
  }

  /**
   * Answer a pile of prompts in one request.
   *
   * Every answer is written down first, then each affected run is resumed
   * once. A bad item does not stop the good ones: it comes back in the results
   * list with its own reason, and the response is still a 200 because the
   * request itself was fine. Callers read `failed` and the per item `ok`.
   */
  async function answerMany(list) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new ApiError(400, 'bad_answers', 'answers must be a list with at least one item in it.');
    }
    if (list.length > MAX_BATCH_ANSWERS) {
      throw new ApiError(400, 'too_many_answers',
        'answers holds ' + list.length + ' items and the limit is ' + MAX_BATCH_ANSWERS + '.');
    }

    const results = [];
    const runIds = [];
    for (const item of list) {
      const promptId = item && typeof item === 'object' ? item.promptId : undefined;
      const answer = item && typeof item === 'object' ? item.answer : undefined;
      const actor = item && typeof item === 'object' ? item.actor : undefined;
      let stored;
      try {
        stored = storeAnswer(promptId, answer, actor);
      } catch (err) {
        stored = { ok: false, status: 500, code: 'answer_failed', message: err && err.message ? err.message : String(err) };
      }
      if (stored.ok) {
        results.push({ promptId: stored.promptId, ok: true, runId: stored.runId });
        if (!runIds.includes(stored.runId)) runIds.push(stored.runId);
      } else {
        results.push({
          promptId: promptId === undefined ? null : promptId,
          ok: false,
          error: { message: stored.message, code: stored.code }
        });
      }
    }

    // One resume per run, however many of its prompts were in the batch.
    for (const runId of runIds) scheduleResume(runId, 'batch');

    const answered = results.filter((r) => r.ok).length;
    return {
      ok: answered === results.length,
      answered,
      failed: results.length - answered,
      runIds,
      resumed: true,
      results
    };
  }

  /**
   * Close prompts that have been open too long, and fail the runs behind them.
   *
   * A claimed prompt releases itself after ten minutes and goes back in the
   * queue. A waiting one has nothing to release it, so an abandoned run holds
   * a slot in the inbox for ever and waitingPrompts only ever goes up. This is
   * the sweeper that ends that. Default is 24 hours.
   */
  function expireStalePrompts(maxHours = PROMPT_MAX_AGE_HOURS) {
    let rows = [];
    try {
      if (typeof db.stalePrompts === 'function') {
        rows = db.stalePrompts(maxHours) || [];
      } else {
        const cutoff = Date.now() - Math.max(1, maxHours) * 60 * 60 * 1000;
        rows = (callIf(db, 'listPrompts', {}) || []).filter((p) => {
          const status = String(val(p, 'status') || '');
          if (status !== 'waiting' && status !== 'claimed') return false;
          const made = Date.parse(val(p, 'createdAt', 'created_at') || '');
          return Number.isFinite(made) && made < cutoff;
        });
      }
    } catch {
      return 0;
    }

    let closed = 0;
    for (const row of rows) {
      const promptId = val(row, 'id');
      const runId = Number(val(row, 'runId', 'run_id'));
      const reason = 'Nobody answered prompt ' + promptId + ' within ' +
        sayAge(maxHours) + ', so it was closed and the run was stopped.';
      try {
        setPromptStatus(promptId, 'failed', reason);
        emit({ type: 'prompt.failed', runId, promptId, reason, expired: true });
        // The step the run parked on is still sitting at running. Close it too,
        // otherwise the run reads failed while its last step reads running.
        const stepId = val(row, 'stepId', 'step_id');
        if (stepId && typeof db.updateStep === 'function') {
          try {
            db.updateStep(Number(stepId), { status: 'failed', error: reason, endedAt: new Date().toISOString() });
          } catch { /* the step row is only for reading back, do not stop for it */ }
        }
        const run = callIf(db, 'getRun', runId);
        if (run && !DEAD_RUN.has(String(val(run, 'status')))) failRun(runId, reason);
        closed++;
      } catch {
        // Leave this one for the next pass rather than stopping the sweep.
      }
    }
    return closed;
  }

  /**
   * Walk data/out and say how big it has got.
   *
   * Nothing is deleted, ever. This is a mirror, not a broom. The walk is
   * capped on both files and depth so a folder somebody symlinked into a loop
   * cannot hang the server, and it says so when it stops early.
   */
  function storageReport(maxFiles = 20000, maxDepth = 12) {
    const outDir = path.join(root, 'data', 'out');
    const report = {
      root: 'data/out',
      files: 0,
      bytes: 0,
      human: '0 B',
      folders: [],
      largest: null,
      oldest: null,
      newest: null,
      truncated: false,
      dbBytes: 0
    };

    const byFolder = new Map();
    const walk = (dir, depth, topName) => {
      if (report.truncated || depth > maxDepth) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (report.files >= maxFiles) { report.truncated = true; return; }
        const full = path.join(dir, entry.name);
        // Never follow a link. It could point anywhere, including in a circle.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(full, depth + 1, topName ?? entry.name);
          continue;
        }
        if (!entry.isFile()) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        report.files += 1;
        report.bytes += stat.size;
        const rel = path.relative(outDir, full);
        const key = topName ?? '.';
        const folder = byFolder.get(key) || { name: key, files: 0, bytes: 0 };
        folder.files += 1;
        folder.bytes += stat.size;
        byFolder.set(key, folder);
        if (!report.largest || stat.size > report.largest.bytes) {
          report.largest = { path: rel, bytes: stat.size };
        }
        const mtime = stat.mtime.toISOString();
        if (!report.oldest || mtime < report.oldest.at) report.oldest = { path: rel, at: mtime };
        if (!report.newest || mtime > report.newest.at) report.newest = { path: rel, at: mtime };
      }
    };

    walk(outDir, 0, null);
    report.human = humanBytes(report.bytes);
    report.folders = [...byFolder.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 50)
      .map((f) => ({ ...f, human: humanBytes(f.bytes) }));

    // The database sits next door and grows too, so it is worth the same look.
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        report.dbBytes += fs.statSync(path.join(root, 'data', 'flow.db' + suffix)).size;
      }
    } catch {
      // A missing wal file is normal.
    }
    report.dbHuman = humanBytes(report.dbBytes);
    report.eventKeepDays = EVENT_KEEP_DAYS;
    return report;
  }

  /** Delete event rows older than the keep window. Returns how many went. */
  function trimOldEvents(days = EVENT_KEEP_DAYS) {
    try {
      if (typeof db.trimEvents !== 'function') return 0;
      return Number(db.trimEvents(days)) || 0;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------- server sent events
  //
  // The websocket is right for the UI and wrong for a terminal. This route
  // lets a Claude session watch a run with nothing but
  //   curl -N 127.0.0.1:7717/api/runs/12/stream
  // and no client code at all, which is how this product actually gets used.
  //
  // One engine listener feeds every open stream, so a hundred watchers cost
  // one subscription. Events already written for the run are replayed on
  // connect, so nothing that happened before you started watching is missed,
  // and the stream closes itself when the run ends.

  const sseClients = new Set();
  let sseHooked = false;

  function hookEngineEvents() {
    if (sseHooked || typeof engine.onEvent !== 'function') return;
    sseHooked = true;
    engine.onEvent((event) => {
      if (!sseClients.size) return;
      const runId = Number(val(event, 'runId', 'run_id'));
      for (const client of sseClients) {
        if (client.runId === runId) client.push(event);
      }
    });
  }

  const RUN_ENDED = new Set(['done', 'failed', 'cancelled']);

  /**
   * Turn a stored event row into the same shape the live feed sends, so a
   * reader cannot tell a replayed event from a live one.
   */
  function eventFromRow(row) {
    const e = normEvent(row);
    if (e.data && typeof e.data === 'object' && !Array.isArray(e.data) && e.data.type) {
      return { ...e.data, ts: e.ts, replayed: true };
    }
    return { type: 'log', runId: e.runId, level: e.level, message: e.message, ts: e.ts, replayed: true };
  }

  function streamRun(req, res, runId) {
    const run = callIf(db, 'getRun', runId);
    if (!run) throw new ApiError(404, 'run_not_found', 'No run with id ' + runId + '.');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Nothing should sit in front of this holding the bytes back.
      'X-Accel-Buffering': 'no'
    });

    const client = {
      runId,
      push(event) {
        try {
          res.write('event: ' + String(event.type || 'message') + '\n');
          res.write('data: ' + JSON.stringify(event) + '\n\n');
        } catch {
          close();
          return;
        }
        if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') {
          finish(String(event.status || event.type.split('.')[1]));
        }
      }
    };

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      sseClients.delete(client);
      try { res.end(); } catch { /* already gone */ }
    }
    function finish(status) {
      if (closed) return;
      try {
        res.write('event: end\n');
        res.write('data: ' + JSON.stringify({ type: 'end', runId, status }) + '\n\n');
      } catch { /* the reader hung up */ }
      close();
    }

    // A comment line every 20 seconds. It is ignored by every reader and it
    // stops anything in the middle deciding the connection went quiet.
    const beat = setInterval(() => {
      if (closed) return;
      try { res.write(': heartbeat\n\n'); } catch { close(); }
    }, SSE_HEARTBEAT_MS);
    if (typeof beat.unref === 'function') beat.unref();

    req.on('close', close);
    req.on('error', close);
    res.on('error', close);

    hookEngineEvents();
    sseClients.add(client);

    // Replay first, so a reader that connects late still sees the whole run.
    const rows = (typeof db.listRecentEvents === 'function'
      ? db.listRecentEvents(runId, RUN_EVENT_LIMIT)
      : callIf(db, 'listEvents', runId) || []);
    const total = typeof db.countEvents === 'function' ? Number(db.countEvents(runId)) : rows.length;
    try {
      res.write('event: hello\n');
      res.write('data: ' + JSON.stringify({
        type: 'hello',
        runId,
        status: val(run, 'status'),
        slug: val(run, 'slug'),
        replaying: rows.length,
        hidden: Math.max(0, total - rows.length),
        version
      }) + '\n\n');
    } catch {
      close();
      return;
    }
    for (const row of rows) {
      if (closed) return;
      client.push(eventFromRow(row));
    }

    // A run that already ended gets its history and then a clean close, so
    // curl -N comes straight back instead of hanging for ever.
    if (!closed && RUN_ENDED.has(String(val(run, 'status')))) {
      finish(String(val(run, 'status')));
    }
  }

  // ---------------------------------------------------------- route table

  async function handle(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const seg = parts.slice(1);                            // drop 'api'

    // GET /api/health
    if (seg.length === 1 && seg[0] === 'health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        waitingPrompts: waitingPrompts(),
        // Runs parked on a wait node. They are not in the Claude inbox and
        // nobody needs to answer them, they are just waiting for a clock.
        waitingOnTimer: countByStatus('waiting_on_timer'),
        waitingOnClaude: countByStatus('waiting_on_claude')
      });
    }

    // ---- workflows

    if (seg[0] === 'workflows') {
      // GET /api/workflows
      if (seg.length === 1 && method === 'GET') {
        const rows = callIf(db, 'listWorkflows') || [];
        const out = rows.map((w) => {
          const def = maybeJson(val(w, 'definition')) || {};
          let lastRun = null;
          try {
            const runs = callIf(db, 'listRuns', { slug: val(w, 'slug'), limit: 1 }) || [];
            const first = runs.filter((r) => val(r, 'slug') === val(w, 'slug'))[0] || runs[0];
            if (first) {
              const r = normRun(first);
              lastRun = { id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt };
            }
          } catch {
            lastRun = null;
          }
          return {
            slug: val(w, 'slug'),
            name: val(w, 'name') ?? val(w, 'slug'),
            description: val(w, 'description') ?? '',
            nodeCount: Array.isArray(def.nodes) ? def.nodes.length : 0,
            enabled: Number(val(w, 'enabled') ?? 1) === 1,
            lastRun
          };
        });
        return sendJson(res, 200, out);
      }

      const slug = seg[1] ? decodeURIComponent(seg[1]) : null;

      // GET /api/workflows/:slug
      if (seg.length === 2 && method === 'GET') {
        const row = callIf(db, 'getWorkflowBySlug', slug);
        if (!row) throw new ApiError(404, 'workflow_not_found', 'No workflow with slug ' + slug + '.');
        const def = maybeJson(val(row, 'definition'));
        return sendJson(res, 200, def && typeof def === 'object' ? def : row);
      }

      // PUT /api/workflows/:slug
      if (seg.length === 2 && method === 'PUT') {
        if (!SLUG_RE.test(String(slug))) {
          throw new ApiError(400, 'bad_slug', 'Slug may only hold lower case letters, numbers, dot, dash and underscore.');
        }
        const body = await readJsonBody(req);
        const def = body && typeof body.definition === 'object' && body.definition !== null ? body.definition : body;
        if (!Array.isArray(def.nodes)) {
          throw new ApiError(400, 'bad_definition', 'A workflow needs a nodes array.');
        }
        if (def.slug && def.slug !== slug) {
          throw new ApiError(400, 'slug_mismatch', 'The slug in the body does not match the slug in the path.');
        }
        def.slug = slug;
        if (!def.name) def.name = slug;

        callIf(db, 'upsertWorkflow', {
          slug,
          name: def.name,
          description: def.description ?? '',
          definition: def,
          enabled: def.enabled === false ? 0 : 1
        });

        // Also write the file back, so the folder stays the source of truth on disk.
        const file = path.join(root, 'workflows', slug + '.json');
        const dir = path.dirname(file);
        if (path.resolve(dir) !== path.join(root, 'workflows')) {
          throw new ApiError(400, 'bad_slug', 'That slug does not make a safe file name.');
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n', 'utf8');

        emit({ type: 'workflow.saved', slug });
        return sendJson(res, 200, { ok: true });
      }

      // POST /api/workflows/:slug/run
      if (seg.length === 3 && seg[2] === 'run' && method === 'POST') {
        const body = await readJsonBody(req);
        const existing = callIf(db, 'getWorkflowBySlug', slug);
        if (existing === null || existing === undefined) {
          throw new ApiError(404, 'workflow_not_found', 'No workflow with slug ' + slug + '.');
        }
        const trigger = typeof body.trigger === 'string' ? body.trigger : 'api';
        const input = body.input !== undefined ? body.input : {};
        if (typeof engine.startRun !== 'function') {
          throw new ApiError(503, 'engine_unavailable', 'The engine is not loaded, so nothing can run yet.');
        }
        const started = await engine.startRun({ slug, input, trigger });
        const runId = val(started, 'runId', 'id');
        if (!runId) throw new ApiError(500, 'run_not_started', 'The engine did not give back a run id.');
        const run = normRun(callIf(db, 'getRun', runId));
        return sendJson(res, 201, { runId, status: run ? run.status : 'queued' });
      }
    }

    // ---- runs

    if (seg[0] === 'runs') {
      // GET /api/runs?status=&slug=&limit=
      if (seg.length === 1 && method === 'GET') {
        const q = url.searchParams;
        const filter = {};
        if (q.get('status')) filter.status = q.get('status');
        if (q.get('slug')) filter.slug = q.get('slug');
        const limitRaw = q.get('limit');
        const limit = limitRaw === null ? 50 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
          throw new ApiError(400, 'bad_limit', 'limit must be a whole number from 1 to 500.');
        }
        filter.limit = limit;
        let rows = callIf(db, 'listRuns', filter) || [];
        // Filter again ourselves, so a db that ignores the filter still answers correctly.
        if (filter.status) rows = rows.filter((r) => val(r, 'status') === filter.status);
        if (filter.slug) rows = rows.filter((r) => val(r, 'slug') === filter.slug);
        rows = rows.slice(0, limit);
        return sendJson(res, 200, rows.map((r) => {
          const n = normRun(r);
          return {
            id: n.id,
            slug: n.slug,
            status: n.status,
            startedAt: n.startedAt,
            endedAt: n.endedAt,
            trigger: n.trigger,
            // The first 200 characters of the error, so the runs table can say
            // why a run failed without anybody opening it. The full text is
            // still on GET /api/runs/:id.
            error: n.error ? String(n.error).slice(0, 200) : null,
            wakeAt: n.wakeAt
          };
        }));
      }

      // GET /api/runs/:id
      if (seg.length === 2 && method === 'GET') {
        const id = asInt(seg[1], 'run id');
        const run = callIf(db, 'getRun', id);
        if (!run) throw new ApiError(404, 'run_not_found', 'No run with id ' + id + '.');

        // The events are capped. A long each loop can write thousands of rows
        // and this route used to load every one of them into one response.
        // We send the newest slice, oldest first, and say how many were left
        // out so the UI can tell the reader.
        const rawLimit = url.searchParams.get('events');
        let limit = RUN_EVENT_LIMIT;
        if (rawLimit !== null) {
          limit = Number(rawLimit);
          if (!Number.isInteger(limit) || limit <= 0 || limit > RUN_EVENT_MAX) {
            throw new ApiError(400, 'bad_limit',
              'events must be a whole number from 1 to ' + RUN_EVENT_MAX + '.');
          }
        }
        const eventRows = typeof db.listRecentEvents === 'function'
          ? db.listRecentEvents(id, limit)
          : (callIf(db, 'listEvents', id, limit) || []).slice(-limit);
        const eventTotal = typeof db.countEvents === 'function'
          ? Number(db.countEvents(id))
          : eventRows.length;

        const runPrompts = (callIf(db, 'listPrompts', { runId: id }) || [])
          .filter((p) => Number(val(p, 'runId', 'run_id')) === id)
          .map(normPrompt);
        const runSlug = val(run, 'slug');
        const workflowDef = runSlug ? callIf(db, 'getWorkflowBySlug', runSlug) : null;
        const rawSteps = (callIf(db, 'listSteps', id) || []).map(normStep);

        return sendJson(res, 200, {
          run: normRun(run),
          steps: enrichSteps(rawSteps, val(workflowDef, 'definition') ?? null, runPrompts),
          events: eventRows.map(normEvent),
          prompts: runPrompts,
          // Newest last. eventsHidden is how many older ones were not sent.
          eventTotal,
          eventsHidden: Math.max(0, eventTotal - eventRows.length),
          eventLimit: limit
        });
      }

      // GET /api/runs/:id/stream   server sent events, for a terminal
      if (seg.length === 3 && seg[2] === 'stream' && method === 'GET') {
        const id = asInt(seg[1], 'run id');
        return streamRun(req, res, id);
      }

      // GET /api/runs/:id/story
      //
      // bin/run-story writes projects/system-atlas/runs/<piece or slug>-STORY.md
      // (and a .json twin), named by the piece slug for a media run or the
      // client slug for a research run, never by the numeric run id, because
      // several runs over the life of one piece all tell that piece's story.
      // This route finds that file for a given run id so the UI's Runs page
      // can link straight to it without knowing the naming convention itself.
      // Read only. Never writes, never runs bin/run-story itself: a story is
      // built by hand, on purpose, not generated on every page view.
      if (seg.length === 3 && seg[2] === 'story' && method === 'GET') {
        const id = asInt(seg[1], 'run id');
        const run = callIf(db, 'getRun', id);
        if (!run) throw new ApiError(404, 'run_not_found', 'No run with id ' + id + '.');
        const input = maybeJson(val(run, 'input')) || {};
        const eaRoot = path.resolve(root, '..', '..');
        const storiesDir = path.join(eaRoot, 'projects/system-atlas/runs');
        const candidates = [];
        if (input.piece) candidates.push(String(input.piece));
        if (input.slug) candidates.push(String(input.slug));
        candidates.push(String(id));
        const checked = [];
        for (const name of candidates) {
          const safeName = name.replace(/[^A-Za-z0-9._-]/g, '');
          if (!safeName) continue;
          const mdPath = path.join(storiesDir, safeName + '-STORY.md');
          const relPath = path.relative(eaRoot, mdPath);
          checked.push(relPath);
          if (mdPath.startsWith(storiesDir + path.sep) && fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
            const markdown = fs.readFileSync(mdPath, 'utf8');
            return sendJson(res, 200, { available: true, path: relPath, markdown });
          }
        }
        return sendJson(res, 200, {
          available: false,
          checkedPaths: checked,
          hint: 'Build it with: bin/run-story ' + id +
            (input.piece ? '   (or: bin/run-story --piece ' + JSON.stringify(input.slug) + ' ' + JSON.stringify(input.piece) + ')' : '') +
            (!input.piece && input.slug ? '   (or: bin/run-story --research ' + JSON.stringify(input.slug) + ')' : '')
        });
      }

      // POST /api/runs/:id/cancel
      if (seg.length === 3 && seg[2] === 'cancel' && method === 'POST') {
        const id = asInt(seg[1], 'run id');
        const run = callIf(db, 'getRun', id);
        if (!run) throw new ApiError(404, 'run_not_found', 'No run with id ' + id + '.');
        const status = val(run, 'status');
        if (['done', 'failed', 'cancelled'].includes(status)) {
          throw new ApiError(409, 'run_not_active', 'Run ' + id + ' already finished with status ' + status + '.');
        }
        if (typeof engine.cancelRun !== 'function') {
          throw new ApiError(503, 'engine_unavailable', 'The engine is not loaded, so nothing can be cancelled.');
        }
        await engine.cancelRun(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- the Claude bridge

    if (seg[0] === 'claude') {
      // GET /api/claude/next?claim=true
      if (seg.length === 2 && seg[1] === 'next' && method === 'GET') {
        const wantsClaim = ['true', '1', 'yes'].includes(String(url.searchParams.get('claim') || '').toLowerCase());
        let row = callIf(db, 'nextWaitingPrompt');
        // If the queue head belongs to a run that already ended, fall back to the
        // filtered list so a dead run cannot block the queue.
        if (row && !promptIsLive(row)) {
          const live = pendingPrompts();
          row = live.length ? callIf(db, 'getPrompt', live[0].id) || live[0] : null;
        }
        if (!row) return sendJson(res, 200, { prompt: null });
        if (wantsClaim) {
          const claimed = callIf(db, 'claimPrompt', val(row, 'id'));
          if (claimed && typeof claimed === 'object') row = claimed;
          else row = callIf(db, 'getPrompt', val(row, 'id')) || row;
          emit({ type: 'prompt.claimed', runId: Number(val(row, 'runId', 'run_id')), promptId: val(row, 'id') });
        }
        return sendJson(res, 200, { prompt: normPrompt(row) });
      }

      // GET /api/claude/pending
      if (seg.length === 2 && seg[1] === 'pending' && method === 'GET') {
        return sendJson(res, 200, { prompts: pendingPrompts() });
      }

      // POST /api/claude/answer   <- the heart of the product
      //
      // Two shapes. { promptId, answer } is the single one, unchanged, and the
      // CLI and the UI both use it. { answers: [ { promptId, answer }, ... ] }
      // is the batch: a loop over 50 leads parks 50 prompts, and answering
      // them one HTTP round trip at a time is slow and painful.
      if (seg.length === 2 && seg[1] === 'answer' && method === 'POST') {
        const body = await readJsonBody(req);

        if (body.answers !== undefined) {
          if (body.promptId !== undefined || body.answer !== undefined) {
            throw new ApiError(400, 'bad_answer',
              'Send either { promptId, answer } or { answers: [...] }, not both.');
          }
          return sendJson(res, 200, await answerMany(body.answers));
        }

        const promptId = asInt(body.promptId, 'promptId');
        const stored = storeAnswer(promptId, body.answer, body.actor);
        if (!stored.ok) {
          throw new ApiError(stored.status, stored.code, stored.message);
        }
        scheduleResume(stored.runId, promptId);
        return sendJson(res, 200, { ok: true, runId: stored.runId, resumed: true });
      }

      // POST /api/claude/fail
      if (seg.length === 2 && seg[1] === 'fail' && method === 'POST') {
        const body = await readJsonBody(req);
        const promptId = asInt(body.promptId, 'promptId');
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'No reason given.';
        const row = callIf(db, 'getPrompt', promptId);
        if (!row) throw new ApiError(404, 'prompt_not_found', 'No prompt with id ' + promptId + '.');
        const runId = Number(val(row, 'runId', 'run_id'));

        setPromptStatus(promptId, 'failed', reason);
        emit({ type: 'prompt.failed', runId, promptId, reason });

        // A parked run whose prompt failed would sit in waiting_on_claude for ever.
        // We fail the run too, so it never quietly hangs.
        failRun(runId, 'Prompt ' + promptId + ' could not be answered: ' + reason);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- storage
    //
    // GET /api/storage. data/out is never pruned, and it should not be:
    // deleting somebody's output on a timer is a good way to lose a client
    // report. So we make it visible instead, before it is a problem.
    if (seg.length === 1 && seg[0] === 'storage' && method === 'GET') {
      return sendJson(res, 200, storageReport());
    }

    // ---- node registry, for the UI form builder

    if (seg.length === 1 && seg[0] === 'nodes' && method === 'GET') {
      const list = nodeMeta(deps.nodes);
      if (list === null) {
        throw new ApiError(503, 'nodes_unavailable', 'The node registry is not loaded yet.');
      }
      return sendJson(res, 200, list);
    }

    throw new ApiError(404, 'not_found', 'No API route for ' + req.method + ' ' + url.pathname + '.');
  }

  /**
   * Set a prompt status directly.
   * db.js has no exported way to move a prompt back to waiting or on to failed, so we
   * use one if it appears, and fall back to a small statement on the open handle.
   */
  function setPromptStatus(promptId, status, reason) {
    if (typeof db.setPromptStatus === 'function') return db.setPromptStatus(promptId, status, reason);
    if (status === 'failed' && typeof db.failPrompt === 'function') return db.failPrompt(promptId, reason);
    if (status === 'waiting' && typeof db.requeuePrompt === 'function') return db.requeuePrompt(promptId);
    if (status === 'waiting' && typeof db.unclaimPrompt === 'function') return db.unclaimPrompt(promptId);
    const handle = deps.dbHandle;
    if (handle && typeof handle.prepare === 'function') {
      if (status === 'waiting') {
        return handle.prepare('UPDATE prompts SET status = ?, claimed_at = NULL WHERE id = ?').run(status, promptId);
      }
      return handle.prepare('UPDATE prompts SET status = ? WHERE id = ?').run(status, promptId);
    }
    return undefined;
  }

  /**
   * Put prompts stuck in claimed back into waiting.
   * Somebody claimed a prompt and then died, or closed the terminal. Ten minutes later
   * it goes back in the queue so the run is not stuck for ever.
   */
  function reapStaleClaims(staleMs = CLAIM_STALE_MS) {
    let freed = 0;
    let rows;
    // db.js has its own sweep in one statement. Use it when it is there, it is faster
    // and it does the whole table at once.
    if (typeof db.releaseStaleClaims === 'function') {
      try {
        const n = Number(db.releaseStaleClaims(staleMs / 60000)) || 0;
        if (n > 0) emit({ type: 'prompt.requeued', count: n });
        return n;
      } catch {
        // Fall through to the row by row version below.
      }
    }
    try {
      rows = callIf(db, 'listPrompts', { status: 'claimed' }) || [];
    } catch {
      return 0;
    }
    const cutoff = Date.now() - staleMs;
    for (const row of rows) {
      if (val(row, 'status') !== 'claimed') continue;
      const claimedAt = val(row, 'claimedAt', 'claimed_at');
      const at = claimedAt ? Date.parse(claimedAt) : 0;
      // A claimed row with no timestamp is treated as stale, otherwise it is stuck for ever.
      if (claimedAt && Number.isFinite(at) && at > cutoff) continue;
      try {
        setPromptStatus(val(row, 'id'), 'waiting');
        freed++;
        const runId = Number(val(row, 'runId', 'run_id'));
        record(runId, 'warn', 'Prompt ' + val(row, 'id') + ' was claimed and never answered, so it is back in the queue.');
        emit({ type: 'prompt.new', runId, promptId: val(row, 'id'), requeued: true });
      } catch {
        // Skip this row and try the next one on the following tick.
      }
    }
    return freed;
  }

  /** Wrap handle so every thrown error becomes a proper HTTP answer. */
  async function handleApi(req, res, url) {
    try {
      // The two locks come first, before any route can act on the request.
      // They cover reads too, because GET /api/claude/next?claim=true changes
      // state, and because no page has any business reading this API either.
      if (!originAllowed(req)) {
        return sendError(res, 403, 'bad_origin',
          'This API only answers its own page. The request came from ' + req.headers.origin + '.');
      }
      const ctProblem = contentTypeProblem(req);
      if (ctProblem) {
        return sendError(res, ctProblem[0], ctProblem[1], ctProblem[2]);
      }
      await handle(req, res, url);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ApiError) {
        return sendError(res, err.status, err.code, err.message);
      }
      const message = err && err.message ? err.message : 'Something went wrong.';
      // Log it here so a 500 is never silent on the server side either.
      console.error('[api] ' + req.method + ' ' + url.pathname + ' failed: ' + message);
      return sendError(res, 500, 'server_error', message);
    }
  }

  return {
    handleApi,
    reapStaleClaims,
    waitingPrompts,
    failRun,
    expireStalePrompts,
    trimOldEvents,
    stopSweepers
  };
}

/**
 * Turn whatever server/nodes/index.js exports into a flat list the UI can draw.
 * We accept a few shapes because that file belongs to another agent.
 */
export function nodeMeta(nodes) {
  if (!nodes) return null;
  let entries = null;
  if (typeof nodes.nodeMeta === 'function') entries = nodes.nodeMeta();
  else if (typeof nodes.listNodes === 'function') entries = nodes.listNodes();
  else if (nodes.nodes) entries = nodes.nodes;
  else if (nodes.registry) entries = nodes.registry;
  else if (nodes.default) entries = nodes.default;
  if (!entries) return null;

  const list = Array.isArray(entries) ? entries : Object.values(entries);
  return list
    .filter((n) => n && (n.type || n.meta))
    .map((n) => ({
      type: n.type ?? (n.meta && n.meta.type) ?? 'unknown',
      label: (n.meta && n.meta.label) ?? n.label ?? n.type,
      description: (n.meta && n.meta.description) ?? n.description ?? '',
      configSchema: (n.meta && n.meta.configSchema) ?? n.configSchema ?? {}
    }));
}

/** Start the reaper on a timer. Returns a stop function. */
export function startPromptReaper(api, { everyMs = 60_000, staleMs = CLAIM_STALE_MS } = {}) {
  const timer = setInterval(() => {
    try {
      const freed = api.reapStaleClaims(staleMs);
      if (freed > 0) console.log('[reaper] put ' + freed + ' stale prompt(s) back to waiting');
    } catch (err) {
      console.error('[reaper] failed: ' + (err && err.message ? err.message : err));
    }
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
