// Run a small JavaScript expression over the run data.
//
// This is the owner's own code on his own machine, so a real expression is fine.
// Two guards all the same:
//   1. process, globalThis, global, require, module and fetch are passed in as
//      undefined parameters, which shadows them inside the expression. That
//      keeps process.env out of reach, which is a standing rule.
//   2. Everything is wrapped in try and catch, and the failure message repeats
//      the expression text so a broken workflow is easy to fix.

export const type = 'transform';

export const meta = {
  label: 'Transform',
  description: 'Runs a JavaScript expression over the run data and returns the value.',
  configSchema: {
    expression: {
      type: 'string',
      required: true,
      help: 'A JavaScript expression, for example: steps.n1.output.body.items.map(i => i.name)'
    }
  }
};

// The first five names are the contract. The rest are blanks that shadow the
// globals we do not want an expression reaching for.
const SHADOWED = ['process', 'globalThis', 'global', 'require', 'module', 'fetch'];

export function compile(expression) {
  return new Function(
    'ctx', 'input', 'steps', 'item', 'index',
    ...SHADOWED,
    'return (' + expression + ')'
  );
}

export async function run(ctx) {
  const expression = ctx.config?.expression;
  if (!expression || typeof expression !== 'string') {
    throw new Error(`transform node "${ctx.node.id}" needs an expression in config`);
  }

  let fn;
  try {
    fn = compile(expression);
  } catch (err) {
    throw new Error(`transform node "${ctx.node.id}": expression will not compile: ${err.message}\n  expression: ${expression}`);
  }

  try {
    const value = await fn(ctx, ctx.input, ctx.steps, ctx.item, ctx.index);
    return { value };
  } catch (err) {
    throw new Error(`transform node "${ctx.node.id}": expression failed: ${err.message}\n  expression: ${expression}`);
  }
}
