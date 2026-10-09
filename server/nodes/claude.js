// The bridge node. This is the whole point of ARTHA FLOW.
//
// There is no API key and no cost. When a run needs thinking done, this node
// writes the prompt into the prompts table, tells the websocket about it, and
// then parks: it hands back the sentinel { __park: true, promptId } and the
// engine stops the run and saves its place.
//
// Later, a Claude Code session (or a human in the inbox page) posts the answer
// to POST /api/claude/answer. That marks the prompt answered and calls
// resumeRun. The engine walks back to this same node and runs it again, but
// this time ctx.resume.promptId is set, so the node reads the stored answer and
// returns it as a normal output. Nothing polls. Nothing blocks a thread.
//
// A run can sit parked for a minute or a week. The state lives in the runs
// cursor column, not in memory.

import { createPrompt, getPrompt, requeuePrompt } from '../db.js';

export const type = 'claude';

export const meta = {
  label: 'Ask Claude',
  description: 'Parks the run and puts the prompt in the queue. No API key, no cost.',
  configSchema: {
    system: { type: 'string', required: false, help: 'Optional system line. Sets the voice and the rules.' },
    prompt: { type: 'string', required: true, help: 'What to ask. Templates allowed.' },
    expect: { type: 'string', required: false, default: 'text', help: 'text or json' },
    schemaHint: { type: 'string', required: false, help: 'Shown to Claude when expect is json, so the shape comes back right.' }
  }
};

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;
  const expect = cfg.expect === 'json' ? 'json' : 'text';

  // ---- second pass: we are being resumed, the answer is in the table -----
  if (ctx.resume && ctx.resume.promptId) {
    const prompt = getPrompt(ctx.resume.promptId);
    if (!prompt) {
      throw new Error(`claude node "${nodeId}": prompt ${ctx.resume.promptId} is missing from the database`);
    }
    if (prompt.status !== 'answered') {
      throw new Error(
        `claude node "${nodeId}": prompt ${prompt.id} is "${prompt.status}", not "answered", so there is nothing to read`
      );
    }
    const text = String(prompt.answer ?? '');
    const actor = prompt.actor || 'claude:session';
    ctx.emit('prompt.answered', { promptId: prompt.id, nodeId, retryCount: prompt.retryCount, actor });

    if (expect !== 'json') return { text, actor };

    const parsed = tryParseJson(text);
    if (parsed.ok) return { json: parsed.value, text, actor };

    // The answer was meant to be JSON and it is not. Put the prompt back in
    // the queue with the retry counted, so Claude can have another go. The
    // engine marks this step failed and parks the run again on the same node.
    requeuePrompt(prompt.id);
    const reason = `claude node "${nodeId}": expected JSON but the answer did not parse (${parsed.error}). Prompt ${prompt.id} is back in the queue, retry ${prompt.retryCount + 1}.`;
    ctx.log('error', reason);
    ctx.emit('prompt.new', {
      promptId: prompt.id,
      nodeId,
      prompt: prompt.prompt,
      system: prompt.system,
      expect: prompt.expect,
      schemaHint: prompt.schemaHint,
      retryCount: prompt.retryCount + 1
    });
    return { __park: true, promptId: prompt.id, error: reason };
  }

  // ---- first pass: queue the question and park -------------------------
  if (!cfg.prompt || String(cfg.prompt).trim() === '') {
    throw new Error(`claude node "${nodeId}" needs a prompt in config`);
  }

  const row = createPrompt({
    runId: ctx.run.id,
    stepId: ctx.stepId ?? null,
    nodeId,
    system: cfg.system ?? null,
    prompt: String(cfg.prompt),
    expect,
    schemaHint: cfg.schemaHint ?? null
  });

  ctx.log('info', `Waiting on Claude. Prompt #${row.id} is in the queue.`);
  ctx.emit('prompt.new', {
    promptId: row.id,
    nodeId,
    prompt: row.prompt,
    system: row.system,
    expect: row.expect,
    schemaHint: row.schemaHint,
    retryCount: row.retryCount
  });

  return { __park: true, promptId: row.id };
}

/**
 * Claude often wraps JSON in a markdown fence or adds a line before it.
 * Try the plain parse first, then the fence, then the first balanced object or
 * array in the text. Anything looser than that is a real failure.
 */
function tryParseJson(text) {
  const attempts = [];
  const trimmed = text.trim();
  attempts.push(trimmed);

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) attempts.push(fence[1].trim());

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace > -1) {
    const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastError = 'empty answer';
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
}
