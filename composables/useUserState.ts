import { ref } from 'vue';

import * as Iron from 'iron-webcrypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface Auth0User {
    iss: string;
    sub: string;
    aud: string;
    exp: number;
    iat: number;
    name: string;
    given_name: string;
    family_name: string;
    gender: string;
    birthdate: string;
    email: string;
    email_verified: boolean;
    picture: string;
}

interface UserCookie {
    user: Auth0User;
    scope: string;
    expires_in: number;
    token_type: string;
    permissions: string;
    access_token?: string;
}

const REQUIRED_ACCESS = 'read:all';

let _cookie = ref<string | undefined>(undefined);
let _accessToken = ref<string | undefined>(undefined);
let _crypto = globalThis.crypto;
let _picture = ref<string | undefined>(undefined);
const _permissions = ref('');
let _userId = ref<string | undefined>(undefined);
let _userName = ref<string | undefined>(undefined);

export function useUserState() {
    async function clearUser() {
        console.log('clearUser');
        // Clear local composable state.
        _cookie.value = undefined;
        _accessToken.value = undefined;
        _permissions.value = '';
        _picture.value = undefined;
        _userId.value = undefined;
        _userName.value = undefined;

        // Clear the auth0 cookie.
        const cookieName = useRuntimeConfig().public.auth0CookieName;
        const cookie = useCookie(cookieName);
        cookie.value = null;

        const id = useRuntimeConfig().public.auth0ClientId;
        const url = useRuntimeConfig().public.auth0IssuerBaseUrl;
        const redirectUrl = `${useRequestURL().origin}/login`;
        const logoutUrl = `${url}/v2/logout?client_id=${id}&returnTo=${redirectUrl}`;

        await navigateTo(logoutUrl, {
            external: true,
            redirectCode: 302,
        });
    }

    // This is called when we initiate a new login flow with Auth0. `code` is the
    // code we get back from the auth0 /authorize endpoint, which we can then use to
    // get our access and ID tokens.
    async function setUserFromAuth0(code: string) {
        console.log('setUserFromAuth0', code);
        const clientSecret = useRuntimeConfig().public.auth0ClientSecret;
        const cookieSecret = useRuntimeConfig().public.cookieSecret;
        const id = useRuntimeConfig().public.auth0ClientId;

        const redirectUrl = `${useRequestURL().origin}/a0callback`;
        const url = useRuntimeConfig().public.auth0IssuerBaseUrl;

        const body = JSON.stringify({
            grant_type: 'authorization_code',
            client_id: id,
            client_secret: clientSecret,
            code: code,
            redirect_uri: redirectUrl,
        }).toString();

        const tokenResponse = await $fetch<any>(`${url}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-type': 'application/json' },
            body,
        });

        const { access_token, id_token, scope, expires_in, token_type } = tokenResponse;

        // Validate token formats
        if (!id_token || typeof id_token !== 'string') {
            throw new Error(`Invalid id_token type: ${typeof id_token}, value: ${id_token}`);
        }
        if (!access_token || typeof access_token !== 'string') {
            throw new Error(
                `Invalid access_token type: ${typeof access_token}, value: ${access_token}`
            );
        }

        const idTokenParts = id_token.split('.');
        const accessTokenParts = access_token.split('.');

        if (idTokenParts.length !== 3) {
            throw new Error(
                `Invalid id_token format. Expected 3 parts, got ${idTokenParts.length}. Token length: ${id_token.length}`
            );
        }
        // Note: Access token might be opaque if no audience is specified
        const isAccessTokenJWT = accessTokenParts.length === 3;

        // At this point we're at Step 3 of this flow:
        // https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/call-your-api-using-the-authorization-code-flow

        // And the "decoded and extracted" bit of dealing with ID tokens, mentioned in step 2.
        const JWKS = createRemoteJWKSet(new URL(`${url}/.well-known/jwks.json`));

        let user: Auth0User;
        let access: { permissions?: string[] } | null = null;

        try {
            const { payload } = await jwtVerify<Auth0User>(id_token, JWKS, {
                issuer: `${url}/`,
            });
            user = payload;
        } catch (error) {
            throw error;
        }

        // Check if access token is a JWT or opaque token
        const isJWT = access_token.split('.').length === 3;

        if (isJWT) {
            try {
                const { payload } = await jwtVerify<{ permissions?: string[] }>(
                    access_token,
                    JWKS,
                    {
                        issuer: `${url}/`,
                    }
                );
                access = payload;
            } catch (error) {
                throw error;
            }
        }

        // Now create a new sealed cookie using our own secret and pass that around.
        // The server will determine permissions based on email domain, so we just
        // set a default here. The actual permissions will be validated server-side.
        const permissions = REQUIRED_ACCESS;

        const newCookie: UserCookie = {
            user,
            scope,
            expires_in,
            token_type,
            permissions: permissions,
            access_token: access_token,
        };

        const sealedCookie = await Iron.seal(_crypto, newCookie, cookieSecret, Iron.defaults);

        _cookie.value = sealedCookie;
        _accessToken.value = access_token;
        _permissions.value = permissions;
        _picture.value = user.picture;
        _userId.value = user.sub;
        _userName.value = user.name;

        const cookieName = useRuntimeConfig().public.auth0CookieName;
        const cookie = useCookie(cookieName, {
            default: () => '',
            sameSite: 'lax',
        });
        cookie.value = sealedCookie;

        return tokenResponse;
    }

    // This is called when our plugin is called at startup time. Looks for an existing
    // sealed cookie in the incoming request, which happens when the user is already
    // logged in. Just grab the user details from the cookie and store it for later use
    // with QS calls.
    async function setUserFromCookie() {
        const cookieSecret = useRuntimeConfig().public.cookieSecret;
        const cookieName = useRuntimeConfig().public.auth0CookieName;
        const cookie = useCookie(cookieName);

        if (!cookie.value) {
            return true;
        }
        try {
            const unsealed = (await Iron.unseal(
                _crypto,
                cookie.value,
                cookieSecret,
                Iron.defaults
            )) as UserCookie;
            _permissions.value = unsealed.permissions;
            _picture.value = unsealed.user.picture;
            _userId.value = unsealed.user.sub;
            _userName.value = unsealed.user.name;
            _cookie.value = cookie.value;
            _accessToken.value = unsealed.access_token;
        } catch (e) {
            console.error(`Failed to unseal cookie: ${e}`);
            return false;
        }

        return true;
    }

    // Manually assign the userName. Only for internal dev purposes.
    function setUserFromString(userName: string) {
        console.log('setUserFromString', userName);
        _userId.value = userName;
        _userName.value = userName;
        _permissions.value = REQUIRED_ACCESS;
        _picture.value = undefined;

        // Generate a simple development token for localhost
        // This could be a simple base64 encoded string or a mock JWT
        const devToken = btoa(
            JSON.stringify({
                sub: userName,
                name: userName,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 86400, // 24 hours
                scope: REQUIRED_ACCESS,
            })
        );
        _accessToken.value = `dev-token-${devToken}`;

        // Also set a cookie for consistency
        const cookieName = useRuntimeConfig().public.auth0CookieName;
        const cookie = useCookie(cookieName);
        cookie.value = `dev-cookie-${userName}`;
        _cookie.value = cookie.value;
    }

    function userIsPermitted() {
        const hasAccess = _permissions.value?.includes(REQUIRED_ACCESS);
        return hasAccess;
    }

    return {
        clearUser,
        setUserFromAuth0,
        setUserFromCookie,
        setUserFromString,
        userIsPermitted,
        userCookie: readonly(_cookie),
        accessToken: readonly(_accessToken),
        userId: readonly(_userId),
        userName: readonly(_userName),
        userPicture: readonly(_picture),
    };
}
