// One-off: wipe all chat history (tasks + messages + task sessions +
// workflow caches). Leaves employees, settings, password, and uploaded files
// alone. Useful when the user just wants a clean slate for chats.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, ".data", "office.db"));

db.exec(`DELETE FROM messages;`);
db.exec(`DELETE FROM task_sessions;`);
db.exec(`DELETE FROM tasks;`);
// Drop cached workflow maps (key prefix "workflow:")
db.exec(`DELETE FROM settings WHERE key LIKE 'workflow:%';`);

const t = db.prepare("SELECT COUNT(*) AS n FROM tasks").get();
const m = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
console.log(`tasks now: ${t.n}, messages now: ${m.n}`);
db.close();
