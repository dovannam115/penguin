import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { Employee, Message, Task } from "./types";
import { sweepOrphanWorkspaces } from "./upload";

const DB_DIR = path.join(process.cwd(), ".data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, "office.db");

let _db: DatabaseSync | null = null;

// --- Persona migration: SLIDE/DECK template-first exception ---------------
// Designers' personas carry a "DESIGN CHOICE PROTOCOL" that forces the
// design-choices box for every design file. For SLIDE/DECK requests we instead
// want template-first (show the template menu, no theme/style/accent box). This
// must reach EXISTING users too (their DB was seeded once and never re-seeds),
// so we patch personas on boot, version-gated + idempotent. Bump VERSION when
// the SLIDE_EXC text changes to re-apply. Keep SLIDE_EXC identical to seed.ts.
const SLIDE_EXC_VERSION = "3";
const SLIDE_EXC =
  'NGOẠI LỆ SLIDE/DECK (ưu tiên cao nhất, áp TRƯỚC mọi quy tắc dưới): nếu user xin SLIDE / DECK / bài thuyết trình mà CHƯA chọn template → TUYỆT ĐỐI KHÔNG bắn box design-choices. Thay vào đó gọi slide_template() (không tham số) để lấy danh sách mẫu, rồi đưa user: (a) chèn Y NGUYÊN dòng sau để hiện NÚT mở menu (KHÔNG bọc backtick/code, giữ nhãn TIẾNG ANH y nguyên): [Open template menu](#mas-open-template) (bấm là mở menu preview trong trình duyệt); (b) liệt kê ngắn tên các mẫu để chọn theo số/tên. TUYỆT ĐỐI KHÔNG dùng URL http/localhost/port. Hỏi user chọn mẫu nào hoặc "thiết kế tự do". CHỈ khi user chọn "thiết kế tự do" mới dùng box design-choices. Box design-choices (theme/style/accent) bên dưới CHỈ dành cho design file KHÔNG phải slide (dashboard, report layout, web mockup...) hoặc slide tự-do.';
const SLIDE_EXC_MARKER = "NGOẠI LỆ SLIDE/DECK";
const SLIDE_EXC_FOLLOW = "BẮT BUỘC hiện box choices trước khi build";

/** Insert/refresh the slide exception inside one persona. Returns the new text,
 *  or null if this persona has no DESIGN CHOICE PROTOCOL or is already current. */
function patchSlidePersona(p: string): string | null {
  if (!p.includes("DESIGN CHOICE PROTOCOL")) return null;
  let work = p;
  let fIdx = work.indexOf(SLIDE_EXC_FOLLOW);
  if (fIdx < 0) return null;
  const mIdx = work.indexOf(SLIDE_EXC_MARKER);
  if (mIdx >= 0 && mIdx < fIdx) {
    // strip any existing exception block [marker .. follow) before re-inserting
    work = work.slice(0, mIdx) + work.slice(fIdx);
    fIdx = work.indexOf(SLIDE_EXC_FOLLOW);
  }
  const next = work.slice(0, fIdx) + SLIDE_EXC + "\n\n" + work.slice(fIdx);
  return next === p ? null : next;
}

function migrateSlideException(d: DatabaseSync): void {
  const cur = (d.prepare(`SELECT value FROM settings WHERE key=?`).get("migration:slide_exc") as { value?: string } | undefined)?.value;
  if (cur === SLIDE_EXC_VERSION) return;
  const rows = d.prepare(`SELECT id, system_prompt FROM employees`).all() as { id: string; system_prompt: string }[];
  let n = 0;
  for (const r of rows) {
    const next = patchSlidePersona(r.system_prompt);
    if (next) { d.prepare(`UPDATE employees SET system_prompt=? WHERE id=?`).run(next, r.id); n++; }
  }
  d.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run("migration:slide_exc", SLIDE_EXC_VERSION);
  if (n > 0) console.log(`[boot] patched slide-template exception into ${n} persona(s)`);
}

export function db(): DatabaseSync {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`PRAGMA journal_mode = WAL;`);
  migrate(_db);
  // NOTE: we deliberately KEEP task_sessions across restarts. Earlier this
  // table was wiped on every boot, on the belief that the SDK's on-disk session
  // transcript "does not reliably resume across a restart" and a stale resume id
  // silently restores an EMPTY conversation. That was a MISDIAGNOSIS of the old
  // empty-pre-warm bug (a context-less pre-warmed session got its id stored,
  // then resumed empty) — since fixed by dropping the open-existing-task
  // pre-warm. Verified 2026-05-28: resuming a real pre-restart session
  // (task_ybx38zo8) recalled full detail incl. tool-call results — exactly how
  // `claude --resume` works. The boot-wipe was the actual amnesia cause: it
  // discarded the valid resume id, fragmented each task into a new session per
  // restart, and forced the lossy buildEmployeeMemory reconstruction (last 30
  // msgs, 600 char cap, zero tool/file context). If a resume id ever points at
  // a missing/corrupt transcript, claude.ts's catch clears it and the retry
  // falls back to reconstruction — so keeping the table is safe.
  // Boot-time cleanup: remove workspace folders left behind by past failed
  // deletes (Windows EPERM left the folder after the SQLite row was gone). Runs
  // once per process — no subprocess holds a handle yet, so rm-rf succeeds here.
  try {
    const ids = new Set((_db.prepare(`SELECT id FROM tasks`).all() as { id: string }[]).map((r) => r.id));
    const swept = sweepOrphanWorkspaces(ids);
    if (swept > 0) console.log(`[boot] swept ${swept} orphan workspace folder(s)`);
  } catch (err) { console.warn("[boot] orphan workspace sweep failed", err); }
  // Ship the SLIDE/DECK template-first persona fix to existing users too.
  try { migrateSlideException(_db); } catch (err) { console.warn("[boot] slide-exception migration failed", err); }
  return _db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      avatar_color TEXT NOT NULL DEFAULT '#7dd3fc',
      emoji TEXT NOT NULL DEFAULT '👤',
      x REAL NOT NULL DEFAULT 100,
      y REAL NOT NULL DEFAULT 100,
      is_manager INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- Reporting hierarchy: who this employee reports to (NULL = reports directly to user).
    -- Added later; idempotent via try/catch below for existing DBs.
  `);
  // Add column if it doesn't exist (SQLite has no IF NOT EXISTS for ALTER TABLE).
  try {
    d.exec(`ALTER TABLE employees ADD COLUMN manager_id TEXT REFERENCES employees(id) ON DELETE SET NULL;`);
  } catch {
    /* column already exists */
  }
  try {
    d.exec(`ALTER TABLE employees ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';`);
  } catch {
    /* column already exists */
  }
  try {
    d.exec(`ALTER TABLE employees ADD COLUMN is_prompt_engineer INTEGER NOT NULL DEFAULT 0;`);
  } catch {
    /* column already exists */
  }
  try {
    // User-customizable display order in the sidebar (drag to rearrange).
    // REAL so we can splice in fractional positions without re-numbering all
    // rows. Default to created_at on backfill so existing installs keep their
    // current ordering.
    d.exec(`ALTER TABLE employees ADD COLUMN sort_order REAL;`);
    d.exec(`UPDATE employees SET sort_order = created_at WHERE sort_order IS NULL;`);
  } catch {
    /* column already exists */
  }
  try {
    d.exec(`ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]';`);
  } catch {
    /* column already exists */
  }
  try {
    d.exec(`ALTER TABLE messages ADD COLUMN files TEXT NOT NULL DEFAULT '[]';`);
  } catch {
    /* column already exists */
  }
  try {
    d.exec(`ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`);
  } catch {
    /* column already exists */
  }
  d.exec(`

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      mode TEXT NOT NULL DEFAULT 'manual',
      assigned_to TEXT,
      created_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      from_id TEXT,
      to_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      images TEXT NOT NULL DEFAULT '[]',
      files TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_employee ON messages(to_id, from_id, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔧',
      category TEXT NOT NULL DEFAULT 'ops',
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );

    -- One Agent SDK session per (task, employee). Letting the SDK carry
    -- conversation history server-side (via resume) avoids re-injecting the
    -- full memory transcript every turn — same trick Claude Code CLI uses.
    CREATE TABLE IF NOT EXISTS task_sessions (
      task_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, employee_id)
    );

    -- User-edited overrides for built-in skills from skills-library.ts.
    -- Row presence = user customized this skill; absence = use built-in.
    -- Only stores the fields the user actually changed; NULL = inherit.
    -- Removing the row resets to the library default.
    CREATE TABLE IF NOT EXISTS skill_overrides (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      prompt TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

export const taskSessions = {
  // Defensive try/catch: the table is created in migrate() which only runs once
  // per Node process. If user upgraded without restarting the dev server, the
  // table won't exist yet — silently degrade to no-resume rather than crash.
  get(taskId: string, employeeId: string): string | null {
    try {
      const r = db()
        .prepare(`SELECT session_id FROM task_sessions WHERE task_id=? AND employee_id=?`)
        .get(taskId, employeeId) as { session_id: string } | undefined;
      return r?.session_id ?? null;
    } catch { return null; }
  },
  set(taskId: string, employeeId: string, sessionId: string) {
    try {
      db()
        .prepare(`
          INSERT INTO task_sessions (task_id, employee_id, session_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id, employee_id) DO UPDATE SET
            session_id = excluded.session_id, updated_at = excluded.updated_at
        `)
        .run(taskId, employeeId, sessionId, Date.now());
    } catch { /* table missing — no-op until restart */ }
  },
  clear(taskId: string, employeeId: string) {
    try {
      db()
        .prepare(`DELETE FROM task_sessions WHERE task_id=? AND employee_id=?`)
        .run(taskId, employeeId);
    } catch { /* same */ }
  },
  clearAllForEmployee(employeeId: string) {
    // Called when the employee's model (or any capability that the SDK CLI
    // session is pinned to) changes. Resume-ing a session originally started
    // on model X cannot switch to model Y mid-conversation, so every existing
    // resume id for this employee has to go.
    try {
      db().prepare(`DELETE FROM task_sessions WHERE employee_id=?`).run(employeeId);
    } catch { /* same */ }
  },
};

export const settings = {
  get(key: string): string | null {
    const r = db().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value ?? null;
  },
  set(key: string, value: string) {
    db().prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  },
  all(): Record<string, string> {
    const rows = db().prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
};

export interface UserProfile {
  name: string;     // displayed e.g. "Nam"
  address: string;  // how AI calls user e.g. "anh"
}

export function getUserProfile(): UserProfile {
  return {
    name: settings.get("user_name") || "anh",
    address: settings.get("user_address") || "anh",
  };
}

export interface ProviderKeys {
  openrouter: string;
}

/** API keys for non-Claude model providers. Empty string = not configured.
 *  OpenRouter is the single non-Claude provider (it proxies Gemini etc.). */
export function getProviderKeys(): ProviderKeys {
  return {
    openrouter: settings.get("openrouter_api_key") || "",
  };
}

type Row = Record<string, unknown>;

function mapEmployee(r: Row): Employee {
  return {
    id: r.id as string,
    name: r.name as string,
    role: r.role as string,
    systemPrompt: r.system_prompt as string,
    model: r.model as Employee["model"],
    avatarColor: r.avatar_color as string,
    emoji: r.emoji as string,
    x: r.x as number,
    y: r.y as number,
    isPromptEngineer: (r.is_prompt_engineer as number | undefined) ?? 0,
    skills: (() => {
      try { return JSON.parse((r.skills as string) ?? "[]") as string[]; }
      catch { return []; }
    })(),
    sessionId: (r.session_id as string | null) ?? null,
    sortOrder: (r.sort_order as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function mapTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    status: r.status as Task["status"],
    mode: r.mode as Task["mode"],
    assignedTo: (r.assigned_to as string | null) ?? null,
    pinned: !!(r.pinned as number | undefined),
    createdAt: r.created_at as number,
  };
}

function mapMessage(r: Row): Message {
  return {
    id: r.id as string,
    taskId: (r.task_id as string | null) ?? null,
    fromId: (r.from_id as string | null) ?? null,
    toId: (r.to_id as string | null) ?? null,
    role: r.role as Message["role"],
    content: r.content as string,
    mentions: JSON.parse((r.mentions as string) || "[]"),
    images: JSON.parse((r.images as string) || "[]"),
    files: JSON.parse((r.files as string) || "[]"),
    createdAt: r.created_at as number,
  };
}

export const employees = {
  list(): Employee[] {
    // sort_order is user-controlled (drag to reorder); created_at is the tie-
    // breaker so newly-created agents land at the end stably.
    return (db().prepare(
      `SELECT * FROM employees ORDER BY sort_order ASC NULLS LAST, created_at ASC`,
    ).all() as Row[]).map(mapEmployee);
  },
  reorder(orderedIds: string[]) {
    // node:sqlite has no .transaction() helper — wrap manually with BEGIN/COMMIT
    // so a partial update doesn't leave half-applied sort_order values.
    const d = db();
    const stmt = d.prepare(`UPDATE employees SET sort_order = ? WHERE id = ?`);
    d.exec("BEGIN");
    try {
      orderedIds.forEach((id, idx) => stmt.run(idx, id));
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
  },
  get(id: string): Employee | null {
    const r = db().prepare(`SELECT * FROM employees WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapEmployee(r) : null;
  },
  getByName(name: string): Employee | null {
    const r = db().prepare(`SELECT * FROM employees WHERE LOWER(name) = LOWER(?)`).get(name) as Row | undefined;
    return r ? mapEmployee(r) : null;
  },
  create(e: Omit<Employee, "createdAt">): Employee {
    const createdAt = Date.now();
    // is_manager / manager_id columns still exist on the legacy schema with
    // DEFAULT 0 / NULL — we just stopped writing to them.
    db().prepare(`
      INSERT INTO employees (id, name, role, system_prompt, model, avatar_color, emoji, x, y, is_prompt_engineer, skills, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, e.name, e.role, e.systemPrompt, e.model, e.avatarColor, e.emoji, e.x, e.y, e.isPromptEngineer ?? 0, JSON.stringify(e.skills ?? []), e.sessionId, createdAt);
    return { ...e, createdAt };
  },
  update(id: string, patch: Partial<Employee>) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    db().prepare(`
      UPDATE employees SET name=?, role=?, system_prompt=?, model=?, avatar_color=?, emoji=?, x=?, y=?, is_prompt_engineer=?, skills=?, session_id=?
      WHERE id=?
    `).run(next.name, next.role, next.systemPrompt, next.model, next.avatarColor, next.emoji, next.x, next.y, next.isPromptEngineer ?? 0, JSON.stringify(next.skills ?? []), next.sessionId, id);
    return next;
  },
  remove(id: string) {
    db().prepare(`DELETE FROM employees WHERE id=?`).run(id);
    db().prepare(`UPDATE messages SET from_id=NULL WHERE from_id=?`).run(id);
    db().prepare(`UPDATE messages SET to_id=NULL WHERE to_id=?`).run(id);
  },
};

export const tasks = {
  list(): Task[] {
    return (db().prepare(`SELECT * FROM tasks ORDER BY pinned DESC, created_at DESC LIMIT 100`).all() as Row[]).map(mapTask);
  },
  get(id: string): Task | null {
    const r = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapTask(r) : null;
  },
  create(t: Omit<Task, "createdAt" | "pinned">): Task {
    const createdAt = Date.now();
    db().prepare(`
      INSERT INTO tasks (id, title, description, status, mode, assigned_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(t.id, t.title, t.description, t.status, t.mode, t.assignedTo, createdAt);
    return { ...t, pinned: false, createdAt };
  },
  setStatus(id: string, status: Task["status"]) {
    db().prepare(`UPDATE tasks SET status=? WHERE id=?`).run(status, id);
  },
  setTitle(id: string, title: string) {
    db().prepare(`UPDATE tasks SET title=? WHERE id=?`).run(title, id);
  },
  setPinned(id: string, pinned: boolean) {
    db().prepare(`UPDATE tasks SET pinned=? WHERE id=?`).run(pinned ? 1 : 0, id);
  },
  remove(id: string) {
    const d = db();
    d.prepare(`DELETE FROM messages WHERE task_id=?`).run(id);
    d.prepare(`DELETE FROM tasks WHERE id=?`).run(id);
    // Drop the cached workflow map for this task, if any.
    d.prepare(`DELETE FROM settings WHERE key=?`).run(`workflow:${id}`);
  },
};

// Reclaim disk space after bulk deletes.
// wal_checkpoint(TRUNCATE) flushes WAL to main file then truncates it to 0.
// VACUUM rebuilds the DB file to actually release freed pages back to disk.
export function compactDb() {
  const d = db();
  try { d.exec(`PRAGMA wal_checkpoint(TRUNCATE);`); } catch { /* ignore */ }
  try { d.exec(`VACUUM;`); } catch { /* VACUUM fails if a tx is open; safe to skip */ }
}

// ─── Custom skills (user-imported, stored in DB alongside built-in library) ───
export interface CustomSkillRow {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  prompt: string;
  source: string;
  createdAt: number;
}

export const customSkills = {
  list(): CustomSkillRow[] {
    return (db().prepare(`SELECT * FROM custom_skills ORDER BY created_at DESC`).all() as Row[]).map(r => ({
      id: r.id as string,
      name: r.name as string,
      icon: r.icon as string,
      category: r.category as string,
      description: r.description as string,
      prompt: r.prompt as string,
      source: r.source as string,
      createdAt: r.created_at as number,
    }));
  },
  get(id: string): CustomSkillRow | null {
    const r = db().prepare(`SELECT * FROM custom_skills WHERE id=?`).get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      icon: r.icon as string,
      category: r.category as string,
      description: r.description as string,
      prompt: r.prompt as string,
      source: r.source as string,
      createdAt: r.created_at as number,
    };
  },
  create(s: Omit<CustomSkillRow, "createdAt">): CustomSkillRow {
    const createdAt = Date.now();
    db().prepare(`
      INSERT INTO custom_skills (id, name, icon, category, description, prompt, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, s.name, s.icon, s.category, s.description, s.prompt, s.source, createdAt);
    return { ...s, createdAt };
  },
  update(id: string, patch: Partial<{ name: string; icon: string; category: string; description: string; prompt: string }>): CustomSkillRow | null {
    const cur = db().prepare(`SELECT * FROM custom_skills WHERE id=?`).get(id) as Row | undefined;
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name as string,
      icon: patch.icon ?? cur.icon as string,
      category: patch.category ?? cur.category as string,
      description: patch.description ?? cur.description as string,
      prompt: patch.prompt ?? cur.prompt as string,
    };
    db().prepare(`UPDATE custom_skills SET name=?, icon=?, category=?, description=?, prompt=? WHERE id=?`)
      .run(next.name, next.icon, next.category, next.description, next.prompt, id);
    return {
      id,
      name: next.name,
      icon: next.icon,
      category: next.category,
      description: next.description,
      prompt: next.prompt,
      source: cur.source as string,
      createdAt: cur.created_at as number,
    };
  },
  remove(id: string) {
    db().prepare(`DELETE FROM custom_skills WHERE id=?`).run(id);
  },
};

export interface SkillOverride {
  id: string;
  name: string | null;
  description: string | null;
  prompt: string | null;
  updatedAt: number;
}

/** Per-skill overrides for the built-in skills in lib/skills-library.ts. */
export const skillOverrides = {
  list(): SkillOverride[] {
    try {
      const rows = db().prepare(`SELECT * FROM skill_overrides`).all() as Row[];
      return rows.map(r => ({
        id: r.id as string,
        name: (r.name ?? null) as string | null,
        description: (r.description ?? null) as string | null,
        prompt: (r.prompt ?? null) as string | null,
        updatedAt: r.updated_at as number,
      }));
    } catch { return []; }
  },
  get(id: string): SkillOverride | null {
    try {
      const r = db().prepare(`SELECT * FROM skill_overrides WHERE id=?`).get(id) as Row | undefined;
      if (!r) return null;
      return {
        id: r.id as string,
        name: (r.name ?? null) as string | null,
        description: (r.description ?? null) as string | null,
        prompt: (r.prompt ?? null) as string | null,
        updatedAt: r.updated_at as number,
      };
    } catch { return null; }
  },
  set(id: string, patch: { name?: string | null; description?: string | null; prompt?: string | null }) {
    const cur = skillOverrides.get(id);
    const next = {
      name: patch.name !== undefined ? patch.name : cur?.name ?? null,
      description: patch.description !== undefined ? patch.description : cur?.description ?? null,
      prompt: patch.prompt !== undefined ? patch.prompt : cur?.prompt ?? null,
    };
    db().prepare(`
      INSERT INTO skill_overrides (id, name, description, prompt, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        prompt = excluded.prompt,
        updated_at = excluded.updated_at
    `).run(id, next.name, next.description, next.prompt, Date.now());
  },
  remove(id: string) {
    db().prepare(`DELETE FROM skill_overrides WHERE id=?`).run(id);
  },
};

export const messages = {
  listByTask(taskId: string): Message[] {
    return (db().prepare(`SELECT * FROM messages WHERE task_id=? ORDER BY created_at ASC`).all(taskId) as Row[]).map(mapMessage);
  },
  listRecent(limit = 50): Message[] {
    return (db().prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]).map(mapMessage).reverse();
  },
  get(id: string): Message | null {
    const r = db().prepare(`SELECT * FROM messages WHERE id=?`).get(id) as Row | undefined;
    return r ? mapMessage(r) : null;
  },
  create(m: Omit<Message, "createdAt">): Message {
    const createdAt = Date.now();
    db().prepare(`
      INSERT INTO messages (id, task_id, from_id, to_id, role, content, mentions, images, files, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(m.id, m.taskId, m.fromId, m.toId, m.role, m.content, JSON.stringify(m.mentions), JSON.stringify(m.images ?? []), JSON.stringify(m.files ?? []), createdAt);
    return { ...m, createdAt };
  },
  updateContent(id: string, content: string) {
    db().prepare(`UPDATE messages SET content=? WHERE id=?`).run(content, id);
  },
  deleteAfterInTask(taskId: string, afterCreatedAt: number): number {
    const r = db().prepare(`DELETE FROM messages WHERE task_id=? AND created_at > ?`).run(taskId, afterCreatedAt);
    return Number(r.changes);
  },
};
