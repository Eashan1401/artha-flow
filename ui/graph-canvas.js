/* ============================================================================
   ARTHA FLOW, the canvas renderer. B2 owns this file and graph.css only.

   export function createCanvas(host, opts) -> {
     render(definition, layoutResult),
     setRunState(runState),
     focusNode(nodeId),
     fit(),
     destroy(),
   }

   Built against docs/CANVAS-CONTRACT.md. Zero dependencies, plain ES module,
   no build step. B1 (ui/graph-layout.js) and B3 (ui/app.js, ui/index.html) are
   built by other agents against the same contract at the same time, so this
   file never imports either of them and never assumes B1's file exists.

   How it stays at 60fps
   ----------------------------------------------------------------------------
   Everything the user sees while panning or zooming lives inside ONE wrapper
   element, .gcanvas-viewport. Pan and zoom write exactly one CSS `transform`
   on that element per frame, and nothing else. No node is re-measured, no
   edge is re-routed, no style is written to any card during a mouse move or a
   wheel event. The background dot grid is the one exception, and it is a
   single `background-position` / `background-size` write on the outer
   container, not per node.

   Layout is computed once by B1 and only touched again in two cases, both of
   them rare and both of them bounded:

     - a card is dragged: only that card and the edges attached to it are
       rewritten, not the whole graph
     - setRunState paints attributes on cards and edges, which is a lookup by
       id into small Maps built once at render time, not a re-render

   Coordinate system
   ----------------------------------------------------------------------------
   Layout gives every node an (x, y) top left corner in "world" units and every
   edge a polyline in the same units. The SVG edge layer and the node div layer
   are both sized to layoutResult.width x layoutResult.height and positioned at
   (0, 0) inside the transformed wrapper, so a world coordinate IS a CSS pixel
   inside that wrapper. The wrapper's transform is
   `translate(panX, panY) scale(zoom)`, so:

     screenX = worldX * zoom + panX
     screenY = worldY * zoom + panY

   which is what makes "zoom toward the pointer" a two line fix: keep the
   world point under the cursor fixed while zoom changes, and pan absorbs the
   rest.
   ========================================================================= */

// 0.25 is the default floor. It is not always right: fitting a 27 node
// landscape row (linkedin-leads is 5996 x 750) into a 1440px window needs
// about 0.24x, and into a 768px window about 0.13x, so a hard 0.25 floor
// would make the fit button lie on the one workflow that most needs it.
// createCanvas recomputes the real floor per render as
// Math.min(DEFAULT_MIN_ZOOM, rawFitZoom * 0.9), so `fit()` can always
// genuinely fit whatever is on screen, and a small graph still keeps the
// same sane floor it always had.
const DEFAULT_MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
// n8n sized cards, matching ui/graph-layout.js's own defaults (2026-08-19
// correction: boxes stay boxes, just tighter, not bare icon tiles). These are
// only the fallback for a card B1 did not size, the real w/h always comes
// from the layout result.
const DEFAULT_W = 190;
const DEFAULT_H = 100;
const FIT_MARGIN = 24;
const POSITIONS_VERSION = 'v2';

// The opening view fits the graph's HEIGHT into the panel, not its width,
// then clamps into this band. A true width fit on a wide, short landscape
// row (linkedin-leads is 5996 x 750) forces the zoom down around 0.18x,
// where no text is readable at all. Fitting the height instead keeps the
// zoom in a band where 11px mono prompt text is legible, because the whole
// point of this canvas is that the prompt is readable without a click.
const OPEN_MIN_ZOOM = 0.5;
const OPEN_MAX_ZOOM = 1;

// The host panel B3 hands us gets its own height set from here rather than
// staying whatever fixed number B3's markup happens to use, so a small
// graph does not sit inside a box built for a tall one. HOST_MIN_H matches
// .gcanvas's own CSS min-height so the two never fight. HOST_MAX_H_VH keeps
// a very tall, lane heavy graph from swallowing the whole page on a big
// screen, and HOST_MAX_H_CAP is a hard ceiling under that.
const HOST_MIN_H = 320;
const HOST_MAX_H_CAP = 760;
const HOST_MAX_H_VH = 0.72;
// Room for the fit margin on both edges plus the controls and hint, so the
// panel is not sized edge to edge with the content.
const HOST_CHROME = FIT_MARGIN * 2 + 40;
// Below this zoom the detail line and id are unreadable anyway, so the card
// swaps to badge, colour and name only. Cheaper to paint and easier to scan
// on a wide graph seen mostly zoomed out. Toggled by ONE attribute on the
// root, never by touching individual cards.
const SIMPLIFY_BELOW_ZOOM = 0.4;

/** The ten node types the contract and the server registry both know about.
 *  A type outside this list still renders fully (its own two letter badge,
 *  its tier falls back to plumbing), it just also gets a dashed border, so a
 *  node type nobody has written a card for yet is visibly different without
 *  ever being broken. */
const KNOWN_TYPES = new Set(['manual', 'log', 'http', 'claude', 'transform', 'filter', 'each', 'write', 'wait', 'sub']);

/** The exact tier table from CANVAS-CONTRACT.md: prompt for claude, gate for
 *  filter, loop for each, sub for sub, io for http/write/wait, plumbing for
 *  log/transform/manual. This is a fixed, one to one mapping off the node's
 *  own type string, so B2 can work it out on its own rather than trusting a
 *  `tier` field that has to survive a layout call, a JSON round trip, and
 *  whatever B3 does with it in between. A tier B1 hands over is still used as
 *  a fallback for a type outside this table, in case B1 ever knows something
 *  about a custom node type that this map does not. */
const TYPE_TIER = {
  claude: 'prompt', filter: 'gate', each: 'loop', sub: 'sub',
  http: 'io', write: 'io', wait: 'io', log: 'plumbing', transform: 'plumbing', manual: 'plumbing',
};

function resolveTier(node, suppliedTier) {
  const byType = node && node.type ? TYPE_TIER[node.type] : undefined;
  if (byType) return byType;
  if (suppliedTier) return suppliedTier;
  return 'plumbing';
}

/* ----------------------------------------------------------------------------
   Small helpers. Copied rather than imported from ui/app.js on purpose: B2
   owns exactly two files and must not reach into B3's file to get them.
   -------------------------------------------------------------------------- */

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/** First two letters of a type, upper case. Unknown types still get one. */
function typeBadge(type) {
  if (!type) return '?';
  return String(type).slice(0, 2).toUpperCase();
}

/** Cuts a string to a line count worth showing before CSS clamp takes over.
 *  This is a safety cap for pathological input (a ten thousand line prompt),
 *  not the visual clamp itself, which is done in CSS with -webkit-line-clamp. */
function capText(text, maxChars) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '…';
}

function oneLine(text, maxChars) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return capText(s, maxChars || 90);
}

function fmtWaitLine(cfg) {
  if (!cfg) return '';
  if (cfg.until) return 'until ' + cfg.until;
  if (cfg.forSeconds !== undefined) {
    const s = Number(cfg.forSeconds);
    if (isFinite(s)) {
      if (s < 60) return s + 's';
      if (s < 3600) return Math.round(s / 60) + 'm';
      if (s < 86400) return Math.round(s / 3600) + 'h';
      return Math.round(s / 86400) + 'd';
    }
  }
  return 'no wait time set';
}

const ICON = {
  plus: '<path d="M6 2v8M2 6h8"/>',
  sub: '<path d="M2 8V3.5A1.5 1.5 0 0 1 3.5 2H8"/><path d="M5 5l4-4M9 1v3.2M9 1H5.8" fill="none"/>',
};

/* ----------------------------------------------------------------------------
   Reading a node's content out of its type and config. This is the part of
   the contract that says the prompt IS the product: a claude card shows the
   actual prompt text, not a box that says "Claude".
   -------------------------------------------------------------------------- */

