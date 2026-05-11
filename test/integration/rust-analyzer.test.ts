import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerManager } from "../../src/server-manager.js";
import { languages } from "../../src/languages.js";

const rustConfig = languages.find((l) => l.id === "rust")!;

let tempDirs: string[] = [];
let managers: ReturnType<typeof createServerManager>[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-rust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeManager() {
  const m = createServerManager();
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers) await m.shutdownAll();
  managers = [];
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  tempDirs = [];
});

describe("rust-analyzer integration", { skip: !process.env.INTEGRATION }, () => {
  it("reports syntax error", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "main.rs");
    await writeFile(filePath, "fn main() {\n  let x = \n}\n");

    const manager = makeManager();
    const result = await manager.handleEdit(filePath, rustConfig, dir);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0, "expected at least one diagnostic for syntax error");
  });

  it("reports no errors for clean file", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    const filePath = join(srcDir, "main.rs");
    await writeFile(filePath, 'fn main() {\n    println!("hello");\n}\n');

    const manager = makeManager();
    const result = await manager.handleEdit(filePath, rustConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
  });

  it("detects cross-file breakage", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    const srcDir = join(dir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "lib.rs"),
      "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    );
    await writeFile(
      join(srcDir, "main.rs"),
      'mod lib;\n\nfn main() {\n    println!("{}", lib::add(1, 2));\n}\n',
    );

    const manager = makeManager();

    await manager.handleEdit(join(srcDir, "main.rs"), rustConfig, dir);
    await manager.handleEdit(join(srcDir, "lib.rs"), rustConfig, dir);

    // break the signature: change add to take 3 args
    await writeFile(
      join(srcDir, "lib.rs"),
      "pub fn add(a: i32, b: i32, c: i32) -> i32 {\n    a + b + c\n}\n",
    );
    const result = await manager.handleEdit(join(srcDir, "lib.rs"), rustConfig, dir);
    assert.equal(result.status, "ok");

    const totalDiags = result.diagnostics.length + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
