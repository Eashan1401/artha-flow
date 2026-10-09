// Write a line into the run log. The cheapest way to see what a run is doing.

export const type = 'log';

export const meta = {
  label: 'Log a message',
  description: 'Writes a line to the run log and the live feed.',
  configSchema: {
    message: { type: 'string', required: true, help: 'Text to log. Templates allowed.' },
    level: { type: 'string', required: false, default: 'info', help: 'info, warn or error' }
  }
};

const LEVELS = new Set(['info', 'warn', 'error']);

export async function run(ctx) {
  const message = ctx.config.message;
  if (message === undefined || message === null) {
    throw new Error(`log node "${ctx.node.id}" needs a message in config`);
  }
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const level = LEVELS.has(ctx.config.level) ? ctx.config.level : 'info';
  ctx.log(level, text);
  return { message: text };
}
