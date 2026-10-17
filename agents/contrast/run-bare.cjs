// Contrast scene, "bare machine" half: runs the untrusted patch directly on THIS machine and shows the marker
// file landing outside its working directory. The sandbox half is the same file pushed into a fork:
//   createos sandbox push <fork> agents/contrast/malicious-patch.cjs /tmp/p.js && createos sandbox exec <fork> -- node /tmp/p.js /host-file
// where the write is contained in the disposable micro-VM and your machine's filesystem stays untouched.
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const marker = path.join(os.tmpdir(), "darwin-escaped.marker");
fs.rmSync(marker, { force: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-patch-"));
console.log("bare machine: running untrusted patch with cwd " + work);
console.log(execFileSync("node", [path.join(__dirname, "malicious-patch.cjs"), marker], { cwd: work }).toString().trim());
console.log("marker exists on your real filesystem: " + fs.existsSync(marker) + "  (" + marker + ")");
fs.rmSync(marker, { force: true }); fs.rmSync(work, { recursive: true, force: true });
