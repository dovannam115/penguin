import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { settings } from "./db";

// Generated fresh on every server process boot. When start.bat is closed and
// reopened, this value changes, so every previously-issued mas-token cookie
// fails verifyToken() and the user is sent back to /login. Stored on
// globalThis so all Next.js bundles in the same process share it.
const g = globalThis as unknown as { __masBootToken?: string };
if (!g.__masBootToken) g.__masBootToken = randomBytes(32).toString("hex");
const bootToken = g.__masBootToken;

const PASSWORD_BACKUP_PATH = path.join(process.cwd(), "password-backup.txt");

function hash(password: string, salt: string): string {
  return createHash("sha256").update(salt + password).digest("hex");
}

export function hasPassword(): boolean {
  return !!settings.get("auth_hash");
}

export function setPassword(password: string): void {
  const salt = randomBytes(16).toString("hex");
  settings.set("auth_salt", salt);
  settings.set("auth_hash", hash(password, salt));
  writePasswordBackup(password);
}

function writePasswordBackup(password: string): void {
  try {
    const content = [
      "Penguin — Password Backup",
      "================================",
      "",
      "Mat khau:",
      "  " + password,
      "",
      "Ghi chu:",
      "  - File nay duoc tao tu dong khi set password.",
      "  - Quen mat khau? Mo file nay ra xem.",
      "  - Doi mat khau: xoa folder .data trong project, mo lai app, set lai.",
      "  - File nay khong bi dong goi khi chay 'npm run pack' (chia se).",
      "",
      "Created: " + new Date().toISOString(),
      "",
    ].join("\r\n");
    fs.writeFileSync(PASSWORD_BACKUP_PATH, content, "utf8");
  } catch {
    /* non-fatal: backup file is convenience, not a hard requirement */
  }
}

export function verifyPassword(password: string): string | null {
  const salt = settings.get("auth_salt");
  const stored = settings.get("auth_hash");
  if (!salt || !stored) return null;

  const attempt = hash(password, salt);
  const a = Buffer.from(attempt, "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Backfill the backup file for users who set their password before this
  // feature existed — only triggers if the file is missing.
  if (!fs.existsSync(PASSWORD_BACKUP_PATH)) writePasswordBackup(password);

  return bootToken;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(bootToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
