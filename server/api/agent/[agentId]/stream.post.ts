/**
 * Server-side agent streaming route — calls Agent Engine directly.
 *
 * This replaces the portal proxy for the streaming data path. The flow:
 *   1. Get a short-lived token from the portal's /authorize endpoint
 *   2. Call Agent Engine's :streamQuery directly (single hop)
 *   3. Parse the native response and re-emit as clean SSE to the browser
 *
 * The portal is only in the auth path (one-time token fetch), not in the
 * streaming data path. Tokens are cached for their TTL.
 */

interface TokenCache {
    token: string;
    engineUrl: string;
    sessionId: string | null;
    expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

function getCacheKey(orgId: string, agentId: string): string {
    return `${orgId}:${agentId}`;
}

async function getAgentToken(
    gatewayUrl: string,
    orgId: string,
    agentId: string,
    userId: string,
    forceRefresh: boolean = false
): Promise<TokenCache> {
    const key = getCacheKey(orgId, agentId);

    if (!forceRefresh) {
        const cached = tokenCache.get(key);
        // Use cached token if it has at least 2 minutes left.
        // The buffer ensures we never start a stream with a token
        // that could expire mid-response.
        if (cached && cached.expiresAt > Date.now() + 120_000) {
            return cached;
        }
    }

    const authUrl = `${gatewayUrl}/api/agents/${orgId}/${agentId}/authorize`;
    const res = await $fetch<any>(authUrl, {
        method: 'POST',
        body: { user_id: userId, create_session: false },
    });

    const entry: TokenCache = {
        token: res.token,
        engineUrl: res.engine_url,
        sessionId: null,
        expiresAt: Date.now() + (res.expires_in || 900) * 1000,
    };

    tokenCache.set(key, entry);
    return entry;
}

function invalidateToken(orgId: string, agentId: string): void {
    tokenCache.delete(getCacheKey(orgId, agentId));
}

async function createSession(engineUrl: string, token: string, userId: string): Promise<string> {
    const res = await $fetch<any>(`${engineUrl}:query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: { class_method: 'async_create_session', input: { user_id: userId } },
    });
    const sessionId = res.output?.id;
    if (!sessionId) throw new Error('Failed to create agent session');
    return sessionId;
}

export default defineEventHandler(async (event) => {
    const agentId = getRouterParam(event, 'agentId');
    if (!agentId) {
        throw createError({ statusCode: 400, statusMessage: 'agentId is required' });
    }

    const { public: config } = useRuntimeConfig();
    const gatewayUrl = (config as any).gatewayUrl;
    const orgId = (config as any).tenantOrgId;

    if (!gatewayUrl || !orgId) {
        throw createError({ statusCode: 503, statusMessage: 'Gateway not configured' });
    }

    const body = await readBody<Record<string, any>>(event);
    const message = body?.message;
    if (!message) {
        throw createError({ statusCode: 400, statusMessage: 'message is required' });
    }

    const userId = body.user_id || 'default-user';

    // Get token (cached or fresh). On 401/403 from Agent Engine, we
    // invalidate the cache so the next request gets a fresh token.
    let auth: TokenCache;

    async function acquireToken(force: boolean = false): Promise<TokenCache> {
        try {
            return await getAgentToken(gatewayUrl, orgId, agentId, userId, force);
        } catch (e: any) {
            const portalMsg = e.data?.statusMessage || e.message || '';
            const isMintFailure =
                portalMsg.includes('could not mint token') ||
                portalMsg.includes('impersonation failed');
            throw createError({
                statusCode: isMintFailure ? 502 : e.statusCode || 502,
                statusMessage: isMintFailure
                    ? portalMsg
                    : `Failed to authorize with portal: ${portalMsg}`,
            });
        }
    }

    auth = await acquireToken();

    // Create or reuse session
    let sessionId = body.session_id || null;
    if (!sessionId) {
        try {
            sessionId = await createSession(auth.engineUrl, auth.token, userId);
        } catch (e: any) {
            throw createError({
                statusCode: 502,
                statusMessage: `Failed to create agent session: ${e.message}`,
            });
        }
    }

    // Set up SSE headers
    setHeader(event, 'Content-Type', 'text/event-stream');
    setHeader(event, 'Cache-Control', 'no-cache');
    setHeader(event, 'Connection', 'keep-alive');

    const encoder = new TextEncoder();
    let aborted = false;

    const stream = new ReadableStream({
        async start(controller) {
            const emit = (type: string, data: any) => {
                if (aborted) return;
                try {
                    controller.enqueue(
                        encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
                    );
                } catch {
                    /* client disconnected */
                }
            };

            event.node.req.on('close', () => {
                aborted = true;
            });

            try {
                const streamUrl = `${auth.engineUrl}:streamQuery`;
                const res = await fetch(streamUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${auth.token}`,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(5 * 60 * 1000),
                    body: JSON.stringify({
                        class_method: 'async_stream_query',
                        input: { user_id: userId, session_id: sessionId, message },
                    }),
                });

