// POST /api/warm — pre-spawn an SDK subprocess for an upcoming chat. Fired
// by the UI when the user picks a compose target or opens a task, so the
// ~5-9s cold-spawn happens during their typing time instead of after they
// send. No-op if the session already exists or model is non-Claude.
import { requireAuth } from "@/lib/api-auth";
import { prewarmChatSession } from "@/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;
  const body = (await req.json()) as { taskId?: string; employeeId?: string };
  if (!body.taskId || !body.employeeId) {
    return Response.json({ error: "taskId and employeeId required" }, { status: 400 });
  }
  prewarmChatSession(body.taskId, body.employeeId);
  return Response.json({ ok: true });
}
