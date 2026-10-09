import type { MigrationInterface } from 'typeorm';
import { Init1791539521769 } from './1791539521769-Init.js';
import { TriggersCredentialsQueue1791540619770 } from './1791540619770-TriggersCredentialsQueue.js';

// Register every new migration here, in chronological order.
export const migrations: (new () => MigrationInterface)[] = [
  Init1791539521769,
  TriggersCredentialsQueue1791540619770,
];
