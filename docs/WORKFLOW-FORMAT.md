# How to write a workflow

A workflow is one JSON file in `workflows/`. The server reads the folder when it starts, so after
adding or editing a file run `./bin/aflow stop && ./bin/aflow start`.

`./bin/aflow new my-flow` creates a valid starter. `./bin/aflow doctor` checks every file is valid
JSON. `GET /api/nodes` returns every node type with its config keys and help text.

## The file

```json
{
  "slug": "my-flow",
  "name": "My flow",
  "description": "One sentence on what it is for.",
  "trigger": { "type": "manual" },
  "input": { "topic": "example input used when you run it with no input"},
  "nodes": [
    { "id": "n1", "type": "log",    "name": "Start", "config": { "message": "Run {{ run.id }}" }, "next": "n2" },
    { "id": "n2", "type": "claude", "name": "Think", "config": { "prompt": "One sentence on {{ input.topic }}.", "expect": "text" }, "next": "n3" },
    { "id": "n3", "type": "write",  "name": "Save",  "config": { "path": "my-flow/{{ run.id }}.txt", "content": "{{ steps.n2.output.text }}" }, "next": null }
  ]
}
```

- `nodes` is a flat list. Flow follows `next` (a node id, or `null` to end). The run starts at the
  first node unless a node has `"start": true`.
- Every node needs a unique `id`, a `type`, and a `config`.

## Templates

Any string in `config` can hold `{{ path }}`:

| Tag | Gives you |
| --- | --- |
| `{{ input.x }}` | a field of the run input |
| `{{ run.id }}`, `{{ run.slug }}`, `{{ run.startedAt }}` | facts about the run |
| `{{ steps.<nodeId>.output.<field> }}` | an earlier step's output |
| `{{ item }}`, `{{ index }}` | the current item, inside an `each` loop only |

A string that is exactly one tag keeps its real type (an array stays an array). Inside longer text
it becomes text. A path that does not exist fails the step with the exact path named, so mistakes
are loud. Environment variables are deliberately not available.

## Node types

| Type | Use it for | Key config | Output |
| --- | --- | --- | --- |
| `log` | a message in the run log | `message`, `level` | `{ message }` |
| `http` | call a URL | `url`, `method`, `headers`, `body`, `expect` (`json` or `text`), `failOnError` | `{ status, ok, headers, body }` |
| `claude` | **a step that needs thinking.** Parks the run until an agent answers | `prompt`, `system`, `expect` (`text` or `json`), `schemaHint` | `{ text }` or `{ json, text }` |
| `transform` | compute a value with a JavaScript expression | `expression` | `{ value }` |
| `filter` | branch on a true or false expression | `expression`; node keys `next` (true) and `elseNext` (false) | `{ passed }` |
| `each` | run a chain once per list item | `items`, `body` (id of the first loop node), `maxItems`, `stopOnError` | `{ count, results }` |
| `write` | save a file, only inside `data/out/` | `path`, `content`, `mode` (`overwrite` or `append`), `format` | `{ path, bytes }` |
| `shell-json` | run a command, parse its JSON output. No agent needed | `command`, `cwd`, `timeoutMs` | `{ json, stdout, exitCode }` |
| `wait` | pause for a time | `forSeconds` or `until` | none |
| `sub` | run another workflow | `slug`, `input` | that run's output |
| `parallel` | run independent branches at once | see `GET /api/nodes` | per branch |
| `manual` | trigger only | none | none |

Notes that save time:

- `claude` with `expect: "json"`: the agent must answer with bare JSON. A bad answer sends the
  prompt back to the queue for another try. Put the exact keys in `schemaHint`.
- An `each` loop body is a normal chain of nodes that ends with `"next": null`. After the last
  item the run continues at the `each` node's own `next`.
- Use `filter` plus `elseNext` to drop items or to send a run down a different path.
- Use `claude` only where judgement is needed. Fetching, counting, sorting and saving are
  mechanical and should use the other nodes.
- Every step's input and output is saved. Open the run in the browser to see exactly what each
  node received and returned.

## Two working examples

- `workflows/summarize-url.json`: http, transform, claude, write.
- `workflows/triage-list.json`: each, claude with JSON, filter, write.

Run either with `./bin/aflow run <slug>`, answer the prompts, and read the result in `data/out/`.
