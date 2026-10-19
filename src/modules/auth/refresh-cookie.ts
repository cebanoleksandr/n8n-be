import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'flow_refresh';
const COOKIE_PATH = '/api/auth';

export type CookieSameSite = 'lax' | 'none';

/**
 * Attributes of the refresh cookie, also used to clear it (a browser only
 * removes a cookie set with the same attributes).
 *
 * 'lax': the frontend is on the same site as the API (same domain or
 * subdomains of one domain). 'none': it is on another site, e.g. GitHub Pages
 * with the API on Render; browsers then require Secure, and Partitioned keeps
 * the cookie working where third-party cookies are partitioned or blocked.
 */
export function refreshCookieOptions(
  secure: boolean,
  sameSite: CookieSameSite,
): CookieOptions {
  return sameSite === 'none'
    ? {
        httpOnly: true,
        path: COOKIE_PATH,
        secure: true,
        sameSite: 'none',
        partitioned: true,
      }
    : { httpOnly: true, path: COOKIE_PATH, secure, sameSite: 'lax' };
}
