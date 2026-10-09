# The Agent Bridge

**Who this is for:** you, an AI agent (Claude Code, Codex, or any agent with a shell), with no memory of this project.
Read this one file and you can start answering prompts. Nothing else is needed.

---

## What the bridge is

ARTHA FLOW is a workflow engine that runs on this machine. A workflow is a chain of steps. Most
steps are ordinary work: fetch a URL, filter a list, write a file. Some steps need thinking, and
those are `claude` nodes. There is no API key anywhere in this product, so when a run reaches a
`claude` node it does not call a model. It writes the prompt into a queue, parks the run, and
waits. **You are the model.** You pull the prompt out of the queue, think, and post the answer
back. The engine then picks the run up at exactly that step and carries on. That is the whole
trick: the thinking is done by the AI agent the owner already runs, sitting in their terminal.

So when you see a run stuck at `waiting_on_claude`, nothing is broken. It is waiting for you.

---

## The first thing to check

```bash
./bin/aflow health
```

Expected:

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 95,
  "waitingPrompts": 2
}
```

`waitingPrompts` is your inbox count. If the command instead says
`ARTHA FLOW is not running at http://127.0.0.1:7717`, start the server first (`./bin/aflow start` runs it in the background):

```bash
./bin/aflow serve
```

That holds the terminal. Run it in another shell, or in the background, then carry on.

---

## The loop, in four commands

This is the whole job. Copy and paste it.

```bash

# 1. See what is waiting
./bin/aflow pending

# 2. Claim the next one. This prints JSON on stdout and nothing else.
./bin/aflow next

# 3. Think, then answer it. Use the id from step 2.
./bin/aflow answer 12 "your answer here"

# 4. Confirm the run picked up again
./bin/aflow status 7
```

Step 3 has three shapes, all of them fine:

```bash
./bin/aflow answer 12 "one short line"              # short answer
echo "one short line" | ./bin/aflow answer 12       # piped
./bin/aflow answer 12 < /tmp/answer.txt             # long answer from a file
```

Use the file or the pipe for anything long or anything with quotes, brackets, or newlines in
it. That avoids all shell quoting pain, and newlines survive exactly as written.

**Why you should always use `aflow next` and not read the queue by hand:** `next` claims the
prompt. A claimed prompt is not handed to anyone else. It also writes down locally which prompt
you claimed, so if you later type the wrong id, `aflow answer` stops you instead of writing your
answer into someone else's step.

---

## Reading the prompt properly

`aflow next` gives you this shape:

```json
{
  "prompt": {
    "id": 12,
    "runId": 7,
    "nodeId": "n2",
    "system": "You write short plain English.",
    "prompt": "Give one short sentence about cold coffee.",
    "expect": "text",
    "schemaHint": null,
    "status": "claimed",
    "retryCount": 0
  }
}
```

- `system` is the role for this one answer. Obey it. It usually sets tone and length.
- `prompt` is the actual question.
- `expect` is `text` or `json`. This decides the shape of your answer.
- `schemaHint` is only set when `expect` is `json`. It tells you the exact keys to return.
- `retryCount` above 0 means a previous answer to this same prompt was rejected. Look at why
  before answering again, and do not send the same thing back.

Pull out just the parts you need with `jq`:

```bash
./bin/aflow next | jq -r '.prompt.prompt'
./bin/aflow next --no-claim | jq -r '.prompt | "\(.id) [\(.expect)] \(.prompt)"'
```

`--no-claim` looks without taking. Use it when you are just having a look.

If nothing is waiting you get `{ "prompt": null }` and a note on stderr. That is not an error,
the exit code is still 0.

---

## When the answer has to be JSON

