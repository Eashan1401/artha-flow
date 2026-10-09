// A yes or no gate. True carries on at "next", false carries on at "elseNext".
// Either of those may be null, which just ends that branch.
//
// The expression is evaluated exactly like the transform node, with the same
// shadowing of process and friends.

import { compile } from './transform.js';

export const type = 'filter';

export const meta = {
  label: 'Filter',
  description: 'Checks a condition. True goes to next, false goes to elseNext.',
  configSchema: {
    expression: {
      type: 'string',
      required: true,
      help: 'A JavaScript expression read as true or false, for example: item.score > 70'
    }
  }
};

export async function run(ctx) {
  const expression = ctx.config?.expression;
  if (!expression || typeof expression !== 'string') {
    throw new Error(`filter node "${ctx.node.id}" needs an expression in config`);
  }

  let fn;
  try {
    fn = compile(expression);
  } catch (err) {
    throw new Error(`filter node "${ctx.node.id}": expression will not compile: ${err.message}\n  expression: ${expression}`);
  }

  try {
    const value = await fn(ctx, ctx.input, ctx.steps, ctx.item, ctx.index);
    return { passed: Boolean(value) };
  } catch (err) {
    throw new Error(`filter node "${ctx.node.id}": expression failed: ${err.message}\n  expression: ${expression}`);
  }
}