function nodeDetailHtml(entry) {
  const node = entry.node || {};
  const cfg = node.config || {};
  const tier = entry.tier;

  if (tier === 'prompt') {
    const prompt = typeof cfg.prompt === 'string' ? cfg.prompt : '';
    const sys = typeof cfg.system === 'string' && cfg.system.trim() ? true : false;
    const lines = capText(prompt, 400).split('\n').slice(0, 2).join('\n');
    const body = prompt.trim()
      ? '<p class="gc-prompt-text">' + esc(lines) + '</p>'
      : '<p class="gc-prompt-empty">No prompt text set yet.</p>';
    return (sys ? '<span class="gc-sys-chip">sys</span>' : '') + body;
  }

  if (tier === 'gate') {
    const expr = typeof cfg.expression === 'string' ? cfg.expression : '';
    return '<p class="gc-gate-expr">' + (expr ? esc(oneLine(expr, 70)) : 'No condition set.') + '</p>';
  }

  if (tier === 'loop') {
    const items = cfg.items !== undefined ? String(cfg.items) : '';
    return '<p class="gc-loop-line">' + (items ? 'over ' + esc(oneLine(items, 60)) : 'No item list set.') + '</p>';
  }

  if (tier === 'sub') {
    const slug = cfg.slug ? String(cfg.slug) : '';
    if (!slug) return '<p class="gc-io-line">No target workflow set.</p>';
    return '<span class="gc-sub-chip" data-sub-slug="' + esc(slug) + '">' +
      '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor">' + ICON.sub + '</svg>' +
      esc(slug) + '</span>';
  }

  if (tier === 'io') {
    let line = '';
    if (node.type === 'http') line = cfg.url ? String(cfg.url) : '';
    else if (node.type === 'write') line = cfg.path ? String(cfg.path) : '';
    else if (node.type === 'wait') line = fmtWaitLine(cfg);
    else line = cfg.url || cfg.path || '';
    return line ? '<p class="gc-io-line">' + esc(oneLine(line, 70)) + '</p>' : '';
  }

  // plumbing: intentionally no detail line, kept small and quiet
  return '';
}

/**
 * "make the agents visible", 2026-09-17: which desk this node parks work at,
 * and which agent role card owns it, right under the node's name. Read
 * straight off node.config.desk / node.config.role, the same fields the
 * engine renders per step and the run view's Agents table reads back.
 * The graph shows a workflow file, not one run, so a role that is templated
 * ({{ item.role }}, filled in per loop item at run time) is shown as
 * written: a real name here, the resolved one on the run page.
 */
function agentLineHtml(entry) {
  const cfg = (entry.node && entry.node.config) || {};
  const desk = typeof cfg.desk === 'string' && cfg.desk.trim() ? cfg.desk.trim() : '';
  const role = typeof cfg.role === 'string' && cfg.role.trim() ? cfg.role.trim() : '';
  if (!desk && !role) return '';
  return '<div class="gc-agent-line" title="' + esc([desk, role].filter(Boolean).join(', ')) + '">' +
    (desk ? '<span class="gc-desk">' + esc(oneLine(desk, 46)) + '</span>' : '') +
    (role ? '<span class="gc-role">' + esc(oneLine(role, 32)) + '</span>' : '') +
    '</div>';
}

/**
 * "skills on the desks", 2026-09-17: which .agents/skills/ skill this node's
 * desk runs, right under the agent line, same read-off-config pattern as
 * agentLineHtml above (node.config.skills, a list of "skill (provenance
 * tag)" strings, see projects/media-agency/BRIEF-ROUTING.yaml). An empty or
 * missing list renders nothing on the card, same as a node with no desk or
 * role; the full WIRED/UNWIRED account lives in
 * references/SKILLS-PROVENANCE.md, not on every card.
 */
function skillsLineHtml(entry) {
  const cfg = (entry.node && entry.node.config) || {};
  const skills = Array.isArray(cfg.skills) ? cfg.skills.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!skills.length) return '';
  const full = skills.join(', ');
  return '<div class="gc-skills-line" title="' + esc(full) + '">' +
    skills.map((s) => '<span class="gc-skill">' + esc(oneLine(s.split(' (')[0], 22)) + '</span>').join('') +
    '</div>';
}

function cardHtml(entry) {
  const node = entry.node || {};
  const type = node.type || '';
  const name = node.name || node.id || 'Untitled step';
  const id = node.id !== undefined && node.id !== null ? String(node.id) : '';
  const unknown = !type;
  const tier = entry.tier || 'plumbing';

  return (
    '<div class="gc-node-head">' +
      '<span class="gc-badge">' + esc(typeBadge(type)) + '</span>' +
      '<span class="gc-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
      '<span class="gc-id" title="' + esc(id) + '">' + esc(id) + '</span>' +
    '</div>' +
    agentLineHtml(entry) +
    skillsLineHtml(entry) +
    nodeDetailHtml(entry)
  ) || '';
}

/* ----------------------------------------------------------------------------
   Normalising a layout result so nothing downstream has to guard against a
   half built or missing field. B1's file may not exist yet while this file is
   developed, and even once it does, a bad or empty workflow must never throw.
   -------------------------------------------------------------------------- */

function normalizeLayout(layoutResult) {
  const lr = layoutResult && typeof layoutResult === 'object' ? layoutResult : {};
  const nodes = Array.isArray(lr.nodes) ? lr.nodes : [];
  const edges = Array.isArray(lr.edges) ? lr.edges : [];
  const lanes = Array.isArray(lr.lanes) ? lr.lanes : [];

  const safeNodes = nodes
    .filter((n) => n && n.node && n.node.id !== undefined && n.node.id !== null)
    .map((n) => ({
      id: String(n.node.id),
      node: n.node,
      x: isNum(n.x) ? n.x : 0,
      y: isNum(n.y) ? n.y : 0,
      w: isNum(n.w) && n.w > 0 ? n.w : DEFAULT_W,
      h: isNum(n.h) && n.h > 0 ? n.h : DEFAULT_H,
      col: isNum(n.col) ? n.col : 0,
      row: isNum(n.row) ? n.row : 0,
      lane: n.lane || null,
      tier: resolveTier(n.node, n.tier),
    }));

  const byId = new Map(safeNodes.map((n) => [n.id, n]));

  const safeEdges = edges
    .filter((e) => e && e.from !== undefined && e.to !== undefined)
    .map((e) => ({
      from: String(e.from),
      to: String(e.to),
      kind: e.kind || 'next',
      label: e.label || '',
      points: Array.isArray(e.points)
        ? e.points.filter((p) => p && isNum(p.x) && isNum(p.y))
        : [],
    }))
    .filter((e) => byId.has(e.from) && byId.has(e.to));

  const safeLanes = lanes
    .filter((l) => l && l.id !== undefined)
    .map((l) => ({
      id: String(l.id),
      kind: l.kind || 'loop',
      label: l.label || '',
      x: isNum(l.x) ? l.x : 0,
      y: isNum(l.y) ? l.y : 0,
      w: isNum(l.w) && l.w > 0 ? l.w : 200,
      h: isNum(l.h) && l.h > 0 ? l.h : 160,
      ownerId: l.ownerId !== undefined ? String(l.ownerId) : null,
    }));

  let width = isNum(lr.width) && lr.width > 0 ? lr.width : 0;
  let height = isNum(lr.height) && lr.height > 0 ? lr.height : 0;
  if (!width || !height) {
    // Defensive fallback so an empty or malformed width/height never collapses
    // the canvas to nothing when there plainly are nodes to show.
    let maxX = 0, maxY = 0;
    for (const n of safeNodes) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); }
    for (const l of safeLanes) { maxX = Math.max(maxX, l.x + l.w); maxY = Math.max(maxY, l.y + l.h); }
    width = width || maxX || 640;
    height = height || maxY || 320;
  }

  return { nodes: safeNodes, edges: safeEdges, lanes: safeLanes, byId, width, height,
    warnings: Array.isArray(lr.warnings) ? lr.warnings : [] };
}

