#!/usr/bin/env node
// proofloop runner - the mechanical half of proofloop.
//
// Executes ONE scenario against a live system, deterministically:
//   substitution (charset-enforced), liveness check, baseline reads,
//   stimulus, outcome-settling, evidence capture, mechanical contains/absent
//   checks, cleanup + verified sweep - and writes a run record.
//
// It NEVER judges. PASS/FAIL belongs to a fresh-context judge reading the
// run record and raw evidence files. The runner only collects and checks
// mechanically, so the judge works from facts no prompt can fumble.
//
// Usage:
//   node proofloop-runner.mjs run --config <verify.yaml> --scenario <scenario.json> [--run-id <id>]
//
// Zero dependencies. Node 18+.

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------- minimal YAML subset parser (the verify.yaml schema only) ----------
// Supports: nested maps via 2-space indent, `- key: value` list entries,
// single/double-quoted and bare scalars, full-line and trailing comments.
// Anything fancier (multiline blocks, anchors, flow style) errors loudly.

function parseScalar(raw, lineNo) {
  let s = raw.trim();
  if (s.startsWith("'")) {
    let out = "", i = 1;
    for (; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; continue; }
        return out;
      }
      out += s[i];
    }
    throw new Error(`line ${lineNo}: unterminated single-quoted string`);
  }
  if (s.startsWith('"')) {
    let out = "", i = 1;
    for (; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === '"') { out += '"'; i++; continue; }
      if (s[i] === '"') return out;
      out += s[i];
    }
    throw new Error(`line ${lineNo}: unterminated double-quoted string`);
  }
  // bare scalar: strip trailing comment (space + #)
  const hash = s.search(/\s#/);
  if (hash !== -1) s = s.slice(0, hash).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function parseYamlSubset(text) {
  const root = {};
  // stack of [indent, container]; containers are plain objects or arrays
  const stack = [[-1, root]];
  let lastListItem = null, lastListIndent = -1;

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const rawLine = lines[n];
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    if (/[{}[\]&*]|^---/.test(rawLine.trim()[0])) {
      throw new Error(`line ${n + 1}: unsupported YAML construct: ${rawLine.trim().slice(0, 40)}`);
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    let line = rawLine.trim();
    let isListItem = false;
    if (line.startsWith("- ")) { isListItem = true; line = line.slice(2); }

    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
    if (!m) throw new Error(`line ${n + 1}: cannot parse: ${line.slice(0, 60)}`);
    const key = m[1], rest = m[2];

    if (isListItem) {
      while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
      const parent = stack[stack.length - 1][1];
      if (!Array.isArray(parent)) throw new Error(`line ${n + 1}: list item outside a list`);
      lastListItem = {}; lastListIndent = indent;
      parent.push(lastListItem);
      lastListItem[key] = rest.trim() === "" ? {} : parseScalar(rest, n + 1);
      continue;
    }
    // continuation key inside the current list item (e.g. verify: under - run:)
    if (lastListItem && indent === lastListIndent + 2) {
      lastListItem[key] = rest.trim() === "" ? {} : parseScalar(rest, n + 1);
      continue;
    }
    lastListItem = null;

    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    const parent = stack[stack.length - 1][1];
    if (Array.isArray(parent)) throw new Error(`line ${n + 1}: map key inside a list needs '- '`);

    if (rest.trim() === "") {
      // could be a nested map OR a list - peek at the next content line
      let next = n + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].trim().startsWith("#"))) next++;
      const container = next < lines.length && lines[next].trim().startsWith("- ") ? [] : {};
      parent[key] = container;
      stack.push([indent, container]);
    } else {
      parent[key] = parseScalar(rest, n + 1);
    }
  }
  return root;
}

// ---------- substitution with charset enforcement ----------

const RUN_ID_RE = /^[a-z0-9-]+$/;
const VALUE_RE = /^[A-Za-z0-9 _.\-]+$/;

function substitute(template, vars, context) {
  return template.replace(/\{([a-z_]+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`${context}: no value for placeholder {${name}}`);
    const v = String(vars[name]);
    if (!VALUE_RE.test(v)) {
      throw new Error(`${context}: value for {${name}} contains characters outside [A-Za-z0-9 _.-]: ${JSON.stringify(v)}`);
    }
    return v;
  });
}

// ---------- shell execution ----------

