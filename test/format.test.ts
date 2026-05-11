import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDiagnostics } from "../src/format.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "../src/client.js";

function makeDiag(severity: DiagnosticSeverity, message: string, line = 0, col = 0): Diagnostic {
  return {
    range: { start: { line, character: col }, end: { line, character: col + 5 } },
    severity,
    message,
    source: "test",
  };
}

describe("formatDiagnostics", () => {
  it("formats ok result with errors and warnings", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Error, "undefined variable", 4, 10),
        makeDiag(DiagnosticSeverity.Warning, "unused import", 1, 0),
      ],
      otherFiles: [],
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("1 warning"));
    assert.ok(output.includes("error 5:11"));
    assert.ok(output.includes("warning 2:1"));
    assert.ok(output.includes("undefined variable"));
    assert.ok(output.includes("unused import"));
  });

  it("returns empty string for ok result with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [],
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });

  it("returns timeout message for timeout with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [],
      otherFiles: [],
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out"));
    assert.ok(output.includes("main.go"));
  });

  it("includes 'timed out, may be incomplete' for timeout with diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "some error")],
      otherFiles: [],
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out, may be incomplete"));
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("some error"));
  });

  it("appends other-file footer when otherFiles is non-empty", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "type mismatch")],
      otherFiles: [
        { uri: "file:///project/other.go", errorCount: 2, warningCount: 1 },
        { uri: "file:///project/another.go", errorCount: 0, warningCount: 3 },
      ],
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("6 diagnostics in 2 other files"));
  });

  it("shows other-file footer even when main file has no issues", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [{ uri: "file:///project/other.go", errorCount: 1, warningCount: 0 }],
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("1 diagnostic in 1 other file"));
  });

  it("filters out info and hint severity diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Information, "info message"),
        makeDiag(DiagnosticSeverity.Hint, "hint message"),
      ],
      otherFiles: [],
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });
});
