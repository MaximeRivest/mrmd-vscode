/**
 * Language features for code cells in markdown.
 *
 * Bridges VS Code's language feature APIs (completion, hover, etc.)
 * to the running MRP runtimes via the daemon. LSP-agnostic — works
 * with whatever the runtime provides (IPython, Node, bash, etc.).
 *
 * Only active when a runtime is running for the cell's language.
 * Does NOT start runtimes — features appear silently after the user
 * runs their first cell.
 */

import * as vscode from 'vscode';
import { MrmdClient } from './daemon-client';
import { blockAtCursor, parseBlocks, CodeBlock } from './blocks';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Find the code block containing a position, and compute the
 * character offset within the cell's code string.
 */
function cellContext(
    document: vscode.TextDocument,
    position: vscode.Position,
): { block: CodeBlock; code: string; cursor: number } | null {
    const block = blockAtCursor(document, position);
    if (!block) return null;

    // Cursor must be inside the code, not on the fence lines
    if (position.line <= block.fenceStart || position.line >= block.fenceEnd) {
        return null;
    }

    const code = block.code;
    const codeStartLine = block.fenceStart + 1;
    const lineInCell = position.line - codeStartLine;

    // Compute character offset
    const lines = code.split('\n');
    let cursor = 0;
    for (let i = 0; i < lineInCell && i < lines.length; i++) {
        cursor += lines[i].length + 1; // +1 for newline
    }
    cursor += position.character;

    return { block, code, cursor };
}

/**
 * Format a Python docstring as VS Code MarkdownString.
 * Handles numpy/google style sections (Args, Returns, Examples, etc.)
 */
function formatDocstring(raw: string | null | undefined): vscode.MarkdownString | undefined {
    if (!raw) return undefined;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    // Split into lines and process
    const lines = raw.split('\n');
    const out: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect section headers (Args:, Returns:, Examples:, Raises:, Note:, etc.)
        if (/^(Args|Arguments|Parameters|Params|Returns?|Yields?|Raises?|Throws|Examples?|Notes?|See Also|References?|Attributes?|Todo|Warnings?|Deprecated):?\s*$/i.test(trimmed)) {
            out.push('', `**${trimmed}**`, '');
            continue;
        }

        // Detect example code blocks (lines starting with >>> or ...)
        if (trimmed.startsWith('>>>') || (inCodeBlock && trimmed.startsWith('...'))) {
            if (!inCodeBlock) {
                out.push('```python');
                inCodeBlock = true;
            }
            out.push(line);
            continue;
        } else if (inCodeBlock) {
            out.push('```');
            inCodeBlock = false;
        }

        // Parameter descriptions: "    name (type): description" or "    name: description"
        const paramMatch = trimmed.match(/^(\w+)\s*(?:\(([^)]+)\))?\s*:\s*(.+)/);
        if (paramMatch && line.startsWith('    ') && !line.startsWith('        ')) {
            const [, name, type, desc] = paramMatch;
            if (type) {
                out.push(`- **${name}** (*${type}*) — ${desc}`);
            } else {
                out.push(`- **${name}** — ${desc}`);
            }
            continue;
        }

        out.push(line);
    }

    if (inCodeBlock) out.push('```');

    md.appendMarkdown(out.join('\n'));
    return md;
}

// ── Completion Provider ───────────────────────────────────────

export class MrmdCompletionProvider implements vscode.CompletionItemProvider {
    private client: MrmdClient | null = null;

