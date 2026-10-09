# ARTHA FLOW: instructions for the AI agent

You are reading this because a person gave you the link to this repo. Their goal: get ARTHA FLOW
running on their machine, then build and run workflows with them. You do all of it. They should
only have to answer questions that are truly theirs.

This file is for any agent: Claude Code, Codex, Cursor, Gemini CLI, anything with a shell.

## What this is

A local workflow engine with a live web interface. A workflow is a JSON file: a chain of steps
(log, http, filter, loop, write, shell, wait, sub-workflows, parallel branches). Steps that need
thinking are `claude` nodes. There is **no API key anywhere**. When a run reaches a thinking step,
it parks and puts the prompt in a queue. **You are the model.** You read the prompt, think, and
post the answer, and the run carries on.

The person watches all of it in the browser at http://127.0.0.1:7717: the workflow graph, each
run step by step, and the inbox of prompts waiting on you.

It is its own system. It has no link to the company that built it. Their workflows, data and
runs live only on their machine.

## Step 1. Set it up (do this now, ask nothing)

Run these from the repo root:

```bash
node -v                  # must be 22.5 or newer. If not, tell the person to install Node from nodejs.org, then stop.
./bin/aflow doctor       # checks Node, files, workflows. One FAIL line tells you what to fix.
./bin/aflow start        # starts the server in the background, prints the URL
./bin/aflow run smoke-test '{"topic":"cold coffee"}'
./bin/aflow next         # claims the parked prompt, prints JSON
./bin/aflow answer <promptId> "Cold coffee sells all year."
./bin/aflow status <runId>   # expect: done
```

If the smoke test ends `done`, the whole machine works: engine, queue, you, and the file write.
Tell the person to open http://127.0.0.1:7717 and look at the run. Nothing else is needed.
On Windows use WSL or Git Bash. There is nothing to `npm install`, ever.

If something fails, read `data/server.log`, fix it, and try again. Do not skip the smoke test.

## Step 2. Learn the one job you have

Read `docs/AGENT-BRIDGE.md`. It is short and exact. The loop is:
`./bin/aflow pending` then `./bin/aflow next` then think then `./bin/aflow answer <id>`.
Rules you must hold to:

- Answer each prompt from its own text. Never paste one answer into another prompt.
- If the prompt wants JSON, send only JSON, no code fences.
- If you cannot answer honestly, run `./bin/aflow fail <id> "reason"`. A wrong answer is worse.
- Keep a watch running in a second shell when useful: `./bin/aflow watch <runId>` (websocket).

Any agent that can run shell commands or send HTTP requests can be the model. The API is plain
REST plus a websocket at `/ws`; every `aflow` command has a curl form in the bridge doc. A second
agent, or several, can answer prompts at the same time.

## Step 3. Build workflows with the person

Ask them one question: **what do you want to automate?** Then build it yourself:

1. `./bin/aflow new <slug>` creates a valid starter file in `workflows/`.
2. Edit it using `docs/WORKFLOW-FORMAT.md`. `GET /api/nodes` lists every node type and its config.
3. `./bin/aflow stop && ./bin/aflow start` to load it, then `./bin/aflow run <slug> '<input json>'`.
4. Answer the thinking steps as they park, then show the person the run in the browser.

Prefer plain mechanical nodes (`http`, `filter`, `transform`, `write`, `shell-json`) for anything
that does not need judgement, and keep `claude` nodes for the steps that truly need thinking.

## Safety

- The server binds to 127.0.0.1 only and has no login. Do not expose it to a network.
- `write` can only write inside `data/out/`. `transform` and `shell-json` run real code on this
  machine, so only run workflows the person wrote or you wrote with them. Read any workflow
  from outside before running it.
- Never put secrets inside a workflow file. Pass them at run time or read them in a `shell-json`
  command from the person's own environment.
- Do not delete `data/flow.db`. It is their run history.

## Where things are

```
bin/aflow        the command line (list run status watch next pending answer fail start stop doctor new)
server/          the engine, the API, the websocket (zero dependencies)
ui/              the browser interface
workflows/       one JSON file per workflow
docs/            AGENT-BRIDGE.md (your loop), WORKFLOW-FORMAT.md (how to write workflows)
data/            flow.db, server.log, out/ (all git ignored)
```
