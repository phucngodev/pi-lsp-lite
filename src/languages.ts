export interface LanguageServerConfig {
  id: string;
  extensions: string[];
  command: string;
  args: string[];
  rootPatterns: string[];
}

export const languages: LanguageServerConfig[] = [
  {
    id: "go",
    extensions: [".go"],
    command: "gopls",
    args: ["serve"],
    rootPatterns: ["go.mod"],
  },
  {
    id: "rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    rootPatterns: ["Cargo.toml"],
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootPatterns: ["tsconfig.json", "package.json"],
  },
];

export function languageForFile(path: string): LanguageServerConfig | undefined {
  const lower = path.toLowerCase();
  return languages.find((lang) => lang.extensions.some((ext) => lower.endsWith(ext)));
}

export function checkExtensionOverlaps(): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  for (const lang of languages) {
    for (const ext of lang.extensions) {
      const existing = seen.get(ext);
      if (existing) {
        warnings.push(`extension "${ext}" is claimed by both "${existing}" and "${lang.id}" — "${existing}" wins`);
      } else {
        seen.set(ext, lang.id);
      }
    }
  }
  return warnings;
}
