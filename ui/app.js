/* ============================================================================
   ARTHA FLOW, the face.

   Plain JavaScript, no framework, no build step, no outside request. It talks
   to the local API on the same origin and to the websocket at /ws.

   How it hangs together:

     api      thin fetch wrapper, one place that knows about errors
     norm     turns whatever the server sends into the shape the views want
     live     the websocket client: subscribe, backoff reconnect, tell views
     store    the small bits of state the whole page shares
     views    one object per route, each with mount, unmount, event, refresh
     router   hash to view

   Two rules run through all of it.

   1. The websocket is for speed, the REST API is for truth. Every live event
      paints straight away and also marks the view dirty, and a throttled
      refetch then corrects anything the event did not carry. So a payload key
      changing shape under us slows the paint down, it does not break the page.

   2. Nothing renders unbounded. Long lists render a window, big JSON only gets
      built when somebody opens it. See the notes at renderLog and renderJson.
   ========================================================================= */

/* ----------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Every piece of server data goes through this before it touches innerHTML. */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A small, deliberately narrow markdown to HTML renderer, just enough for
 * bin/run-story's own output: headings, bold, inline code, backtick-quoted
 * paths, pipe tables, bullet lists, and plain paragraphs. No npm package,
 * no CDN script, this whole file works with the network cable pulled out.
 * Every raw text run goes through esc() before it reaches innerHTML.
 */
function mdInline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}
function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push('<h' + level + '>' + mdInline(h[2]) + '</h' + level + '>');
      i++; continue;
    }
    if (/^\s*-\s+/.test(line)) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push('<li>' + mdInline(line.replace(/^\s*-\s+/, '')) + '</li>');
      i++; continue;
    }
    closeList();
    if (/^\|.*\|\s*$/.test(line) && lines[i + 1] && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j]); j++; }
      const cells = (r) => r.slice(1, -1).split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2);
      out.push('<div class="table-wrap"><table class="table"><thead><tr>' +
        head.map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + cells(r).map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>');
      i = j; continue;
    }
    if (!line.trim()) { i++; continue; }
    out.push('<p>' + mdInline(line) + '</p>');
    i++;
  }
  closeList();
  return out.join('\n');
}

/** First key that actually holds something. Lets us read camelCase or snake. */
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Lists arrive either bare or wrapped. GET /api/claude/pending really returns
 * { prompts: [...] }, so a bare Array.isArray check is not enough. Checked
 * against the running server on 2026-08-19.
 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.prompts)) return v.prompts;
  if (v && Array.isArray(v.items)) return v.items;
  if (v && Array.isArray(v.rows)) return v.rows;
  if (v && Array.isArray(v.prompts)) return v.prompts;
  if (v && Array.isArray(v.runs)) return v.runs;
  if (v && Array.isArray(v.workflows)) return v.workflows;
  if (v && v.prompt) return [v.prompt];
  return [];
}

/** JSON columns should arrive parsed. If one arrives as text, parse it here. */
function maybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return v;
  if (t[0] !== '{' && t[0] !== '[') return v;
  try { return JSON.parse(t); } catch { return v; }
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function ago(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  let s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function fmtMs(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m < 60) return m + 'm ' + pad2(s) + 's';
  return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
}

function durMs(startIso, endIso) {
  const a = new Date(startIso).getTime();
  if (isNaN(a)) return null;
  const b = endIso ? new Date(endIso).getTime() : Date.now();
  if (isNaN(b)) return null;
  return Math.max(0, b - a);
}

function fmtUptime(sec) {
  const s = Number(sec);
  if (!isFinite(s)) return '';
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}

/** Big JSON gets cut here, not in the DOM. A step can hold megabytes. */
const JSON_CAP = 20000;
function jsonText(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch (err) {
    text = 'Could not show this value: ' + err.message;
  }
  if (text === undefined) text = String(value);
  if (text.length > JSON_CAP) {
    return {
      text: text.slice(0, JSON_CAP),
      cut: true,
      total: text.length,
    };
  }
  return { text, cut: false, total: text.length };
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for a plain http origin that is not treated as secure.
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      ta.remove();
    }
  });
}

function toast(message, tone) {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (tone) el.dataset.tone = tone;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.dataset.leaving = '1';
    setTimeout(() => el.remove(), 260);
  }, tone === 'bad' ? 6000 : 3200);
}

/**
 * Labels for the node types we know about. Anything not in here still renders:
 * it gets its own two letter badge and the raw type as its label. New node
 * types must never need an edit here to show up properly.
 */
const NODE_LABEL = {
  manual: 'Manual trigger', log: 'Log line', http: 'HTTP request',
  claude: 'Ask Claude', transform: 'Transform', filter: 'Filter',
  each: 'Loop over items', write: 'Write a file', wait: 'Wait',
  sub: 'Sub workflow',
};

function nodeLabel(type) {
  if (!type) return 'Unknown node';
  // The server is the authority. NODE_LABEL is only for before the registry
  // has arrived, or when the server is down.
  const meta = (typeof nodeRegistry !== 'undefined') ? nodeRegistry.meta(type) : null;
  if (meta && meta.label) return meta.label;
  return NODE_LABEL[type] || type;
}

function nodeMonogram(type) {
  if (!type) return '?';
  return String(type).slice(0, 2).toUpperCase();
}

const ICON = {
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h6"/></svg>',
  warn: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 3.2 18 17H2L10 3.2Z"/><path d="M10 8v4"/><path d="M10 14.4v.05"/></svg>',
  back: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M5 3.2v9.6l8-4.8z"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.5H3.6A1.1 1.1 0 0 0 2.5 4.6v6.9"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/* ----------------------------------------------------------------------------
   API. One wrapper, so an error has one shape and one place to be handled.
   -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.offline = status === 0;
  }
}

const api = {
  async request(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        ...options,
      });
    } catch (err) {
      // The server is not there at all. This is the restart case.
      store.setApi(false, 'Cannot reach the server on this address.');
      throw new ApiError('Cannot reach the server.', 0, 'offline');
    }
    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
    if (!res.ok) {
      const msg = (body && body.error && body.error.message) || (body && body.message) ||
        ('The server answered ' + res.status + '.');
      const code = (body && body.error && body.error.code) || String(res.status);
      // A 404 or a 400 means the server is alive, so the page is not offline.
      store.setApi(true);
      throw new ApiError(msg, res.status, code);
    }
    store.setApi(true);
    return body;
  },
  get(path) { return api.request(path); },
  post(path, body) {
    return api.request(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
};

/* ----------------------------------------------------------------------------
   Normalisers.

   The contract fixes the routes and the status strings, not every key name of
   every row. db.js columns are snake_case and the runs list is documented as
   camelCase, so both are accepted everywhere. This costs a few lines once and
   saves the whole page from a blank screen if a key lands the other way.
   -------------------------------------------------------------------------- */

function normRun(r) {
  if (!r) return null;
  return {
    id: pick(r, 'id', 'runId', 'run_id'),
    slug: pick(r, 'slug', 'workflowSlug', 'workflow_slug') || '',
    status: pick(r, 'status') || 'queued',
    trigger: pick(r, 'trigger') || '',
    input: maybeJson(pick(r, 'input')),
    error: pick(r, 'error') || '',
    startedAt: pick(r, 'startedAt', 'started_at') || null,
    endedAt: pick(r, 'endedAt', 'ended_at') || null,
    // Set when the run is parked on a wait node. Tells us the time to show
    // rather than a count up that means nothing to anybody.
    wakeAt: pick(r, 'wakeAt', 'wake_at') || null,
  };
}

function normStep(s) {
  return {
    id: pick(s, 'id', 'stepId', 'step_id'),
    nodeId: pick(s, 'nodeId', 'node_id') || '',
    nodeType: pick(s, 'nodeType', 'node_type') || '',
    name: pick(s, 'name') || '',
    iteration: pick(s, 'iteration'),
    status: pick(s, 'status') || 'pending',
    input: maybeJson(pick(s, 'input')),
    output: maybeJson(pick(s, 'output')),
    error: pick(s, 'error') || '',
    startedAt: pick(s, 'startedAt', 'started_at') || null,
    endedAt: pick(s, 'endedAt', 'ended_at') || null,
    // "make the agents visible", 2026-09-17. desk and role name the plain
    // English job and the agent role card, read from the workflow's own
    // config.desk/config.role. actor is who answered a claude node's prompt.
    // outputFile and checkResult are read only summaries of what happened.
    desk: pick(s, 'desk') || '',
    role: pick(s, 'role') || '',
    // "skills on the desks", 2026-09-17: which .agents/skills/ skill this
    // step's desk runs, read straight off config.skills (see api.js
    // enrichSteps). Always an array; empty means no skill is wired here
    // today, per references/SKILLS-PROVENANCE.md.
    skills: Array.isArray(pick(s, 'skills')) ? pick(s, 'skills') : [],
    actor: pick(s, 'actor') || '',
    outputFile: pick(s, 'outputFile', 'output_file') || '',
    checkResult: pick(s, 'checkResult', 'check_result') || '',
  };
}

/**
 * The type of an event lives in two different places and this is the only
 * function allowed to care.
 *
 *   live over the websocket   { type: 'step.started', runId, ... }
 *   stored, from the API      { level, message, data: { type: 'step.started' } }
 *
 * If they are read differently the run page looks right while it streams and
 * then changes under you on the next refresh. So both go through here.
 */
function eventType(e) {
  if (!e) return 'log';
  const data = maybeJson(e.data);
  return e.type || (data && typeof data === 'object' && data.type) || 'log';
}

function normEvent(e) {
  const data = maybeJson(pick(e, 'data'));
  const type = eventType(e);
  let message = pick(e, 'message', 'msg') || '';
  // The server stores the event type as the message on state change rows, so
  // the log would otherwise read "run.started" at a human. Swap in real words.
  if (!message || message === type || /^(run|step|prompt)\.[a-z.]+$/.test(message)) {
    message = describeEvent(type, Object.assign({}, e, data));
  }
  return {
    id: pick(e, 'id'),
    runId: pick(e, 'runId', 'run_id'),
    ts: pick(e, 'ts', 'time', 'at') || new Date().toISOString(),
    level: pick(e, 'level') || (type === 'run.failed' || type === 'step.failed' ? 'error' : 'info'),
    message,
    type,
    data,
  };
}

/** A plain English line for an engine event that carries no message of its own. */
function describeEvent(type, msg) {
  const m = msg || {};
  const name = pick(m, 'name');
  const node = pick(m, 'nodeId', 'node_id', 'node');
  const nodeType = pick(m, 'nodeType', 'node_type');
  const which = name || node || '';
  const where = which ? ' ' + which + (nodeType ? ' (' + nodeType + ')' : '') : '';
  const slug = pick(m, 'slug');
  switch (type) {
    case 'run.started': return 'Run started' + (slug ? ' for ' + slug : '') + '.';
    case 'run.finished': return 'Run finished.';
    case 'run.failed': return 'Run failed. ' + (m.error || '');
    case 'run.waiting':
      if (m.reason === 'timer' || m.wakeAt) return 'Run parked on a timer.';
      return 'Run parked, waiting on Claude.';
    case 'run.resumed': return 'Run picked back up.';
    case 'run.cancelled': return 'Run cancelled.';
    case 'step.started': return 'Step started:' + (where || ' a step') + '.';
    case 'step.finished': return 'Step finished:' + (where || ' a step') + '.';
    case 'step.failed': return 'Step failed:' + (where || ' a step') + '. ' + (m.error || '');
    case 'prompt.new': return 'Prompt ' + (m.promptId || '') + ' is waiting for an answer.';
    case 'prompt.answered': return 'Prompt ' + (m.promptId || '') + ' was answered.';
    default: return type;
  }
}

function normPrompt(p) {
  return {
    id: pick(p, 'id', 'promptId', 'prompt_id'),
    runId: pick(p, 'runId', 'run_id'),
    stepId: pick(p, 'stepId', 'step_id'),
    nodeId: pick(p, 'nodeId', 'node_id') || '',
    slug: pick(p, 'slug', 'workflowSlug', 'workflow_slug') || '',
    system: pick(p, 'system') || '',
    prompt: pick(p, 'prompt') || '',
    expect: pick(p, 'expect') || 'text',
    schemaHint: pick(p, 'schemaHint', 'schema_hint') || '',
    answer: pick(p, 'answer') || '',
    status: pick(p, 'status') || 'waiting',
    retryCount: Number(pick(p, 'retryCount', 'retry_count') || 0),
    createdAt: pick(p, 'createdAt', 'created_at') || null,
    actor: pick(p, 'actor') || '',

    /* ------------------------------------------------------------------------
       THE REJECTED ANSWER SLOT.  Job 4.  Read this before changing it.

       When an answer is meant to be JSON and will not parse, the engine fails
       the step and puts the prompt back in the queue with retry_count + 1. The
       person answering the second time is then shown the same prompt with a
       small "retry 1" chip and nothing else. They cannot see what they sent
       last time and they cannot see what was wrong with it, which is exactly
       the one piece of information they need in order not to make the same
       mistake twice.

       The API does not carry it yet. It is a prompts table change (a
       `last_answer` and a `last_error` column, or a small `attempts` list) plus
       one line in the row mapper. That is a server job, not mine.

       When it lands, nothing here has to change: these three fields already
       read every likely name, and inboxView.drawDetail already renders the
       block whenever one of them holds something. The render site is marked
       with the same words, REJECTED ANSWER SLOT, so grep finds both ends.

       If the server picks a name none of these match, adding it is one word in
       the pick() list below. It is never a redesign.
       --------------------------------------------------------------------- */
    lastAnswer: pick(p, 'lastAnswer', 'last_answer', 'rejectedAnswer', 'rejected_answer',
      'previousAnswer', 'previous_answer') || '',
    lastError: pick(p, 'lastError', 'last_error', 'rejectReason', 'reject_reason',
      'rejectionReason', 'rejection_reason', 'error') || '',
    lastAnsweredAt: pick(p, 'lastAnsweredAt', 'last_answered_at', 'answeredAt', 'answered_at') || null,
  };
}

function normWorkflow(w) {
  const lastRun = pick(w, 'lastRun', 'last_run');
  let last = null;
  if (lastRun && typeof lastRun === 'object') last = normRun(lastRun);
  else if (typeof lastRun === 'string') last = { status: lastRun, id: null, startedAt: null };
  return {
    slug: pick(w, 'slug') || '',
    name: pick(w, 'name') || pick(w, 'slug') || 'Untitled',
    description: pick(w, 'description') || '',
    nodeCount: Number(pick(w, 'nodeCount', 'node_count') || 0),
    enabled: Number(pick(w, 'enabled') === false ? 0 : pick(w, 'enabled') === undefined ? 1 : (pick(w, 'enabled') ? 1 : 0)),
    lastRun: last,
  };
}

/* ----------------------------------------------------------------------------
   Shared state
   -------------------------------------------------------------------------- */

const store = {
  health: null,
  apiUp: true,
  apiMessage: '',
  waiting: 0,

  setApi(up, message) {
    const changed = this.apiUp !== up;
    this.apiUp = up;
    this.apiMessage = message || '';
    if (changed) { renderAlert(); renderHealth(); }
    if (changed && up) {
      // The server just came back. Every view refetches itself.
      if (current && current.refresh) current.refresh();
    }
  },

  setWaiting(n) {
    if (typeof n !== 'number' || isNaN(n)) return;
    this.waiting = n;
    const badge = $('#inbox-badge');
    if (!badge) return;
    badge.textContent = String(n);
    badge.hidden = n <= 0;
  },
};

function renderAlert() {
  const host = $('#alert-host');
  if (!host) return;
  if (store.apiUp) { host.innerHTML = ''; return; }
  host.innerHTML =
    '<div class="alert" role="alert">' +
      ICON.warn +
      '<div>' +
        '<p class="alert-title">The server is not answering.</p>' +
        '<p class="alert-note">' + esc(store.apiMessage || 'Nothing is reachable on this address.') +
        ' Start it with <code>node server/index.js</code> or <code>bin/aflow serve</code>. ' +
        'This page keeps trying on its own.</p>' +
      '</div>' +
      '<button class="btn btn-sm" type="button" id="alert-retry">Try now</button>' +
    '</div>';
  const btn = $('#alert-retry');
  if (btn) btn.addEventListener('click', () => { pollHealth(); live.connectNow(); });
}

/* ----------------------------------------------------------------------------
   The needs-you banner.

   A run blocked on a person is the only genuinely urgent state ARTHA FLOW
   has. Every other state (running, done, even failed) resolves itself or
   already happened. This one sits and waits for the owner, for as long as he
   does not look. So it does not live inside the workflows list like the
   three run cards do: it sits above every view, in #needs-you-host in
   index.html, outside the router entirely, and it is the loudest thing on
   the page whenever it has something to say.

   Same data the inbox view already draws from, GET /api/claude/pending, just
   read here too and kept sorted oldest first so the banner always leads with
   the prompt that has waited longest, which is the one that matters most.
   -------------------------------------------------------------------------- */

const needsYou = {
  items: [],

  async refresh() {
    try {
      const data = await api.get('/api/claude/pending');
      const list = asArray(data).map(normPrompt).filter((p) => p.id !== undefined);
      list.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      this.items = list;
      this.render();
    } catch {
      // A failed refresh leaves the last known banner up rather than blanking
      // it. If the prompt really was answered elsewhere, the next prompt.new
      // or prompt.answered event, or the 15s poll, corrects it.
    }
  },

  render() {
    const host = $('#needs-you-host');
    if (!host) return;
    // The inbox page is itself the full answer of "what needs you and why".
    // Repeating the same fact in a banner above it would not read as more
    // urgent, just as noise on the one screen already built to fix it.
    if (!this.items.length || location.hash.indexOf('#/inbox') === 0) {
      host.innerHTML = '';
      return;
    }

    const p = this.items[0];
    const more = this.items.length - 1;
    const ms = p.createdAt ? Math.max(0, Date.now() - new Date(p.createdAt).getTime()) : 0;
    const hrs = ms / 3600000;
    // An hour parked on a person is cold. Under that it is still fresh, worth
    // a look but not yet the thing that has been silently rotting.
    const severity = hrs >= 1 ? 'critical' : 'high';
    const big = hrs >= 1 ? Math.floor(hrs) : Math.max(1, Math.round(ms / 60000));
    const bigUnit = hrs >= 1 ? (Math.floor(hrs) === 1 ? 'HOUR' : 'HOURS') : 'MIN';

    host.innerHTML =
      '<div class="needs-you" data-severity="' + severity + '" role="alert">' +
        '<div class="needs-you-main">' +
          '<div class="needs-you-head">' +
            '<span class="gap-sev" data-severity="' + severity + '">Waiting on you</span>' +
            (p.slug ? '<span class="chip mono">' + esc(p.slug) + '</span>' : '') +
            (more > 0 ? '<span class="chip">+' + more + ' more waiting</span>' : '') +
          '</div>' +
          '<p class="needs-you-line">Prompt <span class="mono">#' + esc(p.id) +
            '</span> is parked and needs an answer before this run can carry on.</p>' +
          (p.prompt ? '<p class="needs-you-sub">' + esc(p.prompt.slice(0, 180)) +
            (p.prompt.length > 180 ? '…' : '') + '</p>' : '') +
        '</div>' +
        '<div class="needs-you-stuck">' +
          '<span class="needs-you-num mono">' + big + '</span>' +
          '<span class="needs-you-num-label">' + bigUnit + ' WAITING</span>' +
          '<a class="btn btn-primary" href="#/inbox/' + esc(p.id) + '">' + ICON.play + ' Answer it</a>' +
        '</div>' +
      '</div>';
  },
};
needsYou.softRefresh = throttled(() => needsYou.refresh(), 2000);

/* ----------------------------------------------------------------------------
   Live connection.

   Reconnect backoff runs 400ms, 800ms, 1.6s and so on up to 10s, with a little
   jitter so a restarted server does not get every tab knocking at once. The dot
   never says green unless a socket is genuinely open.
   -------------------------------------------------------------------------- */

const live = {
  ws: null,
  tries: 0,
  timer: null,
  wantRunId: null,
  closed: false,

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  },

  setState(state, text) {
    const el = $('#conn');
    if (!el) return;
    el.dataset.state = state;
    $('#conn-text').textContent = text;
  },

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this.timer);
    this.setState(this.tries === 0 ? 'wait' : 'wait',
      this.tries === 0 ? 'Connecting' : 'Reconnecting');
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch (err) {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.tries = 0;
      this.setState('live', 'Live');
      this.subscribe();
      // A socket that opens means the server is up, whatever fetch thought.
      pollHealth();
      if (current && current.refresh) current.refresh();
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleLiveMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.setState('down', 'Offline');
      this.scheduleRetry();
    };

    ws.onerror = () => {
      // onclose always follows, so the retry is scheduled there.
    };
  },

  scheduleRetry() {
    clearTimeout(this.timer);
    this.tries += 1;
    const base = Math.min(10000, 400 * Math.pow(2, Math.min(this.tries, 5)));
    const wait = base + Math.random() * 250;
    this.setState('down', 'Retrying in ' + Math.round(wait / 1000) + 's');
    this.timer = setTimeout(() => this.connect(), wait);
  },

  connectNow() {
    this.tries = 0;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connect();
  },

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  },

  /** Subscribe to one run when a run page is open, otherwise to everything. */
  subscribe(runId) {
    if (runId !== undefined) this.wantRunId = runId;
    if (this.wantRunId) this.send({ type: 'subscribe', runId: Number(this.wantRunId) });
    this.send({ type: 'subscribe', all: true });
  },
};

function handleLiveMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'hello') {
    if (typeof msg.waitingPrompts === 'number') store.setWaiting(msg.waitingPrompts);
    if (msg.version) {
      store.health = Object.assign({}, store.health, { version: msg.version });
      renderHealth();
    }
    needsYou.softRefresh();
    return;
  }

  // The inbox count follows the prompt events wherever we are on the page.
  if (msg.type === 'prompt.new') store.setWaiting(store.waiting + 1);
  if (msg.type === 'prompt.answered') store.setWaiting(Math.max(0, store.waiting - 1));

  // The needs-you banner follows the same events, wherever we are on the
  // page, because it lives outside the router.
  if (msg.type === 'prompt.new' || msg.type === 'prompt.answered' ||
      msg.type === 'run.waiting' || msg.type === 'run.failed' ||
      msg.type === 'run.cancelled') {
    needsYou.softRefresh();
  }

  if (current && current.event) {
    try { current.event(msg); } catch (err) { console.error('view event failed', err); }
  }
}

/* ----------------------------------------------------------------------------
   Health. Polled slowly, and it is also how we notice the server coming back
   when the websocket is down as well.
   -------------------------------------------------------------------------- */

async function pollHealth() {
  try {
    const h = await api.get('/api/health');
    store.health = h;
    if (typeof h.waitingPrompts === 'number') store.setWaiting(h.waitingPrompts);
    renderHealth();
  } catch (err) {
    renderHealth();
  }
}

function renderHealth() {
  const el = $('#health-meta');
  if (!el) return;
  const h = store.health;
  if (!store.apiUp || !h) { el.textContent = ''; return; }
  const bits = [];
  if (h.version) bits.push('v' + h.version);
  if (h.uptimeSec !== undefined) bits.push('up ' + fmtUptime(h.uptimeSec));
  el.textContent = bits.join('  ');
}

/* ----------------------------------------------------------------------------
   A throttle used for "something changed, go and check with the server".
   Leading edge fires at once, the rest are folded into one later call.
   -------------------------------------------------------------------------- */

function throttled(fn, gap) {
  let last = 0;
  let timer = null;
  return function trigger() {
    const now = Date.now();
    if (now - last >= gap) {
      last = now;
      fn();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      fn();
    }, gap - (now - last));
  };
}

/** One ticker for the whole page, so a hundred live durations cost one timer. */
const ticker = {
  els: new Set(),
  timer: null,
  add(el) {
    this.els.add(el);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  },
  clear() {
    this.els.clear();
    clearInterval(this.timer);
    this.timer = null;
  },
  tick() {
    for (const el of this.els) {
      if (!el.isConnected) { this.els.delete(el); continue; }
      const since = el.dataset.since;
      if (!since) continue;
      // data-prefix lets one ticker say "waiting 4m 37s" as well as "4m 37s".
      el.textContent = (el.dataset.prefix || '') + fmtMs(durMs(since, null));
    }
    if (!this.els.size) { clearInterval(this.timer); this.timer = null; }
  },
};

/* ----------------------------------------------------------------------------
   Shared bits of markup
   -------------------------------------------------------------------------- */

function pill(status, labelOverride) {
  const label = labelOverride !== undefined && labelOverride !== null
    ? labelOverride
    : String(status || '').replace(/_/g, ' ');
  return '<span class="pill" data-status="' + esc(status) + '">' + esc(label) + '</span>';
}

/* ----------------------------------------------------------------------------
   Parked is not running. This is the rule the whole page hangs on.

   The server is not wrong about the data. A step that has started and has no
   end time is `running` in the steps table, and that is exactly right for a
   database. The problem is only what it looks like.

   Blue RUNNING with a timer counting up means one thing to a person: the
   machine is busy on this right now. So the first thought when it sits there
   for twenty minutes is that it has hung, and the next thing they do is kill a
   run that was perfectly healthy and simply waiting to be answered.

   So: while a run is parked, nothing on the page is allowed to be blue.

     run waiting_on_claude   the claude node is amber WAITING, "waiting 4m 37s"
     run waiting_on_timer    the wait node is violet WAITING, "waiting until 14:30"

   The `each` and `sub` steps wrapping a parked node are also still `running` in
   the table, because they really have not finished. They are not computing
   either, so they get the same treatment with the same colour. One rule, no
   exceptions: parked run plus running step means waiting, never running.
   -------------------------------------------------------------------------- */

const PARKED_RUN = { waiting_on_claude: 1, waiting_on_timer: 1 };

/**
 * What a step should look like, given the run it belongs to. Returns null when
 * the step is genuinely running and should stay blue.
 *
 * @returns {null|{status:string,label:string,text:string,prefix:string,since:string|null}}
 */
function parkedLook(step, run) {
  if (!step || !run) return null;
  if (step.status !== 'running') return null;
  if (!PARKED_RUN[run.status]) return null;

  // A wait node is violet whichever way the run is labelled, and a timer parked
  // run is violet whatever node it stopped on. Everything else parked is amber,
  // which is the colour of "a person can do something about this".
  const timer = run.status === 'waiting_on_timer' || step.nodeType === 'wait';
  const status = timer ? 'waiting_on_timer' : 'waiting_on_claude';

  if (timer) {
    // Say the wake up time if the server told us one. "waiting until 14:30" is
    // a fact somebody can plan around. A count up is not.
    const wake = pick(run, 'wakeAt', 'wake_at') ||
      (step.input && typeof step.input === 'object' ? step.input.until : null);
    const d = wake ? new Date(wake) : null;
    if (d && !isNaN(d)) {
      return {
        status, label: 'waiting', since: null, prefix: '',
        text: 'waiting until ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
      };
    }
  }
  // "make the agents visible", 2026-09-17: name the role that is being
  // waited on, not just "waiting", so it is obvious which agent this park
  // is sitting on.
  const waitingFor = step.role ? 'waiting for ' + step.role : 'waiting';
  return {
    status, label: waitingFor, since: step.startedAt || null, prefix: 'waiting ',
    text: 'waiting ' + fmtMs(durMs(step.startedAt, null)),
  };
}

function emptyBlock(title, note, action) {
  return '<div class="empty">' + ICON.empty +
    '<p class="empty-title">' + esc(title) + '</p>' +
    '<p class="empty-note">' + note + '</p>' +
    (action || '') + '</div>';
}

function errorBlock(err, retryId) {
  const msg = err && err.message ? err.message : 'Something went wrong.';
  return '<div class="empty">' + ICON.warn +
    '<p class="empty-title">Could not load this.</p>' +
    '<p class="empty-note">' + esc(msg) + '</p>' +
    '<button class="btn" type="button" id="' + esc(retryId || 'retry') + '">Try again</button></div>';
}

/**
 * A collapsible JSON block. The <pre> is only built the first time it is
 * opened, so a step holding a big payload costs nothing until it is asked for.
 */
function jsonDetails(label, value, openKey, openSet) {
  if (value === undefined || value === null || value === '') return '';
  const open = openSet && openSet.has(openKey);
  return '<details class="json-d"' + (open ? ' open' : '') +
    ' data-openkey="' + esc(openKey) + '">' +
    '<summary>' + esc(label) + '</summary>' +
    '<div class="json-slot" data-json="1"></div></details>';
}

/** Fills in every json slot whose details is open, and wires the toggles. */
function wireJson(root, valueFor, openSet) {
  $$('details.json-d', root).forEach((d) => {
    const key = d.dataset.openkey;
    const slot = $('.json-slot', d);
    const fill = () => {
      if (slot.dataset.filled === '1') return;
      const { text, cut, total } = jsonText(valueFor(key));
      slot.innerHTML =
        (cut ? '<p class="code-note">Showing the first ' + JSON_CAP.toLocaleString() +
          ' characters of ' + total.toLocaleString() + '.</p>' : '') +
        '<pre class="code">' + esc(text) + '</pre>';
      slot.dataset.filled = '1';
    };
    if (d.open) fill();
    d.addEventListener('toggle', () => {
      if (d.open) { fill(); if (openSet) openSet.add(key); }
      else if (openSet) openSet.delete(key);
    });
  });
}

/* ----------------------------------------------------------------------------
   View 1: workflows
   -------------------------------------------------------------------------- */

const workflowsView = {
  root: null,
  items: [],

  async mount(root) {
    this.root = root;
    root.innerHTML = '<div class="page"><div class="page-head">' +
      '<div><h1 class="page-title">Workflows</h1>' +
      '<p class="page-sub">Every workflow the server has loaded. Pick one and run it.</p></div>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm" type="button" id="wf-refresh">Refresh</button>' +
      '</div><div id="wf-body"></div></div>';
    $('#wf-refresh').addEventListener('click', () => this.refresh());
    await this.refresh();
  },

  unmount() { this.root = null; },

  event(msg) {
    // A run finishing changes the "last run" badge on a card.
    if (msg.type === 'run.finished' || msg.type === 'run.failed' ||
        msg.type === 'run.started' || msg.type === 'run.cancelled') {
      this.softRefresh();
    }
  },

  async refresh() {
    const body = this.root && $('#wf-body', this.root);
    if (!body) return;
    if (!this.items.length) body.innerHTML = '<div class="empty"><p class="empty-title">Loading</p></div>';
    try {
      const data = await api.get('/api/workflows');
      this.items = asArray(data).map(normWorkflow);
      this.draw();
    } catch (err) {
      body.innerHTML = errorBlock(err, 'wf-retry');
      const b = $('#wf-retry', body);
      if (b) b.addEventListener('click', () => this.refresh());
    }
  },

  softRefresh: null,

  draw() {
    const body = this.root && $('#wf-body', this.root);
    if (!body) return;
    if (!this.items.length) {
      body.innerHTML = emptyBlock(
        'No workflows yet.',
        'Drop a workflow JSON file into <code>workflows/</code> and restart the server, ' +
        'or send one to <code>PUT /api/workflows/&lt;slug&gt;</code>.');
      return;
    }
    body.innerHTML = '<div class="cards">' + this.items.map((w) => this.card(w)).join('') + '</div>';
    $$('[data-run-slug]', body).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openRunDialog(btn.dataset.runSlug);
      });
    });
    $$('[data-open-run]', body).forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = '#/runs/' + a.dataset.openRun;
      });
    });
  },

  card(w) {
    const last = w.lastRun;
    let lastBit = '<span class="chip">never run</span>';
    if (last && last.status) {
      const when = last.startedAt ? ' <span class="faint">' + esc(ago(last.startedAt)) + '</span>' : '';
      const inner = pill(last.status) + when;
      lastBit = last.id
        ? '<a href="#/runs/' + esc(last.id) + '" data-open-run="' + esc(last.id) +
          '" class="card-meta">' + inner + '</a>'
        : '<span class="card-meta">' + inner + '</span>';
    }
    return '<article class="panel card" data-enabled="' + esc(w.enabled) + '">' +
      '<div class="card-top"><div class="grow">' +
        '<h2 class="card-name"><a href="#/workflows/' + encodeURIComponent(w.slug) + '">' +
          esc(w.name) + '</a></h2>' +
        '<p class="card-slug">' + esc(w.slug) + '</p>' +
      '</div>' + (w.enabled ? '' : '<span class="chip">off</span>') + '</div>' +
      '<p class="card-desc">' + esc(w.description || 'No description.') + '</p>' +
      '<div class="card-meta">' +
        '<span class="chip">' + esc(w.nodeCount) + ' node' + (w.nodeCount === 1 ? '' : 's') + '</span>' +
        lastBit +
      '</div>' +
      '<div class="card-foot">' +
        '<button class="btn btn-primary" type="button" data-run-slug="' + esc(w.slug) + '">' +
          ICON.play + ' Run</button>' +
        '<a class="btn" href="#/workflows/' + encodeURIComponent(w.slug) + '">Open</a>' +
        '<span class="spacer"></span>' +
        '<a class="btn btn-ghost btn-sm" href="#/runs?slug=' + encodeURIComponent(w.slug) + '">Runs</a>' +
      '</div>' +
    '</article>';
  },
};
workflowsView.softRefresh = throttled(() => workflowsView.refresh(), 3000);

/* --- the run input dialog ------------------------------------------------- */

let dialogSlug = null;

async function openRunDialog(slug) {
  const dlg = $('#run-dialog');
  dialogSlug = slug;
  $('#run-dialog-title').textContent = slug;
  $('#run-error').hidden = true;
  const ta = $('#run-input');
  ta.value = '{}';
  if (typeof dlg.showModal === 'function') dlg.showModal();

  // Pull the full definition so the box is prefilled with the real input block.
  try {
    const def = await api.get('/api/workflows/' + encodeURIComponent(slug));
    const input = (def && def.input) || (def && def.definition && def.definition.input) || {};
    ta.value = JSON.stringify(input, null, 2);
  } catch (err) {
    ta.value = '{}';
    showRunError('Could not read the workflow input block: ' + err.message);
  }
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function showRunError(msg) {
  const p = $('#run-error');
  p.textContent = msg;
  p.hidden = false;
}

async function submitRunDialog() {
  const ta = $('#run-input');
  let input;
  try {
    input = ta.value.trim() ? JSON.parse(ta.value) : {};
  } catch (err) {
    showRunError('That is not valid JSON: ' + err.message);
    return;
  }
  const go = $('#run-go');
  go.disabled = true;
  go.textContent = 'Starting';
  try {
    const res = await api.post('/api/workflows/' + encodeURIComponent(dialogSlug) + '/run', { input });
    const runId = pick(res, 'runId', 'id', 'run_id');
    $('#run-dialog').close();
    toast('Run ' + runId + ' started.', 'good');
    if (runId !== undefined) location.hash = '#/runs/' + runId;
  } catch (err) {
    showRunError(err.message);
  } finally {
    go.disabled = false;
    go.innerHTML = 'Run it';
  }
}

function wireDialog() {
  const dlg = $('#run-dialog');
  if (!dlg) return;
  $('#run-go').addEventListener('click', submitRunDialog);
  $('#run-close').addEventListener('click', () => dlg.close());
  $('#run-cancel').addEventListener('click', () => dlg.close());
  $('#run-input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitRunDialog(); }
  });
}

/* ----------------------------------------------------------------------------
   The node registry, fetched once and kept.

   Every label, every config field, every piece of help text on the workflow
   page comes from GET /api/nodes. Nothing about a node type is written into
   this file. That is the whole design rule for this screen: a new node type
   lands in server/nodes/, it appears here with its own form and its own help,
   and nobody edits the UI.

   NODE_LABEL further up is a fallback for when the registry has not arrived
   yet or the server is down, not a source of truth.
   -------------------------------------------------------------------------- */

const nodeRegistry = {
  byType: null,
  inflight: null,

  load() {
    if (this.byType) return Promise.resolve(this.byType);
    if (!this.inflight) {
      this.inflight = api.get('/api/nodes').then((data) => {
        const map = {};
        for (const n of asArray(data)) {
          if (n && n.type) map[String(n.type)] = n;
        }
        this.byType = map;
        this.inflight = null;
        return map;
      }).catch((err) => {
        this.inflight = null;
        throw err;
      });
    }
    return this.inflight;
  },

  meta(type) {
    if (!this.byType || !type) return null;
    return this.byType[String(type)] || null;
  },
};

/* ----------------------------------------------------------------------------
   The landscape canvas.

   graph-layout.js and graph-canvas.js are built by two other agents, at the
   same time as this file. They may not exist yet when this page loads, or
   they may have a mistake in them. Neither is allowed to take the rest of the
   app down, so nothing here is a static import. A static import that fails to
   parse breaks the whole module, which breaks every view, not just the two
   that want a canvas.

   So both are asked for with a dynamic import, the promise is kept once, and
   any view that wants the canvas awaits canvasModules() and checks `.ok`
   before touching either function. `.ok` false, or the functions throwing once
   called, both mean the same thing: draw the stacked list instead, and say so
   quietly. That fallback is not optional.
   -------------------------------------------------------------------------- */

let canvasModulesPromise = null;

function canvasModules() {
  if (!canvasModulesPromise) {
    canvasModulesPromise = Promise.all([
      import('./graph-layout.js').catch((err) => {
        console.error('graph-layout.js did not load', err);
        return null;
      }),
      import('./graph-canvas.js').catch((err) => {
        console.error('graph-canvas.js did not load', err);
        return null;
      }),
    ]).then(([layoutMod, canvasMod]) => {
      const layoutFn = layoutMod && typeof layoutMod.layout === 'function' ? layoutMod.layout : null;
      const createCanvasFn = canvasMod && typeof canvasMod.createCanvas === 'function'
        ? canvasMod.createCanvas : null;
      return { layout: layoutFn, createCanvas: createCanvasFn, ok: Boolean(layoutFn && createCanvasFn) };
    });
  }
  return canvasModulesPromise;
}

/** Busts the cached attempt, so a person can retry after the files land. */
function resetCanvasModules() { canvasModulesPromise = null; }

/* ----------------------------------------------------------------------------
   Turning a flat node list into something a person can read.

   The file format is a flat array joined by `next`, which is right for a
   machine and useless to look at. linkedin-leads has 27 nodes and eleven
   distinct paths through them, and a plain list of 27 rows hides every one of
   the branches.

   So the graph is cut into chains. A chain is a run of nodes that follow each
   other with nothing else joining in. A new chain starts at:

     - the workflow start
     - the false side of a filter          (`elseNext`)
     - the body of an each loop            (`config.body`)
     - anything left over that nothing points at   (an orphan, which is a bug
       in the workflow, so it is shown loudly rather than hidden)

   A chain stops when it hits the end, or when it reaches a node that is
   already in another chain. That second case is a join, and it is the one a
   flat list can never show: two dropped branches both ending at the same
   "write the dropped row" node is the difference between reading this screen
   and opening the JSON.
   -------------------------------------------------------------------------- */

