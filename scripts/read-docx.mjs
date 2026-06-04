// Quick text dump of a .docx for content QA. Run:
//   node scripts/read-docx.mjs <path-to-docx>

import mammoth from "mammoth";
const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/read-docx.mjs <docx>");
  process.exit(1);
}
const { value, messages } = await mammoth.extractRawText({ path: file });
console.log("=== DOCX TEXT ===");
console.log(value);
console.log("\n=== MAMMOTH MESSAGES ===");
for (const m of messages) console.log(m.type + ": " + m.message);
console.log("\nLength:", value.length);
