// ARTHA FLOW graph layout engine.
//
// A pure function. No DOM, no window, no document, no browser API of any kind.
// It has to run in plain Node so it can be tested without a browser, and so
// B2 can call it from inside the page without pulling in anything extra.
//
// The job: turn a workflow definition into cards in a row, arrows between
// them, and lanes for loop bodies, the way n8n reads left to right.

// n8n sized cards, per the 2026-08-19 correction: boxes stay boxes, with the
// name and a trimmed line or two of content inside them, just tighter than
// the original 260 wide paragraph box. Column and row gap grew a little to
// match, so the tighter cards still read as a row with room to breathe.
const DEFAULT_W = 190;
const DEFAULT_H = 100;
const COLUMN_GAP = 110;
const ROW_GAP = 60;

const LANE_PADDING = 24;   // space inside a lane's border before its own content starts
const LANE_HEADER = 34;    // room at the top of a lane for its label
const LANE_INDENT = 40;    // how far right of the each node the lane starts
const LANE_GAP = 30;       // gap between two sibling lanes stacked in the same scope

const GAP_BELOW_MAIN = 50; // space kept between the main row and whatever sits under it,
                            // which in practice means the run up to a lane
const TOP_MARGIN = 40;     // clear band above the main row before the first card

// how deep a loop can nest inside a loop before the layout refuses to go further.
// nothing shipped needs this, it is a guard against a mistake, not a real limit.
const MAX_SCOPE_DEPTH = 24;

// a hard ceiling on total nodes processed across every scope, so a workflow that
// somehow tricks the claim tracking cannot make this run forever. real workflows
// are nowhere near this.
const MAX_TOTAL_NODES = 20000;

// how loud B2 should draw a card, grouped by what the node actually does
const TIER_BY_TYPE = {
  claude: 'prompt',
  filter: 'gate',
  each: 'loop',
  sub: 'sub',
  http: 'io',
  write: 'io',
  wait: 'io',
  log: 'plumbing',
  transform: 'plumbing',
  manual: 'plumbing'
};

