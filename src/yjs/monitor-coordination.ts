/**
 * Monitor Coordination
 *
 * VS Code-side coordination protocol for working with mrmd-monitor.
 * Uses Y.Map('executions') to communicate with the monitor.
 *
 * Ported from mrmd-editor/src/monitor-coordination.js
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Execution status values (must match mrmd-monitor/coordination.js)
 */
export const EXECUTION_STATUS = {
    /** Browser/VS Code has requested execution */
    REQUESTED: 'requested',
    /** Monitor has claimed the execution */
    CLAIMED: 'claimed',
    /** Client has created output block, ready to start */
    READY: 'ready',
    /** Monitor is streaming output from runtime */
    RUNNING: 'running',
    /** Execution completed successfully */
    COMPLETED: 'completed',
    /** Execution failed with error */
    ERROR: 'error',
    /** Execution was cancelled */
    CANCELLED: 'cancelled',
} as const;

export type ExecutionStatus = typeof EXECUTION_STATUS[keyof typeof EXECUTION_STATUS];

/**
 * Execution entry in Y.Map
 */
export interface ExecutionEntry {
    id: string;
    cellId?: string;
    code: string;
    language: string;
    runtimeUrl: string;
    session: string;
    status: ExecutionStatus;
    requestedBy: number;
    requestedAt: number;
    claimedBy: number | null;
    claimedAt: number | null;
    outputBlockReady: boolean;
    outputPosition: unknown | null;
    startedAt: number | null;
    completedAt: number | null;
    stdinRequest: StdinRequest | null;
    stdinResponse: StdinResponse | null;
    result: unknown | null;
    error: string | null;
    displayData: unknown[];
}

export interface StdinRequest {
    prompt: string;
    password: boolean;
    requestedAt: number;
}

export interface StdinResponse {
    text: string;
    respondedAt: number;
}

export interface ExecutionRequest {
    code: string;
    language: string;
    runtimeUrl: string;
    session?: string;
    cellId?: string;
}

type StatusCallback = (status: ExecutionStatus, execution: ExecutionEntry) => void;

/**
 * Client-side coordination for monitor mode
 */
export class MonitorCoordination {
    readonly ydoc: Y.Doc;
    readonly clientId: number;
    readonly executions: Y.Map<ExecutionEntry>;

    private _statusCallbacks = new Map<string, StatusCallback>();
    private _observers = new Set<(event: Y.YMapEvent<ExecutionEntry>) => void>();

    constructor(ydoc: Y.Doc, clientId: number) {
        this.ydoc = ydoc;
        this.clientId = clientId;
        this.executions = ydoc.getMap('executions') as Y.Map<ExecutionEntry>;
        this._setupObserver();
    }

