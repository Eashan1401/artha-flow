// The node registry. One place that knows every node type.
//
// The UI reads the meta and configSchema from here to draw its forms, and the
// engine looks a type up here before it runs a step. An unknown type is a hard
// failure with the type and the node id in the message.

import * as manual from './manual.js';
import * as log from './log.js';
import * as http from './http.js';
import * as claude from './claude.js';
import * as transform from './transform.js';
import * as filter from './filter.js';
import * as each from './each.js';
import * as write from './write.js';
import * as wait from './wait.js';
import * as sub from './sub.js';
import * as parallel from './parallel.js';
import * as shellJson from './shell-json.js';

const MODULES = [
  manual, log, http, claude, transform, filter, each, write, wait, sub, parallel,
  shellJson
];

export const nodes = Object.freeze(
  Object.fromEntries(MODULES.map((m) => [m.type, m]))
);

export const nodeTypes = Object.freeze(MODULES.map((m) => m.type));

/** Look a node module up. Throws a clear error if the type is not known. */
export function getNode(type, nodeId = null) {
  const found = nodes[type];
  if (!found) {
    const where = nodeId ? ` (node "${nodeId}")` : '';
    throw new Error(
      `Unknown node type "${type}"${where}. Known types: ${nodeTypes.join(', ')}.`
    );
  }
  return found;
}

export function hasNode(type) {
  return Boolean(nodes[type]);
}

/** Everything the UI form builder needs, one entry per node type. */
export function nodeMeta() {
  return MODULES.map((m) => ({
    type: m.type,
    label: m.meta.label,
    description: m.meta.description,
    configSchema: m.meta.configSchema
  }));
}
