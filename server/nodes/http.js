// Call an HTTP endpoint. Uses the built in fetch, no libraries.
//
// Redirects are followed by hand so we can check every hop. A redirect to
// anything that is not http or https is refused, which stops a server sending
// us at file:// or another local scheme.

export const type = 'http';

export const meta = {
  label: 'HTTP request',
  description: 'Calls a URL and returns the status, headers and body.',
  configSchema: {
    url: { type: 'string', required: true, help: 'Full URL, http or https only.' },
    method: { type: 'string', required: false, default: 'GET', help: 'GET, POST, PUT, PATCH, DELETE' },
    headers: { type: 'object', required: false, default: {}, help: 'Request headers as an object.' },
    body: { type: 'string', required: false, help: 'String, or an object which is sent as JSON.' },
    timeoutMs: { type: 'number', required: false, default: 20000, help: 'Give up after this long.' },
    expect: { type: 'string', required: false, default: 'json', help: 'json or text' },
    failOnError: { type: 'boolean', required: false, default: true, help: 'Fail the step on a non 2xx reply.' }
  }
};

const MAX_REDIRECTS = 5;

function checkScheme(url, nodeId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`http node "${nodeId}": "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http node "${nodeId}": refusing scheme "${parsed.protocol}". Only http and https are allowed.`);
  }
  return parsed;
}

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;
  if (!cfg.url) throw new Error(`http node "${nodeId}" needs a url in config`);

  const method = String(cfg.method || 'GET').toUpperCase();
  const timeoutMs = Number(cfg.timeoutMs ?? 20000);
  const expect = cfg.expect === 'text' ? 'text' : 'json';
  const failOnError = cfg.failOnError === undefined ? true : Boolean(cfg.failOnError);

  const headers = { ...(cfg.headers || {}) };
  let body;
  if (cfg.body !== undefined && cfg.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof cfg.body === 'string') {
      body = cfg.body;
    } else {
      body = JSON.stringify(cfg.body);
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    }
  }

  // The run wide cancel signal and the per call timeout, whichever fires first.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  const signal = AbortSignal.any(signals);

  let url = checkScheme(cfg.url, nodeId).toString();
  let res;
  let hops = 0;

  while (true) {
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal });
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) throw new Error(`http node "${nodeId}": run was cancelled`);
      throw new Error(`http node "${nodeId}": request to ${url} failed: ${err.message}`);
    }
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect) break;
    if (++hops > MAX_REDIRECTS) {
      throw new Error(`http node "${nodeId}": too many redirects (over ${MAX_REDIRECTS}) starting at ${cfg.url}`);
    }
    const next = new URL(res.headers.get('location'), url);
    checkScheme(next.toString(), nodeId);
    url = next.toString();
  }

  const raw = await res.text();
  let parsed = raw;
  let parseError = null;
  if (expect === 'json') {
    try {
      parsed = raw === '' ? null : JSON.parse(raw);
    } catch (err) {
      // Keep the raw text as the body. A bad status is the more useful
      // complaint, so the parse problem is only raised if the call went fine.
      parsed = raw;
      parseError = err.message;
    }
  }

  const out = {
    status: res.status,
    ok: res.ok,
    headers: Object.fromEntries(res.headers.entries()),
    body: parsed
  };

  if (!res.ok && failOnError) {
    const err = new Error(`http node "${nodeId}": ${method} ${url} returned ${res.status}`);
    err.output = out;
    throw err;
  }
  if (parseError && res.ok && failOnError) {
    throw new Error(`http node "${nodeId}": reply from ${url} was not valid JSON: ${parseError}`);
  }
  return out;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}
