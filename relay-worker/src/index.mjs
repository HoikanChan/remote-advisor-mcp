const MAX_RAW_BYTES = 8192;        // 压缩后最大 8KB
const MAX_DECOMPRESSED_BYTES = 32768; // 解压后最大 32KB
const JOB_TTL_SECONDS = 600;       // 任务/回复 10 分钟自动焚毁

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 使用 Web Crypto 进行恒定时间 Token 比对，避免时序侧信道
async function verifyBearerToken(request, expectedToken) {
  if (!expectedToken) return false;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const provided = auth.slice(7);

  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expectedToken)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// 读取请求体，支持 Content-Encoding: gzip，并限制最大字节数
async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_RAW_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  const rawBuf = await request.arrayBuffer();
  if (rawBuf.byteLength > MAX_RAW_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  if (rawBuf.byteLength === 0) return {};

  let text;
  if ((request.headers.get("content-encoding") || "").toLowerCase() === "gzip") {
    const ds = new DecompressionStream("gzip");
    const decompressedStream = new Response(rawBuf).body.pipeThrough(ds);
    const decompressedBuf = await new Response(decompressedStream).arrayBuffer();
    if (decompressedBuf.byteLength > MAX_DECOMPRESSED_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    text = new TextDecoder().decode(decompressedBuf);
  } else {
    text = new TextDecoder().decode(rawBuf);
  }

  return JSON.parse(text);
}

function makeJobId() {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `${ts}-${rand}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 健康检查
    if (request.method === "GET" && pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    // 鉴权
    const authed = await verifyBearerToken(request, env.RELAY_TOKEN);
    if (!authed) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    try {
      // 1. 内网提交求助任务：POST /v1/jobs
      if (request.method === "POST" && pathname === "/v1/jobs") {
        const body = await readJsonBody(request);
        const jobId = makeJobId();
        const sid = body.sid || `s_${crypto.randomUUID().slice(0, 6)}`;

        const record = {
          job_id: jobId,
          sid,
          created_at: new Date().toISOString(),
          payload: body,
        };

        await env.RELAY_KV.put(`pending:${jobId}`, JSON.stringify(record), {
          expirationTtl: JOB_TTL_SECONDS,
        });

        console.log(JSON.stringify({ event: "job_created", jobId, sid }));
        return jsonResponse({ job_id: jobId, sid }, 201);
      }

      // 2. 本机/Antigravity 轮询拉取待处理任务：GET /v1/poll
      if (request.method === "GET" && pathname === "/v1/poll") {
        const list = await env.RELAY_KV.list({ prefix: "pending:", limit: 1 });
        if (!list.keys.length) {
          return new Response(null, { status: 204 });
        }

        const keyName = list.keys[0].name;
        const raw = await env.RELAY_KV.get(keyName);
        await env.RELAY_KV.delete(keyName);

        if (!raw) {
          return new Response(null, { status: 204 });
        }

        const record = JSON.parse(raw);
        console.log(JSON.stringify({ event: "job_polled", jobId: record.job_id }));
        return jsonResponse(record, 200);
      }

      // 3. 本机/Antigravity 回传答案：POST /v1/jobs/:id/reply
      const replyMatch = pathname.match(/^\/v1\/jobs\/([a-z0-9-]+)\/reply$/i);
      if (request.method === "POST" && replyMatch) {
        const jobId = replyMatch[1];
        const body = await readJsonBody(request);

        await env.RELAY_KV.put(
          `reply:${jobId}`,
          JSON.stringify({
            job_id: jobId,
            replied_at: new Date().toISOString(),
            data: body,
          }),
          { expirationTtl: JOB_TTL_SECONDS }
        );

        console.log(JSON.stringify({ event: "job_replied", jobId }));
        return jsonResponse({ ok: true, job_id: jobId }, 200);
      }

      // 4. 内网轮询取回答案：GET /v1/jobs/:id
      const getMatch = pathname.match(/^\/v1\/jobs\/([a-z0-9-]+)$/i);
      if (request.method === "GET" && getMatch) {
        const jobId = getMatch[1];
        const raw = await env.RELAY_KV.get(`reply:${jobId}`);
        if (!raw) {
          return jsonResponse({ status: "pending", job_id: jobId }, 200);
        }

        const reply = JSON.parse(raw);
        console.log(JSON.stringify({ event: "job_fetched", jobId }));
        return jsonResponse({ status: "done", job_id: jobId, data: reply.data }, 200);
      }

      return jsonResponse({ error: "not_found" }, 404);
    } catch (err) {
      if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
        return jsonResponse({ error: "payload_too_large" }, 413);
      }
      console.error(JSON.stringify({ event: "error", message: String(err) }));
      return jsonResponse({ error: "bad_request" }, 400);
    }
  },
};