    setClient(client: MrmdClient | null): void {
        this.client = client;
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): Promise<vscode.CompletionItem[] | null> {
        if (!this.client?.connected) return null;

        const ctx = cellContext(document, position);
        if (!ctx) return null;

        try {
            const result = await this.client._call('doc.complete', {
                documentPath: document.uri.fsPath,
                code: ctx.code,
                cursor: ctx.cursor,
                language: ctx.block.language,
            });

            if (!result?.matches?.length) return null;

            const replaceRange = this._replaceRange(document, position, result);

            return result.matches.map((m: any, i: number) => {
                const item = new vscode.CompletionItem(
                    m.label,
                    mapCompletionKind(m.kind),
                );

                if (m.insertText) {
                    item.insertText = m.insertText;
                }

                // Detail: shown inline to the right of the label
                if (m.detail) {
                    item.detail = m.detail;
                }

                // Documentation: shown in the side panel when item is focused
                if (m.documentation) {
                    item.documentation = formatDocstring(m.documentation);
                }

                // Sort order from runtime (magics/dunders pushed to bottom)
                if (m.sortText) {
                    item.sortText = m.sortText;
                } else {
                    // Fallback: preserve runtime order
                    item.sortText = String(i).padStart(4, '0');
                }

                if (replaceRange) {
                    item.range = replaceRange;
                }

                return item;
            });
        } catch {
            return null;
        }
    }

    /**
     * Compute the range to replace based on cursorStart/cursorEnd
     * from the MRP response.
     */
    private _replaceRange(
        document: vscode.TextDocument,
        position: vscode.Position,
        result: any,
    ): vscode.Range | undefined {
        if (result.cursorStart == null || result.cursorEnd == null) return undefined;

        const prefixLen = result.cursorEnd - result.cursorStart;
        const startChar = position.character - prefixLen;
        if (startChar < 0) return undefined;

        return new vscode.Range(
            position.line, Math.max(0, startChar),
            position.line, position.character,
        );
    }
}

// ── Hover Provider ────────────────────────────────────────────

export class MrmdHoverProvider implements vscode.HoverProvider {
    private client: MrmdClient | null = null;

    setClient(client: MrmdClient | null): void {
        this.client = client;
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): Promise<vscode.Hover | null> {
        if (!this.client?.connected) return null;

        const ctx = cellContext(document, position);
        if (!ctx) return null;

        try {
            const result = await this.client._call('doc.hover', {
                documentPath: document.uri.fsPath,
                code: ctx.code,
                cursor: ctx.cursor,
                language: ctx.block.language,
            });

            if (!result?.found) return null;

            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.supportHtml = true;

            // Signature / type header — rendered like Pylance/Jupyter
            if (result.signature) {
                // e.g., (variable) def configure(**kwargs: Any) -> None
                const kind = result.type === 'function' || result.type === 'builtin_function_or_method'
                    ? 'function' : result.type === 'method' ? 'method' : result.type === 'type' ? 'class' : 'variable';
                md.appendCodeblock(
                    `(${kind}) ${result.signature}`,
                    'python',
                );
            } else if (result.name && result.type) {
                md.appendCodeblock(
                    `(${result.type}) ${result.name}`,
                    'python',
                );
            }

            // Value preview (for non-callables)
            if (result.value && !result.signature) {
                md.appendMarkdown(`\n**Value:** \`${truncate(result.value, 200)}\`\n`);
            }

            // Docstring — formatted as proper markdown
            if (result.docstring) {
                md.appendMarkdown('\n---\n');
                const docMd = formatDocstring(result.docstring);
                if (docMd) {
                    md.appendMarkdown(docMd.value);
                }
            }

            // Quick check: if nothing was added, skip
            if (!md.value.trim()) return null;

            return new vscode.Hover(md);
        } catch {
            return null;
        }
    }
}

// ── Signature Help Provider ───────────────────────────────────

export class MrmdSignatureHelpProvider implements vscode.SignatureHelpProvider {
    private client: MrmdClient | null = null;

    setClient(client: MrmdClient | null): void {
        this.client = client;
    }

    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.SignatureHelpContext,
    ): Promise<vscode.SignatureHelp | null> {
        if (!this.client?.connected) return null;

        const ctx = cellContext(document, position);
        if (!ctx) return null;

        try {
            const result = await this.client._call('doc.inspect', {
                documentPath: document.uri.fsPath,
                code: ctx.code,
                cursor: ctx.cursor,
                language: ctx.block.language,
                detail: 1,
            });

            if (!result?.found || !result.signature) return null;

            const sigInfo = new vscode.SignatureInformation(result.signature);
            if (result.docstring) {
                sigInfo.documentation = formatDocstring(result.docstring);
            }

            const help = new vscode.SignatureHelp();
            help.signatures = [sigInfo];
            help.activeSignature = 0;
            return help;
        } catch {
            return null;
        }
    }
}