function runCmd(cmd, cwd, shell, timeoutMs) {
  const started = Date.now();
  try {
    const stdout = execSync(cmd, {
      cwd, timeout: timeoutMs, encoding: "utf8",
      shell: shell || true, stdio: ["ignore", "pipe", "pipe"],
    });
    return { cmd, ok: true, exitCode: 0, output: stdout, ms: Date.now() - started };
  } catch (e) {
    return {
      cmd, ok: false, exitCode: e.status ?? null,
      output: (e.stdout || "") + (e.stderr ? `\n[stderr] ${e.stderr}` : ""),
      error: e.signal === "SIGTERM" ? "timeout" : (e.message || "").split("\n")[0],
      ms: Date.now() - started,
    };
  }
}

const matchingLines = (output, needle, cap = 3) =>
  output.split(/\r?\n/).filter((l) => l.includes(needle)).slice(0, cap);

// ---------- the run ----------

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "run") {
    console.error("usage: proofloop-runner.mjs run --config <verify.yaml> --scenario <scenario.json> [--run-id <id>]");
    process.exit(2);
  }
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const configPath = resolve(opt("config") || "verify.yaml");
  const scenarioPath = resolve(opt("scenario") || "");
  const cwd = dirname(configPath);

  const config = parseYamlSubset(readFileSync(configPath, "utf8"));
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  const shell = config.shell || undefined;
  const settleTimeoutS = Number(config.settle?.timeout_seconds ?? 30);
  const cmdTimeoutMs = 60_000;

  // run_id + tag
  const runId = opt("run-id") || scenario.run_id ||
    `r-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
  if (!RUN_ID_RE.test(runId)) fail(`run_id must match [a-z0-9-]+, got: ${runId}`);
  if (!config.tag || !String(config.tag).includes("{run_id}")) fail("config.tag must contain {run_id}");
  const tag = String(config.tag).replaceAll("{run_id}", runId);

  const vars = { run_id: runId, tag, ...(scenario.stimulus?.inputs || {}) };
  const record = {
    proofloop_runner: "0.3.0", run_id: runId, tag,
    config: configPath, scenario: scenarioPath, cwd,
    claim: scenario.claim, started_at: new Date().toISOString(),
    liveness: null, baseline: {}, baseline_collision: false,
    stimulus: null, settle: null, evidence: {}, checks: [], cleanup: [],
    cleanup_verified: null, warnings: [],
  };
  const runDir = join(cwd, ".proofloop", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const save = (name, content) => writeFileSync(join(runDir, name), content ?? "", "utf8");

  function fail(msg) {
    console.error(`proofloop-runner: ${msg}`);
    process.exit(2);
  }
  const evidenceCmd = (name) => {
    const src = config.evidence?.[name];
    if (!src?.run) fail(`evidence source '${name}' not declared in config`);
    return substitute(src.run, vars, `evidence.${name}`);
  };

  // which evidence sources does this scenario touch?
  const sources = [...new Set([
    ...(scenario.expect || []).map((e) => e.evidence),
    ...(scenario.absent || []).map((e) => e.evidence),
    ...(scenario.settle?.evidence ? [scenario.settle.evidence] : []),
  ])];
  if (sources.length === 0) fail("scenario names no evidence sources (expect/absent/settle)");

  // 1. liveness
  if (config.settle?.poll) {
    record.liveness = runCmd(substitute(config.settle.poll, vars, "settle.poll"), cwd, shell, 10_000);
    if (!record.liveness.ok) fail(`liveness probe failed - system not reachable: ${record.liveness.error}`);
  }

  // 2. baseline reads (+ debris detection)
  for (const name of sources) {
    const r = runCmd(evidenceCmd(name), cwd, shell, cmdTimeoutMs);
    record.baseline[name] = { ok: r.ok, exitCode: r.exitCode, ms: r.ms, file: `baseline-${name}.txt` };
    save(`baseline-${name}.txt`, r.output);
    if (r.output.includes(tag)) record.baseline_collision = true;
  }
  if (record.baseline_collision) fail(`tag '${tag}' already present in a baseline read - debris from a prior run, or run_id collision. Aborting before any mutation.`);

  // 3. stimulus
  const stim = config.stimuli?.[scenario.stimulus?.name];
  if (!stim?.run) fail(`stimulus '${scenario.stimulus?.name}' not declared in config`);
  const stimCmd = substitute(stim.run, vars, `stimuli.${scenario.stimulus.name}`);
  const stimRes = runCmd(stimCmd, cwd, shell, cmdTimeoutMs);
  record.stimulus = { name: scenario.stimulus.name, ...stimRes, file: "reply.txt" };
  save("reply.txt", stimRes.output);

  // 4. settle: poll the named evidence source for the marker, bounded
  if (scenario.settle?.evidence) {
    const marker = substitute(scenario.settle.expect || "{tag}", vars, "settle.expect");
    const cmd = evidenceCmd(scenario.settle.evidence);
    const deadline = Date.now() + settleTimeoutS * 1000;
    let settled = false, polls = 0;
    while (Date.now() < deadline) {
      polls++;
      const r = runCmd(cmd, cwd, shell, cmdTimeoutMs);
      if (r.ok && r.output.includes(marker)) { settled = true; break; }
      execSync(process.platform === "win32" ? "timeout /t 1 >nul 2>&1 || ping -n 2 127.0.0.1 >nul" : "sleep 1", { shell: true });
    }
    record.settle = { evidence: scenario.settle.evidence, marker, settled, polls, budget_s: settleTimeoutS };
    if (!settled) record.warnings.push(`settle: marker '${marker}' never appeared in '${scenario.settle.evidence}' within ${settleTimeoutS}s`);
  } else {
    record.settle = { note: `no settle source declared - waited full budget (${settleTimeoutS}s) for absence-style scenario`, budget_s: settleTimeoutS };
    execSync(process.platform === "win32" ? `ping -n ${settleTimeoutS + 1} 127.0.0.1 >nul` : `sleep ${settleTimeoutS}`, { shell: true });
  }

  // 5. evidence capture
  for (const name of sources) {
    const r = runCmd(evidenceCmd(name), cwd, shell, cmdTimeoutMs);
    record.evidence[name] = { ok: r.ok, exitCode: r.exitCode, ms: r.ms, file: `evidence-${name}.txt` };
    save(`evidence-${name}.txt`, r.output);
    record.evidence[name].output_chars = r.output.length;
  }

  // 6. mechanical checks (facts for the judge - NOT a verdict)
  const readEvidence = (name) => readFileSync(join(runDir, `evidence-${name}.txt`), "utf8");
  for (const exp of scenario.expect || []) {
    const needle = substitute(exp.contains, vars, "expect.contains");
    const out = readEvidence(exp.evidence);
    record.checks.push({
      type: "expect", evidence: exp.evidence, contains: needle,
      found: out.includes(needle), matching_lines: matchingLines(out, needle),
    });
  }
  for (const abs of scenario.absent || []) {
    const needle = substitute(abs.contains, vars, "absent.contains");
    const out = readEvidence(abs.evidence);
    record.checks.push({
      type: "absent", evidence: abs.evidence, contains: needle,
      found: out.includes(needle), matching_lines: matchingLines(out, needle),
    });
  }

  // 7. cleanup + verified sweep
  for (const step of config.cleanup || []) {
    if (step.run) {
      const r = runCmd(substitute(step.run, vars, "cleanup.run"), cwd, shell, cmdTimeoutMs);
      record.cleanup.push({ kind: "run", cmd: r.cmd, ok: r.ok, output: r.output.slice(0, 500) });
    }
    if (step.verify) {
      const r = runCmd(substitute(step.verify, vars, "cleanup.verify"), cwd, shell, cmdTimeoutMs);
      const leftovers = matchingLines(r.output, tag, 5);
      record.cleanup_verified = leftovers.length === 0 && r.ok;
      record.cleanup.push({ kind: "verify", cmd: r.cmd, ok: r.ok, clean: record.cleanup_verified, leftover_lines: leftovers });
    }
  }
  if (record.cleanup_verified === null && (config.cleanup || []).length > 0) {
    record.warnings.push("cleanup ran but config declares no verify: step - sweep is unproven");
  }

  record.finished_at = new Date().toISOString();
  save("record.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify({
    run_id: runId, tag, run_dir: runDir,
    stimulus_ok: record.stimulus.ok,
    settled: record.settle.settled ?? null,
    checks: record.checks.map((c) => ({ type: c.type, evidence: c.evidence, found: c.found })),
    cleanup_verified: record.cleanup_verified,
    warnings: record.warnings,
    note: "Mechanical facts only. Judgment (PASS/FAIL per claim) belongs to a fresh-context judge reading record.json and the evidence files.",
  }, null, 2));
}

main();
