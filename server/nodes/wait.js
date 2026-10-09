// Park a run until a time, then carry on.
//
// This is the scheduling half of the product. A follow up sequence is just a
// chain: send, wait three days, check for a reply, send again. Without this
// node every one of those has to be driven by hand, which is exactly how 25
// leads went cold before.
//
// It uses the same park machinery the claude node uses. The node does not
// sleep, does not hold a timer, and does not block a thread. It works out the
// wake time, hands the engine the sentinel { __wait: true, wakeAt }, and the
// engine writes that time into runs.wake_at and stops. A sweeper on a timer
// picks the run back up once the time has passed.
//
// The wake time lives in the database, never only in a setTimeout, so killing
// the server mid wait costs nothing. On restart the sweeper sees the row and
// carries on.

export const type = 'wait';

// Seven days. Nothing waits longer than this, whatever the config says.
export const HARD_MAX_WAIT_SECONDS = 604800;
export const DEFAULT_MAX_WAIT_SECONDS = 604800;

export const meta = {
  label: 'Wait',
  description: 'Parks the run until a time or for a number of seconds, then carries on.',
  configSchema: {
    until: {
      type: 'string',
      required: false,
      help: 'An ISO timestamp to wake at, for example 2026-08-22T09:00:00Z. Use this or forSeconds.'
    },
    forSeconds: {
      type: 'number',
      required: false,
      help: 'How many seconds to wait from now. Use this or until.'
    },
    maxWaitSeconds: {
      type: 'number',
      required: false,
      default: DEFAULT_MAX_WAIT_SECONDS,
      help: 'Safety cap in seconds. Default and hard limit is 604800, which is 7 days.'
    }
  }
};

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;

  // ---- second pass: the timer fired and the engine walked us back here ----
  if (ctx.resume && ctx.resume.wakeAt) {
    const until = ctx.resume.wakeAt;
    ctx.log('info', `Wait is over. Node "${nodeId}" was waiting until ${until}.`);
    return {
      waited: true,
      until,
      seconds: ctx.resume.seconds ?? null,
      resumedAt: new Date().toISOString()
    };
  }

  // ---- first pass: work out when to wake up and park -------------------
  const hasUntil = cfg.until !== undefined && cfg.until !== null && String(cfg.until).trim() !== '';
  const hasFor = cfg.forSeconds !== undefined && cfg.forSeconds !== null && String(cfg.forSeconds).trim() !== '';

  if (!hasUntil && !hasFor) {
    throw new Error(`wait node "${nodeId}" needs either "until" (an ISO timestamp) or "forSeconds" (a number)`);
  }
  if (hasUntil && hasFor) {
    throw new Error(`wait node "${nodeId}" has both "until" and "forSeconds". Pick one.`);
  }

  const now = Date.now();
  let target;

  if (hasUntil) {
    target = Date.parse(String(cfg.until));
    if (!Number.isFinite(target)) {
      throw new Error(`wait node "${nodeId}": "until" is not a time I can read: ${JSON.stringify(cfg.until)}. Use an ISO timestamp like 2026-08-22T09:00:00Z.`);
    }
  } else {
    const seconds = Number(cfg.forSeconds);
    if (!Number.isFinite(seconds)) {
      throw new Error(`wait node "${nodeId}": "forSeconds" must be a number, got ${JSON.stringify(cfg.forSeconds)}.`);
    }
    if (seconds < 0) {
      throw new Error(`wait node "${nodeId}": "forSeconds" cannot be negative, got ${seconds}.`);
    }
    target = now + seconds * 1000;
  }

  // The cap. A bad template must never park a run for a year.
  let maxSeconds = Number(cfg.maxWaitSeconds);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) maxSeconds = DEFAULT_MAX_WAIT_SECONDS;
  if (maxSeconds > HARD_MAX_WAIT_SECONDS) maxSeconds = HARD_MAX_WAIT_SECONDS;

  const latest = now + maxSeconds * 1000;
  let capped = false;
  if (target > latest) {
    ctx.log(
      'warn',
      `wait node "${nodeId}" was asked to wait past the ${maxSeconds} second cap, so it will wake at the cap instead.`
    );
    target = latest;
    capped = true;
  }

  // A time that has already gone by is not an error. There is simply nothing
  // to wait for, so the run walks straight on.
  if (target <= now) {
    const until = new Date(target).toISOString();
    ctx.log('info', `wait node "${nodeId}": ${until} has already passed, so nothing to wait for.`);
    return { waited: false, until, seconds: 0, resumedAt: new Date().toISOString() };
  }

  const wakeAt = new Date(target).toISOString();
  const seconds = Math.round((target - now) / 1000);

  ctx.log('info', `Waiting until ${wakeAt}, which is about ${seconds} second(s) away.`);

  return { __wait: true, wakeAt, seconds, capped };
}
