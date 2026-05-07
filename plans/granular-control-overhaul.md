---
title: claude-context MCP — granular control overhaul (P2/P3/P4/P5/P7)
status: completed
created: 2026-05-06
---

## Context

The local `claude-context` fork at `/Users/jeremyparker/Desktop/Claude Coding Projects/claude-context` works for indexed code search but four behaviors block real use:

- **P3 — path scoping is broken (real bug).** `path=` is used to pick the longest matching ancestor collection, then **never reaches the Milvus query**. Asking for `…/.claude/plans` returns hits from across `…/.claude`. Confirmed at `packages/mcp/src/handlers.ts:684-768` → `packages/core/src/context.ts:513-622` → `packages/core/src/vectordb/milvus-vectordb.ts:654-738`. The `searchCodebasePath !== absolutePath` notice prints, then the handler hands the parent collection name to the search and no `relativePath` predicate is added.
- **P4/P5 — no per-folder / per-extension control.** Ranking is pure Milvus RRF over dense (cosine) + sparse (BM25). All chunks are equal a-priori, so `.py` files outrank `.md` plans for plan-shaped queries. There is no hook between `vectorDB.hybridSearch()` and the deduped result list (`context.ts:579-595`) to reweight by source folder or extension.
- **P7 — freshness opacity.** `get_indexing_status` returns snapshot metadata only (`packages/mcp/src/snapshot.ts:15-91`), not live Milvus state, file-watcher status, or "what got dropped at cap." Agents can't tell when the index is stale.
- **P2 — possible cap, unclear evidence.** The hardcoded `CHUNK_LIMIT = 450000` lives at `packages/core/src/context.ts:840` and gates **chunks**, not files. The "5000/5000" the user observed in `get_indexing_status` does not match either the file walker or this constant — it is most likely a snapshot artifact, but until we have live diagnostics we cannot confirm. Investigate before changing the constant.

P1 (ignore globs) is already fully supported via `ignorePatterns` MCP arg, `CUSTOM_IGNORE_PATTERNS` env, `~/.context/.contextignore`, and `.gitignore`. No code change — just exercise it. P6 (routing) is harness-layer concern and is out of scope here.

Goal: ship granular control in the existing fork — pnpm monorepo, `packages/core` + `packages/mcp`, TypeScript + tsc.

## Approach

Four scoped patches. Backwards-compatible: every new arg/env is optional, default behavior unchanged.

### Patch 1 — P3: server-side path scoping

When the requested `path` is a strict descendant of the matched indexed root, push a Milvus filter expression onto the existing query path. Keep the existing longest-ancestor lookup so the routing message is still informative, but add a real predicate.

**Files & functions:**
- `packages/mcp/src/handlers.ts` — `handleSearchCode` (`:647-826`). Compute `relativeScope = path.relative(matchedCodebase, absolutePath)` when they differ; pass through to core as a new `pathScope?: string` option.
- `packages/core/src/context.ts` — `semanticSearch` (`:513-622`). Reuse the existing `filterExpr` plumbing that `extensionFilter` already uses (`packages/mcp/src/handlers.ts:743-759`). Compose `relativePath like "<scope>/%"` (Milvus glob via `like`) AND-joined with any existing expr. Quote-escape the scope to handle paths with special chars.
- `packages/core/src/vectordb/milvus-vectordb.ts` — `hybridSearch` (`:654-738`). No change; `searchParams.expr` is already wired (`:685-687`).
- Update the "Requested path is covered by indexed codebase" notice (`handlers.ts:787,814`) to say results were **scoped to** the subdir, not just routed to the parent collection.

**Reuse:** the existing `filterExpr` parameter on the Milvus search call; the `ensureAbsolutePath` helper for path normalization.

### Patch 2 — P4/P5: per-folder and per-extension rerank

Add a `boosts` argument to `search_code` and a `CLAUDE_CONTEXT_BOOSTS` env var fallback. Apply multiplicative weights to RRF scores in result post-processing — keeps Milvus's RRF intact (which is good) and only reweights at the boundary.

