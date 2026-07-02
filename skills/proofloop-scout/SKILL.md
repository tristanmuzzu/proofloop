---
name: proofloop-scout
description: Derive WHAT to verify from a deployed change — read the diff, produce testable claims, discover how to stimulate the system and where evidence lives, and propose verify.yaml entries and scenario files for the proofloop runner. Use before a proofloop run when claims are unstated ("scout this change", "figure out what to verify"), when verify.yaml is missing or doesn't cover the changed surface, or as the first half of a deploy-verify pipeline. Read-only: scout NEVER fires stimuli — it proposes, the human confirms, the runner executes.
---

# Proofloop Scout — from diff to verifiable claims

Scout answers the question the runner can't: **what should we even test?** Input: a change (git diff, PR, or stated intent) plus the repo. Output: claims, proposed `verify.yaml` additions, and scenario JSONs — never an executed stimulus. Scout is read-only by contract; the human confirms the config before anything touches a live system.

## Step 1 — Read the change, classify every hunk

Get the real diff (`git diff <base>...<head>`, the PR, or `git diff HEAD` for undeployed work — but remember proofloop verifies *deployed* behavior; flag it if the diff isn't live yet). Classify each hunk by shape; the shape dictates the claim template:

| Change shape | Claim template |
|---|---|
| New endpoint/command/handler | "Calling <it> with <valid input> produces <its observable effect>" + one claim for its documented failure mode |
| New field in a write path | "Reads now expose <field> for newly created entities" |
| Changed conditional/branch | One claim per observable branch: "given <condition>, the system now <new behavior>" |
| Bug fix | The bug report inverted: "the reported reproduction now yields <correct behavior>" |
| New background job/schedule | "Within <period>, <the job's side effect> is observable at <surface>" |
| Removed/deprecated behavior | An absence claim: "<old behavior> no longer occurs" (expect nothing; budget the full settle timeout) |
| Config/env change | "The system behaves per <new value>" — name the observable that differs between old and new values |
| Pure refactor (claimed) | A preservation claim on the highest-traffic adjacent behavior: "<existing behavior> is unchanged" |

Rules: every claim is one sentence with an observable outcome; discard claims with no reachable evidence surface (report them as **unverifiable-as-deployed** instead of silently dropping); prefer the one claim that exercises the changed path end-to-end.

## Step 2 — Discover surfaces (stimuli and evidence)

Work from the repo, not from guesses:

- **Stimuli**: how does the world reach the changed code? Route registrations (grep the framework's router idiom near the changed handler), CLI entry points (`bin` in package.json / console_scripts), message handlers (bot command tables, queue consumers), schedules (cron/scheduler registrations). The stimulus must be *user-grade* — the same door a real caller uses, not an internal function call.
- **Evidence**: where does the effect become observable? Read endpoints over the same data; the database tables the diff touches (migration files and ORM models name them); **log lines ADDED in the diff are gift-wrapped evidence needles** — a new `log("order %s refunded")` is exactly the distinctive marker a scenario should expect; downstream API state; files written.
- **Needle discipline**: propose distinctive markers, never generic substrings — `"persisted #"` not `"persisted"` (a real run watched `"persisted"` match `"nothing persisted"` on a failing system). Prefer markers that include the `{tag}`.
- **Tag path**: identify where the tag can ride along (a title, a comment field, a metadata column). If NO input of the changed path can carry a tag, say so — that scenario needs a dedicated cleanup query and extra care, and the human must sign off on it explicitly.

## Step 3 — Gap analysis against verify.yaml

Diff your discovered surfaces against the existing `verify.yaml` (if none exists, you are proposing the whole file):

- Reuse declared stimuli/evidence wherever they cover the surface — do not propose duplicates.
- For each gap, propose the exact YAML addition, as a snippet the human can paste, honoring the execution contract (commands run from the verify.yaml directory; placeholders limited to `{tag}/{run_id}/{input}/{id}`).
- Mark every proposed stimulus with its blast radius: `read-only` / `creates-tagged-data` / `mutates-existing` / `destructive`. Anything beyond `creates-tagged-data` requires the human to opt in per-stimulus.
- Propose the cleanup entry and its `verify:` read in the same breath as any stimulus that creates data — a stimulus without a sweep is not a complete proposal.

## Step 4 — Emit scenarios and stop

For each claim (smallest sufficient set, 1–3, max 7): write the scenario JSON (`claim` / `stimulus` / `settle` / `expect` / `absent`) referencing only stimuli and evidence that exist in verify.yaml *after* the human accepts your Step-3 proposals. Choose the cheapest evidence source for `settle`.

Then **stop and hand over**. The output contract:

1. **Claims** — numbered, one line each, with any judged unverifiable-as-deployed listed separately with reasons.
2. **Proposed verify.yaml additions** — paste-ready snippet, each stimulus labeled with blast radius.
3. **Scenario files** — written to disk next to verify.yaml, named `scenario-<slug>.json`.
4. **Open questions** — anything you'd be guessing on (auth tokens, environment URLs, which log file production actually writes).

Scout never runs the runner. The human reviews, accepts or edits the config, and then the loop proceeds: runner executes, fresh-context judge rules.

## Safety rules

- Read-only: no stimulus, no cleanup, no "just checking" curl against the live system. Discovery happens in the repo.
- Never echo secrets found during discovery (tokens in env files, connection strings) into proposals — reference them as `$ENV_VAR`.
- If the diff touches auth, permissions, or data isolation, say so explicitly and propose at least one *negative* claim ("user A cannot read B's rows") — those are the changes where verification matters most.
