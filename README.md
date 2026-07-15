# proofloop

**Your agent says "done." Proofloop checks whether reality agrees.**

A [Claude Code](https://claude.com/claude-code) plugin that freezes what must be proven **before implementation**, then verifies the deployed change using real stimuli, independent evidence, and strict PASS/FAIL reports.

## Why this exists

An API can return `{"ok": true}` without persisting anything. A bot can say "done" without firing its tool. A job can log "completed" after dropping half the batch.

**A system's own reply is a claim, not evidence.** Proofloop compares that claim with state the system cannot fake through wording: database rows, downstream API state, execution logs, files, and browser output. When they disagree, evidence wins.

## What changed in v1.1

Proofloop used to describe "claims before code" as an agent rule. v1.1 makes it executable:

- exactly 2-3 distinct scenarios are frozen before implementation;
- every scenario includes a positive observation and a must-not-happen observation;
- the proof contract and `verify.yaml` share an immutable SHA-256 digest;
- workflow state moves through `planned -> local_green -> deployed -> verifying -> passed`;
- every verification attempt requires a fresh run ID and exact deployed revision;
- a report cannot claim `allPassed: true` unless every frozen observation passed and cleanup is clean;
- failed evidence starts another repair attempt without an arbitrary iteration cap.

The runner's original standalone scenario mode remains available for ad-hoc verification.

## The workflow

Proofloop separates four responsibilities:

1. **Scout** reads the intent and repository, discovers real stimuli/evidence surfaces, and proposes the smallest sufficient contract.
2. **Contract CLI** freezes the 2-3 scenarios before implementation and enforces workflow state.
3. **Runner** performs baseline reads, stimulus execution, settling, evidence capture, mechanical checks, and verified cleanup.
4. **Fresh-context verifier** judges the frozen claims from raw records and returns a complete report.

`verify.yaml` defines reusable system access:

```yaml
tag: proofloop-{run_id}

stimuli:
  create_widget:
    run: 'curl -s -X POST localhost:3000/widgets -d "name={tag}"'

evidence:
  widget_state:
    run: 'curl -s localhost:3000/widgets'

cleanup:
  - run: 'curl -s -X DELETE localhost:3000/widgets/by-tag/{tag}'
    verify: 'curl -s localhost:3000/widgets?tag={tag}'
```

`proofloop.contract.json` defines the change-specific claims and observations. See [`proofloop.contract.example.json`](proofloop.contract.example.json) or the runnable [todo demo contract](examples/todo-api/proofloop.contract.json).

## Quick start

Install the plugin:

```text
/plugin marketplace add tristanmuzzu/proofloop
/plugin install proofloop@proofloop
```

Copy and adapt the examples:

```bash
cp verify.example.yaml verify.yaml
cp proofloop.contract.example.json proofloop.contract.json
```

Freeze the contract **before changing its implementation paths**:

```bash
node bin/proofloop-contract.mjs validate-contract \
  --contract proofloop.contract.json --worktree .

node bin/proofloop-contract.mjs init \
  --contract proofloop.contract.json --worktree . \
  --state .proofloop/state.json --base-ref HEAD
```

Record the build and exact deployment:

```bash
node bin/proofloop-contract.mjs transition \
  --state .proofloop/state.json --phase local_green

node bin/proofloop-contract.mjs transition \
  --state .proofloop/state.json --phase deployed \
  --deployed-ref <exact-revision>

node bin/proofloop-contract.mjs transition \
  --state .proofloop/state.json --phase verifying \
  --run-id <fresh-run-id>
```

Run every frozen scenario:

```bash
node bin/proofloop-runner.mjs run \
  --state .proofloop/state.json --scenario-id <frozen-scenario-id>
```

The runner writes each scenario's verbatim artifacts to `.proofloop/runs/<run_id>/<scenario_id>/`. A fresh-context judge reads those records and creates one report covering every scenario and required observation. Then validate and accept it:

```bash
node bin/proofloop-contract.mjs validate-report \
  --state .proofloop/state.json --report .proofloop/report.json

node bin/proofloop-contract.mjs transition \
  --state .proofloop/state.json --phase passed \
  --report .proofloop/report.json
```

The contract CLI rejects changed contracts/config, illegal phase transitions, reused run IDs, omitted scenarios, incomplete evidence, and dishonest success summaries.

## Watch it catch a liar

The demo todo API has deliberate failure modes. In `LIE_MODE`, it returns a successful create reply without storing anything. Proofloop captures the mismatch:

```text
reply:       {"ok":true,"id":1,...}
api_state:   no tagged todo
server_log:  POST /todos LIED ... (nothing persisted)
verdict:     FAIL
```

Restart the same server honestly and the reply can remain byte-for-byte identical while the verdict flips to PASS because independent API state and the persistence log now agree. That is the point: reply unchanged, reality changed, verdict changed.

## Browser evidence

`bin/proofloop-browser.mjs` captures page text and a full-page screenshot using the installed Chrome or Edge. UI evidence can prove presentation claims directly. Persistence claims should pair it with state evidence because a UI can render stale data in either direction.

The demo includes `STALE_UI`: state and API are honest while the page remains frozen at boot. Proofloop sees `api_state: found` plus `ui_state: not found`, and the screenshot shows what the user actually sees.

## Safety properties

- Baseline reads abort before mutation when a run tag already exists.
- Only stimuli declared in `verify.yaml` are executed.
- Placeholder values are limited to `[A-Za-z0-9 _.-]+`.
- Cleanup is tag-scoped and followed by a verification read.
- Destructive or irreversible stimuli require explicit human approval.
- Contract paths are confined to the worktree.
- The reply is stored separately from evidence.
- Missing or ambiguous evidence cannot produce PASS.

## Calibration gym

The liar's gym starts the demo in honest and deliberately deceptive modes: reply-liar, log-liar, partial-persist, and stale-UI. It asserts the exact evidence signature expected from each:

```bash
npm test
npm run gym
```

Any Proofloop change should leave both the contract tests and gym clean.

## Architecture

- `bin/proofloop-contract.mjs` owns proof policy: contract schema, digest, workflow transitions, and report validation.
- `bin/proofloop-runner.mjs` is mechanical: execute declared operations and record facts; never judge.
- `skills/proofloop-scout` discovers surfaces and drafts contracts without touching live systems.
- `agents/proofloop-verifier.md` defines the stateless evidence judge.
- `gym/run-gym.mjs` guards against verifier regressions.

The public project is generic and contains no private deployment adapters, customer data, credentials, or environment coordinates.

## Origin

Generalized from a private live-verification harness used to gate production changes. The transferable idea is simple: decide what evidence will prove the change before building it, then let a fresh judge compare the deployed system with that frozen contract.

MIT. Contributions are welcome, especially evidence adapters, new liar-gym residents, and real-world verification writeups.
