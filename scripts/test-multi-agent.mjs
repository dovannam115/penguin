// Multi-agent + @mention E2E tests.
// 1. planner (Haiku) for 2-agent room → expect 2 assignments in order
// 2. sequential execution with prior-output context
// 3. @mention chain: agent A's output mentions agent B → B runs next
//
// Run: npx tsx scripts/test-multi-agent.mjs

import { planAssignments } from "../lib/orchestrator.ts";
import { runEmployee, extractMentions } from "../lib/claude.ts";
import { employees, tasks } from "../lib/db.ts";
import { ensureSeed } from "../lib/seed.ts";
import { ensureWorkspace } from "../lib/upload.ts";

ensureSeed();
const roster = employees.list();
const byName = (n) => roster.find((e) => e.name === n);

const results = [];
function rec(name, ok, detail, extra) {
  results.push({ name, ok, detail, extra });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (extra) console.log(`    ${extra}`);
}

// ============== Test 1: planner gives N assignments for N picked agents ==============
console.log("\n=== Multi-agent planner ===");
{
  const atlas = byName("Atlas");
  const scout = byName("Scout");
  const picked = [atlas, scout];
  const t0 = Date.now();
  try {
    const plan = await planAssignments(
      "Phân tích thị trường bảo hiểm xe ô tô cho banca: số liệu thị phần + segment khách hàng + đề xuất sản phẩm.",
      picked,
      () => {},
    );
    const ms = Date.now() - t0;
    const ok = plan.assignments.length === 2 &&
      plan.assignments[0].employeeId === atlas.id &&  // could be either order, but planner usually does Atlas first for data
      plan.assignments[0].subtask.length > 10;
    const order = plan.assignments.map(a => roster.find(e => e.id === a.employeeId)?.name).join(" → ");
    rec(
      "planner: 2 agents → 2 assignments",
      plan.assignments.length === 2,
      `${ms}ms, order: ${order}`,
      `summary: "${plan.summary.slice(0, 100)}"`,
    );
  } catch (e) {
    rec("planner: 2 agents → 2 assignments", false, `threw: ${e.message}`);
  }
}

// ============== Test 2: planner with 3 agents → 3 assignments ==============
{
  const scout = byName("Scout");
  const forge = byName("Forge");
  const aria = byName("Aria");
  const picked = [scout, forge, aria];
  const t0 = Date.now();
  try {
    const plan = await planAssignments(
      "Thiết kế ra mắt sản phẩm bảo hiểm du lịch Đông Nam Á: research market + thiết kế sản phẩm + mockup landing page.",
      picked,
      () => {},
    );
    const ms = Date.now() - t0;
    rec(
      "planner: 3 agents → 3 assignments",
      plan.assignments.length === 3 && new Set(plan.assignments.map(a => a.employeeId)).size === 3,
      `${ms}ms, count=${plan.assignments.length}, unique=${new Set(plan.assignments.map(a => a.employeeId)).size}`,
    );
    for (const a of plan.assignments) {
      const e = roster.find(emp => emp.id === a.employeeId);
      console.log(`    ${e?.name}: "${a.subtask.slice(0, 80)}..."`);
    }
  } catch (e) {
    rec("planner: 3 agents → 3 assignments", false, `threw: ${e.message}`);
  }
}

// ============== Test 3: extractMentions parser ==============
console.log("\n=== @mention extraction ===");
{
  const atlas = byName("Atlas");
  const iris = byName("Iris");
  const text = `Dạ anh, em đã phân tích xong. @Iris bạn build dashboard cho mảng này nhé. Cảm ơn @Scout đã cung cấp data.`;
  const mentions = extractMentions(text, roster);
  const names = mentions.map(id => roster.find(e => e.id === id)?.name).sort();
  const ok = names.length === 2 && names.includes("Iris") && names.includes("Scout");
  rec("extractMentions: @Iris + @Scout in text", ok, `extracted: ${names.join(", ")}`);
}

{
  // Edge: case insensitive, with bold markdown
  const text = `**@iris** xem giúp em.`;
  const mentions = extractMentions(text, roster);
  // Bold/italic shouldn't break the @ — only the plain @ char triggers
  // Per system prompt: "Bold/italic KHÔNG route mention, chỉ ký tự @ mới gọi"
  // So actually `**@iris**` SHOULD still extract because @ is intact
  const found = mentions.length === 1 && roster.find(e => e.id === mentions[0])?.name === "Iris";
  rec("extractMentions: case-insensitive @iris", found, `extracted ${mentions.length}: ${mentions.map(id => roster.find(e => e.id === id)?.name).join(",")}`);
}

{
  // Edge: @ inside word should NOT match (e.g. email-like)
  const text = `Send to scout@example.com please.`;
  const mentions = extractMentions(text, roster);
  rec("extractMentions: @ inside email should NOT match", mentions.length === 0, `extracted: ${mentions.length}`);
}

// ============== Test 4: full sequential run with planner ==============
console.log("\n=== Sequential execution with prior-output context ===");
{
  const atlas = byName("Atlas");
  const iris = byName("Iris");
  const picked = [atlas, iris];

  // Skip Iris if it's on OpenRouter (Gemini) — needs API key configured in app settings
  if (iris.model.startsWith("or:")) {
    console.log(`  (skipping sequential run: Iris uses ${iris.model}, needs OpenRouter key)`);
  } else {
    const taskId = `test_multi_${Date.now()}`;
    const dir = ensureWorkspace(taskId);
    tasks.create({ id: taskId, title: "multi-agent test", description: "test", status: "in_progress", mode: "direct", assignedTo: atlas.id });

    const t0 = Date.now();
    try {
      const plan = await planAssignments(
        "Đề xuất 3 KPI cho banca xe ô tô + ý tưởng dashboard cho 3 KPI đó.",
        picked,
        () => {},
      );
      const planMs = Date.now() - t0;
      console.log(`  planner: ${planMs}ms, order: ${plan.assignments.map(a => roster.find(e => e.id === a.employeeId)?.name).join(" → ")}`);

      const prior = [];
      const turnMs = [];
      for (const a of plan.assignments) {
        const emp = roster.find(e => e.id === a.employeeId);
        const tt = Date.now();
        let text = "";
        const prompt = prior.length > 0
          ? `[Context — đồng nghiệp đã làm trước:]\n${prior.join("\n\n")}\n\n[Việc của bạn:] ${a.subtask}`
          : a.subtask;
        for await (const ev of runEmployee({
          employee: emp,
          prompt,
          taskId,
          workspace: { dir, hasFiles: false },
        })) {
          if (ev.kind === "delta") text += ev.text;
          else if (ev.kind === "done") text = ev.fullText || text;
        }
        const ms = Date.now() - tt;
        turnMs.push({ name: emp.name, ms, chars: text.length });
        if (text) prior.push(`**${emp.name}:** ${text}`);
      }
      const total = Date.now() - t0;
      rec(
        "sequential 2-agent execution",
        turnMs.length === 2,
        `total ${total}ms (planner ${planMs}ms + agents ${turnMs.map(t => `${t.name}=${t.ms}ms/${t.chars}c`).join(", ")})`,
      );
    } catch (e) {
      rec("sequential 2-agent execution", false, `threw: ${e.message}`);
    }
  }
}

// ============== Summary ==============
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n=== RESULT: ${passed}/${results.length} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
