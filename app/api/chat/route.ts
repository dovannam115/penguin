import { employees, tasks, messages, getUserProfile, spaces } from "@/lib/db";
import { runEmployee, extractMentions } from "@/lib/claude";
import { planAssignments } from "@/lib/orchestrator";
import { shortId } from "@/lib/utils";
import type { Employee, ModelId } from "@/lib/types";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/api-auth";
import { currentView } from "@/lib/space";
import { listFiles, ensureWorkspace, workspaceDir, saveFile } from "@/lib/upload";
import { renderDeckToImages } from "@/lib/office-tools/deck-to-images";

async function generateTaskTitle(userMessage: string): Promise<string | null> {
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      messages: [{ role: "user", content: userMessage }],
      system: "Đặt tên ngắn gọn (tối đa 6 từ tiếng Việt) cho task dựa trên tin nhắn user. Chỉ trả lời tên task, không giải thích. Ví dụ: 'Phân tích doanh thu Q1', 'Sửa lỗi login page', 'Viết báo cáo KPI tháng 5'.",
    });
    const text = res.content[0];
    if (text.type === "text") return text.text.trim().slice(0, 80);
    return null;
  } catch {
    return null;
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface ChatRequest {
  message: string;
  /** Multiple agents for new multi-agent rooms. First entry becomes
   *  `task.assignedTo`. For backward compat, single-agent callers can
   *  send `employeeId` instead. */
  employeeIds?: string[];
  employeeId?: string;
  taskId?: string; // present = continuation of existing task
  images?: string[]; // base64 data URLs from pasted screenshots
  files?: string[];  // filenames already uploaded to the task workspace
  skipUserMessage?: boolean; // true when edit-and-resend (user msg already exists)
  /** Handoff dispatch from a user-accepted agent-to-agent invite. When set,
   *  the route skips creating a user message and runs `targetId` with a
   *  handoff prompt derived from `sourceMessageId`'s content. */
  dispatch?: { targetId: string; sourceMessageId: string };
}

function extractInviteReason(text: string, targetName: string): string {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "i");
  const idx = text.search(re);
  if (idx < 0) return "";
  const before = text.slice(0, idx).split(/(?<=[.!?])\s+/).pop() ?? "";
  const after = text.slice(idx).split(/(?<=[.!?])\s+/)[0] ?? "";
  return (before + after).replace(/\s+/g, " ").trim().slice(0, 220);
}

