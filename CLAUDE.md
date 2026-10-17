# CLAUDE.md: Fork Race + Red Team

Hackathon: **CreateOS x Stripe Projects: Build Agents That Run Code**, Sat Oct 17, all times PT.
Team of two, working in parallel: **Part A** and **Part B**. Each person runs their own coding agent. **Read this whole file, then ask your human which part they own and stay inside it.**

## 0. Hard facts (do not violate)

| Item | Detail |
|---|---|
| Kickoff | 12:00 PM. Build starts 12:30 PM |
| **Submissions lock** | **5:30 PM. No commits or edits after this count** |
| Demos | 6:00 PM, top 5 teams present live, judges pick top 3 |
| Eligibility | Project must be **new, built during the hackathon**, and must use **both Stripe Projects and the CreateOS Sandbox** |
| Not judged if missing | 2-3 min demo video (YouTube, a team member on camera), public GitHub repo with README, public X/LinkedIn post tagging @createosai (CreateOS on LinkedIn), entry at projects.dev/leaderboard with code `CreateOS-2026`, team and project details in the submission form (forms.gle link from the organizers' email) |
| Prizes | $10k total, $5k cash + $5k CreateOS credits (1st $2.5k+$2.5k, 2nd $1.5k+$1.5k, 3rd $1k+$1k) |
| Help | Discord #support, hello@createos.sh, docs at https://createos.sh/docs/Sandbox/Overview/ |

Do not create the project repo before 12:30 PM. Before kickoff, only install tools and run throwaway tests in a scratch directory.

## 1. The project in one paragraph

We give an agent a buggy Stripe-webhook service (it double-processes duplicate webhook events). The service runs in a **base CreateOS sandbox**, which we **pause and fork** into N copies. A **builder agent** writes a different fix in each fork. A **red-team agent**, running in its own sandbox on a private network, attacks every fork (duplicate, concurrent, malformed and replayed webhooks). A **judge** scores the results, kills the forks that fail, and promotes the survivor. A **live UI** shows the fork tree as branches live and die. Run history is stored in **Neon Postgres**. The whole stack is provisioned with **Stripe Projects**.

Pitch line: *"Four fixes race, a red team attacks each one in an isolated micro-VM, and only the fix that survives gets promoted. None of the agent-written code ever touches a real machine."*

This combines two items on the organizers' idea list ("Fork-and-race fixer" and "Red team with proof"), so we win on demo clarity and on real Stripe Projects usage.

### Why a sandbox
Agent-written patches and attack scripts are untrusted code. On a laptop they run with the user's keys and files; a permission prompt is a policy, not a boundary. In a CreateOS micro-VM, code gets its **own kernel**, an **egress allowlist**, no inbound access and a disposable VM. A **fork** also copies RAM and running processes, which a git worktree cannot. Make this point clearly in the README and demo.

## 2. Glossary

- **Stripe Projects**: a Stripe CLI plugin that provisions third-party services (CreateOS, Neon, OpenRouter, ...) from the terminal and syncs credentials into `.env`. State lives in `.projects/`. It is NOT a payments API.
- **CreateOS Sandbox**: Firecracker micro-VMs (own kernel, about 30 ms boot), controlled through a REST API, a TypeScript SDK (Node 20+) and the CLI (`createos sandbox ...`, alias `sb`).
- **Fork**: a clone of a **paused** sandbox. The pause snapshot includes disk, RAM and processes, so the fork starts with the service already running. Each fork gets its own ID and IP. Pause, resume and fork are **asynchronous**: they return 202 with a transitional status (`pausing`, `forking`, ...) and you poll `GET /v1/sandboxes/{id}` until the status is `paused` or `running` (honor the `X-Poll-After` header). Fork requires a paused source; S3 mounts do not carry over; SSH keys and egress rules are configurable on the fork.
- **Egress allowlist**: restricts a sandbox's outbound traffic to listed hostnames, IPs or CIDRs (`sandbox firewall set`). Everything else is blocked.
- **Neon**: serverless Postgres, our run-history store. Provisioned through Stripe Projects. Look up the exact catalog name with `stripe projects catalog`.
- **Private network**: `sandbox network create` and `sandbox network attach`. Sandboxes on one network reach each other **by IP** (for example `http://10.0.60.70:8080`). The docs say by name, but that failed in testing (see 3.2a).

**CLI gotchas found in testing (CLI v0.0.31):**
- `sandbox create` requires `--rootfs` (`alpine:3.20` default, `debian:13`, `ubuntu:26.04`, `devbox:1`, `desktop:1`). Use `devbox:1` for Node/Docker; list with `createos sandbox rootfs`.
- `sandbox fork [<sandbox>] [--paused] [--egress ...] [--ssh-key ...]` has **no `--name` flag**. Read the new ID/name from its output or `sandbox list`.
- Other `create` flags: `--ingress` (public HTTPS URL), `--egress` (repeatable allowlist), `--network`, `--env KEY=VALUE`, `--auto-pause 10m`.
- Use `-o json` before the subcommand (`createos -o json sandbox list`) for machine-readable output. Human mode prints spinner escape codes.
- `sandbox rm` asks for confirmation; pass `--force` in scripts.
- Don't leave background processes holding stdout in `exec` (for example `(sleep 3000 &)`); the call can hang. Use `process start` for long-running services.
- Measured: create spawn about 42 ms, `exec` round trip about 1.6 s, `pause` about 4.3 s. Fork latency is still unmeasured (blocked by the quota).
- Auth: `createos login`, check with `createos whoami`. Or `--api-key` / `CREATEOS_API_KEY`.

CLI commands we use: `sandbox create | list | get | edit | pause | resume | fork | rm | exec | push | pull | firewall set | network create/attach/detach | process start/run/stop`. Output is capped at 1 MiB per process and 32 MiB per sandbox. Push limit is 500 MB per file.

## 3. Architecture

```
Stripe Projects setup -> .env  (CreateOS, Neon, OpenRouter creds)
        |
ORCHESTRATOR (TypeScript, runs on host)   <-- Part A
   | drives CreateOS, calls Part B's agent functions, writes Neon, serves /api
   v
BASE SANDBOX: buggy webhook service running  --pause-->  snapshot
   v
FORK x N  (own kernel, egress allowlist, same private network)
   builder patch applied to each  (push files + restart service)
   v
RED-TEAM SANDBOX (same private network)
   attack script hits http://<fork-ip>:8080 for each fork (names don't resolve)
   v
JUDGE: score each fork, kill failures, promote survivor
   v
Neon (runs, branches, attacks, events)  <--  UI (reads /api)   <-- Part B
```

Only the optional Stripe test-event trigger needs a public URL (enable ingress on one sandbox). Attacks stay on the private network.

### 3.1 Quota budget (design constraint)

On Beginner we get **5 concurrent sandboxes (paused ones count)** and **50 sandbox creations per rolling 24 h**.
- Race layout: **3 forks + 1 red-team = 4 live**, plus the base. Keep the base paused only while forking, then **delete the base after the forks exist** (or keep it paused: 1 + 3 + 1 = 5, zero headroom). Default `N = 3`; `N = 4` only if the base is deleted.
- **Reuse the red-team sandbox across races** (just re-push the attack script) instead of recreating it.
- **Each race costs about N creations** (3 forks, plus the base on a cold start). Budget about 8-10 full races a day in total, including dry runs. Don't burn them on experiments: use the fixtures and stubs for UI and agent work, and pre-warm the base once.
- The cleanup script must delete leftovers after every run, or the concurrency cap will block the next race.

### 3.2 Verified CreateOS facts (docs: https://createos.sh/docs/Sandbox/...)

- **Isolation:** Firecracker micro-VM, egress enforced outside the VM in the kernel.
- **Egress:** empty list = open. Once any rule exists, **only listed destinations pass**. Formats: `host`, `host:443`, `*.pythonhosted.org`, `1.2.3.4`, `10.0.0.0/8:8080`, `*` for all. Set at creation (`--egress`, enforced before any code runs) or live via `PUT /v1/sandboxes/{id}/egress`. Networks are separate from egress controls; check that the private-network traffic still works once egress is restricted.
- **Private network:** `POST /v1/networks {name}`, attach with `POST /v1/sandboxes/{id}/networks {id}` or at create time. Peers reach each other at `http://<sandbox-name>:<port>`. Different networks cannot reach each other. Deleting a network requires no members.
- **Ingress:** sandbox needs `ingress_enabled` (CLI `--ingress`, SDK `setIngress(true)`). The server **must bind `0.0.0.0`, not localhost**. SDK: `sandbox.previewUrl(port, {scheme:"http"})` (use `http` unless the wildcard domain has TLS), `waitForPortReady(port)`. Unknown whether preview URLs work on forks or wake paused sandboxes.
- **Pause/fork:** snapshot is disk + RAM + CPU state; source must be paused to fork; fork gets a new ID and IP; S3 attachments don't carry over; ops are async (202 then poll).
- **Shapes:** 9 of them, `s-0.25vcpu-512mb` up to `s-4vcpu-8gb`, 10 GiB default disk. Use `s-1vcpu-1gb` or smaller. Time to interactive about 210 ms median.
- **Limits:** env vars 64 keys / 4 KiB per value; 50 GiB bandwidth per sandbox; exec output 1 MiB.
- **Billing:** per second of vCPU/RAM/disk; paused sandboxes stop compute charges but still bill memory and storage.

### 3.2.0 Sandbox endpoint: we use the DEFAULT, not EU (decision made on the day)

The organizers asked everyone on Discord to use **`https://api-eu.sb.createos.sh`** (and said it was necessary). After many live races we moved the project to the **default `https://api.sb.createos.sh`** because the EU host stalled often on pause, fork and resume (about 1 in 3 operations ran past 75 s; one hung 10 minutes). **This goes against the organizers' instruction; if they object or eligibility depends on it, switch back by setting both variables below to the EU URL (nothing else changes).** Never mix endpoints inside one run: sandboxes created on one host may not appear on the other.
- **CLI:** `CREATEOS_SANDBOX_URL=https://api.sb.createos.sh` (flag `--sandbox-api-url`). **SDK:** `CREATEOS_SANDBOX_BASE_URL=...` or `createClient({ baseUrl })`. **REST:** `<base>/v1/...` with header `X-Api-Key`.
- The orchestrator reads `CREATEOS_SANDBOX_BASE_URL` / `CREATEOS_SANDBOX_URL` from `.env` (default: the standard host). Stripe Projects holds them as project variables (`createos-sandbox-url`, `createos-sandbox-base-url`); `stripe projects env --pull` rewrites `.env`, but **do not run it blindly**: it also resets `OPENROUTER_API_KEY` to the OpenRouter key, overwriting the Gemini key we put there.
- Measured on each host (one sample each, so indicative only): default endpoint pause about 5.5 s and fork about 5.4 s; EU pause 8-15 s and fork 10-16 s with frequent stalls. Behavior (network attach, egress, RAM copy) was identical.

### 3.2a LIVE-TESTED behavior (pre-kickoff, CLI v0.0.31, `devbox:1`, `s-1vcpu-1gb`). These override the docs where they differ

| Test | Result |
|---|---|
| Create | about 0.7-0.8 s wall time (spawn about 30 ms) |
| Pause (with a running node server) | about 5.5 s |
| **Fork** | **about 5.3-5.5 s each**, comes back `running` |
| Fork copies RAM + processes | **Yes.** The node server kept running in the fork and its in-memory counter continued from the base's value (3 -> 4). Each fork then diverges independently |
| Delete base after forking | Forks keep working |
| **Concurrency cap** | **5**, paused sandboxes count. 6th -> `sandbox concurrent quota reached (5 / 5)` (fast error) |
| Fork that lands exactly on the cap | **Hung**: the CLI waited more than 240 s and the fork was left `paused`. Always use timeouts; keep 1 slot of headroom, or fork with `start_paused` and resume explicitly |
| **Private-network DNS by name** | **Does NOT work.** `curl http://fr-base:8080` -> `Could not resolve host` (NXDOMAIN at 169.254.20.10). The docs' `http://<name>:8080` claim failed |
| Private network by IP | Works. Get member IPs from `createos -o json sandbox network show <net>` (or `sb.ip` in the SDK) |
| **Fork network membership** | **Not inherited.** Forks start outside the network (red -> fork timed out). `network attach <net> <fork>` takes about 0.8 s, after which it works. The fork keeps the same IP |
| **Egress allowlist vs private network** | `firewall set <fork> example.com` blocks google.com (good) **but also cuts private-network traffic from the red team**. **Fix verified:** include the red-team sandbox's IP in the allowlist (`firewall set <fork> <red-ip> [hosts...]`) |
| `exec` with a background job | Hangs unless stdio is redirected; use `sandbox process start` (worked) |
| `whoami` | Shows `Plan free-plan` even on the account with the 5-cap; don't rely on it |

**Wrapper smoke test (`npm run`-able via `npx tsx infra/smoke.ts`, EU endpoint, through `orchestrator/createos.ts`):** create base+red in parallel 0.6 s; start service + port ready 0.8 s; pause base 8.0 s; **fork x2 in parallel 10.2 s** (so 3 parallel forks should be about 10-12 s, better than the 15 s per fork planned for); attach to network 0.2 s; cleanup 1.0 s. **New rule:** env keys used by `exec`/`process` must be **declared at sandbox creation** (`envs`), otherwise the API returns `400 env key "X" was not declared at sandbox creation`. `createBox` declares `PORT` for you; declare any other key in `CreateBoxOptions.envs`.

**Live race results (stub agents, EU endpoint, `npm run race`):** the full loop works end to end: base -> pause -> fork -> drop base -> red team joins -> per-fork patch + restart + attack -> judge -> kill losers -> promote. Typical run 3.5-6 min when a fork stalls, about 1.5 min when forks are healthy (one run had 3 forks ready in 7 s). Findings:
- **Forks are flaky on the EU endpoint:** roughly 1 in 3 stalls past 60-180 s (one run hung 10 minutes with no timeout). Every fork now has a **75 s hard deadline** (`withDeadline` aborts the SDK request), a stuck fork is destroyed, and the race **falls back to a fresh sandbox + the same service files** ("fresh copy") so a run always completes. Say "fork" in the demo only for candidates that really were forks (the events feed labels each one).
- **Slots stay held after destroy:** `whoami.stats.other` counts destroying/failed sandboxes, which keep using concurrency slots for a while. `quota().live` now includes them; the race waits for them to drain (up to 60 s) and otherwise shrinks `n`. **Landing exactly on 5/5 hangs a fork**, so peak concurrency is kept at 4: base + 3 forks, then base is destroyed before the red team is created.
- **Sandbox names max 22 chars** (`dw-<6-char run id>-base`).
- **Daily budget (unconfirmed, be deliberate):** a race costs about 5 creations (base, forks, red team, plus any retry or fallback copy); `whoami.stats.total` was **44** after development and tests. The docs say Free = 10 and Beginner = 50 creations per day, **but this account reports `planName: "free-plan"` (general API `GET /v1/users/me`) and still ran 5 concurrent sandboxes and 44 creations without a daily-limit error, so it has custom limits and we do not know whether a daily cap applies or what it is.** Ask in Discord #support. Until known, avoid casual live races (use `check:agents`, fixtures and stubs) and keep a recorded run for the demo video. A daily-limit error would be a clear 429/403 with its own message.
- **Scripts must `process.exit()`**: the SDK keeps sockets open, so a script never ends on its own.
- Commands: `npm run race` (one race; `DARWIN_N=2` for fewer forks; `DARWIN_AGENTS=real` to use Part B's `agents/index.ts`), `npm run dev` (API on :8787), `npm run cleanup`, `npm run smoke`, `npm run doctor`, `npm run db:apply`.

**A5 additions (orchestrator):**
- **Stripe Projects in every run:** the first event of each run (`provision`) lists the stack `stripe projects status --json` reports (createos/project, Neon/postgres, OpenRouter/api) and how many credentials it synced, so the UI feed and demo show real Stripe Projects usage. Read-only, names only, never fails the run if the CLI is missing.
- **Watchdog:** a run that exceeds 8 minutes is marked failed, our sandboxes are destroyed and the slots freed (so the UI never spins forever).
- **Stripe webhook trigger:** `POST /api/stripe/webhook` verifies the Stripe signature and starts a race on `payment_intent.succeeded` (override with `DARWIN_TRIGGER_EVENT`). Needs `STRIPE_WEBHOOK_SECRET` (`stripe listen --print-secret`); `DARWIN_DRY=1` logs instead of racing. Tested with locally signed payloads (valid, other event type, wrong secret, no signature). **Not tested with a real `stripe trigger`**: the CLI on this machine is logged into the account's **live** mode and Stripe refuses test triggers there. To demo it, create a Stripe **sandbox** (Dashboard account picker -> Sandboxes, or `stripe switch`), then: `stripe listen --forward-to localhost:8787/api/stripe/webhook` in one terminal and `stripe trigger payment_intent.succeeded` in another. Never run triggers in live mode.

**Part B merged into main (commit 42e22a5)** after a clean trial merge: typecheck passes, `npm run check:agents` works on the real `/service` (the race now picks `/service` automatically over the placeholder), and the offline loop gives 1 survivor of 3.

**LLM access (the open problem):** the Stripe-Projects OpenRouter key is a **free-tier key with no credits**: paid models return `402 Insufficient credits`, so the default `anthropic/claude-haiku-4.5` fails and every patch falls back to the fixtures. Upgrading through `stripe projects upgrade openrouter` needs a paid-tier country (India is not on the list), so the realistic fix is to **buy credits directly at https://openrouter.ai/settings/credits** (a few dollars is plenty). Until then, free models work but are weak and flaky: `DARWIN_MODEL=cohere/north-mini-code:free` gave real model patches (one of 3 failed after a 45 s timeout and fell back to a fixture; the two real patches both failed the attacks; run took 90 s); `poolside/laguna-s-2.1:free` hit a 429 and a syntax error, ending with 0 of 3 survivors. Free-tier accounts are also rate-limited per day. With free models expect slow runs and sometimes 0 survivors, so for the demo video use a funded key and a strong model, and prefer the recorded run.

**Live race with Part B's real agents (run rca526, `DARWIN_AGENTS=real`, triggered from the API like the UI's Start button):** completed in about 4 min: 3 real forks ready in 10.9 s, base resumed as the red team in 4.6 s, patch-b promoted (6/6), patch-a killed (17), patch-c killed (0). The OpenRouter key had no credits, so all patches came from the fixtures (labels in the UI come from the fixture rationales). What changed to make it reliable: **the base sandbox is resumed and used as the red team** (no 6th sandbox, no waiting for a destroyed sandbox to release its slot: destroyed sandboxes keep holding slots for minutes on the EU endpoint), and **cleanup issues destroys in parallel without waiting**. The earlier run r53bba failed (`timed out waiting for 1 free slot`) because the red team was a new sandbox created while two destroying ones still held slots. **Daily limit:** the account reached **53 creations with no daily-limit error**, so a 50/day cap is not enforced on this account (so far). **Attack hang:** one attack (patch-c) hung about 3 minutes until the exec timeout; the attack script's `fetch` calls have no per-request timeout (Part B should add `AbortSignal.timeout(5000)`); the orchestrator's attack exec timeout is now 60 s.

**LLM solved with Google's free Gemini tier (tested):** Part B's agent speaks the OpenAI chat-completions format, so it works with Google's OpenAI-compatible endpoint through three env vars (the names still say OPENROUTER): `OPENROUTER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `OPENROUTER_API_KEY=<Google AI Studio key>`, `DARWIN_MODEL=gemini-3.7-flash`. **Model notes:** `gemini-2.5-*` returns `404 no longer available to new users`; these work on a free key: `gemini-3.7-flash` (fastest, about 2.7 s), `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3-flash-preview`. List ids with `GET <base>/models` (ids come back as `models/<id>`; use the part after `models/`). **Result with real model patches (`DARWIN_MODEL=gemini-3.7-flash DARWIN_N=3 npm run check:agents`):** 3 distinct patches in 21 s, no fixture fallbacks, exactly 1 of 3 survived (scores 83, 100, 83: two fixed idempotency but missed input validation). Keep the key only in `.env`, never in git or chat.

**CLI and "bring your own code" (new, tested live):** `./darwin run <path|git-url> --bug "..." --test "npm test"` (or `--example slugify|webhook`). A project can also carry a `darwin.json` (`bug`, `test`, `install`, `egress`, `n`, `editable`). Command mode copies the project into a base sandbox (tar upload), installs dependencies, runs the tests (they must fail), snapshots, forks N, has the model write a fix per fork (`orchestrator/generic-agents.ts`, rotates through `DARWIN_MODELS` because Google's free tier allows 20 requests per day per model), locks each fork's egress, runs the tests in each fork, and promotes the **smallest** passing patch (saved to `<project>/.darwin/<run>/winner.patch`, or written into the project with `--apply`). The live terminal view draws the sandboxes as 3D cubes (`cli/iso.ts`; `npx tsx cli/iso-demo.ts` shows the gallery; `--flat` or a short terminal gives flat boxes). No-sandbox benches: `npm run check:target -- --example slugify` and `npm run check:agents`. First live CLI run (slugify, default endpoint): baseline 2/10, 3 candidates (one fork stalled and was replaced by a fresh copy), all passed, winner promoted in 112 s. **SDK bug worked around:** the CreateOS SDK's HTTP/2 transport can crash the process (`RangeError: init["status"]` when a response stream ends without a status); `makeClient` now injects plain `fetch`, which bypasses that transport.

**Web UI (PR #1 merged, then reworked to show only live data):** `/` is the landing page and `/arena` the live dashboard (both served by `npm run dev` on port 8787). The arena shows real sandbox names and IPs, each candidate's real patch diff (new `branches.patch_diff` column, filled by both race modes), and whatever checks the run reported (the six webhook attacks or the test suite). It has a **target picker**: `POST /api/runs` takes `{ n?, example?: "webhook" | "slugify" }`. Model-written text is HTML-escaped. There is no fake race: if the orchestrator is unreachable the page says so; `/arena?preview` shows a bundled sample run, labelled "PREVIEW · SAMPLE DATA". The layout is responsive (checked at 12 widths from 360 to 1512 px with no horizontal scroll; the header wraps below 980 px).

**Deployed on Render:** service `darwin` (id `srv-db9vsgjrjlhs738c78j0`, workspace "My Workspace"), live at https://darwin-tr7p.onrender.com, free plan (sleeps when idle), auto-deploys from `main`, single instance. Config is `render.yaml`; secrets were set with `render services create --env-var`. **Protection:** `POST /api/runs` needs the `DARWIN_ADMIN_TOKEN` (header `x-darwin-token`; the arena prompts for it), starts are rate-limited (`DARWIN_MIN_INTERVAL_SEC`, 240 s hosted), a hosted server with no token refuses starts, no CORS when hosted. The token lives in the local gitignored `.env` (`grep DARWIN_ADMIN_TOKEN .env`) and in Render's env settings; **setting it locally also makes the local server ask for it**. Verified live: pages 200, token gate 401/401/400 (no race was started on the deployment). Redeploy: `git push` (auto) or `render deploys create srv-db9vsgjrjlhs738c78j0`; logs: `render logs`; delete: `render services delete`.

**Orchestrator recipe (proven):** create net -> create base (on net) + red (on net) -> push service and `process start` -> pause base -> fork x3 (about 5.5 s each, can run in parallel) -> `attach` each fork to the net -> `setEgress([redIp, ...needed hosts])` on each fork -> red attacks `http://<forkIp>:8080` -> judge -> delete losers (and the base) -> `network rm` only when it has no members.
Slot math: base(paused) + red + 3 forks = **5/5**, i.e. the cap. Safer: fork 2, or delete the base right after the last fork. Budget: one pre-kickoff test used about 5 creations.

### 3.3 TypeScript SDK (`@nodeops-createos/sandbox` v0.8.2, Node 20+). Signatures verified from the package's `.d.ts`

```ts
import { createClient, Sandbox, selfPause, selfDelete,
         CreateosSandboxRateLimitError, CreateosSandboxPaymentRequiredError } from "@nodeops-createos/sandbox";

const client = createClient();          // reads CREATEOS_SANDBOX_API_KEY (+ optional CREATEOS_SANDBOX_BASE_URL); or createClient({ apiKey })
await client.whoami();                  // { user_id, stats: { running, paused, other, total } }  <- use to check quota headroom
await client.listShapes(); await client.listRootfs();

// create: wait:true blocks until running
const base = await client.createSandbox(
  { shape: "s-1vcpu-1gb", rootfs: "devbox:1", name: "fr-base",
    egress: ["registry.npmjs.org"], envs: { PORT: "8080" },
    networks: [{ id: netId }], ingress_enabled: false, auto_pause_after_seconds: 600 },
  { wait: true, waitTimeoutMs: 60_000 });

// one-shot exec (buffered, 1 MiB cap). Background jobs MUST detach (redirect stdio + &) or exec blocks
const { result, exec_ms } = await base.runCommand("node", ["-v"], { env: {...}, stdin: "..." });
// result: { stdout, stderr, exit_code, error? }
await base.sh("cd /app && npm ci", { timeoutMs: 300_000 });      // throws on non-zero exit
for await (const ev of base.streamCommand("npm", ["test"])) { /* ev.type: stdout|stderr|exit|error|heartbeat */ }

// files (absolute paths only, parent dirs auto-created; for directories: tar locally, upload, untar inside)
await base.files.upload("/app/server.js", fileText);  const buf = await base.files.download("/app/out.json"); // ArrayBuffer

// managed long-running process (use for the demo service)
const p = await base.processes.create({ cmd: "node", args: ["server.js"], cwd: "/app", env: { PORT: "8080" } });
// p.process_id; processes.list/get/wait/signal(id,"SIGTERM")/delete(id); processes.connect(id) -> async events {type:"data",stream,data}|{type:"exit",exitCode}
await base.waitForPortReady(8080, { timeoutMs: 15_000 });

// networks
const net = await client.networks.create({ name: "fr-net" });   // { id, name, members? }
await sb.attachNetwork(net.id);  await sb.detachNetwork(net.id);  await client.networks.delete(net.id); // needs 0 members

// egress / ingress
await sb.setEgress(["api.openrouter.ai:443"]);   // null = allow all;  sb.getEgress()
await sb.setIngress(true);  const url = sb.previewUrl(8080, { scheme: "http" }); // server must bind 0.0.0.0

// pause / fork / destroy
await base.pause(); await base.waitUntilPaused({ timeoutMs: 60_000 });
const fork = await base.fork({ start_paused: false, egress: [...], envs: {...}, ingress_enabled: false });
await fork.waitUntilRunning({ timeoutMs: 60_000 });   // fork.name is auto-generated: no name field in ForkSandboxRequest
await sb.destroy(); await sb.waitUntilDestroyed();

// handles: sb.id, sb.name, sb.ip, sb.status, sb.data (SandboxView: forked_from, ingress_url_template, egress, spawn_ms...), sb.refresh()
// Sandbox.connect("sb-...") to reattach to an existing sandbox (pre-warmed base).
// Inside a sandbox: selfPause(reason) / selfDelete(), or curl -X POST http://127.0.0.1:1029/self/delete
```
- REST base `https://api.sb.createos.sh`, header `X-Api-Key`. Statuses: `creating | running | pausing | paused | resuming | forking | destroying | destroyed | error`.
- Errors to handle: `CreateosSandboxRateLimitError` (429, includes the concurrency quota), `CreateosSandboxPaymentRequiredError` (402, credits/plan), `CreateosSandboxTimeoutError`, `CreateosSandboxNotFoundError`.
- **Verified (3.2a):** forks do NOT keep network membership -> `attachNetwork(netId)` each fork after it is running. Name DNS doesn't work -> the red team must use `fork.ip`.
- **API-key env var mismatch:** the SDK reads `CREATEOS_SANDBOX_API_KEY`; the CLI reads `CREATEOS_API_KEY`. Check which name `stripe projects add createos/project` writes to `.env`, and map it in our config loader.
- The CLI is the fallback if the SDK misbehaves. Other SDKs exist (Go, Python, Rust, C#, Java); we use TypeScript.

### 3.4 Stripe Projects (developer preview; docs: https://docs.stripe.com/projects and https://docs.stripe.com/cli/projects)

**What it is:** a Stripe CLI plugin. A "project" = one app; you add provider services (resources) and their credentials sync to `.env`. Resources live in provider accounts you own. Billing for paid tiers runs through one Stripe payment method (Shared Payment Tokens), with spend caps.

**Setup:** Stripe CLI v1.40+ (`npm install -g @stripe/cli`), `stripe login`, `stripe plugin install projects` (`stripe plugin upgrade projects` to update).

**Gotchas hit on day (plugin v0.50.0):** `--auto-confirm` is rejected ("Unknown arguments"), so use `--accept-tos --yes --no-interactive --json`. Each provider needs its **plan first**: `stripe projects add createos/free`, then `createos/project`; `neon/free`, then `neon/postgres`. (`openrouter/api` needed no plan step.) `init` did not require a browser pairing once `stripe login` was done. `init`/`add` print a `<claude-code-hint .../>` line before the JSON, so strip it before parsing. `init` rewrites `.gitignore` and appends a line to `CLAUDE.md`; both were left as is.

**Commands** (global flags: `--json --no-interactive --auto-confirm --accept-tos --quiet --debug`):
| Command | Use |
|---|---|
| `init [name]` / `init --yes` / `init --from <share-url>` | Creates `.projects/`, `.env`, `AGENTS.md`, agent skills in `.skills/stripe-projects-cli/`, and updates `.gitignore` |
| `catalog [provider\|category] --json`, `search <q> --json` | Discover services and tiers |
| `add <provider>/<service> [--name X] [--config '<json>']` | Provision a resource and write its env vars |
| `link <provider>` | Link an existing provider account without provisioning (do this before agent runs, so no browser pop-ups) |
| `status --json`, `list`, `services list` | Project and resources |
| `env [--pull]`, `env list/show/create <n> --output .env.x/use/add/remove` | Env files; `--pull` restores `.env` on a new machine |
| `variables set <name> --env-key KEY --value V` | Your own env vars, managed by Projects |
| `remove`, `rotate`, `upgrade`, `open <provider>` | Lifecycle (remove is destructive at the provider) |
| `billing show/add/update --limit N [--provider p]`, `spend` | Paid tiers |
| `share` / `import <url>` / `pull <proj_id>` | Share the stack (no secrets) / clone the project to another machine |
| `build <app> [--template ...]` | Starter app from the template registry |
| `llm-context` | Regenerate `AGENTS.md` |

**Services we use:** `createos/project` (compute), `neon/postgres` (writes `DATABASE_URL`; free tier), `openrouter/api` (writes `OPENROUTER_API_KEY`; free tier available).

**Files:** commit `.projects/state.json` **and** `.projects/state.local.json` (the teammate needs it for `link`). Never commit `.projects/vault/`, `.projects/cache/`, `.env*` (auto-gitignored). The teammate gets credentials with `stripe projects env --pull`, or `stripe projects pull <proj_id>` from an empty directory. If that fails, send the keys over a private DM.

**Installed and verified pre-kickoff:** Stripe CLI 1.54.0 + `projects` plugin v0.50.0 (`stripe plugin install projects`; the download is large and slow, about 350 KB/s, **allow 10+ minutes and don't wrap it in a short timeout**; it needs `stripe login` first, otherwise it stalls). `stripe projects --help` works. Also available: `switch-account`, `services list`, `downgrade`, `update`, `unlink`.

**Catalog (live, `stripe projects catalog <provider> --json`, no project needed):**
| Service | kind | Notes |
|---|---|---|
| `createos/free` | plan (account scope) | upgradable to `beginner-monthly`, `pro-monthly`, `enterprise-monthly` (via `stripe projects upgrade`/`update`) |
| `createos/project` | deployable | the one the hackathon checklist adds |
| `neon/free` | plan | upgradable to `launch` |
| `neon/postgres` | deployable | Postgres (+ auth); this is our DB |
| `openrouter/free` | plan | upgradable to `pay_as_you_go` |
| `openrouter/api` | deployable | LLM access; free option, otherwise per-token |

`stripe projects status --json` outside an initialized project returns `NO_PROJECT_CONFIG` with `meta.authenticated: false`: Projects keeps its own auth, established by the `init` browser pairing below.

**Auth flow (from Stripe's own `stripe-projects` agent skill):** `stripe projects init --accept-tos --yes --json` may return `BROWSER_AUTH_REQUIRED` with `details.reason = handoff_prepared`. A human must open `details.browser_url`, enter `details.verification_code`, approve in the browser, then rerun the **same** init command. Don't start a separate `stripe login` for that. Init also installs a local `stripe-projects-cli` skill under `.agents/skills/` (read it for post-init commands). Pre-kickoff, `stripe plugin install projects` hung with no Stripe login on this machine (stalled at "Fetching plugin metadata" from dashboard.stripe.com); try it again after the human has logged in or paired.

**Error recovery:** `PROVIDER_NOT_LINKED` -> `stripe projects link <provider>`; anything else -> rerun with `--debug`. If the CLI opens a browser for auth, a human must finish it (agents: stop and ask).

**Account requirements:**
- A plain free Stripe account is enough; Projects does not need payment processing or business activation.
- **Paid tiers** need `billing add` and an account country on the [paid-tier country list](https://docs.stripe.com/projects/paid-tier-countries.md). **India is NOT on the list**, so if our Stripe account is Indian, upgrade CreateOS to Beginner on the CreateOS dashboard (or get a promo), not via `stripe projects upgrade`.

**Demo value:** run `catalog --json` / `add ... --json` from the orchestrator and show the output in the events feed. "One command provisions compute, DB and LLM; no dashboard opened."

**Leaderboard:** projects.dev/leaderboard. Submit with event code `CreateOS-2026`. Ranked by community votes; entries show name, repo, stack. After submitting, share it to collect votes.

### 3.5 Stripe without a business account (for the webhook trigger / test events)

- Every new Stripe account has **test mode / sandboxes** immediately, with no activation or business details needed. Activation is only for live payments.
- **Anonymous sandbox:** `stripe sandbox create --email you@x.com --non-interactive` (or `--from-git`) gives test API keys with **no account at all**, saved to the CLI profile. Expires in **7 days** unless claimed (`stripe sandbox claim`). Good for agents/CI. It probably doesn't cover Stripe Projects, which is tied to a logged-in Stripe account, so use the normal `stripe login` account for Projects.
- **Webhook testing:** `stripe listen --forward-to <url>/webhook` prints a `whsec_...` signing secret and forwards events. `stripe trigger payment_intent.succeeded` fires a test event. `stripe events resend <evt_id>` re-delivers an event, which is a real duplicate delivery and fits our demo bug.
- Our demo service can verify signatures with `stripe.webhooks.constructEvent(rawBody, sig, whsec)`. Optional: the core loop uses synthetic events from the red team and doesn't need Stripe at all.

## 4. Repo layout and ownership (non-overlapping)

Single repo, TypeScript, Node 20+, ESM. **Each part owns its directories and does not edit the other's.** Shared files change only after telling the other person.

```
/contracts/        types.ts, schema.sql           OWNER: A (B may propose changes; agree first)
/orchestrator/     CreateOS driver, run loop, API OWNER: A
/infra/            stripe-projects setup, scripts OWNER: A
/service/          buggy demo service             OWNER: B
/agents/           builder, red team, judge       OWNER: B
/ui/               live fork-tree UI              OWNER: B
/docs/ README.md   README, demo script, post      SHARED (last hour)
```

Git rules: A creates the repo at 12:30 and pushes the scaffold within 15 minutes; B clones it. Commit small and often. Pull with rebase before pushing. Nothing lands after 5:30.

## 5. Contracts (agree on these first; these are the only coupling)

Put in `/contracts/types.ts` (A writes the first version in the first 15 minutes):

```ts
export type BranchStatus =
  | "forking" | "patching" | "attacking" | "killed" | "survivor" | "promoted" | "error";

export interface Patch {
  id: string;                       // e.g. "patch-a"
  rationale: string;                // short, shown in the UI
  files: Record<string, string>;    // relative path in /service -> full new file content
}

export interface AttackResult {
  name: string;                     // e.g. "concurrent-duplicates"
  passed: boolean;                  // true = the service survived this attack
  detail: string;
}

export interface AttackReport {
  branchId: string;
  results: AttackResult[];
  finishedAt: string;               // ISO time
}

export interface Verdict {
  branchId: string;
  alive: boolean;
  score: number;                    // 0-100
  reason: string;
}
```

**Part B exports (consumed by Part A)**, from `/agents/index.ts`:

```ts
generatePatches(input: { sourceFiles: Record<string,string>; bugReport: string; n: number }): Promise<Patch[]>;
getAttackScript(input: { sourceFiles: Record<string,string> }): Promise<string>;
// returns Node.js source; run as `node attack.js <TARGET_URL> <BRANCH_ID>`;
// prints one AttackReport as JSON on the LAST line of stdout
judge(reports: AttackReport[]): Promise<Verdict[]>;
```

**Demo service HTTP interface (Part B builds, Part A relies on)**, always port 8080:

- `GET /health` returns 200 `{ok:true}`
- `POST /webhook` takes a Stripe-style event `{ id, type:"payment_intent.succeeded", data:{ amount, customer } }`, returns 200
- `GET /ledger` returns `{ entries: [{eventId, amount, customer}], total }`
- `POST /reset` clears the ledger
- Start command: `npm start`, run from the service directory

**Neon tables** (`/contracts/schema.sql`, A owns): `runs(id, created_at, status)`, `branches(id, run_id, parent_id, sandbox_id, status, patch_rationale, score, reason, created_at)`, `attacks(id, branch_id, name, passed, detail)`, `events(id, run_id, at, kind, message)`.

**API for the UI (Part A serves, Part B consumes)**, on the orchestrator host:
- `GET /api/runs/latest` returns `{ run, branches[], attacks[], events[] }`. The UI polls this every 1 s. No websockets.
- `POST /api/runs` starts a new run (the UI's "Start" button).

Until Part A's API exists, Part B's UI uses a fixture file `/ui/fixtures/run.json` in the same shape. Part A uses stub agents (section 7) until Part B ships.

## 6. The demo bug (Part B owns)

`/service` is a small Express app that "fulfills an order" per webhook event. Make the bug realistic, so naive fixes fail:
- No idempotency by `event.id`, so a duplicate event is double-processed.
- Fulfillment includes `await sleep(50)` between "check" and "record", so a lazy fix (`if (seen.has(id)) return; await work(); seen.add(id)`) still loses to **concurrent** duplicates. A correct fix marks the id in-flight *before* the await.
- A malformed body (missing id, wrong types) currently crashes or returns 500.

The red-team suite (`/agents/attacks`) checks at least: sequential duplicates (same id x5), concurrent duplicates (same id x20 in parallel), malformed payloads (must return 4xx, never crash), replay of an old event after others, and `GET /health` still alive afterwards. Each check outputs an `AttackResult`. Add LLM-generated extra attacks only after the fixed suite works.

Goal for the demo: of 3 patches (quota limit, section 3.1), typically 1 passes everything, and the others die to the concurrency attack. Tune the prompts (for example vary the builder's temperature or strategy hints) so the result is not all-pass or all-fail. Verify this with a dry run before the video.

## 7. Work split: step-by-step phases

Times are targets. **Milestone M1 = 1:45 PM** (infra and service independently working), **M2 = 3:30 PM** (core loop works end to end), **M3 = 4:30 PM** (feature freeze, record the video), **M4 = 5:15 PM** (everything submitted, 15-minute buffer before lock).

### PART A: Infra and Orchestrator

**A1. Scaffold and provisioning (12:30-1:00)**
1. Create the repo and push the layout from section 4. Write `/contracts/types.ts` and `/contracts/schema.sql`; tell B.
2. `stripe projects init <name>`, `stripe projects add createos/project`, `stripe projects catalog`, then add Neon and OpenRouter. Run `stripe projects env --pull`. Share the needed keys with B securely (Discord DM, never commit `.env`; add it to `.gitignore` first).
3. Apply `schema.sql` to Neon.
3a. **Sandbox endpoint (we use the default host, see 3.2.0; the EU values below are the organizers' request and are no longer used).** Both teammates do this once, before touching CreateOS:
   - Shell (permanent): `echo 'export CREATEOS_SANDBOX_URL=https://api-eu.sb.createos.sh' >> ~/.bashrc && echo 'export CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh' >> ~/.bashrc && source ~/.bashrc`. The CLI reads `CREATEOS_SANDBOX_URL`; the SDK reads `CREATEOS_SANDBOX_BASE_URL`. Verify with `echo $CREATEOS_SANDBOX_URL` and `createos sandbox list`.
   - Project config: after `init`, store both as Stripe Projects variables so `env --pull` writes them to `.env` for everyone: `stripe projects variables set createos-sandbox-url --env-key CREATEOS_SANDBOX_URL --value https://api-eu.sb.createos.sh` and the same with `createos-sandbox-base-url` / `CREATEOS_SANDBOX_BASE_URL`.
   - Commit a `.env.example` with these variable names and the EU URL (not secret); `.env` itself stays gitignored. Nothing loads `.env` into the CLI automatically; our orchestrator loads it (dotenv or `node --env-file=.env`) and also passes `baseUrl` to `createClient` explicitly.
   - **Done (provisioned on day):** `stripe projects add createos/project` wrote `CREATEOS_PLAN_API_KEY/URL/CREDENTIALS/DASHBOARD_URL` and `CREATEOS_PROJECT_API_KEY/URL/CREDENTIALS/DASHBOARD_URL`. The CLI accepts these names natively, but the SDK wants `CREATEOS_SANDBOX_API_KEY`, which is **not** written, so `config.ts` maps `CREATEOS_PROJECT_API_KEY` to it. Verified: both keys authenticate against `https://api-eu.sb.createos.sh/v1/whoami` and map to the same account (and its 5-sandbox cap) we tested with. `*_API_URL` is the general CreateOS API (`api-createos.nodeops.network`), not the sandbox API.
- **Neon** wrote `NEON_POSTGRES_CONNECTION_STRING` (+ `_PROJECT_ID`, `_BRANCH_ID`, `_BRANCH_NAME`, `_DATABASE_NAME`, `_ORG_ID`, `NEON_PLAN_ORG_ID`). **OpenRouter** wrote `OPENROUTER_API_KEY` (+ `OPENROUTER_TYPE`).
4. **Resolved pre-kickoff:** the CreateOS account we tested with has a 5-concurrent cap and fork works (verified, section 3.2a). Use this account for the CreateOS side. Historical note: a fresh (Free) account failed with `sandbox concurrent quota reached (1 / 1)`; paused sandboxes count and `fork --paused` is blocked too. Per https://createos.sh/docs/Sandbox/Limits: **Free = 1 concurrent / 10 per day, Beginner = 5 concurrent / 50 per day, Pro = 20 / 200**. We need Beginner (about $10/month per a marketplace listing, or a promo from the organizers; we asked in Discord). Confirm the plan is active and rerun the fork test. A quota of 1 cannot run this project, even with the "create N sandboxes" fallback.

**A2. Sandbox primitives (1:00-1:45)**
Write `/orchestrator/createos.ts`, a thin wrapper with async helpers that poll to the terminal status: `createSandbox`, `pause`, `fork`, `exec`, `pushFiles`, `setFirewall`, `createNetwork/attach`, `remove`. **Measure and record fork latency** (note it in `/docs/notes.md`). Verify: private-network name resolution between two sandboxes; how to enable ingress for a public URL; how `exec` returns output and exit codes.

**A3. Base image and run loop with stubs (1:45-2:45)**
1. Use B's `/service` (placeholder until M1) to build the base sandbox: push service, `npm install`, start on 8080, verify `/health`, pause.
2. Implement `runRace()`: fork N, create the red-team sandbox, attach all to one network, apply an egress allowlist to forks (allow nothing but the red-team peer and the LLM API only if needed), push each patch, restart the service, run the attack script, collect `AttackReport`s, call `judge`, delete losers, mark the survivor.
3. Use **stub agent functions** (`/orchestrator/stubs.ts`) until B's real ones land: hardcoded patches and a canned attack report in the contract's shape.
4. Write every state change to Neon (`branches`, `attacks`, `events`).

**A4. API and integration (2:45-3:30)**
1. Serve `GET /api/runs/latest` and `POST /api/runs`.
2. Swap the stubs for B's real `/agents` functions. Fix contract mismatches together with B.
3. **M2: one full real run end to end.**

**A5. Hardening and the Stripe Projects stretch (3:30-4:15)**
1. Add retries and timeouts around every poll. Failed forks mark the branch `error` and do not stop the run.
2. Pre-warm: a script that creates and pauses the base sandbox ahead of time, so the live demo skips the slow setup. Also add `forkAll` in parallel.
3. Stripe Projects stretch: during the run the orchestrator calls `stripe projects add ...` to provision a service the demo app needs (for example a Neon database for the service's ledger) and shows it in the events feed. Only attempt this if M2 is solid.
4. Optional: trigger a run from a Stripe test event on a public URL.
5. Cleanup script to delete leftover sandboxes (credit saver).

**A6. Submission assets (4:15-5:15), shared with B**
README architecture section, the CreateOS and Stripe Projects usage write-up, the contrast scene (below), the video, the post, the leaderboard entry, the form.

### PART B: Demo service, Agents and UI

> **Test your agents without any sandbox:** once `agents/index.ts` exports `generatePatches`, `getAttackScript` and `judge`, run `npm run check:agents` (optionally `DARWIN_N=3`). It starts each patched service on localhost, runs your attack script against it, and prints the verdicts. This costs no CreateOS quota (the account has a limited daily sandbox budget, see 3.2a). Aim for exactly 1 survivor out of 3. The orchestrator loads your module with `DARWIN_AGENTS=real npm run race` only when the team agrees a live run is worth the budget. The service in `/service` must start with `npm start` and read `PORT`.

**B1. Demo service (12:30-1:15)**
Build `/service` per section 6: Express, `npm start` on 8080, the interface in section 5. Include the deliberate bug and a `README` note about it. Add `/service/test/` with a simple script that proves the bug locally (double ledger entries). Commit by **M1** (1:45) so A can use it.

**B2. Attack suite (1:15-2:00)**
Build `/agents/attacks`: a standalone `attack.js` (no dependencies beyond Node 20 built-in `fetch`) that implements the checks in section 6 and prints an `AttackReport` as JSON on the last stdout line. Test locally against the buggy service (must fail), then against a hand-written correct fix (must pass). Save both fixes as fixtures: `/agents/fixtures/good-patch.json` and `bad-patch.json`, and give them to A.

**B3. Builder agent (2:00-2:45)**
`generatePatches()` in `/agents/builder.ts`: calls OpenRouter (key from `.env`) with the source files, the bug report and a different strategy hint per patch (for example "in-memory set", "set checked before await", "idempotency map with in-flight tracking", "database unique constraint"). Validate the model's JSON output, retry once on bad output, and fall back to fixtures if the model fails. Implement `getAttackScript()` (returns the contents of `attack.js`, optionally with LLM-written extra attacks) and `judge()` (deterministic scoring from the results, with a one-line LLM-written reason for the UI).

**B4. UI (2:45-3:30)**
`/ui`: a single-page app (Vite + React, or plain HTML + JS if faster). Polls `GET /api/runs/latest` every second. Shows the base sandbox, forking into tiles, each tile showing status (colors: attacking = amber, killed = red, survivor = green), the patch rationale, per-attack pass/fail ticks and the score, plus an events feed. A "Start run" button calls `POST /api/runs`. Build against `/ui/fixtures/run.json` first. **M2: UI shows a real run.**

**B5. Polish and the contrast scene (3:30-4:15)**
1. **Contrast scene:** a short script that runs one attack payload on a bare machine (for example the attack against an unprotected local process that writes a file outside its sandbox directory) versus the same payload inside a fork where it is contained. Keep it harmless: it only writes a marker file. Do not run anything destructive.
2. Dry-run 3 full races, tune the prompts so outcomes are interesting and the demo is reliable. Record which seed or prompt settings gave a good result.
3. UI polish: animations when a branch dies, a clear "survivor promoted" state.

**B6. Submission assets (4:15-5:15), shared with A**
Demo script, the video (someone on camera), the post, README sections on the service, agents and UI.

## 8. Fallbacks (decide quickly, do not stall)

- **Fork too slow (more than about 20 s):** pre-fork before the demo and play the race from the prepared forks. Show a timelapse for the fork step.
- **Fork not available (plan issue):** create N sandboxes from the same rootfs and push the service into each. The loop still works; we lose the "memory copied" claim, so say "fork" only where it is true.
- **Private-network names do not resolve:** attach by IP from `sandbox get`, or enable ingress on each fork and attack the public URLs.
- **LLM output bad:** use fixtures in `/agents/fixtures` so the demo never depends on one model call.
- **Anything running past M2 is cut.** Priority order: core loop, UI, Neon history, contrast scene, Stripe Projects provisioning stretch, Stripe-event trigger.

## 9. Open items to verify in the first hour

1. **Sandbox quota / Beginner plan** (see A1 step 4 and section 3.1). Free tier = 1 concurrent, so fork fails. Beginner = 5 concurrent, 50 per day: enough for 3 forks + red team, with no room for more.
2. Fork latency (measure it, write it in `/docs/notes.md`).
3. Private-network name resolution between sandboxes.
4. How ingress is enabled and what the public URL looks like.
5. ~~Catalog names~~ (resolved: `neon/postgres`, `openrouter/api`, `createos/project`). Still check which env var name `createos/project` writes (SDK wants `CREATEOS_SANDBOX_API_KEY`).
6. ~~Non-interactive add~~ (resolved: `--no-interactive --accept-tos --auto-confirm --json`; run `stripe projects link <provider>` beforehand to avoid browser pop-ups).
7. ~~Fork network membership / egress vs network~~ (resolved in 3.2a: not inherited, attach manually; egress must include the red-team IP; name DNS broken, use IPs). Still unknown: preview URLs on forks, and the `.env` var name from `createos/project`.
8. Does the Stripe account's country support Projects paid tiers? (India is not on the list.)

## 10. Conventions

- TypeScript, Node 20+, ESM. No secrets in git (`.env` in `.gitignore` before the first commit).
- Every sandbox gets a name prefix `fr-` so the cleanup script can find them. Delete sandboxes you no longer need (credits).
- Keep functions small and log to the `events` table so the UI can show progress.
- If you need something from the other part, ask your human to message the teammate; do not edit their directories.
- When a contract changes, update `/contracts/types.ts` in the same commit and announce it.

## 11. Submission checklist (owner: both; finish by 5:15 PM)

- [ ] Public GitHub repo with README (architecture, how to run, Stripe Projects and CreateOS usage, why a sandbox)
- [ ] 2-3 minute demo video on YouTube, a team member on camera
- [ ] Public X or LinkedIn post tagging @createosai (CreateOS on LinkedIn)
- [ ] Entry at projects.dev/leaderboard with code `CreateOS-2026`
- [ ] Submission form filled in (team and project details, video, repo, post links)
- [ ] Last commit pushed before 5:30 PM

### Demo script (about 3 minutes)
1. (15 s) The problem: AI agents write code; running it on your laptop is dangerous.
2. (20 s) One command provisions the stack with Stripe Projects.
3. (60 s) Start a run: the base forks into tiles, the builder writes different fixes, the red team attacks, tiles turn red, one survives.
4. (30 s) Contrast scene: same attack bare vs in a fork.
5. (20 s) Survivor promoted, run history in Neon.
6. (15 s) Close: "Fork, attack, promote. Safe by construction."

## 12. Pre-kickoff checklist (before 12:00 PM, no repo yet)

- [ ] `npm install -g @stripe/cli`, then `stripe plugin install projects`
- [ ] Install the CreateOS CLI: `curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh -`
- [ ] Throwaway test in a scratch directory (not the project repo): `createos sandbox create --shape s-1vcpu-1gb --name test-1` and `createos sandbox exec test-1 -- python3 -c 'print("hello")'`, then delete it
- [ ] (Superseded by 3.2.0: we use the default endpoint; skip this.) Set the EU sandbox endpoint in your shell: `echo 'export CREATEOS_SANDBOX_URL=https://api-eu.sb.createos.sh' >> ~/.bashrc`, also `CREATEOS_SANDBOX_BASE_URL` for the SDK, then `source ~/.bashrc` (required by the organizers)
- [ ] Both joined the Discord
- [ ] Both have free Stripe accounts and a YouTube account for the video
- [ ] Check the Beginner plan situation (item 1 in section 9)

<!-- stripe-projects-cli managed:claude-md:start -->
look at AGENTS.md for your rules
<!-- stripe-projects-cli managed:claude-md:end -->
