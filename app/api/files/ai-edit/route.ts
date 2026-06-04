// POST /api/files/ai-edit — edit one HTML fragment with the model.
// Body: { snippet, instruction }. Returns { html } (the edited fragment), which
// the Visual editor splices back over the original char range. Used by the
// "AI edit" marquee mode in components/file-editor.tsx.
import { requireAuth } from "@/lib/api-auth";
import { editHtmlFragment, prewarmAiEdit } from "@/lib/ai-edit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    snippet?: string;
    instruction?: string;
    warm?: boolean;
  };

  // Pre-warm ping: fired when the user enters AI-edit mode so the SDK
  // subprocess spawns during their box-drag/typing time, not after they submit.
  if (body.warm) {
    prewarmAiEdit();
    return Response.json({ ok: true });
  }

  const snippet = (body.snippet || "").trim();
  const instruction = (body.instruction || "").trim();
  if (!snippet || !instruction) {
    return Response.json({ error: "snippet and instruction required" }, { status: 400 });
  }

  try {
    const html = await editHtmlFragment(snippet, instruction);
    return Response.json({ html });
  } catch (e) {
    return Response.json({ error: (e as Error).message || "AI edit failed" }, { status: 500 });
  }
}