export function layout(definition, opts = {}) {
  const warnings = [];
  const nodesArr = (definition && Array.isArray(definition.nodes)) ? definition.nodes : [];

  if (nodesArr.length === 0) {
    return { nodes: [], edges: [], lanes: [], width: 0, height: 0, warnings };
  }

  const byId = new Map();
  for (const n of nodesArr) {
    if (n && n.id != null) byId.set(n.id, n);
  }

  const sizeOf = typeof opts.sizeOf === 'function' ? opts.sizeOf : null;
  function sizeFor(nodeDef) {
    let w = DEFAULT_W;
    let h = DEFAULT_H;
    if (sizeOf) {
      try {
        const s = sizeOf(nodeDef);
        if (s && typeof s === 'object') {
          if (typeof s.w === 'number' && s.w > 0) w = s.w;
          if (typeof s.h === 'number' && s.h > 0) h = s.h;
        }
      } catch (e) {
        // a broken sizeOf must never break the picture, fall back to the default card
      }
    }
    return { w, h };
  }

  // the run starts at the node flagged start, or the first node in the file.
  // this mirrors server/engine.js so the picture always starts where a run starts.
  const startNode = nodesArr.find((n) => n && n.start === true) || nodesArr[0];
  const startId = startNode ? startNode.id : undefined;

  // a node can only belong to one scope. this catches a body pointing back into
  // an ancestor, or two each nodes sharing a body, without looping forever.
  const claimed = new Set();
  const laneCounter = { n: 0 };
  const budget = { left: MAX_TOTAL_NODES };

  const top = layoutScope(startId, 0);

  const MARGIN = 24; // canvas padding so nothing sits flush against the edge
  translateBundle(top, MARGIN, MARGIN);

  return {
    nodes: top.nodes,
    edges: top.edges,
    lanes: top.lanes,
    width: top.width + MARGIN * 2,
    height: top.height + MARGIN * 2,
    warnings
  };

  // ---- everything below runs once per scope: the main row, and once again for
  // ---- every loop lane, at whatever depth it nests to. ----

  function layoutScope(rootId, depth) {
    if (rootId == null || !byId.has(rootId) || claimed.has(rootId) || depth > MAX_SCOPE_DEPTH) {
      if (rootId != null && !byId.has(rootId)) {
        warnings.push(`"${rootId}" does not exist, that part of the picture is left out`);
      } else if (rootId != null && claimed.has(rootId)) {
        warnings.push(`"${rootId}" is already used somewhere else in the graph, it cannot also start a loop body here`);
      } else if (depth > MAX_SCOPE_DEPTH) {
        warnings.push(`a loop nests deeper than ${MAX_SCOPE_DEPTH}, the layout stops going deeper there`);
      }
      return emptyBundle();
    }

    // 1. walk everything reachable from rootId over next, elseNext and true/false,
    // but never step into an each node's body here, that is a separate scope.
    const scopeNodeIds = [];
    const edgesFlat = []; // next / true / else, this is what column math runs on
    const bodyLinks = []; // each -> its body root, turned into a lane after column math
    const visited = new Set();
    const queue = [rootId];

    while (queue.length) {
      if (budget.left-- <= 0) { warnings.push('layout hit its global node budget and stopped early'); break; }
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      claimed.add(id);
      scopeNodeIds.push(id);
      const node = byId.get(id);
      if (!node) continue;

      const addEdge = (targetId, kind, label) => {
        if (targetId == null) return;
        if (!byId.has(targetId)) {
          warnings.push(`"${id}" points at "${targetId}", which does not exist. That edge is dropped.`);
          return;
        }
        edgesFlat.push({ from: id, to: targetId, kind, label });
        if (!visited.has(targetId)) queue.push(targetId);
      };

      if (node.type === 'filter') {
        addEdge(node.next, 'true', 'yes');
        addEdge(node.elseNext, 'else', 'no');
      } else if (node.type === 'each') {
        addEdge(node.next, 'next', null); // after the loop finishes, carry on down the main row
        const bodyRoot = node.config && node.config.body;
        if (bodyRoot != null) {
          if (byId.has(bodyRoot)) {
            bodyLinks.push({ ownerId: id, bodyRoot });
          } else {
            warnings.push(`each "${id}" points its body at "${bodyRoot}", which does not exist. That loop has no lane.`);
          }
        }
      } else {
        addEdge(node.next, 'next', null);
      }
    }

    // 2. a cycle must never hang the layout. walk the scope with an explicit
    // stack and turn any edge that closes a loop into a back edge instead of
    // following it further.
    const backEdges = markBackEdges(scopeNodeIds, edgesFlat, rootId);
    for (const e of edgesFlat) {
      if (backEdges.has(e)) { e.kind = 'back'; e.label = null; }
    }

    // 3. longest path from the scope root, over everything except a back edge.
    // longest, not shortest, so a node can never sit to the left of the longest
    // chain of work that has to finish before it runs.
    const dagEdges = edgesFlat.filter((e) => e.kind !== 'back');
    const col = longestPathColumns(scopeNodeIds, dagEdges, rootId);

    // 4. order each column by a barycenter pass, so a child lands near the
    // average row of whatever feeds it and the arrows stay as straight as
    // they can.
    const { row, order } = assignRows(scopeNodeIds, dagEdges, col, nodesArr);

    // 5. columns and rows into real pixels
    const sizes = new Map();
    for (const id of scopeNodeIds) sizes.set(id, sizeFor(byId.get(id)));

    const maxCol = scopeNodeIds.reduce((m, id) => Math.max(m, col.get(id) || 0), 0);
    const colWidth = new Array(maxCol + 1).fill(0);
    for (const id of scopeNodeIds) {
      const c = col.get(id) || 0;
      colWidth[c] = Math.max(colWidth[c], sizes.get(id).w);
    }
    const colX = new Array(maxCol + 1).fill(0);
    for (let c = 1; c <= maxCol; c++) colX[c] = colX[c - 1] + colWidth[c - 1] + COLUMN_GAP;

    const posById = new Map();
    for (let c = 0; c <= maxCol; c++) {
      let y = TOP_MARGIN;
      for (const id of order[c] || []) {
        const s = sizes.get(id);
        posById.set(id, { x: colX[c], y, w: s.w, h: s.h, col: c, row: row.get(id) });
        y += s.h + ROW_GAP;
      }
    }

    let mainRowBottom = TOP_MARGIN;
    let mainRowWidth = 0;
    for (const id of scopeNodeIds) {
      const p = posById.get(id);
      mainRowBottom = Math.max(mainRowBottom, p.y + p.h);
      mainRowWidth = Math.max(mainRowWidth, p.x + p.w);
    }

    const outNodes = [];
    const outLanes = [];
    let outEdges = [];
    const metaById = new Map(); // x,y,w,h,col,row per node, used for edge routing and lane placement

    for (const id of scopeNodeIds) {
      const p = posById.get(id);
      const nodeDef = byId.get(id);
      const tier = TIER_BY_TYPE[nodeDef.type] || 'plumbing';
      outNodes.push({
        id,
        node: nodeDef,
        x: p.x, y: p.y, w: p.w, h: p.h,
        col: p.col, row: p.row,
        lane: null,
        tier
      });
      metaById.set(id, p);
    }

    // 6. one lane per each node found here, stacked below the main row so a
    // lane can never collide with a main row card no matter how tall the loop
    // body turns out to be. lanes read left to right, top to bottom, in the
    // same order their owner appears in the row.
    const sortedLinks = bodyLinks.slice().sort((a, b) => {
      const pa = metaById.get(a.ownerId);
      const pb = metaById.get(b.ownerId);
      if (pa.col !== pb.col) return pa.col - pb.col;
      return pa.row - pb.row;
    });

    let laneStackY = mainRowBottom + GAP_BELOW_MAIN;
    let scopeWidth = mainRowWidth;

    for (const { ownerId, bodyRoot } of sortedLinks) {
      const ownerPos = metaById.get(ownerId);
      const sub = layoutScope(bodyRoot, depth + 1);

      const laneId = `lane_${ownerId}_${laneCounter.n++}`;
      const laneW = Math.max(sub.width, 160) + LANE_PADDING * 2;
      const laneH = Math.max(sub.height, 40) + LANE_HEADER + LANE_PADDING * 2;
      const laneX = ownerPos.x + LANE_INDENT;
      const laneY = laneStackY;

      translateBundle(sub, laneX + LANE_PADDING, laneY + LANE_HEADER + LANE_PADDING);
      for (const n of sub.nodes) { if (n.lane == null) n.lane = laneId; }

      outNodes.push(...sub.nodes);
      outEdges = outEdges.concat(sub.edges);
      outLanes.push(...sub.lanes);

      const ownerNodeDef = byId.get(ownerId);
      outLanes.push({
        id: laneId,
        kind: 'each',
        label: laneLabel(ownerNodeDef),
        x: laneX, y: laneY, w: laneW, h: laneH,
        ownerId
      });

      outEdges.push({
        from: ownerId,
        to: bodyRoot,
        kind: 'body',
        label: 'for each',
        points: routeIntoLane(ownerPos, { x: laneX, y: laneY, w: laneW, h: laneH })
      });

      laneStackY = laneY + laneH + LANE_GAP;
      scopeWidth = Math.max(scopeWidth, laneX + laneW);
    }

    const scopeHeight = sortedLinks.length ? (laneStackY - LANE_GAP) : (mainRowBottom + GAP_BELOW_MAIN);

    // 7. structural edges (next, true, else, back) carry no routed points.
    // Wiring them into a curve is now a rendering concern, not a layout one:
    // B2 draws a bezier straight from the source card's output port to the
    // target card's input port, which is what makes it read as n8n. Points
    // stayed useful for body edges above, which have a real routing rule
    // (owner's bottom, into the lane's header band), so those keep theirs.
    outEdges = outEdges.concat(edgesFlat.map((e) => ({ ...e, points: [] })));

    return { nodes: outNodes, edges: outEdges, lanes: outLanes, width: scopeWidth, height: scopeHeight };
  }
}

