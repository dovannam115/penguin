import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { settings, spaces } from "./db";

// ── Mức B: per-account auth ───────────────────────────────────────────────
// Each "space" with a password is a login account. A session token binds the
// browser to one account id; every API route derives the current owner from
// this token (via currentSpaceId), so one account can never see another's
// tasks. Replaces the old single shared password.

// HMAC signing secret. Persisted in settings so sessions survive a server
// restart (people don't get logged out every reboot). Cached on globalThis so
// middleware and route bundles in the same process share one read.
const g = globalThis as unknown as { __masAuthSecret?: string };

function getSecret(): string {
  if (g.__masAuthSecret) return g.__masAuthSecret;
  let secret = settings.get("auth_server_secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    settings.set("auth_server_secret", secret);
  }
  g.__masAuthSecret = secret;
  return secret;
}

function hash(password: string, salt: string): string {
  return createHash("sha256").update(salt + password).digest("hex");
}

/** Sign an account id into a session token: `<accountId>.<hmac>`. */
export function issueToken(accountId: string): string {
  const sig = createHmac("sha256", getSecret()).update(accountId).digest("hex");
  return `${accountId}.${sig}`;
}

/** Validate a session token and return the account id it carries, or null. */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const accountId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(accountId).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return accountId;
}

/** True once at least one login account exists (drives setup vs login UI). */
export function hasAnyAccount(): boolean {
  return spaces.countAccounts() > 0;
}

export type AuthResult = { ok: true; token: string; name: string } | { ok: false; error: string };

function validate(name: string, password: string): string | null {
  if (!name.trim()) return "Username required";
  if (name.trim().length > 40) return "Username too long";
  if (!password || password.length < 4) return "Password must be at least 4 characters";
  return null;
}

/** Create a new account. The very first account adopts the legacy "Chung"
 *  tasks so the original user keeps their existing work. A pre-existing
 *  password-less space (left over from the Mức A picker) can be claimed by
 *  signing up with its name — this keeps any tasks already in it. */
export function signup(name: string, password: string): AuthResult {
  const err = validate(name, password);
  if (err) return { ok: false, error: err };

  const existing = spaces.getByName(name);
  if (existing && existing.passwordHash) {
    return { ok: false, error: "Username already taken" };
  }

  const isFirst = spaces.countAccounts() === 0;
  const id = existing ? existing.id : spaces.create(name).id;
  const salt = randomBytes(16).toString("hex");
  spaces.setCredentials(id, hash(password, salt), salt);
  if (isFirst) {
    // First account becomes the admin and is auto-approved; it also inherits
    // the legacy "Chung" tasks. Every later signup starts pending (approved=0)
    // until this admin approves it.
    spaces.adoptDefaultTasks(id);
    spaces.setAdminApproved(id);
  }

  return { ok: true, token: issueToken(id), name: existing ? existing.name : name.trim() };
}

/** Verify credentials and return a session token, or an error. */
export function login(name: string, password: string): AuthResult {
  const acct = spaces.getByName(name);
  if (!acct || !acct.passwordHash || !acct.salt) {
    return { ok: false, error: "Wrong username or password" };
  }
  const attempt = Buffer.from(hash(password, acct.salt), "hex");
  const stored = Buffer.from(acct.passwordHash, "hex");
  if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
    return { ok: false, error: "Wrong username or password" };
  }
  return { ok: true, token: issueToken(acct.id), name: acct.name };
}
