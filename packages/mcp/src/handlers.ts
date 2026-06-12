import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CHUNK_LIMIT, Context, COLLECTION_LIMIT_MESSAGE, envManager, FileSynchronizer, IndexAbortError } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import type { BoostRules, CodebaseIndexOptions, RequestSplitterType } from "./config.js";
import { createRequestSplitter, isRequestSplitterType } from "./splitter.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";
import { appendBoostEvent, summarizeBoostEvents } from "./boost-log.js";

/**
 * If `requestedPath` is a strict descendant of `indexedRoot`, return the
 * POSIX-normalized relative subdirectory (e.g. "plans" or "src/core").
 * Returns undefined when paths are equal or `requestedPath` escapes the root —
 * callers MUST treat undefined as "no scope filter" and fall back to the full
 * collection. Counterpart: indexer writes POSIX `relativePath` into Milvus, so
 * the returned scope is safe to compose into a `like "<scope>/%"` predicate.
 * @internal
 */
function computePathScope(indexedRoot: string, requestedPath: string): string | undefined {
    if (indexedRoot === requestedPath) return undefined;
    const rel = path.relative(indexedRoot, requestedPath);
    if (!rel || rel.startsWith('..')) return undefined;
    return rel.split(path.sep).join('/');
}

/**
 * Escape Milvus LIKE wildcards (`%`, `_`) and the escape char itself in a
 * literal path segment so it matches verbatim. Without this, a folder named
 * `my_folder` would over-match `myXfolder` because `_` is a single-char
 * wildcard in Milvus boolean expressions. Milvus uses `\` as the escape prefix.
 * Cross-reference: https://milvus.io/docs/boolean.md
 * @internal
 */
function escapeMilvusLike(literal: string): string {
    return literal.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Validate a per-call `boosts` arg from the MCP search_code tool. Returns a
 * normalized {@link BoostRules} (folder keys forced to trailing slash, weights
 * coerced to number). Returns undefined when the arg is unset/invalid; the
 * server must NOT throw on bad input — it logs and falls through to defaults.
 * Counterpart: parseBoostRulesFromEnv in config.ts mirrors this for env input.
 * @internal
 */
function validateBoostsArg(raw: unknown): BoostRules | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const input = raw as { folders?: unknown; extensions?: unknown };
    const folders: Record<string, number> = {};
    const extensions: Record<string, number> = {};

    if (input.folders && typeof input.folders === 'object') {
        for (const [key, value] of Object.entries(input.folders as Record<string, unknown>)) {
            const weight = Number(value);
            if (!Number.isFinite(weight) || weight <= 0) {
                console.warn(`[SEARCH] ⚠️  Ignoring boost folder '${key}': non-positive weight ${value}`);
                continue;
            }
            const normalized = key.endsWith('/') ? key : `${key}/`;
            folders[normalized] = weight;
        }
    }
    if (input.extensions && typeof input.extensions === 'object') {
        for (const [key, value] of Object.entries(input.extensions as Record<string, unknown>)) {
            const weight = Number(value);
            if (!Number.isFinite(weight) || weight <= 0) {
                console.warn(`[SEARCH] ⚠️  Ignoring boost extension '${key}': non-positive weight ${value}`);
                continue;
            }
            if (!key.startsWith('.') || key.length < 2) {
                console.warn(`[SEARCH] ⚠️  Ignoring boost extension '${key}': missing leading dot`);
                continue;
            }
            extensions[key] = weight;
        }
    }

    const folderCount = Object.keys(folders).length;
    const extCount = Object.keys(extensions).length;
    if (folderCount === 0 && extCount === 0) return undefined;
    return {
        ...(folderCount > 0 && { folders }),
        ...(extCount > 0 && { extensions })
    };
}

/**
 * Preset boost profiles exposed via the `profile` arg on `search_code`.
 * Each preset is a known-good {@link BoostRules} for a common query intent.
 * Layered under per-call `boosts` (per-call wins) and over the server-side
 * `CLAUDE_CONTEXT_BOOSTS` env defaults — see {@link mergeBoostRules}.
 * EXTENSION POINT — add new presets here and document them in the schema in
 * `index.ts` and the README "Granular Control" section.
 * @stable — keys are part of the MCP tool surface.
 */
