export function isTestPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return /(^|[\\/])(tests?|spec)([\\/]|$)/.test(normalized)
    || /(^|[\\/]).*test\.php$/.test(normalized)
    || /(^|[\\/]).*spec\.[a-z0-9]+$/.test(normalized);
}
