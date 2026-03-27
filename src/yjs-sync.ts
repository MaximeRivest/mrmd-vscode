/**
 * Yjs Document Sync
 *
 * Bidirectional sync between a VS Code TextDocument and a Yjs Y.Text.
 *
 * - Editor changes → Y.Text (via onDidChangeTextDocument)
 * - Y.Text changes → Editor (via ytext.observe)
 * - Anti-loop guards prevent infinite echo between the two directions
 *
 * IMPORTANT: During the initial WebSocket sync, Yjs→Editor updates are
 * suppressed. The `_reconcileInitialContent()` method handles the first
 * merge once the full server state has arrived. Only then is bidirectional
 * sync enabled. Without this, the Yjs observe fires an insert-at-0 delta
 * into an editor that already has the file content, doubling it.
 *
 * Disk persistence is ultimately owned by the sync server, but the VS Code
 * document must stay clean quickly enough that the server's later disk write
 * reloads silently instead of triggering the overwrite popup. To do that we
 * fast-save tracked documents after either sync direction applies content.
 *
 * Guards against echo loops:
 *   1. _suppressEditorToYjs — set during Yjs→Editor workspace.applyEdit
 *   2. _suppressYjsToEditor — set during Editor→Yjs ydoc.transact
 *   3. _selfSaving          — set during our own document.save(), so the
 *                             onDidSave file-watcher round-trip is ignored
 *   4. Full-document reload detection — if VS Code reloads from disk
 *      (file watcher), the change event replaces the entire content.
 *      We detect this and suppress the Editor→Yjs path since the content
 *      already matches Yjs (the sync server wrote it from the same Y.Doc).
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

/** Origin tag for transactions initiated by the local editor. */
const ORIGIN_EDITOR = 'vscode-editor';

export class YjsDocumentSync implements vscode.Disposable {
    readonly ydoc: Y.Doc;
    readonly ytext: Y.Text;
    readonly provider: WebsocketProvider;

    private _suppressEditorToYjs = false;
    private _suppressYjsToEditor = false;
    private _selfSaving = false;
    private _initialSyncDone = false;
    private _saveTimer: ReturnType<typeof setTimeout> | null = null;
    private _disposables: vscode.Disposable[] = [];
    private _document: vscode.TextDocument;

    constructor(
        wsUrl: string,
        roomName: string,
        document: vscode.TextDocument,
    ) {
        this._document = document;
        this.ydoc = new Y.Doc();
        this.ytext = this.ydoc.getText('content');
        this.provider = new WebsocketProvider(wsUrl, roomName, this.ydoc);

        // Suppress Yjs→Editor updates until initial reconciliation.
        // The server will send its full state during sync; we don't
        // want the observe handler to blindly insert that into the
        // editor (which already has the file content from disk).
        this._suppressYjsToEditor = true;

        // ── Y.Text → Editor ──────────────────────────────────
        this.ytext.observe(this._onYjsChange);

        // ── Editor → Y.Text ──────────────────────────────────
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document !== this._document) return;
                if (e.contentChanges.length === 0) return;
                if (this._suppressEditorToYjs) return;

                // Detect file-watcher full-document reload: a single change
                // that replaces the entire document. This happens when the
                // sync server writes to disk and VS Code picks it up.
                // Since the sync server wrote from the same Yjs state, the
                // content already matches — don't feed it back to Yjs.
                if (this._isFullDocumentReload(e.contentChanges)) return;

