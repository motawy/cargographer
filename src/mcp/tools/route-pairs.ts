import type { ToolDeps } from '../types.js';

interface RoutePairsParams {
  query?: string;
  path?: string;
  limit?: number;
}

type RoutePairsDeps = Pick<ToolDeps, 'repoId' | 'symbolRepo'>;

interface RouteFamily {
  familyKey: string;
  familyName: string;
  qualifiedName: string;
  filePath: string;
  displayPath: string;
  resourceSegments: string[];
  isNested: boolean;
  flatKey: string;
  aliases: string[];
}

export function handleRoutePairs(deps: RoutePairsDeps, params: RoutePairsParams): string {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const pathFilter = params.path ?? 'Route';
  const query = params.query?.trim().toLowerCase() ?? '';

  const candidates = deps.symbolRepo
    .searchContentSymbols(deps.repoId, ['class'], pathFilter)
    .filter((symbol) => isRoutePath(symbol.filePath));

  const families = collectRouteFamilies(candidates);
  if (families.length === 0) {
    return params.path
      ? `No route endpoint families found in path "${params.path}".`
      : 'No route endpoint families were found in indexed source files.';
  }

  const flatFamilies = families.filter((family) => !family.isNested);
  const flatByKey = new Map<string, RouteFamily[]>();
  for (const family of flatFamilies) {
    const existing = flatByKey.get(family.flatKey) ?? [];
    existing.push(family);
    flatByKey.set(family.flatKey, existing);
  }

  const nestedRows = families
    .filter((family) => family.isNested)
    .map((family) => ({
      family,
      flatMatches: uniqueRouteFamilies(
        family.aliases.flatMap((alias) => flatByKey.get(alias) ?? [])
      ),
    }))
    .filter((row) => matchesRoutePairsQuery(row.family, row.flatMatches, query))
    .sort((a, b) => a.family.displayPath.localeCompare(b.family.displayPath))
    .slice(0, limit);

  if (nestedRows.length === 0) {
    return query
      ? `No nested route families matched "${params.query}".`
      : 'No nested route families were found.';
  }

  const flatGroups = buildFlatGroups(nestedRows);
  const lines: string[] = [];
  lines.push('## Route Pairs');
  lines.push('- Matching: heuristic route path/resource naming');
  if (params.query) {
    lines.push(`- Query: ${params.query}`);
  }
  if (params.path) {
    lines.push(`- Path filter: ${params.path}`);
  }
  lines.push(`- Nested route families shown: ${nestedRows.length}`);
  lines.push('');
  lines.push('### Nested -> flat');

  for (const row of nestedRows) {
    lines.push(`- ${row.family.displayPath}`);
    lines.push(`  Nested: ${row.family.qualifiedName} — ${row.family.filePath}`);
    if (row.flatMatches.length === 0) {
      lines.push('  Likely flat equivalent: none found');
    } else {
      lines.push('  Likely flat equivalent(s):');
      for (const match of row.flatMatches) {
        lines.push(`    - ${match.qualifiedName} — ${match.filePath}`);
      }
    }
  }

  lines.push('');
  lines.push('### Flat -> nested');
  if (flatGroups.length === 0) {
    lines.push('No flat routes with nested equivalents were inferred in this result set.');
  } else {
    for (const group of flatGroups) {
      lines.push(`- ${group.flat.familyName}`);
      lines.push(`  Flat: ${group.flat.qualifiedName} — ${group.flat.filePath}`);
      lines.push('  Nested equivalent(s):');
      for (const nested of group.nestedFamilies) {
        lines.push(`    - ${nested.displayPath} — ${nested.qualifiedName}`);
      }
    }
  }

  return lines.join('\n');
}

function collectRouteFamilies(
  symbols: Array<ReturnType<RoutePairsDeps['symbolRepo']['searchContentSymbols']>[number]>
): RouteFamily[] {
  const deduped = new Map<string, RouteFamily>();

  for (const symbol of symbols) {
    const parsed = parseRouteFamily(symbol.qualifiedName ?? symbol.name, symbol.filePath);
    if (!parsed) continue;

    const existing = deduped.get(parsed.familyKey);
    if (!existing || shouldPreferRouteFamily(symbol.filePath, existing.filePath)) {
      deduped.set(parsed.familyKey, parsed);
    }
  }

  return [...deduped.values()];
}

