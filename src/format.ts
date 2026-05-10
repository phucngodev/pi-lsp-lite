import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "./client.js";

export function formatDiagnostics(filePath: string, result: DiagnosticResult): string {
  const relevant = result.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );

  if (relevant.length === 0 && result.status === "ok") return "";

  if (relevant.length === 0 && result.status === "timeout") {
    return `\n⚠ LSP diagnostics for ${filePath}: timed out waiting for response (results may be incomplete)`;
  }

  const lines = relevant.map((d) => {
    const severity = d.severity === DiagnosticSeverity.Error ? "error" : "warning";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? `[${d.source}] ` : "";
    return `  ${severity} ${line}:${col} ${source}${d.message}`;
  });

  const errorCount = relevant.filter((d) => d.severity === DiagnosticSeverity.Error).length;
  const warnCount = relevant.length - errorCount;

  const summary = [
    errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : "",
    warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "",
    result.status === "timeout" ? "timed out, may be incomplete" : "",
  ]
    .filter(Boolean)
    .join(", ");

  return `\n⚠ LSP diagnostics for ${filePath} (${summary}):\n${lines.join("\n")}`;
}
