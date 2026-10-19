import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const original = {
  nodeEnv: process.env.NODE_ENV,
  corsOrigins: process.env.CORS_ORIGINS,
};

afterEach(() => {
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
  if (original.corsOrigins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = original.corsOrigins;
});

describe('production deployment configuration', () => {
  it('requires exact HTTPS CORS origins and rejects local or non-origin values', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGINS;
    expect(() => createApp()).toThrow(/CORS_ORIGINS must contain the exact HTTPS frontend origin/);

    process.env.CORS_ORIGINS = 'http://localhost:5173';
    expect(() => createApp()).toThrow(/only exact HTTPS origins/);

    process.env.CORS_ORIGINS = ', , ';
    expect(() => createApp()).toThrow(/exact HTTPS frontend origin/);

    process.env.CORS_ORIGINS = 'https://ops.example.com/path';
    expect(() => createApp()).toThrow(/only exact HTTPS origins/);
  });

  it('allows only a configured production frontend origin', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://ops.example.com, https://ops.example.net';
    const app = createApp();

    const allowed = await request(app).options('/api/v1/auth/login').set('Origin', 'https://ops.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://ops.example.com');

    const denied = await request(app).options('/api/v1/auth/login').set('Origin', 'https://unlisted.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