function buildChains(def) {
  const nodes = Array.isArray(def && def.nodes) ? def.nodes : [];
  const byId = new Map();
  const dupes = [];
  for (const n of nodes) {
    if (!n || n.id === undefined || n.id === null) continue;
    const id = String(n.id);
    if (byId.has(id)) dupes.push(id);
    else byId.set(id, n);
  }

  const chains = [];
  const placed = new Map();          // node id -> chain index
  const jobs = [];                   // chains still to walk
  const queued = new Set();

  const startNode = nodes.find((n) => n && n.start === true) || nodes[0];
  if (startNode && startNode.id !== undefined) {
    jobs.push({
      startId: String(startNode.id), title: 'Main path', kind: 'main', note: '',
      entry: { kind: 'start' },
    });
    queued.add(String(startNode.id));
  }

  // `entry` says what points at the top of this chain. Adding a step at the
  // head of a chain has to rewire that pointer, not a `next`, so it is
  // recorded here rather than worked out again later.
  function push(targetId, title, kind, note, entry) {
    if (targetId === null || targetId === undefined) return;
    const id = String(targetId);
    if (queued.has(id)) return;
    queued.add(id);
    jobs.push({ startId: id, title, kind, note, entry });
  }

  const nameOf = (n) => (n && (n.name || n.id)) || '';

  while (jobs.length) {
    const job = jobs.shift();
    if (!byId.has(job.startId)) {
      chains.push({
        index: chains.length, title: job.title, kind: 'broken', note: job.note,
        entry: job.entry || null, items: [], tail: { kind: 'missing', id: job.startId },
      });
      continue;
    }
    if (placed.has(job.startId)) continue;   // it turned out to be a join

    const chain = {
      index: chains.length, title: job.title, kind: job.kind, note: job.note,
      entry: job.entry || null, items: [], tail: null,
    };
    chains.push(chain);

    let cur = job.startId;
    const guard = new Set();
    for (;;) {
      if (cur === null || cur === undefined) { chain.tail = { kind: 'end' }; break; }
      const id = String(cur);
      if (!byId.has(id)) { chain.tail = { kind: 'missing', id }; break; }
      if (guard.has(id)) { chain.tail = { kind: 'loop', id }; break; }
      if (placed.has(id)) { chain.tail = { kind: 'join', id }; break; }

      guard.add(id);
      placed.set(id, chain.index);
      const n = byId.get(id);
      chain.items.push(n);

      if (n.type === 'filter') {
        // The false side is its own chain. The true side carries on here.
        push(n.elseNext, 'When "' + nameOf(n) + '" is false', 'else',
          'The false side of filter ' + id + '.', { kind: 'else', fromId: id });
        cur = n.next === undefined ? null : n.next;
      } else if (n.type === 'each') {
        // The loop body is a separate chain that runs once per item.
        const body = n.config && n.config.body;
        push(body, 'Loop body of "' + nameOf(n) + '"', 'body',
          'Runs once for every item. When the list is finished the run carries ' +
          'on at the node after ' + id + '.', { kind: 'body', fromId: id });
        cur = n.next === undefined ? null : n.next;
      } else {
        cur = n.next === undefined ? null : n.next;
      }
    }
  }

  // Anything nothing points at. A workflow with one of these has a node that
  // can never run, and that is worth shouting about, not hiding.
  const orphans = [];
  for (const [id, n] of byId) {
    if (!placed.has(id)) orphans.push(n);
  }
  if (orphans.length) {
    chains.push({
      index: chains.length, kind: 'orphan',
      title: 'Nothing reaches these',
      note: 'No path leads to these nodes, so they can never run. Either a ' +
            '"next" is pointing somewhere else, or they are left over.',
      entry: null, items: orphans, tail: { kind: 'end' },
    });
    for (const n of orphans) placed.set(String(n.id), chains.length - 1);
  }

  return { nodes, byId, chains, placed, dupes, startId: startNode ? String(startNode.id) : null };
}

/** Marks up {{ template tags }} inside an already escaped string. */
function markTemplates(escaped) {
  return String(escaped).replace(/\{\{[^{}]*\}\}/g, (m) => '<span class="tpl">' + m + '</span>');
}

/** One config value, shown as text a person can read rather than raw JSON. */
function configValueHtml(value) {
  if (value === undefined) return '';
  if (value === null) return '<span class="faint">null</span>';
  if (typeof value === 'string') {
    if (!value) return '<span class="faint">empty</span>';
    return '<pre class="cfg-val">' + markTemplates(esc(value)) + '</pre>';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return '<span class="cfg-scalar mono">' + esc(String(value)) + '</span>';
  }
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return '<pre class="cfg-val">' + markTemplates(esc(text)) + '</pre>';
}

/**
 * The config block for one node, drawn from the type's configSchema.
 *
 * Three things it has to get right, all of them from the schema and never from
 * a list in this file:
 *
 *   - a key the schema knows about gets its type, whether it is required, its
 *     default, and its help line
 *   - a required key with nothing set is called out in red, because that node
 *     will fail the moment the run reaches it
 *   - a key the schema does not know about is still shown, and marked, because
 *     hiding it would mean a typo silently disappears off this screen
 */
function nodeConfigHtml(node, meta) {
  const schema = (meta && meta.configSchema) || {};
  const cfg = (node && node.config) || {};
  const keys = Object.keys(schema);
  for (const k of Object.keys(cfg)) if (keys.indexOf(k) === -1) keys.push(k);

  if (!keys.length) {
    return '<p class="cfg-none">' +
      (meta ? 'This node takes no config.'
            : 'No config, and the server does not know this node type, so there is ' +
              'nothing to check it against.') + '</p>';
  }

  const rows = keys.map((k) => {
    const spec = schema[k];
    const has = Object.prototype.hasOwnProperty.call(cfg, k) &&
      cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '';
    const required = Boolean(spec && spec.required);
    const missing = required && !has;

    const chips =
      (spec && spec.type ? '<span class="chip">' + esc(spec.type) + '</span>' : '') +
      (required ? '<span class="chip chip-req">required</span>' : '') +
      (!spec ? '<span class="chip chip-warn">not in the schema</span>' : '');

    let valueHtml;
    if (has) {
      valueHtml = configValueHtml(cfg[k]);
    } else if (spec && spec.default !== undefined) {
      valueHtml = '<p class="cfg-default">Not set, so it uses the default: ' +
        '<span class="mono">' + esc(JSON.stringify(spec.default)) + '</span></p>';
    } else if (missing) {
      valueHtml = '<p class="cfg-missing">This is required and it is not set. ' +
        'The run fails when it reaches this node.</p>';
    } else {
      valueHtml = '<p class="cfg-default">Not set.</p>';
    }

    return '<div class="cfg-row' + (missing ? ' is-missing' : '') + '">' +
      '<div class="cfg-key">' +
        '<span class="cfg-name mono">' + esc(k) + '</span>' + chips +
      '</div>' +
      (spec && spec.help ? '<p class="cfg-help">' + esc(spec.help) + '</p>' : '') +
      valueHtml +
    '</div>';
  }).join('');

  return '<div class="cfg-list">' + rows + '</div>';
}

/* ----------------------------------------------------------------------------
   How loud a node is drawn.

   the owner's words: this is a chain of prompts with plumbing between them. So the
   page is ranked by how much a person cares about the thing, not by how the
   engine sees it:

     tier 1, "asks"       the prompt text itself, big and readable. This IS the
                          work. A claude node is not a box saying type: claude.
     tier 2, "decides"    gates, loops, waits, calls to other workflows. The
                          shape of the run depends on these, so they are legible
                          but quieter.
     tier 3, "plumbing"   logs, transforms, writes, http. Needed, dull, one line
                          each, with the detail folded away.

   The tier is worked out from the type's configSchema, never from a list of
   type names in this file. A node type with a `prompt` key is a prompt,
   whatever it is called. A node with two ways out, or one that parks the run,
   or one that calls another workflow, is a decision. That way a node type
   nobody has written yet still lands in the right tier on the day it appears.
   -------------------------------------------------------------------------- */

/**
 * Node types the registry cannot tell apart on its own, and the tier they
 * belong in. Right now that is one type.
 *
 * `filter` and `transform` both declare exactly one config key called
 * `expression`, so nothing in GET /api/nodes separates a gate that sends the
 * run down two different roads from a line of arithmetic. Reading the prose in
 * `description` to guess would be worse than saying it out loud here.
 *
 * The right fix is on the server, and it is small: one more field on `meta`,
 * something like `branches: true` on filter and each, so the UI can rank a node
 * by what it does to the flow rather than by a name. `nodeTier` already reads
 * `meta.branches` and `meta.flow` if either ever turns up, so the day that
 * lands this list can be deleted and nothing else changes. Reported to the
 * coordinator as a server side suggestion, not a bug.
 *
 * Note this only matters in the add a step picker, where there is no node yet.
 * A real filter inside a real workflow carries `elseNext`, which is read below
 * and is proof rather than a guess.
 */
const TIER_FALLBACK = { filter: 2 };

function nodeTier(node, meta) {
  const schema = (meta && meta.configSchema) || {};
  const cfg = (node && node.config) || {};

  // Tier 1. It asks a question and waits for words back. That is the product.
  if (schema.prompt || cfg.prompt !== undefined) return 1;

  // Tier 2. It decides where the run goes, parks it, or hands it to another
  // workflow. Read from the server first if the server ever says so.
  if (meta && (meta.branches === true || meta.flow === true)) return 2;

  // Proof, not a guess: this node really does have a second way out.
  if (node && node.elseNext !== undefined) return 2;
  if (cfg.body !== undefined && cfg.items !== undefined) return 2;

  // A loop needs BOTH a list and a body. Checking `body` on its own is what
  // put an http request in with the gates, because an http request has a
  // `body` too and it means something completely different.
  if (schema.items && schema.body) return 2;
  if (schema.slug) return 2;                        // calls another workflow
  if (schema.until || schema.forSeconds) return 2;  // parks on a clock

  if (node && node.type && TIER_FALLBACK[node.type]) return TIER_FALLBACK[node.type];

  // Tier 3. Plumbing. Needed, dull, and it gets out of the way.
  return 3;
}

/**
 * The one config key worth showing on a folded plumbing row. It is the first
 * required key in the schema, so `log` shows its message, `write` shows its
 * path and `http` shows its url, and a new node type shows whatever it says
 * matters most. No list of type names here either.
 */
function headlineKey(node, meta) {
  const schema = (meta && meta.configSchema) || {};
  for (const k of Object.keys(schema)) {
    if (schema[k] && schema[k].required) return k;
  }
  const cfg = (node && node.config) || {};
  const keys = Object.keys(cfg);
  return keys.length ? keys[0] : null;
}

function oneLine(value, cap) {
  if (value === undefined || value === null) return '';
  let t;
  if (typeof value === 'string') t = value;
  else { try { t = JSON.stringify(value); } catch { t = String(value); } }
  t = t.replace(/\s+/g, ' ').trim();
  const max = cap || 120;
  return t.length > max ? t.slice(0, max) + '...' : t;
}

/* ----------------------------------------------------------------------------
   View 5: one workflow.  #/workflows/:slug

   This is the screen somebody opens when a run failed at node "n4" and they
   have no idea what n4 is. Before it existed the only answer was to go and
   open a JSON file by hand.
   -------------------------------------------------------------------------- */

/** The view a workflow page opens in, remembered across visits. Canvas is the
 *  default per the contract: n8n style cards in a row beats a stacked list for
 *  seeing the shape of a workflow, the list stays for reading long prompts. */
const WF_VIEW_KEY = 'aflow.wf.view';
function loadViewMode() {
  try { return localStorage.getItem(WF_VIEW_KEY) === 'list' ? 'list' : 'canvas'; }
  catch { return 'canvas'; }
}

