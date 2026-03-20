/**
 * Orchestrator Client
 *
 * Connects to the mrmd daemon (auto-starts if needed).
 * The daemon is bundled inside the extension — no global install required.
 *
 * Replaces the old Python orchestrator (uvx mrmd) with the JS daemon.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';

// ── Socket path (must match daemon.js) ────────────────────────

function getSocketPath(): string {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\mrmd-daemon';
    }
    return path.join(os.tmpdir(), `mrmd-daemon-${os.userInfo().uid}.sock`);
}

function getPidPath(): string {
    return path.join(os.homedir(), '.mrmd', 'daemon.pid');
}

function isDaemonRunning(): boolean {
    const pidPath = getPidPath();
    if (!fs.existsSync(pidPath)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
        process.kill(data.pid, 0); // throws if not alive
        return true;
    } catch {
        return false;
    }
}

// ── JSON-RPC over Unix socket ─────────────────────────────────

class DaemonConnection {
    private socket: net.Socket | null = null;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private buffer = '';
    private eventEmitter: vscode.EventEmitter<{ event: string; data: any }>;

    constructor() {
        this.eventEmitter = new vscode.EventEmitter();
    }

    get onEvent() {
        return this.eventEmitter.event;
    }

    async connect(socketPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection(socketPath);
            this.socket.on('connect', () => resolve());
            this.socket.once('error', reject);

            this.socket.on('data', (data) => {
                this.buffer += data.toString();
                let newline: number;
                while ((newline = this.buffer.indexOf('\n')) !== -1) {
                    const line = this.buffer.slice(0, newline).trim();
                    this.buffer = this.buffer.slice(newline + 1);
                    if (line) this.handleMessage(line);
                }
            });

            this.socket.on('close', () => {
                for (const [, { reject }] of this.pending) {
                    reject(new Error('Daemon disconnected'));
                }
                this.pending.clear();
            });
        });
    }

    private handleMessage(raw: string): void {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.event) {
            this.eventEmitter.fire({ event: msg.event, data: msg.data });
            return;
        }

        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);

        if (msg.error) {
            pending.reject(new Error(msg.error));
        } else {
            pending.resolve(msg.result);
        }
    }

    call(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Not connected'));
                return;
            }
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.socket.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }

    disconnect(): void {
        this.socket?.destroy();
        this.socket = null;
    }

    dispose(): void {
        this.disconnect();
        this.eventEmitter.dispose();
    }
}

// ── Public types ──────────────────────────────────────────────

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

export interface RuntimeInfo {
    name: string;
    language: string;
    pid: number;
    port: number;
    url: string;
    cwd: string;
    alive: boolean;
    consumers: string[];
}

// ── Orchestrator Client ───────────────────────────────────────

export class OrchestratorClient implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private connection: DaemonConnection | null = null;
    private _urls: OrchestratorUrls | null = null;
    private _onStatusChange = new vscode.EventEmitter<OrchestratorStatus>();
    private _runtimes = new Map<string, RuntimeInfo>(); // language -> runtime

    readonly onStatusChange = this._onStatusChange.event;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    get urls(): OrchestratorUrls | null {
        return this._urls;
    }

    get isRunning(): boolean {
        return this.connection !== null;
    }

    get syncUrl(): string | null {
        return this._urls?.sync || null;
    }

    get runtimeUrl(): string | null {
        return this._urls?.runtime || null;
    }

    /**
     * Start mrmd services. Connects to daemon (auto-starts if needed)
     * and starts a runtime for the workspace.
     */
    async start(options: {
        workspaceFolder?: string;
        language?: string;
    } = {}): Promise<OrchestratorUrls> {
        if (this.isRunning) {
            return this._urls!;
        }

        const cwd = options.workspaceFolder
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || process.cwd();
        const language = options.language || 'bash'; // Start with bash, add python later

        // 1. Ensure daemon is running and connect
        await this.ensureDaemon();

        // 2. Start a runtime
        this.outputChannel.appendLine(`[mrmd] Starting ${language} runtime in ${cwd}...`);
        const rt = await this.startRuntime(language, cwd);

        this._urls = {
            orchestrator: '',
            runtime: rt.url,
            sync: '', // TODO: sync service integration
        };

        this._onStatusChange.fire(await this.getStatus());
        this.outputChannel.appendLine(`[mrmd] Runtime ready: ${rt.url} (pid ${rt.pid})`);

        return this._urls;
    }

    /**
     * Connect to daemon, starting it if needed.
     * The daemon binary is bundled inside the extension.
     */
    private async ensureDaemon(): Promise<void> {
        const socketPath = getSocketPath();

        if (!isDaemonRunning()) {
            this.outputChannel.appendLine('[mrmd] Starting daemon...');
            await this.spawnDaemon();

            // Wait for socket
            const start = Date.now();
            while (Date.now() - start < 5000) {
                if (fs.existsSync(socketPath)) break;
                await new Promise(r => setTimeout(r, 100));
            }
        }

        // Connect
        this.connection = new DaemonConnection();
        await this.connection.connect(socketPath);
        this.outputChannel.appendLine('[mrmd] Connected to daemon');

        // Forward daemon events
        this.connection.onEvent(({ event, data }) => {
            this.outputChannel.appendLine(`[mrmd:event] ${event}: ${JSON.stringify(data).slice(0, 200)}`);
        });
    }

    /**
     * Spawn the daemon process from the bundled mrmd package.
     */
    private async spawnDaemon(): Promise<void> {
        // The daemon entry point is bundled inside the extension's node_modules
        // or alongside the extension. Find it relative to this file.
        const daemonScript = this.findDaemonScript();

        if (!daemonScript) {
            throw new Error('Could not find mrmd daemon script. Is mrmd installed as a dependency?');
        }

        this.outputChannel.appendLine(`[mrmd] Daemon script: ${daemonScript}`);

        const proc = cp.spawn(process.execPath, [daemonScript, 'daemon', 'start', '--foreground'], {
            stdio: 'ignore',
            detached: true,
            env: { ...process.env },
        });
        proc.unref();

        this.outputChannel.appendLine(`[mrmd] Daemon spawned (pid ${proc.pid})`);

        // Wait for it to be ready
        await new Promise(r => setTimeout(r, 800));
    }

    /**
     * Find the daemon script. Looks in:
     * 1. Extension's node_modules/mrmd/bin/mrmd.js
     * 2. Sibling package ../mrmd/bin/mrmd.js (dev mode)
     */
    private findDaemonScript(): string | null {
        const candidates = [
            // Installed as dependency of extension
            path.resolve(__dirname, '..', 'node_modules', 'mrmd', 'bin', 'mrmd.js'),
            // Dev mode: sibling in monorepo
            path.resolve(__dirname, '..', '..', 'mrmd', 'bin', 'mrmd.js'),
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    /**
     * Start a runtime for a language.
     */
    async startRuntime(language: string, cwd: string): Promise<RuntimeInfo> {
        if (!this.connection) throw new Error('Not connected to daemon');

        const name = `rt:${language}:${Date.now()}`;
        const rt = await this.connection.call('runtime.start', { name, language, cwd }) as RuntimeInfo;
        this._runtimes.set(language, rt);
        return rt;
    }

    /**
     * Get the runtime for a language (start if needed).
     */
    async getRuntimeUrl(language: string, cwd?: string): Promise<string> {
        const existing = this._runtimes.get(language);
        if (existing?.alive) return existing.url;

        const workDir = cwd
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || process.cwd();
        const rt = await this.startRuntime(language, workDir);
        return rt.url;
    }

    /**
     * Stop services (disconnect from daemon — daemon stays running).
     */
    async stop(): Promise<void> {
        this.connection?.disconnect();
        this.connection = null;
        this._urls = null;
        this._runtimes.clear();
        this._onStatusChange.fire({ running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] });
    }

    /**
     * Get current status.
     */
    async getStatus(): Promise<OrchestratorStatus> {
        if (!this.connection) {
            return { running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] };
        }

        try {
            const status = await this.connection.call('daemon.status') as any;
            const runtimes = await this.connection.call('runtime.list', {}) as RuntimeInfo[];
            return {
                running: true,
                urls: this._urls || { orchestrator: '', runtime: '', sync: '' },
                sessions: runtimes.map(r => r.name),
            };
        } catch {
            return { running: false, urls: { orchestrator: '', runtime: '', sync: '' }, sessions: [] };
        }
    }

    /**
     * Restart runtime for a language.
     */
    async restartRuntime(language?: string): Promise<void> {
        const lang = language || 'bash';
        const rt = this._runtimes.get(lang);
        if (rt && this.connection) {
            const restarted = await this.connection.call('runtime.restart', { name: rt.name }) as RuntimeInfo;
            this._runtimes.set(lang, restarted);
            this._urls = {
                ...this._urls!,
                runtime: restarted.url,
            };
        }
    }

    /**
     * Create a session (stub for monitor mode compatibility).
     */
    async createSession(docName: string): Promise<any> {
        // TODO: implement when monitor/sync are integrated into daemon
        return { doc: docName };
    }

    dispose(): void {
        this.connection?.dispose();
        this._onStatusChange.dispose();
    }
}
