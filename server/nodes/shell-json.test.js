import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from './shell-json.js';

function ctx(config) {
  return {
    node: { id: 'test-node' },
    config,
    log() {},
  };
}

test('runs a command and parses a single line of JSON', async () => {
  const out = await run(ctx({ command: 'echo \'{"pass":true,"missing":[]}\'' }));
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.json, { pass: true, missing: [] });
  assert.equal(out.parseError, null);
});

test('walks backward to find the last JSON line when the command also logs progress', async () => {
  const out = await run(ctx({
    command: 'echo "doing the thing"; echo "still going"; echo \'{"stage":"done"}\''
  }));
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.json, { stage: 'done' });
});

test('captures a non zero exit and its stdout without throwing, by default', async () => {
  const out = await run(ctx({
    command: 'echo \'{"pass":false,"missing":["9","11"]}\'; exit 1'
  }));
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.json, { pass: false, missing: ['9', '11'] });
});

test('failOnNonZeroExit true throws on a non zero exit', async () => {
  await assert.rejects(
    () => run(ctx({ command: 'exit 3', failOnNonZeroExit: true })),
    /exited 3/
  );
});

test('reports parseError and null json when stdout has nothing JSON shaped', async () => {
  const out = await run(ctx({ command: 'echo "just some text"' }));
  assert.equal(out.json, null);
  assert.match(out.parseError, /did not contain a JSON line/);
});

test('throws a clear error when command is missing from config', async () => {
  await assert.rejects(() => run(ctx({})), /needs a command/);
});

test('defaults cwd to the artha-flow folder, so a relative bin/ path resolves', async () => {
  const out = await run(ctx({ command: 'test -x bin/aflow && echo \'{"ok":true}\' || echo \'{"ok":false}\'' }));
  assert.deepEqual(out.json, { ok: true });
});
