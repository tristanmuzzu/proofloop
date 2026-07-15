#!/usr/bin/env node
// Frozen pre-build proof contracts for proofloop.
//
// Owns four policies that prose cannot enforce reliably:
//   1. exactly 2-3 distinct scenarios are chosen before implementation;
//   2. the contract and verify.yaml are frozen behind a SHA-256 digest;
//   3. build/deploy/verify moves through an explicit state machine;
//   4. allPassed is accepted only when every required observation passed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO_KINDS = new Set(["happy_path", "alternate_path", "preservation", "security"]);
const CHECK_TYPES = new Set(["expect", "absent"]);
const PHASES = new Set(["planned", "local_green", "deployed", "verifying", "passed", "blocked"]);
const TRANSITIONS = {
  planned: ["local_green", "blocked"],
  local_green: ["deployed", "blocked"],
  deployed: ["verifying", "blocked"],
  verifying: ["local_green", "verifying", "passed", "blocked"],
  passed: [],
  blocked: [],
};
const RUN_ID_RE = /^[a-z0-9-]+$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9 _.-]+$/;
const PLACEHOLDER_MARKERS = [
  "replace_me",
  "replace-with-",
  "describe the observable",
  "name adjacent behavior",
  "command or endpoint",
];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const texts = (value) => Array.isArray(value) && value.every(isText);

