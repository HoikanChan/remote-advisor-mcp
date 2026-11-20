import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./env.mjs";

const { relayUrl, relayToken, dir } = loadConfig();
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.error(`[watch-once] Listening on ${relayUrl}/v1/poll (interval ${POLL_MS}ms)...`);

while (true) {
  try {
    const res = await fetch(`${relayUrl}/v1/poll`, {
      headers: {
        Authorization: `Bearer ${relayToken}`,
        "Accept-Encoding": "gzip",
      },
    });

    if (res.status === 200) {
      const job = await res.json();
      fs.writeFileSync(path.join(dir, ".last-job.json"), JSON.stringify(job, null, 2), "utf8");
      console.log(JSON.stringify(job, null, 2));
      process.exit(0);
    }

    if (res.status !== 204) {
      console.error(`[watch-once] Unexpected HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[watch-once] Network error: ${err.message}`);
  }

  await sleep(POLL_MS);
}
