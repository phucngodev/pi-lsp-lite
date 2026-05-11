import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { type LanguageServerConfig, builtinLanguages } from "./languages.js";

export interface ServerConfigOverride {
  extensions?: string[];
  command?: string;
  args?: string[];
  rootPatterns?: string[];
  diagnosticTimeout?: number;
  disabled?: boolean;
}

export interface UserConfig {
  servers?: Record<string, ServerConfigOverride>;
  diagnosticTimeout?: number;
  documentIdleTimeout?: number;
}

export interface ResolvedConfig {
  servers: LanguageServerConfig[];
  diagnosticTimeout: number;
  documentIdleTimeout: number;
  perServerTimeout: Map<string, number>;
}

const DEFAULT_DIAGNOSTIC_TIMEOUT = 5_000;
const DEFAULT_DOCUMENT_IDLE_TIMEOUT = 120_000;

async function readConfigFile(path: string): Promise<UserConfig | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as UserConfig;
  } catch {
    return null;
  }
}

async function findProjectConfig(cwd: string): Promise<UserConfig | null> {
  let dir = cwd;
  while (true) {
    for (const candidate of [
      join(dir, ".pi-lsp-lite.json"),
      join(dir, ".pi", "lsp-lite.json"),
    ]) {
      const config = await readConfigFile(candidate);
      if (config) return config;
    }
    if (dir === cwd && dirname(dir) !== dir) {
      // only check cwd itself, don't walk up for project config
      break;
    }
    break;
  }
  return null;
}

function mergeConfigs(base: LanguageServerConfig[], overrides: Record<string, ServerConfigOverride>): LanguageServerConfig[] {
  const result = new Map<string, LanguageServerConfig>();

  for (const server of base) {
    result.set(server.id, { ...server });
  }

  for (const [id, override] of Object.entries(overrides)) {
    if (override.disabled) {
      result.delete(id);
      continue;
    }

    const existing = result.get(id);
    if (existing) {
      result.set(id, {
        ...existing,
        ...(override.extensions !== undefined && { extensions: override.extensions }),
        ...(override.command !== undefined && { command: override.command }),
        ...(override.args !== undefined && { args: override.args }),
        ...(override.rootPatterns !== undefined && { rootPatterns: override.rootPatterns }),
      });
    } else {
      if (!override.command || !override.extensions) {
        console.error(`[pi-lsp-lite] config for "${id}" must have at least "command" and "extensions" to define a new server, skipping`);
        continue;
      }
      result.set(id, {
        id,
        extensions: override.extensions,
        command: override.command,
        args: override.args ?? [],
        rootPatterns: override.rootPatterns ?? [],
      });
    }
  }

  return Array.from(result.values());
}

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const globalConfig = await readConfigFile(join(homedir(), ".pi-lsp-lite.json"));
  const projectConfig = await findProjectConfig(cwd);

  let servers = [...builtinLanguages];
  const perServerTimeout = new Map<string, number>();
  let diagnosticTimeout = DEFAULT_DIAGNOSTIC_TIMEOUT;
  let documentIdleTimeout = DEFAULT_DOCUMENT_IDLE_TIMEOUT;

  if (globalConfig) {
    if (globalConfig.servers) {
      servers = mergeConfigs(servers, globalConfig.servers);
      for (const [id, override] of Object.entries(globalConfig.servers)) {
        if (override.diagnosticTimeout !== undefined) {
          perServerTimeout.set(id, override.diagnosticTimeout);
        }
      }
    }
    if (globalConfig.diagnosticTimeout !== undefined) diagnosticTimeout = globalConfig.diagnosticTimeout;
    if (globalConfig.documentIdleTimeout !== undefined) documentIdleTimeout = globalConfig.documentIdleTimeout;
  }

  if (projectConfig) {
    if (projectConfig.servers) {
      servers = mergeConfigs(servers, projectConfig.servers);
      for (const [id, override] of Object.entries(projectConfig.servers)) {
        if (override.diagnosticTimeout !== undefined) {
          perServerTimeout.set(id, override.diagnosticTimeout);
        }
      }
    }
    if (projectConfig.diagnosticTimeout !== undefined) diagnosticTimeout = projectConfig.diagnosticTimeout;
    if (projectConfig.documentIdleTimeout !== undefined) documentIdleTimeout = projectConfig.documentIdleTimeout;
  }

  return { servers, diagnosticTimeout, documentIdleTimeout, perServerTimeout };
}