If `expect` is `json`, the engine will run `JSON.parse` on whatever you send. Send **only** the
JSON. No prose before it, no explanation after it, and no ``` fences. Fences are the single most
common way this fails.

```bash
./bin/aflow answer 12 '{"line":"Cold coffee sells all year.","why":"People buy iced drinks in winter too."}'
```

For anything longer than one line, write the file first and pipe it. It is easier to get right
and easier to check:

```bash
cat > /tmp/answer.json <<'EOF'
{
  "line": "Cold coffee sells all year.",
  "why": "People buy iced drinks in winter too."
}
EOF
./bin/aflow answer 12 < /tmp/answer.json
```

The CLI checks your JSON before it sends it, so a mistake costs you nothing:

```
$ ./bin/aflow answer 12 "Cold coffee sells all year."
Prompt 12 wants JSON and this is not valid JSON: Unexpected token 'C', "Cold coffe"... is not valid JSON
Fix it and send again, or use --no-validate to send it anyway.
$ echo $?
1
```

### How the retry works

If bad JSON does reach the server, nothing is lost. The step fails, the prompt goes back to
`waiting` with `retry_count` bumped by one, and you get exit code 3:

```
$ ./bin/aflow answer 12 "not json" --no-validate
Server said no (400) [bad_json]: Prompt 12 wants JSON and that did not parse. It is back in the queue, try again.
$ echo $?
3
```

Just claim it again and answer properly:

```bash
./bin/aflow next          # prompt 12 comes back, retryCount is now 1
./bin/aflow answer 12 < /tmp/answer.json
```

There is no penalty for a retry other than time. Do not try to route around it.

---

## Answering several in a row

A batch workflow can queue many prompts at once, for example one per lead. Do them one at a
time, in a loop. Claim, answer, claim the next.

Look at the whole queue first so you know what you are in for:

```bash
./bin/aflow pending
```

```
ID  RUN  NODE  EXPECT  STATUS   CREATED   PROMPT
--  ---  ----  ------  -------  --------  --------------------------------------------------
4   3    n4    json    waiting  13:07:51  Write a first message to Priya Nair, founder of ...
5   3    n4    json    waiting  13:07:51  Write a first message to Arjun Mehta, founder of ...
6   3    n4    json    waiting  13:07:52  Write a first message to Sara Khan, founder of ...
```

Then work the queue. Read one, think, answer, repeat:

```bash
./bin/aflow next | jq -r '.prompt.prompt'      # read prompt 4
./bin/aflow answer 4 < /tmp/a4.json

./bin/aflow next | jq -r '.prompt.prompt'      # read prompt 5
./bin/aflow answer 5 < /tmp/a5.json
```

Two rules for batches:

1. **One at a time.** Read the actual prompt each time. Prompts in a batch look similar and are
   not the same. Copying answer 4 into prompt 5 is the failure mode here.
2. **Do not loop blind in bash.** A `while` loop that pipes `aflow next` into `aflow answer`
   cannot think, so it will write rubbish into every step very fast. You are the thinking part.
   The loop is you.

When the queue is empty:

```bash
./bin/aflow pending
# Nothing waiting. Every run is either finished or still working.
```

---

## When to give up on a prompt instead of guessing

Use `aflow fail` when you genuinely cannot answer. A wrong answer is worse than a failed run,
because a wrong answer flows into the next steps and gets written to a file or sent to a client.

```bash
./bin/aflow fail 12 "The prompt asks for the client's pricing and no pricing was passed in."
```

Fail it when:

- the prompt refers to data that is not in it (a name, a number, a document you cannot see)
- the prompt asks for something you must not do
- `expect` is `json` and `schemaHint` is missing or contradicts the prompt, so any shape you
  pick would be a guess
- the prompt is empty, cut off, or clearly the result of a broken template
- you have already retried twice and the same thing keeps being rejected

Do **not** fail it just because it is hard, and do not fail it to move on faster. Write the
reason plainly. That reason is what the owner reads when they work out which workflow to fix.

---

## Doing all of this with curl instead

The CLI may not be on your PATH. Every command has a plain curl equivalent. Base URL is
`http://127.0.0.1:7717`, or `$AFLOW_PORT` if that is set.

```bash
# health
curl -s 127.0.0.1:7717/api/health

# see everything waiting
curl -s 127.0.0.1:7717/api/claude/pending

# claim the next one
curl -s "127.0.0.1:7717/api/claude/next?claim=true"

# look without claiming
curl -s 127.0.0.1:7717/api/claude/next

# answer it
curl -s -X POST 127.0.0.1:7717/api/claude/answer \
  -H 'content-type: application/json' \
  -d '{"promptId":12,"answer":"Cold coffee sells all year."}'

# answer with a long body held in a file, so no quoting problems
jq -n --arg a "$(cat /tmp/answer.txt)" '{promptId:12, answer:$a}' \
  | curl -s -X POST 127.0.0.1:7717/api/claude/answer -H 'content-type: application/json' -d @-

# give up on it
curl -s -X POST 127.0.0.1:7717/api/claude/fail \
  -H 'content-type: application/json' \
  -d '{"promptId":12,"reason":"No pricing data in the prompt."}'

# check the run carried on
curl -s 127.0.0.1:7717/api/runs/7 | jq '.run.status'

# start a run yourself
curl -s -X POST 127.0.0.1:7717/api/workflows/smoke-test/run \
  -H 'content-type: application/json' \
  -d '{"input":{"topic":"cold coffee"}}'
```

The one thing curl does not give you is the claim check that stops you answering the wrong
prompt. If you are using curl, read the `id` field back before you post.

