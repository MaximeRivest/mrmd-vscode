/**
 * MRP (MRMD Runtime Protocol) Client
 *
 * HTTP/SSE client for communicating with mrmd-python runtime.
 * Implements the MRP v1 protocol for code execution, completion, inspection, etc.
 */

import * as https from 'https';
import * as http from 'http';

// ============================================================================
// Types
// ============================================================================

export interface MrpCapabilities {
    name: string;
    version: string;
    languages: string[];
    features: string[];
}

export interface MrpSession {
    id: string;
    language: string;
    createdAt: string;
}

export interface MrpExecuteRequest {
    code: string;
    session?: string;
    storeHistory?: boolean;
}

export interface MrpCompleteRequest {
    code: string;
    cursor: number;
    session?: string;
}

export interface MrpCompleteResponse {
    matches: string[];
    start: number;
    end: number;
}

export interface MrpInspectRequest {
    code: string;
    cursor: number;
    session?: string;
    detail?: number;
}

export interface MrpInspectResponse {
    found: boolean;
    data?: {
        'text/plain'?: string;
        'text/html'?: string;
    };
}

export interface MrpVariable {
    name: string;
    type: string;
    kind: 'primitive' | 'collection' | 'data' | 'object' | 'callable' | 'class';
    preview?: string;
    shape?: string;
    dtype?: string;
    size?: number;
    length?: number;
    memory_size?: number;
    columns?: string[];
    keys?: string[];
    expandable?: boolean;
    path?: string;
}

export interface MrpVariablesResponse {
    session: string;
    variables: MrpVariable[];
}

export interface MrpDisplayData {
    data: Record<string, string>;
    metadata?: Record<string, unknown>;
}

export interface MrpExecutionResult {
    status: 'ok' | 'error';
    result?: MrpDisplayData;
    error?: {
        ename: string;
        evalue: string;
        traceback: string[];
    };
}

// SSE Event types
export type MrpStreamEvent =
    | { type: 'stdout'; content: string; accumulated: string }
    | { type: 'stderr'; content: string; accumulated: string }
    | { type: 'display'; data: MrpDisplayData }
    | { type: 'result'; data: MrpDisplayData }
    | { type: 'error'; ename: string; evalue: string; traceback: string[] }
    | { type: 'status'; status: string };

export interface MrpStreamCallbacks {
    onStdout?: (content: string, accumulated: string) => void;
    onStderr?: (content: string, accumulated: string) => void;
    onDisplay?: (data: MrpDisplayData) => void;
    onResult?: (data: MrpDisplayData) => void;
    onError?: (ename: string, evalue: string, traceback: string[]) => void;
    onStatus?: (status: string) => void;
    onComplete?: (result: MrpExecutionResult) => void;
}

// ============================================================================
// MRP Client
// ============================================================================

export class MrpClient {
    private baseUrl: string;
    private defaultSession: string;

    constructor(baseUrl: string, defaultSession = 'default') {
        // Ensure baseUrl ends with /mrp/v1
        this.baseUrl = baseUrl.replace(/\/$/, '');
        if (!this.baseUrl.endsWith('/mrp/v1')) {
            this.baseUrl += '/mrp/v1';
        }
        this.defaultSession = defaultSession;
    }

    // ========================================================================
    // Capabilities
    // ========================================================================

    async getCapabilities(): Promise<MrpCapabilities> {
        return this.get('/capabilities');
    }

