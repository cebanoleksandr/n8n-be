/**
 * e2e tests use their own database, Redis db and bucket so they never touch
 * development data. These override the values from .env.
 */
export const testEnv = {
  DATABASE_URL: 'postgres://flow:flow@localhost:5440/flow_test',
  REDIS_URL: 'redis://localhost:6390/1',
  S3_BUCKET: 'flow-binary-data-test',
};
