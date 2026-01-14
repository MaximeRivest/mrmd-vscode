/**
 * Completion Provider for mrmd
 *
 * Provides code completions inside Python code blocks
 * using MRP protocol to query mrmd-python.
 */

import * as vscode from 'vscode';
import { MrpClient } from './mrp-client';
import { MrmdCodeLensProvider, getCodeBlockAtPosition } from './codelens-provider';

export class MrmdCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private getClient: () => MrpClient | null,
        private codeLensProvider: MrmdCodeLensProvider
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | null> {
        // Only provide completions in markdown files
        if (document.languageId !== 'markdown') {
            return null;
        }

        // Check if we're inside a Python code block
        const block = getCodeBlockAtPosition(document, position, this.codeLensProvider);
        if (!block) {
            return null;
        }

        // Only complete in Python blocks
        const lang = block.language.toLowerCase();
        if (!['python', 'py', 'python3'].includes(lang)) {
            return null;
        }

        const client = this.getClient();
        if (!client) {
            return null;
        }

        // Calculate cursor position within the code block
        const lineInBlock = position.line - block.startLine;
        const codeLines = block.code.split('\n');

        // Build code up to cursor position
        let cursorOffset = 0;
        for (let i = 0; i < lineInBlock && i < codeLines.length; i++) {
            cursorOffset += codeLines[i].length + 1; // +1 for newline
        }
        cursorOffset += position.character;

        // Get the current line text for context
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character);

        try {
            const response = await client.complete({
                code: block.code,
                cursor: cursorOffset,
            });

            if (!response.matches || response.matches.length === 0) {
                return null;
            }

            // Convert matches to completion items
            return response.matches.map((match, index) => {
                const item = new vscode.CompletionItem(match, this.getCompletionKind(match));
                item.sortText = String(index).padStart(5, '0');

                // Calculate range to replace
                const start = response.start;
                const end = response.end;

                // Map back to document positions
                const replaceStart = new vscode.Position(
                    position.line,
                    position.character - (cursorOffset - start)
                );
                const replaceEnd = new vscode.Position(
                    position.line,
                    position.character - (cursorOffset - end)
                );

                item.range = new vscode.Range(replaceStart, replaceEnd);

                return item;
            });
        } catch (err) {
            console.error('Completion error:', err);
            return null;
        }
    }

    private getCompletionKind(match: string): vscode.CompletionItemKind {
        // Heuristic-based kind detection
        if (match.startsWith('__') && match.endsWith('__')) {
            return vscode.CompletionItemKind.Property; // Dunder methods
        }
        if (match.startsWith('_')) {
            return vscode.CompletionItemKind.Field; // Private
        }
        if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
            return vscode.CompletionItemKind.Class; // Likely a class
        }
        return vscode.CompletionItemKind.Variable;
    }

    dispose(): void {}
}
