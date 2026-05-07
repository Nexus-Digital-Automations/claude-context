/**
 * Boost-event telemetry log (Q5).
 *
 * Owns: append-and-rotate JSONL persistence at `~/.context/boost-events.jsonl`,
 * and aggregate summarization for the `boost_stats` MCP tool. Best-effort —
 * I/O errors are logged to stderr but never propagate to the search path.
 *
 * Does NOT own: boost rule resolution (handlers.ts), profile presets
 * (handlers.ts BOOST_PROFILES), or search execution (context.ts).
 *
 * Called by: handlers.ts handleSearchCode (appendBoostEvent) and
 * handlers.ts handleBoostStats (summarizeBoostEvents).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOG_PATH = path.join(os.homedir(), '.context', 'boost-events.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;     // 5 MB hard cap before rotation
const ROTATION_DROP_RATIO = 0.25;       // drop oldest 25% of lines on overflow
const QUERY_TRUNCATE = 200;             // PII-safety: never log full long queries

/**
 * One row in the boost telemetry log. Field order matters for JSONL parsing
 * downstream — keep stable. `shifted` means rank-1 changed vs RRF order.
 * @stable — external analysis tools may parse this format.
 */
export interface BoostEvent {
    ts: string;
    query: string;
    scope?: string;
    boostKeys: string[];
    top: { path: string; boost: number; rrf: number; adj: number };
    shifted: boolean;
}

/**
 * Append one event to the JSONL log. Truncates the query string to
 * QUERY_TRUNCATE chars before writing — queries are user input and may
 * contain pasted secrets or PII. Rotates the file when it exceeds MAX_BYTES.
 * Never throws — telemetry must not block search results.
 */
export function appendBoostEvent(event: BoostEvent): void {
    try {
        const safeEvent: BoostEvent = {
            ...event,
            query: event.query.length > QUERY_TRUNCATE
                ? event.query.slice(0, QUERY_TRUNCATE) + '…'
                : event.query
        };
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        fs.appendFileSync(LOG_PATH, JSON.stringify(safeEvent) + '\n');
        const stat = fs.statSync(LOG_PATH);
        if (stat.size > MAX_BYTES) rotateLog();
    } catch (error) {
        console.warn(`[BOOST-LOG] Append failed (telemetry only, search unaffected):`, error);
    }
}

/**
 * Read the entire log and produce aggregates. Returns a structured summary
 * the `boost_stats` handler renders to text. Counts only well-formed JSONL
 * lines; malformed lines are silently skipped (best-effort parse).
 */
export function summarizeBoostEvents(): {
    totalEvents: number;
    perRuleFireCount: Record<string, number>;
    shiftedCount: number;
    shiftedRate: number;
    topBoostedPaths: Array<{ path: string; count: number }>;
    earliestTs?: string;
    latestTs?: string;
} {
    const empty = {
        totalEvents: 0,
        perRuleFireCount: {} as Record<string, number>,
        shiftedCount: 0,
        shiftedRate: 0,
        topBoostedPaths: []
    };
    if (!fs.existsSync(LOG_PATH)) return empty;
    let raw: string;
    try {
        raw = fs.readFileSync(LOG_PATH, 'utf8');
    } catch (error) {
        console.warn(`[BOOST-LOG] Read failed:`, error);
        return empty;
    }
    const events: BoostEvent[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            // skip malformed
        }
    }
    if (events.length === 0) return empty;

    const perRule: Record<string, number> = {};
    const perPath: Record<string, number> = {};
    let shiftedCount = 0;
    for (const e of events) {
        for (const k of e.boostKeys) perRule[k] = (perRule[k] ?? 0) + 1;
        if (e.top?.path) perPath[e.top.path] = (perPath[e.top.path] ?? 0) + 1;
        if (e.shifted) shiftedCount++;
    }
    const topBoostedPaths = Object.entries(perPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p, count]) => ({ path: p, count }));
    return {
        totalEvents: events.length,
        perRuleFireCount: perRule,
        shiftedCount,
        shiftedRate: shiftedCount / events.length,
        topBoostedPaths,
        earliestTs: events[0]?.ts,
        latestTs: events[events.length - 1]?.ts
    };
}

/**
 * Drop the oldest ROTATION_DROP_RATIO of lines and rewrite the file. Called
 * synchronously from append when size exceeds MAX_BYTES — keeps the log
 * bounded without a separate rotation daemon. @internal
 */
function rotateLog(): void {
    try {
        const raw = fs.readFileSync(LOG_PATH, 'utf8');
        const lines = raw.split('\n').filter(line => line.trim());
        const dropCount = Math.floor(lines.length * ROTATION_DROP_RATIO);
        const kept = lines.slice(dropCount);
        fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
        console.log(`[BOOST-LOG] Rotated: dropped ${dropCount} oldest lines, kept ${kept.length}`);
    } catch (error) {
        console.warn(`[BOOST-LOG] Rotation failed:`, error);
    }
}
