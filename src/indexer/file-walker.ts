import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import ignore from 'ignore';
import fg from 'fast-glob';
import type { AdditionalSourceConfig, DiscoveredFile, CartographConfig } from '../types.js';

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.php': 'php',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
};

export function discoverFiles(
  repoPath: string,
  config: CartographConfig
): DiscoveredFile[] {
  const allowedExtensions = new Set(
    Object.entries(LANGUAGE_EXTENSIONS)
      .filter(([, lang]) => config.languages.includes(lang))
      .map(([ext]) => ext)
  );

  if (allowedExtensions.size === 0) {
    return [];
  }

  const sourcePatterns = [...allowedExtensions].map((ext) => `**/*${ext}`);
  const roots = buildDiscoveryRoots(repoPath, config.additionalSources);
  const files = new Map<string, DiscoveredFile>();

  for (const root of roots) {
    const filePaths = discoverCandidatePaths(root.rootPath, config.exclude, sourcePatterns);
    const ig = ignore().add(config.exclude);
    const filteredPaths = filePaths.filter((p) => !ig.ignores(p));

    for (const discoveredPath of filteredPaths) {
      const ext = extname(discoveredPath);
      if (!allowedExtensions.has(ext)) continue;

      const language = LANGUAGE_EXTENSIONS[ext]!;
      const absolutePath = join(root.rootPath, discoveredPath);
      const relativePath = root.pathPrefix
        ? `${root.pathPrefix}${discoveredPath}`
        : discoveredPath;

      try {
        const content = readFileSync(absolutePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        files.set(relativePath, {
          relativePath,
          absolutePath,
          language,
          hash,
          sourceLabel: root.label,
        });
      } catch {
        // Skip unreadable files
        continue;
      }
    }
  }

  return [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

interface DiscoveryRoot {
  rootPath: string;
  label: string;
  pathPrefix: string;
}

function discoverCandidatePaths(
  repoPath: string,
  exclude: string[],
  sourcePatterns: string[]
): string[] {
  const candidates = new Set<string>();

  for (const path of discoverGitPaths(repoPath)) {
    candidates.add(path);
  }

  // Supplement git discovery with a filesystem scan so branch-specific repo
  // layouts do not hide valid source files from the indexer.
  for (const path of fg.sync(sourcePatterns, {
    cwd: repoPath,
    ignore: exclude,
    dot: false,
    onlyFiles: true,
    unique: true,
    suppressErrors: true,
    followSymbolicLinks: true,
  })) {
    candidates.add(path);
  }

  return [...candidates].sort();
}

function discoverGitPaths(repoPath: string): string[] {
  const tracked = runGitCommand(
    repoPath,
    'git ls-files --cached --recurse-submodules'
  ) ?? runGitCommand(repoPath, 'git ls-files --cached') ?? [];

  const untracked = runGitCommand(
    repoPath,
    'git ls-files --others --exclude-standard'
  ) ?? [];

  return [...new Set([...tracked, ...untracked])];
}

function runGitCommand(repoPath: string, command: string): string[] | null {
  try {
    const output = execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function buildDiscoveryRoots(
  repoPath: string,
  additionalSources: AdditionalSourceConfig[]
): DiscoveryRoot[] {
  const roots: DiscoveryRoot[] = [
    { rootPath: repoPath, label: 'repo', pathPrefix: '' },
  ];
  const seenLabels = new Set<string>(['repo']);

  for (const source of additionalSources) {
    const label = normalizeSourceLabel(source.label);
    if (seenLabels.has(label)) {
      throw new Error(`Duplicate additional source label: ${source.label}`);
    }

    const rootPath = resolve(repoPath, source.path);
    const stat = statSync(rootPath, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      throw new Error(`Additional source path is not a directory: ${source.path}`);
    }

    seenLabels.add(label);
    roots.push({
      rootPath,
      label,
      pathPrefix: `@${label}/`,
    });
  }

  return roots;
}

function normalizeSourceLabel(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    throw new Error(`Invalid additional source label: "${label}"`);
  }

  return normalized;
}
