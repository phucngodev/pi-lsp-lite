import { spawn, type ChildProcess } from "node:child_process";
import { which, fileUri } from "./util.js";
import { createLspClient, type LspClient, type DiagnosticResult } from "./client.js";
import type { LanguageServerConfig } from "./languages.js";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { readFile } from "node:fs/promises";

interface ManagedServer {
  config: LanguageServerConfig;
  process: ChildProcess;
  client: LspClient;
  openDocuments: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  startTime: number;
  lastActivity: number;
}

export interface ServerManager {
  handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult>;
  status(): ServerStatus[];
  shutdownAll(): Promise<void>;
}

export interface ServerStatus {
  id: string;
  pid: number;
  uptime: number;
  openDocuments: number;
  lastActivity: number;
}

const IDLE_TIMEOUT_MS = 240_000;
const DIAGNOSTIC_TIMEOUT_MS = 3_000;
const INIT_TIMEOUT_MS = 10_000;

export function createServerManager(): ServerManager {
  const servers = new Map<string, ManagedServer>();
  const pending = new Map<string, Promise<ManagedServer | null>>();
  const disabledLanguages = new Set<string>();

  function resetIdleTimer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    server.lastActivity = Date.now();
    server.idleTimer = setTimeout(() => shutdownServer(server), IDLE_TIMEOUT_MS);
  }

  async function shutdownServer(server: ManagedServer) {
    if (server.idleTimer) clearTimeout(server.idleTimer);
    if (servers.get(server.config.id) === server) {
      servers.delete(server.config.id);
    }
    try {
      await server.client.shutdown();
    } catch {
      server.process.kill("SIGTERM");
    }
  }

  async function spawnServer(config: LanguageServerConfig, cwd: string): Promise<ManagedServer | null> {
    if (disabledLanguages.has(config.id)) return null;

    const binaryPath = await which(config.command);
    if (!binaryPath) {
      console.error(`[pi-lsp-lite] ${config.command} not found on PATH, disabling ${config.id}`);
      disabledLanguages.add(config.id);
      return null;
    }

    const child = spawn(binaryPath, config.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr?.on("data", () => {});

    child.on("error", (err) => {
      console.error(`[pi-lsp-lite] ${config.id} process error:`, err);
    });

    const client = createLspClient(child);

    let initTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(new Error("LSP initialize timed out")), INIT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.initialize(cwd), timeoutPromise]);
      clearTimeout(initTimer!);
    } catch (err) {
      clearTimeout(initTimer!);
      console.error(`[pi-lsp-lite] failed to initialize ${config.id}:`, err);
      child.kill("SIGTERM");
      disabledLanguages.add(config.id);
      return null;
    }

    const now = Date.now();
    const server: ManagedServer = {
      config,
      process: child,
      client,
      openDocuments: new Set(),
      idleTimer: null,
      startTime: now,
      lastActivity: now,
    };

    child.on("exit", () => {
      if (servers.get(config.id) === server) {
        servers.delete(config.id);
      }
    });

    resetIdleTimer(server);
    servers.set(config.id, server);
    return server;
  }

  async function ensureServer(config: LanguageServerConfig, cwd: string): Promise<ManagedServer | null> {
    const existing = servers.get(config.id);
    if (existing) return existing;

    if (disabledLanguages.has(config.id)) return null;

    const inflight = pending.get(config.id);
    if (inflight) return inflight;

    const promise = spawnServer(config, cwd).finally(() => pending.delete(config.id));
    pending.set(config.id, promise);
    return promise;
  }

  return {
    async handleEdit(filePath: string, config: LanguageServerConfig, cwd: string): Promise<DiagnosticResult> {
      const server = await ensureServer(config, cwd);
      if (!server) return { status: "ok", diagnostics: [] };

      resetIdleTimer(server);

      const uri = fileUri(filePath);
      const content = await readFile(filePath, "utf-8");

      if (server.openDocuments.has(uri)) {
        server.client.didChange(uri, content);
      } else {
        server.openDocuments.add(uri);
        server.client.didOpen(uri, config.id, content);
      }

      return server.client.waitForDiagnostics(uri, DIAGNOSTIC_TIMEOUT_MS);
    },

    status(): ServerStatus[] {
      return Array.from(servers.values()).map((s) => ({
        id: s.config.id,
        pid: s.process.pid ?? 0,
        uptime: Date.now() - s.startTime,
        openDocuments: s.openDocuments.size,
        lastActivity: s.lastActivity,
      }));
    },

    async shutdownAll() {
      const shutdowns = Array.from(servers.values()).map((s) => shutdownServer(s));
      await Promise.allSettled(shutdowns);
    },
  };
}
