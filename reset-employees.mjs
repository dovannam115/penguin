// One-off: wipe all employees and message references so the next
// /api/bootstrap call re-runs ensureSeed() with the fresh roster.
// Tasks and messages are kept; messages whose fromId/toId pointed at a
// removed agent are nulled out (existing app already tolerates null).
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, ".data", "office.db"));

db.exec(`UPDATE messages SET from_id = NULL WHERE from_id IN (SELECT id FROM employees);`);
db.exec(`UPDATE messages SET to_id   = NULL WHERE to_id   IN (SELECT id FROM employees);`);
db.exec(`UPDATE tasks    SET assigned_to = NULL WHERE assigned_to IN (SELECT id FROM employees);`);
db.exec(`DELETE FROM employees;`);

const cnt = db.prepare("SELECT COUNT(*) AS n FROM employees").get();
console.log(`employees now: ${cnt.n}`);
db.close();
