<template>
    <v-container fluid class="fill-height d-flex align-center justify-center login-page">
        <v-card class="login-card text-center pa-8" elevation="0" max-width="400">
            <!-- Logo -->
            <div class="mb-6">
                <img src="/LL-logo-full-wht.svg" alt="Lovelace" class="login-logo" />
            </div>

            <!-- App Title -->
            <h1 class="app-title mb-8">{{ appName }}</h1>

            <!-- Error alert -->
            <v-alert v-if="authError" type="error" density="compact" variant="tonal" class="mb-4">
                {{ authError }}
            </v-alert>

            <!-- Server unavailable alert -->
            <v-alert
                v-if="serverStatus === 'unavailable'"
                type="warning"
                density="compact"
                variant="tonal"
                class="mb-4"
            >
                <v-icon icon="mdi-server-off" size="small" class="mr-1"></v-icon>
                Server is unavailable
            </v-alert>

            <!-- Login Button -->
            <v-btn
                :color="isLoginDisabled ? 'grey' : undefined"
                :text="loginButtonText"
                :disabled="isLoginDisabled"
                :loading="serverStatus === 'checking'"
                @click="redirectToLogin"
                variant="flat"
                size="large"
                block
                class="login-btn"
            >
            </v-btn>

            <!-- Version -->
            <p class="version-text mt-6">v{{ uiVersion }}</p>
        </v-card>
    </v-container>
</template>

<script lang="ts" setup>
    import { useServerStatus } from '~/composables/useServerStatus';

    const uiVersion = ref('(unknown)');
    const authError = ref<string | null>(null);
    const route = useRoute();

    // Get app configuration
    const { appName } = useAppInfo();

    // Get server status
    const { serverStatus, startChecking, stopChecking } = useServerStatus();

    // Computed properties
    const isLoginDisabled = computed(
        () => serverStatus.value === 'unavailable' || serverStatus.value === 'checking'
    );

    const loginButtonText = computed(() => {
        if (serverStatus.value === 'checking') {
            return 'CHECKING SERVER...';
        }
        if (serverStatus.value === 'unavailable') {
            return 'SERVER UNAVAILABLE';
        }
        return 'LOGIN';
    });

    onMounted(() => {
        // Start checking server status
        startChecking();

        // Check for error in query params
        if (route.query.error) {
            authError.value = route.query.error as string;
        }

        const versionString = useRuntimeConfig().public.versionString as string;
        if (versionString) {
            uiVersion.value = versionString;
        }

        const index = versionString.indexOf('release_');
        if (index !== -1) {
            uiVersion.value = versionString.slice(index + 8);
        }
    });

    onUnmounted(() => {
        // Stop checking when leaving the login page
        stopChecking();
    });

    async function redirectToLogin() {
        const audience = useRuntimeConfig().public.auth0Audience;
        const id = useRuntimeConfig().public.auth0ClientId;
        const url = useRuntimeConfig().public.auth0IssuerBaseUrl;

        // The audience param is optional. Tenants that proxy through the
        // Broadchurch Portal Gateway don't need a user-issued access token
        // for any specific resource server (the portal mints its own M2M
        // tokens), so they leave `auth0Audience` empty and get an opaque
        // access token from Auth0. Tenants that still call APIs directly
        // with user JWTs set NUXT_PUBLIC_AUTH0_AUDIENCE to that API's
        // audience and Auth0 returns a signed JWT keyed to it.
        //
        // Sending `&audience=` (empty value) makes Auth0 reject the request
        // with `Service not found:` — hence the guard.
        const redirectUrl = `${useRequestURL().origin}/a0callback`;
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: id,
            redirect_uri: redirectUrl,
            scope: 'openid profile email',
            prompt: 'login',
        });
        if (audience) {
            params.set('audience', audience);
        }
        const loginUrl = `${url}/authorize?${params.toString()}`;

        await navigateTo(loginUrl, {
            external: true,
            redirectCode: 302,
        });
    }
</script>

<style scoped>
    .login-page {
        background: var(--lv-black) !important;
        min-height: 100vh;
    }

    .login-card {
        background: transparent !important;
    }

    .login-logo {
        height: 2rem;
        width: auto;
    }

    .app-title {
        font-family: var(--font-headline);
        font-size: 2rem;
        font-weight: 400;
        color: var(--lv-white);
        margin: 0;
    }

    .login-btn {
        font-family: var(--font-mono);
        text-transform: uppercase;
        font-weight: 500;
        letter-spacing: 0.05em;
        background-color: var(--lv-green) !important;
        color: var(--lv-black) !important;
    }

    .login-btn:disabled {
        background-color: var(--lv-silver) !important;
        color: var(--lv-black) !important;
    }

    .version-text {
        color: var(--lv-silver);
        font-family: var(--font-mono);
        font-size: 0.75rem;
        margin: 0;
    }
</style>
