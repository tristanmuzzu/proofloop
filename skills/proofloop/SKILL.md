---
name: proofloop
description: Verify a deployed change against the LIVE running system by executing real stimuli and auditing real side-effect evidence — not by reading code or trusting the system's own replies. Use after deploying a change ("verify this works live", "prove the fix landed", "run proofloop"), or as the final gate in a build-deploy-verify loop. Requires a verify.yaml in the repo describing how to stimulate the system and where evidence lives.
---

# Proofloop — claim-vs-reality verification for live systems

## The core rule

**A system's own reply is a claim, not evidence.** A bot that answers "done!", an API that returns `{"ok": true}`, a job that logs "completed" — none of these prove anything. Proofloop verifies every claim against independent evidence surfaces: database rows, downstream API state, log lines, files on disk. If the claim and the evidence disagree, the evidence wins and the scenario FAILS.

## Requirements

A `verify.yaml` at the repo root (or path given by the user) declaring:

- `stimuli`: named ways to poke the live system (shell commands; HTTP calls, CLI invocations, message sends — anything executable).
- `evidence`: named ways to observe real state (shell commands whose output is the evidence: SQL queries, HTTP GETs, log greps, file reads).
- `cleanup`: commands that remove entities carrying the test tag, plus a `verify` read to prove the sweep worked.
- `tag`: a string template for marking test entities so they are identifiable and sweepable.

See `verify.example.yaml` in this plugin for the schema. If no `verify.yaml` exists, STOP and offer to scaffold one from the repo's stack — do not improvise stimuli against a live system.

### Execution contract (binding for every `run:` command)

- **cwd:** all `run:` commands execute from the directory containing `verify.yaml`. Relative paths in commands resolve from there.
- **run_id:** chosen by the executor at the start of a run. Lowercase `[a-z0-9-]` only, unique per run, and collision-safe: never a prefix of another live run's id (cleanup may match by substring). A good shape: `r<N>-<yyyymmdd>-<4 random chars>`.
- **Placeholder substitution** (`{tag}`, `{run_id}`, `{input}`, `{id}`): literal string replacement into the command template. Substituted values MUST match `[a-zA-Z0-9 _.-]+`; if a value needs any other character, do not shell-escape it into place — rule the scenario un-runnable and report the gap. Templates are shell commands; a permissive substitution is an injection into your own harness.

## Who executes

Run the whole loop in a **fresh-context agent** — one that did not build the change. This plugin ships `proofloop-verifier` for exactly that; when it is available, spawning it is the default, not an option. When it isn't (plugin not installed as a plugin, or no agent support), the loop may run inline ONLY if the executor did not implement the change being verified; a builder judging its own deploy is self-critique, which this tool exists to replace.

## The runner (default execution path)

The mechanical half of the loop — substitution, liveness, baseline reads, stimulus, settle-polling, evidence capture, contains/absent checks, cleanup + verified sweep — is owned by `bin/proofloop-runner.mjs` (zero-dependency, Node 18+). You write a **scenario JSON** (see `examples/todo-api/scenario-create-persists.json`):

```json
{
  "claim": "...",
  "stimulus": {"name": "<declared stimulus>", "inputs": {"input": "..."}},
  "settle": {"evidence": "<cheapest source>", "expect": "{tag}"},
  "expect": [{"evidence": "<source>", "contains": "<distinctive marker>"}],
  "absent": [{"evidence": "<source>", "contains": "<must-not-appear marker>"}]
}
```

then run:

```
node <plugin>/bin/proofloop-runner.mjs run --config verify.yaml --scenario scenario.json
```

It writes verbatim evidence files plus `record.json` into `.proofloop/runs/<run_id>/` and prints a summary of **mechanical facts only** — it never judges. It also aborts before any mutation if the tag already appears in a baseline read (debris/collision protection). You judge from `record.json` and the raw evidence files. Two judging notes the runner's design forces on you:

- A `found: true` is not a PASS: read the `matching_lines` — a weak needle can substring-match a failure message (e.g. `"persisted"` matching `"nothing persisted"`). Choose distinctive markers; quote the lines in your verdict.
- `settled: false` plus empty expects is the classic reply-lied signature; the burned settle budget is documented in the record.

When Node is unavailable, fall back to executing steps 3–5 below manually under the same contract.

## The loop

