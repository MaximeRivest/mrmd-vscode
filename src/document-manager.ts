/**
 * Document Manager
 *
 * Manages per-document lifecycle: opening (sync + monitor), execution,
 * and cleanup. Each open .md file gets a YjsDocumentSync instance
 * backed by the daemon's sync server and monitor.
 *
 * Also tracks execution state by observing the Yjs `executions` map.
 * Emits 'execution:done' when an execution completes/errors/cancels
 * so the extension can update CodeLens.
 */

import * as vscode from 'vscode';
import { MrmdClient, OpenResult } from './daemon-client';
import { YjsDocumentSync } from './yjs-sync';

const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled']);

interface TrackedDocument {
    sync: YjsDocumentSync;
    info: OpenResult;
    execObserver?: () => void; // Yjs unsubscribe
}

export interface ExecutionEvent {
    execId: string;
    docPath: string;
    status: string;
    language?: string;
}

export class DocumentManager implements vscode.Disposable {
    private _tracked = new Map<string, TrackedDocument>();
    private _client: MrmdClient;
    private _disposables: vscode.Disposable[] = [];

    // Execution lifecycle callback — set by the extension
    onExecutionDone?: (event: ExecutionEvent) => void;

    constructor(client: MrmdClient) {
        this._client = client;

        // Auto-close when document is closed in VS Code
        this._disposables.push(
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.close(doc.uri.fsPath);
            }),
        );
    }

    /**
     * Open a document for Yjs-synced editing and execution.
     * Idempotent — returns existing sync if already tracked.
     *
     * 1. Calls client.open() → daemon ensures sync server + monitor
     * 2. Creates YjsDocumentSync → joins Yjs room
     * 3. Waits for initial sync
     * 4. Starts observing the executions Y.Map for status changes
     */
    async open(document: vscode.TextDocument): Promise<TrackedDocument> {
        const filePath = document.uri.fsPath;

        const existing = this._tracked.get(filePath);
        if (existing) return existing;

        // Daemon resolves projectRoot automatically from mrmd.md
        const info = await this._client.open(filePath);

        const roomName = filePath;
        const sync = new YjsDocumentSync(info.wsUrl, roomName, document);
        await sync.waitForSync();

        const tracked: TrackedDocument = { sync, info };

        // Observe the executions Y.Map for completion events
        tracked.execObserver = this._observeExecutions(filePath, sync);

        this._tracked.set(filePath, tracked);
        return tracked;
    }

    /**
     * Close a tracked document — dispose Yjs sync and observers.
     */
    close(filePath: string): void {
        const tracked = this._tracked.get(filePath);
        if (!tracked) return;
        tracked.execObserver?.();
        tracked.sync.dispose();
        this._tracked.delete(filePath);
    }

    isTracked(filePath: string): boolean {
        return this._tracked.has(filePath);
    }

    /**
     * Re-establish all document syncs after a daemon reconnection.
     */
    async reconnect(): Promise<string[]> {
        const previousPaths = [...this._tracked.keys()];

        for (const [, tracked] of this._tracked) {
            tracked.execObserver?.();
            tracked.sync.dispose();
        }
        this._tracked.clear();

        const failed: string[] = [];
        for (const filePath of previousPaths) {
            const doc = vscode.workspace.textDocuments.find(
                (d) => d.uri.fsPath === filePath,
            );
            if (!doc) continue;
            try {
                await this.open(doc);
            } catch {
                failed.push(filePath);
            }
        }

        return failed;
    }

    dispose(): void {
        for (const [, tracked] of this._tracked) {
            tracked.execObserver?.();
            tracked.sync.dispose();
        }
        this._tracked.clear();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    // ── Execution observer ───────────────────────────────────

    /**
     * Watch the Yjs `executions` map for an open document.
     * When an execution reaches a terminal status, fire the callback
     * so the extension can update CodeLens and status bar.
     */
    private _observeExecutions(
        docPath: string,
        sync: YjsDocumentSync,
    ): () => void {
        const execMap = sync.ydoc.getMap('executions');

        const observer = (event: any) => {
            if (!this.onExecutionDone) return;
            event.changes.keys.forEach((_change: any, key: string) => {
                const exec = execMap.get(key) as any;
                if (!exec) return;
                if (TERMINAL_STATUSES.has(exec.status)) {
                    this.onExecutionDone!({
                        execId: key,
                        docPath,
                        status: exec.status,
                        language: exec.language,
                    });
                }
            });
        };

        execMap.observe(observer);
        return () => execMap.unobserve(observer);
    }
}
