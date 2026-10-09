// ARTHA FLOW: the run executor.
//
// One step at a time, awaited, in process. No threads, no polling.
//
// The interesting part is parking. A claude node hands back
// { __park: true, promptId }. When that happens the engine writes its whole
// place in the run into runs.cursor as JSON, sets the run to
// waiting_on_claude, and returns. Nothing is left running. Minutes or days
// later, resumeRun rebuilds that exact state from the cursor and carries on at
// the same node, with the same step outputs and the same loop position, so a
// run that parked finishes with the same result as one that never did.
//
// The cursor holds:
//   steps      every finished step output so far, keyed by node id
//   stack      the frame stack, one frame for the main chain plus one per
//              each loop, each frame holding where it is up to
//   stepCount  the guard against a bad next loop spinning forever
//   park       which node parked, which prompt it is waiting on, and the step
//              row to carry on writing into

import { render, RenderError } from './render.js';
import { getNode, hasNode } from './nodes/index.js';
import * as db from './db.js';

export const MAX_STEPS = 500;
const CURSOR_VERSION = 1;
const ENDED = new Set(['done', 'failed', 'cancelled']);
// Both parked states. One waits for a person or for Claude, the other waits
// for a clock. Resume treats them the same way, because the cursor is the same
// cursor. Only the reason for stopping is different.
const PARKED = new Set(['waiting_on_claude', 'waiting_on_timer']);

// ---------------------------------------------------------------------------
// events out
// ---------------------------------------------------------------------------

const listeners = new Set();