function parseRouteFamily(qualifiedName: string, filePath: string): RouteFamily | null {
  const withoutExt = filePath.replace(/\.[^.]+$/, '');
  const pathSegments = withoutExt.split('/');
  const routeIndex = pathSegments.findIndex((segment) => /^routes?$/i.test(segment));
  if (routeIndex === -1) return null;

  const routeTail = pathSegments.slice(routeIndex + 1);
  if (routeTail.length === 0) return null;

  const fileStem = stripInterfaceSuffix(routeTail[routeTail.length - 1]!);
  const directorySegments = routeTail.slice(0, -1);
  const resourceSegments = [...stripRouteScaffolding(directorySegments), fileStem];
  const displayPath = resourceSegments.join('/');

  return {
    familyKey: `${routeTail.slice(0, -1).join('/')}/${fileStem}`.replace(/^\/+/, ''),
    familyName: fileStem,
    qualifiedName,
    filePath,
    displayPath,
    resourceSegments,
    isNested: resourceSegments.length > 1,
    flatKey: normalizeResourceSegments([fileStem]),
    aliases: buildRouteAliases(resourceSegments),
  };
}

function stripRouteScaffolding(segments: string[]): string[] {
  const trimmed = [...segments];
  while (trimmed.length > 0 && ROUTE_SCAFFOLD_SEGMENTS.has(trimmed[0]!.toLowerCase())) {
    trimmed.shift();
  }
  return trimmed;
}

function buildRouteAliases(resourceSegments: string[]): string[] {
  const aliases = new Set<string>();
  const minSegments = resourceSegments.length > 1 ? 2 : 1;
  for (let start = 0; start < resourceSegments.length; start++) {
    const slice = resourceSegments.slice(start);
    if (slice.length < minSegments) continue;
    aliases.add(normalizeResourceSegments(slice));
  }
  return [...aliases];
}

function normalizeResourceSegments(segments: string[]): string {
  const normalizedTokens = segments.flatMap((segment, index) => {
    const tokens = tokenizeIdentifier(stripInterfaceSuffix(segment));
    if (index < segments.length - 1 && tokens.length > 0) {
      tokens[tokens.length - 1] = singularizeToken(tokens[tokens.length - 1]!);
    }
    return tokens;
  });

  return normalizedTokens.join('');
}

function tokenizeIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function singularizeToken(token: string): string {
  if (token.endsWith('ies') && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith('sses') || token.endsWith('ss')) {
    return token;
  }
  if (token.endsWith('s') && token.length > 1) {
    return token.slice(0, -1);
  }
  return token;
}

function stripInterfaceSuffix(value: string): string {
  return value.endsWith('Interface')
    ? value.slice(0, -'Interface'.length)
    : value;
}

function shouldPreferRouteFamily(candidatePath: string, existingPath: string): boolean {
  const candidateInterface = candidatePath.endsWith('Interface.php');
  const existingInterface = existingPath.endsWith('Interface.php');
  if (candidateInterface !== existingInterface) {
    return candidateInterface;
  }
  return candidatePath.localeCompare(existingPath) < 0;
}

function uniqueRouteFamilies(families: RouteFamily[]): RouteFamily[] {
  const seen = new Set<string>();
  const result: RouteFamily[] = [];
  for (const family of families) {
    if (seen.has(family.familyKey)) continue;
    seen.add(family.familyKey);
    result.push(family);
  }
  return result.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function matchesRoutePairsQuery(
  family: RouteFamily,
  flatMatches: RouteFamily[],
  query: string
): boolean {
  if (!query) return true;

  const haystacks = [
    family.familyName,
    family.displayPath,
    family.filePath,
    family.qualifiedName,
    ...flatMatches.flatMap((match) => [match.familyName, match.filePath, match.qualifiedName]),
  ].map((value) => value.toLowerCase());

  return haystacks.some((value) => value.includes(query));
}

function buildFlatGroups(
  nestedRows: Array<{ family: RouteFamily; flatMatches: RouteFamily[] }>
): Array<{ flat: RouteFamily; nestedFamilies: RouteFamily[] }> {
  const groups = new Map<string, { flat: RouteFamily; nestedFamilies: RouteFamily[] }>();

  for (const row of nestedRows) {
    for (const flatMatch of row.flatMatches) {
      const existing = groups.get(flatMatch.familyKey);
      if (!existing) {
        groups.set(flatMatch.familyKey, {
          flat: flatMatch,
          nestedFamilies: [row.family],
        });
        continue;
      }
      existing.nestedFamilies.push(row.family);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      flat: group.flat,
      nestedFamilies: group.nestedFamilies.sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
    }))
    .sort((a, b) => a.flat.displayPath.localeCompare(b.flat.displayPath));
}

function isRoutePath(filePath: string): boolean {
  return /(?:^|\/)routes?(?:\/|$)/i.test(filePath);
}

const ROUTE_SCAFFOLD_SEGMENTS = new Set([
  'root',
  'companies',
  'company',
]);