// a short, readable tag for a lane, built from whatever the each node is
// actually looping over so it reads like a caption, not a placeholder
function laneLabel(eachNodeDef) {
  const name = eachNodeDef && eachNodeDef.name ? eachNodeDef.name : eachNodeDef.id;
  return `Loop: ${name}`;
}

function emptyBundle() {
  return { nodes: [], edges: [], lanes: [], width: 0, height: 0 };
}

function translateBundle(bundle, dx, dy) {
  for (const n of bundle.nodes) { n.x += dx; n.y += dy; }
  for (const l of bundle.lanes) { l.x += dx; l.y += dy; }
  for (const e of bundle.edges) {
    for (const p of e.points) { p.x += dx; p.y += dy; }
  }
}

// walks the scope with its own stack (not the call stack, so this cannot blow
// up on a deep or cyclic graph) and reports every edge that closes a loop.
// those are marked 'back' by the caller and left out of the column math,
// which is what stops a cycle from ever hanging the layout.
function markBackEdges(nodeIds, edges, rootId) {
  const adjacency = new Map();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) {
    if (adjacency.has(e.from)) adjacency.get(e.from).push(e);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodeIds.map((id) => [id, WHITE]));
  const backEdges = new Set();
  const stepCap = nodeIds.length * 8 + 200; // generous, a real graph never gets near this
  let steps = 0;

  function dfsFrom(start) {
    if (color.get(start) !== WHITE) return;
    const stack = [{ id: start, i: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      if (steps++ > stepCap) { stack.length = 0; break; }
      const frame = stack[stack.length - 1];
      const outs = adjacency.get(frame.id) || [];
      if (frame.i < outs.length) {
        const e = outs[frame.i];
        frame.i++;
        const c = color.get(e.to);
        if (c === GRAY) {
          backEdges.add(e); // points at a node still open on the stack: a real cycle
        } else if (c === WHITE) {
          color.set(e.to, GRAY);
          stack.push({ id: e.to, i: 0 });
        }
        // BLACK means an already finished branch, nothing to do
      } else {
        color.set(frame.id, BLACK);
        stack.pop();
      }
    }
  }

  if (rootId != null && color.has(rootId)) dfsFrom(rootId);
  for (const id of nodeIds) dfsFrom(id); // safety net, should be a no-op once root is walked

  return backEdges;
}

