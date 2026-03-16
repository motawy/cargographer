import type { DepsData, ModuleDependency } from './generate-pipeline.js';

const TOKEN_BUDGET_CHARS = 12000; // ~3K tokens
const MAX_DEPS = 50;

// Expected layer order (top = highest, can depend on lower but not higher)
const LAYER_ORDER = ['controllers', 'http', 'services', 'repositories', 'models', 'traits'];

export function generateDeps(data: DepsData): string {
  const lines: string[] = [];

  lines.push('# Dependencies\n');

  // Module dependencies (directed)
  lines.push('## Module Dependencies\n');
  lines.push('Directed references between top-level modules, sorted by frequency.\n');
  lines.push('```');

  const shown = data.internal.slice(0, MAX_DEPS);
  for (const dep of shown) {
    lines.push(`${dep.sourceModule} → ${dep.targetModule} (${dep.referenceCount} refs)`);
  }
  if (data.internal.length > MAX_DEPS) {
    lines.push(`... and ${data.internal.length - MAX_DEPS} more`);
  }
  lines.push('```\n');

  // Dependency violations
  const violations = detectViolations(data.internal);
  if (violations.length > 0) {
    lines.push('## Potential Layer Violations\n');
    lines.push('References going from lower layers to higher layers:\n');
    lines.push('```');
    for (const v of violations) {
      lines.push(`⚠ ${v.sourceModule} → ${v.targetModule} (${v.referenceCount} refs)`);
    }
    lines.push('```\n');
  }

  // External dependencies
  if (data.external.length > 0) {
    lines.push('## External Dependencies\n');
    lines.push('Frameworks and libraries referenced but not in the codebase:\n');
    lines.push('| Namespace | References |');
    lines.push('|-----------|-----------|');
    for (const ext of data.external.slice(0, 20)) {
      lines.push(`| ${ext.namespace} | ${ext.referenceCount} |`);
    }
    if (data.external.length > 20) {
      lines.push(`\n*... and ${data.external.length - 20} more*`);
    }
    lines.push('');
  }

  let result = lines.join('\n');
  if (result.length > TOKEN_BUDGET_CHARS) {
    result = result.substring(0, TOKEN_BUDGET_CHARS) + '\n\n... (truncated to fit token budget)\n';
  }

  return result;
}

function detectViolations(deps: ModuleDependency[]): ModuleDependency[] {
  return deps.filter(dep => {
    const sourceLayer = getLayerIndex(dep.sourceModule);
    const targetLayer = getLayerIndex(dep.targetModule);
    // A violation is when a lower-layer module depends on a higher-layer one
    // Higher index = lower layer in the stack
    return sourceLayer > targetLayer && sourceLayer !== -1 && targetLayer !== -1;
  });
}

function getLayerIndex(modulePath: string): number {
  const lower = modulePath.toLowerCase();
  for (let i = 0; i < LAYER_ORDER.length; i++) {
    if (lower.includes(LAYER_ORDER[i])) return i;
  }
  return -1; // Unknown layer — don't flag
}
