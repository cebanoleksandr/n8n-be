import { startMockServer } from './mock-server.js';
import { createTestApp, link, testNode, type TestApp } from './test-app.js';

describe('OAuth2 credentials (e2e)', () => {
  let t: TestApp;
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  beforeAll(async () => {
    t = await createTestApp();
    mock = await startMockServer();
  });

  afterAll(async () => {
    await mock.close();
    await t.close();
  });

  const createCredential = async (data: Record<string, unknown>) =>
    (
      await t
        .api()
        .post('/api/credentials')
        .send({ name: 'OAuth', type: 'oAuth2Api', data })
        .expect(201)
    ).body as { id: string; oauth2: { connected: boolean } };

  const workflowUsing = (credentialId: string) =>
    t.createWorkflow('OAuth call', {
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode(
          'http',
          'core.httpRequest',
          { url: `${mock.url}/headers`, authentication: 'oAuth2Api' },
          { credentials: { oAuth2Api: credentialId } },
        ),
      ],
      connections: [link('t', 'http')],
    });

  const authHeader = async (workflowId: string) => {
    const run = await t
      .api()
      .post(`/api/workflows/${workflowId}/run?wait=true`)
      .expect(200);
    if (run.body.status !== 'success')
      return `error: ${run.body.error.message}`;
    return run.body.steps[1].output[0][0].json.authorization as string;
  };

  it('connects with authorization code + PKCE and refreshes tokens', async () => {
    const credential = await createCredential({
      grantType: 'authorizationCode',
      authUrl: 'https://provider.example/authorize',
      accessTokenUrl: `${mock.url}/oauth/token`,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      scope: 'read write',
      authQueryParameters: 'access_type=offline',
    });
    expect(credential.oauth2).toEqual({ connected: false, expiresAt: null });
    const workflow = await workflowUsing(credential.id);
    expect(await authHeader(workflow)).toContain('is not connected yet');

    const { body } = await t
      .api()
      .get(`/api/credentials/${credential.id}/oauth2/auth-url`)
      .expect(200);
    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe(
      'https://provider.example/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      scope: 'read write',
      code_challenge_method: 'S256',
      access_type: 'offline',
      redirect_uri: body.redirectUri,
    });
    expect(body.redirectUri).toMatch(/\/api\/oauth2\/callback$/);
    const state = url.searchParams.get('state')!;

    // The provider redirects the browser back with a code.
    const callback = await t
      .anon()
      .get(`/api/oauth2/callback?code=good-code&state=${state}`)
      .expect(200);
    expect(callback.text).toContain('Connected');
    expect(callback.headers['content-type']).toContain('text/html');
    const exchange = mock.tokenRequests.at(-1)!;
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
    expect(exchange.code_verifier.length).toBeGreaterThan(40);

    // State is single use.
    await t
      .anon()
      .get(`/api/oauth2/callback?code=good-code&state=${state}`)
      .expect(400);

    const connected = await t
      .api()
      .get(`/api/credentials/${credential.id}`)
      .expect(200);
    expect(connected.body.oauth2.connected).toBe(true);
    expect(JSON.stringify(connected.body)).not.toContain('access-1');

    // access-1 expires immediately, so the run refreshes to access-2.
    expect(await authHeader(workflow)).toBe('Bearer access-2');
    expect(mock.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    // Still valid: no new token request.
    const requests = mock.tokenRequests.length;
    expect(await authHeader(workflow)).toBe('Bearer access-2');
    expect(mock.tokenRequests.length).toBe(requests);

    // Changing the client drops the stored tokens.
    await t
      .api()
      .put(`/api/credentials/${credential.id}`)
      .send({ data: { clientId: 'client-2' } })
      .expect(200);
    const reset = await t
      .api()
      .get(`/api/credentials/${credential.id}`)
      .expect(200);
    expect(reset.body.oauth2.connected).toBe(false);
  });

  it('rejects users trying to set tokens themselves', async () => {
    const credential = await createCredential({
      grantType: 'clientCredentials',
      accessTokenUrl: `${mock.url}/oauth/token`,
      clientId: 'c',
      clientSecret: 's',
      oauthTokenData: { accessToken: 'forged' },
    });
    expect(credential.oauth2.connected).toBe(false);
  });

  it('gets client credentials tokens on demand', async () => {
    const credential = await createCredential({
      grantType: 'clientCredentials',
      accessTokenUrl: `${mock.url}/oauth/token`,
      clientId: 'svc',
      clientSecret: 'svc-secret',
      clientAuth: 'header',
    });
    const workflow = await workflowUsing(credential.id);
    expect(await authHeader(workflow)).toBe('Bearer cc-token');
    const request = mock.tokenRequests.at(-1)!;
    expect(request.grant_type).toBe('client_credentials');
    expect(request.client_secret).toBeUndefined();
  });

  it('reports provider errors on the callback page', async () => {
    const credential = await createCredential({
      grantType: 'authorizationCode',
      authUrl: 'https://provider.example/authorize',
      accessTokenUrl: `${mock.url}/oauth/token`,
      clientId: 'c',
      clientSecret: 's',
    });
    const { body } = await t
      .api()
      .get(`/api/credentials/${credential.id}/oauth2/auth-url`)
      .expect(200);
    const state = new URL(body.url).searchParams.get('state')!;
    const res = await t
      .anon()
      .get(`/api/oauth2/callback?code=wrong&state=${state}`)
      .expect(400);
    expect(res.text).toContain('invalid_grant');
    expect(res.text).not.toContain('<script>alert');
  });
});