// Kahn's algorithm run for longest path instead of the usual shortest. every
// node's column becomes one more than the largest column among everything
// that feeds it, so an arrow can never point back at where it came from.
function longestPathColumns(nodeIds, edges, rootId) {
  const indeg = new Map(nodeIds.map((id) => [id, 0]));
  const adj = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !indeg.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const col = new Map(nodeIds.map((id) => [id, 0]));
  let queue = nodeIds.filter((id) => indeg.get(id) === 0);
  // the declared root belongs first, it is genuinely column 0, not just a node
  // that happens to have no incoming edge left after a cycle got broken
  queue.sort((a, b) => (a === rootId ? -1 : b === rootId ? 1 : 0));

  const cap = nodeIds.length * 4 + 100;
  let guard = 0;
  while (queue.length) {
    if (guard++ > cap) break; // should never trigger, back edges are already removed
    const id = queue.shift();
    for (const to of adj.get(id)) {
      if (col.get(id) + 1 > col.get(to)) col.set(to, col.get(id) + 1);
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return col;
}

// one barycenter pass per column: a node's row is the average row of whatever
// feeds it, so a child lands close to its parent instead of at a random spot.
// nodes with no predecessor in this scope keep the order they had in the
// original file, so the picture is stable across runs.
function assignRows(nodeIds, edges, col, nodesArr) {
  const orderIndex = new Map(nodesArr.map((n, i) => [n && n.id, i]));
  const preds = new Map(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (preds.has(e.to)) preds.get(e.to).push(e.from);
  }
  const maxCol = nodeIds.reduce((m, id) => Math.max(m, col.get(id) || 0), 0);
  const byCol = new Array(maxCol + 1).fill(null).map(() => []);
  for (const id of nodeIds) byCol[col.get(id) || 0].push(id);

  const rowOf = new Map();
  const order = new Array(maxCol + 1).fill(null).map(() => []);

  for (let c = 0; c <= maxCol; c++) {
    const scored = byCol[c].map((id) => {
      const ps = preds.get(id) || [];
      let bary;
      if (ps.length === 0) {
        bary = orderIndex.has(id) ? orderIndex.get(id) : 0;
      } else {
        const sum = ps.reduce((s, p) => s + (rowOf.has(p) ? rowOf.get(p) : 0), 0);
        bary = sum / ps.length;
      }
      return { id, bary, tie: orderIndex.has(id) ? orderIndex.get(id) : 0 };
    });
    scored.sort((a, b) => (a.bary - b.bary) || (a.tie - b.tie));
    scored.forEach((s, i) => { rowOf.set(s.id, i); order[c].push(s.id); });
  }

  return { row: rowOf, order };
}

// Structural edges no longer carry routed points, see the note at the call
// site above. Kept nothing here on purpose: the old orthogonal router
// (adjacent / skip / back detours through a clear band) is gone, because a
// bezier from output port to input port does not need to dodge the columns
// in between the way a right angle line did.

// a short vertical connector from the bottom of the each card down into the
// lane's header band, where nothing else is ever drawn
function routeIntoLane(ownerPos, lane) {
  const startX = ownerPos.x + ownerPos.w / 2;
  const startY = ownerPos.y + ownerPos.h;
  const midY = lane.y + LANE_HEADER / 2;
  const endX = lane.x + 14;
  return [
    { x: startX, y: startY },
    { x: startX, y: midY },
    { x: endX, y: midY }
  ];
}
