import { NextResponse } from "next/server";
import { customSkills } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { shortId } from "@/lib/utils";
import { invalidateCustomSkillsCache } from "@/lib/employee-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNPKG_BASE = "https://unpkg.com/claude-code-templates@latest/cli-tool/components/skills";

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = content;
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key && val) meta[key] = val;
      }
    }
    body = fmMatch[2].trim();
  }
  return { meta, body };
}

function guessCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(frontend|react|next|css|tailwind|component|html)\b/.test(lower)) return "dev";
  if (/\b(backend|api|server|database|node)\b/.test(lower)) return "dev";
  if (/\b(data|pandas|sql|analytics|csv)\b/.test(lower)) return "data";
  if (/\b(design|ui|ux|figma|layout|visual)\b/.test(lower)) return "design";
  if (/\b(writ|content|copy|blog|article|document)\b/.test(lower)) return "writing";
  if (/\b(manage|plan|review|priorit|decision)\b/.test(lower)) return "management";
  if (/\b(insurance|actuari|finance|legal)\b/.test(lower)) return "domain";
  return "ops";
}

function guessIcon(category: string): string {
  const map: Record<string, string> = {
    dev: "💻", data: "📊", design: "🎨", writing: "✍️",
    management: "📋", domain: "🏦", ops: "🔧",
  };
  return map[category] ?? "🔧";
}

// Extract skill path from various input formats:
//   "npx claude-code-templates@latest --skill creative-design/frontend-design"
//   "creative-design/frontend-design"
//   "https://www.aitmpl.com/skills/creative-design/frontend-design"
function extractSkillPath(input: string): string | null {
  const s = input.trim();

  // From npx command: --skill <path>
  const skillFlag = s.match(/--skill\s+([^\s]+)/);
  if (skillFlag) return skillFlag[1];

  // From URL: /skills/<path>
  const urlMatch = s.match(/aitmpl\.com\/skills\/([^?\s]+)/);
  if (urlMatch) return urlMatch[1].replace(/\/$/, "");

  // Bare path like "creative-design/frontend-design"
  if (/^[\w-]+\/[\w-]+$/.test(s)) return s;

  return null;
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = await req.json() as { command: string };

  if (!body.command?.trim()) {
    return NextResponse.json({ error: "command required" }, { status: 400 });
  }

  const raw = body.command.trim();
  const skillPath = extractSkillPath(raw);

  if (!skillPath) {
    return NextResponse.json({
      error: "Could not parse skill path. Accepted formats:\n• creative-design/frontend-design\n• npx claude-code-templates@latest --skill creative-design/frontend-design\n• https://www.aitmpl.com/skills/creative-design/frontend-design",
    }, { status: 400 });
  }

  try {
    const url = `${UNPKG_BASE}/${skillPath}/SKILL.md`;
    const res = await fetch(url, { redirect: "follow" });

    if (!res.ok) {
      return NextResponse.json({
        error: `Skill "${skillPath}" not found (HTTP ${res.status}). Check the path on aitmpl.com/skills/`,
      }, { status: 404 });
    }

    const content = await res.text();
    const { meta, body: prompt } = parseFrontmatter(content);

    if (!prompt.trim()) {
      return NextResponse.json({ error: "Skill file found but has no prompt content" }, { status: 422 });
    }

    const name = meta.name || skillPath.split("/").pop()!.replace(/[-_]/g, " ");
    const description = meta.description || "";
    const category = guessCategory(name + " " + description + " " + prompt);
    const icon = guessIcon(category);

    // Check for duplicate
    const existing = customSkills.list();
    if (existing.some(s => s.name === name)) {
      return NextResponse.json({ error: `Skill "${name}" already imported` }, { status: 409 });
    }

    const skill = customSkills.create({
      id: `custom-${shortId("sk")}`,
      name,
      icon,
      category,
      description: description.slice(0, 500),
      prompt: prompt.slice(0, 20_000),
      source: raw,
    });
    invalidateCustomSkillsCache();

    return NextResponse.json({ imported: [{ id: skill.id, name: skill.name }] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Import failed: ${msg.slice(0, 400)}` }, { status: 500 });
  }
}
