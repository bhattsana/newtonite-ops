import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Production builds get a Content-Security-Policy <meta>: scripts/styles only from this origin, network requests only to this origin and
// the configured API. That limits what injected script could do with the session token (it cannot send it to another site).
// Also send the same policy as an HTTP header from your static host if you can (a <meta> cannot express frame-ancestors).
const csp = (apiOrigin: string): Plugin => ({
  name: 'csp-meta', apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', injectTo: 'head-prepend', attrs: { 'http-equiv': 'Content-Security-Policy',
    content: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${apiOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'` } }],
});
export default defineConfig(({ command, mode }) => {
  const configuredApiBase = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE_URL;
  if (command === 'build' && mode === 'production' && !configuredApiBase) {
    throw new Error('VITE_API_BASE_URL must be set to the deployed HTTPS API origin for production builds');
  }
  const base = configuredApiBase ?? 'http://localhost:3000';
  if (command === 'build' && mode === 'production') {
    let apiUrl: URL;
    try {
      apiUrl = new URL(base);
    } catch {
      throw new Error('VITE_API_BASE_URL must be a valid HTTPS API origin for production builds');
    }
    if (apiUrl.protocol !== 'https:' || apiUrl.origin !== base) {
      throw new Error('VITE_API_BASE_URL must be an HTTPS origin without a path or trailing slash in production builds');
    }
  }
  return { plugins: [react(), csp(new URL(base).origin)], server: { port: 5173, host: true, fs: { allow: ['..'] } } };
});