/** Register a handler for engine events. Returns a function that removes it. */
export function onEvent(handler) {
  if (typeof handler !== 'function') throw new Error('onEvent needs a function');
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function offEvent(handler) {
  listeners.delete(handler);
}

// Event types are fixed by the contract:
// run.started, run.finished, run.failed, run.waiting, run.resumed,
// run.cancelled, step.started, step.finished, step.failed, log, prompt.new,
// prompt.answered.
function emit(evt) {
  try {
    persistEvent(evt);
  } catch (err) {
    // Never let bookkeeping kill a run.
    console.error('[flow] could not save event:', err.message);
  }
  for (const handler of listeners) {
    try {
      handler(evt);
    } catch (err) {
      // A broken websocket must not take the run down with it.
      console.error('[flow] event listener failed:', err.message);
    }
  }
}

// The live feed carries the full payload. The saved copy is trimmed, because a
// step output can be large and the events table is for reading back, not for
// storing results twice.
function persistEvent(evt) {
  if (evt.type === 'log') return; // already written by logLine
  const trimmed = { ...evt };
  delete trimmed.output;
  delete trimmed.config;
  delete trimmed.prompt;
  delete trimmed.system;
  db.addEvent({
    runId: evt.runId ?? null,
    level: evt.type === 'run.failed' || evt.type === 'step.failed' ? 'error' : 'info',
    message: evt.type,
    data: trimmed
  });
}

function logLine(state, level, message, data) {
  const safeLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
  db.addEvent({ runId: state.runId, level: safeLevel, message: String(message), data: data ?? null });
  emit({ type: 'log', runId: state.runId, level: safeLevel, message: String(message), data: data ?? null });
}

// ---------------------------------------------------------------------------
// runs currently moving, so two callers cannot drive the same run at once
// ---------------------------------------------------------------------------

const active = new Map(); // runId -> AbortController

export function isActive(runId) {
  return active.has(Number(runId));
}

// ---------------------------------------------------------------------------
// the run lock, which works across processes
// ---------------------------------------------------------------------------
//
// The Map above only guards this process. Two servers on the same flow.db
// would both see a parked run, both resume it, and every step after the park
// would happen twice. The real guard is a lock column on the run, taken with
// one conditional UPDATE, so only one caller can win.
//
// The owner id is per process. It has to be unique and it must not leak
// anything, so it is the pid plus a random string, never a path or a user name.

export const OWNER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
export const LOCK_TTL_MS = 5 * 60 * 1000;

/** Take the lock on a run. False means somebody else is already driving it. */
function takeLock(runId) {
  try {
    return db.acquireRunLock(runId, OWNER_ID, LOCK_TTL_MS);
  } catch (err) {
    // An older database without the lock columns must not stop work. The in
    // memory Map is still there as the single process guard.
    console.error('[flow] could not take the run lock:', err.message);
    return true;
  }
}

/** Push the expiry out. A long run must not have its lock time out under it. */
function keepLock(state) {
  const now = Date.now();
  if (state.lockRenewedAt && now - state.lockRenewedAt < LOCK_TTL_MS / 3) return;
  state.lockRenewedAt = now;
  try {
    db.renewRunLock(state.runId, OWNER_ID, LOCK_TTL_MS);
  } catch {
    // Not fatal. The lock expiring only lets somebody else pick the run up.
  }
}

function releaseLock(state) {
  try {
    db.releaseRunLock(state.runId, OWNER_ID);
  } catch {
    // Nothing to do. The lock expires on its own.
  }
}

// ---------------------------------------------------------------------------
// workflow checks
// ---------------------------------------------------------------------------

/**
 * Read a workflow definition and list what is wrong with it.
 * Empty array means it is fine. Catching a dangling "next" here is much kinder
 * than finding it halfway through a run.
 */
export function validateWorkflow(def, slug = '') {
  const problems = validateOne(def, slug);
  // A sub node call graph is checked before the run starts, so a workflow that
  // calls itself fails at the door and not halfway through.
  if (!problems.length) checkSubGraph(def, slug, [slug || ''], problems, 0);
  return problems;
}

function validateOne(def, slug = '') {
  const problems = [];
  const where = slug ? ` in workflow "${slug}"` : '';
  if (!def || typeof def !== 'object') return [`Workflow${where} is not an object.`];
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) return [`Workflow${where} has no nodes.`];

  const ids = new Set();
  for (const node of def.nodes) {
    if (!node || typeof node !== 'object') { problems.push(`A node${where} is not an object.`); continue; }
    if (!node.id) { problems.push(`A node${where} has no id.`); continue; }
    if (ids.has(node.id)) problems.push(`Node id "${node.id}"${where} is used more than once.`);
    ids.add(node.id);
    if (!node.type) problems.push(`Node "${node.id}"${where} has no type.`);
    else if (!hasNode(node.type)) problems.push(`Unknown node type "${node.type}" (node "${node.id}")${where}.`);
  }
  for (const node of def.nodes) {
    if (!node || !node.id) continue;
    for (const key of ['next', 'elseNext']) {
      const target = node[key];
      if (target !== undefined && target !== null && !ids.has(target)) {
        problems.push(`Node "${node.id}"${where} points ${key} at "${target}", which does not exist.`);
      }
    }
    if (node.type === 'each') {
      const body = node.config && node.config.body;
      if (!body) problems.push(`each node "${node.id}"${where} has no body node id.`);
      else if (!ids.has(body)) problems.push(`each node "${node.id}"${where} has body "${body}", which does not exist.`);
    }
    if (node.type === 'parallel') {
      const branches = node.config && node.config.branches;
      if (!Array.isArray(branches) || !branches.length) {
        problems.push(`parallel node "${node.id}"${where} has no branches.`);
      } else {
        const sections = new Set();
        for (const b of branches) {
          const body = b && b.body;
          if (!body) problems.push(`parallel node "${node.id}"${where} has a branch with no body node id.`);
          else if (!ids.has(body)) problems.push(`parallel node "${node.id}"${where} has a branch with body "${body}", which does not exist.`);
          if (b && b.section) {
            if (sections.has(b.section)) problems.push(`parallel node "${node.id}"${where} claims section "${b.section}" in more than one branch.`);
            sections.add(b.section);
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Walk the sub node call graph and report loops, missing workflows, and
 * chains that go too deep.
 *
 * Only literal slugs are followed. A slug that is still a template cannot be
 * known until the run reaches it, so that one is caught at run time by the sub
 * node instead, which has the same check with the live chain.
 */
function checkSubGraph(def, slug, chain, problems, depth) {
  if (!def || !Array.isArray(def.nodes)) return;
  for (const node of def.nodes) {
    if (!node || node.type !== 'sub') continue;
    const target = node.config && node.config.slug;
    if (typeof target !== 'string' || target.includes('{{') || !target.trim()) continue;
    const name = target.trim();

    if (chain.includes(name)) {
      problems.push(
        `sub node "${node.id}" in workflow "${slug}" makes a loop: ${[...chain, name].join(' -> ')}. ` +
        'A workflow cannot call itself, directly or through another one.'
      );
      continue;
    }
    if (depth + 1 > MAX_SUB_DEPTH) {
      problems.push(
        `sub node "${node.id}" in workflow "${slug}" goes more than ${MAX_SUB_DEPTH} workflows deep: ` +
        `${[...chain, name].join(' -> ')}.`
      );
      continue;
    }

    let child;
    try {
      child = db.getWorkflowBySlug(name);
    } catch {
      child = null;
    }
    if (!child) {
      problems.push(`sub node "${node.id}" in workflow "${slug}" calls "${name}", which is not in the database.`);
      continue;
    }
    for (const p of validateOne(child.definition, name)) problems.push(p);
    checkSubGraph(child.definition, name, [...chain, name], problems, depth + 1);
  }
}

function startNode(def) {
  return def.nodes.find((n) => n.start === true) || def.nodes[0];
}

function nodeById(def, id) {
  return def.nodes.find((n) => n.id === id) || null;
}

// ---------------------------------------------------------------------------
// which workflow and which variables the frame on top is working with
// ---------------------------------------------------------------------------
//
// A sub frame brings its own workflow definition and its own { input, steps }.
// An each frame brings neither, so it borrows from whatever encloses it. Both
// helpers walk the stack from the top and take the first frame that has one.
// The main chain is the fallback, which is why an old cursor with no sub
// frames in it behaves exactly as it did before.

export const MAX_SUB_DEPTH = 5;

function currentDef(state) {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const slug = state.stack[i].defSlug;
    if (!slug) continue;
    if (slug === state.slug) return state.def;
    const cached = state.defs.get(slug);
    if (cached) return cached;
    const wf = db.getWorkflowBySlug(slug);
    if (!wf) throw new Error(`Workflow "${slug}" is gone, so this run cannot carry on.`);
    state.defs.set(slug, wf.definition);
    return wf.definition;
  }
  return state.def;
}

/** The slug of the workflow the top frame belongs to. */
function frameDefSlug(state) {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    if (state.stack[i].defSlug) return state.stack[i].defSlug;
  }
  return state.slug;
}

function currentScope(state) {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    if (state.stack[i].scope) return state.stack[i].scope;
  }
  return { input: state.input, steps: state.steps };
}

/** [top level slug, ...every sub workflow we are inside right now]. */
function subChain(state) {
  const chain = [state.slug];
  for (const frame of state.stack) {
    if (frame.kind === 'sub' && frame.defSlug) chain.push(frame.defSlug);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// state, and how it turns into a cursor and back
// ---------------------------------------------------------------------------

function newState(runRow, def) {
  const controller = new AbortController();
  return {
    runId: runRow.id,
    slug: runRow.slug,
    def,
    input: runRow.input ?? {},
    run: { id: runRow.id, slug: runRow.slug, startedAt: runRow.startedAt },
    steps: {},
    stack: [{ kind: 'main', defSlug: runRow.slug, cur: startNode(def).id }],
    stepCount: 0,
    defs: new Map(),
    park: null,
    resume: null,
    controller,
    signal: controller.signal
  };
}

function toCursor(state) {
  return {
    v: CURSOR_VERSION,
    steps: state.steps,
    stack: state.stack,
    stepCount: state.stepCount,
    park: state.park
  };
}

function fromCursor(runRow, def, cursor) {
  const controller = new AbortController();
  if (!cursor || cursor.v !== CURSOR_VERSION || !Array.isArray(cursor.stack)) {
    throw new Error(`Run ${runRow.id} has no usable resume state in its cursor.`);
  }
  return {
    runId: runRow.id,
    slug: runRow.slug,
    def,
    input: runRow.input ?? {},
    run: { id: runRow.id, slug: runRow.slug, startedAt: runRow.startedAt },
    steps: cursor.steps ?? {},
    stack: cursor.stack,
    stepCount: cursor.stepCount ?? 0,
    // Workflow definitions are looked up again on resume, never stored in the
    // cursor. The cursor keeps slugs, which stay small and stay current.
    defs: new Map(),
    park: null,
    resume: cursor.park ? { ...cursor.park } : null,
    controller,
    signal: controller.signal
  };
}

function innermostEach(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === 'each') return stack[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// finishing
// ---------------------------------------------------------------------------

function finishRun(state, status, error = null) {
  db.updateRun(state.runId, { status, error, endedAt: db.nowIso(), cursor: null, wakeAt: null });
  releaseLock(state);
  active.delete(state.runId);
  const type = status === 'done' ? 'run.finished' : status === 'cancelled' ? 'run.cancelled' : 'run.failed';
  emit({ type, runId: state.runId, slug: state.slug, status, error });
  return status;
}

function failRun(state, message, nodeId = null) {
  logLine(state, 'error', message, nodeId ? { nodeId } : null);
  return finishRun(state, 'failed', message);
}

// ---------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------

async function execute(state) {
  active.set(state.runId, state.controller);
  try {
    return await loop(state);
  } catch (err) {
    // An error this far out is an engine or database problem, not a node
    // problem. It still ends the run loudly.
    try {
      return failRun(state, `Engine error: ${err.message}`);
    } catch {
      active.delete(state.runId);
      return 'failed';
    }
  } finally {
    if (db.getRun(state.runId)?.status !== 'running') active.delete(state.runId);
  }
}

async function loop(state) {
  while (true) {
    if (state.signal.aborted) {
      return finishRun(state, 'cancelled', 'Run was cancelled.');
    }

    // Hold on to the lock while we work, so a long run does not have it time
    // out and get picked up by somebody else halfway through.
    keepLock(state);

    const frame = state.stack[state.stack.length - 1];
    if (!frame) return finishRun(state, 'done', null);

    // ---- a parallel frame: several branches, advanced together ----------
    // Additive only. Every other frame kind (main, sub, each) never has
    // kind === 'parallel', so a workflow that never uses a parallel node
    // never reaches this branch at all, and behaves exactly as it did before
    // this code existed.
    if (frame.kind === 'parallel') {
      const result = await advanceParallelFrame(state, frame);
      if (result.status === 'cancelled') {
        return finishRun(state, 'cancelled', 'Run was cancelled.');
      }
      if (result.status === 'failed') {
        return failRun(state, result.message, frame.nodeId);
      }
      if (result.status === 'park') {
        db.updateRun(state.runId, { status: 'waiting_on_claude', cursor: toCursor(state) });
        releaseLock(state);
        active.delete(state.runId);
        emit({
          type: 'run.waiting',
          runId: state.runId,
          slug: state.slug,
          nodeId: frame.nodeId,
          promptId: result.promptIds[0] ?? null,
          promptIds: result.promptIds,
          reason: 'claude'
        });
        return 'waiting_on_claude';
      }
      continue; // result.status === 'continue': the frame progressed or closed
    }

    // ---- a frame with nowhere left to go --------------------------------
    if (frame.cur === null || frame.cur === undefined) {
      if (frame.kind === 'main') {
        state.stack.pop();
        continue;
      }
      if (frame.kind === 'sub') {
        // The child workflow reached the end of its chain. Close it and carry
        // on in the parent at whatever the sub node points at.
        closeSubFrame(state, frame, 'done');
        continue;
      }
      // One pass of an each loop just ended.
      frame.results.push(frame.lastOutput === undefined ? null : frame.lastOutput);
      frame.index += 1;
      frame.lastOutput = null;
      if (frame.index < frame.items.length) {
        frame.cur = frame.body;
        continue;
      }
      closeLoopFrame(state, frame, 'done');
      continue;
    }

    // ---- run one node ----------------------------------------------------
    let def;
    try {
      def = currentDef(state);
    } catch (err) {
      return failRun(state, err.message, frame.cur);
    }
    const defSlug = frameDefSlug(state);
    const node = nodeById(def, frame.cur);
    if (!node) {
      return failRun(state, `Node "${frame.cur}" is not in workflow "${defSlug}".`, frame.cur);
    }

    state.stepCount += 1;
    if (state.stepCount > MAX_STEPS) {
      return failRun(
        state,
        `Run hit the ${MAX_STEPS} step limit at node "${node.id}". Check for a next that loops back on itself.`,
        node.id
      );
    }

    let mod;
    try {
      mod = getNode(node.type, node.id);
    } catch (err) {
      return failRun(state, err.message, node.id);
    }

    const enclosing = innermostEach(state.stack);
    const iteration = enclosing ? enclosing.index : null;

    // Is this the node we parked on? If so, reuse its step row and hand the
    // node the prompt id so it can read the answer.
    const myResume = state.resume && state.resume.nodeId === node.id ? state.resume : null;
    state.resume = null;

    let stepId = myResume && myResume.stepId ? myResume.stepId : null;
    if (stepId) {
      db.updateStep(stepId, { status: 'running' });
    } else {
      const step = db.createStep({
        runId: state.runId,
        nodeId: node.id,
        nodeType: node.type,
        name: node.name ?? null,
        iteration,
        status: 'running'
      });
      stepId = step.id;
      emit({
        type: 'step.started',
        runId: state.runId,
        stepId,
        nodeId: node.id,
        nodeType: node.type,
        name: node.name ?? null,
        iteration
      });
    }

    // ---- render the config ----------------------------------------------
    const scope = currentScope(state);
    const renderCtx = {
      input: scope.input,
      run: state.run,
      steps: scope.steps
    };
    if (enclosing) {
      renderCtx.item = enclosing.items[enclosing.index];
      renderCtx.index = enclosing.index;
    }

    let config;
    try {
      config = render(node.config ?? {}, renderCtx);
    } catch (err) {
      const message = err instanceof RenderError
        ? `Node "${node.id}" (${node.type}): ${err.message}`
        : `Node "${node.id}" (${node.type}): config could not be rendered: ${err.message}`;
      const handled = handleStepFailure(state, stepId, node, iteration, message);
      if (handled === 'stop') return finishRun(state, 'failed', message);
      continue;
    }
    db.updateStep(stepId, { input: config });

    // ---- build the node context -----------------------------------------
    const chain = subChain(state);
    const ctx = {
      node,
      config,
      input: scope.input,
      run: state.run,
      steps: scope.steps,
      // Where this node sits in the workflow call chain. The sub node reads
      // these to refuse a loop and to hold the depth limit.
      subChain: chain,
      subDepth: chain.length - 1,
      workflowSlug: defSlug,
      item: renderCtx.item,
      index: renderCtx.index,
      iteration,
      stepId,
      resume: myResume,
      log: (level, message, data) => logLine(state, level, message, { nodeId: node.id, ...(data ?? {}) }),
      emit: (type, payload = {}) => emit({ type, runId: state.runId, nodeId: node.id, stepId, ...payload }),
      signal: state.signal
    };

    let output;
    try {
      output = await mod.run(ctx);
    } catch (err) {
      const message = `Node "${node.id}" (${node.type}) failed: ${err.message}`;
      if (state.signal.aborted) {
        db.updateStep(stepId, { status: 'failed', error: 'Run was cancelled.', endedAt: db.nowIso() });
        return finishRun(state, 'cancelled', 'Run was cancelled.');
      }
      const handled = handleStepFailure(state, stepId, node, iteration, message);
      if (handled === 'stop') return finishRun(state, 'failed', message);
      continue;
    }

    if (state.signal.aborted) {
      db.updateStep(stepId, { status: 'failed', error: 'Run was cancelled.', endedAt: db.nowIso() });
      return finishRun(state, 'cancelled', 'Run was cancelled.');
    }

    // ---- park: the claude node asked to wait -----------------------------
    if (output && output.__park === true) {
      let parkStepId = stepId;
      if (output.error) {
        // The answer came back wrong, for example JSON that will not parse.
        // The step is marked failed, the prompt went back in the queue, and
        // the run waits again. The resume makes a fresh step row.
        db.updateStep(stepId, { status: 'failed', error: output.error, endedAt: db.nowIso() });
        emit({ type: 'step.failed', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration, error: output.error });
        parkStepId = null;
      }
      state.park = { nodeId: node.id, promptId: output.promptId, stepId: parkStepId };
      // frame.cur stays on this node, so the resume runs it again.
      db.updateRun(state.runId, { status: 'waiting_on_claude', cursor: toCursor(state) });
      releaseLock(state);
      active.delete(state.runId);
      emit({
        type: 'run.waiting',
        runId: state.runId,
        slug: state.slug,
        nodeId: node.id,
        promptId: output.promptId,
        reason: 'claude'
      });
      return 'waiting_on_claude';
    }

    // ---- park on a clock: the wait node asked for time --------------------
    if (output && output.__wait === true) {
      state.park = {
        nodeId: node.id,
        stepId,
        wakeAt: output.wakeAt,
        seconds: output.seconds ?? null
      };
      // frame.cur stays on this node, so the resume runs it again and the node
      // sees ctx.resume.wakeAt and returns instead of parking a second time.
      db.updateRun(state.runId, {
        status: 'waiting_on_timer',
        cursor: toCursor(state),
        wakeAt: output.wakeAt
      });
      releaseLock(state);
      active.delete(state.runId);
      emit({
        type: 'run.waiting',
        runId: state.runId,
        slug: state.slug,
        nodeId: node.id,
        wakeAt: output.wakeAt,
        seconds: output.seconds ?? null,
        reason: 'timer'
      });
      return 'waiting_on_timer';
    }

    // ---- each: open a loop frame -----------------------------------------
    if (output && output.__each === true) {
      if (!output.items.length) {
        const empty = { count: 0, results: [] };
        finishStep(state, stepId, node, iteration, empty);
        scope.steps[node.id] = { output: empty };
        if (frame.kind === 'each' || frame.kind === 'sub') frame.lastOutput = empty;
        frame.cur = node.next ?? null;
        continue;
      }
      state.stack.push({
        kind: 'each',
        nodeId: node.id,
        stepId,
        items: output.items,
        index: 0,
        results: [],
        body: output.body,
        next: node.next ?? null,
        stopOnError: Boolean(output.stopOnError),
        cur: output.body,
        lastOutput: null
      });
      continue;
    }

    // ---- sub: run another workflow inside this one -----------------------
    //
    // The child goes on the same stack as an each loop, with two extras: its
    // own workflow slug and its own { input, steps }. Everything else, park,
    // resume, cancel, the step limit, works on it unchanged, which is exactly
    // why a claude node deep inside a child resumes with no special code.
    if (output && output.__sub === true) {
      let childDef;
      try {
        const wf = db.getWorkflowBySlug(output.slug);
        if (!wf) throw new Error(`Workflow "${output.slug}" was not found.`);
        childDef = wf.definition;
        const problems = validateOne(childDef, output.slug);
        if (problems.length) {
          throw new Error(`Workflow "${output.slug}" is not valid:\n  ` + problems.join('\n  '));
        }
      } catch (err) {
        const message = `Node "${node.id}" (sub) failed: ${err.message}`;
        const handled = handleStepFailure(state, stepId, node, iteration, message);
        if (handled === 'stop') return finishRun(state, 'failed', message);
        continue;
      }
      state.defs.set(output.slug, childDef);
      state.stack.push({
        kind: 'sub',
        nodeId: node.id,
        stepId,
        defSlug: output.slug,
        scope: { input: output.input ?? {}, steps: {} },
        next: node.next ?? null,
        cur: startNode(childDef).id,
        lastOutput: null
      });
      logLine(state, 'info', `Entered workflow "${output.slug}" from node "${node.id}".`, { nodeId: node.id });
      continue;
    }

    // ---- parallel: open a batch of independent, claim-gated branches ----
    //
    // FORGE.md section 3: the craft departments (step 6), the gates (step 7),
    // and the publish block (step 10) are the three stages that qualify.
    // Pushing a frame here, instead of running the branches inline, is what
    // lets a claude node deep inside one branch park just that branch: the
    // rest of the batch keeps moving in the same pass, exactly like a claude
    // node inside a sub workflow already parks only its own place in the
    // stack.
    if (output && output.__parallel === true) {
      // Register every section the moment the batch is dispatched (FORGE.md
      // 1.1, "created the moment a piece enters the pipeline"). Safe to
      // repeat on a resume: ensureForgeClaim never overwrites an existing row.
      for (const b of output.branches) {
        db.ensureForgeClaim({ pieceId: output.pieceId, section: b.section, agent: b.agent });
      }
      state.stack.push({
        kind: 'parallel',
        nodeId: node.id,
        stepId,
        pieceId: output.pieceId,
        next: node.next ?? null,
        // false is the FORGE off switch (parallel.js's own "parallel" config
        // flag): branches run one at a time, in array order, each fully
        // settling before the next is even attempted. Same claim-gated code
        // path either way, only the fan out is turned off.
        sequential: output.parallel === false,
        branches: output.branches.map((b) => ({
          id: b.id,
          section: b.section,
          agent: b.agent,
          hardReads: b.hardReads || [],
          softReads: b.softReads || [],
          body: b.body,
          cur: b.body,
          status: 'blocked', // blocked -> running -> parked -> done | failed
          claimed: false,
          waitingOn: null,
          lastOutput: null,
          stepId: null,
          promptId: null
        })),
        lastOutput: null
      });
      logLine(state, 'info', `Opened parallel batch "${node.id}": ${output.branches.length} branch(es).`, { nodeId: node.id });
      continue;
    }

    // ---- normal output ---------------------------------------------------
    const value = output === undefined ? null : output;
    finishStep(state, stepId, node, iteration, value);
    scope.steps[node.id] = { output: value };
    if (frame.kind === 'each' || frame.kind === 'sub') frame.lastOutput = value;

    if (node.type === 'filter') {
      frame.cur = value && value.passed ? (node.next ?? null) : (node.elseNext ?? null);
    } else {
      frame.cur = node.next ?? null;
    }
  }
}

function finishStep(state, stepId, node, iteration, output) {
  db.updateStep(stepId, { status: 'done', output, endedAt: db.nowIso() });
  emit({
    type: 'step.finished',
    runId: state.runId,
    stepId,
    nodeId: node.id,
    nodeType: node.type,
    iteration,
    output
  });
}

/**
 * A step threw. Mark it failed, then work out whether the run stops.
 *
 * Walk the frame stack from the top down. The first each loop with
 * stopOnError false swallows the error: that item gets an error result and the
 * loop moves to the next one. An each loop with stopOnError true passes the
 * error up to whatever encloses it. If nothing catches it, the run fails.
 *
 * Returns 'continue' or 'stop'.
 */
function handleStepFailure(state, stepId, node, iteration, message) {
  db.updateStep(stepId, { status: 'failed', error: message, endedAt: db.nowIso() });
  emit({
    type: 'step.failed',
    runId: state.runId,
    stepId,
    nodeId: node.id,
    nodeType: node.type,
    iteration,
    error: message
  });
  logLine(state, 'error', message, { nodeId: node.id });

  while (state.stack.length) {
    const frame = state.stack[state.stack.length - 1];
    if (frame.kind === 'sub') {
      // A child workflow that failed makes its sub node fail too. The error
      // keeps rising, so an each loop above it can still swallow it.
      closeSubFrame(state, frame, 'failed', message);
      continue;
    }
    if (frame.kind !== 'each') break;
    if (!frame.stopOnError) {
      frame.lastOutput = { error: message, nodeId: node.id };
      frame.cur = null; // ends this pass, the main loop moves to the next item
      return 'continue';
    }
    // This loop wants to stop. Close it as failed and let the error rise.
    closeLoopFrame(state, frame, 'failed', message);
  }
  return 'stop';
}

/** Pop an each frame, write its step row, and point the parent at what is next. */
function closeLoopFrame(state, frame, status, error = null) {
  state.stack.pop();
  const output = { count: frame.results.length, results: frame.results };
  db.updateStep(frame.stepId, {
    status: status === 'failed' ? 'failed' : 'done',
    output,
    error,
    endedAt: db.nowIso()
  });
  currentScope(state).steps[frame.nodeId] = { output };
  emit({
    type: status === 'failed' ? 'step.failed' : 'step.finished',
    runId: state.runId,
    stepId: frame.stepId,
    nodeId: frame.nodeId,
    nodeType: 'each',
    output,
    error
  });
  if (status === 'failed') return;
  const parent = state.stack[state.stack.length - 1];
  if (parent) {
    parent.cur = frame.next ?? null;
    if (parent.kind === 'each' || parent.kind === 'sub') parent.lastOutput = output;
  }
}

/**
 * Pop a sub frame, write the sub node's step row, and put the result where the
 * parent can reach it.
 *
 * The output is { slug, output, steps }. `output` is the last thing the child
 * did, which is the usual thing a caller wants, and `steps` is every step the
 * child ran, so a parent can reach deeper with
 * {{ steps.s1.output.steps.n2.output.text }}.
 */
function closeSubFrame(state, frame, status, error = null) {
  state.stack.pop();
  const output = {
    slug: frame.defSlug,
    output: frame.lastOutput === undefined ? null : frame.lastOutput,
    steps: frame.scope ? frame.scope.steps : {}
  };
  db.updateStep(frame.stepId, {
    status: status === 'failed' ? 'failed' : 'done',
    output,
    error,
    endedAt: db.nowIso()
  });
  currentScope(state).steps[frame.nodeId] = { output };
  emit({
    type: status === 'failed' ? 'step.failed' : 'step.finished',
    runId: state.runId,
    stepId: frame.stepId,
    nodeId: frame.nodeId,
    nodeType: 'sub',
    output,
    error
  });
  if (status === 'failed') return;
  const parent = state.stack[state.stack.length - 1];
  if (parent) {
    parent.cur = frame.next ?? null;
    if (parent.kind === 'each' || parent.kind === 'sub') parent.lastOutput = output;
  }
}

// ---------------------------------------------------------------------------
// the parallel frame: FORGE's dispatcher rule
// ---------------------------------------------------------------------------
//
// This is a sibling to closeLoopFrame and closeSubFrame, not a rewrite of the
// main loop above. It has its own, deliberately duplicated, small version of
// "run one node": rendering config, creating or reusing a step row, building
// ctx, calling mod.run, handling a park. Sharing that code with the main loop
// was possible but not worth the risk: the main loop is what runs 10, 11, 12,
// 15, 16, 17, 18, and 19 already proved correct, and this file must not
// change what they do. A few dozen duplicated lines here is a smaller risk
// than threading a new branch through code that already works.
//
// A branch body may only be a straight chain of ordinary nodes, ending in a
// null next, optionally with one filter for a plain yes/no fork. It may not
// contain an each, sub, or wait node. FORGE.md section 7 names this directly:
// build the second real shape only once a second real shape needs it. Craft
// departments, gates, and the publish block are all short, linear chains
// today, so this covers the one shape that exists.

async function advanceParallelFrame(state, frame) {
  const def = currentDef(state);
  const defSlug = frameDefSlug(state);
  const scope = currentScope(state);

  let progressed = true;
  while (progressed) {
    progressed = false;
    if (state.signal.aborted) return { status: 'cancelled' };

    let sequentialSlotTaken = false;
    for (const branch of frame.branches) {
      if (branch.status === 'done' || branch.status === 'failed') continue;

      // Sequential mode (parallel.js's "parallel" config set to false, the
      // FORGE off switch): only the first not-yet-finished branch, in array
      // order, is ever touched in a pass. Every later branch is left
      // completely alone, not even claim-attempted, until that one finishes.
      // This reproduces a hand written chain's order and outcome exactly,
      // through the same claim-gated code path used for real parallel batches.
      if (frame.sequential) {
        if (sequentialSlotTaken) continue;
        sequentialSlotTaken = true;
      }

      let resumeInfo = null;

      if (branch.status === 'parked') {
        const prompt = db.getPrompt(branch.promptId);
        if (!prompt || prompt.status !== 'answered') continue; // still waiting on this one prompt
        resumeInfo = { nodeId: branch.cur, promptId: branch.promptId, stepId: branch.stepId };
      } else if (!branch.claimed) {
        // The one atomic check-and-claim, FORGE.md section 2.1. Everything
        // this branch needs to know, hard deps settled or not, and whether
        // somebody already owns this section, comes back from one BEGIN
        // IMMEDIATE transaction in db.js. Nothing here reads and then writes
        // as two separate steps.
        const claimResult = db.tryClaimSection({
          pieceId: frame.pieceId,
          section: branch.section,
          agent: branch.agent,
          hardReads: branch.hardReads
        });
        if (!claimResult.ok) {
          if (claimResult.reason === 'already_claimed' && claimResult.claim && claimResult.claim.agent === branch.agent) {
            // A resume re-entering after a crash: this branch already holds
            // the claim from an earlier pass. Fall through and keep running.
          } else if (claimResult.reason === 'waiting_on_deps') {
            branch.status = 'blocked';
            branch.waitingOn = claimResult.waitingOn;
            continue;
          } else {
            branch.status = 'failed';
            branch.lastOutput = { error: `branch "${branch.id}" (${branch.section}) could not claim: ${claimResult.reason}` };
            logLine(state, 'error', `Parallel branch "${branch.id}" (${branch.section}) refused: ${claimResult.reason}.`, { nodeId: frame.nodeId });
            progressed = true;
            continue;
          }
        }
        branch.claimed = true;
        branch.status = 'running';
      }

      const node = nodeById(def, branch.cur);
      if (!node) {
        branch.status = 'failed';
        branch.lastOutput = { error: `branch "${branch.id}": node "${branch.cur}" is not in workflow "${defSlug}"` };
        progressed = true;
        continue;
      }

      state.stepCount += 1;
      if (state.stepCount > MAX_STEPS) {
        return {
          status: 'failed',
          message: `Run hit the ${MAX_STEPS} step limit inside parallel node "${frame.nodeId}", branch "${branch.id}".`
        };
      }

      let mod;
      try {
        mod = getNode(node.type, node.id);
      } catch (err) {
        branch.status = 'failed';
        branch.lastOutput = { error: err.message };
        progressed = true;
        continue;
      }

      let stepId = resumeInfo && branch.stepId ? branch.stepId : null;
      if (stepId) {
        db.updateStep(stepId, { status: 'running' });
      } else {
        const step = db.createStep({
          runId: state.runId,
          nodeId: node.id,
          nodeType: node.type,
          name: node.name ?? null,
          iteration: null,
          status: 'running'
        });
        stepId = step.id;
        emit({
          type: 'step.started',
          runId: state.runId,
          stepId,
          nodeId: node.id,
          nodeType: node.type,
          name: node.name ?? null,
          iteration: null
        });
      }
      branch.stepId = stepId;

      const renderCtx = { input: scope.input, run: state.run, steps: scope.steps };
      let config;
      try {
        config = render(node.config ?? {}, renderCtx);
      } catch (err) {
        const message = err instanceof RenderError
          ? `Node "${node.id}" (${node.type}): ${err.message}`
          : `Node "${node.id}" (${node.type}): config could not be rendered: ${err.message}`;
        db.updateStep(stepId, { status: 'failed', error: message, endedAt: db.nowIso() });
        emit({ type: 'step.failed', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration: null, error: message });
        branch.status = 'failed';
        branch.lastOutput = { error: message };
        progressed = true;
        continue;
      }
      db.updateStep(stepId, { input: config });

      const chain = subChain(state);
      const ctx = {
        node,
        config,
        input: scope.input,
        run: state.run,
        steps: scope.steps,
        subChain: chain,
        subDepth: chain.length - 1,
        workflowSlug: defSlug,
        item: undefined,
        index: undefined,
        iteration: null,
        stepId,
        resume: resumeInfo,
        log: (level, message, data) => logLine(state, level, message, { nodeId: node.id, branch: branch.id, ...(data ?? {}) }),
        emit: (type, payload = {}) => emit({ type, runId: state.runId, nodeId: node.id, stepId, ...payload }),
        signal: state.signal
      };

      let output;
      try {
        output = await mod.run(ctx);
      } catch (err) {
        if (state.signal.aborted) return { status: 'cancelled' };
        const message = `Node "${node.id}" (${node.type}) failed: ${err.message}`;
        db.updateStep(stepId, { status: 'failed', error: message, endedAt: db.nowIso() });
        emit({ type: 'step.failed', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration: null, error: message });
        logLine(state, 'error', message, { nodeId: node.id });
        branch.status = 'failed';
        branch.lastOutput = { error: message };
        progressed = true;
        continue;
      }

      if (state.signal.aborted) return { status: 'cancelled' };

      // A claude node inside a branch parks the branch, not the whole run.
      // Every other branch keeps moving in this same pass.
      if (output && output.__park === true) {
        if (output.error) {
          db.updateStep(stepId, { status: 'failed', error: output.error, endedAt: db.nowIso() });
          emit({ type: 'step.failed', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration: null, error: output.error });
        }
        branch.status = 'parked';
        branch.promptId = output.promptId;
        progressed = true;
        continue; // branch.cur is unchanged, so the resume re-runs this same node
      }

      if (output && (output.__each === true || output.__sub === true || output.__wait === true)) {
        const message = `branch "${branch.id}" at node "${node.id}": an each, sub, or wait node is not supported inside a parallel branch yet (FORGE.md section 7).`;
        db.updateStep(stepId, { status: 'failed', error: message, endedAt: db.nowIso() });
        emit({ type: 'step.failed', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration: null, error: message });
        branch.status = 'failed';
        branch.lastOutput = { error: message };
        progressed = true;
        continue;
      }

      // ---- normal output: one node of this branch finished --------------
      const value = output === undefined ? null : output;
      db.updateStep(stepId, { status: 'done', output: value, endedAt: db.nowIso() });
      emit({ type: 'step.finished', runId: state.runId, stepId, nodeId: node.id, nodeType: node.type, iteration: null, output: value });
      scope.steps[node.id] = { output: value };
      branch.lastOutput = value;
      branch.status = 'running';
      branch.promptId = null;

      branch.cur = node.type === 'filter'
        ? (value && value.passed ? (node.next ?? null) : (node.elseNext ?? null))
        : (node.next ?? null);
      progressed = true;

      if (branch.cur === null) {
        // This branch's chain has ended. Settle its section: drafted, then
        // settled, in the same pass. FORGE.md section 2.3: for a section with
        // no downstream hard reader inside its own batch (which is every
        // section here except the one MUSIC reads), drafted and settled
        // happen at the same moment, the write succeeding is enough.
        db.markSectionDrafted(frame.pieceId, branch.section);
        const settleResult = db.markSectionSettled(frame.pieceId, branch.section);
        if (settleResult.ok) {
          branch.status = 'done';
        } else {
          branch.status = 'failed';
          branch.lastOutput = { error: `branch "${branch.id}" (${branch.section}) finished but could not settle: ${settleResult.reason}` };
        }
      }
    }
  }

  const anyFailed = frame.branches.some((b) => b.status === 'failed');
  const allSettled = frame.branches.every((b) => b.status === 'done' || b.status === 'failed');

  if (anyFailed) {
    const failedList = frame.branches
      .filter((b) => b.status === 'failed')
      .map((b) => `${b.id} (${b.section}): ${b.lastOutput && b.lastOutput.error}`);
    return { status: 'failed', message: `Parallel node "${frame.nodeId}" failed: ${failedList.join('; ')}` };
  }

  if (allSettled) {
    closeParallelFrame(state, frame);
    return { status: 'continue' };
  }

  // Nothing moved this pass. Either several prompts are genuinely in flight
  // (the real fan-out: park the run, surface every one of them at once, so
  // several Claude sessions can answer in parallel), or something is stuck.
  const promptIds = frame.branches.filter((b) => b.status === 'parked').map((b) => b.promptId);
  const stillBlocked = frame.branches.filter((b) => b.status === 'blocked');

  if (!promptIds.length && stillBlocked.length) {
    // Every remaining branch is blocked on a dependency and nothing is left
    // in flight that could ever settle it. That is a real deadlock in the
    // workflow's own hardReads declarations, not a normal wait, so it must
    // not sit silently. Fail loudly and name every stuck branch.
    const stuckList = stillBlocked.map((b) => `${b.id} (${b.section}) waiting on ${JSON.stringify(b.waitingOn)}`);
    return { status: 'failed', message: `Parallel node "${frame.nodeId}" deadlocked: ${stuckList.join('; ')}` };
  }

  return { status: 'park', promptIds };
}

/** Pop a parallel frame, write its step row, and point the parent at what is next. */
function closeParallelFrame(state, frame) {
  state.stack.pop();
  const output = {
    branches: Object.fromEntries(frame.branches.map((b) => [
      b.id,
      { section: b.section, status: b.status, output: b.lastOutput }
    ]))
  };
  db.updateStep(frame.stepId, { status: 'done', output, endedAt: db.nowIso() });
  currentScope(state).steps[frame.nodeId] = { output };
  emit({
    type: 'step.finished',
    runId: state.runId,
    stepId: frame.stepId,
    nodeId: frame.nodeId,
    nodeType: 'parallel',
    output
  });
  const parent = state.stack[state.stack.length - 1];
  if (parent) {
    parent.cur = frame.next ?? null;
    if (parent.kind === 'each' || parent.kind === 'sub') parent.lastOutput = output;
  }
}

// ---------------------------------------------------------------------------
// the public three
// ---------------------------------------------------------------------------

/**
 * Start a run. Returns { runId, status }.
 *
 * By default this waits until the run ends or parks, so the caller gets a real
 * status back and a queued prompt is definitely in the table. Pass wait:false
 * to fire it off and return straight away.
 */
export async function startRun({ slug, input = null, trigger = 'api', wait = true } = {}) {
  const wf = db.getWorkflowBySlug(slug);
  if (!wf) throw new Error(`Workflow "${slug}" was not found.`);
  if (!wf.enabled) throw new Error(`Workflow "${slug}" is switched off.`);

  const def = wf.definition;
  const problems = validateWorkflow(def, slug);
  if (problems.length) {
    throw new Error(`Workflow "${slug}" is not valid:\n  ` + problems.join('\n  '));
  }

  const runInput = input === null || input === undefined ? (def.input ?? {}) : input;
  const runRow = db.createRun({
    workflowId: wf.id,
    slug,
    status: 'running',
    trigger: trigger || 'api',
    input: runInput
  });

  const state = newState(runRow, def);
  // A brand new run cannot be contended, but taking the lock here means the
  // row is owned from its first step, so a second process cannot join in.
  takeLock(runRow.id);
  emit({ type: 'run.started', runId: runRow.id, slug, trigger: trigger || 'api', input: runInput });

  if (!wait) {
    execute(state).catch((err) => console.error('[flow] run failed in the background:', err.message));
    return { runId: runRow.id, status: 'running' };
  }

  const status = await execute(state);
  return { runId: runRow.id, status };
}

/**
 * True if the run's cursor holds a parallel frame with a branch that is
 * parked on a prompt which has already been answered.
 *
 * Why this exists: a parallel batch can have several prompts outstanding at
 * once (FORGE.md section 3, the whole point of fanning out steps 6, 7, and
 * 10). Two answers can land close enough together that the second caller's
 * resumeRun finds `active.has(id)` still true from the first and walks away
 * (the log line right below explains why that is the correct thing for it to
 * do, not a bug). That second answer is still sound in the prompts table, it
 * is just not read yet. This is what the drain loop in resumeRun checks for,
 * so that answer is never left stuck until some unrelated later trigger
 * happens to stumble onto it.
 */
function cursorHasAnsweredParkedBranch(cursor) {
  if (!cursor || !Array.isArray(cursor.stack)) return false;
  for (const frame of cursor.stack) {
    if (frame.kind !== 'parallel' || !Array.isArray(frame.branches)) continue;
    for (const b of frame.branches) {
      if (b.status !== 'parked' || !b.promptId) continue;
      const prompt = db.getPrompt(b.promptId);
      if (prompt && prompt.status === 'answered') return true;
    }
  }
  return false;
}

/**
 * One attempt at taking the lock, loading the cursor, and running the loop.
 * Pulled out of resumeRun so the drain loop below can call it again without
 * repeating the lock dance. Every failure in here is written to the events
 * table and flips the run to failed, so a resume can never fail quietly.
 */
async function attemptResume(id) {
  const runRow = db.getRun(id);
  if (!runRow) return { status: 'missing', resumed: false, reason: `Run ${id} was not found.` };

  if (active.has(id)) {
    return { status: runRow.status, resumed: false, reason: 'That run is already moving.' };
  }
  if (!PARKED.has(runRow.status)) {
    return { status: runRow.status, resumed: false, reason: `Run ${id} is "${runRow.status}", not parked, so there is nothing to resume.` };
  }

  // Take the lock before anything is written. If another process got here
  // first this returns false and we walk away, which is the whole point: two
  // servers must never resume the same run and double its steps.
  if (!takeLock(id)) {
    const holder = (() => { try { return db.getRunLock(id); } catch { return null; } })();
    return {
      status: runRow.status,
      resumed: false,
      reason: `Run ${id} is locked by another process${holder ? ` (${holder.lockedBy})` : ''}, so this one left it alone.`
    };
  }

  // Read the row again now that we hold the lock. The winner of a race may
  // have moved the run on between our first read and the lock.
  const fresh = db.getRun(id);
  if (!fresh || !PARKED.has(fresh.status)) {
    db.releaseRunLock(id, OWNER_ID);
    return {
      status: fresh ? fresh.status : 'missing',
      resumed: false,
      reason: `Run ${id} is "${fresh ? fresh.status : 'missing'}", so somebody else already moved it on.`
    };
  }

  let state;
  try {
    const wf = db.getWorkflowById(fresh.workflowId);
    if (!wf) throw new Error(`Workflow ${fresh.workflowId} is missing, so run ${id} cannot carry on.`);
    state = fromCursor(fresh, wf.definition, fresh.cursor);
  } catch (err) {
    const message = `Resume failed: ${err.message}`;
    db.addEvent({ runId: id, level: 'error', message, data: null });
    emit({ type: 'log', runId: id, level: 'error', message, data: null });
    db.updateRun(id, { status: 'failed', error: message, endedAt: db.nowIso(), wakeAt: null });
    db.releaseRunLock(id, OWNER_ID);
    emit({ type: 'run.failed', runId: id, slug: fresh.slug, status: 'failed', error: message });
    return { status: 'failed', resumed: false, reason: message };
  }

  // wake_at is cleared here. The run is moving again, so it is no longer due,
  // and leaving it set would make the sweeper pick the same run up twice.
  db.updateRun(id, { status: 'running', wakeAt: null });
  emit({
    type: 'run.resumed',
    runId: id,
    slug: state.slug,
    nodeId: state.resume ? state.resume.nodeId : null,
    promptId: state.resume ? state.resume.promptId : null,
    wakeAt: state.resume ? state.resume.wakeAt ?? null : null
  });

  const status = await execute(state);
  return { status, resumed: true };
}

/**
 * Carry on a run that parked on a claude node. Called once the answer is in.
 */
export async function resumeRun(runId) {
  const id = Number(runId);
  const first = await attemptResume(id);

  // Drain: keep resuming this run for as long as it re-parked with a branch
  // whose prompt is already answered and simply has not been read yet. See
  // cursorHasAnsweredParkedBranch for why this can happen. Bounded so a real
  // bug cannot spin forever; nine branches is the largest batch FORGE defines
  // today, so 25 passes is generous headroom, not a number chosen to matter.
  let status = first.status;
  let resumed = first.resumed;
  let drainCount = 0;
  while (status === 'waiting_on_claude' && drainCount < 25) {
    const row = db.getRun(id);
    if (!row || !cursorHasAnsweredParkedBranch(row.cursor)) break;
    drainCount += 1;
    const again = await attemptResume(id);
    if (!again.resumed) break; // somebody else is already draining it, or it moved on
    status = again.status;
    resumed = true;
  }
  if (drainCount >= 25) {
    db.addEvent({ runId: id, level: 'warn', message: `Run ${id}: drain loop stopped at 25 passes with answered prompts still unread. Investigate.`, data: null });
  }

  return { runId: id, status, resumed, reason: first.reason };
}

/** Stop a run, whether it is moving or parked. */
export async function cancelRun(runId) {
  const id = Number(runId);
  const runRow = db.getRun(id);
  if (!runRow) throw new Error(`Run ${runId} was not found.`);
  if (ENDED.has(runRow.status)) {
    return { ok: false, runId: id, status: runRow.status, reason: 'That run has already ended.' };
  }

  const controller = active.get(id);
  if (controller) {
    // The executor checks the signal between steps and nodes pass it to fetch,
    // so this stops at the next safe point.
    controller.abort();
    return { ok: true, runId: id, status: 'cancelling' };
  }

  // A parked run has nothing running. Close its open prompts so the queue does
  // not hold work nobody will ever use.
  for (const prompt of db.listPrompts({ runId: id })) {
    if (prompt.status === 'waiting' || prompt.status === 'claimed') {
      db.failPrompt(prompt.id, `Run ${id} was cancelled.`);
    }
  }
  db.updateRun(id, {
    status: 'cancelled',
    endedAt: db.nowIso(),
    cursor: null,
    wakeAt: null,
    error: 'Run was cancelled.'
  });
  try { db.releaseRunLock(id, OWNER_ID); } catch { /* the lock expires on its own */ }
  emit({ type: 'run.cancelled', runId: id, slug: runRow.slug, status: 'cancelled', error: 'Run was cancelled.' });
  return { ok: true, runId: id, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// the timer sweeper, which wakes runs parked on a wait node
// ---------------------------------------------------------------------------
//
// The wake time is a column, not a setTimeout, so this survives a restart.
// The sweeper asks the database one question on a timer: which parked runs are
// due. Nothing is held in memory between ticks, so killing the server mid wait
// costs nothing at all.

/** Resume every run whose wake time has passed. Returns how many were woken. */
export async function resumeDueTimers(limit = 25) {
  let due;
  try {
    due = db.dueTimerRuns(db.nowIso(), limit);
  } catch (err) {
    console.error('[flow] the timer sweep could not read the database:', err.message);
    return 0;
  }
  let woken = 0;
  for (const runRow of due) {
    if (active.has(runRow.id)) continue;
    try {
      const res = await resumeRun(runRow.id);
      if (res && res.resumed) woken++;
    } catch (err) {
      console.error(`[flow] waking run ${runRow.id} failed:`, err.message);
    }
  }
  return woken;
}

/**
 * Run the sweep on a timer. Returns a stop function.
 * One second is fine: it is one indexed query against a small table, and it
 * keeps a three second wait honest.
 */
export function startTimerSweeper({ everyMs = 1000 } = {}) {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; // never let two sweeps overlap
    busy = true;
    resumeDueTimers()
      .catch((err) => console.error('[flow] timer sweep failed:', err.message))
      .finally(() => { busy = false; });
  }, Math.max(200, Number(everyMs) || 1000));
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