const workflowView = {
  root: null,
  slug: null,
  def: null,
  graph: null,
  runs: [],
  expanded: false,
  editorOpen: false,
  editorChecked: null,
  viewMode: 'canvas',
  canvasUnavailable: false,
  canvas: null,
  canvasApi: null,
  selectedNodeId: null,

  async mount(root, params) {
    this.root = root;
    this.slug = params && params.id ? String(params.id) : '';
    this.def = null;
    this.graph = null;
    this.runs = [];
    this.expanded = false;
    this.editorOpen = false;
    this.editorChecked = null;
    this.viewMode = loadViewMode();
    this.canvasUnavailable = false;
    this.canvas = null;
    this.canvasApi = null;
    this.selectedNodeId = null;

    root.innerHTML = '<div class="page wide">' +
      '<a class="back-link" href="#/workflows">' + ICON.back + ' All workflows</a>' +
      '<div id="wfd-head"></div>' +
      '<div id="wfd-body"><div class="empty"><p class="empty-title">Loading</p></div></div>' +
    '</div>';

    await this.refresh();
  },

  unmount() {
    if (this.canvas) { try { this.canvas.destroy(); } catch (err) { console.error(err); } this.canvas = null; }
    this.root = null;
    ticker.clear();
  },

  event(msg) {
    // Only the run list at the bottom moves on its own.
    if (msg.type && msg.type.indexOf('run.') === 0) this.softRefreshRuns();
  },

  softRefreshRuns: null,

  async refresh() {
    if (!this.root) return;
    const body = $('#wfd-body', this.root);
    try {
      // The registry is asked for at the same time as the definition, and a
      // registry that fails does not stop the page: the chain still draws, the
      // config just loses its help text.
      const [def] = await Promise.all([
        api.get('/api/workflows/' + encodeURIComponent(this.slug)),
        nodeRegistry.load().catch(() => null),
      ]);
      this.def = (def && def.definition && def.definition.nodes) ? def.definition : def;
      this.graph = buildChains(this.def);
      this.draw();
      this.refreshRuns();
    } catch (err) {
      if (body) {
        body.innerHTML = errorBlock(err, 'wfd-retry');
        const b = $('#wfd-retry', body);
        if (b) b.addEventListener('click', () => this.refresh());
      }
      const head = $('#wfd-head', this.root);
      if (head) head.innerHTML = '';
    }
  },

  async refreshRuns() {
    if (!this.root || !this.def) return;
    const host = $('#wfd-runs', this.root);
    if (!host) return;
    try {
      const data = await api.get('/api/runs?limit=5&slug=' + encodeURIComponent(this.slug));
      this.runs = asArray(data).map(normRun).filter((r) => r && r.id !== undefined).slice(0, 5);
      this.drawRuns();
    } catch (err) {
      host.innerHTML = '<p class="list-note">Could not load the runs: ' + esc(err.message) + '</p>';
    }
  },

  /* --- drawing --- */

  draw() {
    const head = $('#wfd-head', this.root);
    const body = $('#wfd-body', this.root);
    if (!head || !body) return;
    const d = this.def || {};
    const g = this.graph || { chains: [], nodes: [], dupes: [] };

    const types = {};
    for (const n of g.nodes) if (n && n.type) types[n.type] = (types[n.type] || 0) + 1;
    const typeChips = Object.keys(types).sort().map((t) =>
      '<span class="chip" title="' + esc(nodeLabel(t)) + '">' + esc(t) + ' ' + types[t] + '</span>').join('');

    head.innerHTML = '<div class="run-head">' +
      '<div class="grow">' +
        '<h1 class="page-title">' + esc(d.name || this.slug) + '</h1>' +
        '<p class="card-slug">' + esc(this.slug) + '</p>' +
        '<p class="page-sub" style="max-width:70ch">' + esc(d.description || 'No description.') + '</p>' +
      '</div>' +
      '<div class="run-actions">' +
        '<button class="btn btn-primary" type="button" id="wfd-run">' + ICON.play + ' Run</button>' +
        '<a class="btn" href="#/runs?slug=' + encodeURIComponent(this.slug) + '">All runs</a>' +
      '</div>' +
    '</div>' +
    '<div class="wfd-facts">' +
      '<span class="chip">' + esc(g.nodes.length) + ' node' + (g.nodes.length === 1 ? '' : 's') + '</span>' +
      '<span class="chip">' + esc(g.chains.length) + ' path' + (g.chains.length === 1 ? '' : 's') + '</span>' +
      '<span class="chip">trigger ' + esc((d.trigger && d.trigger.type) || 'manual') + '</span>' +
      typeChips +
    '</div>' +
    (g.dupes.length
      ? '<p class="wfd-warn">Two nodes share the id ' +
        esc(g.dupes.join(', ')) + '. Only the first one of each is used.</p>' : '');

    const runBtn = $('#wfd-run', head);
    if (runBtn) runBtn.addEventListener('click', () => openRunDialog(this.slug));

    const canvasMode = this.viewMode === 'canvas' && !this.canvasUnavailable;

    body.innerHTML =
      '<div class="panel wfd-panel">' +
        '<div class="panel-head">' +
          '<span class="eyebrow">The chain</span>' +
          '<span class="spacer"></span>' +
          this.viewToggleHtml(canvasMode) +
          (canvasMode ? '' : '<button class="btn btn-sm" type="button" id="wfd-expand">Open every config</button>') +
        '</div>' +
        (canvasMode ? this.canvasAreaHtml() : '<div class="wfd-chains" id="wfd-chains">' + this.chainsHtml() + '</div>') +
      '</div>' +
      '<div class="panel wfd-panel">' +
        '<div class="panel-head"><span class="eyebrow">Last five runs</span>' +
          '<span class="spacer"></span>' +
          '<a class="btn btn-sm" href="#/runs?slug=' + encodeURIComponent(this.slug) + '">See all</a>' +
        '</div>' +
        '<div id="wfd-runs"><p class="list-note">Loading</p></div>' +
      '</div>' +
      this.editorHtml() +
      '<div class="panel wfd-panel">' +
        '<div class="panel-head"><span class="eyebrow">Input block</span></div>' +
        '<div class="panel-body"><pre class="code">' +
          esc(JSON.stringify(d.input || {}, null, 2)) + '</pre>' +
          '<p class="cfg-help">This is what the Run button prefills. Change it there for one ' +
          'run, or change it here to change it for good.</p>' +
        '</div>' +
      '</div>';

    const cv = $('#wfd-view-canvas', body);
    const lv = $('#wfd-view-list', body);
    if (cv) cv.addEventListener('click', () => this.setViewMode('canvas'));
    if (lv) lv.addEventListener('click', () => this.setViewMode('list'));

    if (canvasMode) this.mountCanvas();
    else this.wireChains();
    this.wireEditor();
    this.drawRuns();

    const ex = $('#wfd-expand', body);
    if (ex) ex.addEventListener('click', () => {
      this.expanded = !this.expanded;
      $$('.wf-config', this.root).forEach((el) => { el.open = this.expanded; });
      ex.textContent = this.expanded ? 'Close every config' : 'Open every config';
    });
  },

  /** Canvas / list toggle. Two plain buttons, the active one in the primary
   *  colour, same trick the editor's diff view already uses elsewhere on this
   *  page. No new CSS, this is all classes the page already has. */
  viewToggleHtml(canvasMode) {
    return '<div class="btn-row" role="group" aria-label="How to view this workflow" style="display:flex;gap:6px;margin-right:6px">' +
      '<button class="btn btn-sm' + (canvasMode ? ' btn-primary' : '') + '" type="button" id="wfd-view-canvas"' +
        (canvasMode ? ' aria-pressed="true"' : '') + '>Canvas</button>' +
      '<button class="btn btn-sm' + (canvasMode ? '' : ' btn-primary') + '" type="button" id="wfd-view-list"' +
        (canvasMode ? '' : ' aria-pressed="true"') + '>List</button>' +
    '</div>';
  },

  setViewMode(mode) {
    const retrying = mode === 'canvas' && this.canvasUnavailable;
    if (mode === this.viewMode && !retrying) return;
    this.viewMode = mode;
    try { localStorage.setItem(WF_VIEW_KEY, mode); } catch (err) { /* private mode, fine to lose */ }
    if (retrying) { this.canvasUnavailable = false; resetCanvasModules(); }
    this.draw();
  },

  /* --------------------------------------------------------------------------
     The canvas. Nodes as cards left to right, arrows between them, same idea
     as n8n. graph-layout.js works out where every card and edge goes,
     graph-canvas.js draws it and reports clicks back through opts. Both are
     owned by other agents and may be missing or broken, see canvasModules().
     ----------------------------------------------------------------------- */

  canvasAreaHtml() {
    return '<div id="wfd-canvas-row" style="display:flex;gap:16px;align-items:flex-start;padding:16px">' +
      '<div id="wfd-canvas-host" style="flex:1 1 auto;min-width:0;height:640px;position:relative;' +
        'border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--base)"></div>' +
      '<div class="panel" id="wfd-node-panel" style="width:380px;flex:0 0 380px;max-height:640px;' +
        'overflow:auto;display:none"></div>' +
    '</div>' +
    '<p class="list-note" id="wfd-canvas-note" style="display:none;padding:0 16px 16px"></p>';
  },

  async mountCanvas() {
    const slug = this.slug;
    const host = $('#wfd-canvas-host', this.root);
    if (!host) return;
    const mods = await canvasModules();
    if (!this.root || this.slug !== slug || this.viewMode !== 'canvas') return;
    if (!mods.ok) {
      this.canvasUnavailable = true;
      toast('The canvas pieces are not built yet. Showing the list instead.', 'bad');
      this.draw();
      return;
    }
    this.canvasApi = mods;
    if (this.canvas) { try { this.canvas.destroy(); } catch (err) { console.error(err); } this.canvas = null; }
    try {
      this.canvas = mods.createCanvas(host, {
        onNodeClick: (id) => this.openNodePanel(id),
        onNodeDoubleClick: (id) => this.openNodePanel(id),
        onAddAfter: (id) => openNodeDialog(this, { where: 'after', node: id }),
        onSubOpen: (slug2) => { location.hash = '#/workflows/' + encodeURIComponent(slug2); },
      });
      const layoutResult = mods.layout(this.def, {});
      this.canvas.render(this.def, layoutResult);
      this.showLayoutWarnings(layoutResult);
    } catch (err) {
      console.error('canvas failed to draw this workflow', err);
      this.canvasUnavailable = true;
      this.canvas = null;
      toast('The canvas hit a problem drawing this workflow. Showing the list instead.', 'bad');
      this.draw();
    }
  },

  showLayoutWarnings(layoutResult) {
    const note = $('#wfd-canvas-note', this.root);
    if (!note) return;
    const warnings = (layoutResult && Array.isArray(layoutResult.warnings)) ? layoutResult.warnings : [];
    if (!warnings.length) { note.style.display = 'none'; note.textContent = ''; return; }
    note.style.display = '';
    note.textContent = 'The canvas layout has a note: ' + warnings.join(' ');
  },

  /** Redraws the canvas after a save, without losing pan or zoom on the parts
   *  that did not change (createCanvas().render handles that, this just feeds
   *  it a fresh layout off the fresh definition). Never throws: a bad repaint
   *  here must not take down a save that already reached disk. */
  async refreshCanvas() {
    if (this.viewMode !== 'canvas' || this.canvasUnavailable || !this.canvas || !this.canvasApi) return;
    try {
      const layoutResult = this.canvasApi.layout(this.def, {});
      this.canvas.render(this.def, layoutResult);
      this.showLayoutWarnings(layoutResult);
    } catch (err) {
      console.error('canvas refresh failed', err);
      return;
    }
    if (this.selectedNodeId && this.graph && this.graph.byId.has(String(this.selectedNodeId))) {
      this.openNodePanel(this.selectedNodeId);
    } else {
      this.closeNodePanel();
    }
  },

  /** The side panel a node click opens. Same card markup and the same click
   *  delegation as the stacked list, see wireChainClicks. Nothing about
   *  editing, adding, or deleting a step is rebuilt for the canvas, it is the
   *  same door the list already uses. */
  openNodePanel(nodeId) {
    const panel = $('#wfd-node-panel', this.root);
    if (!panel || !this.graph) return;
    const node = this.graph.byId.get(String(nodeId));
    if (!node) { this.closeNodePanel(); return; }

    let nextInChain = null;
    for (const c of this.graph.chains) {
      const i = c.items.findIndex((n) => String(n.id) === String(nodeId));
      if (i !== -1) { nextInChain = c.items[i + 1] ? String(c.items[i + 1].id) : null; break; }
    }

    this.selectedNodeId = String(nodeId);
    panel.style.display = '';
    panel.innerHTML =
      '<div class="panel-head">' +
        '<span class="eyebrow">Step</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn-icon" type="button" id="wfd-panel-close" aria-label="Close">' + ICON.close + '</button>' +
      '</div>' +
      '<div class="panel-body">' + this.nodeHtml(node, nextInChain, null) + '</div>';

    const close = $('#wfd-panel-close', panel);
    if (close) close.addEventListener('click', () => this.closeNodePanel());
    this.wireChainClicks(panel);

    if (this.canvas && typeof this.canvas.focusNode === 'function') {
      try { this.canvas.focusNode(String(nodeId)); } catch (err) { console.error(err); }
    }
  },

  closeNodePanel() {
    this.selectedNodeId = null;
    const panel = this.root && $('#wfd-node-panel', this.root);
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  },

  chainsHtml() {
    const g = this.graph;
    if (!g || !g.nodes.length) {
      return emptyBlock('This workflow has no nodes.',
        'A workflow needs at least one node in its <code>nodes</code> array.');
    }
    return g.chains.map((c) => this.chainHtml(c)).join('');
  },

  chainHtml(chain) {
    const nextInChain = {};
    chain.items.forEach((n, i) => {
      const after = chain.items[i + 1];
      nextInChain[String(n.id)] = after ? String(after.id) : null;
    });

    // The head plus, which adds a step in front of the first one. It rewires
    // the pointer that reaches this chain, which is the workflow start for the
    // main path, a filter's elseNext for a false branch, and an each node's
    // config.body for a loop body.
    const headAdd = chain.entry
      ? this.addSlotHtml({ where: 'head', chain: chain.index })
      : '';

    const cards = chain.items.map((n) =>
      this.nodeHtml(n, nextInChain[String(n.id)], chain) +
      this.addSlotHtml({ where: 'after', node: String(n.id) })
    ).join('');

    let tail = '';
    const t = chain.tail || { kind: 'end' };
    if (t.kind === 'end') {
      tail = '<div class="chain-end">The run ends here.</div>';
    } else if (t.kind === 'join') {
      tail = '<div class="chain-end is-join">Carries on at ' + this.nodeLink(t.id) + '</div>';
    } else if (t.kind === 'missing') {
      tail = '<div class="chain-end is-bad">Points at <span class="mono">' + esc(t.id) +
        '</span>, which is not in this workflow.</div>';
    } else if (t.kind === 'loop') {
      tail = '<div class="chain-end is-bad">Loops back to ' + this.nodeLink(t.id) +
        '. The engine stops a run at 500 steps, so this will not spin for ever, ' +
        'but it will not finish either.</div>';
    }

    return '<section class="chain" data-kind="' + esc(chain.kind) + '">' +
      '<div class="chain-head">' +
        '<span class="chain-tag">' + esc(chain.title) + '</span>' +
        '<span class="chain-len">' + esc(chain.items.length) + ' step' +
          (chain.items.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      (chain.note ? '<p class="chain-note">' + esc(chain.note) + '</p>' : '') +
      '<div class="chain-body">' + headAdd + cards + tail + '</div>' +
    '</section>';
  },

  /** The thin gap between two steps. Hover it and a plus appears. */
  addSlotHtml(spec) {
    const attrs = spec.where === 'head'
      ? ' data-add-head="' + esc(spec.chain) + '"'
      : ' data-add-after="' + esc(spec.node) + '"';
    return '<div class="add-slot">' +
      '<button class="add-btn" type="button"' + attrs +
        ' title="Add a step here" aria-label="Add a step here">+</button>' +
    '</div>';
  },

  /** A clickable reference to another node, wherever it sits on the page. */
  nodeLink(id, label) {
    const g = this.graph;
    const n = g && g.byId.get(String(id));
    if (!n) {
      return '<span class="node-ref is-bad mono" title="This node is not in the workflow">' +
        esc(id) + '</span>';
    }
    return '<a class="node-ref" href="#/workflows/' + encodeURIComponent(this.slug) +
      '" data-goto="' + esc(id) + '"><span class="mono">' + esc(id) + '</span>' +
      (label === false ? '' : ' <span class="node-ref-name">' + esc(n.name || nodeLabel(n.type)) + '</span>') +
      '</a>';
  },

  /** One edge out of a node. `inline` means it is the very next card down. */
  edgeHtml(label, targetId, opts) {
    const o = opts || {};
    let target;
    if (targetId === null || targetId === undefined) {
      target = '<span class="edge-end">ends the run</span>';
    } else {
      target = this.nodeLink(targetId);
    }
    return '<div class="edge' + (o.inline ? ' is-inline' : '') +
      (o.tone ? ' tone-' + o.tone : '') + '">' +
      '<span class="edge-label">' + esc(label) + '</span>' + target + '</div>';
  },

  edgesHtml(n, nextIdInChain) {
    const type = n.type || '';
    const norm = (v) => (v === undefined ? null : v);
    const nx = norm(n.next);
    const inline = (v) => v !== null && String(v) === nextIdInChain;
    const edges = [];

    if (type === 'filter') {
      edges.push(this.edgeHtml('true', nx, { tone: 'yes', inline: inline(nx) }));
      edges.push(this.edgeHtml('false', norm(n.elseNext), { tone: 'no' }));
    } else if (type === 'each') {
      const body = (n.config && n.config.body) !== undefined ? n.config.body : null;
      edges.push(this.edgeHtml('each item', body, { tone: 'loop' }));
      edges.push(this.edgeHtml('after the loop', nx, { inline: inline(nx) }));
    } else if (type === 'sub') {
      const slug = n.config && n.config.slug;
      // A sub node is a doorway into another workflow. Without this link a
      // person following a chain of workflows has to go back to the list and
      // find it by hand every single time.
      edges.push('<div class="edge tone-sub"><span class="edge-label">runs workflow</span>' +
        (slug && typeof slug === 'string' && slug.indexOf('{{') === -1
          ? '<a class="node-ref is-wf" href="#/workflows/' + encodeURIComponent(slug) + '">' +
            '<span class="mono">' + esc(slug) + '</span>' +
            '<span class="node-ref-name">open it</span></a>'
          : '<span class="node-ref is-bad mono">' +
            esc(slug === undefined || slug === null || slug === '' ? 'no slug set' : String(slug)) +
            '</span>') +
        '</div>');
      edges.push(this.edgeHtml('then', nx, { inline: inline(nx) }));
    } else {
      edges.push(this.edgeHtml('then', nx, { inline: inline(nx) }));
    }
    return '<div class="wf-edges">' + edges.join('') + '</div>';
  },

  /** An editable block of text. Click it, or its pencil, and it turns into a box. */
  fieldHtml(nodeId, field, label, value, cls) {
    const empty = value === undefined || value === null || value === '';
    return '<div class="ask-field ' + esc(cls) + '" data-field-node="' + esc(nodeId) + '"' +
      ' data-field-key="' + esc(field) + '">' +
      '<div class="ask-field-head">' +
        '<span class="ask-tag">' + esc(label) + '</span>' +
        '<button class="field-edit" type="button" title="Edit this">edit</button>' +
      '</div>' +
      '<div class="ask-field-view">' +
        (empty ? '<p class="ask-empty">Nothing here yet. Click edit to write it.</p>'
               : '<p class="ask-text">' + markTemplates(esc(value)) + '</p>') +
      '</div>' +
    '</div>';
  },

  nodeHtml(n, nextIdInChain, chain) {
    const g = this.graph;
    const type = n.type || '';
    const meta = nodeRegistry.meta(type);
    const known = Boolean(meta);
    const id = String(n.id);
    const isStart = g.startId === id;
    const cfg = n.config || {};
    const tier = nodeTier(n, meta);

    const head =
      '<div class="wf-node-head">' +
        '<span class="node-badge" title="' + esc(nodeLabel(type)) + '">' +
          esc(nodeMonogram(type)) + '</span>' +
        '<div class="wf-node-main">' +
          '<p class="wf-node-name">' + esc(n.name || id) + '</p>' +
          '<p class="wf-node-sub"><span class="mono">' + esc(id) + '</span> &middot; ' +
            esc(nodeLabel(type)) +
            (tier === 1 && cfg.expect ? ' &middot; wants ' + esc(cfg.expect) : '') +
          '</p>' +
        '</div>' +
        (isStart ? '<span class="chip chip-start">start</span>' : '') +
        (known ? '' : '<span class="chip chip-warn">the server does not know this type</span>') +
        '<button class="node-del" type="button" data-del="' + esc(id) + '"' +
          ' title="Remove this step" aria-label="Remove this step">' +
          '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
          '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
          '</svg></button>' +
      '</div>';

    let body;
    if (tier === 1) {
      // The prompt is the point. It gets the room and the contrast.
      body =
        (cfg.system !== undefined || cfg.prompt !== undefined
          ? this.fieldHtml(id, 'system', 'System', cfg.system, 'is-system') : '') +
        this.fieldHtml(id, 'prompt', 'Prompt', cfg.prompt, 'is-prompt') +
        (cfg.schemaHint
          ? this.fieldHtml(id, 'schemaHint', 'Shape it wants back', cfg.schemaHint, 'is-hint') : '');
    } else if (tier === 2) {
      const key = headlineKey(n, meta);
      const val = key ? cfg[key] : undefined;
      body = '<div class="wf-node-gist">' +
        (key ? '<span class="gist-key mono">' + esc(key) + '</span>' +
               '<code class="gist-val">' + markTemplates(esc(oneLine(val, 220))) + '</code>'
             : '<span class="gist-key">no config</span>') +
        '</div>';
    } else {
      const key = headlineKey(n, meta);
      const val = key ? cfg[key] : undefined;
      body = '<div class="wf-node-gist">' +
        (key && val !== undefined
          ? '<span class="gist-key mono">' + esc(key) + '</span>' +
            '<code class="gist-val">' + markTemplates(esc(oneLine(val, 140))) + '</code>'
          : '<span class="gist-key">no config</span>') +
        '</div>';
    }

    return '<article class="wf-node" data-node="' + esc(id) + '" data-type="' + esc(type) + '"' +
      ' data-tier="' + tier + '"' + (known ? '' : ' data-unknown="1"') + '>' +
      head + body +
      this.edgesHtml(n, nextIdInChain) +
      '<details class="wf-config"' + (this.expanded ? ' open' : '') + '>' +
        '<summary>' + (tier === 1 ? 'All config' : 'Config') + '</summary>' +
        nodeConfigHtml(n, meta) +
      '</details>' +
    '</article>';
  },

  /* --------------------------------------------------------------------------
     Everything clickable on the chain, wired in one place by delegation, so
     redrawing a card never leaves a dead button behind.
     ----------------------------------------------------------------------- */

  wireChains() {
    const host = $('#wfd-chains', this.root);
    if (!host) return;
    this.wireChainClicks(host);
  },

  /**
   * Every clickable thing on a node card, wired once by delegation on
   * whichever host holds the card. The stacked list and the canvas side panel
   * both call this on their own host, so add, delete, and inline edit are one
   * piece of code with two doors in, not two copies that can drift apart.
   */
  wireChainClicks(host) {
    if (!host) return;
    host.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) {
        e.preventDefault();
        // On the canvas a jump means open that node's own panel and pan the
        // canvas to it. In the stacked list it means scroll to the card.
        if (this.viewMode === 'canvas' && !this.canvasUnavailable) this.openNodePanel(goto.dataset.goto);
        else this.focusNode(goto.dataset.goto);
        return;
      }

      const edit = e.target.closest('.field-edit');
      if (edit) {
        e.preventDefault();
        this.startFieldEdit(edit.closest('.ask-field'));
        return;
      }

      const del = e.target.closest('[data-del]');
      if (del) { e.preventDefault(); this.askDelete(del.dataset.del); return; }

      const addAfter = e.target.closest('[data-add-after]');
      if (addAfter) {
        e.preventDefault();
        openNodeDialog(this, { where: 'after', node: addAfter.dataset.addAfter });
        return;
      }
      const addHead = e.target.closest('[data-add-head]');
      if (addHead) {
        e.preventDefault();
        openNodeDialog(this, { where: 'head', chain: Number(addHead.dataset.addHead) });
        return;
      }

      // Clicking the prompt text itself is the same as clicking edit. This is
      // the interaction that gets used all day, so it is not hidden behind a
      // button only.
      const text = e.target.closest('.ask-field-view');
      if (text && !text.querySelector('textarea')) {
        this.startFieldEdit(text.closest('.ask-field'));
      }
    });
  },

  /** Jump to a node card and flash it, so a jump across the page is followable.
   *  On the canvas there is no stacked card to scroll to, so this opens the
   *  node's panel instead, which pans the canvas to it the same way. */
  focusNode(id) {
    if (this.viewMode === 'canvas' && !this.canvasUnavailable) { this.openNodePanel(id); return; }
    const el = $('[data-node="' + String(id).replace(/"/g, '') + '"]', this.root);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.dataset.flash = '1';
    setTimeout(() => { delete el.dataset.flash; }, 1400);
  },

  /* --------------------------------------------------------------------------
     Saving.

     One door. Every change on this page, whether it is a prompt reworded, a
     step added or a step deleted, builds the whole new definition, hands it to
     this, and this is the only thing that talks to PUT.

     What it guarantees:

       - the new definition is parsed and checked in the browser first, so a
         broken chain never reaches the disk
       - a problem the workflow already had does not block an unrelated edit.
         Those get demoted to warnings, because refusing to let somebody fix a
         typo until they first fix something they did not break is how a tool
         gets abandoned
       - if the server says no, the caller gets the reason back and keeps the
         user's typing on screen. Nothing is ever thrown away
     ----------------------------------------------------------------------- */

  preExisting() {
    // Errors the workflow already had before this edit. Worked out once.
    if (this._pre) return this._pre;
    const before = checkWorkflowEdit(JSON.stringify(this.def), this.def, this.slug);
    this._pre = new Set(before.errors);
    return this._pre;
  },

  async saveDef(nextDef) {
    const check = checkWorkflowEdit(JSON.stringify(nextDef), this.def, this.slug);
    const old = this.preExisting();
    const fresh = check.errors.filter((m) => !old.has(m));
    const carried = check.errors.filter((m) => old.has(m));
    if (fresh.length) {
      return { ok: false, errors: fresh, warnings: check.warnings.concat(carried) };
    }
    try {
      await api.request('/api/workflows/' + encodeURIComponent(this.slug), {
        method: 'PUT',
        body: JSON.stringify(nextDef),
      });
    } catch (err) {
      return {
        ok: false, fromServer: true,
        errors: ['The server refused it: ' + err.message],
        warnings: check.warnings,
      };
    }
    this.def = nextDef;
    this.graph = buildChains(this.def);
    this._pre = null;
    // Every save, whether it is a field edit, an added step, or a removed
    // step, goes through here, so this is the one place that keeps the canvas
    // in step with the file on disk. The stacked list redraws itself at each
    // call site, the canvas does not, so it has to be told here instead.
    this.refreshCanvas();
    return { ok: true, errors: [], warnings: check.warnings.concat(carried) };
  },

  clone() { return JSON.parse(JSON.stringify(this.def)); },

  /* --- editing one field in place --- */

  startFieldEdit(field) {
    if (!field || field.dataset.editing === '1') return;
    const nodeId = field.dataset.fieldNode;
    const key = field.dataset.fieldKey;
    const node = this.graph.byId.get(String(nodeId));
    if (!node) return;
    const current = (node.config && node.config[key] !== undefined && node.config[key] !== null)
      ? String(node.config[key]) : '';

    field.dataset.editing = '1';
    const view = $('.ask-field-view', field);
    view.innerHTML =
      '<textarea class="field-box" spellcheck="false"></textarea>' +
      '<p class="field-error" hidden></p>' +
      '<div class="field-foot">' +
        '<button class="btn btn-primary btn-sm" type="button" data-do="save">Save</button>' +
        '<button class="btn btn-sm" type="button" data-do="cancel">Cancel</button>' +
        '<span class="field-hint">Cmd or Ctrl plus Enter saves. Escape cancels.</span>' +
      '</div>';

    const ta = $('.field-box', view);
    ta.value = current;
    // Grow to fit rather than making somebody scroll a four line box.
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(560, Math.max(120, ta.scrollHeight + 4)) + 'px';
    };
    fit();
    ta.addEventListener('input', fit);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const stop = () => {
      delete field.dataset.editing;
      this.drawCard(nodeId);
    };

    const err = $('.field-error', view);
    const save = $('[data-do="save"]', view);

    const doSave = async () => {
      const value = ta.value;
      if (value === current) { stop(); return; }
      save.disabled = true;
      save.textContent = 'Saving';
      err.hidden = true;
      const next = this.clone();
      const target = next.nodes.find((n) => String(n.id) === String(nodeId));
      if (!target) { stop(); return; }
      target.config = target.config || {};
      target.config[key] = value;
      const res = await this.saveDef(next);
      if (!res.ok) {
        // The typing stays exactly where it is. Losing it here would be worse
        // than the failed save.
        err.textContent = res.errors.join('  ');
        err.hidden = false;
        save.disabled = false;
        save.textContent = 'Save';
        return;
      }
      save.textContent = 'Saved';
      toast('Saved ' + key + ' on ' + nodeId + '.', 'good');
      setTimeout(() => {
        delete field.dataset.editing;
        this.drawCard(nodeId, true);
      }, 260);
    };

    $('[data-do="cancel"]', view).addEventListener('click', stop);
    save.addEventListener('click', doSave);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') { e.preventDefault(); stop(); }
    });
  },

  /** Repaint one card without rebuilding the whole page under the reader. */
  drawCard(nodeId, flash) {
    const el = $('[data-node="' + String(nodeId).replace(/"/g, '') + '"]', this.root);
    const node = this.graph.byId.get(String(nodeId));
    if (!el || !node) { this.draw(); return; }
    // Work out what follows it in its own chain, the same way chainHtml does.
    let nextInChain = null;
    for (const c of this.graph.chains) {
      const i = c.items.findIndex((n) => String(n.id) === String(nodeId));
      if (i !== -1) { nextInChain = c.items[i + 1] ? String(c.items[i + 1].id) : null; break; }
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = this.nodeHtml(node, nextInChain, null);
    const fresh = wrap.firstElementChild;
    el.replaceWith(fresh);
    if (flash) {
      fresh.dataset.saved = '1';
      setTimeout(() => { delete fresh.dataset.saved; }, 1200);
    }
  },

  /* --- removing a step --- */

  /**
   * Asks first, in the card, and says exactly what the removal does to the
   * chain rather than a bare "are you sure". A yes/no box that does not say
   * what happens is not a safety step, it is a speed bump.
   */
  askDelete(nodeId) {
    const el = $('[data-node="' + String(nodeId).replace(/"/g, '') + '"]', this.root);
    if (!el || $('.del-ask', el)) return;
    const built = this.withoutNode(nodeId);
    if (built.blocked) { toast(built.blocked, 'bad'); return; }

    const check = checkWorkflowEdit(JSON.stringify(built.def), this.def, this.slug);
    const old = this.preExisting();
    const fresh = check.errors.filter((m) => !old.has(m));

    const lines = built.effects.concat(
      check.warnings.filter((w) => w.indexOf('Nothing reaches') === 0));

    const box = document.createElement('div');
    box.className = 'del-ask' + (fresh.length ? ' is-bad' : '');
    box.innerHTML =
      '<p class="del-ask-title">Remove ' + esc(nodeId) + '?</p>' +
      (lines.length ? '<ul class="del-ask-list">' +
        lines.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' : '') +
      (fresh.length
        ? '<p class="del-ask-stop">This cannot be done: ' + esc(fresh.join(' ')) + '</p>'
        : '') +
      '<div class="del-ask-foot">' +
        (fresh.length ? '' : '<button class="btn btn-danger btn-sm" type="button" data-do="yes">Remove it</button>') +
        '<button class="btn btn-sm" type="button" data-do="no">Keep it</button>' +
      '</div>';
    el.appendChild(box);

    $('[data-do="no"]', box).addEventListener('click', () => box.remove());
    const yes = $('[data-do="yes"]', box);
    if (yes) yes.addEventListener('click', async () => {
      yes.disabled = true;
      yes.textContent = 'Removing';
      const res = await this.saveDef(built.def);
      if (!res.ok) {
        toast('Not removed: ' + res.errors.join(' '), 'bad');
        yes.disabled = false;
        yes.textContent = 'Remove it';
        return;
      }
      toast('Step ' + nodeId + ' removed.', 'good');
      this.draw();
    });
  },

  /**
   * The definition with one node taken out and the chain healed around the
   * gap. Everything that pointed at it now points at whatever it pointed at.
   *
   * The awkward case is the start node. The contract says a run begins at
   * nodes[0] unless something carries `start: true`, so deleting the first node
   * has to either move the flag or move the heir to the front of the array.
   * Miss that and the workflow quietly starts somewhere else.
   */
  withoutNode(nodeId) {
    const def = this.clone();
    const nodes = def.nodes || [];
    const i = nodes.findIndex((n) => String(n.id) === String(nodeId));
    if (i === -1) return { blocked: 'That node is not here any more.' };
    if (nodes.length <= 1) return { blocked: 'A workflow needs at least one step.' };

    const gone = nodes[i];
    const heir = (gone.next === undefined || gone.next === null) ? null : gone.next;
    const wasStart = gone.start === true || (i === 0 && !nodes.some((n) => n.start === true));
    const effects = [];

    nodes.splice(i, 1);

    for (const n of nodes) {
      if (n.next !== undefined && n.next !== null && String(n.next) === String(nodeId)) {
        n.next = heir;
        effects.push(n.id + ' now goes straight to ' + (heir === null ? 'the end' : heir) + '.');
      }
      if (n.elseNext !== undefined && n.elseNext !== null && String(n.elseNext) === String(nodeId)) {
        n.elseNext = heir;
        effects.push(n.id + ' false side now goes to ' + (heir === null ? 'the end' : heir) + '.');
      }
      if (n.config && n.config.body !== undefined && n.config.body !== null &&
          String(n.config.body) === String(nodeId)) {
        n.config.body = heir;
        effects.push('The loop body of ' + n.id + ' now starts at ' + (heir === null ? 'nothing' : heir) + '.');
      }
    }

    if (wasStart) {
      if (heir === null) return { blocked: 'That is the first step and it leads nowhere, so removing it would leave no way in.' };
      const hi = nodes.findIndex((n) => String(n.id) === String(heir));
      if (hi === -1) return { blocked: 'The step after it is missing, so the start cannot be moved.' };
      for (const n of nodes) if (n.start === true) delete n.start;
      if (hi !== 0) nodes.unshift(nodes.splice(hi, 1)[0]);
      effects.push('The run now starts at ' + heir + '.');
    }

    if (gone.type === 'filter' && gone.elseNext) {
      effects.push('The false branch at ' + gone.elseNext + ' loses the only thing pointing at it.');
    }
    if (gone.type === 'each' && gone.config && gone.config.body) {
      effects.push('The loop body starting at ' + gone.config.body + ' loses the only thing pointing at it.');
    }
    if (!effects.length) effects.push('Nothing else points at it, so nothing needs rewiring.');

    return { def, effects };
  },

  /* --- adding a step --- */

  /**
   * Puts a brand new node into the chain and rewires the pointers around it.
   *
   * Three shapes, and the third is the one that is easy to get wrong:
   *
   *   after a step        the new node takes over that step's `next`
   *   head of a branch    the filter's `elseNext` is repointed at it
   *   head of a loop body the each node's `config.body` is repointed at it
   *
   * Head of the main path is its own case again: the run starts at nodes[0]
   * unless a node carries `start: true`, so the new node goes to the front of
   * the array and the flag moves with it.
   */
  insertNode(spec, node) {
    const def = this.clone();
    const nodes = def.nodes || [];

    if (spec.where === 'after') {
      const i = nodes.findIndex((n) => String(n.id) === String(spec.node));
      if (i === -1) return { blocked: 'The step to add after is not here any more.' };
      const anchor = nodes[i];
      node.next = (anchor.next === undefined) ? null : anchor.next;
      anchor.next = node.id;
      nodes.splice(i + 1, 0, node);
      return { def, effects: [spec.node + ' now goes to ' + node.id + ', which goes to ' +
        (node.next === null ? 'the end' : node.next) + '.'] };
    }

    const chain = this.graph.chains[Number(spec.chain)];
    if (!chain || !chain.entry) return { blocked: 'Cannot work out where that goes.' };
    const firstId = chain.items.length ? String(chain.items[0].id) : null;
    node.next = firstId;

    if (chain.entry.kind === 'start') {
      for (const n of nodes) if (n.start === true) delete n.start;
      node.start = true;
      nodes.unshift(node);
      return { def, effects: ['The run now starts at ' + node.id + ', which goes to ' +
        (firstId === null ? 'the end' : firstId) + '.'] };
    }

    const from = nodes.find((n) => String(n.id) === String(chain.entry.fromId));
    if (!from) return { blocked: 'The node that leads into this branch is missing.' };
    nodes.push(node);

    if (chain.entry.kind === 'else') {
      from.elseNext = node.id;
      return { def, effects: [from.id + ' false side now goes to ' + node.id + '.'] };
    }
    from.config = from.config || {};
    from.config.body = node.id;
    return { def, effects: ['The loop body of ' + from.id + ' now starts at ' + node.id + '.'] };
  },

  /** A node id nobody is using, following whatever naming the file already has. */
  suggestId(type) {
    const taken = new Set((this.def.nodes || []).map((n) => String(n.id)));
    const numeric = [...taken].every((id) => /^n\d+$/.test(id));
    if (numeric) {
      let k = taken.size + 1;
      while (taken.has('n' + k)) k += 1;
      return 'n' + k;
    }
    let k = 1;
    while (taken.has(type + '_' + k)) k += 1;
    return type + '_' + k;
  },

  drawRuns() {
    const host = this.root && $('#wfd-runs', this.root);
    if (!host) return;
    if (!this.runs.length) {
      host.innerHTML = '<p class="list-note">This workflow has not run yet.</p>';
      return;
    }
    host.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th style="width:78px">Run</th><th style="width:150px">Status</th>' +
      '<th style="width:92px">Trigger</th><th>Started</th>' +
      '<th style="width:110px" class="num">Duration</th>' +
      '</tr></thead>' +
      this.runs.map((r) => {
        const err = String(r.error || '').trim();
        // Same shape as the runs table: one tbody per run, and a failed run
        // gets a full width row underneath saying why.
        return '<tbody data-run="' + esc(r.id) + '"><tr class="run-row">' +
          '<td class="mono">' + esc(r.id) + '</td>' +
          '<td>' + pill(r.status) + '</td>' +
          '<td>' + (r.trigger ? '<span class="chip">' + esc(r.trigger) + '</span>'
            : '<span class="faint">-</span>') + '</td>' +
          '<td class="mono faint" title="' + esc(fmtStamp(r.startedAt)) + '">' + esc(ago(r.startedAt)) + '</td>' +
          '<td class="num">' + esc(fmtMs(durMs(r.startedAt, r.endedAt))) + '</td>' +
        '</tr>' +
        (err ? '<tr class="err-row"><td colspan="5"><span class="row-error" title="' + esc(err) + '">' +
          esc(err.length > 300 ? err.slice(0, 300) + '...' : err) + '</span></td></tr>' : '') +
        '</tbody>';
      }).join('') + '</table></div>';
    $$('[data-run]', host).forEach((tb) => {
      tb.addEventListener('click', () => { location.hash = '#/runs/' + tb.dataset.run; });
    });
  },

  /* --------------------------------------------------------------------------
     The editor.

     PUT /api/workflows/:slug writes the JSON file back to disk. There is no
     undo and no version history behind it, so a bad save quietly replaces a
     working workflow with a broken one. That is the failure this is built
     around, not typing comfort.

     So saving is three steps and not one:

       1. type
       2. Check it. The JSON is parsed here, in the browser, and run through
          every rule below. Nothing at all is sent to the server at this point.
       3. Read what will change, node by node, then Save.

     Save cannot be pressed until a check has passed, and any keystroke after a
     check turns Save off again. Errors block the save. Warnings do not, but
     they are shown in the same list, because an orphan node is worth knowing
     about and is not worth refusing a save over.
     ----------------------------------------------------------------------- */

  editorHtml() {
    return '<div class="panel wfd-panel">' +
      '<div class="panel-head">' +
        '<span class="eyebrow">Definition</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm" type="button" id="wfd-edit-toggle">' +
          (this.editorOpen ? 'Close the editor' : 'Edit this workflow') + '</button>' +
      '</div>' +
      '<div class="panel-body" id="wfd-editor"' + (this.editorOpen ? '' : ' hidden') + '>' +
        '<p class="cfg-help">Saving writes the JSON file on disk straight away. It is checked ' +
        'here first and you get to read every change before it goes.</p>' +
        '<textarea class="code-input" id="wfd-json" spellcheck="false" rows="20"></textarea>' +
        '<div class="wfd-edit-foot">' +
          '<button class="btn" type="button" id="wfd-check">Check the changes</button>' +
          '<button class="btn btn-primary" type="button" id="wfd-save" disabled>Save</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" id="wfd-reset">Put it back</button>' +
          '<span class="spacer"></span>' +
          '<span class="answer-hint" id="wfd-edit-hint">Check it first. Save turns on after that.</span>' +
        '</div>' +
        '<div id="wfd-diff"></div>' +
      '</div>' +
    '</div>';
  },

  wireEditor() {
    const root = this.root;
    const toggle = $('#wfd-edit-toggle', root);
    const box = $('#wfd-editor', root);
    const ta = $('#wfd-json', root);
    const save = $('#wfd-save', root);
    if (!toggle || !box || !ta || !save) return;

    const original = JSON.stringify(this.def, null, 2);
    ta.value = original;

    const lock = (why) => {
      save.disabled = true;
      this.editorChecked = null;
      const hint = $('#wfd-edit-hint', root);
      if (hint) hint.textContent = why;
    };

    toggle.addEventListener('click', () => {
      this.editorOpen = !this.editorOpen;
      box.hidden = !this.editorOpen;
      toggle.textContent = this.editorOpen ? 'Close the editor' : 'Edit this workflow';
      if (this.editorOpen) ta.focus();
    });

    ta.addEventListener('input', () => lock('Changed since the last check. Check it again.'));

    $('#wfd-reset', root).addEventListener('click', () => {
      ta.value = original;
      $('#wfd-diff', root).innerHTML = '';
      lock('Back to what is on disk.');
    });

    $('#wfd-check', root).addEventListener('click', () => {
      const out = checkWorkflowEdit(ta.value, this.def, this.slug);
      $('#wfd-diff', root).innerHTML = renderEditReport(out);
      if (out.errors.length) {
        lock(out.errors.length + ' problem' + (out.errors.length === 1 ? '' : 's') +
          ' to fix before this can be saved.');
      } else if (!out.changes.length) {
        lock('Nothing is different from what is on disk.');
      } else {
        this.editorChecked = out.parsed;
        save.disabled = false;
        const hint = $('#wfd-edit-hint', root);
        if (hint) hint.textContent = 'Checked. Save writes the file.';
      }
    });

    save.addEventListener('click', async () => {
      if (!this.editorChecked) return;
      save.disabled = true;
      save.textContent = 'Saving';
      try {
        await api.request('/api/workflows/' + encodeURIComponent(this.slug), {
          method: 'PUT',
          body: JSON.stringify(this.editorChecked),
        });
        toast('Saved. The file on disk is updated.', 'good');
        this.editorChecked = null;
        $('#wfd-diff', root).innerHTML = '';
        await this.refresh();
      } catch (err) {
        toast('Not saved: ' + err.message, 'bad');
        save.disabled = false;
      } finally {
        save.textContent = 'Save';
      }
    });
  },
};
workflowView.softRefreshRuns = throttled(() => workflowView.refreshRuns(), 2000);

/**
 * Everything that has to be true before a definition is allowed near the API.
 * Returns { parsed, errors, warnings, changes }. Errors block the save.
 */
function checkWorkflowEdit(text, oldDef, slug) {
  const errors = [];
  const warnings = [];
  const changes = [];
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { parsed: null, errors: ['That is not valid JSON: ' + err.message], warnings, changes };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { parsed: null, errors: ['The top level has to be an object.'], warnings, changes };
  }
  if (parsed.slug !== undefined && String(parsed.slug) !== String(slug)) {
    errors.push('The slug says "' + parsed.slug + '" but this page is "' + slug +
      '". Renaming a workflow from here would save it over a different one.');
  }
  if (!Array.isArray(parsed.nodes) || !parsed.nodes.length) {
    errors.push('"nodes" has to be an array with at least one node in it.');
    return { parsed, errors, warnings, changes };
  }

  const ids = new Set();
  parsed.nodes.forEach((n, i) => {
    const where = 'Node ' + (i + 1);
    if (!n || typeof n !== 'object') { errors.push(where + ' is not an object.'); return; }
    if (n.id === undefined || n.id === null || n.id === '') { errors.push(where + ' has no id.'); return; }
    const id = String(n.id);
    if (ids.has(id)) errors.push('Two nodes share the id "' + id + '".');
    ids.add(id);
    if (!n.type) { errors.push('Node "' + id + '" has no type.'); return; }
    if (nodeRegistry.byType && !nodeRegistry.meta(n.type)) {
      errors.push('Node "' + id + '" is type "' + n.type +
        '", which the server does not have. It knows: ' +
        Object.keys(nodeRegistry.byType).sort().join(', ') + '.');
    }
  });

  const pointsAt = (from, key, v) => {
    if (v === undefined || v === null) return;
    if (!ids.has(String(v))) {
      errors.push('Node "' + from + '" has ' + key + ' pointing at "' + v +
        '", and there is no node with that id.');
    }
  };
  for (const n of parsed.nodes) {
    if (!n || n.id === undefined) continue;
    const id = String(n.id);
    pointsAt(id, 'next', n.next);
    if (n.elseNext !== undefined) {
      if (n.type !== 'filter') warnings.push('Node "' + id + '" has elseNext but is not a filter, so it is ignored.');
      pointsAt(id, 'elseNext', n.elseNext);
    }
    if (n.type === 'each') pointsAt(id, 'config.body', n.config && n.config.body);
    if (n.next === undefined && n.type !== 'each') {
      warnings.push('Node "' + id + '" has no "next" key at all. Add "next": null if it is meant to end there.');
    }
    const meta = nodeRegistry.meta(n.type);
    if (meta && meta.configSchema) {
      for (const k of Object.keys(meta.configSchema)) {
        const spec = meta.configSchema[k];
        const has = n.config && n.config[k] !== undefined && n.config[k] !== null && n.config[k] !== '';
        if (spec && spec.required && !has) {
          errors.push('Node "' + id + '" needs "' + k + '" and it is not set. ' + (spec.help || ''));
        }
      }
    }
  }

  // Reachability. A warning and not an error: a workflow with a node nothing
  // points at still runs, it just has dead weight in it.
  const g = buildChains(parsed);
  for (const n of parsed.nodes) {
    if (n && n.id !== undefined && !g.placed.has(String(n.id))) {
      warnings.push('Nothing reaches node "' + n.id + '", so it can never run.');
    }
  }

  /* --- what will change --- */

  const oldNodes = new Map();
  for (const n of ((oldDef && oldDef.nodes) || [])) if (n && n.id !== undefined) oldNodes.set(String(n.id), n);
  const newNodes = new Map();
  for (const n of parsed.nodes) if (n && n.id !== undefined) newNodes.set(String(n.id), n);

  for (const k of ['name', 'description', 'enabled']) {
    const a = oldDef ? oldDef[k] : undefined;
    const b = parsed[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ kind: 'field', text: k + ': ' + JSON.stringify(a) + ' becomes ' + JSON.stringify(b) });
    }
  }
  for (const k of ['input', 'trigger']) {
    if (JSON.stringify(oldDef ? oldDef[k] : undefined) !== JSON.stringify(parsed[k])) {
      changes.push({ kind: 'field', text: 'The ' + k + ' block changes.' });
    }
  }
  for (const [id, n] of newNodes) {
    if (!oldNodes.has(id)) {
      changes.push({ kind: 'add', text: 'New node "' + id + '" (' + (n.type || 'no type') + ')' });
    }
  }
  for (const [id, n] of oldNodes) {
    if (!newNodes.has(id)) {
      changes.push({ kind: 'remove', text: 'Node "' + id + '" (' + (n.type || 'no type') + ') is removed' });
    }
  }
  for (const [id, n] of newNodes) {
    const before = oldNodes.get(id);
    if (!before) continue;
    const keys = new Set(Object.keys(before).concat(Object.keys(n)));
    const diffs = [];
    for (const k of keys) {
      if (JSON.stringify(before[k]) !== JSON.stringify(n[k])) diffs.push(k);
    }
    if (diffs.length) {
      changes.push({ kind: 'edit', text: 'Node "' + id + '" changes: ' + diffs.join(', ') });
    }
  }

  return { parsed, errors, warnings, changes };
}

