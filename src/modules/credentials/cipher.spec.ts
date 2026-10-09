import { randomBytes } from 'node:crypto';
import { Cipher } from './cipher.js';

describe('Cipher', () => {
  const cipher = new Cipher(randomBytes(32).toString('base64'));

  it('round-trips data and uses a fresh IV each time', () => {
    const data = { token: 'secret', nested: { n: 1 } };
    const a = cipher.encrypt(data);
    const b = cipher.encrypt(data);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(cipher.decrypt(a)).toEqual(data);
  });

  it('rejects tampered payloads and foreign keys', () => {
    const payload = cipher.encrypt({ token: 'secret' });
    const [v, iv, tag, ct] = payload.split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() =>
      cipher.decrypt([v, iv, tag, flipped.toString('base64')].join(':')),
    ).toThrow();

    const other = new Cipher(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(payload)).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new Cipher(randomBytes(16).toString('base64'))).toThrow();
  });
});
