// Tests the model path of generatePatches against a local mock OpenAI-compatible server (no credits needed).
// npx tsx agents/test-llm.ts
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert";

const good = JSON.parse(readFileSync(new URL("./fixtures/good-patch.json", import.meta.url), "utf8"));
let calls = 0;
const srv = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    calls++;
    // call 1: prose (invalid); call 2: fenced valid JSON (retry works); call 3: syntax error; call 4: syntax error again -> fixture; later: bare JSON
    const body = (content: string) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
    if (calls === 1) return body("Sure! Here is my fix, no JSON though.");
    if (calls === 2) return body("```json\n" + JSON.stringify({ rationale: good.rationale, files: good.files }) + "\n```");
    if (calls === 3 || calls === 4) return body(JSON.stringify({ rationale: "broken", files: { "server.js": "const x = ;" } }));
    body(JSON.stringify({ rationale: good.rationale, files: good.files }));
  });
}).listen(0);
await new Promise((r) => srv.once("listening", r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
process.env.OPENROUTER_API_KEY = "test";
const { generatePatches } = await import("./index.js");
console.warn = () => {};
const patches = await generatePatches({ sourceFiles: { "server.js": "x" }, bugReport: "b", n: 2 });
assert.equal(patches.length, 2);
assert.ok(patches.every((p) => p.files["server.js"].includes("listen(")), "every patch has a server.js");
assert.deepEqual(patches.map((p) => p.id), ["patch-a", "patch-b"]);
console.log("mock model test OK: prose rejected+retried, fenced JSON parsed, bad syntax -> fixture fallback, calls =", calls);
srv.close(); process.exit(0);
