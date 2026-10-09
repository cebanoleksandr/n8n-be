import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { NodeRegistry } from '../../engine/node-registry.js';
import { connect, node } from '../../engine/test-utils.js';
import type {
  BinaryRef,
  CredentialsProvider,
  Item,
} from '../../engine/types.js';
import { WorkflowRunner } from '../../engine/workflow-runner.js';
import { builtinNodes } from '../index.js';

const runner = new WorkflowRunner(new NodeRegistry(builtinNodes));

function credentialsOf(
  data: Record<string, Record<string, unknown>>,
): CredentialsProvider {
  return {
    get: async (id) => data[id],
    oauth2AccessToken: async () => 'unused',
  };
}

const file: BinaryRef = {
  id: 'f1',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  size: 4,
};
const binaryStore = {
  put: async () => file,
  get: async () => Buffer.from('%PDF'),
};

async function runNode(
  type: string,
  parameters: Record<string, unknown>,
  credentials: Record<string, string>,
  provider: CredentialsProvider,
  input: Item[] = [{ json: {} }],
) {
  return runner.run({
    graph: {
      nodes: [
        node('t', 'core.manualTrigger'),
        node('n', type, parameters, { credentials }),
      ],
      connections: [connect('t', 'n')],
    },
    triggerItems: input,
    credentials: provider,
    binary: binaryStore,
  });
}

describe('integration nodes', () => {
  let server: Server;
  let baseUrl: string;
  const requests: {
    url: string;
    headers: Record<string, unknown>;
    body: string;
  }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        requests.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url?.includes('/botBAD/')) {
          res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
        } else if (req.url?.startsWith('/bot')) {
          res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
        } else if (body.includes('"channel":"#missing"')) {
          res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
        } else {
          res.end(JSON.stringify({ ok: true, ts: '1.2' }));
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  describe('Telegram', () => {
    const provider = () =>
      credentialsOf({
        good: { accessToken: 'TOKEN', baseUrl },
        bad: { accessToken: 'BAD', baseUrl },
      });

    it('sends messages', async () => {
      const r = await runNode(
        'integrations.telegram',
        {
          chatId: '{{ $json.chat }}',
          text: 'Hi {{ $json.name }}',
          parseMode: 'HTML',
        },
        { telegramApi: 'good' },
        provider(),
        [{ json: { chat: 7, name: 'Ann' } }],
      );
      expect(r.status).toBe('success');
      expect(r.nodes[1].output[0][0].json).toEqual({ message_id: 42 });
      const req = requests.at(-1)!;
      expect(req.url).toBe('/botTOKEN/sendMessage');
      expect(JSON.parse(req.body)).toEqual({
        chat_id: 7,
        text: 'Hi Ann',
        parse_mode: 'HTML',
      });
    });

    it('uploads documents from binary data', async () => {
      const r = await runNode(
        'integrations.telegram',
        { operation: 'sendDocument', chatId: '7', caption: 'Report' },
        { telegramApi: 'good' },
        provider(),
        [{ json: {}, binary: { data: file } }],
      );
      expect(r.status).toBe('success');
      const req = requests.at(-1)!;
      expect(req.url).toBe('/botTOKEN/sendDocument');
      expect(String(req.headers['content-type'])).toContain(
        'multipart/form-data',
      );
      expect(req.body).toContain('filename="report.pdf"');
      expect(req.body).toContain('%PDF');
      expect(req.body).toContain('Report');
    });

    it('surfaces API errors', async () => {
      const r = await runNode(
        'integrations.telegram',
        { chatId: '1', text: 'x' },
        { telegramApi: 'bad' },
        provider(),
      );
      expect(r.error?.message).toBe('Telegram error: Unauthorized');
    });
  });

  describe('Slack', () => {
    const provider = () =>
      credentialsOf({ s: { accessToken: 'xoxb-1', baseUrl } });

    it('posts messages with blocks and thread', async () => {
      const r = await runNode(
        'integrations.slack',
        {
          channel: '#general',
          text: 'Deploy done',
          blocks:
            '[{"type":"section","text":{"type":"mrkdwn","text":"*done*"}}]',
          threadTs: '1.0',
        },
        { slackApi: 's' },
        provider(),
      );
      expect(r.status).toBe('success');
      const req = requests.at(-1)!;
      expect(req.url).toBe('/chat.postMessage');
      expect(req.headers.authorization).toBe('Bearer xoxb-1');
      expect(JSON.parse(req.body)).toMatchObject({
        channel: '#general',
        text: 'Deploy done',
        thread_ts: '1.0',
        blocks: [{ type: 'section' }],
      });
    });

    it('surfaces API errors', async () => {
      const r = await runNode(
        'integrations.slack',
        { channel: '#missing', text: 'x' },
        { slackApi: 's' },
        provider(),
      );
      expect(r.error?.message).toBe('Slack error: channel_not_found');
    });
  });

  describe('Send Email', () => {
    let smtp: SMTPServer;
    let port: number;
    const received: {
      from: string;
      to: string[];
      data: string;
      user?: string;
    }[] = [];

    beforeAll(async () => {
      smtp = new SMTPServer({
        authOptional: true,
        disabledCommands: ['STARTTLS'],
        onAuth(auth, _session, callback) {
          if (auth.username === 'mailer' && auth.password === 'pw') {
            callback(null, { user: 'mailer' });
          } else {
            callback(new Error('Invalid login'));
          }
        },
        onData(stream, session, callback) {
          let data = '';
          stream.on('data', (c: Buffer) => (data += c.toString()));
          stream.on('end', () => {
            received.push({
              from: session.envelope.mailFrom
                ? session.envelope.mailFrom.address
                : '',
              to: session.envelope.rcptTo.map((r) => r.address),
              data,
              user: session.user as string | undefined,
            });
            callback();
          });
        },
      });
      await new Promise<void>((resolve) =>
        smtp.listen(0, '127.0.0.1', resolve),
      );
      port = (smtp.server.address() as AddressInfo).port;
    });

    afterAll(() => new Promise<void>((resolve) => smtp.close(() => resolve())));

    it('sends one email per item with attachments', async () => {
      const provider = credentialsOf({
        m: { host: '127.0.0.1', port, user: 'mailer', password: 'pw' },
      });
      const r = await runNode(
        'integrations.sendEmail',
        {
          from: 'bot@example.com',
          to: '{{ $json.email }}',
          subject: 'Hello {{ $json.name }}',
          text: 'See attached',
          attachments: 'data',
        },
        { smtp: 'm' },
        provider,
        [
          {
            json: { email: 'ann@example.com', name: 'Ann' },
            binary: { data: file },
          },
          {
            json: { email: 'bob@example.com', name: 'Bob' },
            binary: { data: file },
          },
        ],
      );
      expect(r.status).toBe('success');
      expect(r.nodes[1].output[0].map((i) => i.json.accepted)).toEqual([
        ['ann@example.com'],
        ['bob@example.com'],
      ]);
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({
        from: 'bot@example.com',
        to: ['ann@example.com'],
        user: 'mailer',
      });
      expect(received[0].data).toContain('Subject: Hello Ann');
      expect(received[0].data).toContain('filename=report.pdf');
    });

    it('reports SMTP authentication failures', async () => {
      const provider = credentialsOf({
        m: { host: '127.0.0.1', port, user: 'mailer', password: 'wrong' },
      });
      const r = await runNode(
        'integrations.sendEmail',
        { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' },
        { smtp: 'm' },
        provider,
      );
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/^SMTP: .*Invalid login/);
    });
  });
});
