# remote-advisor-mcp

超轻量级 MCP 工具 + Cloudflare Workers 中转信箱：让公司内网能力较弱的 Claude Code 通过**极小 HTTPS + Gzip Payload（单次 ~200B–1.5KB）**向外部强模型或你正在使用的 Antigravity 对话求助。

> **让 AI Agent 自动帮你安装？** 直接把 [AGENT_SETUP.md](./AGENT_SETUP.md) 交给你的 Claude Code / Antigravity，让它按步骤自动完成配置即可！

## 架构一览

```text
[公司内网电脑]                              [Cloudflare Worker + KV]                       [你的个人电脑 / Antigravity]
Claude Code ◄──(stdio)──► mcp-bridge.mjs ──HTTPS+Gzip (≤2KB)──► Relay (TTL 10m) ◄──HTTPS── watch-once.mjs / reply.mjs
                           ├─ 路径匿名化 (F1/F2)                                            └─ 任务到达自动唤醒当前对话
                           ├─ 敏感凭证正则拦截
                           └─ Gzip 压缩 + 2KB 硬上限
```

## 目录结构

- `mcp-bridge/`：标准 MCP Server（`ask_advisor` 工具），支持路径别名映射、敏感词拦截、gzip 压缩、2KB 上限校验、异步轮询及路径自动还原。
- `relay-worker/`：零外部依赖的 Cloudflare Worker + KV 中转站（Web Crypto 恒定时间鉴权、支持 gzip、每轮问答仅 3 次 KV 写入，免费额度每天可撑 300+ 轮）。
- `local-client/`：外网侧客户端（`watch-once.mjs` 自动唤醒对话 + `reply.mjs` 压缩回传 + `test-e2e.mjs` 全链路自测）。
- `AGENT_SETUP.md`：给 AI Agent 阅读的自动化安装与运行指南。

## 快速开始

### 1. 内网电脑接入 MCP（Client 侧）

```bash
git clone https://github.com/HoikanChan/remote-advisor-mcp.git
cd remote-advisor-mcp
npm install

claude mcp add remote-advisor \
  -e RELAY_URL="https://remote-advisor-relay.<your-subdomain>.workers.dev" \
  -e RELAY_TOKEN="<your-shared-secret>" \
  -e NODE_USE_ENV_PROXY="1" \
  -- node "$(pwd)/mcp-bridge/mcp-bridge.mjs"
```

将 `mcp-bridge/CLAUDE.md.example` 的规范添加到项目 `CLAUDE.md` 中，约束弱模型只传关键代码片段。

### 2. 部署 Cloudflare Worker 中转站（Relay 侧）

```bash
cd relay-worker
npm install
cp wrangler.jsonc.example wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create RELAY_KV   # 把返回的 id 填进 wrangler.jsonc
npx wrangler deploy
npx wrangler secret put RELAY_TOKEN
```

### 3. 外网本机测试与开启监听（Advisor 侧）

复制 `local-client/.env.example` 为 `local-client/.env` 并填入 `RELAY_URL` 和 `RELAY_TOKEN`，然后运行：

```bash
npm run test:e2e
```

在 Antigravity 对话里说一句 **“按 AGENT_SETUP.md 开启远程顾问监听”**，即可实时接收并解答内网求助。
