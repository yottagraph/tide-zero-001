import * as Iron from '@hapi/iron';

import type { H3Event, EventHandlerRequest } from 'h3';

export async function unsealCookie(event: H3Event<EventHandlerRequest>) {
    const config = useRuntimeConfig(event);

    // If there's not an Auth0 client secret, we're not using Auth0.
    if (!config.public.auth0ClientSecret || config.public.auth0ClientSecret.length === 0) {
        return {
            user: {
                sub: config.public.userName,
            },
        };
    }

    const cookieName = config.public.auth0CookieName;
    const cookieSecret = config.public.cookieSecret;

    const cookie = getCookie(event, cookieName) || undefined;
    // If we don't have a cookie we're DOA.
    if (!cookie) {
        console.log(`ERROR: No ${cookieName} cookie found.`);
        return undefined;
    }

    // now we need to crack open the cookie with our key.
    const unsealed = await Iron.unseal(cookie, cookieSecret, Iron.defaults);

    return unsealed;
}