const BOOST_PROFILES: Record<string, BoostRules> = {
    plan: {
        folders: { 'plans/': 2.0, 'specs/': 1.5, 'docs/': 1.3 },
        extensions: { '.md': 1.3, '.py': 0.8, '.ts': 0.8, '.js': 0.8 }
    },
    code: {
        folders: { 'src/': 1.3, 'lib/': 1.2, 'tests/fixtures/': 0.5 },
        extensions: { '.md': 0.7 }
    },
    doc: {
        folders: { 'docs/': 1.5, 'plans/': 1.3 },
        extensions: { '.md': 1.5, '.txt': 1.3 }
    },
    mixed: {} // identity preset; documents the no-op for symmetry
};

/**
 * Compose per-call boost rules over server-side defaults. Per-call entries win
 * on key collision so agents can override env-configured weights for a single
 * query. Returns undefined when neither side contributes any rule.
 * @internal
 */
function mergeBoostRules(defaults: BoostRules | undefined, perCall: BoostRules | undefined): BoostRules | undefined {
    if (!defaults && !perCall) return undefined;
    const folders = { ...(defaults?.folders), ...(perCall?.folders) };
    const extensions = { ...(defaults?.extensions), ...(perCall?.extensions) };
    const folderCount = Object.keys(folders).length;
    const extCount = Object.keys(extensions).length;
    if (folderCount === 0 && extCount === 0) return undefined;
    return {
        ...(folderCount > 0 && { folders }),
        ...(extCount > 0 && { extensions })
    };
}

/**
 * Flatten a {@link BoostRules} into a stable list of `kind:key` rule
 * identifiers for telemetry. Order is folders-then-extensions for log
 * stability; consumers should treat the list as a set.
 * Counterpart: appendBoostEvent in boost-log.ts persists these keys.
 * @internal
 */
function collectBoostKeys(boosts: BoostRules): string[] {
    const keys: string[] = [];
    for (const k of Object.keys(boosts.folders ?? {})) keys.push(`folder:${k}`);
    for (const k of Object.keys(boosts.extensions ?? {})) keys.push(`ext:${k}`);
    return keys;
}

/**
 * Re-rank semantic search results using multiplicative boost factors.
 * Folder match uses longest-prefix-wins; extension match uses exact extname.
 * Both compose multiplicatively. Sort is stable on ties (preserves RRF order).
 * Returns a NEW array — caller's input is not mutated. Each output result
 * carries `originalScore` and `boost` for debuggability when boosts fired.
 * @internal
 */
