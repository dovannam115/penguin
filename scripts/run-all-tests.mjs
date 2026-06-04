// Run all test batteries in sequence and report total coverage.
// Run: npx tsx scripts/run-all-tests.mjs

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BATTERIES = [
  { name: "tools (code-level)",          script: "test-tools.mjs",       est: "5s" },
  { name: "edge cases (text + xlsx)",    script: "test-edge-cases.mjs",  est: "3s" },
  { name: "doc readers (pdf+docx)",      script: "test-doc-readers.mjs", est: "2s" },
  { name: "live app HTTP perf",          script: "test-live-app.mjs",    est: "30s", needsServer: true },
  { name: "stress + concurrency + abort",script: "test-stress.mjs",      est: "60s" },
  { name: "e2e LLM (7 scenarios)",       script: "test-e2e.mjs",         est: "2 min" },
  { name: "multi-agent + @mention",      script: "test-multi-agent.mjs", est: "1 min" },
  { name: "vision (4-color PNG)",        script: "test-vision.mjs",      est: "30s" },
];

mkdirSync("test-output", { recursive: true });
mkdirSync("test-output/logs", { recursive: true });
const summary = [];

function run(scriptName) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ["tsx", `scripts/${scriptName}`];
    const child = spawn("npx", args, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d.toString(); process.stderr.write(d); });
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      writeFileSync(`test-output/logs/${scriptName}.log`, out);
      // Parse "X/Y passed" line
      const m = out.match(/(\d+)\/(\d+)\s+passed/);
      const passed = m ? Number(m[1]) : 0;
      const total = m ? Number(m[2]) : 0;
      resolve({ scriptName, code, ms, passed, total, raw: out });
    });
  });
}

for (const b of BATTERIES) {
  console.log(`\n\n========== ${b.name} (${b.script}, est ${b.est}) ==========\n`);
  const r = await run(b.script);
  const status = r.code === 0 ? "✓ PASS" : "✗ FAIL";
  summary.push({ ...b, ...r });
  console.log(`\n  → ${status}  ${r.passed}/${r.total} in ${(r.ms / 1000).toFixed(1)}s  (exit ${r.code})`);
}

console.log("\n\n╔══════════════════════════════════════════════════════════╗");
console.log("║                  ALL BATTERIES SUMMARY                   ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");
let totalPassed = 0, totalAll = 0, totalFailed = 0;
for (const s of summary) {
  const status = s.code === 0 ? "✓" : "✗";
  totalPassed += s.passed;
  totalAll += s.total;
  if (s.code !== 0) totalFailed++;
  console.log(`${status} ${s.name.padEnd(34)} ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)}  ${(s.ms / 1000).toFixed(1)}s`);
}
console.log("─".repeat(60));
console.log(`  ${String(totalPassed).padStart(3)}/${String(totalAll).padEnd(3)} total test cases passed across ${summary.length} batteries`);
console.log(`  ${totalFailed === 0 ? "✓ ALL BATTERIES PASS" : `✗ ${totalFailed} BATTERY FAILED`}`);
process.exit(totalFailed === 0 ? 0 : 1);
