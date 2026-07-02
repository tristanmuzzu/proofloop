# proofloop

**Your agent says "done". Proofloop checks whether reality agrees.**

A [Claude Code](https://claude.com/claude-code) plugin that verifies deployed changes against the **live running system** — by firing real stimuli, auditing independent evidence surfaces, and issuing binary PASS/FAIL verdicts per claim.

## Why this exists

Every eval framework, test suite, and "verification loop" out there checks your code *before* it runs, or checks *the text of the system's reply*. Neither catches the failure class that actually burns you in production:

> The bot replies **"done!"** — and never fired the tool.
> The API returns **`{"ok": true}`** — and persisted nothing.
> The job logs **"completed"** — and silently dropped half the batch.

**A system's own reply is a claim, not evidence.** Proofloop treats it that way. Evidence is a database row, a downstream API's state, a log line from the actual execution path — something the system cannot fake by phrasing. If claim and evidence disagree, evidence wins, scenario fails.

## How it works

You declare, in one `verify.yaml`, three things about your system:

```yaml
stimuli:    # how to poke it   (HTTP calls, CLI commands, message sends...)
evidence:   # how to observe REAL state  (SQL, API reads, log greps...)
cleanup:    # how to remove tagged test entities
```

Then, after deploying a change:

1. **Scope** — proofloop derives testable *claims* from the diff/intent.
2. **Smallest sufficient scenarios** — 1–3 (max 7). A spot-weld, not a test suite.
3. **Execute** — fire stimuli with tagged, obviously-synthetic inputs.
4. **Judge** — a **fresh-context verifier agent** (it didn't build the change, so it isn't grading its own homework) compares each claim against verbatim evidence quotes. Missing evidence = FAIL, not pass.
5. **Cleanup** — tagged entities swept, sweep verified, leftovers reported.
6. **Verdict** — structured JSON; `allPassed: true` is the only "done".

## Try it in 2 minutes — watch it catch a liar

The demo todo API has a `LIE_MODE`: it returns `201 {"ok": true}` on create **without persisting anything**.

```bash
cd examples/todo-api
LIE_MODE=1 node server.mjs > server.log &
```

Then in Claude Code:

> Use proofloop with examples/todo-api/verify.yaml to verify: "creating a todo through the API persists it".

The stimulus succeeds (the reply says ok!), the `api_state` evidence shows an empty list, and the verdict comes back:

```json
{
  "allPassed": false,
  "scenarios": [{
    "claim": "creating a todo through the API persists it",
    "verdict": "FAIL",
    "evidence": ["stimulus reply: {\"ok\":true,\"id\":1,...}", "api_state: []"],
    "reason": "API claimed success but the todo is absent from the read API."
  }]
}
```

Restart without `LIE_MODE` and the same run passes. That delta — reply unchanged, verdict flipped — is the whole point.

## Install

```
/plugin marketplace add tristanmuzzu/proofloop
/plugin install proofloop@proofloop
```

Then copy `verify.example.yaml` to your repo root as `verify.yaml` and adapt the three vocabularies to your stack (Postgres, REST, message queues, log files — anything you can reach from a shell command).

## Safety by design

- Every test entity carries a run tag; proofloop never touches entities it didn't create.
- Only stimuli declared in `verify.yaml` are ever fired — no improvisation against live systems.
- Destructive/irreversible stimuli require explicit user confirmation.
- Works against real production systems when your evidence surfaces are read-only and your stimuli are user-grade actions — that's the environment it was designed in.

## Origin

Generalized (clean-room) from a private verification harness that gates deploys of a production LLM assistant: every shipped feature is verified by live scenario execution with database/API/log evidence audits before it's called done. The pattern also matches Anthropic's official Claude Fable 5 guidance: *separate, fresh-context verifier subagents outperform self-critique.*

MIT. PRs welcome — adapters, evidence-source recipes, and war stories especially.
