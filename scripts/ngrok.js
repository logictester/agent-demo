#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

function parseTarget(spec, index) {
  const raw = String(spec || "").trim();
  if (!raw) {
    return null;
  }

  if (/^\d+$/.test(raw)) {
    return {
      name: `port-${raw}-${index + 1}`,
      port: Number(raw)
    };
  }

  const parts = raw.split("=");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return {
      name: String(parts[0] || `port-${parts[1]}`).trim().toLowerCase(),
      port: Number(parts[1])
    };
  }

  return null;
}

const rawTargets = process.argv.slice(2);
const targets = (rawTargets.length ? rawTargets : ["backend=4000", "frontend=5173"])
  .map(parseTarget)
  .filter(Boolean);

if (!targets.length) {
  console.error("[ngrok] No valid targets provided.");
  process.exit(1);
}

const configPath = path.join(os.tmpdir(), `agent-demo-ngrok-${Date.now()}.yml`);
const homeDir = os.homedir();
const defaultConfigCandidates = [
  process.env.NGROK_CONFIG,
  path.join(homeDir, "Library", "Application Support", "ngrok", "ngrok.yml"),
  path.join(homeDir, ".config", "ngrok", "ngrok.yml"),
  path.join(homeDir, ".ngrok2", "ngrok.yml")
].filter(Boolean);
const baseConfigPaths = defaultConfigCandidates.filter((candidate) => fs.existsSync(candidate));
const tunnelConfig = [
  'version: "2"',
  "tunnels:",
  ...targets.flatMap((target) => [
    `  ${target.name}:`,
    "    proto: http",
    `    addr: http://127.0.0.1:${target.port}`,
    "    inspect: true"
  ])
].join("\n");

fs.writeFileSync(configPath, `${tunnelConfig}\n`, "utf8");

function cleanupConfig() {
  try {
    fs.unlinkSync(configPath);
  } catch {
    // ignore cleanup failure
  }
}

function fetchTunnelData() {
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
  });
}

function printTunnelSummary(data) {
  const tunnels = Array.isArray(data?.tunnels) ? data.tunnels : [];
  if (!tunnels.length) {
    return;
  }

  console.log("[ngrok] Active public URLs:");
  for (const tunnel of tunnels) {
    const addr = String(tunnel?.config?.addr || "").trim();
    const label =
      targets.find((target) => addr.endsWith(`:${target.port}`))?.name ||
      tunnel?.name ||
      "tunnel";
    console.log(`[ngrok]   ${label}: ${tunnel.public_url} -> ${addr}`);
  }
  console.log("[ngrok] Backend URL is the one to use for Slack interactivity callbacks.");
  console.log("[ngrok] Frontend URL can be copied into FRONTEND_APP_URL if you want Slack links to open the public app.");
}

const child = spawn(
  "ngrok",
  ["start", "--all", ...baseConfigPaths.flatMap((item) => ["--config", item]), "--config", configPath],
  {
    stdio: "inherit",
    shell: false
  }
);

let printedSummary = false;
let pollAttempts = 0;
const maxPollAttempts = 30;
const pollHandle = setInterval(async () => {
  if (printedSummary) {
    return;
  }
  pollAttempts += 1;
  try {
    const data = await fetchTunnelData();
    if (Array.isArray(data?.tunnels) && data.tunnels.length >= targets.length) {
      printedSummary = true;
      printTunnelSummary(data);
    }
  } catch {
    // ngrok API may not be ready yet
  }
  if (!printedSummary && pollAttempts >= maxPollAttempts) {
    printedSummary = true;
    console.log("[ngrok] Tunnel started, but the public URL was not retrieved automatically.");
    console.log("[ngrok] Open http://127.0.0.1:4040/api/tunnels locally to inspect the active endpoints.");
  }
}, 1000);

child.on("error", (error) => {
  clearInterval(pollHandle);
  cleanupConfig();
  if (error?.code === "ENOENT") {
    console.error("[ngrok] The ngrok CLI was not found on your PATH.");
    console.error("[ngrok] Install it and rerun npm run dev:tunnel.");
    return process.exit(1);
  }
  console.error("[ngrok] Failed to start:", error?.message || error);
  process.exit(1);
});

child.on("spawn", () => {
  console.log(`[ngrok] Starting tunnels for: ${targets.map((target) => `${target.name}:${target.port}`).join(", ")}`);
  console.log("[ngrok] Press Ctrl+C to stop all tunnels.");
});

child.on("exit", (code, signal) => {
  clearInterval(pollHandle);
  cleanupConfig();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 0 : code);
});
