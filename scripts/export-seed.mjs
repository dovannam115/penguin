// One-off: regenerate lib/seed.ts from current .data/office.db employees.
// Used by pack flow when we want the shipped zip's default roster to match
// the developer's tuned-in-app prompts/skills/positions.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const db = new DatabaseSync(path.join(root, ".data", "office.db"));

const rows = db.prepare(`
  SELECT id, name, role, system_prompt, model, avatar_color, emoji, x, y,
         is_prompt_engineer, skills
  FROM employees
  ORDER BY COALESCE(sort_order, 999999), created_at
`).all();
db.close();

const seed = rows.map(r => ({
  id: r.id,
  name: r.name,
  role: r.role,
  systemPrompt: r.system_prompt,
  model: r.model,
  avatarColor: r.avatar_color,
  emoji: r.emoji,
  x: r.x,
  y: r.y,
  isPromptEngineer: r.is_prompt_engineer ?? 0,
  skills: JSON.parse(r.skills || "[]"),
}));

const header = `import { employees } from "./db";
import type { Employee } from "./types";

// Bộ agent mặc định cho Agent P.
// ensureSeed() chỉ chạy khi DB chưa có agent nào, lần đầu mở app sẽ tạo đủ bộ này.
// File này được sinh tự động bởi scripts/export-seed.mjs từ .data/office.db.
const SEED: Omit<Employee, "sessionId" | "createdAt">[] = `;

const footer = `;

export function ensureSeed() {
  if (employees.list().length > 0) return;
  for (const e of SEED) {
    employees.create({ ...e, sessionId: null });
  }
}
`;

const body = JSON.stringify(seed, null, 2);
fs.writeFileSync(path.join(root, "lib", "seed.ts"), header + body + footer);
console.log(`seed.ts written with ${seed.length} agents:`, seed.map(s => s.name).join(", "));