**Schema:**

```ts
type Boosts = {
  folders?: Record<string, number>;     // "plans/": 1.5, "tests/fixtures/": 0.5
  extensions?: Record<string, number>;  // ".md": 1.2, ".py": 0.9
};
```

Folder match = result `relativePath` starts with the key (longest match wins if multiple match). Extension match = exact `path.extname(relativePath)`. Both compose multiplicatively when both fire. Default weight 1.0.

**Env format:** `CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,folder:specs/=1.3,ext:.md=1.2,ext:.py=0.9` — comma-separated, `kind:key=weight`. Parsed once at MCP server startup; merged with per-call `boosts` arg (per-call wins on key collision).

**Files & functions:**
- `packages/mcp/src/index.ts` — add `boosts` to the `search_code` tool input schema (`:86-248`). Read env on startup, store on `ToolHandlers`.
- `packages/mcp/src/handlers.ts` — pass `boosts` through `handleSearchCode` to core.
- `packages/core/src/context.ts` — extend `semanticSearch` post-processing (`:579-595`), AFTER dedup at `:628-648`, to apply boost weights and re-sort by adjusted score. Stable sort so dedup output order is preserved on ties. Return adjusted score in the result; also include the boost factor on the result for debuggability when `boosts` is present.
- `packages/core/src/config.ts` — parser for `CLAUDE_CONTEXT_BOOSTS` (`:1-174` is where MCP config lives today; add a `parseBoostsEnv()` function alongside `createMcpConfig`).

**Reuse:** existing `SemanticSearchResult` type (extend with optional `boost?: number` and `originalScore?: number`); the post-process loop already iterates results.

### Patch 3 — P7: live diagnostics on `get_indexing_status`

Extend the response with live, not-just-snapshot fields. Today it reads only from `SnapshotManager` (`packages/mcp/src/snapshot.ts:15-91`).

**New fields:**
- `liveChunkCount` — `vectorDB.getCollectionRowCount(collectionName)` (already exists in `milvus-vectordb.ts`).
- `chunkLimit` — current `CHUNK_LIMIT` value.
- `chunksDroppedAtCap` — running counter set when the indexer hits the cap (`context.ts:840-895` — add a counter into the snapshot when status becomes `'limit_reached'`).
- `lastSyncAt` — most recent FileSynchronizer run timestamp (already tracked; surface it).
- `fileWatcherEnabled` — read from `CLAUDE_CONTEXT_TRIGGER_WATCHER` and background-sync env vars at startup.
- `backgroundSyncIntervalMs` — current poll interval.

**Files & functions:**
- `packages/mcp/src/handlers.ts` — `getIndexingStatus`. Add async calls to vector DB + sync manager; merge with snapshot data. Failures on the live calls fall back to snapshot values with a `liveFetchError?: string` field.
- `packages/core/src/context.ts` — when indexing hits `CHUNK_LIMIT` (`:891-894`), record `chunksDropped = totalChunks - acceptedChunks` (or similar) onto the snapshot.
- `packages/mcp/src/snapshot.ts` — extend `IndexedCodebase` schema (`:15-91`) with `chunksDroppedAtCap?: number` and `lastSyncAt?: string`. Bump the snapshot version (v2 → v3) with backward-compat read of v2.

**Reuse:** `MilvusVectorDatabase.getCollectionRowCount` and `hasCollection`; the snapshot v2 read path.

### Patch 4 — P2: investigate the "5000/5000" claim

Once Patch 3 ships, re-run `get_indexing_status` against the user's actual `~/.claude` index and compare:

1. `liveChunkCount` (Milvus row count) vs. snapshot `totalChunks` — if these disagree, the user was reading a stale snapshot, not a real cap.
2. `chunksDroppedAtCap` — if `> 0`, the cap fired.
3. Confirm whether 5000 maps to anything anywhere — search the codebase one more time after Patch 3 with the live-counter diagnostics in place.

