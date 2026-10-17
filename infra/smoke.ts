// Live check of the CreateOS wrapper: net -> base+red -> service -> pause -> 2 parallel forks -> attach -> egress -> attack by IP.
// Uses about 4 sandbox creations. Always cleans up.
import { loadConfig } from "../orchestrator/config.js";
import * as os from "../orchestrator/createos.js";

const cfg = loadConfig({ requireDb: false });
const client = os.makeClient(cfg);
const t0 = Date.now();
const lap = (label: string, since: number) => console.log(`${label}: ${((Date.now() - since) / 1000).toFixed(1)}s`);
const boxes: os.Box[] = [];
let netId: string | undefined;

const server = `let n=0;require('http').createServer((q,r)=>{n++;r.end(JSON.stringify({host:require('os').hostname(),count:n}))}).listen(8080,'0.0.0.0');`;

try {
  const net = await os.createNetwork(client, "smoke");
  netId = net.id;
  let s = Date.now();
  const [base, red] = await Promise.all([
    os.createBox(client, { name: "smoke-base", networkId: net.id }),
    os.createBox(client, { name: "smoke-red", networkId: net.id }),
  ]);
  boxes.push(base, red);
  lap("create base+red (parallel)", s);

  await os.pushFiles(base, {
    "/app/server.js": server,
    "/app/package.json": JSON.stringify({ name: "demo", scripts: { start: "node server.js" } }),
  });
  s = Date.now();
  const pid = await os.startService(base);
  lap("start service + port ready", s);
  const warm = await os.exec(red, "curl", ["-s", "-m", "5", `http://${base.ip}:8080`]);
  console.log("red -> base:", warm.stdout);

  s = Date.now();
  await os.pauseBox(base);
  lap("pause base", s);

  s = Date.now();
  const forks = await Promise.all([os.forkBox(base), os.forkBox(base)]);
  boxes.push(...forks);
  lap("fork x2 (parallel)", s);

  s = Date.now();
  await Promise.all(forks.map((f) => os.attachNetwork(f, net.id)));
  lap("attach both to network", s);

  for (const f of forks) {
    await os.setEgress(f, [red.ip, "example.com"]);
  }
  for (const f of forks) {
    const r = await os.exec(red, "curl", ["-s", "-m", "6", `http://${f.ip}:8080`]);
    const out = await os.exec(f, "sh", ["-c", "curl -s -o /dev/null -w '%{http_code}' -m 5 https://google.com || echo blocked"]);
    console.log(`red -> ${f.name} (${f.ip}):`, r.stdout, "| fork -> google:", out.stdout.trim());
  }
  console.log("quota during test:", await os.quota(client));
  void pid;
} finally {
  const s = Date.now();
  await Promise.allSettled(boxes.map((b) => os.destroyBox(b)));
  if (netId) await os.deleteNetwork(client, netId).catch((e) => console.log("network delete:", (e as Error).message));
  lap("cleanup", s);
  console.log("quota after:", await os.quota(client));
  lap("total", t0);
}
