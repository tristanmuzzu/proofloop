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
- `cleanup`: commands that remove entities carrying the test tag.
- `tag`: a string template for marking test entities (e.g. `proofloop-{run_id}`) so they are identifiable and sweepable.

See `verify.example.yaml` in this plugin for the schema. If no `verify.yaml` exists, STOP and offer to scaffold one from the repo's stack — do not improvise stimuli against a live system.

## The loop

### 1. Scope — what changed, what is claimed
Read the change (diff, PR description, or the user's stated intent) and write down the **claims**: the observable behaviors that should now be true. One claim = one sentence with an observable outcome. "The retry endpoint re-queues failed jobs" — good. "The code is cleaner" — not a claim proofloop can verify.

### 2. Generate the SMALLEST sufficient scenario set
Derive scenarios from the claims — typically **1–3, never more than 7**. This is not a test suite; it is a spot-weld check that the deployed system exhibits the changed behavior. Each scenario states:

- **claim** — the sentence from step 1 it verifies
- **stimulus** — which stimulus to fire, with what inputs (inputs MUST carry the test tag wherever the schema allows)
- **expected evidence** — for each relevant evidence surface, what should be observable afterwards (and, when meaningful, what must NOT appear)

Prefer one scenario that exercises the changed path end-to-end over three that poke fragments of it.

### 3. Execute against the live system
For each scenario: fire the stimulus, wait a bounded time for the system to settle (poll the cheapest evidence source rather than sleeping blind), then collect evidence from EVERY surface the scenario names. Capture raw output verbatim — the judge needs quotes, not summaries.

### 4. Judge — claim vs reality, binary
For each scenario, compare the claim against the collected evidence and rule **PASS or FAIL** — no partial credit. Rules:

- Missing evidence is a FAIL, not a pass ("couldn't check" ≠ "checked out fine").
- The system's own reply text is never sufficient evidence on its own.
- Every verdict must quote the specific evidence line(s) it rests on.
- If evidence is ambiguous, rule FAIL and say what observation would have settled it.

Judging is best done by a **fresh-context verifier** (see the `proofloop-verifier` agent in this plugin): a judge that watched the implementation happen will grade its own homework.

### 5. Clean up
Run the cleanup commands for the tag. Then verify the cleanup: re-query and confirm zero tagged entities remain. Leftover test data in a live system is itself a FAIL to report.

### 6. Verdict
Report a structured result:

```json
{
  "allPassed": false,
  "scenarios": [
    {
      "claim": "...",
      "stimulus": "...",
      "verdict": "PASS | FAIL",
      "evidence": ["<verbatim quotes with their source>"],
      "reason": "one sentence tying evidence to verdict"
    }
  ],
  "cleanup": "clean | leftovers: <details>"
}
```

`allPassed: true` is the ONLY result that means "verified". A single FAIL means the change is not done — report it plainly; do not soften it to "mostly working".

## Safety rules for live systems

- Tag everything you create; never mutate or delete entities you did not create.
- Use the least-privileged stimuli available; never invent stimuli not declared in `verify.yaml`.
- If the target system serves real users, keep scenario count minimal and inputs obviously synthetic.
- If a stimulus could be destructive or irreversible, ask before firing it.
