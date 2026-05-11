import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  ShutdownRequest,
  ExitNotification,
  PublishDiagnosticsNotification,
  DiagnosticSeverity,
  type InitializeParams,
  type Diagnostic,
} from "vscode-languageserver-protocol/node.js";
import type { ChildProcess } from "node:child_process";
import { fileUri } from "./util.js";

export interface OtherFileDiagnostics {
  uri: string;
  errorCount: number;
  warningCount: number;
}

export interface DiagnosticResult {
  status: "ok" | "timeout";
  diagnostics: Diagnostic[];
  otherFiles: OtherFileDiagnostics[];
}

export interface LspClient {
  initialize(workspaceRoot: string): Promise<void>;
  didOpen(uri: string, languageId: string, content: string): void;
  didChange(uri: string, content: string): void;
  didClose(uri: string): void;
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult>;
  shutdown(): Promise<void>;
}

function countDiagnostics(diags: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) errors++;
    else if (d.severity === DiagnosticSeverity.Warning) warnings++;
  }
  return { errors, warnings };
}

export function createLspClient(child: ChildProcess): LspClient {
  if (!child.stdout || !child.stdin) {
    throw new Error("LSP child process must be spawned with stdio: pipe");
  }

  const connection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  interface DiagnosticEntry {
    diagnostics: Diagnostic[];
    received: boolean;
    resolve?: () => void;
  }

  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  const documentVersion = new Map<string, number>();

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const entry = diagnosticsMap.get(params.uri);
    if (entry) {
      entry.diagnostics = params.diagnostics;
      entry.received = true;
      entry.resolve?.();
    } else {
      diagnosticsMap.set(params.uri, { diagnostics: params.diagnostics, received: true });
    }
  });

  connection.listen();

  return {
    async initialize(workspaceRoot: string) {
      const params: InitializeParams = {
        processId: child.pid ?? null,
        rootUri: fileUri(workspaceRoot),
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
        workspaceFolders: [{ uri: fileUri(workspaceRoot), name: "workspace" }],
      };

      await connection.sendRequest(InitializeRequest.type, params);
      connection.sendNotification(InitializedNotification.type, {});
    },

    didOpen(uri: string, languageId: string, content: string) {
      documentVersion.set(uri, 1);
      diagnosticsMap.set(uri, { diagnostics: [], received: false });
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    },

    didChange(uri: string, content: string) {
      const version = (documentVersion.get(uri) ?? 1) + 1;
      documentVersion.set(uri, version);
      diagnosticsMap.set(uri, { diagnostics: [], received: false });
      connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    },

    didClose(uri: string) {
      connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      diagnosticsMap.delete(uri);
      documentVersion.delete(uri);
    },

    async waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult> {
      // snapshot diagnostic counts for all other tracked URIs before the edit settles
      const preSnapshot = new Map<string, { errors: number; warnings: number }>();
      for (const [trackedUri, entry] of diagnosticsMap) {
        if (trackedUri !== uri) {
          preSnapshot.set(trackedUri, countDiagnostics(entry.diagnostics));
        }
      }

      const collectOtherFiles = (): OtherFileDiagnostics[] => {
        const result: OtherFileDiagnostics[] = [];
        for (const [trackedUri, entry] of diagnosticsMap) {
          if (trackedUri === uri) continue;
          const post = countDiagnostics(entry.diagnostics);
          const pre = preSnapshot.get(trackedUri) ?? { errors: 0, warnings: 0 };
          const newErrors = post.errors - pre.errors;
          const newWarnings = post.warnings - pre.warnings;
          if (newErrors > 0 || newWarnings > 0) {
            result.push({ uri: trackedUri, errorCount: newErrors, warningCount: newWarnings });
          }
        }
        return result;
      };

      return new Promise<DiagnosticResult>((resolve) => {
        const SETTLE_MS = 50;
        let settled = false;

        const settle = (status: "ok" | "timeout") => {
          if (settled) return;
          settled = true;
          setTimeout(() => {
            resolve({
              status,
              diagnostics: diagnosticsMap.get(uri)?.diagnostics ?? [],
              otherFiles: collectOtherFiles(),
            });
          }, SETTLE_MS);
        };

        const timeout = setTimeout(() => {
          settle("timeout");
        }, timeoutMs);

        const entry = diagnosticsMap.get(uri) ?? { diagnostics: [], received: false };
        entry.resolve = () => {
          clearTimeout(timeout);
          settle("ok");
        };
        diagnosticsMap.set(uri, entry);

        if (entry.received) {
          clearTimeout(timeout);
          settle("ok");
        }
      });
    },

    async shutdown() {
      try {
        await connection.sendRequest(ShutdownRequest.type);
        connection.sendNotification(ExitNotification.type);
      } catch {
        // server may have already exited
      }
      connection.dispose();
    },
  };
}
