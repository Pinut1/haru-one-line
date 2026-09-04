#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const ASSETS = ["index.html", "app.js", "styles.css", "config.js"];
const DEFAULT_BASE_URL = "https://my-ochre-gamma.vercel.app";

function readOptions(argv) {
  const options = {
    root: process.cwd(),
    baseUrl: process.env.DEPLOYMENT_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: 8_000,
    retries: 12,
    retryDelayMs: 10_000,
  };
  const names = {
    "--root": "root",
    "--base-url": "baseUrl",
    "--timeout-ms": "timeoutMs",
    "--retries": "retries",
    "--retry-delay-ms": "retryDelayMs",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    options[key] = key === "root" || key === "baseUrl" ? value : Number(value);
  }
  if (![options.timeoutMs, options.retries, options.retryDelayMs].every(Number.isInteger) ||
      options.timeoutMs < 1 || options.retries < 1 || options.retryDelayMs < 0) {
    throw new Error("Timeout and retry options must be bounded integers (retries and timeout >= 1). ");
  }
  options.root = path.resolve(options.root);
  options.baseUrl = options.baseUrl.replace(/\/$/, "");
  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function compareOnce(options, attempt) {
  return Promise.all(ASSETS.map(async (file) => {
    const local = await readFile(path.join(options.root, file));
    const url = new URL(`${options.baseUrl}/${file}`);
    url.searchParams.set("_haru_verify", `${Date.now()}-${attempt}`);
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const remote = Buffer.from(await response.arrayBuffer());
    return { file, localHash: sha256(local), remoteHash: sha256(remote) };
  }));
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  let lastResults = null;
  let lastError = null;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      lastResults = await compareOnce(options, attempt);
      lastError = null;
      if (lastResults.every((result) => result.localHash === result.remoteHash)) {
        for (const result of lastResults) console.log(`${result.file} MATCH ${result.localHash}`);
        console.log(`Deployment assets match ${options.baseUrl} (attempt ${attempt}/${options.retries}).`);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < options.retries) {
      const reason = lastError ? lastError.message : "asset hashes have not converged";
      console.log(`Attempt ${attempt}/${options.retries}: ${reason}; retrying in ${options.retryDelayMs}ms.`);
      await pause(options.retryDelayMs);
    }
  }

  if (lastError) {
    console.error(`Deployment verification failed: ${lastError.message}`);
  } else {
    for (const result of lastResults) {
      const state = result.localHash === result.remoteHash ? "MATCH" : "MISMATCH";
      console.log(`${result.file} ${state} local ${result.localHash} remote ${result.remoteHash}`);
    }
    console.error(`Deployment assets do not match ${options.baseUrl}.`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Deployment verification failed: ${error.message}`);
  process.exitCode = 1;
});
