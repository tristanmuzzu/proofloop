---
name: proofloop-build
description: Build, deploy, and repair a feature until a frozen pre-build proof contract passes against the live system or a concrete external blocker prevents progress. Composes proofloop-scout, the contract CLI, runner, and fresh-context verifier.
---

# Proofloop Build

The exit condition is a validated verdict from deployed reality, not the builder's satisfaction.

## Loop

### 0. Freeze proof before code

Run `proofloop-scout` on the intent and repository. Produce exactly 2-3 distinct scenarios: one happy path plus the smallest useful alternate, preservation, or security path. Every scenario needs positive and negative observations.

Get any live-stimulus approval now. Validate and initialize `proofloop.contract.json` before changing an implementation path. The contract and `verify.yaml` are now immutable for this scope.

### 1. Build and check locally

Implement the smallest coherent slice. Run relevant tests. Move state to `local_green` only with actual passing evidence.

### 2. Deploy the exact revision

Deploy through the repository's normal path and record the exact running revision. A local commit, queued deployment, or stale process is not deployed proof.

### 3. Verify the frozen scenarios

Start `verifying` with a fresh run ID. Execute every scenario from workflow state. A fresh-context verifier judges the raw records and produces the strict report.

### 4. Accept or repair

- Validated `allPassed: true` plus clean cleanup: transition to `passed` and report the evidence.
- Any failure: return to `local_green`, diagnose from the evidence, repair, redeploy, and verify every scenario under another fresh run ID.
- Concrete external dependency or missing authority: transition to `blocked` with the exact reason and preserve the records.

## Anti-self-deception rules

1. Never weaken or rewrite the frozen contract because implementation failed it. A genuine requirement correction creates a new explicit contract with human acknowledgement.
2. Never add scenarios after inspecting the diff. Scout may audit coverage and report a scope gap, but the current contract stays frozen.
3. There is no arbitrary iteration cap. Continue while safe in-scope progress exists.
4. Repeated identical evidence is a signal to re-derive the diagnosis from first principles, inspect deployment identity, and test the current hypothesis. It is not permission to stop or call success.
5. Confirm the exact deploy every round.
6. Re-run every frozen scenario every round, including previously green ones.
7. Sweep and verify tagged cleanup every round.
8. Report the actual terminal state: passed or concretely blocked. Never translate partial success into done.