// ── Definition Provider (Ctrl+Click / F12) ────────────────────

export class MrmdDefinitionProvider implements vscode.DefinitionProvider {
    private client: MrmdClient | null = null;

    setClient(client: MrmdClient | null): void {
        this.client = client;
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): Promise<vscode.Definition | null> {
        if (!this.client?.connected) return null;

        const ctx = cellContext(document, position);
        if (!ctx) return null;

        try {
            const result = await this.client._call('doc.inspect', {
                documentPath: document.uri.fsPath,
                code: ctx.code,
                cursor: ctx.cursor,
                language: ctx.block.language,
                detail: 1,
            });

            if (!result?.found || !result.file) return null;

            const uri = vscode.Uri.file(result.file);
            const line = Math.max(0, (result.line || 1) - 1); // VS Code is 0-indexed
            const pos = new vscode.Position(line, 0);

            return new vscode.Location(uri, pos);
        } catch {
            return null;
        }
    }
}

// ── Utilities ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
    if (!s || s.length <= max) return s;
    return s.slice(0, max) + '…';
}

function mapCompletionKind(kind: string | undefined): vscode.CompletionItemKind {
    switch (kind) {
        case 'function': return vscode.CompletionItemKind.Function;
        case 'method': return vscode.CompletionItemKind.Method;
        case 'class': return vscode.CompletionItemKind.Class;
        case 'module': return vscode.CompletionItemKind.Module;
        case 'property':
        case 'field': return vscode.CompletionItemKind.Property;
        case 'keyword': return vscode.CompletionItemKind.Keyword;
        case 'constant': return vscode.CompletionItemKind.Constant;
        case 'variable': return vscode.CompletionItemKind.Variable;
        case 'value': return vscode.CompletionItemKind.Value;
        default: return vscode.CompletionItemKind.Text;
    }
}

// ── Registration ──────────────────────────────────────────────

const MARKDOWN_SELECTOR: vscode.DocumentSelector = { language: 'markdown' };

/**
 * Trigger characters that fire completion inside code cells.
 * '.' for attribute access, '[' for indexing, '(' for call signatures.
 */
const COMPLETION_TRIGGERS = ['.', '[', '(', ' '];
const SIGNATURE_TRIGGERS = ['(', ','];

export interface LanguageProviders {
    completion: MrmdCompletionProvider;
    hover: MrmdHoverProvider;
    signatureHelp: MrmdSignatureHelpProvider;
    definition: MrmdDefinitionProvider;
    setClient(client: MrmdClient | null): void;
}

/**
 * Register all language feature providers.
 * Returns handles to update the client on reconnect.
 */
export function registerLanguageProviders(
    context: vscode.ExtensionContext,
): LanguageProviders {
    const completion = new MrmdCompletionProvider();
    const hover = new MrmdHoverProvider();
    const signatureHelp = new MrmdSignatureHelpProvider();
    const definition = new MrmdDefinitionProvider();

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            MARKDOWN_SELECTOR,
            completion,
            ...COMPLETION_TRIGGERS,
        ),
        vscode.languages.registerHoverProvider(
            MARKDOWN_SELECTOR,
            hover,
        ),
        vscode.languages.registerSignatureHelpProvider(
            MARKDOWN_SELECTOR,
            signatureHelp,
            ...SIGNATURE_TRIGGERS,
        ),
        vscode.languages.registerDefinitionProvider(
            MARKDOWN_SELECTOR,
            definition,
        ),
    );

    return {
        completion,
        hover,
        signatureHelp,
        definition,
        setClient(client: MrmdClient | null) {
            completion.setClient(client);
            hover.setClient(client);
            signatureHelp.setClient(client);
            definition.setClient(client);
        },
    };
}
