import type { CredentialTypeDescription } from '../engine/types.js';

export interface HttpHeaderAuth {
  name: string;
  value: string;
}

export interface HttpBasicAuth {
  user: string;
  password: string;
}

export interface HttpBearerAuth {
  token: string;
}

export interface TelegramApi {
  accessToken: string;
  baseUrl?: string;
}

export interface SlackApi {
  accessToken: string;
  baseUrl?: string;
}

export interface PostgresCredential {
  host: string;
  port?: number | string;
  database: string;
  user: string;
  password?: string;
  ssl?: 'disable' | 'require' | 'verify';
}

export interface SmtpCredential {
  host: string;
  port?: number | string;
  secure?: boolean;
  user?: string;
  password?: string;
}

export const OAUTH2_TYPE = 'oAuth2Api';

export const builtinCredentialTypes: CredentialTypeDescription[] = [
  {
    type: 'telegramApi',
    displayName: 'Telegram Bot',
    properties: [
      {
        name: 'accessToken',
        displayName: 'Bot Token',
        type: 'string',
        default: '',
        required: true,
        secret: true,
        description: 'From @BotFather',
      },
      {
        name: 'baseUrl',
        displayName: 'API Base URL',
        type: 'string',
        default: 'https://api.telegram.org',
        description: 'Change only for a self-hosted Bot API server',
      },
    ],
  },
  {
    type: 'slackApi',
    displayName: 'Slack Bot',
    properties: [
      {
        name: 'accessToken',
        displayName: 'Bot User OAuth Token',
        type: 'string',
        default: '',
        required: true,
        secret: true,
        placeholder: 'xoxb-...',
      },
      {
        name: 'baseUrl',
        displayName: 'API Base URL',
        type: 'string',
        default: 'https://slack.com/api',
      },
    ],
  },
  {
    type: 'postgres',
    displayName: 'Postgres',
    properties: [
      {
        name: 'host',
        displayName: 'Host',
        type: 'string',
        default: '',
        required: true,
      },
      { name: 'port', displayName: 'Port', type: 'number', default: 5432 },
      {
        name: 'database',
        displayName: 'Database',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'user',
        displayName: 'User',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'password',
        displayName: 'Password',
        type: 'string',
        default: '',
        secret: true,
      },
      {
        name: 'ssl',
        displayName: 'SSL',
        type: 'options',
        default: 'disable',
        options: [
          { name: 'Disable', value: 'disable' },
          { name: 'Require (no certificate check)', value: 'require' },
          { name: 'Verify certificate', value: 'verify' },
        ],
      },
    ],
  },
  {
    type: 'smtp',
    displayName: 'SMTP',
    properties: [
      {
        name: 'host',
        displayName: 'Host',
        type: 'string',
        default: '',
        required: true,
      },
      { name: 'port', displayName: 'Port', type: 'number', default: 587 },
      {
        name: 'secure',
        displayName: 'Use TLS from the start (port 465)',
        type: 'boolean',
        default: false,
      },
      { name: 'user', displayName: 'User', type: 'string', default: '' },
      {
        name: 'password',
        displayName: 'Password',
        type: 'string',
        default: '',
        secret: true,
      },
    ],
  },
  {
    type: OAUTH2_TYPE,
    displayName: 'OAuth2 API',
    oauth2: true,
    properties: [
      {
        name: 'grantType',
        displayName: 'Grant Type',
        type: 'options',
        default: 'authorizationCode',
        options: [
          {
            name: 'Authorization Code (user signs in)',
            value: 'authorizationCode',
          },
          {
            name: 'Client Credentials (server to server)',
            value: 'clientCredentials',
          },
        ],
      },
      {
        name: 'authUrl',
        displayName: 'Authorization URL',
        type: 'string',
        default: '',
        displayOptions: { show: { grantType: ['authorizationCode'] } },
      },
      {
        name: 'accessTokenUrl',
        displayName: 'Access Token URL',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'clientId',
        displayName: 'Client ID',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'clientSecret',
        displayName: 'Client Secret',
        type: 'string',
        default: '',
        required: true,
        secret: true,
      },
      { name: 'scope', displayName: 'Scope', type: 'string', default: '' },
      {
        name: 'authQueryParameters',
        displayName: 'Extra Auth URL Parameters',
        type: 'string',
        default: '',
        placeholder: 'access_type=offline&prompt=consent',
        displayOptions: { show: { grantType: ['authorizationCode'] } },
      },
      {
        name: 'clientAuth',
        displayName: 'Send Client Credentials',
        type: 'options',
        default: 'body',
        options: [
          { name: 'In the request body', value: 'body' },
          { name: 'As a Basic Auth header', value: 'header' },
        ],
      },
    ],
  },
  {
    type: 'httpHeaderAuth',
    displayName: 'Header Auth',
    properties: [
      {
        name: 'name',
        displayName: 'Header Name',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'X-API-Key',
      },
      {
        name: 'value',
        displayName: 'Header Value',
        type: 'string',
        default: '',
        required: true,
        secret: true,
      },
    ],
  },
  {
    type: 'httpBasicAuth',
    displayName: 'Basic Auth',
    properties: [
      {
        name: 'user',
        displayName: 'User',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'password',
        displayName: 'Password',
        type: 'string',
        default: '',
        required: true,
        secret: true,
      },
    ],
  },
  {
    type: 'httpBearerAuth',
    displayName: 'Bearer Token',
    properties: [
      {
        name: 'token',
        displayName: 'Token',
        type: 'string',
        default: '',
        required: true,
        secret: true,
      },
    ],
  },
];