    /**
     * Generate unique execution ID
     */
    static generateExecId(): string {
        return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Set up Y.Map observer
     */
    private _setupObserver(): void {
        const observer = (event: Y.YMapEvent<ExecutionEntry>) => {
            event.changes.keys.forEach((change, execId) => {
                const exec = this.executions.get(execId);

                // Call status callback if registered
                const callback = this._statusCallbacks.get(execId);
                if (callback && exec) {
                    callback(exec.status, exec);
                }
            });
        };

        this.executions.observe(observer);
        this._observers.add(observer);
    }

    /**
     * Request execution via monitor
     */
    requestExecution(options: ExecutionRequest): string {
        const { code, language, runtimeUrl, session = 'default', cellId } = options;
        const execId = MonitorCoordination.generateExecId();

        const entry: ExecutionEntry = {
            id: execId,
            cellId,
            code,
            language,
            runtimeUrl,
            session,
            status: EXECUTION_STATUS.REQUESTED,
            requestedBy: this.clientId,
            requestedAt: Date.now(),
            claimedBy: null,
            claimedAt: null,
            outputBlockReady: false,
            outputPosition: null,
            startedAt: null,
            completedAt: null,
            stdinRequest: null,
            stdinResponse: null,
            result: null,
            error: null,
            displayData: [],
        };

        this.executions.set(execId, entry);
        return execId;
    }

    /**
     * Mark output block as ready (called after creating output block in Y.Text)
     */
    setOutputBlockReady(execId: string, outputPosition: unknown): void {
        const exec = this.executions.get(execId);
        if (!exec) return;

        this.executions.set(execId, {
            ...exec,
            status: exec.status === EXECUTION_STATUS.CLAIMED ? EXECUTION_STATUS.READY : exec.status,
            outputBlockReady: true,
            outputPosition,
        });
    }

    /**
     * Respond to stdin request
     */
    respondStdin(execId: string, text: string): void {
        const exec = this.executions.get(execId);
        if (!exec) return;

        this.executions.set(execId, {
            ...exec,
            stdinResponse: {
                text,
                respondedAt: Date.now(),
            },
        });
    }

    /**
     * Cancel execution
     */
    cancelExecution(execId: string): void {
        const exec = this.executions.get(execId);
        if (!exec) return;

        // Only cancel if not already completed/error
        const terminalStatuses: ExecutionStatus[] = [
            EXECUTION_STATUS.COMPLETED,
            EXECUTION_STATUS.ERROR,
            EXECUTION_STATUS.CANCELLED,
        ];
        if (terminalStatuses.includes(exec.status)) {
            return;
        }

        this.executions.set(execId, {
            ...exec,
            status: EXECUTION_STATUS.CANCELLED,
            completedAt: Date.now(),
        });
    }

    /**
     * Get execution by ID
     */
    getExecution(execId: string): ExecutionEntry | undefined {
        return this.executions.get(execId);
    }

    /**
     * Watch for status changes on a specific execution
     */
    onStatusChange(execId: string, callback: StatusCallback): () => void {
        this._statusCallbacks.set(execId, callback);

        return () => {
            this._statusCallbacks.delete(execId);
        };
    }

    /**
     * Wait for a specific status
     */
    waitForStatus(
        execId: string,
        targetStatus: ExecutionStatus | ExecutionStatus[],
        timeout = 30000
    ): Promise<ExecutionEntry> {
        const statuses = Array.isArray(targetStatus) ? targetStatus : [targetStatus];

        return new Promise((resolve, reject) => {
            // Check current status first
            const current = this.executions.get(execId);
            if (current && statuses.includes(current.status)) {
                resolve(current);
                return;
            }

            let timeoutId: NodeJS.Timeout;
            const unsubscribe = this.onStatusChange(execId, (status, exec) => {
                if (statuses.includes(status)) {
                    clearTimeout(timeoutId);
                    unsubscribe();
                    resolve(exec);
                }
            });

            timeoutId = setTimeout(() => {
                unsubscribe();
                reject(new Error(`Timeout waiting for status ${statuses.join('/')} on ${execId}`));
            }, timeout);
        });
    }

    /**
     * Check if monitor mode is available
     */
    isMonitorAvailable(awareness?: Awareness): boolean {
        if (awareness) {
            // Check if any peer is a monitor
            for (const [, state] of awareness.getStates()) {
                if ((state as Record<string, unknown>)?.user?.type === 'monitor') {
                    return true;
                }
            }
        }

        // Fallback: check if there are any recently claimed executions
        const now = Date.now();
        const recentThreshold = 60000; // 1 minute

        for (const exec of this.executions.values()) {
            if (exec.claimedBy && exec.claimedAt && (now - exec.claimedAt) < recentThreshold) {
                return true;
            }
        }

        return false;
    }

    /**
     * Clean up old executions
     */
    cleanup(maxAge = 3600000): void {
        const now = Date.now();
        const toDelete: string[] = [];

        const terminalStatuses: ExecutionStatus[] = [
            EXECUTION_STATUS.COMPLETED,
            EXECUTION_STATUS.ERROR,
            EXECUTION_STATUS.CANCELLED,
        ];

        this.executions.forEach((exec, execId) => {
            const age = now - (exec.completedAt || exec.requestedAt);
            if (age > maxAge && terminalStatuses.includes(exec.status)) {
                toDelete.push(execId);
            }
        });

        for (const execId of toDelete) {
            this.executions.delete(execId);
        }
    }

    /**
     * Destroy and clean up
     */
    destroy(): void {
        for (const observer of this._observers) {
            this.executions.unobserve(observer);
        }
        this._observers.clear();
        this._statusCallbacks.clear();
    }
}

/**
 * Create monitor coordination instance
 */
export function createMonitorCoordination(ydoc: Y.Doc): MonitorCoordination {
    return new MonitorCoordination(ydoc, ydoc.clientID);
}
