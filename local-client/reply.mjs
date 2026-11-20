import fs from "node:fs";
import zlib from "node:zlib";
import { loadConfig } from "./env.mjs";

const { relayUrl, relayToken } = loadConfig();
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage:");
  console.error("  node reply.mjs <job_id> '<json>'");
  console.error("  node reply.mjs <job_id> --file <path-to-json>");
  process.exit(1);
}

const jobId = args[0];
let jsonText;
if (args[1] === "--file" && args[2]) {
  jsonText = fs.readFileSync(args[2], "utf8");
} else {
  jsonText = args.slice(1).join(" ");
}

// 校验是否为合法 JSON
const parsed = JSON.parse(jsonText);
const gzBuf = zlib.gzipSync(Buffer.from(JSON.stringify(parsed), "utf8"), { level: 9 });

const res = await fetch(`${relayUrl}/v1/jobs/${jobId}/reply`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${relayToken}`,
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
  },
  body: gzBuf,
});

if (!res.ok) {
  console.error(`Reply failed HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(`Replied to ${jobId} (gzipped ${gzBuf.length} bytes):`, await res.json());
