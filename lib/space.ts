import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyToken } from "./auth";
import { spaces } from "./db";

// Set by an admin to browse another account's workspace ("view-as"). Honored
// ONLY when the authenticated account is an admin and the target exists — so a
// normal account can never use it to peek at someone else.
export const VIEW_AS_COOKIE = "mas-view-as";

export interface ViewContext {
  /** The logged-in account (who you really are). Null if unauthenticated. */
  authId: string | null;
  /** The space whose data is shown — the viewed account when an admin is
   *  viewing, otherwise the same as authId. All ownership checks use this. */
  spaceId: string;
  /** True when an admin is viewing someone else's workspace. */
  viewing: boolean;
}

export async function currentView(): Promise<ViewContext> {
  const c = await cookies();
  const authId = verifyToken(c.get("mas-token")?.value);
  if (!authId) return { authId: null, spaceId: "__no_account__", viewing: false };

  const viewAs = c.get(VIEW_AS_COOKIE)?.value;
  if (viewAs && viewAs !== authId && spaces.isAdmin(authId) && spaces.get(viewAs)) {
    return { authId, spaceId: viewAs, viewing: true };
  }
  return { authId, spaceId: authId, viewing: false };
}

// Mức B: the owner whose data the request operates on. For a normal account this
// is itself; for an admin in view-as mode it's the account being viewed. An
// invalid/absent token yields a sentinel that matches no task (fail closed).
export async function currentSpaceId(): Promise<string> {
  return (await currentView()).spaceId;
}

// Read-only guard for write routes: when an admin is viewing another account,
// block ALL mutations so browsing never alters the viewed person's data — they
// keep working as if nothing happened. Returns a 403 to return, or null to
// proceed. Call AFTER requireAuth.
export async function denyIfViewing(): Promise<NextResponse | null> {
  const { viewing } = await currentView();
  if (viewing) {
    return NextResponse.json({ error: "Viewing another account — read-only" }, { status: 403 });
  }
  return null;
}
