import { NextResponse } from "next/server";
import { settings, getUserProfile, getProviderKeys } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { DEFAULT_FILE_EXPORT_RULE, DEFAULT_FILE_ROUTING_RULE } from "@/lib/employee-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings payload sent to the client. The API key is never returned in full —
 *  only a boolean flag saying whether it is configured. */
function settingsPayload() {
  const keys = getProviderKeys();
  return {
    ...getUserProfile(),
    responseStyle: settings.get("response_style") || "balanced",
    hasOpenrouterKey: keys.openrouter.length > 0,
    // Empty saved value = the agent uses the built-in default. We send the
    // default text alongside so the UI can show it (placeholder / reset).
    fileExportRule: settings.get("file_export_rule") || "",
    defaultFileExportRule: DEFAULT_FILE_EXPORT_RULE,
    fileRoutingRule: settings.get("file_routing_rule") || "",
    defaultFileRoutingRule: DEFAULT_FILE_ROUTING_RULE,
    // Auto-update: GitHub Releases repo (owner/repo) and optional PAT for
    // private repos. Token is never returned in full — only a configured flag.
    // Falls back to AGENT_P_UPDATE_REPO env var so distributors can ship a
    // pre-configured default that end users never have to set themselves.
    updateRepo: settings.get("update_repo") || (process.env.AGENT_P_UPDATE_REPO || "").trim(),
    hasUpdateGithubToken: (settings.get("update_github_token") || "").length > 0,
  };
}

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return NextResponse.json(settingsPayload());
}

export async function PUT(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = await req.json() as {
    name?: string;
    address?: string;
    responseStyle?: string;
    openrouterApiKey?: string;
    fileExportRule?: string;
    fileRoutingRule?: string;
    updateRepo?: string;
    updateGithubToken?: string;
  };
  if (body.name !== undefined) settings.set("user_name", body.name.trim() || "anh");
  if (body.address !== undefined) settings.set("user_address", body.address.trim() || "anh");
  if (body.responseStyle !== undefined) settings.set("response_style", body.responseStyle);
  // Key: an explicit empty string clears it; `undefined` leaves it alone.
  if (body.openrouterApiKey !== undefined) settings.set("openrouter_api_key", body.openrouterApiKey.trim());
  // File-export rule: empty string = revert to built-in default (no override).
  if (body.fileExportRule !== undefined) settings.set("file_export_rule", body.fileExportRule.trim());
  if (body.fileRoutingRule !== undefined) settings.set("file_routing_rule", body.fileRoutingRule.trim());
  if (body.updateRepo !== undefined) settings.set("update_repo", body.updateRepo.trim());
  if (body.updateGithubToken !== undefined) settings.set("update_github_token", body.updateGithubToken.trim());
  return NextResponse.json(settingsPayload());
}
