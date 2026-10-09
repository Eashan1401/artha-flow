// FORGE's parallel node. Runs several independent branches of a workflow at
// once, each one owning one Bible section, gated by the atomic claim in
// db.js's tryClaimSection (FORGE.md section 2.1).
//
// Same trick as each.js and sub.js: this node does no dispatching itself. It
// validates the branch list and hands the engine a plan,
// { __parallel: true, pieceId, branches }. The engine pushes a "parallel"
// frame onto the same stack it already uses for loops and sub workflows, and
// advances every branch as far as it can go on every pass (server/engine.js,
// advanceParallelFrame). A branch that parks on a claude node parks only
// itself, not the whole run, so several prompts can sit in the queue at once
// and several Claude sessions can answer them at the same time. That is the
// actual fan-out FORGE.md section 3 names for steps 6, 7, and 10.
//
// What this node deliberately does not support yet, per FORGE.md section 7,
// "what not to build yet": a branch body may not itself contain an each, sub,
// or wait node. Craft departments, gates, and the publish block are all
// short, linear chains (a claude node or two, then a write), which is the one
// real instance of this shape today. Nesting is not worth the extra engine
// surface until a second real shape needs it.

export const type = 'parallel';

export const meta = {
  label: 'Run branches in parallel',
  description: 'Runs several independent, claim-gated branches at once. Each branch owns one Bible section.',
  configSchema: {
    pieceId: { type: 'string', required: true, help: 'The piece this batch belongs to. Usually {{ run.id }} or a real piece id.' },
    branches: {
      type: 'array',
      required: true,
      help: 'One entry per branch: { id, section, agent, body, hardReads, softReads }. hardReads and softReads are optional lists of section names.'
    },
    parallel: {
      type: 'boolean',
      required: false,
      default: true,
      help: 'true (default): every branch is claim-gated and dispatched together, several prompts can queue at once. false: branches run one at a time, in array order, each fully settling before the next is even attempted, the same order and outcome as a hand written sequential chain. This is the FORGE off switch: wire it to a run input and the pipeline behaves exactly as it did before this node existed.'
    }
  }
};

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;

  // {{ run.id }} renders to a real number when it is the whole config value
  // (CONTRACT.md's render() rule), so a numeric run id is just as valid a
  // piece id as a string one.
  const pieceId = (typeof cfg.pieceId === 'string' || typeof cfg.pieceId === 'number')
    ? String(cfg.pieceId).trim()
    : '';
  if (!pieceId) throw new Error(`parallel node "${nodeId}" needs "pieceId"`);

  if (!Array.isArray(cfg.branches) || cfg.branches.length === 0) {
    throw new Error(`parallel node "${nodeId}" needs "branches", a non empty array`);
  }

  const seenIds = new Set();
  const seenSections = new Set();
  const branches = cfg.branches.map((b, i) => {
    if (!b || typeof b !== 'object') throw new Error(`parallel node "${nodeId}": branch ${i} is not an object`);
    const id = String(b.id ?? '').trim();
    const section = String(b.section ?? '').trim();
    const agent = String(b.agent ?? '').trim();
    const body = String(b.body ?? '').trim();
    if (!id) throw new Error(`parallel node "${nodeId}": branch ${i} has no "id"`);
    if (!section) throw new Error(`parallel node "${nodeId}": branch "${id}" has no "section"`);
    if (!agent) throw new Error(`parallel node "${nodeId}": branch "${id}" has no "agent", the one declared owner`);
    if (!body) throw new Error(`parallel node "${nodeId}": branch "${id}" has no "body", the node id it starts at`);
    if (seenIds.has(id)) throw new Error(`parallel node "${nodeId}": branch id "${id}" is used more than once`);
    if (seenSections.has(section)) throw new Error(`parallel node "${nodeId}": section "${section}" is claimed by more than one branch, which breaks the one-writer rule (AGENT-SPEC.md 3.1.1)`);
    seenIds.add(id);
    seenSections.add(section);
    const hardReads = Array.isArray(b.hardReads) ? b.hardReads.map(String) : [];
    const softReads = Array.isArray(b.softReads) ? b.softReads.map(String) : [];
    return { id, section, agent, body, hardReads, softReads };
  });

  // Templates can render "false" as the literal string "false", not just the
  // boolean, so both forms turn the batch off. Anything else, including the
  // key being left out entirely, defaults to on.
  const parallel = !(cfg.parallel === false || cfg.parallel === 'false');

  ctx.log(
    'info',
    `Dispatching ${branches.length} branch(es) for piece "${pieceId}" ${parallel ? 'in parallel' : 'one at a time (FORGE off)'}: ${branches.map((b) => b.section).join(', ')}.`
  );

  return { __parallel: true, pieceId, branches, parallel };
}
