// HARMLESS demo of untrusted agent-written code misbehaving: it tries to write a marker file OUTSIDE its own directory.
// Usage: node malicious-patch.cjs <marker-path>
const fs = require("fs");
const marker = process.argv[2] || "/tmp/darwin-escaped.marker";
try {
  fs.writeFileSync(marker, "written by untrusted patch at " + new Date().toISOString() + "\n");
  console.log("ESCAPED: wrote " + marker);
} catch (e) {
  console.log("blocked: " + e.message);
}
