import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

export async function which(command: string): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
