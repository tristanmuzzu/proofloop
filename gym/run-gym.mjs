#!/usr/bin/env node
// The liar's gym - proofloop's own calibration suite.
//
// Starts the demo server in every mode (honest + each liar), runs the matching
// scenario through the runner, and asserts the mechanical facts show EXACTLY
// the signature that mode must produce. If any liar goes uncaught - or the
// honest server gets flagged - the gym fails. Run this before shipping any
// change to proofloop itself.
//
// Usage: node gym/run-gym.mjs        (from the repo root; needs the demo deps)

import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = join(ROOT, "examples", "todo-api");
const RUNNER = join(ROOT, "bin", "proofloop-runner.mjs");

// signature: scenario -> expected mechanical facts per check, keyed "type:evidence:needle-prefix"
const CASES = [
  {
    name: "honest", env: {}, scenario: "scenario-create-persists.json",
    expect: { settled: true, checks: { "expect:api_state": true, "expect:server_log": true, "absent:server_log": false } },
  },
  {
    name: "reply-liar (LIE_MODE)", env: { LIE_MODE: "1" }, scenario: "scenario-create-persists.json",
    expect: { settled: false, checks: { "expect:api_state": false, "expect:server_log": false, "absent:server_log": true } },
  },
  {
    name: "log-liar (LOG_LIE)", env: { LOG_LIE: "1" }, scenario: "scenario-create-persists.json",
    // the nastiest resident: the log check PASSES while state fails - surfaces disagree
    expect: { settled: false, checks: { "expect:api_state": false, "expect:server_log": true, "absent:server_log": false } },
  },
  {
    name: "partial-persist (PARTIAL)", env: { PARTIAL: "1" }, scenario: "scenario-create-persists.json",
    // persists a mangled, untagged row: tag never appears, log looks plausible
    expect: { settled: false, checks: { "expect:api_state": false, "expect:server_log": true, "absent:server_log": false } },
  },
  {
    name: "stale-ui (STALE_UI)", env: { STALE_UI: "1" }, scenario: "scenario-ui-visible.json",
    expect: { settled: true, checks: { "expect:api_state": true, "expect:ui_state": false } },
  },
  {
    name: "honest-ui", env: {}, scenario: "scenario-ui-visible.json",
    expect: { settled: true, checks: { "expect:api_state": true, "expect:ui_state": true } },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env) {
  // give the child a real file descriptor for server.log - the OS writes it
  // directly, so the parent's later execSync (which blocks the event loop and
  // would starve a JS-level pipe) can't delay or drop log lines
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(join(DEMO, "server.log"), "w");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: DEMO, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      execSync("curl -sf localhost:3000/health", { stdio: "ignore" });
      return child;
    } catch { /* not up yet */ }
  }
  child.kill("SIGKILL");
  throw new Error("demo server never became healthy");
}

let failures = 0;
for (const c of CASES) {
  rmSync(join(DEMO, "server.log"), { force: true });
  const server = await startServer(c.env);
  let summary;
  try {
    const runId = `gym-${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
    const out = execSync(
      `node "${RUNNER}" run --config "${join(DEMO, "verify.yaml")}" --scenario "${join(DEMO, c.scenario)}" --run-id ${runId}`,
      { encoding: "utf8", timeout: 180_000 },
    );
    summary = JSON.parse(out);
  } catch (e) {
    console.log(`FAIL  ${c.name}: runner errored: ${(e.message || "").split("\n")[0]}`);
    failures++; server.kill("SIGKILL"); await sleep(400); continue;
  }
  server.kill("SIGKILL");
  await sleep(400);

  const problems = [];
  if (c.expect.settled !== undefined && summary.settled !== c.expect.settled) {
    problems.push(`settled=${summary.settled}, want ${c.expect.settled}`);
  }
  for (const [key, want] of Object.entries(c.expect.checks)) {
    const [type, evidence] = key.split(":");
    const check = summary.checks.find((x) => x.type === type && x.evidence === evidence);
    if (!check) problems.push(`missing check ${key}`);
    else if (check.found !== want) problems.push(`${key}: found=${check.found}, want ${want}`);
  }
  if (summary.cleanup_verified !== true) problems.push(`cleanup_verified=${summary.cleanup_verified}`);

  if (problems.length) {
    console.log(`FAIL  ${c.name}: ${problems.join("; ")}`);
    failures++;
  } else {
    console.log(`OK    ${c.name}: signature matched (settled=${summary.settled}, checks=${summary.checks.map((x) => `${x.evidence}:${x.found}`).join(",")})`);
  }
}

console.log(failures === 0
  ? "\nGYM CLEAN: every liar caught, honest servers pass."
  : `\nGYM FAILED: ${failures} case(s) with wrong signatures.`);
process.exit(failures === 0 ? 0 : 1);
