// One-off migration: remove "insurance-fundamentals" from Aria's skills if present.
// Designer doesn't own insurance domain; just applies it visually.
// Run: npx tsx scripts/migrate-aria-skills.mjs

import { employees } from "../lib/db.ts";

const list = employees.list();
const aria = list.find(e => e.name === "Aria");
if (!aria) {
  console.log("No Aria employee found. Nothing to migrate.");
  process.exit(0);
}

const before = aria.skills ?? [];
const after = before.filter(s => s !== "insurance-fundamentals");
if (before.length === after.length) {
  console.log(`Aria already clean (skills: ${after.join(", ") || "(none)"}). Skip.`);
  process.exit(0);
}

employees.update(aria.id, { skills: after });
console.log(`Aria migrated:\n  before: ${before.join(", ")}\n  after:  ${after.join(", ")}`);