function renderEditReport(out) {
  const list = (title, items, cls) => {
    if (!items.length) return '';
    return '<div class="edit-group ' + cls + '">' +
      '<p class="edit-group-title">' + esc(title) + '</p><ul>' +
      items.map((t) => '<li>' + esc(typeof t === 'string' ? t : t.text) + '</li>').join('') +
      '</ul></div>';
  };
  if (out.errors.length) {
    return '<div class="edit-report">' +
      list('Fix these before it can be saved', out.errors, 'is-bad') +
      list('Worth knowing', out.warnings, 'is-warn') + '</div>';
  }
  if (!out.changes.length) {
    return '<div class="edit-report"><p class="edit-ok">Nothing is different from what is on disk.</p>' +
      list('Worth knowing', out.warnings, 'is-warn') + '</div>';
  }
  return '<div class="edit-report">' +
    '<p class="edit-ok">Checked. ' + out.changes.length + ' change' +
      (out.changes.length === 1 ? '' : 's') + ' will be written.</p>' +
    list('What changes', out.changes, 'is-change') +
    list('Worth knowing', out.warnings, 'is-warn') + '</div>';
}


/* ----------------------------------------------------------------------------
   The add a step dialog.

   Two panes, one after the other: pick the type, then fill it in. Both are
   built from GET /api/nodes, so the list of types, the fields on the form, the
   help under each field and which ones are required all come from the server.
   Adding a node type on the server puts it in here with no edit to this file.
   -------------------------------------------------------------------------- */

