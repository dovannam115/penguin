import { readFile } from "node:fs/promises";
const BASE = process.env.BASE || "http://localhost:3000";
const PW = process.env.PW || "2101";
const htmlPath = process.argv[2];

const a = await fetch(BASE + "/api/auth", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PW }),
});
const setCookie = a.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
console.log("login:", a.status, "| cookie:", cookie ? cookie.slice(0, 20) + "..." : "(none)");
if (!cookie) { console.log(await a.text()); process.exit(1); }

const html = await readFile(htmlPath, "utf8");
const t0 = Date.now();
const r = await fetch(BASE + "/api/html-to-pptx", {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ taskId: "task_nativetest", html, mode: "native", filename: "native-api-test.pptx" }),
});
const j = await r.json();
console.log("export(native):", r.status, "in", ((Date.now() - t0) / 1000).toFixed(1) + "s");
console.log(JSON.stringify(j, null, 1));
