// Loop over an array.
//
// The node itself does no looping. It checks the list, caps it, and hands the
// engine a plan: { __each: true, items, body, ... }. The engine pushes a loop
// frame and walks the body once per item, giving each pass its own item and
// index, and its own step rows tagged with the iteration number.
//
// Doing it this way (rather than the node calling back into the engine) is what
// makes a park inside a loop work. The loop position lives in the run cursor,
// so a claude node halfway through item 7 of 30 can wait a day and carry on.

export const type = 'each';

export const meta = {
  label: 'For each item',
  description: 'Runs a chain of nodes once for every item in a list.',
  configSchema: {
    items: { type: 'array', required: true, help: 'A template that gives an array, for example {{ steps.n1.output.rows }}' },
    body: { type: 'string', required: true, help: 'The node id the loop body starts at.' },
    maxItems: { type: 'number', required: false, default: 100, help: 'Hard cap on how many items get processed.' },
    stopOnError: { type: 'boolean', required: false, default: false, help: 'Stop the whole run when one item fails.' }
  }
};

export const DEFAULT_MAX_ITEMS = 100;

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;

  if (!cfg.body || typeof cfg.body !== 'string') {
    throw new Error(`each node "${nodeId}" needs "body", the node id the loop starts at`);
  }
  if (!Array.isArray(cfg.items)) {
    const got = cfg.items === null ? 'null' : typeof cfg.items;
    throw new Error(`each node "${nodeId}": "items" must be an array, got ${got}. Use a whole tag like {{ steps.n1.output.rows }}.`);
  }

  const maxItems = Number.isFinite(Number(cfg.maxItems)) ? Number(cfg.maxItems) : DEFAULT_MAX_ITEMS;
  const items = cfg.items.slice(0, Math.max(0, maxItems));
  if (items.length < cfg.items.length) {
    ctx.log('warn', `each node "${nodeId}": list had ${cfg.items.length} items, capped at ${maxItems}.`);
  }

  return {
    __each: true,
    items,
    body: cfg.body,
    total: cfg.items.length,
    maxItems,
    stopOnError: Boolean(cfg.stopOnError)
  };
}
