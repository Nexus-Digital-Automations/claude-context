import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-status-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }

        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }

        await rm(tempRoot, { recursive: true, force: true });
    }
}

test("get_indexing_status syncs cloud state before reading the snapshot", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");

        const handlers = new ToolHandlers({} as any, snapshotManager);
        let syncCalls = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
            syncCalls += 1;
            snapshotManager.setCodebaseIndexed(codebasePath, {
                indexedFiles: 3,
                totalChunks: 5,
                status: "completed",
            });
        };

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(syncCalls, 1);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /fully indexed and ready for search/);
        assert.match(result.content[0].text, /3 files, 5 chunks/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

// Regression: a live background indexing task is authoritative over the snapshot.
// Before the fix, a concurrent recovery/sync path could stamp an actively-indexing
// entry as 'indexed' with a partial rowCount mirrored into both file and chunk
// counts, so get_indexing_status falsely reported "✅ completed — N files, N chunks"
// (always equal) while embedding was still running.
test("get_indexing_status reports 'indexing' while a background task is live, even if the snapshot says indexed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        // Simulate the snapshot having been clobbered to 'indexed' by a racing path.
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 900,
            totalChunks: 900,
            status: "completed",
        });

        const handlers = new ToolHandlers({} as any, snapshotManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};
        // A genuine in-process indexing task is still running for this path.
        (handlers as any).indexingTasks.set(codebasePath, {
            controller: new AbortController(),
            promise: Promise.resolve(),
        });

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /currently being indexed/);
        assert.doesNotMatch(result.content[0].text, /fully indexed and ready for search/);
        // The fabricated, always-equal "completed" line must not surface.
        assert.doesNotMatch(result.content[0].text, /900 files, 900 chunks/);
    });
});

// Regression: syncIndexedCodebasesFromCloud must not "recover" a codebase that is
// mid-index. An indexing entry is absent from getIndexedCodebases() (which only
// holds 'indexed'), so without the in-flight guard the recovery loop overwrote it
// with a premature 'completed' built from the current partial Milvus row count.
test("cloud sync preserves in-flight indexing state instead of clobbering it to completed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });
        const collectionName = "hybrid_code_chunks_deadbeef";

        const snapshotManager = new SnapshotManager();
        // Background task has marked this codebase as indexing at 42%.
        snapshotManager.setCodebaseIndexing(codebasePath, 42);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");

        let rowCountQueried = false;
        const fakeContext = {
            getCollectionName: () => collectionName,
            getVectorDatabase: () => ({
                listCollections: async () => [collectionName],
                getCollectionDescription: async () => `codebasePath:${codebasePath}`,
                hasCollection: async () => true,
                getCollectionRowCount: async () => {
                    rowCountQueried = true;
                    return 900;
                },
                query: async () => [],
            }),
        };

        const handlers = new ToolHandlers(fakeContext as any, snapshotManager);
        // Mirror the live task map the running server would hold.
        (handlers as any).indexingTasks.set(codebasePath, {
            controller: new AbortController(),
            promise: Promise.resolve(),
        });

        await (handlers as any).syncIndexedCodebasesFromCloud();

        // The in-flight entry survives untouched — no premature 'completed', and
        // the recovery row-count query was skipped entirely for this path.
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
        assert.equal(rowCountQueried, false);
        const info = snapshotManager.getCodebaseInfo(codebasePath) as any;
        assert.equal(info.indexingPercentage, 42);
    });
});