                this._applyEditorChangesToYjs(e.contentChanges);
            }),
        );
    }

    /**
     * Wait for the initial sync to complete, then reconcile content.
     *
     * After the full Yjs state has arrived from the server we compare it
     * with the editor's current text. This single reconciliation step
     * replaces the old approach of letting the observe handler apply
     * deltas during the handshake (which caused duplication).
     *
     * After reconciliation, bidirectional sync is enabled.
     */
    waitForSync(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.provider.synced) {
                this._reconcileInitialContent().then(resolve);
                return;
            }
            const handler = (synced: boolean) => {
                if (!synced) return;
                this.provider.off('sync', handler);
                this._reconcileInitialContent().then(resolve);
            };
            this.provider.on('sync', handler);
        });
    }

    dispose(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this.ytext.unobserve(this._onYjsChange);
        this.provider.destroy();
        this.ydoc.destroy();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    // ── Full-document reload detection ─────────────────────

    /**
     * Detect when VS Code's file watcher reloads the buffer from disk.
     * This shows up as a single content change that spans the entire
     * document. We compare the incoming text against Yjs — if it
     * matches, this is a reload of content we already have.
     */
    private _isFullDocumentReload(
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): boolean {
        if (changes.length !== 1) return false;
        const change = changes[0];
        // A full reload replaces from 0 to end-of-document.
        // The range covers the *previous* content, so rangeOffset=0
        // and rangeLength = previous doc length. After the change
        // the new text is the reloaded content.
        if (change.rangeOffset !== 0) return false;
        // Allow a small tolerance — the rangeLength should be close to
        // the full previous content. We can't know the exact previous
        // length after the fact, but if it starts at 0 and the new text
        // matches Yjs, that's our signal.
        const yjsContent = this.ytext.toString();
        return change.text === yjsContent;
    }

    // ── Y.Text → Editor ─────────────────────────────────────

    private _onYjsChange = (event: Y.YTextEvent) => {
        if (this._suppressYjsToEditor) return;
        // Ignore changes we made ourselves (editor → Yjs echo).
        if (event.transaction.origin === ORIGIN_EDITOR) return;
        this._applyYjsChangeToEditor(event);
    };

    private async _applyYjsChangeToEditor(event: Y.YTextEvent): Promise<void> {
        if (this._document.isClosed) return;

        const edit = new vscode.WorkspaceEdit();
        let offset = 0;

        for (const op of event.delta) {
            if (op.retain !== undefined) {
                offset += op.retain;
            } else if (op.delete !== undefined) {
                const start = this._document.positionAt(offset);
                const end = this._document.positionAt(offset + op.delete);
                edit.delete(this._document.uri, new vscode.Range(start, end));
            } else if (op.insert !== undefined && typeof op.insert === 'string') {
                const pos = this._document.positionAt(offset);
                edit.insert(this._document.uri, pos, op.insert);
                offset += op.insert.length;
            }
        }

        this._suppressEditorToYjs = true;
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            this._suppressEditorToYjs = false;
        }

        // Schedule a debounced save so VS Code's dirty flag is cleared
        // and the file is written to disk. The sync server also writes,
        // but going through VS Code keeps the editor state clean.
        this._scheduleSave();
    }

    // ── Editor → Y.Text ─────────────────────────────────────

    private _applyEditorChangesToYjs(
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): void {
        this._suppressYjsToEditor = true;
        try {
            this.ydoc.transact(() => {
                // VS Code provides changes in reverse document order,
                // so we can apply them sequentially without offset adjustment.
                const sorted = [...changes].sort(
                    (a, b) => b.rangeOffset - a.rangeOffset,
                );
                for (const change of sorted) {
                    if (change.rangeLength > 0) {
                        this.ytext.delete(change.rangeOffset, change.rangeLength);
                    }
                    if (change.text.length > 0) {
                        this.ytext.insert(change.rangeOffset, change.text);
                    }
                }
            }, ORIGIN_EDITOR);
        } finally {
            this._suppressYjsToEditor = false;
        }

        // Keep the document clean before the sync server's debounced
        // filesystem write lands, otherwise VS Code shows the overwrite
        // prompt for what is effectively the same content.
        this._scheduleSave();
    }

    // ── Initial reconciliation ───────────────────────────────

    /**
     * One-shot reconciliation after the initial Yjs sync completes.
     *
     * Three cases:
     *   1. Yjs is empty, editor has content → seed Yjs from editor
     *   2. Yjs has content, differs from editor → overwrite editor (Yjs is truth)
     *   3. Both match → no-op
     *
     * After this method returns, the Yjs→Editor observer is enabled and
     * bidirectional sync runs normally.
     */
    private async _reconcileInitialContent(): Promise<void> {
        // _suppressYjsToEditor is already true (set in constructor).
        // Keep it true until we're done reconciling.
        try {
            const yjsContent = this.ytext.toString();
            const editorContent = this._document.getText();

            if (yjsContent === editorContent) {
                // Already in sync — nothing to do.
                return;
            }

            if (yjsContent.length === 0 && editorContent.length > 0) {
                // Yjs doc is empty (new room) — seed it from the editor.
                this.ydoc.transact(() => {
                    this.ytext.insert(0, editorContent);
                });
            } else {
                // Yjs has content — overwrite editor (Yjs is source of truth).
                const fullRange = new vscode.Range(
                    this._document.positionAt(0),
                    this._document.positionAt(editorContent.length),
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(this._document.uri, fullRange, yjsContent);

                this._suppressEditorToYjs = true;
                try {
                    await vscode.workspace.applyEdit(edit);
                } finally {
                    this._suppressEditorToYjs = false;
                }
            }
        } finally {
            // Enable bidirectional sync now that initial state is settled.
            this._initialSyncDone = true;
            this._suppressYjsToEditor = false;
        }

        // Save so the dirty dot clears and the file is on disk.
        this._scheduleSave();
    }

    // ── Auto-save ────────────────────────────────────────────

    /**
     * Fast debounced save (50ms). The sole purpose is to clear the dirty
     * flag so VS Code's file watcher can silently reload when the sync
     * server writes to disk. A dirty document + disk change = overwrite
     * popup; a clean document + disk change = silent reload.
     *
     * This runs after both local editor edits and remote Yjs edits. The
     * sync server still persists the canonical Yjs state, but the fast
     * editor save keeps the working copy clean in the meantime.
     */
    private _scheduleSave(): void {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null;
            if (this._document.isDirty) {
                this._selfSaving = true;
                try {
                    await this._document.save();
                } catch {
                    // Document may have been closed
                } finally {
                    // Small delay before clearing the flag — the file
                    // watcher event arrives asynchronously after save.
                    setTimeout(() => { this._selfSaving = false; }, 100);
                }
            }
        }, 50);
    }
}