let nodeDialogState = null;

function openNodeDialog(view, spec) {
  const dlg = $('#node-dialog');
  if (!dlg) return;
  nodeDialogState = { view, spec, type: null };

  const where = spec.where === 'after'
    ? 'Adding a step after ' + spec.node
    : 'Adding a step at the top of this path';
  $('#node-dialog-where').textContent = where;

  drawTypePicker();
  if (typeof dlg.showModal === 'function') dlg.showModal();

  // The registry is normally already here. If it is not, fetch it and redraw.
  if (!nodeRegistry.byType) {
    nodeRegistry.load().then(drawTypePicker).catch(() => {
      $('#node-dialog-body').innerHTML =
        '<p class="field-error">Could not read the node list from the server, so there is ' +
        'nothing to pick from. Check the server is up and try again.</p>';
    });
  }
}

function closeNodeDialog() {
  const dlg = $('#node-dialog');
  if (dlg && dlg.open) dlg.close();
  nodeDialogState = null;
}

function drawTypePicker() {
  const body = $('#node-dialog-body');
  if (!body || !nodeDialogState) return;
  $('#node-dialog-title').textContent = 'Pick what it does';

  const types = nodeRegistry.byType ? Object.keys(nodeRegistry.byType).sort() : [];
  if (!types.length) {
    body.innerHTML = '<p class="list-note">Loading the node types</p>';
    return;
  }

  // Prompts first. They are what this product is, so they are what the eye
  // lands on when the box opens.
  const rank = (t) => {
    const m = nodeRegistry.meta(t);
    return nodeTier({ type: t, config: {} }, m);
  };
  types.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  body.innerHTML = '<div class="type-grid">' + types.map((t) => {
    const m = nodeRegistry.meta(t) || {};
    return '<button class="type-card" type="button" data-type="' + esc(t) + '" data-tier="' +
      rank(t) + '">' +
      '<span class="node-badge">' + esc(nodeMonogram(t)) + '</span>' +
      '<span class="type-card-main">' +
        '<span class="type-card-name">' + esc(m.label || t) + '</span>' +
        '<span class="type-card-slug mono">' + esc(t) + '</span>' +
        '<span class="type-card-desc">' + esc(m.description || '') + '</span>' +
      '</span>' +
    '</button>';
  }).join('') + '</div>';

  $$('.type-card', body).forEach((b) => {
    b.addEventListener('click', () => {
      nodeDialogState.type = b.dataset.type;
      drawNodeForm();
    });
  });
}

function drawNodeForm() {
  const body = $('#node-dialog-body');
  const st = nodeDialogState;
  if (!body || !st || !st.type) return;
  const meta = nodeRegistry.meta(st.type) || {};
  const schema = meta.configSchema || {};
  $('#node-dialog-title').textContent = meta.label || st.type;

  const bigKeys = { prompt: 1, system: 1, expression: 1, content: 1, schemaHint: 1, message: 1 };

  const fields = Object.keys(schema).map((k) => {
    const spec = schema[k] || {};
    const id = 'nf-' + k;
    const def = spec.default !== undefined
      ? (typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default)) : '';
    const isBig = bigKeys[k] || spec.type === 'object' || spec.type === 'array';
    const control = isBig
      ? '<textarea class="code-input" id="' + esc(id) + '" data-key="' + esc(k) +
        '" data-type="' + esc(spec.type || 'string') + '" rows="' + (k === 'prompt' ? 6 : 3) +
        '" spellcheck="false">' + esc(def) + '</textarea>'
      : '<input class="input wide" id="' + esc(id) + '" data-key="' + esc(k) +
        '" data-type="' + esc(spec.type || 'string') + '" value="' + esc(def) + '">';
    return '<div class="nf-row">' +
      '<label class="field-label" for="' + esc(id) + '">' + esc(k) +
        (spec.required ? '<span class="chip chip-req">required</span>'
                       : '<span class="chip">optional</span>') +
        (spec.type ? '<span class="chip">' + esc(spec.type) + '</span>' : '') +
      '</label>' +
      (spec.help ? '<p class="field-help">' + esc(spec.help) + '</p>' : '') +
      control +
    '</div>';
  }).join('');

  body.innerHTML =
    '<div class="nf-top">' +
      '<div class="nf-row nf-half">' +
        '<label class="field-label" for="nf-name">Name</label>' +
        '<p class="field-help">What this step is for, in plain words.</p>' +
        '<input class="input wide" id="nf-name" value="' + esc(meta.label || st.type) + '">' +
      '</div>' +
      '<div class="nf-row nf-half">' +
        '<label class="field-label" for="nf-id">Step id</label>' +
        '<p class="field-help">Short, no spaces. Other steps point at this.</p>' +
        '<input class="input wide mono" id="nf-id" value="' +
          esc(st.view.suggestId(st.type)) + '">' +
      '</div>' +
    '</div>' +
    (fields || '<p class="cfg-none">This step takes no config.</p>') +
    '<p class="field-error" id="nf-error" hidden></p>' +
    '<div id="nf-preview"></div>' +
    '<div class="dialog-foot">' +
      '<button class="btn btn-ghost btn-sm" type="button" id="nf-back">Pick a different type</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" type="button" id="nf-cancel">Cancel</button>' +
      '<button class="btn btn-primary" type="button" id="nf-add">Add the step</button>' +
    '</div>';

  $('#nf-back').addEventListener('click', drawTypePicker);
  $('#nf-cancel').addEventListener('click', closeNodeDialog);
  $('#nf-add').addEventListener('click', submitNodeForm);
}

/** Turns one form control back into the type its schema asked for. */
function readControl(el) {
  const raw = el.value;
  const want = el.dataset.type;
  if (raw === '') return undefined;
  if (want === 'number') {
    const n = Number(raw);
    return isNaN(n) ? raw : n;
  }
  if (want === 'boolean') return raw === 'true' || raw === '1' || raw === 'yes';
  if (want === 'object' || want === 'array') {
    try { return JSON.parse(raw); } catch { return { __bad: raw }; }
  }
  return raw;
}

async function submitNodeForm() {
  const st = nodeDialogState;
  if (!st) return;
  const view = st.view;
  const err = $('#nf-error');
  const btn = $('#nf-add');
  err.hidden = true;

  const id = $('#nf-id').value.trim();
  const name = $('#nf-name').value.trim();
  const problems = [];

  if (!id) problems.push('The step needs an id.');
  if (/[^A-Za-z0-9_\-]/.test(id)) problems.push('The id can only hold letters, numbers, underscores and dashes.');
  if ((view.def.nodes || []).some((n) => String(n.id) === id)) {
    problems.push('There is already a step called "' + id + '".');
  }

  const config = {};
  $$('[data-key]', $('#node-dialog-body')).forEach((el) => {
    const v = readControl(el);
    if (v === undefined) return;
    if (v && typeof v === 'object' && v.__bad !== undefined) {
      problems.push('"' + el.dataset.key + '" has to be valid JSON.');
      return;
    }
    config[el.dataset.key] = v;
  });

  const meta = nodeRegistry.meta(st.type) || {};
  const schema = meta.configSchema || {};
  for (const k of Object.keys(schema)) {
    if (schema[k] && schema[k].required &&
        (config[k] === undefined || config[k] === null || config[k] === '')) {
      problems.push('"' + k + '" is required. ' + (schema[k].help || ''));
    }
  }

  if (problems.length) {
    err.innerHTML = problems.map((p) => esc(p)).join('<br>');
    err.hidden = false;
    return;
  }

  const node = { id, type: st.type, name: name || id, config, next: null };
  const built = view.insertNode(st.spec, node);
  if (built.blocked) {
    err.textContent = built.blocked;
    err.hidden = false;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adding';
  const res = await view.saveDef(built.def);
  if (!res.ok) {
    // The form keeps everything the person typed. They fix one line and press
    // the button again.
    err.innerHTML = res.errors.map((m) => esc(m)).join('<br>');
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Add the step';
    return;
  }

  closeNodeDialog();
  toast('Step ' + id + ' added. ' + built.effects.join(' '), 'good');
  view.draw();
  setTimeout(() => view.focusNode(id), 80);
}

function wireNodeDialog() {
  const dlg = $('#node-dialog');
  if (!dlg) return;
  $('#node-dialog-close').addEventListener('click', closeNodeDialog);
  dlg.addEventListener('close', () => { nodeDialogState = null; });
}


/* ----------------------------------------------------------------------------
   View 2: runs

   Rows are keyed by run id and patched in place. A run.started prepends one
   row, a status change rewrites one cell. The table is never rebuilt from
   scratch by a live event, which is what keeps it calm under load.
   -------------------------------------------------------------------------- */

const PAGE_SIZE = 100;

const runsView = {
  root: null,
  rows: new Map(),
  filter: { status: '', slug: '', limit: PAGE_SIZE },

  async mount(root, params) {
    this.root = root;
    this.rows = new Map();
    this.filter = {
      status: (params && params.query && params.query.status) || '',
      slug: (params && params.query && params.query.slug) || '',
      limit: PAGE_SIZE,
    };
    root.innerHTML = '<div class="page wide">' +
      '<div class="page-head">' +
        '<div><h1 class="page-title">Runs</h1>' +
        '<p class="page-sub">Newest first. This list updates itself while runs go.</p></div>' +
      '</div>' +
      '<div class="filters">' +
        '<select class="select" id="runs-status" aria-label="Filter by status">' +
          '<option value="">All statuses</option>' +
          ['running', 'waiting_on_claude', 'waiting_on_timer', 'queued', 'done', 'failed', 'cancelled']
            .map((s) => '<option value="' + s + '">' + s.replace(/_/g, ' ') + '</option>').join('') +
        '</select>' +
        '<input class="input" id="runs-slug" placeholder="Filter by workflow slug" aria-label="Filter by workflow slug">' +
        '<span class="spacer"></span>' +
        '<span class="eyebrow" id="runs-count"></span>' +
      '</div>' +
      '<div class="panel"><div class="table-wrap"><table class="table" id="runs-body">' +
        '<thead><tr>' +
          '<th style="width:78px">Run</th><th>Workflow</th><th style="width:150px">Status</th>' +
          '<th style="width:92px">Trigger</th>' +
          '<th style="width:140px">Started</th><th style="width:110px" class="num">Duration</th>' +
        '</tr></thead>' +
      '</table></div><div id="runs-foot"></div></div></div>';

    $('#runs-status').value = this.filter.status;
    $('#runs-slug').value = this.filter.slug;
    $('#runs-status').addEventListener('change', (e) => {
      this.filter.status = e.target.value; this.filter.limit = PAGE_SIZE; this.refresh();
    });
    let t = null;
    $('#runs-slug').addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value.trim();
      t = setTimeout(() => { this.filter.slug = v; this.filter.limit = PAGE_SIZE; this.refresh(); }, 260);
    });

    await this.refresh();
  },

  unmount() { this.root = null; this.rows.clear(); ticker.clear(); },

  event(msg) {
    if (!msg.runId) return;
    if (msg.type && msg.type.indexOf('run.') === 0) this.softRefresh();
  },

  softRefresh: null,

  query() {
    const p = new URLSearchParams();
    if (this.filter.status) p.set('status', this.filter.status);
    if (this.filter.slug) p.set('slug', this.filter.slug);
    p.set('limit', String(this.filter.limit));
    return '/api/runs?' + p.toString();
  },

  async refresh() {
    if (!this.root) return;
    const body = $('#runs-body', this.root);
    if (!body) return;
    try {
      const data = await api.get(this.query());
      const runs = asArray(data).map(normRun).filter((r) => r && r.id !== undefined);
      this.draw(runs);
    } catch (err) {
      body.innerHTML = '';
      const c = $('#runs-count', this.root);
      if (c) c.textContent = '';
      $('#runs-foot', this.root).innerHTML = errorBlock(err, 'runs-retry');
      const b = $('#runs-retry', this.root);
      if (b) b.addEventListener('click', () => this.refresh());
    }
  },

  draw(runs) {
    const body = $('#runs-body', this.root);
    const foot = $('#runs-foot', this.root);
    const count = $('#runs-count', this.root);
    if (!body) return;

    count.textContent = runs.length + (runs.length === this.filter.limit ? '+' : '') + ' runs';

    if (!runs.length) {
      this.rows.forEach((el) => el.remove());
      foot.innerHTML = (this.filter.status || this.filter.slug)
        ? emptyBlock('Nothing matches that filter.', 'Clear the filter to see every run.')
        : emptyBlock('No runs yet.',
            'Start one from <a href="#/workflows">Workflows</a>, or from the shell with ' +
            '<code>bin/aflow run &lt;slug&gt;</code>.');
      this.rows.clear();
      return;
    }

    // Keyed patch. Rows that are already right are left alone.
    //
    // One tbody per run, not one tr. A failed run needs a second row under it
    // holding the error across the whole table width, and a table cell cannot
    // span columns from inside another cell. Squeezing the error into the
    // workflow column looked fine at 1440 and turned into 'Node "start_log"...'
    // at 768, which tells nobody anything.
    ticker.clear();
    const head = $('thead', body);
    const seen = new Set();
    let prev = null;
    for (const r of runs) {
      const key = String(r.id);
      seen.add(key);
      let tb = this.rows.get(key);
      if (!tb) {
        tb = document.createElement('tbody');
        tb.dataset.id = key;
        tb.addEventListener('click', () => { location.hash = '#/runs/' + key; });
        this.rows.set(key, tb);
        tb.dataset.sig = '';
      }
      const sig = r.status + '|' + r.endedAt + '|' + r.slug + '|' + r.trigger + '|' + r.error;
      if (tb.dataset.sig !== sig) {
        tb.innerHTML = this.cells(r);
        tb.dataset.sig = sig;
      }
      // Keep the DOM order matching the data order without rebuilding.
      const wanted = prev ? prev.nextSibling : (head ? head.nextSibling : body.firstChild);
      if (tb !== wanted) body.insertBefore(tb, wanted);
      prev = tb;
      const liveEl = $('[data-since]', tb);
      if (liveEl) ticker.add(liveEl);
    }
    for (const [key, tr] of this.rows) {
      if (!seen.has(key)) { tr.remove(); this.rows.delete(key); }
    }

    foot.innerHTML = runs.length >= this.filter.limit
      ? '<div class="load-more"><button class="btn" type="button" id="runs-more">Load more</button></div>'
      : '';
    const more = $('#runs-more', this.root);
    if (more) more.addEventListener('click', () => {
      this.filter.limit += PAGE_SIZE;
      this.refresh();
    });
  },

  /**
   * One row.
   *
   * `trigger` and `error` are read tolerantly on purpose. They were added to
   * GET /api/runs while this page was being written, so the table has to be
   * right both before and after that landed: a missing trigger shows a quiet
   * dash, a missing error shows nothing at all, and neither is ever the string
   * "undefined".
   *
   * The error sits under the workflow name rather than in a column of its own.
   * A column would be a hundred narrow truncated cells. Under the name it gets
   * the full width of the table, so a failed run says why it failed without a
   * click, which is the whole point of showing it.
   */
  cells(r) {
    const ms = durMs(r.startedAt, r.endedAt);
    const running = !r.endedAt && (r.status === 'running' || r.status === 'queued');
    const err = String(r.error || '').trim();
    const errRow = err
      ? '<tr class="err-row"><td colspan="6">' +
        '<span class="row-error" title="' + esc(err) + '">' +
          esc(err.length > 400 ? err.slice(0, 400) + '...' : err) + '</span></td></tr>'
      : '';
    return '<tr class="run-row">' +
      '<td class="mono">' + esc(r.id) + '</td>' +
      '<td class="truncate">' + esc(r.slug) + '</td>' +
      '<td>' + pill(r.status) + '</td>' +
      '<td>' + (r.trigger ? '<span class="chip">' + esc(r.trigger) + '</span>'
        : '<span class="faint">-</span>') + '</td>' +
      '<td class="mono faint" title="' + esc(fmtStamp(r.startedAt)) + '">' + esc(ago(r.startedAt)) + '</td>' +
      '<td class="num"' + (running ? ' data-since="' + esc(r.startedAt) + '"' : '') + '>' +
        esc(fmtMs(ms)) + '</td>' +
    '</tr>' + errRow;
  },
};
runsView.softRefresh = throttled(() => runsView.refresh(), 900);

/* ----------------------------------------------------------------------------
   View 3: run detail

   The one the owner watches. Three parts: the amber banner when a prompt is
   parked, the step timeline, and the live log.

   Event volume is the thing that kills a page like this. So:
     - the log keeps at most LOG_KEEP events in memory
     - it renders at most LOG_WINDOW of them, newest last, unless asked
     - live lines append one node, they never redraw the list
     - the auto scroll only follows while you are already at the bottom
   -------------------------------------------------------------------------- */

const LOG_KEEP = 5000;
const LOG_WINDOW = 400;

