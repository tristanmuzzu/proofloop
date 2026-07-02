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
cleanup:    # how to remove tagged test entities, + a verify read
```

Then, after deploying a change, a **fresh-context verifier agent** (it didn't build the change, so it isn't grading its own homework) runs the loop:

1. **Scope** — derive testable *claims* from the diff/intent.
2. **Smallest sufficient scenarios** — 1–3 (max 7). A spot-weld, not a test suite.
3. **Baseline-read, stimulate, settle, collect** — tagged synthetic inputs; evidence captured verbatim from every declared surface.
4. **Judge** — binary PASS/FAIL per claim. Missing evidence = FAIL, not pass. The stimulus reply lives in a `reply` field — never in `evidence`.
5. **Cleanup** — tagged entities swept, sweep verified, leftovers reported.
6. **Verdict** — structured JSON; `allPassed: true` is the only "done".

## Watch it catch a liar (verdicts below are captured from a real run)

The demo todo API has a `LIE_MODE`: it returns `201 {"ok": true}` on create **without persisting anything**.

```bash
cd examples/todo-api
LIE_MODE=1 node server.mjs > server.log 2>&1 &
echo $! > server.pid            # stop later with: kill $(cat server.pid)
```

Then in Claude Code:

> Use proofloop with examples/todo-api/verify.yaml to verify: "creating a todo through the API persists it".

Captured verdict (run 1, LIE_MODE on):

```json
{
  "allPassed": false,
  "scenarios": [{
    "claim": "creating a todo through the API persists it",
    "stimulus": {"name": "create_todo", "inputs": {"input": "synthetic demo todo"}},
    "reply": "{\"ok\":true,\"id\":1,\"title\":\"synthetic demo todo [proofloop-r1-20260702]\"}",
    "verdict": "FAIL",
    "evidence": [
      "api_state: []",
      "server_log: [2026-07-02T14:56:18.778Z] POST /todos LIED ok for \"synthetic demo todo [proofloop-r1-20260702]\" (nothing persisted)"
    ],
    "reason": "The API replied 201 ok but the tagged todo never appeared in the read API within the settle budget, and the server log records nothing was persisted."
  }],
  "cleanup": "clean"
}
```

Restarted without `LIE_MODE`, same prompt, run 2: the stimulus reply was **byte-for-byte identical** — and the verdict flipped to `PASS` on the evidence (`api_state` shows the tagged todo, `server_log` shows the persist). That delta — reply unchanged, verdict flipped — is the whole point.

## Install

```
/plugin marketplace add tristanmuzzu/proofloop
/plugin install proofloop@proofloop
```

Then copy `verify.example.yaml` to your repo root as `verify.yaml` and adapt the three vocabularies to your stack (Postgres, REST, message queues, log files — anything you can reach from a shell command). The execution contract (cwd, run_id rules, placeholder escaping) is documented in the skill and the example file.

## Safety by design

- Every test entity carries a run tag; a baseline read before each stimulus makes "never touch entities you didn't create" checkable, not aspirational.
- Only stimuli declared in `verify.yaml` are ever fired, and declared commands are never edited beyond placeholder substitution — a broken command is reported as a config defect, not quietly fixed.
- Placeholder values are restricted to `[a-zA-Z0-9 _.-]+` — no shell-escaping games against your own harness.
- Destructive/irreversible stimuli require explicit user confirmation.
- Works against real production systems when your evidence surfaces are read-only and your stimuli are user-grade actions — that's the environment the pattern was developed in.

## Status and roadmap

v0.3. The mechanical half is now owned by a **zero-dependency runner CLI** (`bin/proofloop-runner.mjs`): charset-enforced substitution, liveness probe, baseline reads with debris/collision abort, stimulus execution, outcome-polling against evidence (not blind sleeps), verbatim evidence capture, mechanical contains/absent checks with quoted matching lines, and cleanup with a verified sweep — all recorded to `.proofloop/runs/<run_id>/record.json`. The model writes the scenario and judges the record; code does everything models fumble. The runner never judges — by design.

Both the runner and the earlier prompt-orchestrated loop have been dogfooded end-to-end against the demo in both modes (the verdicts above are captured, not typed). The runner's first live run immediately demonstrated why judges must read `matching_lines` rather than trust `found` booleans: the needle `"persisted"` substring-matched the liar's own `"(nothing persisted)"` log line.

Roadmap: browser/vision evidence surfaces via Playwright (catch honest-API-but-stale-UI), a scout mode that derives claims and proposes verify.yaml entries from the deployed diff, and a "liar's gym" — a regression suite of deliberately deceptive demo servers that every proofloop change must still catch. Adapter recipes for common stacks (Postgres, Telegram bots, queues) are the other obvious contribution surface.

## Origin

Generalized (clean-room) from a private verification harness that gates deploys of a production LLM assistant: every shipped feature is verified by live scenario execution with database/API/log evidence audits before it's called done. The pattern also matches Anthropic's official Claude Fable 5 guidance: *separate, fresh-context verifier subagents outperform self-critique.*

MIT. PRs welcome — adapters, evidence-source recipes, and war stories especially.
