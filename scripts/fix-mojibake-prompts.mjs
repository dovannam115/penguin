// One-off fix: re-write Aria/Scout/Forge systemPrompt + role from the clean
// seed.ts source into the DB via the /api/employees/[id] PATCH endpoint.
// Reason: original DB rows have double-encoded UTF-8 (mojibake). seed.ts is
// correct but ensureSeed() is a no-op once the DB has any rows.
// Run: node scripts/fix-mojibake-prompts.mjs <password>
//
// The script also lets the PATCH endpoint set sessionId=null because
// systemPrompt changes, so the next message to each agent picks up the fix.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const pass = process.argv[2];
if (!pass) {
  console.error("Usage: node scripts/fix-mojibake-prompts.mjs <password>");
  process.exit(1);
}

const base = process.env.BASE_URL || "http://localhost:3000";

const seedPath = path.join(repoRoot, "lib", "seed.ts");
const seedText = readFileSync(seedPath, "utf8");

// Slice out the JSON-shaped array literal between `= [` and `];`. seed.ts uses
// double-quoted keys + JSON-friendly values throughout, so the slice parses
// directly with JSON.parse.
const start = seedText.indexOf("= [");
const end = seedText.indexOf("];", start);
if (start < 0 || end < 0) {
  console.error("Could not locate SEED array in seed.ts");
  process.exit(1);
}
const jsonText = seedText.slice(start + 2, end + 1);
let seed;
try {
  seed = JSON.parse(jsonText);
} catch (e) {
  console.error("Failed to JSON.parse SEED slice:", e.message);
  process.exit(1);
}

const targets = ["emp_06olbuvu", "emp_mktr2026", "emp_pdsg2026"];

const authRes = await fetch(`${base}/api/auth`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
if (!authRes.ok) {
  console.error("Auth failed:", authRes.status, await authRes.text());
  process.exit(1);
}
const setCookie = authRes.headers.get("set-cookie") || "";
const tokenMatch = setCookie.match(/mas-token=([^;]+)/);
if (!tokenMatch) {
  console.error("No mas-token in Set-Cookie header");
  process.exit(1);
}
const cookie = `mas-token=${tokenMatch[1]}`;
console.log("Auth OK");

for (const id of targets) {
  const row = seed.find((e) => e.id === id);
  if (!row) {
    console.warn(`Skip ${id}: not in seed`);
    continue;
  }
  const patch = {
    name: row.name,
    role: row.role,
    systemPrompt: row.systemPrompt,
    skills: row.skills,
    emoji: row.emoji,
    avatarColor: row.avatarColor,
  };
  const res = await fetch(`${base}/api/employees/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    console.error(`PATCH ${id} failed: ${res.status}`, await res.text());
    continue;
  }
  const updated = await res.json();
  console.log(`PATCHED ${id} (${updated.name}) — promptLen=${updated.systemPrompt.length} sessionId=${updated.sessionId ?? "null"}`);
}

console.log("Done.");