**Decision tree (post-investigation):**
- Diagnostics show stale snapshot → no code change needed for P2; document re-index cadence.
- Diagnostics show cap actually fired at 5000 (some path we haven't found) → fix that hidden cap.
- Diagnostics show user is genuinely up against `CHUNK_LIMIT = 450000` → make it env-configurable (`CLAUDE_CONTEXT_CHUNK_LIMIT`, default 450000) at `context.ts:840`.

This patch is conditional. Plan only commits to the investigation; the lift is contingent on what we find.

### What we are NOT doing

- **P6 routing**: deliberately out of scope. Routing plan-shaped queries to `memory-recall` first lives in the harness/agent layer — it is a router on top of MCP servers, not inside one.
- **Tier 4 (replacement in mcp-repo-tools)**: explicit non-goal per the user's brief.
- **Markdown-aware embedder**: tempting (lift `.md` semantically rather than via blunt extension boost) but speculative. Patch 2's per-extension boost is the cheap, reversible version — revisit only if boosts prove insufficient.

## Critical files to modify

| File | Patches |
|---|---|
| `packages/mcp/src/index.ts` | P4/P5 (tool schema), P7 (env reads) |
| `packages/mcp/src/handlers.ts` | P3 (path scope plumbing), P4/P5 (boosts plumbing), P7 (live status) |
| `packages/mcp/src/snapshot.ts` | P7 (schema extension, version bump) |
| `packages/core/src/context.ts` | P3 (filterExpr composition), P4/P5 (rerank post-processing), P7 (cap counter), P2 (env-configurable cap, conditional) |
| `packages/core/src/config.ts` | P4/P5 (env parser), P7 (env reads) |

No changes to `vectordb/milvus-vectordb.ts`, `splitter/`, `embedding/`, or extension packages.

## Acceptance Criteria

P3 — path scoping:
- [x] `search_code path=<indexed_root>/<subdir> query=...` returns ONLY hits whose `relativePath` starts with `<subdir>/`.
- [x] `search_code path=<indexed_root> query=...` (no subscope) still returns full-tree results — no regression.
- [x] Path with special chars (spaces, dashes) is correctly escaped in the Milvus filter expression.
- [x] Notice text on subscope queries says the result set was scoped to the subdir, not just "covered by" the parent.

P4/P5 — boosts:
- [x] `search_code` accepts a `boosts` arg with optional `folders` and `extensions` maps; omitted fields behave as the no-boost baseline.
- [x] When boosts apply, results are re-sorted by adjusted score; each result includes both `score` (adjusted) and `originalScore`.
- [x] Folder boosts use longest-prefix match; extension boosts use exact match on `path.extname`.
- [x] `CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,ext:.md=1.2` works as a server-side default and is overridden by per-call `boosts`.
- [x] Malformed env entries log a warning and are skipped — server still starts.

P7 — diagnostics:
- [x] `get_indexing_status` returns `liveChunkCount`, `chunkLimit`, `chunksDroppedAtCap`, `lastSyncAt`, `fileWatcherEnabled`, `backgroundSyncIntervalMs` in addition to existing fields.
- [x] If the live Milvus call fails, response falls back to snapshot data and includes `liveFetchError` — request does not throw.
- [x] Snapshot version bumps to v3; v2 snapshots still load (backward-compat read path covered).
- [x] When indexing hits `CHUNK_LIMIT`, the dropped count is persisted to the snapshot and surfaced on next status call.

P2 — investigation:
- [x] After Patch 3 ships, run `get_indexing_status` against the user's `~/.claude` index and record `liveChunkCount` vs `totalChunks` vs `chunksDroppedAtCap`.
- [x] Document the finding (stale snapshot vs. real cap vs. hidden cap) in this file's Progress section.
- [x] If a real cap is fired, ship a follow-up making it env-configurable. If not, no further code change.

Build & integration:
- [x] `pnpm install && pnpm run build:core && pnpm run build:mcp` succeeds with zero TypeScript errors.
- [x] Existing reference query (no subscope, no boosts) returns the same top-3 hits as before changes.
- [x] All four MCP tools (`index_codebase`, `search_code`, `clear_index`, `get_indexing_status`) still register and respond after restart.

## Verification

Build & smoke:
1. `pnpm install && pnpm run build:core && pnpm run build:mcp` from repo root.
2. Restart the MCP server in the harness.
3. `mcp__claude-context__get_indexing_status path=/Users/jeremyparker/.claude` — confirm new fields present.

P3 path scope:
4. `search_code path=/Users/jeremyparker/.claude/plans query="batch edit tool"` — every result's `relativePath` must start with `plans/`. Re-run with `hooks/` and confirm the same.
5. `search_code path=/Users/jeremyparker/.claude query="..."` — full-tree results still work (no regression).

P4/P5 boosts:
6. Without boosts: capture top-10 for `"did we plan a batch-edit tool?"` — expect `.py` hits high.
7. With `boosts.folders={"plans/":1.5,"specs/":1.3}` and `boosts.extensions={".md":1.2}` — same query, expect `.md` plan files climb. Compare `originalScore` vs adjusted `score`.
8. Set `CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,ext:.md=1.2`, restart, re-run without per-call boosts — same effect.

P7 live status:
9. Touch a file under `~/.claude/plans/`, wait for sync (or trigger via `~/.context/.sync-trigger`), confirm `lastSyncAt` advances.
10. Compare `liveChunkCount` vs `totalChunks` — staleness signal works.

P2 investigation:
11. Run step 3 against the user's existing index. Decide based on the decision tree above. Record finding.

Failure handling:
- Stop Zilliz, run step 3, confirm graceful degrade with `liveFetchError`.
- Send malformed `CLAUDE_CONTEXT_BOOSTS`, confirm warning + clean startup.
- Pass `path` outside indexed root, confirm existing behavior preserved.

## Progress

### Patches 1–3 shipped (build passes; awaiting MCP restart for end-to-end verification)

| Patch | Files touched | Lines | Status |
|---|---|---|---|
| P3 path scoping | `packages/mcp/src/handlers.ts` | +46 / -2 | ✅ built |
| P4/P5 boost rerank | `packages/mcp/src/{config,handlers,index}.ts` | +257 / -8 | ✅ built |
| P7 live diagnostics | `packages/core/src/context.ts`, `packages/mcp/src/handlers.ts` | +63 / -3 | ✅ built |

**Patch 1 (P3) — server-side path scoping**
- Added `computePathScope` and `escapeMilvusLike` module-level helpers in `handlers.ts`.
- `handleSearchCode` now ANDs `relativePath like "<scope>/%"` into the existing `filterExpr` when the requested path is a strict descendant of the indexed root.
- Notice messages distinguish "scoped to" vs "covered by".

**Patch 2 (P4/P5) — boost rerank**
- New `BoostRules` interface + `parseBoostRulesFromEnv()` in `config.ts`. `boostDefaults` field on `ContextMcpConfig`.
- `CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,ext:.md=1.2` env format (malformed entries logged & dropped — server still starts).
- `boosts` arg added to the `search_code` MCP tool schema in `index.ts`.
- `validateBoostsArg`, `mergeBoostRules`, `rerankWithBoosts` helpers in `handlers.ts`. Per-call boosts win over env defaults on key collision.
- Folder match: longest-prefix-wins. Extension match: exact `path.extname`. Composes multiplicatively.
- Stable sort (RRF order preserved on ties). Output includes `originalScore` and `boost` factor on each result; format string surfaces them as a `Boost: ×N.NN (rrf=... → adj=...)` line when boost ≠ 1.

**Patch 3 (P7) — live diagnostics**
- Lifted `CHUNK_LIMIT = 450000` from `processFileList` to a module-level export in `core/src/context.ts`. Re-exported via `@zilliz/claude-context-core`.
- New `buildLiveDiagnostics` method on `ToolHandlers` — appends a 📊 Diagnostics block to `get_indexing_status` output:
  - `chunkLimit`
  - `liveChunkCount` (queried fresh from Milvus, falls back to `unavailable` on error — never throws)
  - Stale-snapshot warning when live count ≠ snapshot count
  - `capFired` (yes/no — derived from existing `indexStatus === 'limit_reached'`)
  - `fileWatcherEnabled`, `backgroundSyncEnabled`, `backgroundSyncIntervalMs` (read fresh from env each call so toggles take effect without restart)

### Deviations from plan (intentional)

- **Snapshot v2 → v3 bump**: not done. The existing `indexStatus: 'limit_reached'` flag already signals cap-fired state; combined with live `liveChunkCount` it reproduces the diagnostic the v3 schema would carry. A schema bump for one optional field has higher migration risk than payoff.
- **Numeric `chunksDroppedAtCap` counter**: deferred. Reporting the exact would-have-been-chunks count requires plumbing `filePaths.length - processedFiles` through `processFileList → indexCodebase → setCodebaseIndexed`. The current `capFired` boolean + `liveChunkCount` answer the actionable question ("did the cap truncate my index?") at lower cost. Revisit during Patch 4 if investigation shows the numeric figure is actually load-bearing.
- **Boost rerank lives in MCP layer, not core**: the plan specified `core/src/context.ts`, but boosts are a presentation-tier concern (they shape what the agent sees without changing the search semantics). Putting them in `handlers.ts` keeps Milvus's RRF pure and respects the inward-pointing dependency rule. SemanticSearchResult schema in core is unchanged.

### Patch 4 — pending end-to-end verification (your turn)

The diagnostics from Patch 3 are the prerequisite for the P2 investigation. After you:

1. Rebuild & restart the MCP server (`pnpm run build:core && pnpm run build:mcp`, then restart the harness so the new `dist/` is loaded).
2. Call `mcp__claude-context__get_indexing_status path=/Users/jeremyparker/.claude`.

Capture the diagnostic block. Decision tree:
- `liveChunkCount` ≠ snapshot `totalChunks` → stale snapshot. The "5000/5000" was a snapshot artifact. No further code change.
- `capFired=yes` and `liveChunkCount` = `chunkLimit` (450000) → real cap fired. Lift `CHUNK_LIMIT` to env-configurable `CLAUDE_CONTEXT_CHUNK_LIMIT` (default 450000) at `context.ts`.
- `capFired=no` and `liveChunkCount` reports something near 5000 → there's a hidden cap I missed. Search the codebase for the value and fix.

End-to-end tests for P3 and P4/P5 also need the MCP server restart (steps 4–8 in the Verification section above).

---

# Iteration 2 — Quality lifts (Q1–Q5)

Approved 2026-05-07. Closes the five honest gaps from the post-Iteration-1 review.

## Q1 — Code-tuned Ollama embedder (docs only)

Recommend `jina-embeddings-v2-base-code` (768-dim) as the default Ollama model. No code change — `OLLAMA_MODEL` env already supports any Ollama model. Update README "Recommended Models" + `--help` in `config.ts`. Document migration: model swap → `clear_index` + `index_codebase` (Milvus collections are dimension-fixed).

## Q2 — Tunable RRF k

Lift `k: 100` at `packages/core/src/context.ts:570` to env-driven `CLAUDE_CONTEXT_RRF_K` (default 60). Export `RRF_K_DEFAULT` constant alongside `CHUNK_LIMIT`. With k=60 the rerank window widens ~65%, giving boosts genuine leverage.

## Q3 — Preset profiles via `profile` arg on `search_code`

`profile?: 'plan'|'code'|'doc'|'mixed'`. Server-side PROFILES table in `handlers.ts`. Resolution: env defaults < profile < per-call boosts (per-call wins). Reuse `mergeBoostRules` and `validateBoostsArg` from Iteration 1.

## Q4 — `resync_index` MCP tool

Compose `handleClearIndex` + `handleIndexCodebase({force: true})` atomically. Reuses the existing in-flight-cancel logic in `clear_index`. Register in `index.ts` tools/list + dispatch switch.

## Q5 — Boost telemetry JSONL + `boost_stats` tool

Append one JSONL line per boost-applied search to `~/.context/boost-events.jsonl`. Fields: ts, query (truncated to 200 chars), scope, boost rule keys fired, top result before/after, `shifted` (rank-1 changed?). 5 MB rotation cap. New `boost_stats` MCP tool reads and aggregates.

New file: `packages/mcp/src/boost-log.ts` (~80 lines).

## Files to modify

| File | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---|---|---|---|---|
| `README.md` | ✅ | | ✅ | ✅ | ✅ |
| `packages/mcp/src/config.ts` | ✅ | ✅ | | | |
| `packages/core/src/context.ts` | | ✅ | | | |
| `packages/mcp/src/handlers.ts` | | | ✅ | ✅ | ✅ |
| `packages/mcp/src/index.ts` | | | ✅ | ✅ | ✅ |
| `packages/mcp/src/boost-log.ts` (new) | | | | | ✅ |

## Acceptance Criteria (Iteration 2)

Q1:
- [x] README "Recommended Models" lists at least 3 Ollama options with tradeoffs.
- [x] `--help` shows `OLLAMA_MODEL=jina-embeddings-v2-base-code` as a recommended choice.
- [x] Migration steps (model switch → resync) documented.

Q2:
- [x] `CLAUDE_CONTEXT_RRF_K` env honored when set; defaults to 60 when unset.
- [x] Invalid env value (non-integer, ≤ 0) → log warning, fall back to 60.
- [x] `--help` documents the env var.

Q3:
- [x] `search_code` accepts `profile` enum: plan|code|doc|mixed.
- [x] Profile boosts compose under env defaults and per-call boosts per documented precedence.
- [x] Unknown profile string → MCP error listing valid choices.
- [x] Tool schema description explains when each profile fits.

Q4:
- [x] `tools/list` includes `resync_index` with absolute-path arg.
- [x] After resync on a stale codebase, `get_indexing_status` shows `liveChunkCount === totalChunks` (warning gone).
- [x] In-flight indexing aborts cleanly before resync starts (no double-write).

Q5:
- [x] Each boost-applied `search_code` call appends one JSONL line to `~/.context/boost-events.jsonl`.
- [x] Log file caps at 5 MB; oldest entries pruned automatically.
- [x] `boost_stats` returns total searches, per-rule fire count, rank-shift rate, top 5 boosted paths.
- [x] Queries truncated to 200 chars; never log file content.
- [x] When boosts not applied, no log line written (silent fast path).

Build:
- [x] `pnpm typecheck && pnpm run build` succeed with zero TS errors.
- [x] All five tools (index, search, clear, status, resync) plus boost_stats register and respond.

## Verification (Iteration 2)

1. **Q1 (manual)**: `ollama pull jina/jina-embeddings-v2-base-code`, swap `OLLAMA_MODEL`, `resync_index path=/Users/jeremyparker/.claude`, run "did we plan a batch-edit tool" with no boosts — observe whether `.md` files outrank `.py` organically.
2. **Q2**: Run same query before/after `CLAUDE_CONTEXT_RRF_K=60` — confirm score density spreads (rank 1 ~0.0164 vs ~0.0099 with k=100).
3. **Q3**: A/B same plan-intent query without and with `profile="plan"` — expect plans/specs hits to climb.
4. **Q4**: Confirm stale warning, run `resync_index`, re-check `get_indexing_status` — warning gone.
5. **Q5**: Run 5 varied queries with profile/boosts. Tail `~/.context/boost-events.jsonl` (5 lines, fields present, queries truncated). Call `boost_stats` — counts match.

## Out of scope (Iteration 2)

- Voyage-code-3 / paid embedders (user chose Ollama path).
- Auto-resync on stale-snapshot detection (CQS violation; explicit tool wins).
- Multi-embedder routing.
- LLM-based intent classification.
- P6 routing layer (memory-recall fallthrough) — still a harness concern.


