/**
 * Daemon Client
 *
 * Thin wrapper around the mrmd package's connect() function.
 * Provides TypeScript types for the proxy-based client API.
 *
 * The underlying client auto-reconnects when the daemon restarts.
 * Heads should listen for lifecycle events ('disconnected',
 * 'reconnecting', 'reconnected') to re-establish application state.
 */

// mrmd's client.js is ESM; esbuild handles the interop.
// @ts-ignore — no .d.ts yet for the mrmd package
import { connect as mrmdConnect } from 'mrmd';

// ── Types ─────────────────────────────────────────────────────

export interface OpenResult {
    syncPort: number;
    wsUrl: string;
    documentPath: string;
    projectRoot: string;
}

export interface ExecuteResult {
    execId: string;
}

export interface DaemonStatus {
    pid: number;
    socket: string;
    startedAt: string;
    uptime: number;
    runtimes: number;
    sync: number;
    monitors: number;
    heads: number;
}

/**
 * Proxy-based service namespace.
 * Any method call becomes an RPC call: `ns.method(params)` → `namespace.method(params)`.
 */
export interface ServiceProxy {
    [method: string]: (params?: any) => Promise<any>;
}

export interface InterruptResult {
    ok: boolean;
    cancelled: string[];
}

export interface MrmdClient {
    /** Whether the client is currently connected to the daemon. */
    readonly connected: boolean;

    open(documentPath: string, projectRoot?: string): Promise<OpenResult>;
    run(documentPath: string, code: string, language: string, opts?: { cwd?: string; cellId?: string }): Promise<ExecuteResult>;
    stop(documentPath: string, execId?: string): Promise<InterruptResult>;
    status(): Promise<DaemonStatus>;
    disconnect(): void;

    /** Low-level RPC call to the daemon. */
    _call(method: string, params?: any): Promise<any>;

    on(event: 'disconnected', handler: () => void): void;
    on(event: 'reconnecting', handler: () => void): void;
    on(event: 'reconnected', handler: () => void): void;
    on(event: string, handler: (...args: any[]) => void): void;

    off(event: string, handler: (...args: any[]) => void): void;

    runtimes: ServiceProxy;
    sync: ServiceProxy;
    monitors: ServiceProxy;
    executions: ServiceProxy;
    preferences: ServiceProxy;
}

/**
 * Connect to the mrmd daemon. Auto-starts if not running.
 * The returned client auto-reconnects on disconnection.
 */
export async function connect(): Promise<MrmdClient> {
    return mrmdConnect() as Promise<MrmdClient>;
}