                if (!res.ok) {
                    if (res.status === 401 || res.status === 403) {
                        invalidateToken(orgId, agentId);
                        const errText = await res.text().catch(() => '');
                        emit('error', {
                            code: 'PERMISSION_DENIED',
                            message:
                                "Agent access denied — the project's service account " +
                                'may lack required IAM permissions. ' +
                                `(Agent Engine returned ${res.status}${errText ? ': ' + errText.slice(0, 200) : ''})`,
                        });
                        controller.close();
                        return;
                    }
                    const errText = await res.text().catch(() => 'Unknown error');
                    emit('error', { message: `Agent Engine returned ${res.status}: ${errText}` });
                    controller.close();
                    return;
                }

                if (!res.body) {
                    emit('error', { message: 'No response body from Agent Engine' });
                    controller.close();
                    return;
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalText = '';

                while (!aborted) {
                    let done: boolean;
                    let value: Uint8Array | undefined;
                    try {
                        ({ done, value } = await reader.read());
                    } catch (readErr: any) {
                        const msg =
                            readErr?.name === 'TimeoutError'
                                ? 'Agent Engine stream timed out'
                                : `Stream read failed: ${readErr?.message || 'unknown error'}`;
                        emit('error', { message: msg });
                        break;
                    }
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const { objects, remainder } = extractJsonValues(buffer);
                    buffer = remainder;

                    for (const raw of objects) {
                        const evt = parseAdkEvent(raw);
                        const classified = classifyAdkEvent(evt);
                        if (!classified) continue;

                        emit(classified.type, classified.data);
                        if (classified.type === 'text') {
                            finalText = classified.data.text;
                        }
                    }
                }

                // Flush remaining buffer
                buffer += decoder.decode();
                if (buffer.trim()) {
                    const { objects } = extractJsonValues(buffer);
                    for (const raw of objects) {
                        const evt = parseAdkEvent(raw);
                        const classified = classifyAdkEvent(evt);
                        if (!classified) continue;
                        emit(classified.type, classified.data);
                        if (classified.type === 'text') finalText = classified.data.text;
                    }
                }

                emit('done', { session_id: sessionId, text: finalText });
            } catch (e: any) {
                const msg =
                    e?.name === 'TimeoutError'
                        ? 'Agent Engine request timed out'
                        : e.message || 'Agent Engine request failed';
                emit('error', { message: msg });
            }

            if (!aborted) {
                try {
                    controller.close();
                } catch {
                    /* already closed */
                }
            }
        },
    });

    return sendStream(event, stream);
});

// ---------------------------------------------------------------------------
// Agent Engine response parsing
// ---------------------------------------------------------------------------

function extractJsonValues(buffer: string): { objects: any[]; remainder: string } {
    const objects: any[] = [];
    let i = 0;
    while (i < buffer.length) {
        while (i < buffer.length && /[\s,[\]]/.test(buffer[i])) i++;
        if (i >= buffer.length) break;
        if (buffer[i] === '{') {
            const end = findMatchingBrace(buffer, i);
            if (end < 0) break;
            try {
                objects.push(JSON.parse(buffer.slice(i, end + 1)));
            } catch {
                /* skip */
            }
            i = end + 1;
        } else if (buffer[i] === '"') {
            const end = findStringEnd(buffer, i);
            if (end < 0) break;
            try {
                objects.push(JSON.parse(buffer.slice(i, end + 1)));
            } catch {
                /* skip */
            }
            i = end + 1;
        } else {
            break;
        }
    }
    return { objects, remainder: buffer.slice(i) };
}

function findMatchingBrace(buf: string, start: number): number {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < buf.length; j++) {
        if (esc) {
            esc = false;
            continue;
        }
        if (buf[j] === '\\' && inStr) {
            esc = true;
            continue;
        }
        if (buf[j] === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr) continue;
        if (buf[j] === '{') depth++;
        if (buf[j] === '}') {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

function findStringEnd(buf: string, start: number): number {
    let esc = false;
    for (let j = start + 1; j < buf.length; j++) {
        if (esc) {
            esc = false;
            continue;
        }
        if (buf[j] === '\\') {
            esc = true;
            continue;
        }
        if (buf[j] === '"') return j;
    }
    return -1;
}

function parseAdkEvent(raw: any): any {
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }
    return raw;
}

function classifyAdkEvent(evt: any): { type: string; data: any } | null {
    if (!evt || typeof evt !== 'object') return null;
    const parts: any[] = evt.content?.parts || [];
    if (parts.length === 0) return null;
    for (const part of parts) {
        if (part.functionCall || part.function_call) {
            const fc = part.functionCall || part.function_call;
            return { type: 'function_call', data: { name: fc.name, args: fc.args || {} } };
        }
        if (part.functionResponse || part.function_response) {
            const fr = part.functionResponse || part.function_response;
            return { type: 'function_response', data: { name: fr.name, response: fr.response } };
        }
        if (part.text) {
            return { type: 'text', data: { text: part.text } };
        }
    }
    return null;
}
