// Run one shell command, capture its stdout, parse the last JSON looking line as the output.
//
// Added 2026-09-17, coordinator design fix, WU-20260917123442845903-971C45: a status read or
// a gate check is mechanical. It does not need a person, so it must not park a Claude prompt.
// Before this node the only way a workflow could run a real shell command was a claude node
// whose prompt told Claude to run it by hand, which meant every mechanical check waited on a
// session being attached. This node does the same job with no park at all.
//
// Deliberately minimal, matching CONTRACT.md's zero dependency rule: node:child_process is a
// Node built in, same tier as node:sqlite and node:http elsewhere in this codebase. This is
// the owner's own machine and the transform node already runs arbitrary JavaScript on it
// (transform.js's own header comment says so plainly), so a node that runs one shell command
// is the same trust boundary, not a new one. Nobody outside this machine can reach this node:
// server/index.js binds to 127.0.0.1 only, and CONTRACT.md hard rule 4 keeps it that way.
//
// What this node is FOR: bin/research-pipeline's own --status --json and --gate --json modes,
// and bin/content-brief --check --json, all added the same day this node was, so their stdout
// is exactly one line of JSON and this node's job is trivial. It also tolerates a command that
// prints progress lines before a final JSON line (the "last JSON looking line wins" rule
// below), so it is not narrowly tied to only those three commands.
//
// What this node is NOT for: anything that needs judgement, anything reading many files and
// deciding what matters, anything writing prose that must trace to evidence. That work stays
// on the claude node, which is the actual product.

import { execFileSync } from 'node:child_process';

export const type = 'shell-json';

export const meta = {
  label: 'Run a shell command, parse JSON',
  description: 'Runs one command and parses its stdout as JSON. No park, for mechanical checks a person is not needed for: a status read, a gate check. Never for judgement, that stays on the claude node.',
  configSchema: {
    command: { type: 'string', required: true, help: 'Shell command line, templates allowed, e.g. bin/research-pipeline {{ input.slug }} {{ input.flag }} --status --json' },
    cwd: { type: 'string', required: false, help: 'Working directory. Defaults to the artha-flow folder.' },
    timeoutMs: { type: 'number', required: false, default: 20000, help: 'Kill the command after this long.' },
    failOnNonZeroExit: { type: 'boolean', required: false, default: false, help: 'true: a non zero exit fails the step. false (default): capture the exit code and stdout and let a filter node decide, because tools like bin/research-pipeline --gate use exit 1 as a normal fail signal, not a crash.' }
  }
};

// Default working directory is the artha-flow folder (server/nodes -> server -> root).
// Set cwd in the node config to run somewhere else.
const REPO_ROOT_FROM_HERE = new URL('../../', import.meta.url).pathname;

export async function run(ctx) {
  const cfg = ctx.config || {};
  const nodeId = ctx.node.id;
  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  if (!command) throw new Error(`shell-json node "${nodeId}" needs a command in config`);

  const cwd = typeof cfg.cwd === 'string' && cfg.cwd.trim() ? cfg.cwd.trim() : REPO_ROOT_FROM_HERE;
  const timeoutMs = Number(cfg.timeoutMs ?? 20000);
  const failOnNonZeroExit = Boolean(cfg.failOnNonZeroExit);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('/bin/bash', ['-lc', command], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ? String(err.stdout) : '';
    stderr = err.stderr ? String(err.stderr) : String(err.message || '');
    if (failOnNonZeroExit) {
      throw new Error(`shell-json node "${nodeId}": command exited ${exitCode}: ${command}\n${stderr}`);
    }
  }

  const trimmed = stdout.trim();
  let json = null;
  let parseError = null;
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      // Not every command prints JSON and nothing else. Walk backward through the lines and
      // take the last one that parses, so a command that logs progress before its final JSON
      // line still works without every caller wiring up a --quiet flag.
      const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
      let found = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          json = JSON.parse(lines[i]);
          found = true;
          break;
        } catch {
          // keep walking backward
        }
      }
      if (!found) parseError = `stdout did not contain a JSON line: ${trimmed.slice(0, 300)}`;
    }
  } else {
    parseError = 'stdout was empty';
  }

  ctx.log(
    exitCode === 0 ? 'info' : 'warn',
    `shell-json node "${nodeId}" ran, exit ${exitCode}${json ? ', parsed JSON ok' : ', no JSON parsed'}`
  );

  return { command, exitCode, stdout: trimmed, stderr: stderr.trim(), json, parseError };
}
