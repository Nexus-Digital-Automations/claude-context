import { envManager } from "@zilliz/claude-context-core";

/**
 * Multiplicative score boosts applied to RRF results before re-sorting.
 * `folders`: longest-prefix match on result `relativePath` (e.g. "plans/" → 1.5).
 * `extensions`: exact match on `path.extname(relativePath)` (e.g. ".md" → 1.2).
 * Both compose multiplicatively when both fire. Default per dimension is 1.0.
 * Counterpart: applied in handlers.ts after Context.semanticSearch returns —
 * Milvus's RRF ranking is left intact.
 * @stable — exposed via the `boosts` arg on the search_code MCP tool.
 */
export interface BoostRules {
    folders?: Record<string, number>;
    extensions?: Record<string, number>;
}

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter';
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    // Vector database configuration
    milvusAddress?: string; // Optional, can be auto-resolved from token
    milvusToken?: string;
    collectionNameOverride?: string;
    // Server-side default ranking boosts (overridden per-call by `boosts` arg).
    boostDefaults?: BoostRules;
}

// Legacy format (v1) - for backward compatibility
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;  // Array (legacy) or Map of codebase path to progress percentage
    lastUpdated: string;
}

// New format (v2) - structured with codebase information

export type RequestSplitterType = 'ast' | 'langchain';

// Request-level indexing options stored with a codebase's snapshot entry.
export interface CodebaseIndexOptions {
    requestSplitter?: RequestSplitterType;
    requestCustomExtensions?: string[];
    requestIgnorePatterns?: string[];
}

// Base interface for common fields
interface CodebaseInfoBase extends CodebaseIndexOptions {
    lastUpdated: string;
}

// Indexing state - when indexing is in progress
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;  // Current progress percentage
}

// Indexed state - when indexing completed successfully
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;        // Number of files indexed
    totalChunks: number;         // Total number of chunks generated
    indexStatus: 'completed' | 'limit_reached';  // Status from indexing result
}

// Index failed state - when indexing failed
export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;        // Error message from the failure
    lastAttemptedPercentage?: number;  // Progress when failure occurred
}

// Union type for all codebase information states
export type CodebaseInfo = CodebaseInfoIndexing | CodebaseInfoIndexed | CodebaseInfoIndexFailed;

export interface CodebaseSnapshotV2 {
    formatVersion: 'v2';
    codebases: Record<string, CodebaseInfo>;  // codebasePath -> CodebaseInfo
    lastUpdated: string;
}

// Union type for all supported formats
export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2;

// Helper function to get default model for each provider
export function getDefaultModelForProvider(provider: string): string {
    switch (provider) {
        case 'OpenAI':
            return 'text-embedding-3-small';
        case 'VoyageAI':
            return 'voyage-code-3';
        case 'Gemini':
            return 'gemini-embedding-001';
        case 'OpenRouter':
            return 'openai/text-embedding-3-small';
        case 'Ollama':
            return 'nomic-embed-text';
        default:
            return 'text-embedding-3-small';
    }
}

// Helper function to get embedding model with provider-specific environment variable priority
export function getEmbeddingModelForProvider(provider: string): string {
    switch (provider) {
        case 'Ollama':
            // For Ollama, prioritize OLLAMA_MODEL over EMBEDDING_MODEL for backward compatibility
            const ollamaModel = envManager.get('OLLAMA_MODEL') || envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 Ollama model selection: OLLAMA_MODEL=${envManager.get('OLLAMA_MODEL') || 'NOT SET'}, EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${ollamaModel}`);
            return ollamaModel;
        case 'OpenAI':
        case 'VoyageAI':
        case 'Gemini':
        case 'OpenRouter':
        default:
            // For all other providers, use EMBEDDING_MODEL or default
            const selectedModel = envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 ${provider} model selection: EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${selectedModel}`);
            return selectedModel;
    }
}

function getPositiveIntegerFromEnv(name: string): number | undefined {
    const rawValue = envManager.get(name);
    if (!rawValue) {
        return undefined;
    }

    const parsedValue = Number(rawValue);
    if (Number.isInteger(parsedValue) && parsedValue > 0) {
        return parsedValue;
    }

    console.warn(`[DEBUG] ⚠️  Ignoring invalid ${name}: ${rawValue}. Expected a positive integer.`);
    return undefined;
}

