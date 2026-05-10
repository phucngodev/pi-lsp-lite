import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  ShutdownRequest,
  ExitNotification,
  PublishDiagnosticsNotification,
  type InitializeParams,
  type Diagnostic,
} from "vscode-languageserver-protocol/node.js";
import type { ChildProcess } from "node:child_process";
import { fileUri } from "./util.js";

export type DiagnosticResult =
  | { status: "ok"; diagnostics: Diagnostic[] }
  | { status: "timeout"; diagnostics: Diagnostic[] };

export interface LspClient {
  initialize(workspaceRoot: string): Promise<void>;
  didOpen(uri: string, languageId: string, content: string): void;
  didChange(uri: string, content: string): void;
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult>;
  shutdown(): Promise<void>;
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

    async waitForDiagnostics(uri: string, timeoutMs: number): Promise<DiagnosticResult> {
      return new Promise<DiagnosticResult>((resolve) => {
        const timeout = setTimeout(() => {
          const entry = diagnosticsMap.get(uri);
          resolve({
            status: "timeout",
            diagnostics: entry?.diagnostics ?? [],
          });
        }, timeoutMs);

        const entry = diagnosticsMap.get(uri) ?? { diagnostics: [], received: false };
        entry.resolve = () => {
          clearTimeout(timeout);
          resolve({
            status: "ok",
            diagnostics: diagnosticsMap.get(uri)?.diagnostics ?? [],
          });
        };
        diagnosticsMap.set(uri, entry);

        if (entry.received) {
          clearTimeout(timeout);
          resolve({ status: "ok", diagnostics: entry.diagnostics });
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
