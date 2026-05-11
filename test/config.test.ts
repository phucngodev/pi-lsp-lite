import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("loadConfig", () => {
  it("returns built-in defaults when no config files exist", async () => {
    const dir = await makeTempDir();
    const config = await loadConfig(dir);
    assert.ok(config.servers.length >= 3);
    assert.ok(config.servers.some((s) => s.id === "go"));
    assert.ok(config.servers.some((s) => s.id === "rust"));
    assert.ok(config.servers.some((s) => s.id === "typescript"));
    assert.equal(config.diagnosticTimeout, 5000);
    assert.equal(config.documentIdleTimeout, 120000);
  });

  it("project config adds a new server", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        python: {
          extensions: [".py"],
          command: "pylsp",
          args: [],
          rootPatterns: ["pyproject.toml"],
        },
      },
    }));
    const config = await loadConfig(dir);
    assert.ok(config.servers.some((s) => s.id === "python"));
    assert.ok(config.servers.some((s) => s.id === "go"));
  });

  it("project config in .pi/lsp-lite.json is discovered", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "lsp-lite.json"), JSON.stringify({
      servers: {
        python: {
          extensions: [".py"],
          command: "pylsp",
          args: [],
          rootPatterns: ["pyproject.toml"],
        },
      },
    }));
    const config = await loadConfig(dir);
    assert.ok(config.servers.some((s) => s.id === "python"));
  });

  it("project config disables a built-in server", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        typescript: { disabled: true },
      },
    }));
    const config = await loadConfig(dir);
    assert.ok(!config.servers.some((s) => s.id === "typescript"));
    assert.ok(config.servers.some((s) => s.id === "go"));
  });

  it("partial override changes only specified fields", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        typescript: { args: ["--stdio", "--log-level", "4"] },
      },
    }));
    const config = await loadConfig(dir);
    const ts = config.servers.find((s) => s.id === "typescript");
    assert.ok(ts);
    assert.deepEqual(ts.args, ["--stdio", "--log-level", "4"]);
    assert.equal(ts.command, "typescript-language-server");
    assert.deepEqual(ts.extensions, [".ts", ".tsx", ".js", ".jsx"]);
  });

  it("skips new server without required fields", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        incomplete: { args: ["--stdio"] },
      },
    }));
    const config = await loadConfig(dir);
    assert.ok(!config.servers.some((s) => s.id === "incomplete"));
  });

  it("handles malformed JSON gracefully", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), "{ broken json");
    const config = await loadConfig(dir);
    assert.ok(config.servers.length >= 3);
  });

  it("overrides global diagnosticTimeout", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      diagnosticTimeout: 8000,
    }));
    const config = await loadConfig(dir);
    assert.equal(config.diagnosticTimeout, 8000);
  });

  it("overrides documentIdleTimeout", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      documentIdleTimeout: 60000,
    }));
    const config = await loadConfig(dir);
    assert.equal(config.documentIdleTimeout, 60000);
  });

  it("per-server diagnosticTimeout override", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".pi-lsp-lite.json"), JSON.stringify({
      servers: {
        rust: { diagnosticTimeout: 10000 },
      },
    }));
    const config = await loadConfig(dir);
    assert.equal(config.perServerTimeout.get("rust"), 10000);
    assert.equal(config.perServerTimeout.has("go"), false);
  });
});
