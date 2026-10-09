// Trigger node. It does nothing except mark the start of a run by hand.

export const type = 'manual';

export const meta = {
  label: 'Manual trigger',
  description: 'Starts a run by hand. Does no work of its own.',
  configSchema: {}
};

export async function run() {
  return { ok: true };
}
