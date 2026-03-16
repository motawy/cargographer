# Generate Output Polish — Design Spec

## Goal

Fix 6 issues in the `cartograph generate` output to make the v1 static context files accurate and useful before adding new data sources.

## Scope

Two phases:
1. **Generator fixes (#2-#6)** — output-only changes, no re-index required
2. **Indexer fix (#1)** — case-insensitive namespace resolution, requires re-index

---

## Phase 1: Generator Fixes

### Fix #2 — External deps noise

**Problem:** Non-namespaced references like `m::mock`, `PDO::FETCH_NUM`, `Console::Log`, `PermissionFunctions::hasPermission` appear as top "namespace" entries in `dependencies.md`. The external deps query splits `target_qualified_name` on `\` to extract the first namespace segment, but bare class references contain no `\`, so the entire string passes through.

**File:** `src/output/generate-pipeline.ts` — `queryDependencies()`

**Fix:** Add a WHERE clause to the external deps query requiring `target_qualified_name` to contain at least one backslash:

```sql
AND sr.target_qualified_name LIKE '%\\%'
```

This filters out all non-namespaced references (`m::mock`, `PDO::FETCH_NUM`, etc.) in one condition. Namespaced external deps like `Symfony\Component\...` and `Doctrine\ORM\...` pass through correctly.

**Impact:** Removes ~20+ noisy entries from external deps. The remaining entries are genuine framework/library namespaces.

---

### Fix #3 — Architecture description contradicts stats

**Problem:** `detectArchitecture()` in `root-generator.ts` only looks at directory names. It found `objects/Interfaces` and declared "This codebase uses interface contracts" — but conventions data shows 0% interface adoption (39/15,003). The two statements contradict each other.

**Files:**
- `src/output/root-generator.ts` — `generateRoot()`, `detectArchitecture()`
- `src/output/generate-pipeline.ts` — pass conventions data to root generator

**Fix:** Change `generateRoot(stats)` signature to `generateRoot(stats, conventions)`. The `detectArchitecture()` function receives both directory names AND conventions percentages:

- If `objects/Interfaces` exists but interface adoption < 5%: "Dedicated interfaces directory exists but interface adoption is low (<1%)."
- If adoption >= 5%: "Uses interface contracts" (current behavior).
- Apply same logic for other patterns: if a `services/` directory exists but the codebase has very few classes, qualify the statement.

The architecture description should reflect what the code actually does, not just what the directory structure implies.

**Impact:** Architecture description becomes trustworthy. An AI reading it won't be misled into assuming heavy interface usage.

---

### Fix #4 — Test modules dominate modules.md

**Problem:** `tests/objects` (3,739 symbols) and `tests/src` (401 symbols) rank prominently in `modules.md`, pushing production modules down. An AI trying to understand production architecture sees test stubs before real services.

**Files:**
- `src/output/modules-generator.ts` — `generateModules()`
- `src/output/generate-pipeline.ts` — `ModuleInfo` interface (add optional flag or handle in generator)

**Fix:** In `generateModules()`, partition modules into production and test:

- Test detection: module path starts with `test/` or `tests/` (case-insensitive).
- Production modules render as they do now (tables with symbols, truncation limits apply).
- Test modules render as a single summary line at the bottom of the file:
  `**Test suite:** 4,140 symbols across tests/objects/, tests/src/`
- No table, no per-symbol listing for test modules.

Also filter test modules from the directory map in `root-generator.ts` — they still appear in the directory listing (that's fine for orientation) but don't inflate the module listing.

**Impact:** Production code surfaces first. AI discovers test details on demand.

---

### Fix #5 — Single files appear as directories

**Problem:** The 2-level `split_part` grouping in pipeline queries treats files like `objects/PermissionFunctions.php` as modules with 382 symbols. Same for `objects/Console.php`, `objects/Database.php`, `objects/ContainerDependent.php`. These are god-files, not architectural modules.

**Files:**
- `src/output/modules-generator.ts` — rendering logic
- `src/output/generate-pipeline.ts` — `queryModules()`, `queryRepoStats()`

**Fix:** Detect single-file "modules" by checking if the module path ends with `.php` (or any source file extension). In the generator:

- Single-file modules don't get a full table section.
- Instead, render them in a compact "Standalone Files" section:
  ```
  ## Standalone Files
  | File | Symbols | Top Kind |
  |------|---------|----------|
  | objects/PermissionFunctions.php | 382 | class (utility) |
  | objects/Console.php | 54 | class |
  | objects/Database.php | 41 | class |
  ```
- Limit to top 10 standalone files by symbol count, with a "... and N more" truncation.

Apply the same detection in the directory map (`root-generator.ts`): single-file entries render with the file name, not as directories.

**Impact:** Stops presenting utility files as architectural modules. Makes the module overview more accurate.

---

### Fix #6 — Method naming regex broken

**Problem:** The regex `/^[a-z_][a-zA-Z0-9]*$/` in `conventions-generator.ts` doesn't allow underscores mid-name, so `get_user_name` fails. Magic methods like `__construct` also fail. The result shows "1% camelCase/snake_case" which is obviously wrong for a PHP codebase.

**File:** `src/output/conventions-generator.ts`

**Fix:**

1. Filter out magic methods (`__*`) from the naming sample before computing percentages. Magic methods are a language requirement, not a naming convention choice.

2. Change the method naming regex to: `/^[a-z][a-zA-Z0-9_]*$/` — this matches both `camelCase` and `snake_case` methods.

3. Optionally distinguish camelCase vs snake_case:
   - camelCase: `/^[a-z][a-zA-Z0-9]*$/` (no underscores)
   - snake_case: `/^[a-z][a-z0-9_]*$/` (lowercase + underscores only)
   - Report whichever is dominant: "Method naming: 85% camelCase (sample of 200)"

**Impact:** Method naming percentage becomes accurate and informative.

---

## Phase 2: Indexer Fix

### Fix #1 — Case-insensitive namespace resolution

**Problem:** `resolveTargets()` in `reference-repository.ts` uses exact string matching: `sr.target_qualified_name = s.qualified_name`. PHP namespaces are case-insensitive, so `simPRO\Entity\Foo` won't match `SimPRO\Entity\Foo`. This causes 18,000+ internal references to appear as unresolved external deps.

**Files:**
- `src/indexer/parsers/php.ts` — `qualifyName()`, `resolveTypeName()`
- `src/indexer/reference-extractor.ts` — `resolveTypeName()`
- `src/db/repositories/reference-repository.ts` — `resolveTargets()`

**Fix:** Normalize all qualified names to lowercase at index time:

1. In `php.ts`, `qualifyName()` returns `result.toLowerCase()`.
2. In both `resolveTypeName()` functions (php.ts and reference-extractor.ts), normalize the result to lowercase.
3. `resolveTargets()` can keep exact string matching since both sides are now normalized.
4. Store the original-case `name` field unchanged (for display). Only `qualified_name` is lowercased.

**Migration consideration:** Existing data must be re-indexed. No DB migration needed — the schema doesn't change, only the stored values do.

**Impact:** Resolves ~18,000 previously unresolved references. The dependency graph and conventions stats become dramatically more accurate.

---

## Testing Strategy

**Unit tests (generator fixes):**
- #2: Test `generateDeps()` with fake external deps containing `::` entries — verify they're filtered
- #3: Test `generateRoot()` with low interface adoption — verify architecture description reflects stats
- #4: Test `generateModules()` with test modules — verify they render as summary line
- #5: Test `generateModules()` with `.php` module paths — verify standalone file section
- #6: Test naming convention detection with `snake_case`, `camelCase`, `__construct` samples

**Unit tests (indexer fix):**
- Test that `qualifyName()` returns lowercase
- Test that `resolveTypeName()` returns lowercase
- Test that mixed-case references resolve to the same target

**Integration test:**
- Re-run `generate.test.ts` with fixture data to verify all files still generate correctly
- After re-index: verify reference resolution count increases significantly

## Execution Order

1. Fix #6 (method naming) — simplest, isolated to one file
2. Fix #2 (external deps) — one SQL change
3. Fix #5 (single-file modules) — generator change
4. Fix #4 (test modules) — generator change
5. Fix #3 (architecture + stats) — connects root generator to conventions data
6. Fix #1 (case normalization) — indexer change, re-index required
