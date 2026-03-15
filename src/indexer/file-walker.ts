import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, extname } from 'path';
import ignore from 'ignore';
import fg from 'fast-glob';
import type { DiscoveredFile, CartographConfig } from '../types.js';

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.php': 'php',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
};

export async function discoverFiles(
  repoPath: string,
  config: CartographConfig
): Promise<DiscoveredFile[]> {
  const allowedExtensions = new Set(
    Object.entries(LANGUAGE_EXTENSIONS)
      .filter(([, lang]) => config.languages.includes(lang))
      .map(([ext]) => ext)
  );

  let filePaths: string[];

  try {
    const output = execSync(
      'git ls-files --cached --others --exclude-standard',
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    filePaths = output.trim().split('\n').filter(Boolean);
  } catch {
    filePaths = await fg('**/*', {
      cwd: repoPath,
      ignore: config.exclude,
      dot: false,
    });
  }

  // Apply config excludes
  const ig = ignore().add(config.exclude);
  filePaths = filePaths.filter((p) => !ig.ignores(p));

  const files: DiscoveredFile[] = [];

  for (const relativePath of filePaths) {
    const ext = extname(relativePath);
    if (!allowedExtensions.has(ext)) continue;

    const language = LANGUAGE_EXTENSIONS[ext]!;
    const absolutePath = join(repoPath, relativePath);

    try {
      const content = readFileSync(absolutePath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');
      files.push({ relativePath, absolutePath, language, hash });
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  return files;
}