const runView = {
  root: null,
  runId: null,
  run: null,
  steps: [],
  prompts: [],
  hist: [],        // events from the API. Authoritative.
  liveTail: [],    // events off the socket since the last refetch. Provisional.
  logSig: '',
  openJson: new Set(),
  stepEls: new Map(),
  showAllLog: false,
  loaded: false,
  def: null,
  canvas: null,
  canvasApi: null,
  canvasUnavailable: false,

  async mount(root, params) {
    this.root = root;
    this.runId = params.id;
    this.run = null;
    this.steps = [];
    this.prompts = [];
    this.hist = [];
    this.liveTail = [];
    this.logSig = '';
    this.openJson = new Set();
    this.stepEls = new Map();
    this.showAllLog = false;
    this.loaded = false;
    this.def = null;
    this.canvas = null;
    this.canvasApi = null;
    this.canvasUnavailable = false;

    root.innerHTML = '<div class="page wide">' +
      '<a class="back-link" href="#/runs">' + ICON.back + ' All runs</a>' +
      '<div id="run-banner"></div>' +
      '<div id="run-head"></div>' +
      '<div class="panel" id="run-story-panel" style="margin-bottom:16px">' +
        '<div class="panel-head"><span class="eyebrow">Story</span>' +
          '<span class="spacer"></span>' +
          '<span class="cfg-help" style="margin:0">What happened, desk by desk, who was called and why. Built by bin/run-story.</span></div>' +
        '<div id="run-story-body" class="panel-body"><p class="list-note">Loading</p></div>' +
      '</div>' +
      '<div class="panel" id="run-canvas-panel" style="margin-bottom:16px">' +
        '<div class="panel-head"><span class="eyebrow">Canvas</span>' +
          '<span class="spacer"></span>' +
          '<span class="cfg-help" style="margin:0">The live run, node by node.</span></div>' +
        '<div id="run-canvas-host" style="height:420px;position:relative;overflow:hidden;background:var(--base)"></div>' +
      '</div>' +
      '<div class="panel" style="margin-bottom:16px">' +
        '<div class="panel-head"><span class="eyebrow">Agents</span>' +
          '<span class="spacer"></span>' +
          '<span class="cfg-help" style="margin:0">Which desk, which role card, who answered.</span></div>' +
        '<div class="table-wrap" id="run-agents"></div>' +
      '</div>' +
      '<div class="panel" style="margin-bottom:16px">' +
        '<div class="panel-head"><span class="eyebrow">Steps</span>' +
          '<span class="spacer"></span><span class="eyebrow" id="steps-count"></span></div>' +
        '<div class="timeline" id="run-steps"></div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="panel-head log-head"><span class="eyebrow">Event log</span>' +
          '<span class="spacer"></span>' +
          '<label class="stick"><input type="checkbox" id="log-stick" checked> Follow</label>' +
          '<span class="eyebrow" id="log-count"></span></div>' +
        '<div id="log-more"></div>' +
        '<div class="log-list scroll" id="run-log"></div>' +
      '</div>' +
    '</div>';

    live.subscribe(this.runId);
    await this.refresh();
  },

  unmount() {
    if (this.canvas) { try { this.canvas.destroy(); } catch (err) { console.error(err); } this.canvas = null; }
    this.root = null;
    live.wantRunId = null;
    live.subscribe();
    ticker.clear();
  },

  event(msg) {
    if (msg.runId !== undefined && String(msg.runId) !== String(this.runId)) return;

    // Paint straight away from the event itself, so the page feels instant.
    // These lines are provisional: the next refetch throws them away and takes
    // the stored ones instead, which is what stops the same line showing twice
    // once history and the socket disagree about wording.
    this.liveTail.push(normEvent(msg));
    if (this.liveTail.length > 400) this.liveTail.shift();
    if (this.loaded) this.drawLog();

    // Then correct everything against the server.
    this.softRefresh();
  },

  softRefresh: null,

  async refresh() {
    if (!this.root) return;
    try {
      const data = await api.get('/api/runs/' + encodeURIComponent(this.runId));
      this.run = normRun(pick(data, 'run') || data);
      this.steps = asArray(pick(data, 'steps')).map(normStep);
      this.prompts = asArray(pick(data, 'prompts')).map(normPrompt);
      this.hist = asArray(pick(data, 'events')).map(normEvent);
      this.liveTail = [];
      this.loaded = true;
      this.drawHead();
      this.drawStory();
      this.drawBanner();
      this.drawAgentsTable();
      this.drawSteps();
      this.drawLog();
      // Fire and forget: loading the definition and mounting the canvas is
      // async, and a slow or missing canvas must never hold up the rest of
      // the page painting. See ensureCanvas.
      this.ensureCanvas();
    } catch (err) {
      if (this.loaded) return; // Keep what is on screen, the poll will fix it.
      this.root.innerHTML = '<div class="page">' +
        '<a class="back-link" href="#/runs">' + ICON.back + ' All runs</a>' +
        errorBlock(err, 'run-retry') + '</div>';
      const b = $('#run-retry', this.root);
      if (b) b.addEventListener('click', () => this.mount(this.root, { id: this.runId }));
    }
  },

  /* --- head --- */

  drawHead() {
    const host = $('#run-head', this.root);
    if (!host || !this.run) return;
    const r = this.run;
    const live_ = !r.endedAt && (r.status === 'running' || r.status === 'queued');
    const canCancel = ['running', 'queued', 'waiting_on_claude', 'waiting_on_timer'].includes(r.status);

    host.innerHTML = '<div class="run-head">' +
      '<div>' +
        '<div class="hstack" style="display:flex;align-items:center;gap:12px">' +
          '<span class="run-id">Run ' + esc(r.id) + '</span>' + pill(r.status) +
        '</div>' +
        '<div class="run-facts">' +
          fact('Workflow', esc(r.slug)) +
          fact('Trigger', esc(r.trigger || 'unknown')) +
          fact('Started', '<span title="' + esc(fmtStamp(r.startedAt)) + '">' + esc(ago(r.startedAt)) + '</span>') +
          fact('Duration', '<span' + (live_ ? ' data-since="' + esc(r.startedAt) + '"' : '') + '>' +
            esc(fmtMs(durMs(r.startedAt, r.endedAt))) + '</span>') +
        '</div>' +
      '</div>' +
      '<div class="run-actions">' +
        (canCancel ? '<button class="btn btn-danger" type="button" id="run-cancel-btn">Cancel</button>' : '') +
        '<button class="btn" type="button" id="run-again">Run again</button>' +
      '</div>' +
    '</div>' +
    (r.error ? '<p class="step-error" style="margin-bottom:16px">' + esc(r.error) + '</p>' : '') +
    (r.input && Object.keys(r.input || {}).length
      ? '<div class="panel" style="margin-bottom:16px"><div class="panel-body tight json" id="run-input-json"></div></div>' : '');

    const live_el = $('[data-since]', host);
    if (live_el) ticker.add(live_el);

    const inputHost = $('#run-input-json', host);
    if (inputHost) {
      inputHost.innerHTML = jsonDetails('Run input', this.run.input, 'run-input', this.openJson);
      wireJson(inputHost, () => this.run.input, this.openJson);
    }

    const c = $('#run-cancel-btn', host);
    if (c) c.addEventListener('click', async () => {
      c.disabled = true;
      try {
        await api.post('/api/runs/' + encodeURIComponent(this.runId) + '/cancel', {});
        toast('Cancel asked for.', 'good');
        this.refresh();
      } catch (err) { toast(err.message, 'bad'); c.disabled = false; }
    });

    const again = $('#run-again', host);
    if (again) again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        const res = await api.post('/api/workflows/' + encodeURIComponent(r.slug) + '/run',
          { input: r.input || {} });
        const id = pick(res, 'runId', 'id');
        toast('Run ' + id + ' started.', 'good');
        if (id !== undefined) location.hash = '#/runs/' + id;
      } catch (err) { toast(err.message, 'bad'); again.disabled = false; }
    });
  },

  /* --- the story: bin/run-story's markdown, rendered --- */

  async drawStory() {
    const host = $('#run-story-body', this.root);
    if (!host) return;
    try {
      const data = await api.get('/api/runs/' + encodeURIComponent(this.runId) + '/story');
      if (!host.isConnected) return;
      if (data && data.available) {
        host.innerHTML = '<p class="list-note mono" style="margin-bottom:8px">' + esc(data.path) + '</p>' +
          '<div class="story-md">' + mdToHtml(data.markdown) + '</div>';
      } else {
        host.innerHTML = '<p class="list-note">No story built yet for this run.</p>' +
          (data && data.hint ? '<p class="list-note mono">' + esc(data.hint) + '</p>' : '');
      }
    } catch (err) {
      host.innerHTML = '<p class="list-note">Could not load the story: ' + esc(err.message) + '</p>';
    }
  },

  /* --- the amber banner --- */

  drawBanner() {
    const host = $('#run-banner', this.root);
    if (!host) return;
    if (this.run && this.run.status === 'waiting_on_timer') {
      // Parked on a wait node. Nobody has to do anything, so this is quiet.
      // It is violet and never amber, and it never reaches the inbox, because
      // the inbox is only for things a person can answer.
      const d = this.run.wakeAt ? new Date(this.run.wakeAt) : null;
      const when = (d && !isNaN(d))
        ? ' It starts again at ' + fmtStamp(this.run.wakeAt) + ', which is ' +
          fmtMs(Math.max(0, d.getTime() - Date.now())) + ' from now.'
        : '';
      host.innerHTML = '<div class="timer-banner">' +
        '<p class="timer-title">Waiting on a timer' +
          ((d && !isNaN(d)) ? ', until ' + esc(pad2(d.getHours()) + ':' + pad2(d.getMinutes())) : '') +
          '.</p>' +
        '<p class="timer-sub">This run is parked on a wait node. It carries on by itself.' +
        esc(when) + ' Nothing for a person to answer here.</p></div>';
      return;
    }
    const waiting = this.prompts.filter((p) => p.status === 'waiting' || p.status === 'claimed');
    if (!this.run || this.run.status !== 'waiting_on_claude' || !waiting.length) {
      if (this.run && this.run.status === 'waiting_on_claude' && !waiting.length) {
        host.innerHTML = '<div class="waiting-banner"><div class="waiting-head">' +
          '<div><p class="waiting-title">Waiting on Claude.</p>' +
          '<p class="waiting-sub">The run is parked, but the prompt is not in this response yet. ' +
          'It will show as soon as the server sends it.</p></div></div></div>';
        return;
      }
      host.innerHTML = '';
      return;
    }

    const p = waiting[0];
    const more = waiting.length > 1
      ? ' <span class="chip">' + (waiting.length - 1) + ' more waiting</span>' : '';

    host.innerHTML = '<div class="waiting-banner">' +
      '<div class="waiting-head">' +
        '<div>' +
          '<p class="waiting-title">Waiting on Claude. Prompt #' + esc(p.id) + ' is in the queue.</p>' +
          '<p class="waiting-sub">Node <span class="mono">' + esc(p.nodeId) + '</span>, wants ' +
            esc(p.expect) + '. Asked ' + esc(ago(p.createdAt)) + '.' +
            (p.retryCount ? ' Tried ' + esc(p.retryCount) + ' time(s) already.' : '') + more +
          '</p>' +
        '</div>' +
        '<div class="waiting-actions">' +
          '<button class="btn" type="button" id="copy-prompt">' + ICON.copy + ' Copy prompt</button>' +
          '<a class="btn" href="#/inbox/' + esc(p.id) + '">Answer it</a>' +
        '</div>' +
      '</div>' +
      (p.system ? '<div class="prompt-block"><p class="prompt-label">System</p>' +
        '<pre class="prompt-text">' + esc(p.system) + '</pre></div>' : '') +
      '<div class="prompt-block"><p class="prompt-label">Prompt</p>' +
        '<pre class="prompt-text">' + esc(p.prompt) + '</pre></div>' +
      (p.schemaHint ? '<div class="prompt-block"><p class="prompt-label">Shape it wants back</p>' +
        '<pre class="prompt-text">' + esc(p.schemaHint) + '</pre></div>' : '') +
    '</div>';

    const btn = $('#copy-prompt', host);
    if (btn) btn.addEventListener('click', () => {
      const full = (p.system ? 'System:\n' + p.system + '\n\n' : '') + p.prompt +
        (p.schemaHint ? '\n\nAnswer with JSON in this shape:\n' + p.schemaHint : '');
      copyText(full).then(
        () => toast('Prompt copied.', 'good'),
        () => toast('Could not copy. Select the text and copy by hand.', 'bad'));
    });
  },

  /* --- agents table: desk, role, actor, output file, result, time -------
     "make the agents visible", 2026-09-17. One row per step, in run order,
     read straight off this.steps (already carries desk/role/actor/
     outputFile/checkResult from GET /api/runs/:id). A parked step (no
     endedAt yet, on a claude node) shows "waiting for <role>" instead of a
     result, same wording as the step list's own park label. */
  drawAgentsTable() {
    const host = $('#run-agents', this.root);
    if (!host) return;
    if (!this.steps.length) {
      host.innerHTML = emptyBlock('No steps yet.', 'They will appear here as the run moves.');
      return;
    }
    const rows = this.steps.map((s) => {
      const park = parkedLook(s, this.run);
      const result = park
        ? esc('waiting for ' + (s.role || 'Claude'))
        : (s.checkResult ? esc(s.checkResult) : (s.error ? '<span style="color:var(--st-failed)">' + esc(s.error) + '</span>' : (s.status === 'done' ? 'ok' : esc(s.status))));
      const time = s.startedAt ? esc(fmtMs(durMs(s.startedAt, s.endedAt))) : '';
      // "skills on the desks", 2026-09-17: same list shape as
      // BRIEF-ROUTING.yaml's skills: field, "skill (provenance tag)"
      // strings. No skill wired here shows plainly, not blank, per
      // references/SKILLS-PROVENANCE.md's WIRED/UNWIRED split.
      const skillsCell = (s.skills && s.skills.length)
        ? s.skills.map((sk) => esc(sk)).join('<br>')
        : '<span style="color:var(--muted)">none wired</span>';
      return '<tr>' +
        '<td>' + esc(s.desk || 'none') + '</td>' +
        '<td>' + esc(s.role || 'none') + '</td>' +
        '<td>' + skillsCell + '</td>' +
        '<td>' + esc(s.actor || 'none') + '</td>' +
        '<td class="mono">' + (s.outputFile ? esc(s.outputFile) : 'none') + '</td>' +
        '<td>' + result + '</td>' +
        '<td class="num">' + time + '</td>' +
      '</tr>';
    }).join('');
    host.innerHTML = '<table class="table"><thead><tr>' +
      '<th>Desk</th><th>Role</th><th>Skills</th><th>Actor</th><th>Output file</th><th>Result</th><th class="num">Time</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  },

  /* --- steps --- */

  drawSteps() {
    const host = $('#run-steps', this.root);
    if (!host) return;
    const count = $('#steps-count', this.root);
    if (count) count.textContent = this.steps.length + ' step' + (this.steps.length === 1 ? '' : 's');

    if (!this.steps.length) {
      host.innerHTML = emptyBlock('No steps yet.',
        this.run && this.run.status === 'queued'
          ? 'This run is queued. The first step will show the moment it starts.'
          : 'Nothing has run for this workflow yet.');
      this.stepEls.clear();
      return;
    }

    // Build the list of things to draw: a header when the loop iteration
    // changes, then the step itself. Both carry a key so the patch is cheap.
    const list = [];
    let lastIter;
    for (const s of this.steps) {
      const iter = (s.iteration === null || s.iteration === undefined) ? null : Number(s.iteration);
      if (iter !== null && iter !== lastIter) {
        list.push({ kind: 'iter', key: 'iter:' + s.nodeId + ':' + iter, iter });
      }
      lastIter = iter;
      list.push({
        kind: 'step',
        key: 'step:' + (s.id !== undefined ? s.id : s.nodeId + ':' + iter),
        step: s,
      });
    }

    // The one step the run is actually stopped on is the last one still
    // running. Everything above it that is also running is a wrapper: an each
    // loop or a sub workflow that cannot finish until the inner one does.
    let parkedStep = null;
    if (this.run && PARKED_RUN[this.run.status]) {
      for (const s of this.steps) if (s.status === 'running') parkedStep = s;
    }

    const seen = new Set();
    let prev = null;
    for (const item of list) {
      seen.add(item.key);
      let el = this.stepEls.get(item.key);
      if (!el) {
        el = document.createElement('div');
        el.dataset.key = item.key;
        this.stepEls.set(item.key, el);
        el.dataset.sig = '';
      }
      if (item.kind === 'iter') {
        if (el.dataset.sig !== 'iter') {
          el.className = 'iter-head';
          el.innerHTML = '<span class="eyebrow">Loop item ' + esc(item.iter) + '</span>';
          el.dataset.sig = 'iter';
        }
      } else {
        const s = item.step;
        const park = parkedLook(s, this.run);
        if (park) park.here = (s === parkedStep);
        const sig = [s.status, s.startedAt, s.endedAt, s.error,
          park ? park.status + (park.here ? '!' : '') + park.text : '-',
          s.output === undefined ? '0' : '1', s.input === undefined ? '0' : '1'].join('|');
        // Lets a click on the canvas find its step here and scroll to it,
        // see focusStep. Cheap, and it does not need to be part of the sig.
        el.dataset.nodeId = String(s.nodeId);
        if (el.dataset.sig !== sig) {
          el.className = 'step';
          // The dot follows the same rule as the pill. A blue pulsing dot on a
          // step that is only waiting is the same lie in a smaller shape.
          el.dataset.status = park ? park.status : s.status;
          el.innerHTML = this.stepHtml(s, item.key, park);
          el.dataset.sig = sig;
          wireJson(el, (key) => {
            const which = key.split('::')[1];
            return which === 'in' ? s.input : s.output;
          }, this.openJson);
          const l = $('[data-since]', el);
          if (l) ticker.add(l);
        }
      }
      const wanted = prev ? prev.nextSibling : host.firstChild;
      if (el !== wanted) host.insertBefore(el, wanted);
      prev = el;
    }
    for (const [key, el] of this.stepEls) {
      if (!seen.has(key)) { el.remove(); this.stepEls.delete(key); }
    }
  },

  stepHtml(s, key, park) {
    // `park` is set only when the run is parked and this step is one of the
    // steps sitting still because of it. See parkedLook.
    const running = s.status === 'running' && !park;
    const ms = durMs(s.startedAt, s.endedAt);
    const timeAttrs = park
      ? (park.since ? ' data-since="' + esc(park.since) + '" data-prefix="' + esc(park.prefix) + '"' : '')
      : (running ? ' data-since="' + esc(s.startedAt) + '"' : '');
    const timeText = park ? park.text : (s.startedAt ? fmtMs(ms) : '');
    return '<span class="step-dot" aria-hidden="true"></span>' +
      '<div class="step-row">' +
        '<span class="node-badge" title="' + esc(nodeLabel(s.nodeType)) + '">' +
          esc(nodeMonogram(s.nodeType)) + '</span>' +
        '<div class="step-main">' +
          '<p class="step-name">' + esc(s.name || s.nodeId) + '</p>' +
          '<p class="step-sub">' + esc(s.nodeId) + ' &middot; ' + esc(nodeLabel(s.nodeType)) +
            (s.desk ? ' &middot; ' + esc(s.desk) : '') + '</p>' +
          (s.role || s.actor
            ? '<p class="step-role">' +
                (s.role ? '<span class="step-role-name">' + esc(s.role) + '</span>' : '') +
                (s.role && s.actor ? ' &middot; ' : '') +
                (s.actor ? '<span class="step-actor">' + esc(s.actor) + '</span>' : '') +
              '</p>'
            : '') +
        '</div>' +
        (park && park.here ? '<span class="chip park-here">parked here</span>' : '') +
        (park ? pill(park.status, park.label) : pill(s.status)) +
        '<span class="step-time' + (park ? ' step-time-wait' : '') + '"' + timeAttrs + '>' +
          esc(timeText) + '</span>' +
      '</div>' +
      (s.error ? '<p class="step-error">' + esc(s.error) + '</p>' : '') +
      '<div class="json">' +
        jsonDetails('Input', s.input, key + '::in', this.openJson) +
        jsonDetails('Output', s.output, key + '::out', this.openJson) +
      '</div>';
  },

  /* --- the log --- */

  /**
   * The log draws from two lists: what the API says happened (authoritative)
   * and what the socket has said since (provisional). A refetch replaces the
   * first and empties the second, so a line can never appear twice just
   * because the stored wording and the live wording differ.
   *
   * Volume is handled by drawing a window, not the lot. Measured on 2026-08-19
   * with 2,000 events in one run: 401 lines drawn, 4,736 DOM nodes on the page,
   * first paint 56ms.
   */
  logEvents() {
    const all = this.hist.concat(this.liveTail);
    return all.length > LOG_KEEP ? all.slice(-LOG_KEEP) : all;
  },

  drawLog() {
    const host = $('#run-log', this.root);
    if (!host) return;
    const countEl = $('#log-count', this.root);
    const moreEl = $('#log-more', this.root);

    const all = this.logEvents();
    const window_ = this.showAllLog ? all.length : LOG_WINDOW;
    const visible = all.slice(-window_);
    const hidden = all.length - visible.length;

    // Nothing changed, so do not touch the DOM at all.
    const sig = all.length + ':' + window_ + ':' +
      (visible.length ? visible[visible.length - 1].ts + visible[visible.length - 1].message : '');
    if (sig === this.logSig) return;
    this.logSig = sig;

    if (countEl) countEl.textContent = all.length + ' event' + (all.length === 1 ? '' : 's');

    if (moreEl) {
      const want = hidden > 0
        ? '<div class="log-more"><span class="muted">' + hidden.toLocaleString() +
          ' older lines are hidden so the page stays quick.</span>' +
          '<button class="btn btn-sm" type="button" id="log-all">Show all</button></div>'
        : '';
      if (moreEl.dataset.want !== want) {
        moreEl.innerHTML = want;
        moreEl.dataset.want = want;
        const b = $('#log-all', moreEl);
        if (b) b.addEventListener('click', () => {
          this.showAllLog = true;
          this.logSig = '';
          this.drawLog();
        });
      }
    }

    if (!all.length) {
      host.innerHTML = '<div class="empty"><p class="empty-title">No events yet.</p>' +
        '<p class="empty-note">Lines land here as the run goes.</p></div>';
      return;
    }

    // Follow the tail only while the reader is already at the tail.
    const stick = $('#log-stick', this.root);
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
    const follow = (stick && stick.checked && atBottom) || host.scrollTop === 0;
    const keepTop = host.scrollTop;

    const frag = document.createDocumentFragment();
    for (const e of visible) {
      const div = document.createElement('div');
      div.className = 'log-line';
      div.dataset.level = e.level;
      div.innerHTML = '<span class="log-ts">' + esc(fmtClock(e.ts)) + '</span>' +
        '<span class="log-lv">' + esc(e.level) + '</span>' +
        '<span class="log-msg">' + esc(e.message) +
        (logData(e) ? ' <span class="log-data">' + esc(logData(e)) + '</span>' : '') +
        '</span>';
      frag.appendChild(div);
    }
    host.replaceChildren(frag);

    host.scrollTop = follow ? host.scrollHeight : keepTop;
  },

  /* --------------------------------------------------------------------------
     The canvas, on the run page. This is the payoff: the same landscape
     canvas as the workflow page, with the run's live status painted on top so
     a workflow lights up node by node as it goes. Nothing here edits
     anything, a run is not the place to change a step.

     Loading the definition and creating the canvas both happen once per
     mount, then every refresh only calls setRunState, never a re-layout, so a
     busy run does not thrash the canvas while it streams.
     ----------------------------------------------------------------------- */

  async ensureCanvas() {
    const runId = this.runId;
    if (!this.root || !this.run || !this.run.slug || this.canvasUnavailable) return;

    if (!this.def) {
      let raw;
      try {
        raw = await api.get('/api/workflows/' + encodeURIComponent(this.run.slug));
      } catch (err) {
        // The workflow behind this run may be gone or renamed. The step list
        // and the log still tell the whole story, so the canvas just steps
        // aside quietly rather than erroring the page.
        if (String(this.runId) !== String(runId)) return;
        this.canvasUnavailable = true;
        this.hideCanvasPanel();
        return;
      }
      if (!this.root || String(this.runId) !== String(runId)) return;
      this.def = (raw && raw.definition && raw.definition.nodes) ? raw.definition : raw;
    }

    if (!this.canvas) {
      const host = $('#run-canvas-host', this.root);
      if (!host) return;
      const mods = await canvasModules();
      if (!this.root || String(this.runId) !== String(runId)) return;
      if (!mods.ok) { this.canvasUnavailable = true; this.hideCanvasPanel(); return; }
      this.canvasApi = mods;
      try {
        this.canvas = mods.createCanvas(host, {
          onNodeClick: (id) => this.focusStep(id),
          onNodeDoubleClick: (id) => this.focusStep(id),
          // A run is not editable. Say so rather than silently doing nothing,
          // a hover plus that does not respond reads as broken.
          onAddAfter: () => toast('Steps cannot be added from a run. Open the workflow to edit it.'),
          onSubOpen: (slug) => { location.hash = '#/workflows/' + encodeURIComponent(slug); },
        });
        const layoutResult = mods.layout(this.def, {});
        this.canvas.render(this.def, layoutResult);
      } catch (err) {
        console.error('run canvas failed to draw', err);
        this.canvasUnavailable = true;
        this.canvas = null;
        this.hideCanvasPanel();
        return;
      }
    }

    this.paintCanvas();
  },

  hideCanvasPanel() {
    const wrap = this.root && $('#run-canvas-panel', this.root);
    if (wrap) wrap.style.display = 'none';
  },

  /** Paints the run onto the canvas without touching the layout. Called on
   *  every refresh, so this has to stay cheap: build one small status map and
   *  hand it over, graph-canvas.js does the rest. */
  paintCanvas() {
    if (!this.canvas || !this.run) return;
    const steps = {};
    let currentNodeId = null;
    for (const s of this.steps) {
      const park = parkedLook(s, this.run);
      steps[s.nodeId] = park ? park.status : s.status;
      // The last step still running is the one the run is actually stopped
      // on, same rule drawSteps uses to pick parkedStep: anything above it
      // that is also "running" is a loop or a sub workflow wrapper.
      if (s.status === 'running') currentNodeId = s.nodeId;
    }
    try {
      this.canvas.setRunState({ steps, currentNodeId, runStatus: this.run.status });
    } catch (err) { console.error('setRunState failed', err); }
  },

  /** A node clicked on the canvas scrolls to and flashes its row in the step
   *  list below, the same jump the workflow page already does for its cards.
   *  If a node ran more than once, in a loop, the latest run of it is used. */
  focusStep(nodeId) {
    const matches = $$('[data-node-id="' + String(nodeId).replace(/"/g, '') + '"]', this.root);
    const el = matches[matches.length - 1];
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Reuses the same @keyframes flash the runs table already animates a
    // fresh row with, just set inline since a step has no data-fresh hook.
    el.style.animation = 'flash 1.1s ease-out 1';
    setTimeout(() => { el.style.animation = ''; }, 1200);
  },
};
runView.softRefresh = throttled(() => runView.refresh(), 700);

function fact(label, valueHtml) {
  return '<div><p class="fact-label">' + esc(label) + '</p>' +
    '<p class="fact-value">' + valueHtml + '</p></div>';
}

/** The tail of an event line. The type key is dropped, the message already says it. */
function logData(e) {
  let d = e.data;
  if (d === undefined || d === null || d === '') return '';
  if (typeof d === 'object' && !Array.isArray(d)) {
    const rest = {};
    let any = false;
    for (const k of Object.keys(d)) {
      // Skip anything the message already says, so the line does not repeat itself.
      if (k === 'type' || k === 'runId' || k === 'run_id') continue;
      if (k === 'nodeId' || k === 'node_id' || k === 'name' || k === 'nodeType' ||
          k === 'node_type' || k === 'slug') continue;
      if (d[k] === undefined || d[k] === null) continue;
      if (k === 'error' && e.message && e.message.indexOf(String(d[k])) !== -1) continue;
      rest[k] = d[k]; any = true;
    }
    if (!any) return '';
    d = rest;
  }
  let t;
  try { t = typeof d === 'string' ? d : JSON.stringify(d); }
  catch { t = String(d); }
  if (!t) return '';
  return t.length > 180 ? t.slice(0, 180) + '...' : t;
}

/* ----------------------------------------------------------------------------
   View 4: inbox

   The manual way to answer a parked prompt. Two panes, like a mail app: the
   queue on the left, the one you are answering on the right. Drafts are kept
   per prompt in localStorage, so a server restart or a stray refresh does not
   throw away typing.
   -------------------------------------------------------------------------- */

const DRAFT_PREFIX = 'aflow.draft.';

/**
 * THE REJECTED ANSWER SLOT.  Job 4. See normPrompt for the field names.
 *
 * Draws nothing at all unless the prompt has been tried before. Three levels,
 * best first:
 *
 *   1. we know the answer and why it was refused  -> show both
 *   2. we know only that it was tried before      -> say so, and say honestly
 *                                                    that the text is not kept yet
 *   3. first attempt                              -> nothing
 *
 * Level 2 exists so the person is never quietly misled into thinking this is a
 * fresh question when it is not.
 */
function rejectedBlock(p) {
  const hasText = Boolean(p.lastAnswer);
  const hasWhy = Boolean(p.lastError);
  const tried = Number(p.retryCount) > 0;
  if (!hasText && !hasWhy && !tried) return '';

  const attempt = tried
    ? 'Answered ' + p.retryCount + ' time' + (p.retryCount === 1 ? '' : 's') + ' already and sent back.'
    : 'This answer was sent back.';

  let body = '';
  if (hasWhy) {
    body += '<div class="rejected-part"><p class="rejected-label">Why it was sent back</p>' +
      '<pre class="rejected-text">' + esc(p.lastError) + '</pre></div>';
  }
  if (hasText) {
    body += '<div class="rejected-part"><p class="rejected-label">What was sent last time</p>' +
      '<pre class="rejected-text">' + esc(p.lastAnswer) + '</pre></div>';
  }
  if (!hasText && !hasWhy) {
    body += '<p class="rejected-note">The server does not keep the refused answer yet, so ' +
      'there is nothing to show here. It only tells us this prompt came back. ' +
      'If the node wants JSON, the usual cause is a trailing comma, a missing ' +
      'bracket, or words wrapped around the JSON.</p>';
  }

  return '<div class="rejected-block">' +
    '<div class="rejected-head">' +
      '<span class="pill" data-status="failed">sent back</span>' +
      '<p class="rejected-title">' + esc(attempt) + '</p>' +
    '</div>' + body + '</div>';
}

const inboxView = {
  root: null,
  prompts: [],
  selected: null,
  seenIds: new Set(),

  async mount(root, params) {
    this.root = root;
    this.selected = params && params.id ? String(params.id) : null;
    root.innerHTML = '<div class="page flush"><div class="inbox">' +
      '<div class="inbox-list">' +
        '<div class="inbox-list-head">' +
          '<span class="eyebrow">Waiting on Claude</span>' +
          '<span class="spacer"></span>' +
          '<span class="eyebrow" id="inbox-count"></span>' +
          '<button class="btn btn-sm" type="button" id="inbox-refresh">Refresh</button>' +
        '</div>' +
        '<div class="inbox-items scroll" id="inbox-items"></div>' +
      '</div>' +
      '<div class="inbox-detail" id="inbox-detail"></div>' +
    '</div></div>';
    $('#inbox-refresh').addEventListener('click', () => this.refresh());
    await this.refresh();
  },

  unmount() { this.root = null; },

  event(msg) {
    if (msg.type === 'prompt.new' || msg.type === 'prompt.answered' ||
        msg.type === 'run.waiting' || msg.type === 'run.failed') {
      this.softRefresh();
    }
  },

  softRefresh: null,

  async refresh() {
    if (!this.root) return;
    try {
      const data = await api.get('/api/claude/pending');
      const list = asArray(data).map(normPrompt).filter((p) => p.id !== undefined);
      // Newest last is what the contract promises. The inbox reads newest first.
      list.reverse();
      this.prompts = list;
      store.setWaiting(list.length);
      if (this.selected && !list.some((p) => String(p.id) === String(this.selected))) {
        this.selected = null;
      }
      if (!this.selected && list.length) this.selected = String(list[0].id);
      this.draw();
    } catch (err) {
      const items = $('#inbox-items', this.root);
      if (items) items.innerHTML = '';
      const detail = $('#inbox-detail', this.root);
      if (detail) {
        detail.innerHTML = errorBlock(err, 'inbox-retry');
        const b = $('#inbox-retry', detail);
        if (b) b.addEventListener('click', () => this.refresh());
      }
    }
  },

  draw() {
    const items = $('#inbox-items', this.root);
    const count = $('#inbox-count', this.root);
    if (!items) return;
    count.textContent = this.prompts.length ? String(this.prompts.length) : '';

    if (!this.prompts.length) {
      items.innerHTML = '<p class="list-note">Nothing is waiting.</p>';
      this.drawDetail(null);
      return;
    }

    items.innerHTML = this.prompts.map((p) => {
      const isNew = !this.seenIds.has(String(p.id));
      return '<button class="inbox-item" type="button" data-id="' + esc(p.id) + '"' +
        (String(p.id) === String(this.selected) ? ' aria-current="true"' : '') +
        (isNew ? ' data-unread="1"' : '') + '>' +
        '<span class="inbox-item-top">' +
          '<span class="inbox-item-id">#' + esc(p.id) + '</span>' +
          '<span class="chip">' + esc(p.expect) + '</span>' +
          '<span class="inbox-item-age">' + esc(ago(p.createdAt)) + '</span>' +
        '</span>' +
        '<span class="inbox-item-sub">run ' + esc(p.runId) + ' &middot; node ' + esc(p.nodeId) +
          (p.slug ? ' &middot; ' + esc(p.slug) : '') + '</span>' +
        '<span class="inbox-item-prev">' + esc(p.prompt.slice(0, 220)) + '</span>' +
      '</button>';
    }).join('');

    $$('.inbox-item', items).forEach((b) => {
      b.addEventListener('click', () => {
        this.selected = b.dataset.id;
        this.seenIds.add(b.dataset.id);
        history.replaceState(null, '', '#/inbox/' + b.dataset.id);
        this.draw();
      });
    });

    const chosen = this.prompts.find((p) => String(p.id) === String(this.selected)) || this.prompts[0];
    if (chosen) this.seenIds.add(String(chosen.id));
    this.drawDetail(chosen);
  },

  drawDetail(p) {
    const host = $('#inbox-detail', this.root);
    if (!host) return;

    if (!p) {
      host.innerHTML = emptyBlock('The inbox is empty.',
        'Nothing is waiting on Claude right now. When a workflow hits a Claude node it parks ' +
        'itself and the prompt lands here. From the shell it is ' +
        '<code>bin/aflow next</code> then <code>bin/aflow answer</code>');
      return;
    }

    const draft = localStorage.getItem(DRAFT_PREFIX + p.id) || '';

    host.innerHTML =
      '<div class="inbox-detail-head">' +
        '<div>' +
          '<p class="eyebrow">Prompt #' + esc(p.id) + '</p>' +
          '<p class="page-sub">Run <a href="#/runs/' + esc(p.runId) + '" class="mono">' +
            esc(p.runId) + '</a> &middot; node <span class="mono">' + esc(p.nodeId) + '</span>' +
            ' &middot; asked ' + esc(ago(p.createdAt)) + '</p>' +
        '</div>' +
        '<span class="spacer"></span>' +
        (p.retryCount ? '<span class="chip">retry ' + esc(p.retryCount) + '</span>' : '') +
        pill(p.status) +
        '<button class="btn btn-sm" type="button" id="inbox-copy">' + ICON.copy + ' Copy</button>' +
      '</div>' +

      '<div class="inbox-detail-body scroll">' +

        /* ------------------------------------------------------------------
           THE REJECTED ANSWER SLOT.  Job 4.  Sits first, above the prompt.

           It renders itself the moment the API starts sending any of
           lastAnswer, lastError or retryCount > 0. Until then it is one
           boolean that is false, and the pane looks exactly as it did.

           It is first on the page and not last on purpose. Somebody answering
           a second time needs to know what was wrong with the first answer
           before they read the question again, not after they have typed a new
           one. See normPrompt for the field names and what the server still
           owes us.
           --------------------------------------------------------------- */
        rejectedBlock(p) +

        (p.system ? '<div class="prompt-block"><p class="prompt-label">System</p>' +
          '<pre class="prompt-text">' + esc(p.system) + '</pre></div>' : '') +
        '<div class="prompt-block"><p class="prompt-label">Prompt</p>' +
          '<pre class="prompt-text">' + esc(p.prompt) + '</pre></div>' +
        (p.schemaHint ? '<div class="prompt-block"><p class="prompt-label">Shape it wants back</p>' +
          '<pre class="prompt-text">' + esc(p.schemaHint) + '</pre></div>' : '') +
      '</div>' +

      '<div class="inbox-detail-foot">' +
        '<label class="field-label" for="answer">Your answer' +
          (p.expect === 'json' ? ' (JSON)' : '') + '</label>' +
        '<textarea class="answer-box" id="answer" spellcheck="false" placeholder="' +
          (p.expect === 'json' ? 'Paste the JSON the node asked for' : 'Type the answer') +
          '"></textarea>' +
        '<p class="field-error" id="answer-error" hidden></p>' +
        '<div class="answer-foot">' +
          '<button class="btn btn-primary" type="button" id="answer-send">Send answer</button>' +
          '<button class="btn btn-danger btn-sm" type="button" id="answer-fail">Cannot answer</button>' +
          '<span class="spacer"></span>' +
          '<span class="answer-hint">Cmd or Ctrl plus Enter sends it. The run picks up straight away.</span>' +
        '</div>' +
      '</div>';

    const ta = $('#answer', host);
    ta.value = draft;
    ta.addEventListener('input', () => {
      try { localStorage.setItem(DRAFT_PREFIX + p.id, ta.value); } catch {}
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.send(p); }
    });
    ta.focus();

    $('#answer-send', host).addEventListener('click', () => this.send(p));
    $('#inbox-copy', host).addEventListener('click', () => {
      const full = (p.system ? 'System:\n' + p.system + '\n\n' : '') + p.prompt +
        (p.schemaHint ? '\n\nAnswer with JSON in this shape:\n' + p.schemaHint : '');
      copyText(full).then(
        () => toast('Prompt copied.', 'good'),
        () => toast('Could not copy. Select the text and copy by hand.', 'bad'));
    });
    $('#answer-fail', host).addEventListener('click', () => this.fail(p));
  },

  async send(p) {
    const host = this.root;
    const ta = $('#answer', host);
    const err = $('#answer-error', host);
    const btn = $('#answer-send', host);
    const answer = ta.value;
    err.hidden = true;

    if (!answer.trim()) {
      err.textContent = 'Write something first.';
      err.hidden = false;
      return;
    }
    if (p.expect === 'json') {
      try { JSON.parse(answer); }
      catch (e) {
        err.textContent = 'This node wants JSON and that will not parse: ' + e.message +
          '. Fix it, or the step fails and the prompt comes straight back.';
        err.hidden = false;
        return;
      }
    }

    btn.disabled = true;
    btn.textContent = 'Sending';
    try {
      const res = await api.post('/api/claude/answer', { promptId: p.id, answer });
      try { localStorage.removeItem(DRAFT_PREFIX + p.id); } catch {}
      toast('Answered. Run ' + (pick(res, 'runId') || p.runId) + ' is going again.', 'good');
      this.selected = null;
      await this.refresh();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send answer';
    }
  },

  async fail(p) {
    const reason = prompt('Why can this not be answered?');
    if (reason === null) return;
    try {
      await api.post('/api/claude/fail', { promptId: p.id, reason: reason || 'No reason given.' });
      toast('Prompt ' + p.id + ' marked failed.', 'good');
      this.selected = null;
      await this.refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  },
};
inboxView.softRefresh = throttled(() => inboxView.refresh(), 800);

/* ----------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */

let current = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/workflows';
  const [path, qs] = raw.split('?');
  const query = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'runs' && parts[1]) return { name: 'run', view: runView, params: { id: parts[1], query } };
  if (parts[0] === 'runs') return { name: 'runs', view: runsView, params: { query } };
  if (parts[0] === 'inbox') return { name: 'inbox', view: inboxView, params: { id: parts[1], query } };
  if (parts[0] === 'workflows' && parts[1]) {
    return { name: 'workflow', view: workflowView, params: { id: decodeURIComponent(parts[1]), query } };
  }
  return { name: 'workflows', view: workflowsView, params: { query } };
}

