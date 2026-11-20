import zlib from "node:zlib";
import { loadConfig } from "./env.mjs";

const { relayUrl, relayToken } = loadConfig();

const sample = {
  g: "排查并发扣款死锁",
  e: "Deadlock found when trying to get lock at F1:142",
  s: { "F1:135-145": "tx.lock(B); tx.lock(A);" },
  q: "如何用最小改动修复？",
};

const raw = Buffer.from(JSON.stringify(sample), "utf8");
const gz = zlib.gzipSync(raw, { level: 9 });
console.log(`1. Submitting gzipped job (raw=${raw.length}B, gzip=${gz.length}B)...`);

const subRes = await fetch(`${relayUrl}/v1/jobs`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${relayToken}`,
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
  },
  body: gz,
});
if (!subRes.ok) throw new Error(`Submit failed: ${subRes.status} ${await subRes.text()}`);
const { job_id: jobId, sid } = await subRes.json();
console.log("   Submitted:", { jobId, sid });

console.log("2. Polling /v1/poll...");
const pollRes = await fetch(`${relayUrl}/v1/poll`, {
  headers: { Authorization: `Bearer ${relayToken}` },
});
if (pollRes.status !== 200) throw new Error(`Poll failed: ${pollRes.status}`);
const polled = await pollRes.json();
console.log("   Polled job:", polled.job_id, polled.payload.g);

console.log("3. Replying /v1/jobs/:id/reply...");
const replyPayload = {
  act: "patch",
  ans: "统一加锁顺序为先 A 后 B",
  diff: "@@ -135,1 +135,1 @@\n- tx.lock(B); tx.lock(A);\n+ tx.lock(A); tx.lock(B);",
  need: [],
};
const replyGz = zlib.gzipSync(Buffer.from(JSON.stringify(replyPayload), "utf8"), { level: 9 });
const repRes = await fetch(`${relayUrl}/v1/jobs/${jobId}/reply`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${relayToken}`,
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
  },
  body: replyGz,
});
if (!repRes.ok) throw new Error(`Reply failed: ${repRes.status}`);
console.log(`   Replied (gzip=${replyGz.length}B)`);

console.log("4. Fetching result /v1/jobs/:id...");
const getRes = await fetch(`${relayUrl}/v1/jobs/${jobId}`, {
  headers: { Authorization: `Bearer ${relayToken}` },
});
const result = await getRes.json();
console.log("   Result:", JSON.stringify(result, null, 2));
console.log("E2E PASSED!");
