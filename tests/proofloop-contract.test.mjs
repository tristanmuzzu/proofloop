import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertStateFrozen,
  contractBundleDigest,
  createWorkflowState,
  materializeScenario,
  transitionWorkflow,
  validateProofContract,
  validateVerifierReport,
} from "../bin/proofloop-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, "examples", "todo-api", "proofloop.contract.json");
const loadContract = () => JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
const clone = (value) => structuredClone(value);

function tempBundle() {
  const root = mkdtempSync(join(tmpdir(), "proofloop-contract-"));
  const contract = loadContract();
  contract.config = "verify.yaml";
  contract.implementationPaths = ["server.mjs"];
  const contractPath = join(root, "proofloop.contract.json");
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(root, "verify.yaml"), "tag: proofloop-{run_id}\n");
  writeFileSync(join(root, "server.mjs"), "export const version = 1;\n");
  return { root, contract, contractPath };
}

function validReport(contract, digest) {
  return {
    contractId: contract.contractId,
    contractDigest: digest,
    deployedRef: "deploy-abc123",
    run_id: "proof-1",
    status: "ok",
    allPassed: true,
    cleanup: "clean",
    scenarios: contract.scenarios.map((scenario) => ({
      id: scenario.id,
      claim: scenario.claim,
      stimulus: clone(scenario.stimulus),
      verdict: "PASS",
      reply: "verbatim system reply",
      reason: "Every required observation passed.",
      recordPath: `.proofloop/runs/proof-1/${scenario.id}/record.json`,
      observations: scenario.checks.map((check) => ({
        checkId: check.id,
        status: "pass",
        evidence: [`${check.evidence}: ${check.oracle}`],
      })),
    })),
  };
}

test("accepts a complete contract with happy and preservation scenarios", () => {
  const result = validateProofContract(loadContract());
  assert.equal(result.ok, true, result.issues.join("\n"));
  assert.match(contractBundleDigest(loadContract(), ROOT), /^[a-f0-9]{64}$/);
});

test("rejects too few scenarios and a happy-path-only contract", () => {
  const one = loadContract();
  one.scenarios = one.scenarios.slice(0, 1);
  assert.equal(validateProofContract(one).ok, false);

  const allHappy = loadContract();
  allHappy.scenarios[1].kind = "happy_path";
  const result = validateProofContract(allHappy);
  assert.equal(result.ok, false);
  assert(result.issues.some((issue) => issue.includes("alternate, preservation, or security")));
});

test("requires positive and negative observations in every scenario", () => {
  const contract = loadContract();
  contract.scenarios[0].checks = contract.scenarios[0].checks.filter((check) => check.type === "expect");
  const result = validateProofContract(contract);
  assert.equal(result.ok, false);
  assert(result.issues.some((issue) => issue.includes("must include an absent observation")));
});

test("materializes only scenarios named in the frozen contract", () => {
  const contract = loadContract();
  const scenario = materializeScenario(contract, "happy-create");
  assert.equal(scenario.id, "happy-create");
  assert.equal(scenario.expect.length, 2);
  assert.equal(scenario.absent.length, 1);
  assert.throws(() => materializeScenario(contract, "invented-later"), /not in the frozen contract/);
});

test("digest and frozen-state checks detect config or contract drift", () => {
  const { root, contract, contractPath } = tempBundle();
  const state = createWorkflowState(contract, contractPath, root, "baseline", "HEAD");
  assert.doesNotThrow(() => assertStateFrozen(state));

  const firstDigest = state.contractDigest;
  writeFileSync(join(root, "verify.yaml"), "tag: changed-{run_id}\n");
  assert.notEqual(contractBundleDigest(contract, root), firstDigest);
  assert.throws(() => assertStateFrozen(state), /changed after planning/);
});

test("workflow permits fresh repair attempts without an arbitrary cap", () => {
  const { root, contract, contractPath } = tempBundle();
  let state = createWorkflowState(contract, contractPath, root, "baseline", "HEAD");
  state = transitionWorkflow(state, "local_green");
  for (let attempt = 1; attempt <= 7; attempt++) {
    state = transitionWorkflow(state, "deployed", { deployedRef: `deploy-${attempt}` });
    state = transitionWorkflow(state, "verifying", { runId: `proof-${attempt}` });
    if (attempt < 7) state = transitionWorkflow(state, "local_green");
  }
  assert.equal(state.phase, "verifying");
  assert.equal(state.attempts, 7);
  assert.equal(new Set(state.runIds).size, 7);
  assert.throws(() => transitionWorkflow(state, "verifying", { runId: "proof-7" }), /already used/);
});

test("accepts only reports that cover every frozen observation", () => {
  const { root, contract } = tempBundle();
  const digest = contractBundleDigest(contract, root);
  const report = validReport(contract, digest);
  assert.equal(validateVerifierReport(report, contract, digest).ok, true);

  const omitted = clone(report);
  omitted.scenarios.pop();
  assert.equal(validateVerifierReport(omitted, contract, digest).ok, false);

  const falsePass = clone(report);
  falsePass.scenarios[0].observations[0].status = "fail";
  assert.equal(validateVerifierReport(falsePass, contract, digest).ok, false);

  const dishonestSummary = clone(report);
  dishonestSummary.scenarios[0].verdict = "FAIL";
  assert.equal(validateVerifierReport(dishonestSummary, contract, digest).ok, false);

  const overwrittenRecord = clone(report);
  overwrittenRecord.scenarios[1].recordPath = overwrittenRecord.scenarios[0].recordPath;
  const overwrittenResult = validateVerifierReport(overwrittenRecord, contract, digest);
  assert.equal(overwrittenResult.ok, false);
  assert(overwrittenResult.issues.some((issue) => issue.includes("recordPath")));
});