---

## A full worked example

Real commands, real output, start to finish.

```
$ 
$ ./bin/aflow health
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 95,
  "waitingPrompts": 0
}

$ ./bin/aflow run smoke-test '{"topic":"cold coffee"}'
4
Run 4 started for "smoke-test" (waiting_on_claude).
Watch it with:  aflow watch 4

$ ./bin/aflow status 4
run 4  smoke-test      waiting_on_claude   started 13:07:51  2s  prompt #4 waiting

$ ./bin/aflow pending
ID  RUN  NODE  EXPECT  STATUS   CREATED   PROMPT
--  ---  ----  ------  -------  --------  --------------------------------------------------
4   4    n2    text    waiting  13:07:51  Give one short sentence about cold coffee.

$ ./bin/aflow next
{
  "prompt": {
    "id": 4,
    "runId": 4,
    "stepId": null,
    "nodeId": "n2",
    "system": null,
    "prompt": "Give one short sentence about cold coffee.",
    "expect": "text",
    "schemaHint": null,
    "answer": null,
    "status": "claimed",
    "claimedAt": "2026-08-19T11:08:19.804Z",
    "retryCount": 0,
    "createdAt": "2026-08-19T11:07:51.316Z",
    "answeredAt": null
  }
}

Prompt 4 claimed.
Answer it with:  aflow answer 4 "your answer"

$ echo "Cold coffee sells all year, not just in summer." | ./bin/aflow answer 4
answered 4  run 4  resumed
Check it landed with:  aflow status 4

$ ./bin/aflow status 4
run 4  smoke-test      done                started 13:07:51  29s
```

The run is `done`. The answer is in the output of step `n2`, and the `write` node saved the file
under `data/out/`. Check either one:

```
$ curl -s 127.0.0.1:7717/api/runs/4 | jq '.steps[] | {nodeId, status, output}'
$ ls data/out/smoke/
```

To watch the whole thing happen live instead of polling by hand, open a second shell and run
`./bin/aflow watch 4` before you answer:

```
$ ./bin/aflow watch 4
13:06:13  run.started     Run started for smoke-test
Live over the websocket. Ctrl+c to stop.
13:06:13  step.started    n1  log  "Say hello"
13:06:13  log             info  Starting run for cold coffee
13:06:13  step.finished   n1  done
13:06:13  step.started    n2  claude  "Ask Claude for one line"
13:06:13  prompt.new      n2  Prompt 3 is waiting  prompt #3
13:06:13  run.waiting     Parked on Claude  prompt #3
  -> parked on Claude. Answer it:  aflow next
13:06:15  run.resumed     Answer received, carrying on  prompt #3
13:06:15  prompt.answered  prompt #3
13:06:15  step.finished   n2  done
13:06:16  step.started    n3  write  "Save it"
13:06:16  step.finished   n3  done
13:06:16  run.finished    Run finished  done

Run 3 ended: done
```

---

## Exit codes, for scripting

| Code | Meaning | What to do |
|---|---|---|
| 0 | fine | carry on |
| 1 | you typed it wrong, or the answer failed a local check | fix the command |
| 2 | the server is not running | `./bin/aflow start` |
| 3 | the server rejected it | read the message, it says why |

```bash
./bin/aflow answer 12 < /tmp/answer.json || echo "did not land, code $?"
```

---

## Things that go wrong, and the fix

| What you see | What it means | Fix |
|---|---|---|
| `ARTHA FLOW is not running at ...` | server is down | `./bin/aflow start` |
| `{ "prompt": null }` | queue is empty | nothing to do, this is not an error |
| `You claimed prompt 4, but you are answering prompt 5.` | wrong id | answer 4, or add `--force` if you really meant 5 |
| `Prompt 12 wants JSON and this is not valid JSON` | shape is wrong | send only JSON, no fences, no prose |
| `Server said no (409) ... already answered` | someone got there first | `./bin/aflow pending` and take a different one |
| run sits at `waiting_on_claude` after you answered | a later step is parked too | `./bin/aflow pending` again, there is another prompt |
| `retryCount` is 2 or more | your answers keep being rejected | stop retrying, `./bin/aflow fail` it with the reason |

---

## The short version

1. `./bin/aflow pending` to see the queue.
2. `./bin/aflow next` to claim one and read it.
3. Think. Match `expect`. JSON means JSON only.
4. `./bin/aflow answer <id> < file` to send it.
5. `./bin/aflow status <runId>` to confirm the run moved on.
6. If you would be guessing, `./bin/aflow fail <id> "<reason>"` instead.