/* ----------------------------------------------------------------------------
   Wiring: bezier curves between visible ports. This is the single biggest
   visual change from the first pass at this file. n8n draws a cubic bezier
   straight from an output port to an input port, with horizontal control
   points, not an orthogonal line routed around the cards in between. So:

     - every structural edge (next, true, else, back) is exactly two points,
       the output port and the input port, both read off the CURRENT card
       geometry (not a routed path B1 precomputed), so a drag reroutes it for
       free with no dirty flag bookkeeping
     - a filter's two outputs get two distinct ports on its right edge, yes
       above no, worked out once per render in computePortGeometry below
     - the control point offset scales with the distance between the ports,
       Math.max(60, dx * 0.5) for a mostly horizontal wire, so a short hop
       curves gently and a long hop sweeps, exactly the brief's formula.
       A near vertical wire (the rare back edge that lands almost directly
       below its source) falls back to a vertical version of the same idea,
       so it never degenerates into a straight kinked line.
   -------------------------------------------------------------------------- */

const PORT_NUDGE = 1; // px past the card's own border, so the dot never sits
                       // half hidden under the card's background

function outPortXY(entry, frac) {
  return { x: entry.x + entry.w + PORT_NUDGE, y: entry.y + entry.h * frac };
}
function inPortXY(entry) {
  return { x: entry.x - PORT_NUDGE, y: entry.y + entry.h / 2 };
}

/** The two bezier control points for a straight port to port wire. Offset
 *  scales with distance on whichever axis actually separates the two
 *  points, so this reads correctly both for the common left to right wire
 *  and for the rare near vertical one (a tight back edge, or the body
 *  connector's straight line fallback). */
function bezierControls(p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const offset = Math.max(60, Math.abs(dx) * 0.5);
    const dir = dx >= 0 ? 1 : -1;
    return [{ x: p0.x + dir * offset, y: p0.y }, { x: p1.x - dir * offset, y: p1.y }];
  }
  const offset = Math.max(30, Math.abs(dy) * 0.5);
  const dir = dy >= 0 ? 1 : -1;
  return [{ x: p0.x, y: p0.y + dir * offset }, { x: p1.x, y: p1.y - dir * offset }];
}

function cubicAt(t, p0, c1, c2, p1) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y };
}

function bezierPath(p0, p1) {
  if (!p0 || !p1) return { d: '', mid: null };
  const [c1, c2] = bezierControls(p0, p1);
  const d = 'M' + p0.x.toFixed(1) + ',' + p0.y.toFixed(1) +
    ' C' + c1.x.toFixed(1) + ',' + c1.y.toFixed(1) +
    ' ' + c2.x.toFixed(1) + ',' + c2.y.toFixed(1) +
    ' ' + p1.x.toFixed(1) + ',' + p1.y.toFixed(1);
  return { d, mid: cubicAt(0.5, p0, c1, c2, p1) };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/* SVG marker `fill` is a presentation attribute, not every browser resolves
   var() inside one the way it does inside CSS, so the arrowhead colours are
   read straight out of tokens.css at draw time instead of being typed here
   as hex. Still zero hardcoded colour in this file, just read a different
   way than the rest of the UI reads it. */
function cssVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v ? v.trim() : '';
}

/* ============================================================================
   createCanvas
   ========================================================================= */

