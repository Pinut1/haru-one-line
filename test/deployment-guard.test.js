import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardScript = path.join(repositoryRoot, "scripts", "verify-deployment.js");
const assets = ["index.html", "app.js", "styles.css", "config.js"];

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "haru-deployment-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = Object.fromEntries(assets.map((file) => [file, `canonical ${file}\n`]));
  await Promise.all(assets.map((file) => writeFile(path.join(root, file), contents[file])));

  const server = createServer((request, response) => {
    const file = path.basename(new URL(request.url, "http://localhost").pathname);
    if (!assets.includes(file)) {
      response.writeHead(404).end("missing");
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.end(overrides[file] ?? contents[file]);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return { root, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function runGuard(root, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      guardScript,
      "--root", root,
      "--base-url", baseUrl,
      "--timeout-ms", "1000",
      "--retries", "1",
      "--retry-delay-ms", "1",
    ], { cwd: repositoryRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("deployment guard passes when all deployed assets match", async (t) => {
  const { root, baseUrl } = await fixture(t);
  const result = await runGuard(root, baseUrl);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  for (const file of assets) assert.match(result.stdout, new RegExp(`${file}.*MATCH`));
});

test("deployment guard fails with per-file diagnostics on mismatch", async (t) => {
  const { root, baseUrl } = await fixture(t, { "app.js": "stale app.js\n" });
  const result = await runGuard(root, baseUrl);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /app\.js.*MISMATCH/);
  assert.match(result.stdout, /local [a-f0-9]{64}/);
  assert.match(result.stdout, /remote [a-f0-9]{64}/);
});