    async isHealthy(): Promise<boolean> {
        try {
            await this.getCapabilities();
            return true;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Sessions
    // ========================================================================

    async listSessions(): Promise<MrpSession[]> {
        const response = await this.get('/sessions');
        return response.sessions || [];
    }

    async createSession(id?: string): Promise<MrpSession> {
        return this.post('/sessions', { id });
    }

    async getSession(id: string): Promise<MrpSession> {
        return this.get(`/sessions/${encodeURIComponent(id)}`);
    }

    async destroySession(id: string): Promise<void> {
        await this.delete(`/sessions/${encodeURIComponent(id)}`);
    }

    // ========================================================================
    // Execution
    // ========================================================================

    /**
     * Execute code synchronously (waits for completion).
     */
    async execute(request: MrpExecuteRequest): Promise<MrpExecutionResult> {
        return this.post('/execute', {
            code: request.code,
            session: request.session || this.defaultSession,
            storeHistory: request.storeHistory ?? true,
        });
    }

    /**
     * Execute code with streaming output via SSE.
     */
    async executeStream(
        request: MrpExecuteRequest,
        callbacks: MrpStreamCallbacks,
        signal?: AbortSignal
    ): Promise<MrpExecutionResult> {
        const url = `${this.baseUrl}/execute/stream`;
        const body = JSON.stringify({
            code: request.code,
            session: request.session || this.defaultSession,
            storeHistory: request.storeHistory ?? true,
        });

        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const isHttps = urlObj.protocol === 'https:';
            const lib = isHttps ? https : http;

            const req = lib.request(
                {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'text/event-stream',
                    },
                },
                (res) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }

                    let buffer = '';
                    let currentEvent: string | null = null;
                    let result: MrpExecutionResult = { status: 'ok' };

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();

                        // Parse SSE events
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; // Keep incomplete line

                        for (const line of lines) {
                            if (line.startsWith('event: ')) {
                                currentEvent = line.slice(7).trim();
                            } else if (line.startsWith('data: ') && currentEvent) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    this.handleStreamEvent(currentEvent, data, callbacks, result);
                                } catch (e) {
                                    // Ignore parse errors
                                }
                                currentEvent = null;
                            }
                        }
                    });

                    res.on('end', () => {
                        callbacks.onComplete?.(result);
                        resolve(result);
                    });

                    res.on('error', reject);
                }
            );

            req.on('error', reject);

            // Handle abort
            if (signal) {
                signal.addEventListener('abort', () => {
                    req.destroy();
                    reject(new Error('Aborted'));
                });
            }

            req.write(body);
            req.end();
        });
    }

    private handleStreamEvent(
        event: string,
        data: any,
        callbacks: MrpStreamCallbacks,
        result: MrpExecutionResult
    ): void {
        switch (event) {
            case 'stdout':
                callbacks.onStdout?.(data.content, data.accumulated);
                break;
            case 'stderr':
                callbacks.onStderr?.(data.content, data.accumulated);
                break;
            case 'display':
                callbacks.onDisplay?.(data);
                break;
            case 'result':
                result.result = data;
                callbacks.onResult?.(data);
                break;
            case 'error':
                result.status = 'error';
                result.error = {
                    ename: data.ename,
                    evalue: data.evalue,
                    traceback: data.traceback || [],
                };
                callbacks.onError?.(data.ename, data.evalue, data.traceback || []);
                break;
            case 'status':
                callbacks.onStatus?.(data.status);
                break;
        }
    }

    /**
     * Interrupt running execution.
     */
    async interrupt(session?: string): Promise<void> {
        await this.post('/interrupt', {
            session: session || this.defaultSession,
        });
    }

    // ========================================================================
    // Completion
    // ========================================================================

    async complete(request: MrpCompleteRequest): Promise<MrpCompleteResponse> {
        return this.post('/complete', {
            code: request.code,
            cursor: request.cursor,
            session: request.session || this.defaultSession,
        });
    }

    // ========================================================================
    // Inspection
    // ========================================================================

    async inspect(request: MrpInspectRequest): Promise<MrpInspectResponse> {
        return this.post('/inspect', {
            code: request.code,
            cursor: request.cursor,
            session: request.session || this.defaultSession,
            detail: request.detail ?? 0,
        });
    }

    async hover(request: MrpInspectRequest): Promise<MrpInspectResponse> {
        return this.post('/hover', {
            code: request.code,
            cursor: request.cursor,
            session: request.session || this.defaultSession,
        });
    }

    // ========================================================================
    // Variables
    // ========================================================================

    async getVariables(session?: string): Promise<MrpVariablesResponse> {
        return this.post('/variables', {
            session: session || this.defaultSession,
        });
    }

    async getVariable(name: string, session?: string): Promise<MrpVariable> {
        return this.post(`/variables/${encodeURIComponent(name)}`, {
            session: session || this.defaultSession,
        });
    }

    async inspectObject(path: string, session?: string): Promise<{ children: MrpVariable[] }> {
        return this.post('/inspect_object', {
            path,
            session: session || this.defaultSession,
        });
    }

    // ========================================================================
    // Code Analysis
    // ========================================================================

    async isComplete(code: string, session?: string): Promise<{ status: 'complete' | 'incomplete' | 'invalid' }> {
        return this.post('/is_complete', {
            code,
            session: session || this.defaultSession,
        });
    }

    async format(code: string): Promise<{ formatted: string }> {
        return this.post('/format', { code });
    }

    // ========================================================================
    // HTTP Helpers
    // ========================================================================

    private async get<T>(path: string): Promise<T> {
        const response = await fetch(`${this.baseUrl}${path}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }

    private async delete(path: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
    }
}