export function createCanvas(host, opts) {
  opts = opts || {};
  const onNodeClick = typeof opts.onNodeClick === 'function' ? opts.onNodeClick : () => {};
  const onNodeDoubleClick = typeof opts.onNodeDoubleClick === 'function' ? opts.onNodeDoubleClick : () => {};
  const onAddAfter = typeof opts.onAddAfter === 'function' ? opts.onAddAfter : () => {};
  const onSubOpen = typeof opts.onSubOpen === 'function' ? opts.onSubOpen : () => {};

  if (!host) {
    // Nothing to mount into. Return a harmless no-op object rather than throw,
    // matching the "nothing may throw" rule even for a bad caller.
    const noop = () => {};
    return { render: noop, setRunState: noop, focusNode: noop, fit: noop, destroy: noop };
  }

  /* ---- DOM shell, built once ---------------------------------------------- */

  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'gcanvas';
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Workflow canvas');

  const viewport = document.createElement('div');
  viewport.className = 'gcanvas-viewport';

  const laneLayer = document.createElement('div');
  laneLayer.className = 'gcanvas-lanes';

  const edgeSvg = svgEl('svg', { class: 'gcanvas-edges' });
  const defs = svgEl('defs');
  const markerBase = svgEl('marker', {
    id: 'gc-arrow', viewBox: '0 0 10 10', refX: '8.5', refY: '5',
    markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  });
  markerBase.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: cssVar('--line-strong') || '#3a444e' }));
  const markerDone = markerBase.cloneNode(true);
  markerDone.id = 'gc-arrow-done';
  markerDone.querySelector('path').setAttribute('fill', cssVar('--st-done') || '#22c55e');
  const markerFailed = markerBase.cloneNode(true);
  markerFailed.id = 'gc-arrow-failed';
  markerFailed.querySelector('path').setAttribute('fill', cssVar('--st-failed') || '#ef4444');
  const markerRunning = markerBase.cloneNode(true);
  markerRunning.id = 'gc-arrow-running';
  markerRunning.querySelector('path').setAttribute('fill', cssVar('--st-running') || '#3b82f6');
  const markerParked = markerBase.cloneNode(true);
  markerParked.id = 'gc-arrow-parked';
  markerParked.querySelector('path').setAttribute('fill', cssVar('--st-waiting') || '#f59e0b');
  defs.appendChild(markerBase);
  defs.appendChild(markerDone);
  defs.appendChild(markerFailed);
  defs.appendChild(markerRunning);
  defs.appendChild(markerParked);
  edgeSvg.appendChild(defs);
  const edgeGroup = svgEl('g', { class: 'gc-edge-group' });
  edgeSvg.appendChild(edgeGroup);
  // Ports draw on top of the wires so a curve visibly starts and ends AT a
  // dot, never at a bare card corner. Still under the HTML node layer, so
  // each dot sits nudged one pixel past the card's own border in
  // computePortXY below, clear of the card's background.
  const portGroup = svgEl('g', { class: 'gc-port-group' });
  edgeSvg.appendChild(portGroup);

  const nodeLayer = document.createElement('div');
  nodeLayer.className = 'gcanvas-nodes';

  viewport.appendChild(laneLayer);
  viewport.appendChild(edgeSvg);
  viewport.appendChild(nodeLayer);
  root.appendChild(viewport);

  const controls = document.createElement('div');
  controls.className = 'gcanvas-controls';
  controls.innerHTML =
    '<button type="button" class="gc-ctrl-btn" data-act="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>' +
    '<button type="button" class="gc-ctrl-btn" data-act="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>' +
    '<button type="button" class="gc-ctrl-btn" data-act="fit" title="Fit to screen" aria-label="Fit to screen">⬚</button>' +
    '<div class="gc-ctrl-sep"></div>' +
    '<button type="button" class="gc-ctrl-btn gc-ctrl-reset" data-act="reset-layout" title="Reset layout">Reset</button>';
  root.appendChild(controls);

  const minimap = document.createElement('div');
  minimap.className = 'gcanvas-minimap';
  minimap.hidden = true;
  const mmSvg = svgEl('svg', { class: 'gc-mm-svg' });
  minimap.appendChild(mmSvg);
  root.appendChild(minimap);

  const hint = document.createElement('div');
  hint.className = 'gcanvas-hint';
  hint.textContent = 'Scroll to pan. Ctrl/Cmd + scroll to zoom. Space + drag also pans.';
  root.appendChild(hint);

  const emptyEl = document.createElement('div');
  emptyEl.className = 'gcanvas-empty';
  emptyEl.hidden = true;
  root.appendChild(emptyEl);

  host.appendChild(root);

  /* ---- state --------------------------------------------------------------- */

  const state = {
    definition: {},
    layout: normalizeLayout(null),
    slug: '',
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedId: null,
    currentNodeId: null,
    lastPannedTo: null,
    runState: null,
    cardsById: new Map(),      // id -> HTMLElement
    edgeElsByKey: new Map(),   // "from>to>kind" -> { edge, pathEl, hitEl, labelGroup }
    outAdj: new Map(),         // id -> [edge, ...]
    inAdj: new Map(),          // id -> [edge, ...]
    outPortFrac: new Map(),    // "from>to>kind" -> 0..1, where on the source's right edge this wire leaves
    portDotsByNode: new Map(), // id -> { out: [{frac, el}], in: el|null }, the visible port dots
    dragging: null,            // { id, startX, startY, origX, origY, moved }
    panning: null,             // { startX, startY, origPanX, origPanY }
    spaceHeld: false,
    resizeObs: null,
    minZoom: DEFAULT_MIN_ZOOM,
    simplified: false,
    everRendered: false,
    openedSlugs: new Set(),   // which workflows this instance has already opened a view for
    userInteracted: false,
    resizeSettled: false,
    hintDismissed: false,     // separate from userInteracted: fading the hint must
                               // never affect the resize safety net's own logic
  };

  /** The hint is genuinely useful once, then it is clutter. Fade it out the
   *  first time the person does anything on the canvas, and let hovering
   *  bring it back so it is never truly gone, just out of the way. Kept as
   *  its own flag rather than reusing state.userInteracted, because that
   *  flag also gates the resize safety net's decision to re-settle the view,
   *  and a person clicking a card should not silently disable that. */
  function noteHintInteraction() {
    if (state.hintDismissed) return;
    state.hintDismissed = true;
    root.setAttribute('data-interacted', '1');
  }

  /** The host panel's height is ours to set, not left at whatever fixed
   *  number the caller's markup happens to use. Sized off the graph's own
   *  height so a small graph (a two row, four node smoke test) sits in a
   *  panel built for it, and a wide, short landscape row still gets a
   *  panel tall enough to open height-fit at a readable zoom. Bounded on
   *  both ends: HOST_MIN_H matches .gcanvas's own CSS floor, and the max is
   *  a fraction of the viewport so a very tall graph never swallows the
   *  whole page. */
  function updateHostHeight() {
    if (!host || typeof host.getBoundingClientRect !== 'function') return;
    const lh = state.layout.height || DEFAULT_H;
    const desired = lh * OPEN_MAX_ZOOM + HOST_CHROME;
    const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 900;
    // HOST_MAX_H_VH alone is not enough: it caps the panel against the whole
    // window, but says nothing about how much of that window the page header
    // and title already used above the panel. Without subtracting that, a
    // tall panel pushes its own bottom, including the minimap and the hint,
    // below the fold, forcing a page scroll the canvas was supposed to make
    // unnecessary. Measuring the host's own top gets this right regardless
    // of how much chrome the caller's page puts above it, on the workflow
    // page or the run page alike, without this file needing to know either
    // page's layout.
    const top = host.getBoundingClientRect().top || 0;
    const bottomBreathingRoom = 24;
    const availByViewport = Math.max(HOST_MIN_H, vh - top - bottomBreathingRoom);
    const maxH = Math.max(HOST_MIN_H, Math.min(HOST_MAX_H_CAP, Math.min(vh * HOST_MAX_H_VH, availByViewport)));
    host.style.height = Math.round(clamp(desired, HOST_MIN_H, maxH)) + 'px';
  }

  function positionsKey() {
    return 'arthaflow.canvas.positions.' + POSITIONS_VERSION + '.' + (state.slug || 'unknown');
  }

  function loadPositions() {
    try {
      const raw = window.localStorage.getItem(positionsKey());
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  function savePosition(id, x, y) {
    try {
      const all = loadPositions();
      all[id] = { x, y };
      window.localStorage.setItem(positionsKey(), JSON.stringify(all));
    } catch { /* storage may be full or blocked, positions just do not persist */ }
  }

  function clearPositions() {
    try { window.localStorage.removeItem(positionsKey()); } catch { /* ignore */ }
  }

  /* ---- remembering pan and zoom, per workflow --------------------------------
     B3 calls render() twice in two different situations that need opposite
     behaviour: once to mount a workflow fresh, where the whole point is to
     open on a view that shows the shape of the thing, and again after every
     edit to redraw the same workflow, where the whole point is that panning
     over to read a prompt and then saving it must not snap the view back to
     the start. Both call sites pass the same arguments, so this file is the
     only place that can tell them apart: the first render() since createCanvas
     restores the saved view or fits, every render() after that keeps whatever
     view is already on screen unless the caller explicitly asks otherwise. */
  function viewKey() {
    return 'arthaflow.canvas.view.' + POSITIONS_VERSION + '.' + (state.slug || 'unknown');
  }

  function loadView() {
    try {
      const raw = window.localStorage.getItem(viewKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (v && isNum(v.zoom) && isNum(v.panX) && isNum(v.panY)) return v;
    } catch { /* ignore */ }
    return null;
  }

  let saveViewTimer = null;
  /** Debounced on purpose. Pan and zoom can fire many times a second, and
   *  localStorage writes are synchronous, so writing on every frame would be
   *  exactly the kind of per interaction cost the whole file is built to
   *  avoid. One write, a moment after the person stops moving. */
  function saveViewSoon() {
    state.userInteracted = true;
    clearTimeout(saveViewTimer);
    saveViewTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(viewKey(), JSON.stringify({
          zoom: state.zoom, panX: state.panX, panY: state.panY,
        }));
      } catch { /* storage may be full or blocked, the view just does not persist */ }
    }, 400);
  }

  /* ---- transform / pan / zoom ---------------------------------------------- */

  function applyTransform() {
    // The one write per frame that makes pan and zoom feel physical.
    viewport.style.transform = 'translate(' + state.panX.toFixed(2) + 'px,' +
      state.panY.toFixed(2) + 'px) scale(' + state.zoom.toFixed(4) + ')';
    const bgSize = 26 * state.zoom;
    root.style.backgroundSize = bgSize.toFixed(2) + 'px ' + bgSize.toFixed(2) + 'px';
    root.style.backgroundPosition = state.panX.toFixed(2) + 'px ' + state.panY.toFixed(2) + 'px';
    updateMinimapViewport();
    updateSimplified();
  }

  /** Below SIMPLIFY_BELOW_ZOOM the detail line is unreadable anyway, so every
   *  card drops to badge, colour and name. One attribute write on the root,
   *  never a touch on any individual card, so crossing the threshold while
   *  zooming stays exactly as cheap as any other frame. */
  function updateSimplified() {
    const simple = state.zoom < SIMPLIFY_BELOW_ZOOM;
    if (simple === state.simplified) return;
    state.simplified = simple;
    if (simple) root.setAttribute('data-simplified', '1');
    else root.removeAttribute('data-simplified');
  }

  /** The real floor for this layout, not a flat constant. Fitting a wide,
   *  short landscape row into a narrow window can need well under 0.25x, and
   *  a hard floor there would make the fit button lie. Recomputed whenever
   *  the layout or the viewport size changes. */
  function recomputeMinZoom() {
    const rect = root.getBoundingClientRect();
    const w = state.layout.width || 1;
    const h = state.layout.height || 1;
    const availW = Math.max(40, rect.width - FIT_MARGIN * 2);
    const availH = Math.max(40, rect.height - FIT_MARGIN * 2);
    const rawFit = Math.min(availW / w, availH / h);
    state.minZoom = Math.min(DEFAULT_MIN_ZOOM, rawFit * 0.9);
  }

  function setZoomAt(newZoom, screenX, screenY) {
    const z = clamp(newZoom, state.minZoom, MAX_ZOOM);
    const rect = root.getBoundingClientRect();
    const px = screenX === undefined ? rect.width / 2 : screenX - rect.left;
    const py = screenY === undefined ? rect.height / 2 : screenY - rect.top;
    const worldX = (px - state.panX) / state.zoom;
    const worldY = (py - state.panY) / state.zoom;
    state.zoom = z;
    state.panX = px - worldX * z;
    state.panY = py - worldY * z;
    applyTransform();
    saveViewSoon();
  }

  function fitZoomValue() {
    const rect = root.getBoundingClientRect();
    const w = state.layout.width || 1;
    const h = state.layout.height || 1;
    const availW = Math.max(40, rect.width - FIT_MARGIN * 2);
    const availH = Math.max(40, rect.height - FIT_MARGIN * 2);
    return clamp(Math.min(availW / w, availH / h), state.minZoom, MAX_ZOOM);
  }

  /** True fit: the whole shape, both axes, on screen at once. Kept exactly
   *  for the fit button and the `f` key, because seeing the whole graph on
   *  demand is genuinely useful. Not what the canvas opens on any more, see
   *  openHeightFitView below. */
  function fit() {
    const rect = root.getBoundingClientRect();
    const w = state.layout.width || 1;
    const h = state.layout.height || 1;
    const z = fitZoomValue();
    state.zoom = z;
    state.panX = (rect.width - w * z) / 2;
    state.panY = (rect.height - h * z) / 2;
    applyTransform();
  }

  /** The zoom the opening view uses: fit the graph's HEIGHT into the panel,
   *  then clamp into OPEN_MIN_ZOOM..OPEN_MAX_ZOOM so a very short graph does
   *  not zoom in absurdly far and a very tall one never drops below a
   *  readable floor. */
  function openFitZoomValue() {
    const rect = root.getBoundingClientRect();
    const h = state.layout.height || 1;
    const availH = Math.max(40, rect.height - FIT_MARGIN * 2);
    const rawFitH = availH / h;
    return clamp(rawFitH, Math.max(state.minZoom, OPEN_MIN_ZOOM), Math.min(MAX_ZOOM, OPEN_MAX_ZOOM));
  }

  /** The opening view for a landscape row. Fit the graph's height into the
   *  panel at a readable zoom, then pan to the LEFT edge, vertically
   *  centred, so the view opens on the START of the flow. A workflow reads
   *  left to right: opening on the start and scrolling right to follow it is
   *  how n8n behaves and how reading behaves. Fitting the WIDTH instead, the
   *  previous approach, forces the zoom down around 0.18x on a wide, short
   *  row like linkedin-leads (5996 x 750), where no text is legible at all.
   *  Seeing the whole shape at once is what the minimap and the fit button
   *  are for, not the opening view. */
  function openHeightFitView() {
    const rect = root.getBoundingClientRect();
    const h = state.layout.height || 1;
    const z = openFitZoomValue();
    state.zoom = z;
    state.panX = FIT_MARGIN;
    state.panY = (rect.height - h * z) / 2;
    applyTransform();
  }

  /** The view the FIRST render() since createCanvas opens on. Restore the
   *  view the person left this workflow on, if there is one, otherwise open
   *  height-fit at the left edge (see openHeightFitView). A saved view wins
   *  over a fresh open because it is what the person chose last time, and a
   *  bad or stale saved view (a workflow that shrank, a container that
   *  resized) is caught by clamping its zoom into the current
   *  minZoom..MAX_ZOOM range, so it can never be worse than the open it
   *  would otherwise have gotten. */
  function openInitialView() {
    if (!state.layout.nodes.length) { fit(); return; }
    const saved = loadView();
    if (saved) {
      state.zoom = clamp(saved.zoom, state.minZoom, MAX_ZOOM);
      state.panX = saved.panX;
      state.panY = saved.panY;
      applyTransform();
      return;
    }
    openHeightFitView();
  }

  function panToNode(id, opts2) {
    const card = state.layout.byId.get(id);
    if (!card) return;
    const rect = root.getBoundingClientRect();
    const cx = card.x + card.w / 2;
    const cy = card.y + card.h / 2;
    const z = (opts2 && opts2.keepZoom) ? state.zoom : Math.max(state.zoom, 0.7);
    state.zoom = clamp(z, state.minZoom, MAX_ZOOM);
    state.panX = rect.width / 2 - cx * state.zoom;
    state.panY = rect.height / 2 - cy * state.zoom;
    viewport.style.transition = 'transform 260ms cubic-bezier(0.22,1,0.36,1)';
    applyTransform();
    setTimeout(() => { viewport.style.transition = ''; }, 280);
  }

  function focusNode(nodeId) {
    if (nodeId === null || nodeId === undefined) return;
    const id = String(nodeId);
    if (!state.layout.byId.has(id)) return;
    selectNode(id);
    panToNode(id);
  }

  /* ---- selection ------------------------------------------------------------ */

  function selectNode(id) {
    if (state.selectedId && state.cardsById.has(state.selectedId)) {
      state.cardsById.get(state.selectedId).removeAttribute('data-selected');
    }
    state.selectedId = id;
    if (id && state.cardsById.has(id)) {
      state.cardsById.get(id).setAttribute('data-selected', '1');
    }
  }

  /* ---- edge geometry --------------------------------------------------------- */

  function edgeKey(e) { return e.from + '>' + e.to + '>' + e.kind; }

  /** Two anchor points for one edge: output port of the source, input port
   *  of the target, both read off the CURRENT card geometry. A body edge
   *  (each into its loop lane) is not a card to card wire, it is a drop into
   *  the lane's header band, so it keeps whatever B1 routed for it and only
   *  falls back to a straight guess if that is missing. */
  function edgePointsFor(e) {
    const a = state.layout.byId.get(e.from);
    const b = state.layout.byId.get(e.to);
    if (!a || !b) return [null, null];
    if (e.kind === 'body') {
      if (e.points && e.points.length >= 2) return [e.points[0], e.points[e.points.length - 1]];
      return [{ x: a.x + a.w / 2, y: a.y + a.h }, { x: b.x, y: b.y + b.h / 2 }];
    }
    const frac = state.outPortFrac.get(edgeKey(e));
    return [outPortXY(a, frac === undefined ? 0.5 : frac), inPortXY(b)];
  }

  function redrawEdge(rec) {
    const [p0, p1] = edgePointsFor(rec.edge);
    const { d, mid } = bezierPath(p0, p1);
    rec.pathEl.setAttribute('d', d);
    rec.hitEl.setAttribute('d', d);
    if (rec.labelGroup && mid) {
      rec.labelGroup.setAttribute('transform', 'translate(' + mid.x.toFixed(1) + ',' + mid.y.toFixed(1) + ')');
    }
    if (rec.addBtn && mid) {
      rec.addBtn.setAttribute('transform', 'translate(' + mid.x.toFixed(1) + ',' + mid.y.toFixed(1) + ')');
    }
  }

  /** Filter's two outputs, and any other node that ever grows more than one,
   *  get spread across the right edge instead of stacking on one point.
   *  `true` (yes) always sorts above `else` (no), the one hard rule the
   *  brief gives for this. Recomputed once per full draw, not per edge, and
   *  cached in state.outPortFrac so edgePointsFor is a plain lookup. */
  function computePortGeometry() {
    state.outPortFrac.clear();
    state.portDotsByNode.clear();
    const PRIORITY = { true: 0, next: 1, back: 2, else: 3 };
    for (const [nodeId, edges] of state.outAdj) {
      const structural = edges.filter((e) => e.kind !== 'body');
      if (!structural.length) continue;
      const ordered = structural.slice().sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9));
      const n = ordered.length;
      ordered.forEach((e, i) => {
        const frac = n === 1 ? 0.5 : 0.28 + (0.44 * i) / (n - 1);
        state.outPortFrac.set(edgeKey(e), frac);
      });
    }
  }

  function rerouteEdgesFor(nodeId) {
    const list = (state.outAdj.get(nodeId) || []).concat(state.inAdj.get(nodeId) || []);
    for (const e of list) {
      const rec = state.edgeElsByKey.get(edgeKey(e));
      if (rec) redrawEdge(rec);
    }
    repositionPortsFor(nodeId);
  }

  /* ---- drawing lanes, nodes, edges ------------------------------------------- */

  function drawLanes() {
    laneLayer.innerHTML = '';
    for (const lane of state.layout.lanes) {
      const el = document.createElement('div');
      el.className = 'gc-lane';
      el.style.left = lane.x + 'px';
      el.style.top = lane.y + 'px';
      el.style.width = lane.w + 'px';
      el.style.height = lane.h + 'px';
      const label = document.createElement('span');
      label.className = 'gc-lane-label';
      label.textContent = lane.label || 'Loop';
      el.appendChild(label);
      laneLayer.appendChild(el);
    }
  }

  function drawNodes() {
    nodeLayer.innerHTML = '';
    state.cardsById.clear();
    for (const entry of state.layout.nodes) {
      const el = document.createElement('div');
      el.className = 'gc-node';
      el.dataset.tier = entry.tier;
      el.dataset.id = entry.id;
      if (!entry.node.type || !KNOWN_TYPES.has(entry.node.type)) el.dataset.unknown = '1';
      el.style.left = entry.x + 'px';
      el.style.top = entry.y + 'px';
      el.style.width = entry.w + 'px';
      el.style.height = entry.h + 'px';
      el.innerHTML = cardHtml(entry);

      el.addEventListener('click', (ev) => {
        if (state.dragging && state.dragging.moved) return;
        const subChip = ev.target.closest('.gc-sub-chip');
        if (subChip) {
          ev.stopPropagation();
          onSubOpen(subChip.dataset.subSlug);
          return;
        }
        selectNode(entry.id);
        onNodeClick(entry.node.id);
      });
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        onNodeDoubleClick(entry.node.id);
      });
      el.addEventListener('mousedown', (ev) => startDrag(ev, entry));

      nodeLayer.appendChild(el);
      state.cardsById.set(entry.id, el);
    }
  }

  /** One dot per distinct output port a node actually has, one dot for its
   *  input port if anything feeds it. Drawn once per full draw, then just
   *  moved (never rebuilt) by repositionPortsFor while dragging. */
  function drawPorts() {
    portGroup.innerHTML = '';
    state.portDotsByNode.clear();
    for (const entry of state.layout.nodes) {
      const id = entry.id;
      const outEdges = (state.outAdj.get(id) || []).filter((e) => e.kind !== 'body');
      const hasIn = (state.inAdj.get(id) || []).some((e) => e.kind !== 'body');
      const dots = { out: [], in: null };
      const fracs = new Set(outEdges.map((e) => state.outPortFrac.get(edgeKey(e))).filter((f) => f !== undefined));
      for (const frac of fracs) {
        const p = outPortXY(entry, frac);
        const dot = svgEl('circle', { class: 'gc-port gc-port-out', 'data-tier': entry.tier, cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5 });
        portGroup.appendChild(dot);
        dots.out.push({ frac, el: dot });
      }
      if (hasIn) {
        const p = inPortXY(entry);
        const dot = svgEl('circle', { class: 'gc-port gc-port-in', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5 });
        portGroup.appendChild(dot);
        dots.in = dot;
      }
      if (dots.out.length || dots.in) state.portDotsByNode.set(id, dots);
    }
  }

  function repositionPortsFor(nodeId) {
    const entry = state.layout.byId.get(nodeId);
    const dots = state.portDotsByNode.get(nodeId);
    if (!entry || !dots) return;
    for (const { frac, el } of dots.out) {
      const p = outPortXY(entry, frac);
      el.setAttribute('cx', p.x.toFixed(1));
      el.setAttribute('cy', p.y.toFixed(1));
    }
    if (dots.in) {
      const p = inPortXY(entry);
      dots.in.setAttribute('cx', p.x.toFixed(1));
      dots.in.setAttribute('cy', p.y.toFixed(1));
    }
  }

  function drawEdges() {
    edgeGroup.innerHTML = '';
    state.edgeElsByKey.clear();
    state.outAdj.clear();
    state.inAdj.clear();

    for (const e of state.layout.edges) {
      if (!state.outAdj.has(e.from)) state.outAdj.set(e.from, []);
      state.outAdj.get(e.from).push(e);
      if (!state.inAdj.has(e.to)) state.inAdj.set(e.to, []);
      state.inAdj.get(e.to).push(e);
    }
    computePortGeometry();
    drawPorts();

    for (const e of state.layout.edges) {
      const g = svgEl('g', { 'data-kind': e.kind });
      const hit = svgEl('path', { class: 'gc-edge-hit' });
      const path = svgEl('path', { class: 'gc-edge', 'data-kind': e.kind, 'marker-end': 'url(#gc-arrow)' });
      g.appendChild(hit);
      g.appendChild(path);

      let labelGroup = null;
      if (e.label) {
        labelGroup = svgEl('g', { class: 'gc-edge-label-group' });
        const bg = svgEl('rect', { class: 'gc-edge-label-bg', rx: 3, ry: 3 });
        const text = svgEl('text', { class: 'gc-edge-label', 'text-anchor': 'middle', dy: '3' });
        text.textContent = e.label;
        labelGroup.appendChild(bg);
        labelGroup.appendChild(text);
        g.appendChild(labelGroup);
        // Size the backing rect after the text has real metrics, best effort.
        requestAnimationFrame(() => {
          try {
            const bb = text.getBBox();
            bg.setAttribute('x', bb.x - 4);
            bg.setAttribute('y', bb.y - 2);
            bg.setAttribute('width', bb.width + 8);
            bg.setAttribute('height', bb.height + 4);
          } catch { /* not attached yet, harmless to skip */ }
        });
      }

      let addBtn = null;
      if (e.kind === 'next' || e.kind === 'true' || e.kind === 'else') {
        addBtn = svgEl('g', { class: 'gc-add-btn' });
        addBtn.appendChild(svgEl('circle', { r: 8 }));
        const plus = svgEl('path', { d: 'M-3,0 L3,0 M0,-3 L0,3' });
        addBtn.appendChild(plus);
        addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); onAddAfter(e.from); });
        g.appendChild(addBtn);
      }

      g.addEventListener('mouseenter', () => g.setAttribute('data-edge-hover', '1'));
      g.addEventListener('mouseleave', () => g.removeAttribute('data-edge-hover'));

      edgeGroup.appendChild(g);
      const rec = { edge: e, pathEl: path, hitEl: hit, labelGroup, addBtn };
      state.edgeElsByKey.set(edgeKey(e), rec);
      redrawEdge(rec);
    }
  }

  function sizeSurfaces() {
    const w = state.layout.width, h = state.layout.height;
    edgeSvg.setAttribute('width', w);
    edgeSvg.setAttribute('height', h);
    edgeSvg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    nodeLayer.style.width = w + 'px';
    nodeLayer.style.height = h + 'px';
    laneLayer.style.width = w + 'px';
    laneLayer.style.height = h + 'px';
  }

  /* ---- minimap ---------------------------------------------------------------- */

  function drawMinimapStatic() {
    mmSvg.innerHTML = '';
    const w = state.layout.width, h = state.layout.height;
    if (!w || !h) return;
    mmSvg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    mmSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const n of state.layout.nodes) {
      mmSvg.appendChild(svgEl('rect', {
        class: 'gc-mm-node', 'data-tier': n.tier,
        x: n.x, y: n.y, width: n.w, height: n.h, rx: 3,
      }));
    }
    const viewRect = svgEl('rect', { class: 'gc-mm-view' });
    viewRect.id = 'gc-mm-view-rect';
    mmSvg.appendChild(viewRect);
  }

  function updateMinimapViewport() {
    const rect = root.getBoundingClientRect();
    const wide = state.layout.width * 1 > rect.width || state.layout.height * 1 > rect.height;
    minimap.hidden = !wide || !state.layout.nodes.length;
    if (minimap.hidden) return;
    const viewRect = mmSvg.querySelector('#gc-mm-view-rect');
    if (!viewRect) return;
    const x0 = -state.panX / state.zoom;
    const y0 = -state.panY / state.zoom;
    const vw = rect.width / state.zoom;
    const vh = rect.height / state.zoom;
    viewRect.setAttribute('x', x0);
    viewRect.setAttribute('y', y0);
    viewRect.setAttribute('width', Math.max(1, vw));
    viewRect.setAttribute('height', Math.max(1, vh));
  }

  // On a graph this wide, the minimap is the primary way to get anywhere
  // fast, not a decoration, so it both jumps on click and drags to scrub.
  function jumpMinimapTo(clientX, clientY) {
    const rect = mmSvg.getBoundingClientRect();
    const vb = state.layout;
    if (!rect.width || !vb.width) return;
    const scale = vb.width / rect.width;
    const worldX = clamp((clientX - rect.left) * scale, 0, vb.width);
    const worldY = clamp((clientY - rect.top) * scale, 0, vb.height);
    const hostRect = root.getBoundingClientRect();
    state.panX = hostRect.width / 2 - worldX * state.zoom;
    state.panY = hostRect.height / 2 - worldY * state.zoom;
    applyTransform();
    saveViewSoon();
  }

  minimap.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    noteHintInteraction();
    ev.preventDefault();
    jumpMinimapTo(ev.clientX, ev.clientY);
    const move = (mv) => jumpMinimapTo(mv.clientX, mv.clientY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  /* ---- dragging a card --------------------------------------------------------- */

  function startDrag(ev, entry) {
    if (ev.button !== 0) return;
    if (state.spaceHeld) return; // space always means pan, even over a card
    noteHintInteraction();
    ev.stopPropagation();
    const rect = root.getBoundingClientRect();
    state.dragging = {
      id: entry.id, moved: false,
      startScreenX: ev.clientX, startScreenY: ev.clientY,
      origX: entry.x, origY: entry.y,
    };
    root.dataset.dragging = '1';
    const move = (mv) => {
      const dx = (mv.clientX - state.dragging.startScreenX) / state.zoom;
      const dy = (mv.clientY - state.dragging.startScreenY) / state.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.dragging.moved = true;
      entry.x = state.dragging.origX + dx;
      entry.y = state.dragging.origY + dy;
      const card = state.cardsById.get(entry.id);
      if (card) { card.style.left = entry.x + 'px'; card.style.top = entry.y + 'px'; }
      rerouteEdgesFor(entry.id);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      delete root.dataset.dragging;
      if (state.dragging && state.dragging.moved) {
        savePosition(entry.id, entry.x, entry.y);
      }
      state.dragging = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /* ---- panning the background --------------------------------------------------- */

  root.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.gc-node') && !state.spaceHeld) return;
    if (ev.target.closest('.gcanvas-controls') || ev.target.closest('.gcanvas-minimap')) return;
    noteHintInteraction();
    state.panning = { startX: ev.clientX, startY: ev.clientY, origPanX: state.panX, origPanY: state.panY };
    root.dataset.panning = '1';
    const move = (mv) => {
      state.panX = state.panning.origPanX + (mv.clientX - state.panning.startX);
      state.panY = state.panning.origPanY + (mv.clientY - state.panning.startY);
      applyTransform();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      delete root.dataset.panning;
      state.panning = null;
      saveViewSoon();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  root.addEventListener('click', (ev) => {
    if (ev.target === root || ev.target === viewport) selectNode(null);
  });

  /* ---- wheel: horizontal-first pan, ctrl/cmd scroll (and pinch) zooms ----------
     A landscape row is wide and short by nature, linkedin-leads is 5996 x
     750, about 8x wider than tall. So the wheel's job is mostly east and
     west, not north and south. A plain vertical mouse wheel, a two finger
     swipe in any direction, and shift plus scroll all pan horizontally.
     Full two dimensional panning is still one drag away on the background or
     with space held, so nothing about the vertical axis is lost, wheel panning
     just stops fighting the shape of the thing it is panning. */
  root.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    noteHintInteraction();
    if (ev.ctrlKey || ev.metaKey) {
      const factor = Math.exp(-ev.deltaY * 0.0035);
      setZoomAt(state.zoom * factor, ev.clientX, ev.clientY);
    } else {
      const horizontal = ev.deltaX !== 0 ? ev.deltaX : ev.deltaY;
      state.panX -= horizontal;
      applyTransform();
      saveViewSoon();
    }
  }, { passive: false });

  /* ---- keyboard -------------------------------------------------------------- */

  function neighbourInDirection(dir) {
    const id = state.selectedId;
    if (!id) {
      const first = state.layout.nodes[0];
      return first ? first.id : null;
    }
    const cur = state.layout.byId.get(id);
    if (!cur) return null;
    if (dir === 'right') {
      const list = state.outAdj.get(id) || [];
      if (!list.length) return null;
      const priority = { next: 0, true: 1, body: 2, else: 3, back: 4 };
      list.sort((a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9));
      return list[0].to;
    }
    if (dir === 'left') {
      const list = state.inAdj.get(id) || [];
      return list.length ? list[0].from : null;
    }
    if (dir === 'up' || dir === 'down') {
      const want = dir === 'up' ? -1 : 1;
      let best = null, bestDist = Infinity;
      for (const n of state.layout.nodes) {
        if (n.id === id || n.col !== cur.col) continue;
        const d = n.row - cur.row;
        if (Math.sign(d) === want && Math.abs(d) < bestDist) { best = n.id; bestDist = Math.abs(d); }
      }
      return best;
    }
    return null;
  }

  root.addEventListener('keydown', (ev) => {
    noteHintInteraction();
    if (ev.code === 'Space') { state.spaceHeld = true; root.dataset.space = '1'; }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' }[ev.key];
      const next = neighbourInDirection(dir);
      if (next) { ev.preventDefault(); selectNode(next); panToNode(next, { keepZoom: true }); }
      return;
    }
    if (ev.key === 'Enter') {
      if (state.selectedId) onNodeDoubleClick(state.layout.byId.get(state.selectedId).node.id);
      return;
    }
    if (ev.key === 'Escape') { selectNode(null); return; }
    if (ev.key === 'f' || ev.key === 'F') { fit(); saveViewSoon(); return; }
    if (ev.key === '+' || ev.key === '=') { setZoomAt(state.zoom * 1.2); return; }
    if (ev.key === '-' || ev.key === '_') { setZoomAt(state.zoom * 0.8); return; }
  });
  root.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { state.spaceHeld = false; delete root.dataset.space; }
  });

  /* ---- controls ---------------------------------------------------------------- */

  controls.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'zoom-in') setZoomAt(state.zoom * 1.25);
    else if (act === 'zoom-out') setZoomAt(state.zoom * 0.8);
    else if (act === 'fit') { fit(); saveViewSoon(); }
    else if (act === 'reset-layout') {
      clearPositions();
      render(state.definition, state.rawLayout, { keepView: true });
    }
  });

  /* ---- resize keeps the minimap and the zoom floor honest ----------------------- */

  if (typeof ResizeObserver !== 'undefined') {
    state.resizeObs = new ResizeObserver(() => {
      recomputeMinZoom();
      updateMinimapViewport();
      // Safety net for an SPA mount race: if render() ran its FIRST, view
      // opening pass while the host was still zero sized (a hidden or not
      // yet laid out container), the fit it computed was fit to nothing.
      // The moment this element reports a real size, and only if the person
      // has not already taken control of the view themselves, settle onto
      // the view a correctly sized container would have opened on. Fires at
      // most once, so it never fights someone resizing the window mid pan.
      if (!state.resizeSettled && !state.userInteracted && state.everRendered) {
        const rect = root.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          state.resizeSettled = true;
          openInitialView();
        }
      }
    });
    state.resizeObs.observe(root);
  }

  /* ---- run state ----------------------------------------------------------------- */

  function statusToRunAttr(status) {
    if (status === 'done' || status === 'failed' || status === 'running') return status;
    if (status === 'waiting_on_claude' || status === 'waiting_on_timer') return 'parked';
    if (status === 'cancelled' || status === 'skipped') return 'cancelled';
    return 'dim';
  }

  function setRunState(runState) {
    state.runState = runState && typeof runState === 'object' ? runState : null;
    const steps = (state.runState && state.runState.steps && typeof state.runState.steps === 'object')
      ? state.runState.steps : {};
    const hasRun = Boolean(state.runState);

    for (const entry of state.layout.nodes) {
      const card = state.cardsById.get(entry.id);
      if (!card) continue;
      if (!hasRun) {
        card.removeAttribute('data-run');
        card.removeAttribute('data-current');
        continue;
      }
      const raw = Object.prototype.hasOwnProperty.call(steps, entry.id) ? steps[entry.id] : undefined;
      const attr = raw === undefined ? 'dim' : statusToRunAttr(raw);
      card.setAttribute('data-run', attr);
    }

    // Edges already travelled draw brighter. A node that has any recorded
    // status was reached, so the edge into it was the path actually taken.
    // That is what makes an untaken branch stay dim on a filter node.
    for (const [, rec] of state.edgeElsByKey) {
      const toStatus = hasRun && Object.prototype.hasOwnProperty.call(steps, rec.edge.to) ? steps[rec.edge.to] : undefined;
      const lit = hasRun && toStatus !== undefined;
      if (lit) {
        const tone = toStatus === 'failed' ? 'failed'
          : (toStatus === 'waiting_on_claude' || toStatus === 'waiting_on_timer') ? 'parked'
          : toStatus === 'running' ? 'running' : 'done';
        rec.pathEl.setAttribute('data-lit', '1');
        rec.pathEl.setAttribute('data-lit-tone', tone);
        rec.pathEl.setAttribute('marker-end', 'url(#gc-arrow-' + tone + ')');
      } else {
        rec.pathEl.removeAttribute('data-lit');
        rec.pathEl.removeAttribute('data-lit-tone');
        rec.pathEl.setAttribute('marker-end', 'url(#gc-arrow)');
      }
    }

    const currentId = hasRun && state.runState.currentNodeId !== undefined && state.runState.currentNodeId !== null
      ? String(state.runState.currentNodeId) : null;
    if (currentId && state.cardsById.has(currentId)) {
      state.cardsById.get(currentId).setAttribute('data-current', '1');
    }
    if (currentId !== state.lastPannedTo && currentId && state.layout.byId.has(currentId)) {
      state.lastPannedTo = currentId;
      panToNode(currentId, { keepZoom: true });
    }
    if (!currentId) state.lastPannedTo = null;
  }

  /* ---- render ---------------------------------------------------------------- */

  function render(definition, layoutResult, renderOpts) {
    renderOpts = renderOpts || {};
    state.definition = definition && typeof definition === 'object' ? definition : {};
    state.rawLayout = layoutResult;
    state.slug = state.definition.slug || '';

    let normalized;
    try {
      normalized = normalizeLayout(layoutResult);
    } catch {
      normalized = normalizeLayout(null);
    }
    state.layout = normalized;

    // Apply any positions the user has dragged to before, per workflow.
    const saved = loadPositions();
    for (const n of state.layout.nodes) {
      const p = saved[n.id];
      if (p && isNum(p.x) && isNum(p.y)) { n.x = p.x; n.y = p.y; }
    }
    // Recompute a generous bounding box in case saved positions moved a card
    // outside the box B1 originally reserved.
    let maxX = state.layout.width, maxY = state.layout.height;
    for (const n of state.layout.nodes) { maxX = Math.max(maxX, n.x + n.w + 40); maxY = Math.max(maxY, n.y + n.h + 40); }
    state.layout.width = maxX;
    state.layout.height = maxY;

    // Set the host panel's own height before anything below reads root's
    // geometry, so recomputeMinZoom, openInitialView and the fit functions
    // all measure the panel this graph actually gets, not a stale one.
    updateHostHeight();

    sizeSurfaces();
    drawLanes();
    drawNodes();
    drawEdges();
    drawMinimapStatic();

    const empty = !state.layout.nodes.length;
    emptyEl.hidden = !empty;
    if (empty) {
      const reason = (state.layout.warnings && state.layout.warnings.length)
        ? 'It came back with a warning: ' + esc(state.layout.warnings[0])
        : 'Add a step to get started.';
      emptyEl.innerHTML = '<strong>This workflow has no steps yet.</strong><span>' + reason + '</span>';
    }

    if (state.selectedId && !state.layout.byId.has(state.selectedId)) selectNode(null);
    if (state.runState) setRunState(state.runState);

    recomputeMinZoom();
    // The FIRST render() this instance has done for THIS workflow opens on
    // the saved view or a fit. Every render() after that for the same
    // workflow, including the one B3 fires after saving an edit, leaves the
    // view exactly where the person left it. B3 does not (and should not
    // have to) tell us which case this is, a fresh mount and a post save
    // redraw call render() the same way, so this file is the one place that
    // can tell them apart. Tracked per slug rather than per instance: if a
    // canvas instance is ever reused across workflows, switching to a second
    // workflow must not inherit the first one's pan and zoom.
    const firstForThisWorkflow = !state.openedSlugs.has(state.slug);
    state.openedSlugs.add(state.slug);
    state.everRendered = true;
    if (firstForThisWorkflow) {
      if (renderOpts.keepView) applyTransform();
      else openInitialView();
    } else {
      applyTransform();
    }
  }

  /* ---- window resize keeps the host panel's own height honest -------------------
     ResizeObserver above watches the canvas root for its OWN size changing, which
     is what recomputes the zoom floor and the minimap. This is the other half: the
     browser window resizing changes HOST_MAX_H_VH's ceiling, so a graph that was
     capped by viewport height on a short window should get taller headroom on a
     tall one, and vice versa. Debounced, since resize fires continuously while a
     window is being dragged. */
  let hostResizeTimer = null;
  function onWindowResize() {
    clearTimeout(hostResizeTimer);
    hostResizeTimer = setTimeout(() => {
      updateHostHeight();
      recomputeMinZoom();
      updateMinimapViewport();
    }, 120);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize);
  }

  function destroy() {
    if (state.resizeObs) state.resizeObs.disconnect();
    clearTimeout(hostResizeTimer);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWindowResize);
    }
    host.innerHTML = '';
    host.style.height = '';
  }

  applyTransform();

  return { render, setRunState, focusNode, fit, destroy };
}
