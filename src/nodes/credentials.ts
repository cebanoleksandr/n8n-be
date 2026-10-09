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

export const builtinCredentialTypes: CredentialTypeDescription[] = [
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
