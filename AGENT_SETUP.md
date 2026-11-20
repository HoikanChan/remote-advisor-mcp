# Agent Automated Setup Guide (`remote-advisor-mcp`)

> **For AI Agents (Claude Code / Antigravity / Cursor / Codex):**
> Follow the section matching your role below. Do not hardcode or commit `RELAY_TOKEN` or `.env` files into Git.

---

## Role A: Internal Machine Agent (Claude Code / Client Side)

Use this section when setting up `remote-advisor-mcp` on an internal machine so that Claude Code can call the `ask_advisor` MCP tool.

### Step 1: Verify prerequisites
1. Confirm Node.js >= 18 is installed:
   ```bash
   node -v
   ```
2. Install dependencies at the repository root:
   ```bash
   npm install
   ```

### Step 2: Obtain Relay credentials from the user
Ask the user for two values (do **not** invent them):
- `RELAY_URL`: The deployed Cloudflare Worker HTTPS URL (e.g. `https://remote-advisor-relay.<subdomain>.workers.dev`)
- `RELAY_TOKEN`: The shared Bearer token configured on the Worker

### Step 3: Verify HTTPS connectivity to the Relay
Run a quick health check (if the machine uses a corporate HTTP proxy, ensure `HTTP_PROXY`/`HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` are set):
```bash
curl -sS "$RELAY_URL/health"
```
Expected output: `{"ok":true}`

### Step 4: Register the MCP Server in Claude Code
Replace `<ABS_PATH_TO_REPO>`, `<RELAY_URL>`, and `<RELAY_TOKEN>` with actual values:
```bash
claude mcp add remote-advisor \
  -e RELAY_URL="<RELAY_URL>" \
  -e RELAY_TOKEN="<RELAY_TOKEN>" \
  -e NODE_USE_ENV_PROXY="1" \
  -e MAX_GZIP_BYTES="2048" \
  -- node "<ABS_PATH_TO_REPO>/mcp-bridge/mcp-bridge.mjs"
```
Verify registration:
```bash
claude mcp list
```

### Step 5: Add usage rules to the project's `CLAUDE.md`
Append the contents of `mcp-bridge/CLAUDE.md.example` into the target workspace's `CLAUDE.md` so the local model obeys the compact payload rules:
- Never send full files; send at most 2–3 snippets (<= 30 lines each) and <= 10 lines of core error trace.
- Never include secrets, private keys, or credentials.
- Follow `act: "ask"` + `need` probes strictly by reading only the requested file lines and passing the same `session_id`.

### Step 6: Smoke test
Tell the user setup is complete and offer to run one test `ask_advisor` call once the external advisor listener is active.

---

## Role B: External Machine Agent (Advisor / Antigravity Side)

Use this section when deploying the Cloudflare Worker Relay and running the external advisor listener.

### Step 1: Deploy the Cloudflare Worker (`relay-worker/`)
1. Install Wrangler dependencies:
   ```bash
   cd relay-worker
   npm install
   ```
2. Copy config template:
   ```bash
   cp wrangler.jsonc.example wrangler.jsonc
   ```
3. Authenticate with Cloudflare (`npx wrangler login` or set `CLOUDFLARE_API_TOKEN` in environment).
4. Create the KV namespace and copy its returned `id` into `relay-worker/wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create RELAY_KV
   ```
5. Deploy the Worker and note the deployed `https://*.workers.dev` URL:
   ```bash
   npx wrangler deploy
   ```
6. Generate a random 48-char hex `RELAY_TOKEN` and upload it as a Worker secret (never commit it):
   ```bash
   # Example (macOS/Linux):
   TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")
   printf "%s" "$TOKEN" | npx wrangler secret put RELAY_TOKEN
   ```

### Step 2: Configure `local-client/.env`
Copy `local-client/.env.example` to `local-client/.env` and fill in:
```env
RELAY_URL=https://remote-advisor-relay.<your-subdomain>.workers.dev
RELAY_TOKEN=<your-generated-token>
POLL_INTERVAL_MS=3000
```

### Step 3: Run End-to-End Verification
```bash
NODE_USE_ENV_PROXY=1 node local-client/test-e2e.mjs
```
Expected final line: `E2E PASSED!`

### Step 4: Operate the Live Advisor Loop (Direct Conversation Mode)
When the user asks to start listening for internal requests:
1. Run `local-client/watch-once.mjs` in the background (`NODE_USE_ENV_PROXY=1 node local-client/watch-once.mjs`).
2. When a job arrives, `watch-once.mjs` prints the job JSON and exits with code `0`, waking the agent automatically.
3. Read the job (`job_id`, `sid`, `payload`: `{ g, e, s, q }`) and formulate a **compact JSON response**:
   ```json
   {
     "act": "ask | patch | plan",
     "ans": "Concise root cause or plan (<= 150 chars)",
     "diff": "Minimal unified diff using the same F1/F2 aliases (only when act=patch)",
     "need": ["F1:40-70"]
   }
   ```
   - Keep file aliases (`F1`, `F2`, ...) intact; the internal `mcp-bridge.mjs` restores real paths automatically.
   - If context is insufficient, return `act: "ask"` with exact line ranges in `need` instead of guessing.
4. Write the JSON to `local-client/.last-reply.json` and send it back:
   ```bash
   NODE_USE_ENV_PROXY=1 node local-client/reply.mjs <job_id> --file local-client/.last-reply.json
   ```
5. Immediately restart `local-client/watch-once.mjs` in the background to wait for the next request.

---

## Wire Protocol Summary

| Endpoint | Method | Direction | Purpose |
| :--- | :--- | :--- | :--- |
| `/health` | `GET` | Any | Health check (`{"ok":true}`) |
| `/v1/jobs` | `POST` | Internal -> Relay | Submit gzipped compact job (`<= 2KB` recommended) |
| `/v1/jobs/:id` | `GET` | Internal -> Relay | Poll for reply (`pending` or `done`) |
| `/v1/poll` | `GET` | External -> Relay | Pop oldest pending job (`200` with job, or `204` empty) |
| `/v1/jobs/:id/reply` | `POST` | External -> Relay | Submit gzipped compact JSON reply |

All `/v1/*` routes require `Authorization: Bearer <RELAY_TOKEN>` and auto-expire in KV after 10 minutes (`expirationTtl: 600`).
