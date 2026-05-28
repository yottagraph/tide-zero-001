import { ref, reactive } from 'vue';

type ServerStatus = 'checking' | 'available' | 'unavailable' | 'not-configured';

interface ServerInfo {
    type: string;
    name: string;
    configKey: string;
    status: ServerStatus;
    address?: string;
    lastChecked?: Date;
    error?: string;
}

const server = reactive<ServerInfo>({
    type: 'query',
    name: 'Query API',
    configKey: 'queryServerAddress',
    status: 'checking',
});

let checkInterval: NodeJS.Timeout | null = null;

export function useServerStatus() {
    const config = useRuntimeConfig();

    async function checkServer() {
        try {
            const serverAddress = config.public[server.configKey] as string;
            const gatewayUrl = config.public.gatewayUrl as string;
            const tenantOrgId = config.public.tenantOrgId as string;
            const qsApiKey = config.public.qsApiKey as string;

            // Prefer the Portal Gateway QS proxy when available — direct
            // calls from a tenant's browser to the Query Server fail on
            // CORS and have no usable bearer token on the login page.
            // Mirrors the proxy-first logic in plugins/elemental-client.client.ts.
            const useProxy = !!(gatewayUrl && tenantOrgId && qsApiKey);

            let baseURL = '';
            const headers: Record<string, string> = {};

            if (useProxy) {
                baseURL = `${gatewayUrl}/api/qs/${tenantOrgId}`;
                headers['X-Api-Key'] = qsApiKey;
            } else if (serverAddress) {
                baseURL = serverAddress.startsWith('http')
                    ? serverAddress
                    : `https://${serverAddress}`;
            } else {
                console.log('[ServerStatus] No query server address configured');
                server.status = 'not-configured';
                server.address = undefined;
                return;
            }

            server.address = baseURL;
            console.log('[ServerStatus] Checking query server at:', baseURL);

            await $fetch('/status', {
                baseURL,
                headers,
                timeout: 5000,
            });

            server.status = 'available';
            server.error = undefined;
            server.lastChecked = new Date();
        } catch (error) {
            console.warn('[ServerStatus] Query server check failed:', error);
            server.status = 'unavailable';
            server.error = error instanceof Error ? error.message : 'Unknown error';
            server.lastChecked = new Date();
        }
    }

    function startChecking() {
        checkServer();
        if (!checkInterval) {
            checkInterval = setInterval(checkServer, 30000);
        }
    }

    function stopChecking() {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
    }

    function getConfiguredServers() {
        return server.status !== 'not-configured' ? [server] : [];
    }

    const overallStatus = computed(() => server.status);

    return {
        servers: readonly(reactive({ query: server })),
        getConfiguredServers,
        serverStatus: overallStatus,
        checkServerStatus: checkServer,
        startChecking,
        stopChecking,
    };
}
