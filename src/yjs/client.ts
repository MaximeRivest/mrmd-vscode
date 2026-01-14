/**
 * Yjs Client for VS Code
 *
 * Manages WebSocket connection to mrmd-sync and Y.Doc lifecycle.
 * This is the VS Code equivalent of y-websocket usage in mrmd-editor.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import * as vscode from 'vscode';

export interface YjsClientOptions {
    /** mrmd-sync WebSocket URL (e.g., ws://localhost:41444) */
    syncUrl: string;
    /** Document name/path */
    docName: string;
    /** Optional auth token */
    token?: string;
}

export interface YjsClientStatus {
    connected: boolean;
    synced: boolean;
    error?: string;
}

/**
 * Yjs client that connects to mrmd-sync
 */
export class YjsClient implements vscode.Disposable {
    private _ydoc: Y.Doc;
    private _provider: WebsocketProvider | null = null;
    private _awareness: Awareness | null = null;
    private _status: YjsClientStatus = { connected: false, synced: false };

    private _onStatusChange = new vscode.EventEmitter<YjsClientStatus>();
    readonly onStatusChange = this._onStatusChange.event;

    private _onSynced = new vscode.EventEmitter<void>();
    readonly onSynced = this._onSynced.event;

    constructor() {
        this._ydoc = new Y.Doc();
    }

    get ydoc(): Y.Doc {
        return this._ydoc;
    }

    get awareness(): Awareness | null {
        return this._awareness;
    }

    get yText(): Y.Text {
        return this._ydoc.getText('content');
    }

    get status(): YjsClientStatus {
        return this._status;
    }

    get isConnected(): boolean {
        return this._status.connected;
    }

    get isSynced(): boolean {
        return this._status.synced;
    }

    /**
     * Connect to mrmd-sync server
     */
    async connect(options: YjsClientOptions): Promise<void> {
        if (this._provider) {
            this.disconnect();
        }

        const { syncUrl, docName, token } = options;
        const url = token ? `${syncUrl}?token=${token}` : syncUrl;

        return new Promise((resolve, reject) => {
            try {
                this._provider = new WebsocketProvider(url, docName, this._ydoc);
                this._awareness = this._provider.awareness;

                // Set up status tracking
                this._provider.on('status', ({ status }: { status: string }) => {
                    this._status.connected = status === 'connected';
                    this._onStatusChange.fire({ ...this._status });
                });

                this._provider.on('sync', (synced: boolean) => {
                    this._status.synced = synced;
                    this._onStatusChange.fire({ ...this._status });
                    if (synced) {
                        this._onSynced.fire();
                    }
                });

                // Wait for initial sync
                const onSync = (synced: boolean) => {
                    if (synced) {
                        this._provider?.off('sync', onSync);
                        resolve();
                    }
                };
                this._provider.on('sync', onSync);

                // Timeout after 10 seconds
                setTimeout(() => {
                    if (!this._status.synced) {
                        reject(new Error('Timeout connecting to mrmd-sync'));
                    }
                }, 10000);

            } catch (err) {
                this._status.error = String(err);
                this._onStatusChange.fire({ ...this._status });
                reject(err);
            }
        });
    }

    /**
     * Disconnect from server
     */
    disconnect(): void {
        if (this._provider) {
            this._provider.disconnect();
            this._provider.destroy();
            this._provider = null;
        }
        this._awareness = null;
        this._status = { connected: false, synced: false };
        this._onStatusChange.fire({ ...this._status });
    }

    /**
     * Set local awareness state (identify as VS Code client)
     */
    setAwarenessState(state: Record<string, unknown>): void {
        if (this._awareness) {
            this._awareness.setLocalStateField('user', {
                type: 'vscode',
                name: 'VS Code',
                ...state,
            });
        }
    }

    dispose(): void {
        this.disconnect();
        this._ydoc.destroy();
        this._onStatusChange.dispose();
        this._onSynced.dispose();
    }
}
