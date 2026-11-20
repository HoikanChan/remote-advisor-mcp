#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import zlib from "node:zlib";

const RELAY_URL = (process.env.RELAY_URL || "").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const MAX_GZIP_BYTES = Number(process.env.MAX_GZIP_BYTES || 2048); // 压缩后上限，默认 2KB
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_SEC || 180) * 1000;

if (!RELAY_URL || !RELAY_TOKEN) {
  console.error("Missing RELAY_URL or RELAY_TOKEN environment variables.");
  process.exit(1);
}

// 路径短别名映射，减小体积并避免暴露真实目录结构
const pathToAlias = new Map();
const aliasToPath = new Map();
let aliasSeq = 1;

function toAlias(filePath) {
  if (!pathToAlias.has(filePath)) {
    const id = `F${aliasSeq++}`;
    pathToAlias.set(filePath, id);
    aliasToPath.set(id, filePath);
  }
  return pathToAlias.get(filePath);
}

function restoreAliases(obj) {
  let str = JSON.stringify(obj);
  for (const [alias, realPath] of aliasToPath.entries()) {
    str = str.replaceAll(alias, realPath);
  }
  return JSON.parse(str);
}

// 敏感信息拦截 + 基础去噪
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /(api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{16})\b/,
];

function sanitizeAndSlim(text = "") {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new Error("BLOCKED: 检测到疑似密钥/敏感凭证，已拦截外发。请脱敏后重试。");
    }
  }
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function submitAndWait(payload) {
  const jsonBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const gzBuf = zlib.gzipSync(jsonBuf, { level: 9 });

  if (gzBuf.length > MAX_GZIP_BYTES) {
    return {
      error: `Payload 过大（gzip 后 ${gzBuf.length}B > 上限 ${MAX_GZIP_BYTES}B）。请精简 snippets（每段 ≤ 30 行）和 error 后重试。`,
    };
  }

  // 1. 提交任务
  const postRes = await fetch(`${RELAY_URL}/v1/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RELAY_TOKEN}`,
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Accept-Encoding": "gzip",
    },
    body: gzBuf,
  });

  if (!postRes.ok) {
    throw new Error(`Submit HTTP ${postRes.status}: ${await postRes.text()}`);
  }
  const { job_id: jobId, sid } = await postRes.json();

  // 2. 轮询等待远端强模型回传结果
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${RELAY_URL}/v1/jobs/${jobId}`, {
      headers: {
        Authorization: `Bearer ${RELAY_TOKEN}`,
        "Accept-Encoding": "gzip",
      },
    });
    if (!pollRes.ok) {
      throw new Error(`Poll HTTP ${pollRes.status}: ${await pollRes.text()}`);
    }
    const body = await pollRes.json();
    if (body.status === "done") {
      return restoreAliases({ sid, ...body.data });
    }
  }

  return {
    sid,
    error: `等待远程顾问超时（>${TIMEOUT_MS / 1000}s），请稍后重试或确认远端监听已开启。`,
  };
}

const server = new McpServer({ name: "remote-advisor", version: "1.0.0" });

server.tool(
  "ask_advisor",
  "向外部强模型顾问求助。严禁传完整文件，仅传核心报错和关键 10~30 行代码片段。",
  {
    session_id: z.string().optional().describe("追问或按 need 补充代码时传入上次返回的 sid"),
    goal: z.string().max(200).optional().describe("一句话目标（首轮必填）"),
    error: z.string().max(800).optional().describe("去重截断后的核心报错（最多 10 行）"),
    snippets: z
      .array(
        z.object({
          file: z.string().describe("文件路径"),
          lines: z.string().describe("行号范围，如 40-70"),
          code: z.string().max(1500).describe("精简代码片段"),
        })
      )
      .max(3)
      .optional(),
    question: z.string().max(300).describe("具体卡点或要确认的问题"),
  },
  async ({ session_id, goal, error, snippets, question }) => {
    try {
      const compactSnips = {};
      for (const item of snippets ?? []) {
        const key = `${toAlias(item.file)}:${item.lines}`;
        compactSnips[key] = sanitizeAndSlim(item.code);
      }

      const payload = {
        ...(session_id ? { sid: session_id } : {}),
        ...(goal ? { g: sanitizeAndSlim(goal) } : {}),
        ...(error ? { e: sanitizeAndSlim(error) } : {}),
        ...(Object.keys(compactSnips).length ? { s: compactSnips } : {}),
        q: sanitizeAndSlim(question),
      };

      const reply = await submitAndWait(payload);
      return {
        content: [{ type: "text", text: JSON.stringify(reply, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `ERROR: ${err.message}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