let routeToken = 0;

async function route() {
  const target = parseHash();
  const token = ++routeToken;

  // Switching between two prompts inside the inbox should not remount it.
  // Two different workflow pages are two different pages, so a slug change
  // remounts. Only the inbox switches in place.
  if (current === target.view && target.name === 'workflow' && current.root &&
      current.slug === target.params.id) {
    markTab(target.name);
    return;
  }

  if (current === target.view && target.name === 'inbox' && current.root) {
    inboxView.selected = target.params.id || inboxView.selected;
    inboxView.draw();
    markTab(target.name);
    return;
  }

  if (current && current.unmount) {
    try { current.unmount(); } catch (err) { console.error(err); }
  }
  ticker.clear();
  const root = $('#view');
  root.innerHTML = '';
  current = target.view;
  markTab(target.name);
  try {
    await target.view.mount(root, target.params);
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    root.innerHTML = '<div class="page">' + errorBlock(err, 'route-retry') + '</div>';
    const b = $('#route-retry');
    if (b) b.addEventListener('click', () => route());
  }
  needsYou.render();
}

function markTab(name) {
  const tab = name === 'run' ? 'runs' : (name === 'workflow' ? 'workflows' : name);
  $$('.nav-tab').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = 'ARTHA FLOW, ' + tab;
}

/* ----------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function boot() {
  wireDialog();
  wireNodeDialog();
  $('#conn').addEventListener('click', () => live.connectNow());
  window.addEventListener('hashchange', route);

  // Coming back to the tab after a sleep: check both channels straight away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pollHealth();
      if (!live.ws) live.connectNow();
      if (current && current.refresh) current.refresh();
      needsYou.refresh();
    }
  });

  if (!location.hash) location.hash = '#/workflows';
  route();
  pollHealth();
  needsYou.refresh();
  setInterval(pollHealth, 15000);
  setInterval(() => needsYou.refresh(), 15000);
  live.connect();

  // If the socket is down the page still stays honest, just slower.
  setInterval(() => {
    if (live.ws && live.ws.readyState === 1) return;
    if (current && current.refresh && store.apiUp) current.refresh();
  }, 5000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
