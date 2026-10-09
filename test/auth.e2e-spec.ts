import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import type { Response } from 'supertest';
import { DataSource } from 'typeorm';
import { User } from '../src/modules/auth/user.entity.js';
import { WorkspaceMember } from '../src/modules/workspaces/workspace-member.entity.js';
import { Workspace } from '../src/modules/workspaces/workspace.entity.js';
import { createTestApp, TEST_PASSWORD, type TestApp } from './test-app.js';

/** "flow_refresh=<value>" from Set-Cookie, for sending back as Cookie. */
function refreshCookie(res: Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('flow_refresh='));
  if (!cookie) throw new Error('No refresh cookie');
  return cookie.split(';')[0];
}

describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  describe('access control', () => {
    it.each([
      ['get', '/api/workflows'],
      ['post', '/api/workflows'],
      ['get', '/api/executions'],
      ['get', '/api/credentials'],
      ['get', `/api/binary-data/${randomUUID()}`],
      ['get', '/api/node-types'],
      ['get', '/api/workspace/members'],
      ['get', '/api/auth/me'],
    ] as const)('rejects %s %s without a token', async (method, url) => {
      await t.anon()[method](url).expect(401);
    });

    it('rejects invalid tokens', async () => {
      await t.as('not-a-jwt').get('/api/workflows').expect(401);
      const forged = t.owner.token.slice(0, -4) + 'AAAA';
      await t.as(forged).get('/api/workflows').expect(401);
    });

    it('keeps health, setup status and webhooks public', async () => {
      await t.anon().get('/api/health').expect(200);
      await t.anon().get('/api/auth/setup').expect(200);
      await t.anon().post(`/webhook/nothing-${randomUUID()}`).expect(404);
    });
  });

  describe('roles', () => {
    it('lets viewers read but not write', async () => {
      const viewer = await t.createUser('viewer');
      await t.as(viewer.token).get('/api/workflows').expect(200);
      const res = await t
        .as(viewer.token)
        .post('/api/workflows')
        .send({ name: 'x' })
        .expect(403);
      expect(res.body.message).toBe('Requires the editor role');
      await t.as(viewer.token).get('/api/credentials').expect(200);
      await t.as(viewer.token).post('/api/credentials').send({}).expect(403);
    });

    it('lets editors build and run workflows but not manage members', async () => {
      const editor = await t.createUser('editor');
      const created = await t
        .as(editor.token)
        .post('/api/workflows')
        .send({ name: 'Editor workflow' })
        .expect(201);
      await t
        .as(editor.token)
        .delete(`/api/workflows/${created.body.id}`)
        .expect(204);
      await t
        .as(editor.token)
        .post('/api/workspace/invitations')
        .send({ email: 'x@test.local', role: 'viewer' })
        .expect(403);
    });

    it('lets admins manage editors but not admins', async () => {
      const admin = await t.createUser('admin');
      const editor = await t.createUser('editor');
      const otherAdmin = await t.createUser('admin');

      await t
        .as(admin.token)
        .patch(`/api/workspace/members/${editor.id}`)
        .send({ role: 'viewer' })
        .expect(200);
      await t
        .as(admin.token)
        .patch(`/api/workspace/members/${editor.id}`)
        .send({ role: 'admin' })
        .expect(403);
      await t
        .as(admin.token)
        .delete(`/api/workspace/members/${otherAdmin.id}`)
        .expect(403);
      await t
        .as(admin.token)
        .post('/api/workspace/invitations')
        .send({ email: 'boss@test.local', role: 'owner' })
        .expect(403);
    });
  });

  describe('sessions', () => {
    it('logs in, rotates refresh tokens and detects reuse', async () => {
      const user = await t.createUser('viewer');
      await t
        .anon()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'wrong' })
        .expect(401);

      const login = await t
        .anon()
        .post('/api/auth/login')
        .send({ email: user.email.toUpperCase(), password: TEST_PASSWORD })
        .expect(200);
      expect(login.body).toMatchObject({
        expiresIn: 900,
        user: { email: user.email },
      });
      const setCookie = (login.headers['set-cookie'] as unknown as string[])[0];
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Path=\/api\/auth/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      await t.as(login.body.accessToken).get('/api/workflows').expect(200);

      const first = refreshCookie(login);
      const refreshed = await t
        .anon()
        .post('/api/auth/refresh')
        .set('Cookie', first)
        .expect(200);
      const second = refreshCookie(refreshed);
      expect(second).not.toBe(first);
      await t.as(refreshed.body.accessToken).get('/api/auth/me').expect(200);

      // Replaying the rotated token revokes the whole family, including `second`.
      await t.anon().post('/api/auth/refresh').set('Cookie', first).expect(401);
      await t
        .anon()
        .post('/api/auth/refresh')
        .set('Cookie', second)
        .expect(401);
    });

    it('logs out', async () => {
      const user = await t.createUser('viewer');
      const login = await t
        .anon()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const cookie = refreshCookie(login);
      await t.anon().post('/api/auth/logout').set('Cookie', cookie).expect(204);
      await t
        .anon()
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });

    it('signs out other sessions when the password changes', async () => {
      const user = await t.createUser('viewer');
      const login = await t
        .anon()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      await t
        .as(login.body.accessToken)
        .post('/api/auth/password')
        .send({
          currentPassword: TEST_PASSWORD,
          newPassword: 'brand-new-password',
        })
        .expect(200);
      await t
        .anon()
        .post('/api/auth/refresh')
        .set('Cookie', refreshCookie(login))
        .expect(401);
      await t
        .anon()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'brand-new-password' })
        .expect(200);
    });

    it('rate-limits login attempts per email', async () => {
      const email = `nobody-${randomUUID()}@test.local`;
      for (let i = 0; i < 5; i++) {
        await t
          .anon()
          .post('/api/auth/login')
          .send({ email, password: 'x' })
          .expect(401);
      }
      const res = await t
        .anon()
        .post('/api/auth/login')
        .send({ email, password: 'x' })
        .expect(429);
      expect(res.body.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('invitations', () => {
    it('lets an invited person create an account and join', async () => {
      const email = `new-${randomUUID()}@test.local`;
      const invite = await t
        .api()
        .post('/api/workspace/invitations')
        .send({ email, role: 'editor' })
        .expect(201);
      expect(invite.body).toMatchObject({
        email,
        role: 'editor',
        token: expect.any(String),
      });

      const info = await t
        .anon()
        .get(`/api/auth/invitations/${invite.body.token}`)
        .expect(200);
      expect(info.body).toMatchObject({
        email,
        role: 'editor',
        hasAccount: false,
      });

      const accepted = await t
        .anon()
        .post(`/api/auth/invitations/${invite.body.token}/accept`)
        .send({ name: 'New Person', password: 'new-person-pass' })
        .expect(201);
      const me = await t
        .as(accepted.body.accessToken)
        .get('/api/auth/me')
        .expect(200);
      expect(me.body.workspaces).toEqual([
        expect.objectContaining({ role: 'editor' }),
      ]);

      // Single use.
      await t
        .anon()
        .post(`/api/auth/invitations/${invite.body.token}/accept`)
        .send({ name: 'Again', password: 'new-person-pass' })
        .expect(404);
      const members = await t.api().get('/api/workspace/members').expect(200);
      expect(members.body.map((m: { email: string }) => m.email)).toContain(
        email,
      );
    });

    it('can be revoked', async () => {
      const invite = await t
        .api()
        .post('/api/workspace/invitations')
        .send({ email: `revoke-${randomUUID()}@test.local`, role: 'viewer' })
        .expect(201);
      await t
        .api()
        .delete(`/api/workspace/invitations/${invite.body.id}`)
        .expect(204);
      await t
        .anon()
        .get(`/api/auth/invitations/${invite.body.token}`)
        .expect(404);
    });
  });

  describe('workspace isolation', () => {
    it('scopes data to the selected workspace', async () => {
      const db = t.app.get(DataSource);
      const other = await db
        .getRepository(Workspace)
        .save({ name: `Other ${randomUUID()}` });
      const user = await t.createUser('owner');
      await db
        .getRepository(WorkspaceMember)
        .insert({ workspaceId: other.id, userId: user.id, role: 'owner' });

      // Two memberships: the workspace must be chosen explicitly.
      const ambiguous = await t
        .as(user.token)
        .get('/api/workflows')
        .expect(400);
      expect(ambiguous.body.message).toContain('x-workspace-id');

      const inOther = await t
        .as(user.token)
        .post('/api/workflows')
        .set('X-Workspace-Id', other.id)
        .send({ name: 'Secret' })
        .expect(201);

      // Invisible from the default workspace, and its members cannot reach it.
      await t.api().get(`/api/workflows/${inOther.body.id}`).expect(404);
      await t
        .api()
        .get('/api/workflows')
        .set('X-Workspace-Id', other.id)
        .expect(403);
      await t
        .as(user.token)
        .get(`/api/workflows/${inOther.body.id}`)
        .set('X-Workspace-Id', other.id)
        .expect(200);

      // Last owner protection.
      const res = await t
        .as(user.token)
        .patch(`/api/workspace/members/${user.id}`)
        .set('X-Workspace-Id', other.id)
        .send({ role: 'editor' })
        .expect(400);
      expect(res.body.message).toContain('at least one owner');

      await db.getRepository(Workspace).delete(other.id);
    });

    it('authenticates WebSocket connections and subscriptions', async () => {
      const refused = io(`${t.url}/executions`, { transports: ['websocket'] });
      const error = await new Promise<Error>((resolve) =>
        refused.once('connect_error', resolve),
      );
      expect(error.message).toBe('Unauthorized');
      refused.close();

      const db = t.app.get(DataSource);
      const other = await db
        .getRepository(Workspace)
        .save({ name: `Ws ${randomUUID()}` });
      const outsider = await t.createUser('viewer');
      await db.getRepository(WorkspaceMember).delete({ userId: outsider.id });
      await db
        .getRepository(WorkspaceMember)
        .insert({ workspaceId: other.id, userId: outsider.id, role: 'owner' });
      const workflowId = await t.createWorkflow('Private');

      const socket = io(`${t.url}/executions`, {
        transports: ['websocket'],
        auth: { token: outsider.token },
      });
      await new Promise<void>((resolve) =>
        socket.once('connect', () => resolve()),
      );
      const ack = await socket.emitWithAck('subscribe', { workflowId });
      expect(ack).toEqual({ ok: false, error: 'Not found' });
      socket.close();
      await db.getRepository(Workspace).delete(other.id);
    });
  });

  // Last: it empties the users table to exercise first-run setup.
  describe('first-run setup', () => {
    it('creates the first owner once', async () => {
      const db = t.app.get(DataSource);
      await db.query('TRUNCATE users CASCADE');
      expect((await t.anon().get('/api/auth/setup').expect(200)).body).toEqual({
        needsSetup: true,
      });

      const setup = await t
        .anon()
        .post('/api/auth/setup')
        .send({
          email: 'Owner@Example.com',
          name: 'Owner',
          password: 'owner-password',
        })
        .expect(201);
      expect(setup.body.user.email).toBe('owner@example.com');
      const me = await t
        .as(setup.body.accessToken)
        .get('/api/auth/me')
        .expect(200);
      expect(me.body.workspaces).toEqual([
        expect.objectContaining({ role: 'owner' }),
      ]);

      await t
        .anon()
        .post('/api/auth/setup')
        .send({
          email: 'second@example.com',
          name: 'Second',
          password: 'second-password',
        })
        .expect(409);
      expect(await db.getRepository(User).count()).toBe(1);
    });
  });
});
