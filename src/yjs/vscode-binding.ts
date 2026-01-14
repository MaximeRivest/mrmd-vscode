/**
 * VS Code Yjs Binding
 *
 * Bidirectional sync between Y.Text and VS Code TextDocument.
 * This is the VS Code equivalent of y-codemirror.next's yCollab.
 *
 * Key challenges:
 * - VS Code's TextDocument is file-based, not in-memory like CodeMirror
 * - Need to avoid echo (re-applying our own changes)
 * - Need to handle concurrent edits from Yjs (other collaborators)
 */

import * as Y from 'yjs';
import * as vscode from 'vscode';

const ORIGIN_VSCODE = 'vscode';
const ORIGIN_REMOTE = 'remote';

export interface VsCodeYjsBindingOptions {
    /** The Y.Text to bind */
    yText: Y.Text;
    /** The VS Code document to bind */
    document: vscode.TextDocument;
}

/**
 * Bidirectional binding between Y.Text and VS Code TextDocument
 */
export class VsCodeYjsBinding implements vscode.Disposable {
    private _yText: Y.Text;
    private _document: vscode.TextDocument;
    private _disposables: vscode.Disposable[] = [];

    /** Flag to prevent echo when applying Yjs changes to VS Code */
    private _isApplyingYjsChanges = false;

    /** Flag to prevent echo when applying VS Code changes to Yjs */
    private _isApplyingVsCodeChanges = false;

    /** Pending VS Code edit to apply */
    private _pendingEdit: vscode.WorkspaceEdit | null = null;

    constructor(options: VsCodeYjsBindingOptions) {
        this._yText = options.yText;
        this._document = options.document;

        this._setupYjsObserver();
        this._setupVsCodeObserver();
    }

    get document(): vscode.TextDocument {
        return this._document;
    }

    get yText(): Y.Text {
        return this._yText;
    }

    /**
     * Initialize binding - sync initial content
     *
     * Call this after connecting to mrmd-sync and waiting for sync.
     * Determines which side has authority based on content.
     */
    async initialize(): Promise<void> {
        const yjsContent = this._yText.toString();
        const vsCodeContent = this._document.getText();

        if (yjsContent && !vsCodeContent) {
            // Yjs has content, VS Code empty - apply Yjs to VS Code
            await this._applyYjsToVsCode(yjsContent);
        } else if (!yjsContent && vsCodeContent) {
            // VS Code has content, Yjs empty - apply VS Code to Yjs
            this._applyVsCodeToYjs(vsCodeContent);
        } else if (yjsContent !== vsCodeContent) {
            // Both have content but differ - Yjs wins (it's the source of truth)
            await this._applyYjsToVsCode(yjsContent);
        }
        // If both are equal (or both empty), nothing to do
    }

    /**
     * Set up Y.Text observer for remote changes
     */
    private _setupYjsObserver(): void {
        const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
            // Skip if this change originated from VS Code
            if (transaction.origin === ORIGIN_VSCODE || this._isApplyingVsCodeChanges) {
                return;
            }

            // Apply Yjs changes to VS Code
            this._applyYjsDeltaToVsCode(event.delta);
        };

        this._yText.observe(observer);

        // Store cleanup
        this._disposables.push({
            dispose: () => this._yText.unobserve(observer),
        });
    }

    /**
     * Set up VS Code document change observer
     */
    private _setupVsCodeObserver(): void {
        const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
            // Only handle our document
            if (event.document !== this._document) {
                return;
            }

            // Skip if we're applying Yjs changes
            if (this._isApplyingYjsChanges) {
                return;
            }

            // Skip empty changes
            if (event.contentChanges.length === 0) {
                return;
            }

            // Apply VS Code changes to Yjs
            this._applyVsCodeChangesToYjs(event.contentChanges);
        });

        this._disposables.push(subscription);
    }

    /**
     * Apply Y.Text delta to VS Code document
     */
    private async _applyYjsDeltaToVsCode(delta: Y.Delta[]): Promise<void> {
        if (delta.length === 0) return;

        this._isApplyingYjsChanges = true;

        try {
            const edit = new vscode.WorkspaceEdit();
            let index = 0;

            for (const op of delta) {
                if (op.retain !== undefined) {
                    index += op.retain;
                } else if (op.insert !== undefined) {
                    const text = typeof op.insert === 'string' ? op.insert : '';
                    const position = this._document.positionAt(index);
                    edit.insert(this._document.uri, position, text);
                    index += text.length;
                } else if (op.delete !== undefined) {
                    const start = this._document.positionAt(index);
                    const end = this._document.positionAt(index + op.delete);
                    edit.delete(this._document.uri, new vscode.Range(start, end));
                    // Don't advance index for delete
                }
            }

            await vscode.workspace.applyEdit(edit);
        } finally {
            this._isApplyingYjsChanges = false;
        }
    }

    /**
     * Apply VS Code content changes to Y.Text
     */
    private _applyVsCodeChangesToYjs(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
        this._isApplyingVsCodeChanges = true;

        try {
            this._yText.doc?.transact(() => {
                // Sort changes by offset descending to apply from end to start
                // This prevents offset shifts from affecting subsequent changes
                const sortedChanges = [...changes].sort(
                    (a, b) => b.rangeOffset - a.rangeOffset
                );

                for (const change of sortedChanges) {
                    // Delete old content
                    if (change.rangeLength > 0) {
                        this._yText.delete(change.rangeOffset, change.rangeLength);
                    }
                    // Insert new content
                    if (change.text) {
                        this._yText.insert(change.rangeOffset, change.text);
                    }
                }
            }, ORIGIN_VSCODE);
        } finally {
            this._isApplyingVsCodeChanges = false;
        }
    }

    /**
     * Replace VS Code document content with Yjs content
     */
    private async _applyYjsToVsCode(content: string): Promise<void> {
        this._isApplyingYjsChanges = true;

        try {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                this._document.positionAt(0),
                this._document.positionAt(this._document.getText().length)
            );
            edit.replace(this._document.uri, fullRange, content);
            await vscode.workspace.applyEdit(edit);
        } finally {
            this._isApplyingYjsChanges = false;
        }
    }

    /**
     * Replace Y.Text content with VS Code document content
     */
    private _applyVsCodeToYjs(content: string): void {
        this._isApplyingVsCodeChanges = true;

        try {
            this._yText.doc?.transact(() => {
                this._yText.delete(0, this._yText.length);
                this._yText.insert(0, content);
            }, ORIGIN_VSCODE);
        } finally {
            this._isApplyingVsCodeChanges = false;
        }
    }

    /**
     * Update the bound document (call when switching documents)
     */
    updateDocument(document: vscode.TextDocument): void {
        this._document = document;
    }

    dispose(): void {
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables = [];
    }
}

/**
 * Create a binding between Y.Text and VS Code document
 */
export function createVsCodeBinding(
    yText: Y.Text,
    document: vscode.TextDocument
): VsCodeYjsBinding {
    return new VsCodeYjsBinding({ yText, document });
}
