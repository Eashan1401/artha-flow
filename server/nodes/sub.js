// Run another workflow and hand its output back.
//
// Without this, every common block gets copy pasted into every workflow file,
// and a fix has to be made in nine places. With it, "research a lead" or
// "write the follow up" is one workflow that everything else calls.
//
// The engine does the running. This node checks the call is allowed and hands
// back the sentinel { __sub: true, slug, input }. The engine then pushes the
// child workflow onto the same frame stack it already uses for each loops. That
// is the whole trick: a claude node three workflows deep parks and resumes
// through exactly the same cursor path as one at the top level, with no change
// to the resume code at all.
//
// The child gets its own input and its own steps namespace, so a node id used
// in both the parent and the child cannot collide.

import { getWorkflowBySlug } from '../db.js';

export const type = 'sub';

// How many workflows deep a call chain may go. The engine holds the same
// number. It is repeated here rather than imported because the engine imports
// the node registry, so importing the engine back would be a circle.
export const MAX_DEPTH = 5;

export const meta = {
  label: 'Run a workflow',
  description: 'Runs another workflow by slug and returns its output.',
  configSchema: {
    slug: { type: 'string', required: true, help: 'The slug of the workflow to run.' },
    input: { type: 'object', required: false, help: 'The input for the child run. Templates allowed.' },
    maxDepth: { type: 'number', required: false, default: MAX_DEPTH, help: 'How many workflows deep the chain may go. Hard limit is 5.' }
  }
};

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;

  const slug = typeof cfg.slug === 'string' ? cfg.slug.trim() : '';
  if (!slug) {
    throw new Error(`sub node "${nodeId}" needs "slug", the workflow to run`);
  }

  let maxDepth = Number(cfg.maxDepth);
  if (!Number.isFinite(maxDepth) || maxDepth <= 0) maxDepth = MAX_DEPTH;
  if (maxDepth > MAX_DEPTH) maxDepth = MAX_DEPTH;

  // The chain is [top level slug, ...every sub we are already inside].
  const chain = Array.isArray(ctx.subChain) && ctx.subChain.length ? ctx.subChain : [ctx.run.slug];
  const depth = Number(ctx.subDepth) || 0;

  // Recursion, direct or round a cycle. Caught before anything runs, and the
  // message names the whole loop so it is obvious which link to cut.
  if (chain.includes(slug)) {
    throw new Error(
      `sub node "${nodeId}" would run "${slug}", which is already in this chain: ` +
      `${[...chain, slug].join(' -> ')}. A workflow cannot call itself, directly or through another one.`
    );
  }

  if (depth >= maxDepth) {
    throw new Error(
      `sub node "${nodeId}" is ${depth} workflow(s) deep already, and the limit is ${maxDepth}. ` +
      `Chain: ${chain.join(' -> ')}.`
    );
  }

  const wf = getWorkflowBySlug(slug);
  if (!wf) {
    throw new Error(`sub node "${nodeId}" calls workflow "${slug}", which is not in the database.`);
  }
  if (!wf.enabled) {
    throw new Error(`sub node "${nodeId}" calls workflow "${slug}", which is switched off.`);
  }

  // No input given means the child uses its own default input block, the same
  // way a manual run of that workflow would.
  let input;
  if (cfg.input === undefined || cfg.input === null) {
    input = wf.definition && wf.definition.input ? wf.definition.input : {};
  } else if (typeof cfg.input !== 'object' || Array.isArray(cfg.input)) {
    throw new Error(`sub node "${nodeId}": "input" must be an object, got ${Array.isArray(cfg.input) ? 'an array' : typeof cfg.input}.`);
  } else {
    input = cfg.input;
  }

  ctx.log('info', `Running workflow "${slug}" from node "${nodeId}".`);

  return { __sub: true, slug, input };
}