### 1. Scope — what changed, what is claimed
Read the change (diff, PR description, or the user's stated intent) and write down the **claims**: the observable behaviors that should now be true. One claim = one sentence with an observable outcome. "The retry endpoint re-queues failed jobs" — good. "The code is cleaner" — not a claim proofloop can verify.

### 2. Generate the SMALLEST sufficient scenario set
Derive scenarios from the claims — typically **1–3, never more than 7**. This is not a test suite; it is a spot-weld check that the deployed system exhibits the changed behavior. Each scenario states:

- **claim** — the sentence from step 1 it verifies
- **stimulus** — which stimulus to fire, with what inputs (inputs MUST carry the test tag wherever the schema allows)
- **expected evidence** — for each relevant evidence surface, what should be observable afterwards
- **expected absences** — when meaningful, what must NOT appear on which surface (an absence is judged by quoting the queried surface and stating the tag/marker is not in it)

Prefer one scenario that exercises the changed path end-to-end over three that poke fragments of it.

### 3. Execute against the live system
For each scenario:

1. **Baseline read.** Before firing anything, read each evidence surface the scenario names. This is what makes "never touch entities you did not create" checkable, and it exposes pre-existing tagged debris from earlier crashed runs.
2. **Fire the stimulus.** Capture its reply verbatim — as the *claim under test*, not as evidence.
3. **Wait for settling.** Poll the scenario's cheapest *evidence source* for the expected marker, bounded by `settle.timeout_seconds`. (`settle.poll` in verify.yaml is a *liveness* probe — use it only to confirm the system is up, never to judge the outcome.) For expected-absence scenarios there is no "settled" signal: the full timeout is the price; say so in the report rather than ending early.
4. **Collect evidence.** Run every evidence source the scenario names and capture raw output verbatim — the judge needs quotes, not summaries.

### 4. Judge — claim vs reality, binary
For each scenario, compare the claim against the collected evidence and rule **PASS or FAIL** — no partial credit. Rules:

- Missing evidence is a FAIL, not a pass ("couldn't check" ≠ "checked out fine").
- The stimulus reply is never sufficient evidence on its own; it belongs in the `reply` field of the verdict, not in `evidence`.
- Every verdict must quote the specific evidence line(s) it rests on, each as `"<source>: <verbatim quote>"`.
- If evidence is ambiguous, rule FAIL and say what observation would have settled it.
- Polluted surfaces: if an evidence surface contains garbage attributable to an unrelated process AND the verdict-relevant lines are unambiguous, you may judge on those lines — but record the pollution in the report. If the pollution makes the relevant lines uncertain, that is ambiguity: FAIL.

### 5. Clean up
Run the cleanup commands for the tag — including when scenarios failed. Then run the `cleanup.verify` read and confirm the sweep: **the tag string must not appear anywhere in the verify command's output.** On systems with real data, prefer a tag-scoped verify query over a full dump. Leftover test data in a live system is itself a finding to report.

### 6. Verdict
Report a structured result:

```json
{
  "allPassed": false,
  "run_id": "r1-20260702-k3xq",
  "tag": "proofloop-r1-20260702-k3xq",
  "scenarios": [
    {
      "claim": "...",
      "stimulus": {"name": "create_todo", "inputs": {"input": "synthetic demo todo"}},
      "reply": "<verbatim stimulus reply - the claim under test>",
      "verdict": "PASS | FAIL",
      "evidence": ["<source>: <verbatim quote>", "..."],
      "reason": "one sentence tying evidence to verdict"
    }
  ],
  "cleanup": "clean | leftovers: <details>",
  "notes": "pollution, timeouts burned on absence checks, invented judgment calls - anything the reader should know"
}
```

`allPassed: true` is the ONLY result that means "verified". A single FAIL means the change is not done — report it plainly; do not soften it to "mostly working".

## Safety rules for live systems

- Tag everything you create; never mutate or delete entities you did not create (the baseline read is your proof).
- Use the least-privileged stimuli available; never invent stimuli not declared in `verify.yaml`, and never edit a declared command beyond placeholder substitution — if a command is broken (wrong path, wrong flags), report it as a config defect instead of quietly fixing it.
- If the target system serves real users, keep scenario count minimal and inputs obviously synthetic.
- If a stimulus could be destructive or irreversible, ask before firing it.