function strictKeys(value, allowed, path, issues) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported`);
  }
  return true;
}

function requireText(value, path, issues) {
  if (!isText(value)) issues.push(`${path} must be a non-empty string`);
}

function requireTexts(value, path, issues, { nonEmpty = false } = {}) {
  if (!texts(value)) {
    issues.push(`${path} must be an array of non-empty strings`);
    return;
  }
  if (nonEmpty && value.length === 0) issues.push(`${path} must not be empty`);
}

function safeRelativePath(value, path, issues) {
  requireText(value, path, issues);
  if (!isText(value)) return;
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(value) || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    issues.push(`${path} must be a specific path inside the worktree`);
  }
}

function validateStimulus(value, path, issues) {
  if (!strictKeys(value, ["name", "inputs"], path, issues)) return;
  requireText(value.name, `${path}.name`, issues);
  if (!isRecord(value.inputs)) {
    issues.push(`${path}.inputs must be an object`);
    return;
  }
  for (const [key, input] of Object.entries(value.inputs)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) issues.push(`${path}.inputs.${key} has an invalid name`);
    if (!["string", "number"].includes(typeof input) || !SAFE_VALUE_RE.test(String(input))) {
      issues.push(`${path}.inputs.${key} must fit [A-Za-z0-9 _.-]+`);
    }
  }
}

function validateSettle(value, path, issues) {
  if (value === null || value === undefined) return;
  if (!strictKeys(value, ["evidence", "expect"], path, issues)) return;
  requireText(value.evidence, `${path}.evidence`, issues);
  requireText(value.expect, `${path}.expect`, issues);
}

function validateCheck(value, path, issues, checkIds) {
  if (!strictKeys(value, ["id", "type", "evidence", "contains", "oracle", "required"], path, issues)) return;
  requireText(value.id, `${path}.id`, issues);
  if (isText(value.id)) {
    if (!/^[a-z0-9-]+$/.test(value.id)) issues.push(`${path}.id must match [a-z0-9-]+`);
    if (checkIds.has(value.id)) issues.push(`check id ${value.id} is duplicated`);
    checkIds.add(value.id);
  }
  if (!CHECK_TYPES.has(value.type)) issues.push(`${path}.type must be expect or absent`);
  requireText(value.evidence, `${path}.evidence`, issues);
  requireText(value.contains, `${path}.contains`, issues);
  requireText(value.oracle, `${path}.oracle`, issues);
  if (value.required !== true) issues.push(`${path}.required must be true`);
}

function validateScenario(value, index, issues, scenarioIds, claims, checkIds) {
  const path = `scenarios[${index}]`;
  if (!strictKeys(
    value,
    ["id", "kind", "description", "surface", "claim", "preconditions", "stimulus", "settle", "checks"],
    path,
    issues,
  )) return;
  for (const field of ["id", "description", "surface", "claim"]) {
    requireText(value[field], `${path}.${field}`, issues);
  }
  if (isText(value.id)) {
    if (!/^[a-z0-9-]+$/.test(value.id)) issues.push(`${path}.id must match [a-z0-9-]+`);
    if (scenarioIds.has(value.id)) issues.push(`scenario id ${value.id} is duplicated`);
    scenarioIds.add(value.id);
  }
  if (isText(value.claim)) {
    const claim = value.claim.trim().toLocaleLowerCase("en");
    if (claims.has(claim)) issues.push(`scenario claim ${value.claim} is duplicated`);
    claims.add(claim);
  }
  if (!SCENARIO_KINDS.has(value.kind)) issues.push(`${path}.kind is not supported`);
  requireTexts(value.preconditions, `${path}.preconditions`, issues);
  validateStimulus(value.stimulus, `${path}.stimulus`, issues);
  validateSettle(value.settle, `${path}.settle`, issues);
  if (!Array.isArray(value.checks) || value.checks.length < 2) {
    issues.push(`${path}.checks must contain positive and negative observations`);
    return;
  }
  value.checks.forEach((check, checkIndex) =>
    validateCheck(check, `${path}.checks[${checkIndex}]`, issues, checkIds));
  if (!value.checks.some((check) => check?.type === "expect")) {
    issues.push(`${path}.checks must include an expect observation`);
  }
  if (!value.checks.some((check) => check?.type === "absent")) {
    issues.push(`${path}.checks must include an absent observation`);
  }
}

export function validateProofContract(input) {
  const issues = [];
  if (!strictKeys(
    input,
    [
      "schemaVersion", "contractId", "createdAt", "createdBeforeImplementation",
      "changeIntent", "config", "implementationPaths", "declaredSurface",
      "preservedBehavior", "scenarios",
    ],
    "contract",
    issues,
  )) return { ok: false, issues };
  if (input.schemaVersion !== "1.0") issues.push('schemaVersion must be "1.0"');
  if (!isText(input.contractId) || !/^PROOFLOOP_VERIFY_[A-Z0-9_-]+$/.test(input.contractId)) {
    issues.push("contractId must match PROOFLOOP_VERIFY_[A-Z0-9_-]+");
  }
  if (!isText(input.createdAt) || Number.isNaN(Date.parse(input.createdAt))) {
    issues.push("createdAt must be an ISO-8601 timestamp");
  }
  if (input.createdBeforeImplementation !== true) {
    issues.push("createdBeforeImplementation must be true");
  }
  requireText(input.changeIntent, "changeIntent", issues);
  safeRelativePath(input.config, "config", issues);
  requireTexts(input.implementationPaths, "implementationPaths", issues, { nonEmpty: true });
  if (Array.isArray(input.implementationPaths)) {
    input.implementationPaths.forEach((item, index) => safeRelativePath(item, `implementationPaths[${index}]`, issues));
  }
  requireTexts(input.declaredSurface, "declaredSurface", issues, { nonEmpty: true });
  requireTexts(input.preservedBehavior, "preservedBehavior", issues, { nonEmpty: true });

  const serialized = JSON.stringify(input).toLocaleLowerCase("en");
  for (const marker of PLACEHOLDER_MARKERS) {
    if (serialized.includes(marker)) issues.push(`contract still contains template placeholder: ${marker}`);
  }

  if (!Array.isArray(input.scenarios) || input.scenarios.length < 2 || input.scenarios.length > 3) {
    issues.push("scenarios must contain exactly 2 or 3 precommitted scenarios");
  } else {
    const scenarioIds = new Set();
    const claims = new Set();
    const checkIds = new Set();
    input.scenarios.forEach((scenario, index) =>
      validateScenario(scenario, index, issues, scenarioIds, claims, checkIds));
    if (!input.scenarios.some((scenario) => scenario?.kind === "happy_path")) {
      issues.push("scenarios must include one happy_path");
    }
    if (!input.scenarios.some((scenario) => scenario?.kind !== "happy_path")) {
      issues.push("scenarios must include an alternate, preservation, or security path");
    }
  }
  return issues.length === 0 ? { ok: true, issues, value: input } : { ok: false, issues };
}

export function assertProofContract(input) {
  const result = validateProofContract(input);
  if (!result.ok) throw new Error(`Invalid proof contract:\n- ${result.issues.join("\n- ")}`);
  return result.value;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]),
  );
}

export const canonicalJson = (value) => JSON.stringify(normalize(value));

export function resolveInside(worktree, path, label = "path") {
  const root = resolve(worktree);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes the worktree`);
  return target;
}

export function contractBundleDigest(contract, worktree) {
  const valid = assertProofContract(contract);
  const configPath = resolveInside(worktree, valid.config, "config");
  if (!existsSync(configPath)) throw new Error(`verify config not found: ${configPath}`);
  return createHash("sha256")
    .update(canonicalJson(valid))
    .update("\n")
    .update(readFileSync(configPath, "utf8"))
    .digest("hex");
}

