/**
 * Orchestrator Client
 *
 * Manages the full mrmd stack lifecycle:
 * - mrmd-sync (Yjs server)
 * - mrmd-monitor (execution handler)
 * - mrmd-python (runtime)
 *
 * Can operate in two modes:
 * - Full orchestrator mode: Start `mrmd` which manages everything
 * - Direct mode: Connect to existing mrmd-python runtime (legacy)
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';

export interface OrchestratorUrls {
    orchestrator: string;
    runtime: string;
    sync: string;
    ai?: string;
}

export interface OrchestratorStatus {
    running: boolean;
    urls: OrchestratorUrls;
    sessions: string[];
}

export interface SessionInfo {
    doc: string;
    monitor_process: string;
    runtime_process: string;
    runtime_url: string;
    dedicated_runtime: boolean;
    venv: string;
}

interface RuntimeInfo {
    id: string;
    status: string;
    pid: number;
    port: number;
    url: string;
}

export class OrchestratorClient implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private _urls: OrchestratorUrls | null = null;
    private _onStatusChange = new vscode.EventEmitter<OrchestratorStatus>();
    private _runtimeId = 'shared';
    private _orchestratorProcess: cp.ChildProcess | null = null;
    private _useFullOrchestrator = true;

    readonly onStatusChange = this._onStatusChange.event;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('mrmd');
    }

    get urls(): OrchestratorUrls | null {
        return this._urls;
    }

    get isRunning(): boolean {
        return this._urls !== null;
    }

    get syncUrl(): string | null {
        return this._urls?.sync || null;
    }

    get runtimeUrl(): string | null {
        return this._urls?.runtime || null;
    }

    /**
     * Start the mrmd stack.
     *
     * This starts the full orchestrator which manages:
     * - mrmd-sync (Yjs server for collaboration)
     * - mrmd-monitor (execution via Y.Map)
     * - mrmd-python (Python runtime)
     */
    async start(options: {
        workspaceFolder?: string;
        port?: number;
        session?: string;
    } = {}): Promise<OrchestratorUrls> {
        if (this.isRunning) {
            return this._urls!;
        }

        const config = vscode.workspace.getConfiguration('mrmd');
        const directRuntimeUrl = config.get<string>('runtimeUrl');
        const configuredSyncUrl = config.get<string>('syncUrl');
        const orchestratorUrl = config.get<string>('orchestratorUrl') || 'http://localhost:41580';

        // If user specified a direct runtime URL, use legacy direct mode
        if (directRuntimeUrl && !configuredSyncUrl) {
            this._useFullOrchestrator = false;
            return this.startDirectMode(directRuntimeUrl);
        }

        // Full orchestrator mode
        this._useFullOrchestrator = true;
        this.outputChannel.appendLine('Starting full mrmd orchestrator...');

        // Check if orchestrator is already running
        const existing = await this.checkOrchestrator(orchestratorUrl);
        if (existing) {
            this.outputChannel.appendLine(`Found running orchestrator at ${orchestratorUrl}`);
            this._urls = existing;
            this._onStatusChange.fire(await this.getStatus());
            return this._urls;
        }

        // Start orchestrator
        await this.startOrchestrator(options.workspaceFolder);

        // Wait for it to be ready
        await this.waitForOrchestrator(orchestratorUrl, 15000);

        // Get URLs from orchestrator
        const urls = await this.checkOrchestrator(orchestratorUrl);
        if (!urls) {
            throw new Error('Failed to start mrmd orchestrator');
        }

        this._urls = urls;
        this._onStatusChange.fire(await this.getStatus());
        this.outputChannel.appendLine(`mrmd orchestrator ready:`);
        this.outputChannel.appendLine(`  Orchestrator: ${urls.orchestrator}`);
        this.outputChannel.appendLine(`  Sync: ${urls.sync}`);
        this.outputChannel.appendLine(`  Runtime: ${urls.runtime}`);

        return this._urls;
    }

    /**
     * Start in direct mode (legacy - just mrmd-python, no sync/monitor)
     */
    private async startDirectMode(runtimeUrl: string): Promise<OrchestratorUrls> {
        this.outputChannel.appendLine(`Using direct runtime URL: ${runtimeUrl}`);
        this._urls = {
            orchestrator: '',
            runtime: runtimeUrl,
            sync: '',
        };
        this._onStatusChange.fire(await this.getStatus());
        return this._urls;
    }

    /**
     * Check if orchestrator is running and get its URLs.
     */
    private async checkOrchestrator(baseUrl: string): Promise<OrchestratorUrls | null> {
        try {
            const response = await fetch(`${baseUrl}/api/status`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                const status = await response.json() as {
                    sync_url: string;
                    runtime_url: string;
                    ai_url?: string;
                };
                return {
                    orchestrator: baseUrl,
                    sync: status.sync_url || 'ws://localhost:41444',
                    runtime: status.runtime_url || 'http://localhost:41765/mrp/v1',
                    ai: status.ai_url,
                };
            }
        } catch {
            // Not running
        }
        return null;
    }

    /**
     * Start the mrmd orchestrator process.
     */
    private async startOrchestrator(cwd?: string): Promise<void> {
        const workDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

        this.outputChannel.appendLine(`Starting mrmd in ${workDir}...`);

        // Use uvx to run mrmd
        const env = this.getEnv();

        return new Promise((resolve, reject) => {
            // Start mrmd as background process
            this._orchestratorProcess = cp.spawn('uvx', ['mrmd'], {
                cwd: workDir,
                env,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            this._orchestratorProcess.stdout?.on('data', (data) => {
                this.outputChannel.appendLine(`[mrmd] ${data.toString().trim()}`);
            });

            this._orchestratorProcess.stderr?.on('data', (data) => {
                this.outputChannel.appendLine(`[mrmd stderr] ${data.toString().trim()}`);
            });

            this._orchestratorProcess.on('error', (err) => {
                this.outputChannel.appendLine(`Failed to start mrmd: ${err.message}`);
                reject(err);
            });

            // Don't wait for process to exit - it runs as server
            // Resolve immediately and let waitForOrchestrator handle readiness
            setTimeout(resolve, 500);
        });
    }

    /**
     * Wait for orchestrator to be ready.
     */
    private async waitForOrchestrator(url: string, timeout: number): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const result = await this.checkOrchestrator(url);
            if (result) {
                return;
            }
            await this.sleep(500);
        }
        throw new Error(`Timeout waiting for orchestrator at ${url}`);
    }

    /**
     * Create a session for a document.
     *
     * This ensures a monitor is watching for executions on this document.
     */
    async createSession(docName: string, options: {
        dedicated?: boolean;
        venv?: string;
    } = {}): Promise<SessionInfo> {
        if (!this._urls?.orchestrator) {
            throw new Error('Orchestrator not running');
        }

        const body: Record<string, unknown> = {
            doc: docName,
            python: options.dedicated ? 'dedicated' : 'shared',
        };

        if (options.venv) {
            body.venv = options.venv;
        }

        const response = await fetch(`${this._urls.orchestrator}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create session: ${text}`);
        }

        return response.json() as Promise<SessionInfo>;
    }

    /**
     * Get session info for a document.
     */
    async getSession(docName: string): Promise<SessionInfo | null> {
        if (!this._urls?.orchestrator) {
            return null;
        }

        try {
            const response = await fetch(`${this._urls.orchestrator}/api/sessions/${encodeURIComponent(docName)}`);
            if (response.ok) {
                return response.json() as Promise<SessionInfo>;
            }
        } catch {
            // Session not found
        }
        return null;
    }

    /**
     * Stop the orchestrator.
     */
    async stop(): Promise<void> {
        if (this._orchestratorProcess) {
            this.outputChannel.appendLine('Stopping mrmd orchestrator...');
            this._orchestratorProcess.kill('SIGTERM');
            this._orchestratorProcess = null;
        }

        this._urls = null;
        this._onStatusChange.fire({ running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] });
    }

    /**
     * Get current status.
     */
    async getStatus(): Promise<OrchestratorStatus> {
        if (!this._urls) {
            return { running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] };
        }

        if (this._useFullOrchestrator && this._urls.orchestrator) {
            try {
                const response = await fetch(`${this._urls.orchestrator}/api/status`, {
                    signal: AbortSignal.timeout(2000),
                });
                if (response.ok) {
                    const data = await response.json() as { sessions?: string[] };
                    return {
                        running: true,
                        urls: this._urls,
                        sessions: data.sessions || [],
                    };
                }
            } catch {
                // Fall through
            }
        }

        // Direct mode or orchestrator not responding - check runtime directly
        try {
            const response = await fetch(`${this._urls.runtime}/capabilities`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                return { running: true, urls: this._urls, sessions: ['default'] };
            }
        } catch {
            this._urls = null;
        }

        return { running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] };
    }

    /**
     * Restart the runtime (clear Python session).
     */
    async restartRuntime(session?: string): Promise<void> {
        if (this._urls?.orchestrator) {
            // Use orchestrator API to restart
            const response = await fetch(`${this._urls.orchestrator}/api/runtime/restart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: session || 'shared' }),
            });
            if (!response.ok) {
                throw new Error('Failed to restart runtime');
            }
        } else {
            // Direct mode - kill and restart
            await this.stop();
            await this.start();
        }
    }

    /**
     * Get environment with proper PATH for uvx.
     */
    private getEnv(): NodeJS.ProcessEnv {
        const env = { ...process.env };
        const home = process.env.HOME || '';
        const localBin = `${home}/.local/bin`;
        const cargoBin = `${home}/.cargo/bin`;
        env.PATH = `${localBin}:${cargoBin}:${env.PATH || ''}`;
        return env;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    dispose(): void {
        // Note: We don't stop the orchestrator on dispose
        // It's meant to persist for other sessions
        this.outputChannel.dispose();
        this._onStatusChange.dispose();
    }
}
