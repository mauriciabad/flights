// There is no server anywhere in this app. Routes are prerendered to static
// HTML at build time, then hydrate and do all their fetching in the browser
// against the user's own API keys.
export const prerender = true;
export const trailingSlash = 'always';
