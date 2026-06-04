import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), ".data", "uploads");

export interface FileInfo {
  name: string;
  size: number;
  mtime: number;
}

export function workspaceDir(taskId: string): string {
  return path.join(ROOT, taskId);
}

export function ensureWorkspace(taskId: string): string {
  const dir = workspaceDir(taskId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listFiles(taskId: string): FileInfo[] {
  const dir = workspaceDir(taskId);
  if (!fs.existsSync(dir)) return [];
  const out: FileInfo[] = [];
  const walk = (sub: string) => {
    const abs = path.join(dir, sub);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        const st = fs.statSync(path.join(abs, entry.name));
        out.push({ name: rel, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk("");
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function saveFile(taskId: string, filename: string, data: Buffer): FileInfo {
  const dir = ensureWorkspace(taskId);
  const safe = sanitizeRelativePath(filename);
  const target = path.join(dir, safe);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  const st = fs.statSync(target);
  return { name: safe.split(path.sep).join("/"), size: st.size, mtime: st.mtimeMs };
}

export function readFile(taskId: string, filename: string): Buffer | null {
  const resolved = resolveFilePath(taskId, filename);
  if (!resolved) return null;
  return fs.readFileSync(resolved);
}

/** Resolve a workspace file to its absolute on-disk path (with traversal guard).
 *  Returns null if the path escapes the workspace or the file doesn't exist.
 *  Use this when an external process (e.g. the Python pptx engine) needs a real
 *  path rather than a buffer. */
export function resolveFilePath(taskId: string, filename: string): string | null {
  const safe = sanitizeRelativePath(filename);
  const target = path.join(workspaceDir(taskId), safe);
  const resolved = path.resolve(target);
  const base = path.resolve(workspaceDir(taskId));
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  if (!fs.existsSync(resolved)) return null;
  if (!fs.statSync(resolved).isFile()) return null;
  return resolved;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** rm -rf with retry. On Windows a just-killed Agent SDK subprocess can briefly
 *  keep a handle inside the workspace dir (its old cwd), so fs.rmSync throws
 *  EPERM/EBUSY even right after we signalled it to close. Retry a few times with
 *  backoff to let the OS release the handle. Lock errors are swallowed after the
 *  last attempt (best-effort: the boot-time sweep clears any leftover); other
 *  errors rethrow. Returns true only if the dir is actually gone. */
async function rmWithRetry(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw err;
      if (attempt === 4) return false; // still locked — leave for next-boot sweep
      await sleep(150 * (attempt + 1));
    }
  }
  return false;
}

export async function deleteWorkspace(taskId: string): Promise<boolean> {
  const dir = workspaceDir(taskId);
  const resolved = path.resolve(dir);
  const base = path.resolve(ROOT);
  if (!resolved.startsWith(base + path.sep)) return false;
  if (!fs.existsSync(resolved)) return false;
  return rmWithRetry(resolved);
}

/** Remove workspace folders whose task no longer exists in the DB — debris from
 *  past failed deletes (Windows EPERM left the folder after the row was gone).
 *  Call once on boot, when no subprocess holds a handle yet. Returns count
 *  removed. Folder name == taskId (see workspaceDir). */
export function sweepOrphanWorkspaces(validTaskIds: Set<string>): number {
  if (!fs.existsSync(ROOT)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || validTaskIds.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(ROOT, entry.name), { recursive: true, force: true });
      removed++;
    } catch { /* still locked somehow — try again next boot */ }
  }
  return removed;
}

export function deleteFile(taskId: string, filename: string): boolean {
  const safe = sanitizeRelativePath(filename);
  const target = path.join(workspaceDir(taskId), safe);
  const resolved = path.resolve(target);
  const base = path.resolve(workspaceDir(taskId));
  if (!resolved.startsWith(base + path.sep)) return false;
  if (!fs.existsSync(resolved)) return false;
  if (!fs.statSync(resolved).isFile()) return false;
  fs.unlinkSync(resolved);
  // Remove empty parent dirs back up to workspace root, so deleting the last
  // file in a subfolder doesn't leave a ghost folder in the UI.
  let parent = path.dirname(resolved);
  while (parent !== base && parent.startsWith(base + path.sep)) {
    try {
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      else break;
    } catch {
      break;
    }
    parent = path.dirname(parent);
  }
  return true;
}

// Allow subfolders in filenames (e.g. "reports/q1/summary.pdf") and Unicode
// characters (Vietnamese diacritics, etc.) — NTFS handles them fine. Strip
// only OS-forbidden ASCII chars and block ".." traversal. Forward and
// backslashes both treated as path separators; normalized to the OS separator.
// MUST stay in sync with `resolveOutput` in lib/office-mcp.ts so files
// written by tools are readable via /api/files/<taskId>/<path>.
function sanitizeRelativePath(name: string): string {
  if (!name) return "untitled";
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue; // strip traversal
    safe.push(part.replace(/[<>:"|?*\x00-\x1f]/g, "_"));
  }
  if (safe.length === 0) return "untitled";
  return safe.join(path.sep);
}
