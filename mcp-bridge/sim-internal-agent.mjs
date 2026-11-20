import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../local-client/.env");

// 从 local-client/.env 读取配置（模拟内网环境变量）
const envVars = { ...process.env, NODE_USE_ENV_PROXY: "1" };
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    envVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "mcp-bridge.mjs")],
  env: envVars,
});

const client = new Client({ name: "sim-internal-claude-code", version: "1.0.0" });
await client.connect(transport);

console.log("[sim-internal-agent] Connected to real mcp-bridge.mjs via stdio.");
console.log("[sim-internal-agent] Calling ask_advisor tool...");

const result = await client.callTool({
  name: "ask_advisor",
  arguments: {
    goal: "修复异步退款重试导致余额多加一次的并发 Bug",
    error: "AssertionError: expected balance 100, got 200 under 2 concurrent refund retries",
    snippets: [
      {
        file: "src/modules/payment/refund.ts",
        lines: "42-55",
        code: `async function refund(orderId: string, amount: number) {
  const order = await db.orders.findById(orderId);
  if (order.status === "REFUNDED") return;
  await db.wallets.increment(order.userId, amount);
  await db.orders.update(orderId, { status: "REFUNDED" });
}`,
      },
    ],
    question: "为什么并发下会多退一次？请给最小改动方案和 diff。",
  },
});

console.log("[sim-internal-agent] Received MCP response:");
console.log(result.content?.[0]?.text || JSON.stringify(result, null, 2));

await client.close();