function gitLines(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function matchesImplementationPath(path, prefixes) {
  return prefixes.some((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/\/$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

export function implementationChanges(worktree, baseRef, implementationPaths) {
  const paths = new Set([
    ...gitLines(worktree, ["diff", "--name-only", "HEAD", "--"]),
    ...gitLines(worktree, ["diff", "--name-only", `${baseRef}...HEAD`, "--"]),
    ...gitLines(worktree, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...paths].filter((path) => matchesImplementationPath(path, implementationPaths));
}

export function createWorkflowState(contract, contractPath, worktree, baselineRef, baseRef) {
  return {
    schemaVersion: "1.0",
    contract: structuredClone(contract),
    contractPath: resolve(contractPath),
    contractDigest: contractBundleDigest(contract, worktree),
    worktree: resolve(worktree),
    baselineRef,
    baseRef,
    phase: "planned",
    attempts: 0,
    runIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadWorkflowState(path) {
  const state = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!isRecord(state) || state.schemaVersion !== "1.0" || !PHASES.has(state.phase)) {
    throw new Error("Invalid proofloop workflow state");
  }
  return state;
}

export function assertStateFrozen(state) {
  const currentContract = assertProofContract(JSON.parse(readFileSync(state.contractPath, "utf8")));
  if (canonicalJson(currentContract) !== canonicalJson(state.contract)) {
    throw new Error("Proof contract changed after planning; create a new explicit contract instead");
  }
  const currentDigest = contractBundleDigest(currentContract, state.worktree);
  if (currentDigest !== state.contractDigest) {
    throw new Error("Proof contract or verify config changed after planning; create a new explicit contract instead");
  }
  return state;
}

export function transitionWorkflow(state, next, options = {}) {
  assertStateFrozen(state);
  if (!PHASES.has(next) || !TRANSITIONS[state.phase].includes(next)) {
    throw new Error(`Invalid proofloop workflow transition: ${state.phase} -> ${next}`);
  }
  const deployedRef = options.deployedRef ?? state.deployedRef;
  if (["deployed", "verifying", "passed"].includes(next) && !isText(deployedRef)) {
    throw new Error(`${next} requires the exact deployedRef`);
  }
  if (next === "verifying") {
    if (!isText(options.runId) || !RUN_ID_RE.test(options.runId)) {
      throw new Error("verifying requires a fresh lowercase [a-z0-9-]+ runId");
    }
    if (state.runIds.includes(options.runId)) throw new Error(`runId was already used: ${options.runId}`);
  }
  if (next === "passed" && !isText(options.reportPath)) {
    throw new Error("passed requires a validated reportPath");
  }
  if (next === "blocked" && !isText(options.blockedReason)) {
    throw new Error("blocked requires a concrete blockedReason");
  }
  return {
    ...state,
    phase: next,
    attempts: next === "verifying" ? state.attempts + 1 : state.attempts,
    runIds: next === "verifying" ? [...state.runIds, options.runId] : state.runIds,
    deployedRef,
    latestReportPath: options.reportPath ?? state.latestReportPath,
    blockedReason: next === "blocked" ? options.blockedReason : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function materializeScenario(contract, scenarioId) {
  const scenario = contract.scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new Error(`Scenario '${scenarioId}' is not in the frozen contract`);
  return {
    id: scenario.id,
    kind: scenario.kind,
    description: scenario.description,
    claim: scenario.claim,
    stimulus: structuredClone(scenario.stimulus),
    settle: structuredClone(scenario.settle),
    expect: scenario.checks
      .filter((check) => check.type === "expect")
      .map(({ type: _type, ...check }) => structuredClone(check)),
    absent: scenario.checks
      .filter((check) => check.type === "absent")
      .map(({ type: _type, ...check }) => structuredClone(check)),
  };
}

function validateObservation(input, check, scenarioId, issues) {
  if (!isRecord(input)) {
    issues.push(`scenario ${scenarioId} observation ${check.id} must be an object`);
    return;
  }
  if (input.checkId !== check.id) issues.push(`scenario ${scenarioId} is missing observation ${check.id}`);
  if (!["pass", "fail", "inconclusive", "human_required"].includes(input.status)) {
    issues.push(`observation ${check.id} has invalid status`);
  }
  if (!texts(input.evidence) || input.evidence.length === 0) {
    issues.push(`observation ${check.id} must cite concrete evidence`);
  }
}

export function validateVerifierReport(input, contract, expectedDigest) {
  const issues = [];
  if (!isRecord(input)) return { ok: false, issues: ["verifier report must be an object"] };
  if (input.contractId !== contract.contractId) issues.push("contractId does not match the frozen contract");
  if (input.contractDigest !== expectedDigest) issues.push("contractDigest does not match the frozen contract");
  requireText(input.deployedRef, "deployedRef", issues);
  if (!isText(input.run_id) || !RUN_ID_RE.test(input.run_id)) issues.push("run_id is invalid");
  if (!new Set(["ok", "blocked"]).has(input.status)) issues.push("status must be ok or blocked");
  if (input.status === "blocked") {
    if (input.allPassed !== null) issues.push("blocked report must use allPassed: null");
    requireText(input.blockedReason, "blockedReason", issues);
    return issues.length === 0 ? { ok: true, issues, value: input } : { ok: false, issues };
  }
  if (typeof input.allPassed !== "boolean") issues.push("status ok requires boolean allPassed");
  if (!Array.isArray(input.scenarios)) {
    issues.push("scenarios must be an array");
    return { ok: false, issues };
  }
  if (input.scenarios.length !== contract.scenarios.length) {
    issues.push("verifier must execute every precommitted scenario exactly once");
  }
  let passed = 0;
  const recordPaths = new Set();
  contract.scenarios.forEach((scenario, index) => {
    const result = input.scenarios[index];
    if (!isRecord(result)) {
      issues.push(`scenario ${scenario.id} result must be an object`);
      return;
    }
    if (result.id !== scenario.id) issues.push(`scenario order/identity drift: expected ${scenario.id}`);
    if (result.claim !== scenario.claim) issues.push(`scenario ${scenario.id} claim changed after planning`);
    if (canonicalJson(result.stimulus) !== canonicalJson(scenario.stimulus)) {
      issues.push(`scenario ${scenario.id} stimulus changed after planning`);
    }
    if (!new Set(["PASS", "FAIL"]).has(result.verdict)) {
      issues.push(`scenario ${scenario.id} verdict must be PASS or FAIL`);
    }
    if (!isText(result.reply)) issues.push(`scenario ${scenario.id} must include the verbatim reply`);
    requireText(result.reason, `scenario ${scenario.id} reason`, issues);
    requireText(result.recordPath, `scenario ${scenario.id} recordPath`, issues);
    if (isText(result.recordPath)) {
      const normalizedRecordPath = result.recordPath.replaceAll("\\", "/");
      const expectedRecordPath = `.proofloop/runs/${input.run_id}/${scenario.id}/record.json`;
      if (normalizedRecordPath !== expectedRecordPath) {
        issues.push(`scenario ${scenario.id} recordPath must be ${expectedRecordPath}`);
      }
      if (recordPaths.has(normalizedRecordPath)) {
        issues.push(`recordPath is duplicated: ${normalizedRecordPath}`);
      }
      recordPaths.add(normalizedRecordPath);
    }
    if (!Array.isArray(result.observations) || result.observations.length !== scenario.checks.length) {
      issues.push(`scenario ${scenario.id} must report every required observation`);
    } else {
      scenario.checks.forEach((check, checkIndex) =>
        validateObservation(result.observations[checkIndex], check, scenario.id, issues));
      if (result.verdict === "PASS") {
        for (let checkIndex = 0; checkIndex < scenario.checks.length; checkIndex++) {
          if (result.observations[checkIndex]?.status !== "pass") {
            issues.push(`scenario ${scenario.id} cannot pass: ${scenario.checks[checkIndex].id} is not pass`);
          }
        }
      }
    }
    if (result.verdict === "PASS") passed++;
  });
  if (!isText(input.cleanup)) issues.push("cleanup is required");
  const computedAllPassed = passed === contract.scenarios.length && input.cleanup === "clean";
  if (input.allPassed !== computedAllPassed) {
    issues.push("allPassed must equal every scenario PASS plus cleanup clean");
  }
  return issues.length === 0 ? { ok: true, issues, value: input } : { ok: false, issues };
}

export function renderVerifierReport(output) {
  const lines = [
    `# Proofloop verification ${output.contractId}`,
    "",
    `- Run: \`${output.run_id}\``,
    `- Deployed ref: \`${output.deployedRef}\``,
    `- Contract digest: \`${output.contractDigest}\``,
    `- Status: \`${output.status}\``,
    `- allPassed: \`${String(output.allPassed)}\``,
    `- Cleanup: \`${output.cleanup ?? "not reported"}\``,
    "",
  ];
  for (const scenario of output.scenarios || []) {
    lines.push(
      `## ${scenario.id}`,
      "",
      `- Verdict: \`${scenario.verdict}\``,
      `- Reason: ${scenario.reason}`,
      `- Record: \`${scenario.recordPath}\``,
      "- Observations:",
      ...scenario.observations.flatMap((observation) => [
        `  - ${observation.checkId}: \`${observation.status}\``,
        ...observation.evidence.map((item) => `    - ${item}`),
      ]),
      "",
    );
  }
  if (output.blockedReason) lines.push(`## Blocker\n\n${output.blockedReason}\n`);
  return `${lines.join("\n").trim()}\n`;
}

function parseArgs() {
  const [, , command = "", ...rest] = process.argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token?.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split("=", 2);
    const value = inline ?? rest[index + 1];
    if (inline === undefined) index++;
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
  }
  return { command, flags };
}

const required = (flags, name) => {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const writeJson = (path, value) => {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

function main() {
  const { command, flags } = parseArgs();
  if (command === "validate-contract" || command === "digest") {
    const contractPath = resolve(required(flags, "contract"));
    const contract = assertProofContract(readJson(contractPath));
    const worktree = resolve(flags.get("worktree") || dirname(contractPath));
    if (command === "digest") {
      console.log(contractBundleDigest(contract, worktree));
    } else {
      console.log(JSON.stringify({ ok: true, issues: [], contractDigest: contractBundleDigest(contract, worktree) }, null, 2));
    }
    return;
  }
  if (command === "init") {
    const contractPath = resolve(required(flags, "contract"));
    const contract = assertProofContract(readJson(contractPath));
    const worktree = resolve(required(flags, "worktree"));
    const baseRef = flags.get("base-ref") || "HEAD";
    const changes = implementationChanges(worktree, baseRef, contract.implementationPaths);
    if (changes.length > 0) {
      throw new Error(`Proof contract must be initialized before implementation changes. Already changed:\n- ${changes.join("\n- ")}`);
    }
    const baselineRef = gitLines(worktree, ["rev-parse", "HEAD"])[0];
    if (!baselineRef) throw new Error("Could not resolve the pre-build baseline ref");
    const state = createWorkflowState(contract, contractPath, worktree, baselineRef, baseRef);
    writeJson(required(flags, "state"), state);
    console.log(JSON.stringify({ phase: state.phase, contractDigest: state.contractDigest }));
    return;
  }
  if (command === "transition") {
    const statePath = resolve(required(flags, "state"));
    const state = loadWorkflowState(statePath);
    const phase = required(flags, "phase");
    let reportPath;
    if (phase === "passed") {
      const reportJsonPath = resolve(required(flags, "report"));
      const validation = validateVerifierReport(readJson(reportJsonPath), state.contract, state.contractDigest);
      if (!validation.ok) throw new Error(`Invalid verifier report:\n- ${validation.issues.join("\n- ")}`);
      if (validation.value.allPassed !== true) throw new Error("passed requires allPassed: true");
      if (validation.value.deployedRef !== state.deployedRef) throw new Error("Report deployedRef does not match workflow state");
      if (validation.value.run_id !== state.runIds.at(-1)) throw new Error("Report run_id is not the fresh run for this attempt");
      reportPath = reportJsonPath;
    }
    const next = transitionWorkflow(state, phase, {
      deployedRef: flags.get("deployed-ref"),
      runId: flags.get("run-id"),
      reportPath,
      blockedReason: flags.get("blocked-reason"),
    });
    writeJson(statePath, next);
    console.log(JSON.stringify({ phase: next.phase, attempts: next.attempts }));
    return;
  }
  if (command === "validate-report" || command === "render-report") {
    const state = loadWorkflowState(required(flags, "state"));
    assertStateFrozen(state);
    const report = readJson(required(flags, "report"));
    const validation = validateVerifierReport(report, state.contract, state.contractDigest);
    if (command === "validate-report") {
      console.log(JSON.stringify(validation, null, 2));
      if (!validation.ok) process.exitCode = 1;
    } else {
      if (!validation.ok) throw new Error(`Invalid verifier report:\n- ${validation.issues.join("\n- ")}`);
      writeFileSync(resolve(required(flags, "out")), renderVerifierReport(validation.value), "utf8");
    }
    return;
  }
  throw new Error(
    "Usage: proofloop-contract <validate-contract|init|transition|validate-report|render-report|digest> ...",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