const MENTION_CHAIN_LIMIT = 2;

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = (await req.json()) as ChatRequest;
  if (!body.message?.trim() && !body.dispatch) {
    return new Response(JSON.stringify({ error: "message required" }), { status: 400 });
  }
  // Space this turn belongs to: new tasks are stamped with it, and continuing
  // another space's task is refused.
  const view = await currentView();
  const spaceId = view.spaceId;
  // An admin browsing someone else's workspace is read-only — never run the AI
  // (or create content) as another account.
  if (view.viewing) {
    return new Response(JSON.stringify({ error: "Viewing another account — read-only" }), { status: 403 });
  }
  // Hard gate: an account awaiting admin approval cannot run the AI (this is the
  // expensive, Max-quota-burning path), so block it before anything else.
  if (!spaces.isApproved(spaceId)) {
    return new Response(JSON.stringify({ error: "Account pending admin approval" }), { status: 403 });
  }
  if (body.taskId) {
    const existing = tasks.get(body.taskId);
    if (existing && existing.ownerId !== spaceId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    }
  }

  const sdkAbort = new AbortController();
  req.signal.addEventListener("abort", () => sdkAbort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const roster = employees.list();
        // Look up by supplied taskId; if found = continuation, if not found =
        // create a new task using that id (client may have generated it for
        // optimistic navigation). Continuation status is derived from "did the
        // task already exist?", not from "did the client send an id?".
        let task = body.taskId ? tasks.get(body.taskId) : null;
        const isContinuation = !!task;
        // Normalize: support both employeeIds[] (multi-agent) and the legacy
        // single employeeId. Primary agent (first id) becomes assignedTo.
        const composeIds: string[] = body.employeeIds && body.employeeIds.length > 0
          ? body.employeeIds.filter(id => roster.find(e => e.id === id))
          : (body.employeeId ? [body.employeeId] : []);
        const primaryId = composeIds[0] ?? null;
        if (!task) {
          task = tasks.create({
            id: body.taskId ?? shortId("task"),
            title: body.message.slice(0, 80),
            description: body.message,
            status: "in_progress",
            mode: "direct",
            assignedTo: primaryId,
            ownerId: spaceId,
          });
        } else {
          tasks.setStatus(task.id, "in_progress");
        }
        let userMentions = extractMentions(body.message, roster);

        // Handoff dispatch (user accepted an agent-to-agent invite): rewrite
        // body.message into a handoff prompt and route it only to the target
        // agent. Keeps the rest of the flow unchanged.
        if (body.dispatch && task) {
          const sourceMsg = messages.get(body.dispatch.sourceMessageId);
          const target = employees.get(body.dispatch.targetId);
          if (!target) {
            send("error", { error: "Target agent not found" });
            return;
          }
          if (sourceMsg) {
            const sourceEmp = sourceMsg.fromId ? employees.get(sourceMsg.fromId) : null;
            const sName = sourceEmp?.name ?? "Đồng nghiệp";
            const sRole = sourceEmp?.role ?? "";
            body.message = `Đồng nghiệp ${sName}${sRole ? ` (${sRole})` : ""} vừa nói:\n\n"${sourceMsg.content}"\n\nUser đã phê duyệt việc kéo bạn vào room. Phản hồi ngắn gọn theo góc nhìn của bạn.`;
          } else {
            body.message = `User đã phê duyệt việc kéo bạn vào room. Phản hồi theo nội dung mới nhất trong room.`;
          }
          body.skipUserMessage = true;
          userMentions = [body.dispatch.targetId];
        }

        // Save pasted images to workspace before running employee
        const imageFilenames: string[] = [];
        if (body.images && body.images.length > 0) {
          ensureWorkspace(task.id);
          for (let i = 0; i < body.images.length; i++) {
            const dataUrl = body.images[i];
            const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!match) continue;
            const ext = match[1] === "jpeg" ? "jpg" : match[1];
            const filename = `paste-${Date.now()}-${i}.${ext}`;
            const buf = Buffer.from(match[2], "base64");
            saveFile(task.id, filename, buf);
            imageFilenames.push(filename);
          }
        }

        const attachedFiles: string[] = Array.isArray(body.files) ? body.files.filter((x: unknown): x is string => typeof x === "string") : [];
        const imageExtToMime: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
        };
        const isImage = (n: string) => {
          const ext = n.split(".").pop()?.toLowerCase() ?? "";
          return ext in imageExtToMime;
        };
        const uploadedImages = attachedFiles.filter(isImage);

        let userMsgId: string | null = null;
        if (!body.skipUserMessage) {
          const userMsg = messages.create({
            id: shortId("msg"),
            taskId: task.id,
            fromId: null,
            toId: primaryId,
            role: "user",
            content: body.message,
            mentions: userMentions,
            images: imageFilenames,
            files: attachedFiles,
          });
          userMsgId = userMsg.id;
        }
        send("task_created", { taskId: task.id, userMessageId: userMsgId, mode: task.mode, continuation: isContinuation, images: imageFilenames, files: attachedFiles });

        if (!isContinuation) {
          generateTaskTitle(body.message).then(title => {
            if (title) {
              tasks.setTitle(task.id, title);
              send("task_titled", { taskId: task.id, title });
            }
          });
        }

        // Design-reference decks: render attached .pptx / .pdf into per-page
        // PNGs so the agent SEES the slides (palette / layout / presentation
        // style) as vision input rather than only extracted text. Rendered PNGs
        // feed the SAME pipeline as uploaded images. .pptx → PowerPoint COM,
        // .pdf → poppler pdftoppm. Cached per file so continuation turns reuse.
        const deckRefFiles = attachedFiles.filter(n => /\.(pptx|pdf)$/i.test(n));
        const renderedRefImages: string[] = [];
        const renderedSources: string[] = [];
        const refRenderErrors: string[] = [];
        if (deckRefFiles.length > 0) {
          ensureWorkspace(task.id);
          const wsDir = workspaceDir(task.id);
          for (const name of deckRefFiles) {
            try {
              const r = await renderDeckToImages(wsDir, name);
              if (r.images.length > 0) { renderedRefImages.push(...r.images); renderedSources.push(name); }
              else if (r.error && r.error !== "unsupported") refRenderErrors.push(`${name}: ${r.error}`);
            } catch (e) {
              refRenderErrors.push(`${name}: ${(e as Error).message}`);
            }
          }
        }

        // Pasted screenshots + uploaded image files are sent as IMAGE content
        // blocks (vision), so the model actually sees them. We still add a
        // short text note so the agent's response can reference them by name.
        // Rendered deck pages go FIRST so the 10-image cap never drops them.
        const pastedUploadedImages = [...imageFilenames, ...uploadedImages];
        const allImageFilenames = [...renderedRefImages, ...pastedUploadedImages];
        if (pastedUploadedImages.length > 0) {
          body.message += `\n\n[Ảnh đính kèm: ${pastedUploadedImages.join(", ")} — bạn ĐANG nhìn thấy ảnh ở trên, mô tả/phân tích trực tiếp, KHÔNG gọi Read.]`;
        }
        if (renderedSources.length > 0) {
          body.message += `\n\n[MẪU THAM KHẢO (CẢM HỨNG): ${renderedSources.join(", ")} → ${renderedRefImages.length} ảnh, bạn ĐANG NHÌN THẤY ở trên. Đây là nguồn CẢM HỨNG về ngôn ngữ thiết kế (tông màu, kiểu chữ, motif trang trí, độ tinh xảo) — KHÔNG phải khuôn để chép y từng ô. ĐỪNG ép nội dung vào đúng vị trí box của mẫu; ĐỪNG để slide trống hoác vì cố giống mẫu. HÃY: (1) HỎI user TRƯỚC (1 lần, gộp) về mục đích + độ dài + NHẤT LÀ MÀU SẮC — dùng tông của mẫu hay màu brand/khác? — đừng tự bê palette mẫu vào; (2) thiết kế bố cục SÁNG TẠO phục vụ NỘI DUNG từng slide, biến tấu đa dạng, lấp đầy slide cân đối, thông tin ĐẦY ĐỦ và có chiều sâu (không sơ sài, không trống); (3) chỉ MƯỢN tinh thần motif/typographic/độ polish của mẫu rồi sáng tạo lại cho hợp nội dung. Nội dung tiếng Việt → BẮT BUỘC dùng font có subset Vietnamese đầy đủ (kẻo vỡ dấu). KHÔNG chép chữ của mẫu; KHÔNG gọi read_pdf/Read lên các file này.]`;
        }
        if (refRenderErrors.length > 0) {
          body.message += `\n\n[Lưu ý: không render được ${refRenderErrors.join("; ")}. Nếu đây là file thiết kế mẫu, gợi ý user xuất từng slide ra ảnh PNG rồi đính kèm.]`;
        }

        // Files attached for READING (exclude decks already rendered to vision).
        const renderedSet = new Set(renderedSources);
        const nonRefAttached = attachedFiles.filter(n => !renderedSet.has(n));
        if (nonRefAttached.length > 0) {
          const xlsxFiles = nonRefAttached.filter(n => /\.xlsx?$/i.test(n));
          const pdfToRead = nonRefAttached.filter(n => /\.pdf$/i.test(n));
          const docxToRead = nonRefAttached.filter(n => /\.docx?$/i.test(n));
          const otherFiles = nonRefAttached.filter(n =>
            !/\.xlsx?$/i.test(n) && !/\.pdf$/i.test(n) && !/\.docx?$/i.test(n)
          );
          let hint = `\n\n[File user vừa đính kèm trong workspace: ${nonRefAttached.join(", ")}.`;
          if (xlsxFiles.length > 0) {
            hint += ` BƯỚC 1: ${xlsxFiles.map(f => `read_xlsx({filename:"${f}"})`).join(", ")} để xem nội dung. ` +
              `BƯỚC 2: Nếu user yêu cầu format / clean / đẹp / restructure file Excel — gọi xlsx_write 1 phát với headers + rows (đặt tên output kèm hậu tố như "_formatted.xlsx"). Preset đã đẹp sẵn (header đậm + freeze + border + zebra), KHÔNG cần config thêm style trừ khi user nói cụ thể. KHÔNG trả lời inline data dump. ` +
              `BƯỚC 3 (BẮT BUỘC): Sau khi xlsx_write trả về thành công, reply text 1 câu: "Dạ anh, xong file <tên_file>." Nếu xlsx_write báo lỗi, nói cho user biết lý do.`;
          }
          if (pdfToRead.length > 0) {
            hint += ` Đọc PDF bằng read_pdf({filename:"<tên>.pdf"}) trước khi xử lý: ${pdfToRead.join(", ")}.`;
          }
          if (docxToRead.length > 0) {
            hint += ` Đọc Word bằng read_docx({filename:"<tên>.docx"}) trước khi xử lý: ${docxToRead.join(", ")}.`;
          }
          if (otherFiles.length > 0) {
            hint += ` Đọc ${otherFiles.join(", ")} bằng read_text hoặc Read tool trước khi xử lý.`;
          }
          hint += `]`;
          body.message += hint;
        }

        // Workspace + office tools are ALWAYS attached now (each task gets a
        // dir under .data/workspaces/<taskId>). Lets the agent actually write
        // out PDFs / docs / dashboards / HTML instead of asking the user to
        // copy-paste a code block. Cold start cost (~300-800ms) is acceptable
        // for the UX gain — and prompt-cache amortizes turn 2+.
        ensureWorkspace(task.id);
        const taskWorkspaceDir = workspaceDir(task.id);
        const taskFiles = listFiles(task.id);
        const hasWorkspaceFiles = taskFiles.length > 0 || imageFilenames.length > 0;

        // Set of agent ids "already in this room" — used to decide whether an
        // agent's @-mention of someone else should auto-cascade or require
        // user approval. Anyone the user already invited (composeIds, user
        // @-mentions, prior message history) is considered in-room.
        const knownRoomMembers = new Set<string>(composeIds);
        if (task.assignedTo) knownRoomMembers.add(task.assignedTo);
        for (const mid of userMentions) knownRoomMembers.add(mid);
        for (const m of messages.listByTask(task.id)) {
          if (m.fromId) knownRoomMembers.add(m.fromId);
          if (m.toId) knownRoomMembers.add(m.toId);
          for (const x of m.mentions ?? []) knownRoomMembers.add(x);
        }
        // Within a single request, don't emit multiple invite_request events
        // for the same target — if Agent A and Agent B both @-mention Charlie
        // back-to-back, the user should see ONE invite card, not two.
        const invitedThisRequest = new Set<string>();

        const runTurn = async (
          employee: Employee,
          prompt: string,
          depth: number,
          modelOverride?: ModelId,
        ): Promise<string> => {
          if (sdkAbort.signal.aborted) return "";
          send("turn_start", {
            employeeId: employee.id,
            name: employee.name,
            role: employee.role,
            emoji: employee.emoji,
            avatarColor: employee.avatarColor,
            depth,
            hasWorkspace: true,
          });

          let fullText = "";
          let sessionId: string | null = employee.sessionId;
          let errored = false;
          const filesBeforeTurn = listFiles(task.id).map(f => f.name + ":" + f.mtime).join("|");

          for await (const ev of runEmployee({
            employee,
            prompt,
            taskId: task.id,
            signal: sdkAbort,
            // Always-on workspace so agents can produce files. `hasFiles` flips
            // the system-prompt hint ("read uploads first" vs "create outputs
            // here"); the tool surface is identical either way.
            workspace: { dir: taskWorkspaceDir, hasFiles: hasWorkspaceFiles, files: taskFiles.map(f => f.name) },
            // Pass images as content blocks (vision) on the FIRST turn for this
            // employee. After that, the warm subprocess keeps the conversation;
            // sending images again on every turn would re-upload bytes.
            attachedImages: depth === 0 ? allImageFilenames.map(n => ({
              path: `${taskWorkspaceDir}/${n}`,
              mediaType: imageExtToMime[n.split(".").pop()!.toLowerCase()],
            })) : undefined,
            modelOverride,
          })) {
            if (ev.kind === "delta") {
              fullText += ev.text;
              send("delta", { employeeId: employee.id, text: ev.text });
            } else if (ev.kind === "thinking_delta") {
              send("thinking_delta", { employeeId: employee.id, text: ev.text });
            } else if (ev.kind === "tool_use_start") {
              send("tool_use_start", { employeeId: employee.id, toolName: ev.toolName, id: ev.id, index: ev.index });
            } else if (ev.kind === "tool_use_delta") {
              send("tool_use_delta", { employeeId: employee.id, id: ev.id, index: ev.index, partialJson: ev.partialJson });
            } else if (ev.kind === "tool_use") {
              send("tool_use", { employeeId: employee.id, toolName: ev.toolName, input: ev.input, id: ev.id });
            } else if (ev.kind === "error") {
              send("turn_error", { employeeId: employee.id, error: ev.error });
              errored = true;
              break;
            } else if (ev.kind === "done") {
              fullText = ev.fullText || fullText;
              sessionId = ev.sessionId;
            }
          }
          if (errored) return "";

          // Detect file changes during this turn
          const filesAfterTurn = listFiles(task.id);
          const afterSig = filesAfterTurn.map(f => f.name + ":" + f.mtime).join("|");
          const beforeNames = new Set(filesBeforeTurn.split("|").map(s => s.split(":")[0]).filter(Boolean));
          const beforeMtimes = new Map(filesBeforeTurn.split("|").filter(Boolean).map(s => {
            const [n, m] = s.split(":");
            return [n, Number(m)];
          }));
          if (afterSig !== filesBeforeTurn) {
            send("files_changed", { taskId: task.id, files: filesAfterTurn });
          }

          // Fallback narration: some models call a writer tool (xlsx_write,
          // export_pdf, ...) and stop without speaking, leaving the user with
          // a blank bubble + no clue whether the file landed. If the turn
          // wrote/updated a file but the agent text is empty, synthesize a
          // one-line confirmation so the user always knows what happened.
          if (!fullText.trim()) {
            const newOrUpdated = filesAfterTurn.filter(f => {
              const prev = beforeMtimes.get(f.name);
              return !beforeNames.has(f.name) || (prev !== undefined && prev !== f.mtime);
            });
            if (newOrUpdated.length > 0) {
              const names = newOrUpdated.map(f => f.name).join(", ");
              fullText = `Dạ ${getUserProfile().address}, xong file ${names}.`;
              send("delta", { employeeId: employee.id, text: fullText });
            }
          }

          if (sessionId && sessionId !== employee.sessionId) {
            employees.update(employee.id, { sessionId });
          }

          const mentions = extractMentions(fullText, roster).filter(id => id !== employee.id);
          const msg = messages.create({
            id: shortId("msg"),
            taskId: task.id,
            fromId: employee.id,
            toId: null,
            role: "assistant",
            content: fullText,
            mentions,
            images: [],
            files: [],
          });
          send("turn_done", {
            employeeId: employee.id,
            messageId: msg.id,
            fullText,
            mentions,
          });

          if (depth < MENTION_CHAIN_LIMIT && mentions.length > 0) {
            for (const mid of mentions) {
              if (sdkAbort.signal.aborted) break;
              const target = employees.get(mid);
              if (!target) continue;
              // PE is a 1-on-1 prompt-refining helper, never auto-pulled into
              // rooms even when another agent @mentions them.
              if (target.isPromptEngineer === 1) continue;
              if (knownRoomMembers.has(mid)) {
                // Already part of the room → auto-handoff as before.
                const handoffPrompt = `Đồng nghiệp ${employee.name} (${employee.role}) vừa nói với bạn:\n\n"${fullText}"\n\nPhản hồi ngắn gọn theo góc nhìn của bạn. Nếu không đồng ý, nói thẳng vì sao.`;
                await runTurn(target, handoffPrompt, depth + 1);
              } else if (!invitedThisRequest.has(mid)) {
                // New agent — gate behind user approval instead of cascading.
                invitedThisRequest.add(mid);
                send("invite_request", {
                  inviteId: shortId("inv"),
                  taskId: task.id,
                  fromId: employee.id,
                  fromName: employee.name,
                  targetId: target.id,
                  targetName: target.name,
                  targetEmoji: target.emoji,
                  targetRole: target.role,
                  reason: extractInviteReason(fullText, target.name),
                  sourceMessageId: msg.id,
                });
              }
            }
          }
          return fullText;
        };

        // Explicit @mention is the user's loudest routing intent: hand off
        // straight to the mentioned employees in parallel.
        const runDirectMentions = async () => {
          await Promise.allSettled(
            userMentions.map(async (mid) => {
              if (sdkAbort.signal.aborted) return;
              const emp = employees.get(mid);
              if (!emp) return;
              await runTurn(emp, body.message, 0);
            }),
          );
        };

        if (userMentions.length > 0) {
          await runDirectMentions();
        } else if (isContinuation) {
          // Continuation in a multi-agent room: only assignedTo (primary)
          // replies by default. Use @Name to direct another room member.
          if (task.assignedTo) {
            const emp = employees.get(task.assignedTo);
            if (emp) await runTurn(emp, body.message, 0);
            else send("error", { error: "Nhân viên gốc của task này không còn." });
          } else {
            send("error", { error: "Vui lòng @TênNhânViên trong tin nhắn để chỉ định người trả lời." });
          }
        } else {
          if (composeIds.length === 0) {
            send("error", { error: "employeeIds (or employeeId) required" });
            tasks.setStatus(task.id, "failed");
            return;
          }
          if (composeIds.length === 1) {
            // Single-agent new chat: skip the planner — straight to the agent.
            const emp = employees.get(composeIds[0]);
            if (emp && emp.isPromptEngineer !== 1) await runTurn(emp, body.message, 0);
          } else {
            // Multi-agent room: cheap Haiku planner gives one subtask per
            // picked agent (user's selection is mandatory — every picked
            // agent gets work), then we run them SEQUENTIALLY so each agent
            // sees prior outputs (inlined into the prompt) instead of writing
            // parallel paragraphs that don't build on each other.
            send("plan_start", {});
            const picked = composeIds
              .map(id => roster.find(e => e.id === id))
              .filter((e): e is Employee => !!e);
            let plan;
            try {
              plan = await planAssignments(body.message, picked, (chunk) => {
                send("plan_delta", { text: chunk });
              });
            } catch (err) {
              send("error", { error: "Planner failed: " + (err instanceof Error ? err.message : String(err)) });
              tasks.setStatus(task.id, "failed");
              return;
            }
            const planContent = `**Plan:** ${plan.summary}\n\n` +
              plan.assignments.map(a => {
                const e = roster.find(r => r.id === a.employeeId);
                return `- **${e?.name ?? a.employeeId}** (${e?.role ?? ""}): ${a.subtask}`;
              }).join("\n");
            const planMsg = messages.create({
              id: shortId("msg"),
              taskId: task.id,
              fromId: null,
              toId: null,
              role: "system",
              content: planContent,
              mentions: plan.assignments.map(a => a.employeeId),
              images: [],
              files: [],
            });
            send("plan", { plan, messageId: planMsg.id, content: planContent });

            const prior: string[] = [];
            for (const a of plan.assignments) {
              if (sdkAbort.signal.aborted) break;
              const emp = employees.get(a.employeeId);
              if (!emp) continue;
              if (emp.isPromptEngineer === 1) continue;
              const prompt = prior.length > 0
                ? `[Context — đồng nghiệp đã làm trước:]\n${prior.join("\n\n")}\n\n[Việc của bạn:] ${a.subtask}`
                : a.subtask;
              const result = await runTurn(emp, prompt, 0);
              if (result) prior.push(`**${emp.name} (${emp.role}):** ${result}`);
            }
          }
        }

        if (sdkAbort.signal.aborted) {
          tasks.setStatus(task.id, "failed");
          send("stopped", { taskId: task.id });
        } else {
          tasks.setStatus(task.id, "done");
          send("end", { taskId: task.id });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (!sdkAbort.signal.aborted) send("error", { error: errorMsg });
        else send("stopped", {});
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
