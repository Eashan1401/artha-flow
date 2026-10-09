// ARTHA FLOW: template rendering for {{ path }} tags.
//
// Two behaviours, and the difference matters:
//
//   "{{ steps.n1.output.rows }}"        the whole string is one tag, so the
//                                       real value comes back, array or object
//                                       intact, never stringified.
//   "Found {{ steps.n1.output.count }}" a tag inside longer text, so the value
//                                       is turned into text and slotted in.
//
// A path that does not resolve throws RenderError naming the exact path. We
// never quietly write the word "undefined" into a workflow output.
//
// {{ env.SOMETHING }} is refused on purpose. Templates never see process.env.

export class RenderError extends Error {
  constructor(message, path = null) {
    super(message);
    this.name = 'RenderError';
    this.path = path;
  }
}

// One tag: {{ anything that is not a brace }}
const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;

// Roots a template is allowed to start from. Anything else is a clear error,
// which is much friendlier than "cannot read property of undefined".
const ROOTS = new Set(['input', 'run', 'steps', 'item', 'index']);

/**
 * Render a value. Strings get their tags filled in, arrays and plain objects
 * are walked, everything else comes back untouched.
 */
export function render(value, ctx = {}) {
  if (typeof value === 'string') return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = render(val, ctx);
    return out;
  }
  return value;
}

/** Render one string. Exported because the engine sometimes wants just this. */
export function renderString(text, ctx = {}) {
  TAG.lastIndex = 0;
  const whole = wholeTag(text);
  if (whole !== null) return resolvePath(whole, ctx);
  TAG.lastIndex = 0;
  return text.replace(TAG, (_match, path) => toText(resolvePath(path, ctx), path));
}

/** True if the string is exactly one tag and nothing else. */
function wholeTag(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}')) return null;
  TAG.lastIndex = 0;
  const first = TAG.exec(trimmed);
  if (!first) return null;
  // It only counts as a whole tag if that one match covers the whole string.
  if (first.index !== 0 || first[0].length !== trimmed.length) return null;
  return first[1];
}

/**
 * Walk a dotted path through the context.
 * Supports dots and bracket indexes: steps.n1.output.rows[0].name
 */
export function resolvePath(rawPath, ctx = {}) {
  const path = String(rawPath).trim();
  if (path === '') throw new RenderError('Empty template tag {{ }}', path);

  const parts = splitPath(path);
  const root = parts[0];

  if (root === 'env' || root === 'process') {
    throw new RenderError(
      `Template path "${path}" is not allowed. Environment variables are never exposed to workflows.`,
      path
    );
  }
  if (!ROOTS.has(root)) {
    throw new RenderError(
      `Unknown template root "${root}" in "${path}". Use one of: ${[...ROOTS].join(', ')}.`,
      path
    );
  }
  if (!(root in ctx) || ctx[root] === undefined) {
    if (root === 'item' || root === 'index') {
      throw new RenderError(`"${path}" is only available inside an each loop.`, path);
    }
    throw new RenderError(`Template path "${path}" cannot be resolved: "${root}" is not set.`, path);
  }

  let cur = ctx[root];
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    if (cur === null || cur === undefined) {
      throw new RenderError(
        `Template path "${path}" cannot be resolved: "${parts.slice(0, i).join('.')}" is ${cur === null ? 'null' : 'not set'}.`,
        path
      );
    }
    if (typeof cur !== 'object') {
      throw new RenderError(
        `Template path "${path}" cannot be resolved: "${parts.slice(0, i).join('.')}" is a ${typeof cur}, not an object.`,
        path
      );
    }
    if (!(key in cur)) {
      throw new RenderError(
        `Template path "${path}" cannot be resolved: "${key}" is missing from "${parts.slice(0, i).join('.')}".`,
        path
      );
    }
    cur = cur[key];
  }

  if (cur === undefined) {
    throw new RenderError(`Template path "${path}" resolved to nothing.`, path);
  }
  return cur;
}

function splitPath(path) {
  // rows[0].name becomes rows.0.name, then a plain split on dots.
  const flat = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = flat.split('.').map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length) throw new RenderError(`Template path "${path}" is empty.`, path);
  return parts;
}

/** Turn a resolved value into text for an inline tag. */
function toText(value, path) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    throw new RenderError(`Template path "${path}" holds a value that cannot be turned into text.`, path);
  }
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
