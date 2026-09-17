#!/usr/bin/env node
/**
 * Calibrate the test suite with attacks derived from this product's published
 * guarantees — never from the tests.
 *
 * Each entry names one invariant the adapter promises (README's "How a judgment
 * happens" and "Falsification-tested" sections, plus the design doc) and the
 * smallest edit that breaks it. The suite must then fail. Which test fails is an
 * observation reported afterwards: naming a target test up front would tune the
 * attack to the tests, and a suite calibrated against itself only proves it
 * covers what it already covers.
 *
 * Usage: bun run mutate [--verbose]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");

/**
 * @typedef {{
 *   guarantee: string;
 *   breakBy: string;
 *   file: string;
 *   find: string;
 *   replace: string;
 * }} Attack
 */

/** @type {readonly Attack[]} */
const ATTACKS = [
 {
  guarantee: "a verdict binds to the exact bytes it judged",
  breakBy: "ignore the captured digest when resolving a settlement",
  file: "omp/settlement.ts",
  find: "if (record.inputSha256 !== options.inputSha256) {",
  replace: "if (false) {",
 },
 {
  guarantee: "a verdict binds to the exact instruction it answered",
  breakBy: "ignore the instruction hash when resolving a settlement",
  file: "omp/settlement.ts",
  find: "if (record.instructionHash !== options.instructionHash) {",
  replace: "if (false) {",
 },
 {
  guarantee: "a verdict must be newer than the dispatch that requested it",
  breakBy: "ignore the dispatch/settlement ordering",
  file: "omp/settlement.ts",
  find: "if (dispatchedAt !== undefined && settledAt !== undefined && settledAt < dispatchedAt) {",
  replace: "if (false) {",
 },
 {
  guarantee: "no settlement means no pass",
  breakBy: "fall through when no settlement file exists",
  file: "omp/settlement.ts",
  find: "if (record === undefined) {",
  replace: "if (false) {",
 },
 {
  guarantee: "a judgment is bound to a graph revision",
  breakBy: "resolve a goal whose run carries no graph revision",
  file: "omp/kernels.ts",
  find: "if (graphDigest === undefined) {",
  replace: "if (false) {",
 },
 {
  guarantee: "every kernel failure path is inconclusive, never pass",
  breakBy: "make the inconclusive constructor return pass",
  file: "omp/kernels.ts",
  find: 'return { state: "inconclusive", evidence, reason }',
  replace: 'return { state: "pass", evidence, reason }',
 },
 {
  guarantee: "a script that exits non-zero is inconclusive",
  breakBy: "ignore the exit code",
  file: "omp/kernels.ts",
  find: "if (result.code !== 0) {",
  replace: "if (false) {",
 },
 {
  guarantee: "a script that prints an unknown verdict is inconclusive",
  breakBy: "accept any verdict string",
  file: "omp/kernels.ts",
  find: 'if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {',
  replace: "if (false) {",
 },
 {
  guarantee: "a settlement that does not parse to a legal shape is absent",
  breakBy: "skip the state validation when reading a settlement",
  file: "omp/settlement.ts",
  find: 'if (state !== "pass" && state !== "fail" && state !== "inconclusive") return undefined;',
  replace: "if (false) return undefined;",
 },
 {
  guarantee: "a dispatch request records when the judgment was first handed out",
  breakBy: "let every dispatch rewrite the request file",
  file: "omp/settlement.ts",
  find: 'flag: "wx"',
  replace: 'flag: "w"',
 },
 {
  guarantee: "a goal whose object and judgment are unchanged reuses the prior verdict",
  breakBy: "never inherit a prior verdict",
  file: "omp/dispatch.ts",
  find: "if (priorRun === undefined || anchor === undefined) return false;",
  replace: "if (true) return false;",
 },
 {
  guarantee: "a goal whose object and judgment are unchanged is not re-dispatched",
  breakBy: "invert the plan's acceptance of a valid settlement",
  file: "omp/dispatch.ts",
  find: 'if (resolution.ok) return { kind: "skip" };',
  replace: 'if (!resolution.ok) return { kind: "skip" };',
 },
 {
  guarantee: "a goal with nothing captured is deferred, never dispatched",
  breakBy: "dispatch goals that have no captured object",
  file: "omp/dispatch.ts",
  find: "if (plan.input === undefined || !plan.input.exists) {",
  replace: "if (false) {",
 },
 {
  guarantee: "a verifier is handed the frozen capture, and a failed extraction yields nothing",
  breakBy: "return an object path even when the capture could not be unpacked",
  file: "omp/dispatch.ts",
  find: "if (extracted.code !== 0) return undefined;",
  replace: "if (false) return undefined;",
 },
 {
  guarantee: "the panel reflects every goal of the run it renders",
  breakBy: "render no goal rows at all",
  file: "omp/panel.ts",
  find: "for (const goalId of Object.keys(nodes).slice(0, limit)) {",
  replace: "for (const goalId of []) {",
 },
 {
  guarantee: "the ledger reports which verifier a verdict was adopted from",
  breakBy: "make every adoption record read back as absent",
  file: "omp/bindings.ts",
  find: 'if (typeof record.runId !== "string" || typeof record.goalId !== "string") return undefined;',
  replace: "if (true) return undefined;",
 },
];

function runSuite() {
 const result = spawnSync(
  "bun",
  ["x", "vitest", "run", "--reporter=json", "--outputFile=/tmp/omp-dog-mutation.json"],
  { cwd: repo, encoding: "utf8" },
 );
 if (verbose) process.stdout.write(result.stdout ?? "");
 return result.status;
}

function failingTests() {
 try {
  const report = JSON.parse(readFileSync("/tmp/omp-dog-mutation.json", "utf8"));
  const names = [];
  for (const file of report.testResults ?? []) {
   for (const assertion of file.assertionResults ?? []) {
    if (assertion.status === "failed") names.push(String(assertion.fullName ?? assertion.title ?? ""));
   }
  }
  return names;
 } catch {
  return [];
 }
}

if (runSuite() !== 0) {
 console.error("baseline suite is already failing — fix that before calibrating");
 process.exit(2);
}
console.log("baseline: green\n");

const rows = [];
let survived = 0;
for (const attack of ATTACKS) {
 const path = join(repo, attack.file);
 const original = readFileSync(path, "utf8");
 const matches = original.split(attack.find).length - 1;
 if (matches !== 1) {
  rows.push([attack.guarantee, "NOT INJECTED", `anchor matched ${matches}× in ${attack.file}`]);
  survived += 1;
  continue;
 }
 try {
  writeFileSync(path, original.replace(attack.find, attack.replace));
  runSuite();
  const failed = failingTests();
  if (failed.length === 0) {
   rows.push([attack.guarantee, "SURVIVED", "suite stayed green"]);
   survived += 1;
  } else {
   rows.push([attack.guarantee, `caught (${failed.length})`, failed.slice(0, 2).join(" · ")]);
  }
 } finally {
  writeFileSync(path, original);
 }
}

const width = Math.max(...rows.map(([guarantee]) => guarantee.length));
console.log(`${"guarantee attacked".padEnd(width)}  verdict            failing tests (observed)`);
for (const [guarantee, verdict, evidence] of rows) {
 console.log(`${guarantee.padEnd(width)}  ${verdict.padEnd(17)}  ${evidence.slice(0, 96)}`);
}
console.log();
if (survived === 0) {
 console.log(`${ATTACKS.length}/${ATTACKS.length} broken guarantees were caught by the suite.`);
} else {
 console.log(`${survived}/${ATTACKS.length} broken guarantee(s) survived — the suite does not defend them.`);
 process.exit(1);
}