function rerankWithBoosts(results: any[], boosts: BoostRules): any[] {
    const folderKeys = Object.keys(boosts.folders ?? {}).sort((a, b) => b.length - a.length);
    const extensionMap = boosts.extensions ?? {};

    return results
        .map((result, index) => {
            let factor = 1;
            for (const key of folderKeys) {
                if (result.relativePath.startsWith(key)) {
                    factor *= boosts.folders![key];
                    break;
                }
            }
            const ext = path.extname(result.relativePath);
            if (ext && extensionMap[ext] !== undefined) {
                factor *= extensionMap[ext];
            }
            return {
                ...result,
                originalScore: result.score,
                score: result.score * factor,
                boost: factor,
                _rrfIndex: index
            };
        })
        .sort((a, b) => b.score - a.score || a._rrfIndex - b._rrfIndex)
        .map(({ _rrfIndex, ...rest }) => rest);
}

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    /**
     * Tracks active background indexing tasks per absolute codebase path so
     * clear_index can cancel and await them before dropping the collection.
     * Without this, a clear_index call returns "successfully cleared" while
     * the background task keeps embedding chunks and writing them into the
     * just-cleared collection (issue #199).
     */
    private indexingTasks: Map<string, { controller: AbortController; promise: Promise<void> }> = new Map();
    /**
     * Server-side default ranking boosts parsed from CLAUDE_CONTEXT_BOOSTS.
     * Per-call `boosts` arg on search_code wins on key collision.
     * Counterpart: parseBoostRulesFromEnv in config.ts.
     */
    private boostDefaults?: BoostRules;

    constructor(context: Context, snapshotManager: SnapshotManager, boostDefaults?: BoostRules) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.boostDefaults = boostDefaults;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Query Milvus for the real row count of a codebase's collection.
     * Returns null if the count cannot be determined — callers must NOT write a
     * snapshot entry in that case. Writing { indexedFiles: 0, totalChunks: 0,
     * status: 'completed' } for an unknown-state collection poisons the client:
     * the client treats 0/0 as "not indexed" and triggers force reindex, which
     * deletes real data and rewrites 0/0 — an infinite loop. See Issue #295.
     */
    private async queryCollectionStats(codebasePath: string): Promise<{ indexedFiles: number; totalChunks: number } | null> {
        try {
            const collectionName = this.context.getCollectionName(codebasePath);
            const rowCount = await this.context.getVectorDatabase().getCollectionRowCount(collectionName);
            if (rowCount < 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Row count unknown for '${codebasePath}', skipping recovery write`);
                return null;
            }
            if (rowCount === 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Collection '${collectionName}' truly empty — NOT writing recovered entry (would poison client)`);
                return null;
            }
            // rowCount is chunk count, not file count. Without a metadata query
            // we don't have the real file count; the snapshot will be corrected
            // on the next full index. Using rowCount for both is imprecise but
            // keeps the state non-zero so the client doesn't misread it as empty.
            return { indexedFiles: rowCount, totalChunks: rowCount };
        } catch (error) {
            console.warn(`[SNAPSHOT-RECOVERY] Failed to query stats for '${codebasePath}':`, error);
            return null;
        }
    }

    /**
     * One-shot startup validation: find any legacy 0/0+completed entries on disk
     * (left over from old MCP versions, v1 snapshot migrations, or pre-fix recovery
     * paths) and either heal them with the real Milvus row count or remove them
     * if the underlying collection is empty/missing. See Issue #295.
     *
     * Safe to call multiple times but intended to run once per server start after
     * loadCodebaseSnapshot(). Errors are caught and logged; never throws.
     */
    public async validateLegacyZeroEntries(): Promise<void> {
        try {
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            let healed = 0, removed = 0, skipped = 0, checked = 0;

            for (const codebasePath of indexedCodebases) {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== 'indexed') continue;
                // Only validate suspiciously-zero entries
                if (info.indexedFiles !== 0 || info.totalChunks !== 0) continue;

                checked++;
                const collectionName = this.context.getCollectionName(codebasePath);
                const vdb = this.context.getVectorDatabase();

                // First probe: does the collection even exist? A "no" here is
                // authoritative (permanent orphan), while a throw is most likely
                // transient (Milvus unreachable) — keep those two cases distinct
                // so we don't destroy real state on a network blip.
                let collectionExists: boolean;
                try {
                    collectionExists = await vdb.hasCollection(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] hasCollection failed for '${codebasePath}' (likely transient), skipping:`, err);
                    skipped++;
                    continue;
                }

                if (!collectionExists) {
                    // Permanent orphan — no matching Milvus collection, so the
                    // 0/0+completed snapshot entry is a pure phantom. Remove it.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed orphan 0/0 entry '${codebasePath}' — no matching Milvus collection`);
                    continue;
                }

                // Collection exists — get an accurate row count.
                let rowCount: number;
                try {
                    rowCount = await vdb.getCollectionRowCount(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] getCollectionRowCount failed for '${codebasePath}', skipping:`, err);
                    skipped++;
                    continue;
                }

                if (rowCount > 0) {
                    // Heal: rewrite with real row count. rowCount is chunk count;
                    // without a cheap file-count query we reuse it for both fields.
                    // Imprecise but keeps the state non-zero and will be corrected
                    // on the next full index.
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles: rowCount,
                        totalChunks: rowCount,
                        status: 'completed' as const,
                    });
                    healed++;
                    console.log(`[SNAPSHOT-VALIDATE] Healed legacy 0/0 entry '${codebasePath}' → rows=${rowCount}`);
                } else if (rowCount === 0) {
                    // Collection exists but truly empty — the 0/0+completed entry
                    // is a phantom. Remove so the user must explicitly reindex.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed phantom 0/0 entry '${codebasePath}' — collection exists but empty`);
                } else {
                    // rowCount === -1 despite the collection existing: the count
                    // query failed after the existence probe succeeded. Treat as
                    // transient and leave the entry alone.
                    skipped++;
                    console.warn(`[SNAPSHOT-VALIDATE] Row count unavailable for existing collection '${codebasePath}', skipping`);
                }
            }

            if (healed > 0 || removed > 0) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`, error);
        }
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud. Skipping deletion of local codebases to avoid data loss from transient errors.`);
                return;
            }

            const cloudCodebases = new Set<string>();
            let codeCollectionsChecked = 0;
            let successfulExtractions = 0;

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    codeCollectionsChecked++;
                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Try to extract codebasePath from collection description first (new format)
                    let extracted = false;
                    try {
                        const description = await vectorDb.getCollectionDescription(collectionName);
                        if (description && description.startsWith('codebasePath:')) {
                            const codebasePath = description.substring('codebasePath:'.length);
                            if (codebasePath.length > 0) {
                                console.log(`[SYNC-CLOUD] 📍 Found codebase path from description: ${codebasePath} in collection: ${collectionName}`);
                                cloudCodebases.add(codebasePath);
                                successfulExtractions++;
                                extracted = true;
                            }
                        }
                    } catch (descError: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to get description for collection ${collectionName}:`, descError.message || descError);
                    }

                    // Fallback: query document metadata for old collections without new description format
                    if (!extracted) {
                        console.log(`[SYNC-CLOUD] 🔄 Falling back to query-based extraction for collection: ${collectionName}`);
                        try {
                            const results = await vectorDb.query(
                                collectionName,
                                undefined as any, // Don't pass empty filter
                                ['metadata'], // Only fetch metadata field
                                1 // Only need one result to extract codebasePath
                            );

                            if (results && results.length > 0) {
                                const firstResult = results[0];
                                const metadataStr = firstResult.metadata;

                                if (metadataStr) {
                                    const metadata = JSON.parse(metadataStr);
                                    const codebasePath = metadata.codebasePath;

                                    if (codebasePath && typeof codebasePath === 'string') {
                                        console.log(`[SYNC-CLOUD] 📍 Found codebase path from query: ${codebasePath} in collection: ${collectionName}`);
                                        cloudCodebases.add(codebasePath);
                                        successfulExtractions++;
                                    } else {
                                        console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                    }
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                                }
                            } else {
                                console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                            }
                        } catch (queryError: any) {
                            console.warn(`[SYNC-CLOUD] ⚠️  Fallback query failed for collection ${collectionName}:`, queryError.message || queryError);
                        }
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud (checked ${codeCollectionsChecked} code collections, ${successfulExtractions} successfully extracted)`);

            // Safety guard: if we checked code collections but none returned results,
            // treat this as an extraction failure rather than "cloud is empty".
            // This prevents deleting all local codebases due to transient errors.
            if (codeCollectionsChecked > 0 && successfulExtractions === 0) {
                console.warn(`[SYNC-CLOUD] ⚠️  All ${codeCollectionsChecked} code collection extractions failed. Skipping sync to avoid accidental deletion of local codebases.`);
                return;
            }

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeCodebaseCompletely(localCodebase);
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localCodebase);
                    } catch (error: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to delete local merkle snapshot for removed codebase '${localCodebase}':`, error?.message || error);
                    }

                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Codebases with an in-flight index must NOT be "recovered" here. An
            // actively-indexing codebase has snapshot status 'indexing', so it is
            // absent from `localCodebases` (which only holds 'indexed' entries),
            // and its Milvus collection is mid-populate. Recovering it would call
            // queryCollectionStats() and stamp a premature 'completed' using the
            // current PARTIAL rowCount for BOTH indexedFiles and totalChunks —
            // clobbering live progress and surfacing fabricated, always-equal
            // "N files, N chunks" while embedding is still running (the exact
            // cause of get_indexing_status reporting "completed" mid-index).
            // Guard with the live task map (authoritative for this server) plus
            // the snapshot's 'indexing' set (covers a task owned by another
            // process or carried across a restart).
            const indexingInFlight = new Set<string>(
                [
                    ...this.indexingTasks.keys(),
                    ...this.snapshotManager.getIndexingCodebases(),
                ].map(p => path.resolve(p))
            );

            // Add cloud codebases that are missing from local snapshot (recovery).
            // Query Milvus for the real row count — if unknown/empty, skip the write
            // so we don't persist a poisoning 0/0+completed entry (Issue #295).
            for (const cloudCodebase of cloudCodebases) {
                if (localCodebases.has(cloudCodebase)) continue;
                if (indexingInFlight.has(path.resolve(cloudCodebase))) {
                    console.log(`[SYNC-CLOUD] ⏭️  Skipped recovery for ${cloudCodebase} (indexing in progress — preserving live state)`);
                    continue;
                }
                const stats = await this.queryCollectionStats(cloudCodebase);
                if (stats) {
                    this.snapshotManager.setCodebaseIndexed(cloudCodebase, {
                        ...stats,
                        status: 'completed' as const
                    });
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➕ Recovered codebase from cloud: ${cloudCodebase} (rows=${stats.totalChunks})`);
                } else {
                    console.log(`[SYNC-CLOUD] ⏭️  Skipped recovery for ${cloudCodebase} (row count unknown or zero)`);
                }
            }

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const requestedSplitter = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (!isRequestSplitterType(requestedSplitter)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${requestedSplitter}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            const splitterType: RequestSplitterType = requestedSplitter;
            const indexOptions: CodebaseIndexOptions = {
                requestSplitter: splitterType,
                requestCustomExtensions: customFileExtensions,
                requestIgnorePatterns: customIgnorePatterns
            };
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                if (forceReindex) {
                    console.log(`[FORCE-REINDEX] Clearing stale indexing state for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                        }],
                        isError: true
                    };
                }
            }

            //Check if the snapshot and cloud index are in sync
            const snapshotHasIndex = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const vectorDbHasIndex = await this.context.hasIndex(absolutePath);
            if (snapshotHasIndex !== vectorDbHasIndex) {
                if (vectorDbHasIndex && !snapshotHasIndex) {
                    // Query Milvus for real row count. If unknown/empty, log and move on
                    // without writing 0/0+completed (which would trigger the force-reindex
                    // loop in Issue #295). The user is about to (re)index anyway.
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[INDEX-VALIDATION] Recovering missing snapshot for '${absolutePath}' (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                    } else {
                        console.warn(`[INDEX-VALIDATION] VectorDB reports index for '${absolutePath}' but row count unknown/zero — not writing snapshot entry`);
                    }
                } else if (!vectorDbHasIndex && snapshotHasIndex) {
                    console.warn(`[INDEX-VALIDATION] Clearing stale snapshot for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationError.message || validationError}`
                    }],
                    isError: true
                };
            }

            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed.
            // Track the controller + promise so clear_index can cancel and
            // await us before dropping the underlying collection.
            const controller = new AbortController();
            const promise = this.startBackgroundIndexing(
                absolutePath,
                forceReindex,
                splitterType,
                customIgnorePatterns,
                customFileExtensions,
                indexOptions,
                controller.signal
            ).finally(() => {
                // Only clear the entry if it still points at this run — a
                // concurrent re-index may have replaced us.
                const current = this.indexingTasks.get(absolutePath);
                if (current && current.controller === controller) {
                    this.indexingTasks.delete(absolutePath);
                }
            });
            this.indexingTasks.set(absolutePath, { controller, promise });

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            const requestSplitter = createRequestSplitter(splitterType);

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            // and merge them with this request's custom ignore patterns without
            // relying on shared Context state for this background indexing task.
            const ignorePatterns = await this.context.getEffectiveIgnorePatterns(absolutePath, customIgnorePatterns);
            const supportedExtensions = this.context.getEffectiveSupportedExtensions(customFileExtensions);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            if (customFileExtensions.length > 0) {
                console.log(`[BACKGROUND-INDEX] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, supportedExtensions);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await this.context.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, false, customIgnorePatterns, customFileExtensions, requestSplitter, signal);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, indexOptions);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            // Cooperative cancel from clear_index — clear_index is responsible
            // for tearing down the snapshot/collection right after, so do not
            // overwrite the snapshot with an "indexfailed" entry that would
            // race the clear and leave a tombstone behind.
            if (error instanceof IndexAbortError) {
                console.log(`[BACKGROUND-INDEX] Indexing for ${absolutePath} was cancelled: ${error.message}`);
                return;
            }

            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter, boosts: boostsArg, profile: profileArg } = args;
        const resultLimit = limit || 10;
        // Resolve profile preset, rejecting unknown values rather than silently
        // falling back — surprise routing on a typo is worse than an error.
        let profileBoosts: BoostRules | undefined;
        if (profileArg !== undefined && profileArg !== null) {
            if (typeof profileArg !== 'string' || !(profileArg in BOOST_PROFILES)) {
                const valid = Object.keys(BOOST_PROFILES).join(', ');
                return {
                    content: [{ type: 'text', text: `Error: Unknown profile '${profileArg}'. Valid choices: ${valid}.` }],
                    isError: true
                };
            }
            profileBoosts = BOOST_PROFILES[profileArg];
        }
        // Layered merge: env defaults < profile preset < per-call boosts.
        // Counterpart: BOOST_PROFILES lookup table at module top.
        const effectiveBoosts = mergeBoostRules(
            mergeBoostRules(this.boostDefaults, profileBoosts),
            validateBoostsArg(boostsArg)
        );

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const indexedCodebasePath = this.snapshotManager.findIndexedCodebasePath(absolutePath);
            const indexingCodebasePath = this.snapshotManager.findIndexingCodebasePath(absolutePath);
            const matchedCodebase = [indexedCodebasePath, indexingCodebasePath]
                .filter((codebase): codebase is string => codebase !== undefined)
                .sort((a, b) => b.length - a.length)[0];
            let searchCodebasePath = matchedCodebase || absolutePath;
            let isIndexed = indexedCodebasePath === searchCodebasePath;
            const isIndexing = indexingCodebasePath === searchCodebasePath;

            if (!isIndexed && !isIndexing) {
                // Fallback: check VectorDB directly in case snapshot is out of sync.
                // Only recover the snapshot when we can confirm a real row count —
                // writing 0/0+completed for an unverifiable collection poisons the
                // client into a force-reindex loop (Issue #295).
                const hasVectorIndex = await this.context.hasIndex(absolutePath);
                if (hasVectorIndex) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[SEARCH] Snapshot missing but VectorDB has index for '${absolutePath}', recovering snapshot (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                        searchCodebasePath = absolutePath;
                        isIndexed = true;
                        // Continue with search (don't return error)
                    } else {
                        return {
                            content: [{
                                type: "text",
                                text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                            }],
                            isError: true
                        };
                    }
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                        }],
                        isError: true
                    };
                }
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${searchCodebasePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // Path scope: when the requested path is a strict descendant of the matched
            // indexed root, restrict results to that subtree. Without this, `path=` is
            // only used to pick the parent collection — results bleed across the whole
            // indexed tree (P3). Counterpart: chunks are stored with POSIX `relativePath`
            // by the indexer in context.ts, so we normalize separators on Windows.
            const pathScope = computePathScope(searchCodebasePath, absolutePath);
            if (pathScope) {
                const scopeExpr = `relativePath like "${escapeMilvusLike(pathScope)}/%"`;
                filterExpr = filterExpr ? `(${filterExpr}) and (${scopeExpr})` : scopeExpr;
                console.log(`[SEARCH] Scoping results to subdirectory: ${pathScope}/`);
            }

            // Search in the specified codebase
            const rawResults = await this.context.semanticSearch(
                searchCodebasePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr
            );

            // Re-rank with boost rules at the MCP boundary so Milvus's RRF stays
            // pure. Boosts are presentation-tier (P4/P5) — they shape what the
            // agent sees without polluting the core search API.
            const rrfTopPath = (rawResults as any[])[0]?.relativePath;
            const searchResults = effectiveBoosts ? rerankWithBoosts(rawResults as any[], effectiveBoosts) : rawResults;
            if (effectiveBoosts && searchResults.length > 0) {
                const top = searchResults[0] as any;
                console.log(`[SEARCH] 🎚️  Boosts applied: top result boost=×${top.boost?.toFixed(2)}, rrf=${top.originalScore?.toFixed(3)} → adj=${top.score?.toFixed(3)}, path=${top.relativePath}`);
                // Telemetry (Q5) — fire-and-forget; never blocks the search
                // path. Counterpart: ~/.context/boost-events.jsonl, summarized
                // by handleBoostStats / boost_stats MCP tool.
                appendBoostEvent({
                    ts: new Date().toISOString(),
                    query,
                    scope: pathScope,
                    boostKeys: collectBoostKeys(effectiveBoosts),
                    top: {
                        path: top.relativePath,
                        boost: top.boost ?? 1,
                        rrf: top.originalScore ?? top.score,
                        adj: top.score
                    },
                    shifted: !!rrfTopPath && rrfTopPath !== top.relativePath
                });
            }

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                // Check if collection was lost (indexed locally but missing in Milvus)
                if (isIndexed && !isIndexing) {
                    const collectionName = this.context.getCollectionName(searchCodebasePath);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [{ type: "text", text: `Error: Index data for '${searchCodebasePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.` }],
                            isError: true
                        };
                    }
                }

                let noResultsMessage = `No results found for query: "${query}" in codebase '${searchCodebasePath}'`;
                if (searchCodebasePath !== absolutePath) {
                    noResultsMessage += pathScope
                        ? `\nResults scoped to subdirectory '${pathScope}/' within indexed codebase '${searchCodebasePath}'.`
                        : `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
                }
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(searchCodebasePath);
                const boostLine = (result.boost !== undefined && result.boost !== 1)
                    ? `   Boost: ×${result.boost.toFixed(2)} (rrf=${result.originalScore.toFixed(3)} → adj=${result.score.toFixed(3)})\n`
                    : '';

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    boostLine +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`;
            if (searchCodebasePath !== absolutePath) {
                resultMessage += pathScope
                    ? `\nResults scoped to subdirectory '${pathScope}/' within indexed codebase '${searchCodebasePath}'.`
                    : `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
            }
            resultMessage += `\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            // Cancel any in-flight background indexing for this codebase and
            // wait for it to wind down before we drop the collection.
            // Otherwise the background task keeps embedding chunks and writes
            // them into the just-cleared collection (issue #199).
            const activeTask = this.indexingTasks.get(absolutePath);
            if (activeTask) {
                console.log(`[CLEAR] Cancelling in-flight background indexing for: ${absolutePath}`);
                activeTask.controller.abort();
                try {
                    await activeTask.promise;
                } catch (waitError: any) {
                    // startBackgroundIndexing already logs and never re-throws,
                    // so this catch only guards against future refactors.
                    console.warn(`[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`);
                }
                this.indexingTasks.delete(absolutePath);
            }

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    /**
     * Resync a codebase's index by composing clear + force re-index. Use after
     * `get_indexing_status` flags a stale snapshot (live Milvus chunk count
     * differs from snapshot's stored count) so the snapshot and the vector DB
     * agree again. Cancels any in-flight indexing via `handleClearIndex`'s
     * AbortController plumbing before starting the new index.
     * Counterpart: stale-snapshot warning emitted by `buildLiveDiagnostics`.
     * Failure modes: clear failure short-circuits with the clear error; index
     * failure surfaces normally and the snapshot is left in `indexfailed` state
     * so the agent can retry.
     * @stable — exposed as the `resync_index` MCP tool.
     */
    public async handleResyncIndex(args: any) {
        const { path: codebasePath } = args;
        console.log(`[RESYNC] Starting resync for: ${codebasePath}`);
        const clearResult = await this.handleClearIndex({ path: codebasePath });
        if (clearResult.isError) {
            console.error(`[RESYNC] Clear step failed for ${codebasePath} — aborting resync`);
            return clearResult;
        }
        console.log(`[RESYNC] Clear succeeded, starting fresh index for: ${codebasePath}`);
        return await this.handleIndexCodebase({ path: codebasePath, force: true });
    }

    /**
     * Render boost telemetry as a human-readable summary for the `boost_stats`
     * MCP tool (Q5). Reads `~/.context/boost-events.jsonl` via boost-log helpers
     * and aggregates: total events, per-rule fire count, rank-shift rate, top
     * boosted paths. Returns an "empty" summary when no log exists yet — never
     * an error, since a fresh install has no telemetry by definition.
     * Counterpart: appendBoostEvent in boost-log.ts writes the source data.
     * @stable — exposed as the `boost_stats` MCP tool.
     */
    public async handleBoostStats(_args: any) {
        const summary = summarizeBoostEvents();
        if (summary.totalEvents === 0) {
            return {
                content: [{ type: 'text', text: 'No boost events recorded yet. Run search_code with `profile` or `boosts` to populate ~/.context/boost-events.jsonl.' }]
            };
        }
        const ruleLines = Object.entries(summary.perRuleFireCount)
            .sort((a, b) => b[1] - a[1])
            .map(([rule, count]) => `   ${rule}: ${count}`)
            .join('\n');
        const pathLines = summary.topBoostedPaths
            .map((entry, i) => `   ${i + 1}. ${entry.path} (${entry.count})`)
            .join('\n');
        const text = [
            `📊 Boost telemetry summary`,
            `   totalEvents=${summary.totalEvents}`,
            `   shiftedRate=${(summary.shiftedRate * 100).toFixed(1)}%  (rank-1 changed in ${summary.shiftedCount}/${summary.totalEvents} queries)`,
            summary.earliestTs ? `   firstSeen=${summary.earliestTs}` : '',
            summary.latestTs ? `   lastSeen=${summary.latestTs}` : '',
            ``,
            `Per-rule fire counts:`,
            ruleLines || '   (none)',
            ``,
            `Top boosted result paths:`,
            pathLines || '   (none)'
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text }] };
    }

    /**
     * Build the live-diagnostics block appended to `get_indexing_status` (P7).
     * Reads Milvus row count and freshness env vars on every call so the
     * report reflects current state, not server-startup state. Failures on the
     * Milvus side fall through to a snapshot-only block — agents must still
     * get a usable response when the vector DB is unreachable.
     * Counterpart: setCodebaseIndexed in snapshot.ts persists `indexStatus`
     * which we surface here as the cap-fired signal.
     * @internal
     */
    private async buildLiveDiagnostics(codebasePath: string, info: any): Promise<string> {
        const lines: string[] = ['', '📊 Diagnostics:'];
        lines.push(`   chunkLimit=${CHUNK_LIMIT}`);

        let liveChunkCount: number | 'unavailable' = 'unavailable';
        try {
            const collectionName = this.context.getCollectionName(codebasePath);
            const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
            if (hasCollection) {
                const rowCount = await this.context.getVectorDatabase().getCollectionRowCount(collectionName);
                if (rowCount >= 0) liveChunkCount = rowCount;
            }
        } catch (error) {
            console.warn(`[STATUS] Live chunk count unavailable for '${codebasePath}':`, error);
        }
        lines.push(`   liveChunkCount=${liveChunkCount}`);

        const snapshotChunks = info && 'totalChunks' in info ? info.totalChunks : undefined;
        if (typeof snapshotChunks === 'number' && typeof liveChunkCount === 'number' && snapshotChunks !== liveChunkCount) {
            lines.push(`   ⚠️  snapshot=${snapshotChunks} differs from Milvus=${liveChunkCount} — snapshot may be stale`);
        }

        const capFired = info && 'indexStatus' in info && info.indexStatus === 'limit_reached';
        lines.push(`   capFired=${capFired ? 'yes' : 'no'}`);

        // Sync env vars: read each call so toggling them doesn't require a restart.
        const watcherDisabled = (envManager.get('CLAUDE_CONTEXT_TRIGGER_WATCHER') ?? 'true').toLowerCase() === 'false';
        const backgroundDisabled = (envManager.get('CLAUDE_CONTEXT_BACKGROUND_SYNC') ?? 'true').toLowerCase() === 'false';
        const intervalMs = Number(envManager.get('CLAUDE_CONTEXT_SYNC_INTERVAL_MS') ?? 300000);
        lines.push(`   fileWatcherEnabled=${!watcherDisabled}`);
        lines.push(`   backgroundSyncEnabled=${!backgroundDisabled}`);
        lines.push(`   backgroundSyncIntervalMs=${Number.isFinite(intervalMs) ? intervalMs : 300000}`);

        return lines.join('\n');
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            await this.syncIndexedCodebasesFromCloud();

            // Check indexing status using new status system
            const statusCodebasePath = this.snapshotManager.findTrackedCodebasePath(absolutePath) || absolutePath;
            const status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
            const info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);

            // A live in-process indexing task is authoritative over the snapshot.
            // Recovery/sync/validation paths can momentarily stamp an actively-
            // indexing entry as 'indexed'; while our background task is still
            // embedding, the honest status is 'indexing'. The task map self-clears
            // on completion (startBackgroundIndexing's .finally), so this is true
            // only while work is genuinely in flight.
            const effectiveStatus =
                (this.indexingTasks.has(statusCodebasePath) || this.indexingTasks.has(absolutePath))
                    ? 'indexing'
                    : status;

            let statusMessage = '';

            switch (effectiveStatus) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';
            const matchedPathInfo = statusCodebasePath !== absolutePath
                ? `\nRequested path '${absolutePath}' is covered by tracked codebase '${statusCodebasePath}'.`
                : '';

            const diagnostics = await this.buildLiveDiagnostics(statusCodebasePath, info);

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo + matchedPathInfo + diagnostics
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
} 