/**
 * Parse `CLAUDE_CONTEXT_BOOSTS` into a {@link BoostRules} object.
 * Format: comma-separated `kind:key=weight` entries. `kind` is `folder` or
 * `ext`; weight is a positive finite number. Examples:
 *   `folder:plans/=1.5,folder:tests/fixtures/=0.5,ext:.md=1.2,ext:.py=0.9`
 * Malformed entries are logged and dropped — server still starts.
 * Returns undefined when the env var is unset or yields zero valid rules.
 * @internal — counterpart: validateBoosts in handlers.ts mirrors per-call validation.
 */
export function parseBoostRulesFromEnv(): BoostRules | undefined {
    const raw = envManager.get('CLAUDE_CONTEXT_BOOSTS');
    if (!raw) return undefined;

    const folders: Record<string, number> = {};
    const extensions: Record<string, number> = {};
    const entryPattern = /^(folder|ext):(.+?)=([^=]+)$/;

    for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const parts = trimmed.match(entryPattern);
        if (!parts) {
            console.warn(`[DEBUG] ⚠️  Ignoring malformed CLAUDE_CONTEXT_BOOSTS entry: '${trimmed}'. Expected 'folder:<path>/=<weight>' or 'ext:.<ext>=<weight>'.`);
            continue;
        }
        const kind = parts[1];
        const key = parts[2];
        const weight = Number(parts[3]);
        if (!Number.isFinite(weight) || weight <= 0) {
            console.warn(`[DEBUG] ⚠️  Ignoring CLAUDE_CONTEXT_BOOSTS entry with non-positive weight: '${trimmed}'.`);
            continue;
        }
        if (kind === 'folder') {
            const normalized = key.endsWith('/') ? key : `${key}/`;
            folders[normalized] = weight;
        } else {
            if (!key.startsWith('.') || key.length < 2) {
                console.warn(`[DEBUG] ⚠️  Ignoring CLAUDE_CONTEXT_BOOSTS extension entry without leading dot: '${trimmed}'.`);
                continue;
            }
            extensions[key] = weight;
        }
    }

    const folderCount = Object.keys(folders).length;
    const extCount = Object.keys(extensions).length;
    if (folderCount === 0 && extCount === 0) return undefined;
    console.log(`[DEBUG] 🎚️  Parsed CLAUDE_CONTEXT_BOOSTS: ${folderCount} folder rule(s), ${extCount} extension rule(s)`);
    return {
        ...(folderCount > 0 && { folders }),
        ...(extCount > 0 && { extensions })
    };
}

