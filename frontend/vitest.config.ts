import { defineConfig } from 'vitest/config'; import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], test: {
  environment: 'jsdom', environmentOptions: { jsdom: { url: 'http://localhost:5173/' } }, globals: true,
  setupFiles: ['tests/setup.ts'], globalSetup: ['tests/globalSetup.ts'], env: { VITE_API_BASE_URL: 'http://127.0.0.1:3200' },
  testTimeout: 20000, hookTimeout: 60000, fileParallelism: false } });
