---
name: proofloop
description: Verify a deployed change against the live system using a frozen pre-build proof contract, real stimuli, independent evidence, strict PASS/FAIL reports, and verified cleanup. Use after deployment or as the final gate in a build-deploy-verify loop.
---

# Proofloop

## Core rule

A system reply is a claim, not evidence. Evidence comes from independently observable state: database rows, read APIs, execution logs, downstream systems, files, or browser output. If claim and evidence disagree, evidence wins.

## Required inputs

- `proofloop.contract.json`: the change-specific intent, implementation paths, and exactly 2-3 frozen scenarios.
- `verify.yaml`: reusable stimuli, evidence sources, settle policy, tag convention, and cleanup.
- `.proofloop/state.json`: created by the contract CLI before implementation begins.

Each scenario must have a happy/alternate/preservation/security kind, an explicit stimulus, and both:

- at least one positive `expect` check;
- at least one negative `absent` check.

Every check names its evidence source, distinctive marker, oracle, and stable ID.

## Pre-build freeze

Run before implementation paths change:

```bash
node <plugin>/bin/proofloop-contract.mjs validate-contract --contract proofloop.contract.json --worktree .
node <plugin>/bin/proofloop-contract.mjs init --contract proofloop.contract.json --worktree . --state .proofloop/state.json --base-ref HEAD
```

Initialization refuses existing changes within `implementationPaths`. It stores the contract plus a SHA-256 digest of the canonical contract and `verify.yaml`. After this point, changing either requires a new explicit contract; do not silently update scenarios after seeing the implementation.

## Workflow state

The legal path is:

```text
planned -> local_green -> deployed -> verifying -> passed
                                  ^        |
                                  |________|
```

A failed attempt returns from `verifying` to `local_green`, then redeploys and verifies under a fresh run ID. `blocked` is terminal and needs a concrete external reason.

Transitions:

```bash
node <plugin>/bin/proofloop-contract.mjs transition --state .proofloop/state.json --phase local_green
node <plugin>/bin/proofloop-contract.mjs transition --state .proofloop/state.json --phase deployed --deployed-ref <exact-revision>
node <plugin>/bin/proofloop-contract.mjs transition --state .proofloop/state.json --phase verifying --run-id <fresh-run-id>
```

## Execution

Run every scenario from the frozen contract:

```bash
node <plugin>/bin/proofloop-runner.mjs run --state .proofloop/state.json --scenario-id <scenario-id>
```

The runner owns baseline collision checks, safe placeholder substitution, liveness, stimulus execution, evidence polling/capture, mechanical contains/absent checks, and cleanup. It writes isolated raw artifacts under `.proofloop/runs/<run_id>/<scenario_id>/` and never issues the verdict. Contract-mode configs may use `{scenario_id}` when an evidence command needs to choose its artifact path.

The original standalone mode remains supported for ad-hoc checks:

```bash
node <plugin>/bin/proofloop-runner.mjs run --config verify.yaml --scenario scenario.json
```

## Fresh-context judgment

A verifier that did not build the change reads `record.json` and raw evidence. It must:

- execute and report every frozen scenario exactly once and in contract order;
- preserve each frozen claim and stimulus verbatim;
- include the system reply verbatim, separately from evidence;
- assign PASS or FAIL per scenario;
- report every required check by ID with a status and concrete evidence;
- mark cleanup `clean` only after the verify sweep proves no leftovers.

Missing, unreachable, or ambiguous evidence fails its scenario. A weak substring match is not sufficient: inspect and cite the actual matching lines.

Validate the complete JSON report:

```bash
node <plugin>/bin/proofloop-contract.mjs validate-report --state .proofloop/state.json --report .proofloop/report.json
node <plugin>/bin/proofloop-contract.mjs transition --state .proofloop/state.json --phase passed --report .proofloop/report.json
```

`allPassed: true` is accepted only when every scenario is PASS, every required observation is `pass`, cleanup is `clean`, the deployed revision matches state, and the run ID is the fresh current attempt.

## Live-system safety

- Tag every entity and baseline-read each used surface before mutation.
- Use only declared stimuli; never improvise live commands.
- Placeholder values must match `[A-Za-z0-9 _.-]+`.
- Always run cleanup, including after failures.
- Require explicit human approval for destructive or irreversible stimuli.
- Never expose credentials in contracts, reports, or proposals; reference environment variables.