export function createMcpConfig(): ContextMcpConfig {
    // Debug: Print all environment variables related to Context
    console.log(`[DEBUG] 🔍 Environment Variables Debug:`);
    console.log(`[DEBUG]   EMBEDDING_PROVIDER: ${envManager.get('EMBEDDING_PROVIDER') || 'NOT SET'}`);
    console.log(`[DEBUG]   EMBEDDING_MODEL: ${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}`);
    console.log(`[DEBUG]   EMBEDDING_DIMENSION: ${envManager.get('EMBEDDING_DIMENSION') || 'NOT SET'}`);
    console.log(`[DEBUG]   OLLAMA_MODEL: ${envManager.get('OLLAMA_MODEL') || 'NOT SET'}`);
    console.log(`[DEBUG]   GEMINI_API_KEY: ${envManager.get('GEMINI_API_KEY') ? 'SET (length: ' + envManager.get('GEMINI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.log(`[DEBUG]   OPENAI_API_KEY: ${envManager.get('OPENAI_API_KEY') ? 'SET (length: ' + envManager.get('OPENAI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.log(`[DEBUG]   MILVUS_ADDRESS: ${envManager.get('MILVUS_ADDRESS') || 'NOT SET'}`);
    console.log(`[DEBUG]   CODE_CHUNKS_COLLECTION_NAME_OVERRIDE: ${envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE') || 'NOT SET'}`);
    console.log(`[DEBUG]   NODE_ENV: ${envManager.get('NODE_ENV') || 'NOT SET'}`);

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Context MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
        // Embedding provider configuration
        embeddingProvider: (envManager.get('EMBEDDING_PROVIDER') as 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter') || 'OpenAI',
        embeddingModel: getEmbeddingModelForProvider(envManager.get('EMBEDDING_PROVIDER') || 'OpenAI'),
        // Provider-specific API keys
        openaiApiKey: envManager.get('OPENAI_API_KEY'),
        openaiBaseUrl: envManager.get('OPENAI_BASE_URL'),
        voyageaiApiKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        // OpenRouter configuration
        openrouterApiKey: envManager.get('OPENROUTER_API_KEY'),
        // Ollama configuration
        ollamaModel: envManager.get('OLLAMA_MODEL'),
        ollamaHost: envManager.get('OLLAMA_HOST'),
        ollamaDimension: getPositiveIntegerFromEnv('EMBEDDING_DIMENSION'),
        // Vector database configuration - address can be auto-resolved from token
        milvusAddress: envManager.get('MILVUS_ADDRESS'), // Optional, can be resolved from token
        milvusToken: envManager.get('MILVUS_TOKEN'),
        collectionNameOverride: envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE'),
        boostDefaults: parseBoostRulesFromEnv()
    };

    return config;
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    // Log configuration summary before starting server
    console.log(`[MCP] 🚀 Starting Context MCP Server`);
    console.log(`[MCP] Configuration Summary:`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding Provider: ${config.embeddingProvider}`);
    console.log(`[MCP]   Embedding Model: ${config.embeddingModel}`);
    console.log(`[MCP]   Milvus Address: ${config.milvusAddress || (config.milvusToken ? '[Auto-resolve from token]' : '[Not configured]')}`);
    if (config.collectionNameOverride) {
        console.log(`[MCP]   Collection Name Override: ✅ Configured`);
    }

    // Log provider-specific configuration without exposing sensitive data
    switch (config.embeddingProvider) {
        case 'OpenAI':
            console.log(`[MCP]   OpenAI API Key: ${config.openaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.openaiBaseUrl) {
                console.log(`[MCP]   OpenAI Base URL: ${config.openaiBaseUrl}`);
            }
            break;
        case 'VoyageAI':
            console.log(`[MCP]   VoyageAI API Key: ${config.voyageaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.geminiBaseUrl) {
                console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
            }
            break;
        case 'OpenRouter':
            console.log(`[MCP]   OpenRouter API Key: ${config.openrouterApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Ollama':
            console.log(`[MCP]   Ollama Host: ${config.ollamaHost || 'http://127.0.0.1:11434'}`);
            console.log(`[MCP]   Ollama Model: ${config.embeddingModel}`);
            if (config.ollamaDimension) {
                console.log(`[MCP]   Ollama Embedding Dimension: ${config.ollamaDimension}`);
            }
            break;
    }

    console.log(`[MCP] 🔧 Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Context MCP Server

Usage: npx @zilliz/claude-context-mcp@latest [options]

Options:
  --help, -h                          Show this help message

Environment Variables:
  MCP_SERVER_NAME         Server name
  MCP_SERVER_VERSION      Server version
  
  Embedding Provider Configuration:
  EMBEDDING_PROVIDER      Embedding provider: OpenAI, VoyageAI, Gemini, Ollama, OpenRouter (default: OpenAI)
  EMBEDDING_MODEL         Embedding model name (works for all providers)
  EMBEDDING_DIMENSION     Optional embedding dimension override for Ollama
  
  Provider-specific API Keys:
  OPENAI_API_KEY          OpenAI API key (required for OpenAI provider)
  OPENAI_BASE_URL         OpenAI API base URL (optional, for custom endpoints)
  VOYAGEAI_API_KEY        VoyageAI API key (required for VoyageAI provider)
  GEMINI_API_KEY          Google AI API key (required for Gemini provider)
  GEMINI_BASE_URL         Gemini API base URL (optional, for custom endpoints)
  OPENROUTER_API_KEY      OpenRouter API key (required for OpenRouter provider)

  Ollama Configuration:
  OLLAMA_HOST             Ollama server host (default: http://127.0.0.1:11434)
  OLLAMA_MODEL            Ollama model name (alternative to EMBEDDING_MODEL for Ollama).
                          Recommended for code+text retrieval:
                            jina/jina-embeddings-v2-base-code  (768 dim, code-tuned)
                            mxbai-embed-large                  (1024 dim, prose-focused)
                            nomic-embed-text                   (768 dim, fast default)
                          Switching the model requires a full re-index — use the
                          'resync_index' MCP tool after changing OLLAMA_MODEL.
  
  Vector Database Configuration:
  MILVUS_ADDRESS          Milvus address (optional, can be auto-resolved from token)
  MILVUS_TOKEN            Milvus token (optional, used for authentication and address resolution)
  CODE_CHUNKS_COLLECTION_NAME_OVERRIDE
                          Optional readable prefix for collection names.
                          Uses code_chunks_<override>_<pathHash> (or hybrid_...)
                          after sanitization (letters/digits/underscore, 255 chars max).
                          The per-codebase pathHash is preserved so multiple
                          codebases stay distinct under the same override.

  MCP Sync Configuration:
  CLAUDE_CONTEXT_BACKGROUND_SYNC
                          Enable/disable startup + periodic background sync
                          for indexed codebases (default: true). Set to false
                          to disable polling while keeping trigger-based sync.
  CLAUDE_CONTEXT_SYNC_INTERVAL_MS
                          Background sync interval in milliseconds when enabled
                          (default: 300000).

  Sync Trigger Watcher:
  CLAUDE_CONTEXT_TRIGGER_WATCHER
                          Enable/disable the ~/.context/.sync-trigger filesystem
                          watcher (default: true). When enabled, touching the
                          trigger file kicks off an immediate, debounced re-index.
                          Triggered syncs share the same global cross-process
                          lock as background sync, so multi-instance setups stay
                          coordinated. Set to false to disable filesystem
                          watching entirely (read-only / sandboxed environments).

  Ranking Boosts:
  CLAUDE_CONTEXT_BOOSTS   Server-side default ranking boosts applied to RRF
                          scores AFTER vector search. Format: comma-separated
                          'kind:key=weight' entries. kind is 'folder' or 'ext';
                          weight is a positive finite number.
                          Folder match uses longest-prefix on relativePath;
                          extension match uses exact extname. Per-call boosts
                          arg on search_code wins over these defaults on key
                          collision. Malformed entries are logged and dropped.
                          Example:
                            CLAUDE_CONTEXT_BOOSTS=folder:plans/=1.5,folder:tests/fixtures/=0.5,ext:.md=1.2,ext:.py=0.9

  CLAUDE_CONTEXT_RRF_K    RRF rank-fusion constant for hybrid search. Score is
                          1 / (k + rank), so smaller k spreads scores between
                          adjacent ranks and gives boosts more leverage.
                          Default: 60. Invalid values (non-integer, <= 0) log a
                          warning and fall back to the default.

Examples:
  # Start MCP server with OpenAI (default) and explicit Milvus address
  OPENAI_API_KEY=sk-xxx MILVUS_ADDRESS=localhost:19530 npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with OpenAI and specific model
  OPENAI_API_KEY=sk-xxx EMBEDDING_MODEL=text-embedding-3-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with VoyageAI and specific model
  EMBEDDING_PROVIDER=VoyageAI VOYAGEAI_API_KEY=pa-xxx EMBEDDING_MODEL=voyage-3-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Gemini and specific model
  EMBEDDING_PROVIDER=Gemini GEMINI_API_KEY=xxx EMBEDDING_MODEL=gemini-embedding-001 MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Ollama and specific model (using OLLAMA_MODEL)
  EMBEDDING_PROVIDER=Ollama OLLAMA_MODEL=mxbai-embed-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Ollama and specific model (using EMBEDDING_MODEL)
  EMBEDDING_PROVIDER=Ollama EMBEDDING_MODEL=nomic-embed-text MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest

  # Start MCP server with a human-readable collection name override
  OPENAI_API_KEY=sk-xxx MILVUS_TOKEN=your-token CODE_CHUNKS_COLLECTION_NAME_OVERRIDE=my_project npx @zilliz/claude-context-mcp@latest

  # Start MCP server with background sync enabled every minute
  OPENAI_API_KEY=sk-xxx MILVUS_TOKEN=your-token CLAUDE_CONTEXT_BACKGROUND_SYNC=true CLAUDE_CONTEXT_SYNC_INTERVAL_MS=60000 npx @zilliz/claude-context-mcp@latest
        `);
}
