import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createLspClient } from "../src/client.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerPath = join(__dirname, "fake-server.ts");

function spawnFake(options: Record<string, unknown> = {}) {
  const args = ["--import", "tsx", fakeServerPath, "--run"];
  if (Object.keys(options).length > 0) {
    args.push(`--options=${JSON.stringify(options)}`);
  }
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("LspClient", () => {
  it("receives diagnostics after didOpen", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("returns ok with empty diagnostics for clean file", async () => {
    const child = spawnFake({
      diagnosticsByUri: { "file:///tmp/test-workspace/clean.go": [] },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/clean.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);

    await client.shutdown();
  });

  it("returns ok even with delayed diagnostics", async () => {
    const child = spawnFake({ diagnosticDelay: 500 });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);

    await client.shutdown();
  });

  it("returns timeout when server never publishes", async () => {
    const child = spawnFake({ neverPublish: true });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 500);
    assert.equal(result.status, "timeout");

    await client.shutdown();
  });

  it("returns latest diagnostics after rapid didChange", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake({
      diagnosticDelay: 100,
      diagnosticsByUri: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: "latest error",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main\nfunc a() {}");
    client.didChange(uri, "package main\nfunc b() {}");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0);

    await client.shutdown();
  });

  it("didClose removes document so next didOpen is treated as fresh", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    // Open and wait for diagnostics once
    client.didOpen(uri, "go", "package main");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.status, "ok");

    // Close the document — should remove tracking state
    client.didClose(uri);

    // Re-open: the client should send didOpen (not didChange) so fake server
    // publishes diagnostics again
    client.didOpen(uri, "go", "package main");
    const second = await client.waitForDiagnostics(uri, 2000);
    assert.equal(second.status, "ok");
    assert.equal(second.diagnostics.length, 1);

    await client.shutdown();
  });

  it("completes graceful shutdown", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");
    await client.shutdown();
    // no assertion needed — test passes if no error is thrown
  });

  it("collects other-file diagnostics", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const otherUri = "file:///tmp/test-workspace/other.go";
    const child = spawnFake({
      otherFileDiagnostics: {
        [otherUri]: [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            severity: 1,
            message: "error in other file",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.otherFiles.length > 0);
    assert.equal(result.otherFiles[0].uri, otherUri);
    assert.equal(result.otherFiles[0].errorCount, 1);

    await client.shutdown();
  });
});
