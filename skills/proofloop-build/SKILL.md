---
name: proofloop-build
description: Autonomous build-verify loop - "build feature X" goes off, builds, deploys, and verifies against the LIVE system over and over until every claim passes or the loop is genuinely blocked. Use when the user asks to build a feature end-to-end with verified completion ("build X and make sure it works", "don't stop until it's proven"). Composes proofloop-scout (claims), the runner (execution), and a fresh-context judge (verdicts) into one loop with hard anti-self-deception rules.
---

# Proofloop Build — build until reality agrees

The loop that turns "build feature X" into "feature X is deployed and proven": claims first, then iterate build → deploy → verify on live evidence until `allPassed: true` or genuinely blocked. The whole point is that **the exit condition is a verdict from reality, not the builder's satisfaction.**

## The loop

### 0. Claims before code
Run `proofloop-scout` on the *intent* (there is no diff yet): derive the target claims — the observable behaviors that will be true when the feature works. Present them in one line each. These claims are the contract for the entire loop; write them down before the first line of implementation. If verify.yaml lacks surfaces for them, propose the additions now (human confirms once, up front — not mid-loop).

### 1. Build the smallest slice that could satisfy the claims
Implement. Keep the diff scoped to the feature.

### 2. Deploy for real
Whatever "deployed" means for this system: restart the process, push the branch, roll the pod. Verification against a stale process proves nothing — confirm the running system carries the change (version endpoint, startup log line, or the liveness probe after restart).

### 3. Scout the actual diff
Re-run scout on the real diff. It usually confirms the Step-0 claims, sometimes adds one you didn't foresee (a log line you added is a new needle; an error path you wrote deserves its own claim). Update scenarios accordingly.

### 4. Run the runner, judge the record
Execute every scenario via the runner. Judge each claim from `record.json` and the raw evidence files — or better, hand judging to a fresh-context agent if one is available. Binary verdicts, evidence quoted.

### 5. Exit or iterate
- **All claims PASS + cleanup clean → done.** Report the verdicts with evidence, then stop.
- **Any FAIL → iterate.** The verdict's evidence quotes ARE the bug report: feed them into the next build step (step 1) verbatim. Go around again.

## Hard rules (anti-self-deception)

1. **Never weaken a claim to make it pass.** Editing a claim, an expected marker, or a scenario so a failing behavior counts as success is the one forbidden move. If a claim was genuinely wrong (misunderstood requirement), say so explicitly, get the human's confirmation, and record the change — that is a scope decision, not a verification decision.
2. **Iteration cap: 5.** Past it, stop and report honestly: what passes, what still fails, with the evidence.
3. **No-progress detection: 2.** If the same scenario fails with materially identical evidence twice in a row, the loop is not converging — the diagnosis is wrong, not the effort. Stop, report the repeated evidence, and either re-derive from first principles or hand back to the human. Iterating on an unchanged hypothesis is how loops burn budgets.
4. **Deploy check every round.** A surprising FAIL after a "fix" is very often a stale deploy. Confirm the change is live before believing the evidence contradicts your code.
5. **Regression floor.** Claims that passed in an earlier iteration re-run in every later one. A fix that breaks a previously-green claim is a FAIL, not a trade.
6. **Cleanup always.** Every iteration sweeps its tags, even mid-loop failures. N iterations must not leave N piles of debris.
7. **Report faithfully at every exit.** "4 of 5 claims pass, the fifth fails with <evidence>" is a good, honest terminal state. "Mostly done" is not.

## Blocked is an answer

Genuinely blocked means: a claim needs a surface that doesn't exist (report as unverifiable-as-deployed), a stimulus requires credentials/confirmation the human hasn't given, or no-progress triggered twice on re-derived diagnoses. Say which, hand over the run records, stop. An honest blocked report after 3 iterations beats a fabricated success after 5 — the gym's log-liar exists precisely because "the log said done" isn't done.
