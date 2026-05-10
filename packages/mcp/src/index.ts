#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Claude Context
        this.context = new Context({
            embedding,
            vectorDatabase,
            collectionNameOverride: config.collectionNameOverride
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, config.boostDefaults);

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

🎚️ **Granular Control**:
- **Path subscope**: passing a path that is a strict descendant of an indexed root (e.g. \`path=/repo/plans\` when \`/repo\` is indexed) restricts results to that subtree via a server-side filter — results from siblings are excluded, not just routed.
- **Per-call ranking boosts** (\`boosts\` arg): multiplicatively reweight RRF scores AFTER vector search.
  - \`boosts.folders\`: longest-prefix match on \`relativePath\` (e.g. \`{"plans/": 1.5, "tests/fixtures/": 0.5}\`).
  - \`boosts.extensions\`: exact extname match (e.g. \`{".md": 1.2, ".py": 0.9}\`).
  - Folder + extension compose multiplicatively. Default is 1.0 (no-op). Per-call entries win over server-side defaults from the \`CLAUDE_CONTEXT_BOOSTS\` env var on key collision.
  - Use boosts to surface plan/spec markdown over implementation files for intent queries, or to demote test fixtures.
- **Server-side defaults**: \`CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,ext:.md=1.2\` sets baseline weights without requiring per-call args.

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
- When boosts are applied, each result's output includes a \`Boost: ×N.NN (rrf=... → adj=...)\` line for transparency.

⛔ **When NOT to use search_code** (use grep / find / Read instead):
- **Filename filtering**: \`find … | grep …\`, \`find -not -path …\`, or \`find … | xargs grep\`. \`find\` emits paths; the downstream grep filters paths, never file contents — search_code can't replace that.
- **Single-file content scans**: \`grep "pat" path/to/file.py\` against one named file is targeted I/O. Read the file or run grep — the index round-trip adds latency without value.
- **Off-project / unindexed paths**: anything outside an indexed root (\`/etc\`, \`/tmp\`, sibling repos that haven't been indexed). Use grep directly.
- **Exact opaque tokens you already located**: UUIDs, SHAs, error codes, version strings in a known file. \`grep -F\` is precise; semantic ranking just adds noise.

For everything else — concept queries, cross-file pattern discovery, "where is X implemented", architecture exploration — search_code is the right tool.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                },
                                profile: {
                                    type: "string",
                                    enum: ["plan", "code", "doc", "mixed"],
                                    description: "Optional: ranking profile preset. Each preset bundles known-good boosts for a common query intent. Layers UNDER per-call `boosts` (per-call wins) and OVER server-side `CLAUDE_CONTEXT_BOOSTS` env defaults. Presets:\n- 'plan' — surfaces planning/spec markdown over implementation code (plans/=2.0, specs/=1.5, docs/=1.3, .md=1.3, .py/.ts/.js=0.8). Use for 'did we plan/spec X?' queries.\n- 'code' — favours source code, demotes test fixtures (src/=1.3, lib/=1.2, tests/fixtures/=0.5, .md=0.7). Use for implementation-finding queries.\n- 'doc' — favours documentation (docs/=1.5, plans/=1.3, .md=1.5, .txt=1.3). Use for 'how do I configure/use X?' queries.\n- 'mixed' — identity (no boosts from profile). Use to opt out without removing the arg."
                                },
                                boosts: {
                                    type: "object",
                                    description: "Optional: Multiplicative score boosts applied AFTER RRF ranking, used to re-sort results. Server-side defaults from CLAUDE_CONTEXT_BOOSTS env var are merged in (per-call entries win on key collision). Both maps are optional; default per dimension is 1.0.",
                                    properties: {
                                        folders: {
                                            type: "object",
                                            description: "Per-folder weights keyed by relativePath prefix (e.g. {'plans/': 1.5, 'tests/fixtures/': 0.5}). Longest matching prefix wins.",
                                            additionalProperties: { type: "number" }
                                        },
                                        extensions: {
                                            type: "object",
                                            description: "Per-extension weights keyed by extname including the dot (e.g. {'.md': 1.2, '.py': 0.9}).",
                                            additionalProperties: { type: "number" }
                                        }
                                    },
                                    additionalProperties: false
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "boost_stats",
                        description: `Summarize boost telemetry from ~/.context/boost-events.jsonl. Reports total boost-applied searches, per-rule fire counts (which folder/extension boosts actually matched results), rank-shift rate (% of queries where boosts changed the rank-1 result), and top boosted result paths. Use this to tune profile presets and CLAUDE_CONTEXT_BOOSTS env defaults based on real query patterns. Returns 'no events recorded' when telemetry is empty.`,
                        inputSchema: {
                            type: "object",
                            properties: {},
                            required: []
                        }
                    },
                    {
                        name: "resync_index",
                        description: `Resync a codebase's index when get_indexing_status reports a stale snapshot (live Milvus chunk count differs from the snapshot's stored count). Composes clear_index + index_codebase(force=true) atomically. Cancels in-flight indexing before resyncing. Use this instead of running clear_index and index_codebase separately when the staleness warning fires.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to resync.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.

Also returns a 📊 Diagnostics block with:
- chunkLimit: hard cap on chunks per codebase (450000)
- liveChunkCount: live row count from Milvus (vs. snapshot's stored counts) — call this out as 'unavailable' if the vector DB is unreachable
- stale-snapshot warning: auto-fires when liveChunkCount differs from the snapshot's totalChunks (signals the snapshot is out of sync; clear_index + index_codebase will resync)
- capFired: yes/no — whether indexing was truncated by chunkLimit
- fileWatcherEnabled, backgroundSyncEnabled, backgroundSyncIntervalMs: current sync configuration

Use this to diagnose stale snapshots before re-indexing.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "resync_index":
                    return await this.toolHandlers.handleResyncIndex(args);
                case "boost_stats":
                    return await this.toolHandlers.handleBoostStats(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');

        // One-shot startup healing for legacy 0/0+completed snapshot entries
        // left over from pre-fix MCP versions. Runs before the transport accepts
        // requests so clients never observe the poisoning state. See Issue #295.
        await this.toolHandlers.validateLegacyZeroEntries();

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
