# ARTHA FLOW

A workflow engine that runs on your own machine, with a live interface, and **no API key**.

You describe a workflow as a chain of steps. Fetch a page, filter a list, loop over items, save a
file. Steps that need thinking are handed to the AI agent you already use (Claude Code, Codex,
Cursor, Gemini CLI, anything with a shell). The run pauses, the agent answers, the run carries on.
You watch all of it in the browser.

- Zero dependencies. Nothing to `npm install`.
- Runs only on `127.0.0.1`. Your data stays on your machine.
- Works with any agent that can run a shell command or send an HTTP request.

## Set it up: give your AI this link

Paste this to your AI agent:

> Set up this repo for me and get me started: https://github.com/Eashan1401/artha-flow

The agent clones it, reads `AGENTS.md`, checks your Node version, starts the server, runs a test
workflow end to end, and then asks what you want to automate. You only need **Node 22.5 or newer**.

## Set it up by hand

```bash
git clone https://github.com/Eashan1401/artha-flow.git
cd artha-flow
./bin/aflow doctor
./bin/aflow start            # then open http://127.0.0.1:7717
./bin/aflow run smoke-test
./bin/aflow next             # the parked prompt, for your agent (or answer it in the Inbox page)
./bin/aflow answer 1 "Cold coffee sells all year."
```

## What you see in the browser

Workflows with a live graph, every run step by step with its input and output, a live event log,
and an Inbox of prompts waiting for the agent (you can answer by hand there too).

## Docs

- `AGENTS.md`: full instructions for the AI agent (setup, the loop, safety).
- `docs/AGENT-BRIDGE.md`: exactly how an agent answers prompts, including raw HTTP and websocket.
- `docs/WORKFLOW-FORMAT.md`: how to write workflows and every node type.
- `workflows/`: `smoke-test`, `summarize-url`, `triage-list`.

## Safety

The server has no login and binds to localhost only, so do not expose it to a network. The
`transform` and `shell-json` nodes run real code on your machine: run only workflows you wrote or
read. `write` can only write inside `data/out/`.

## Licence

MIT.
