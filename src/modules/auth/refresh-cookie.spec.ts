import { describe, expect, it } from 'vitest';
import { refreshCookieOptions } from './refresh-cookie.js';

describe('refreshCookieOptions', () => {
  it('is Lax and Secure only in production for a same-site frontend', () => {
    expect(refreshCookieOptions(false, 'lax')).toEqual({
      httpOnly: true,
      path: '/api/auth',
      secure: false,
      sameSite: 'lax',
    });
    expect(refreshCookieOptions(true, 'lax').secure).toBe(true);
  });

  it('is always Secure and Partitioned for a frontend on another site', () => {
    expect(refreshCookieOptions(false, 'none')).toEqual({
      httpOnly: true,
      path: '/api/auth',
      secure: true,
      sameSite: 'none',
      partitioned: true,
    });
  });
});
