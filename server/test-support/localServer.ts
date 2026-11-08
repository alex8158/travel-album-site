/**
 * Test-only HTTP server bound to 127.0.0.1 (docs/agent/known-issues.md 12a).
 *
 * `request(app)` makes supertest call `app.listen(0)`, which binds the
 * dual-stack `::` wildcard, and then connects to `127.0.0.1:<port>`. When
 * another local process holds that port number on IPv4, the connection does
 * not reach the test server (confirmed for three gallery.test.ts failures,
 * round14/15 evidence). Binding the test server to 127.0.0.1 explicitly
 * avoids that.
 *
 * `listenLocal(app)`:
 * - creates an http.Server for `app` and listens on 127.0.0.1, port 0;
 * - resolves only once the server is listening; a listen error rejects;
 * - registers the close with `onTestFinished`, so it runs even when the test
 *   body or an `afterEach` hook throws, and finishes before the next test;
 *   a close error fails the test instead of being swallowed.
 *
 * Call it inside a test or a `beforeEach` (vitest's current-test context);
 * elsewhere `onTestFinished` throws.
 *
 * Lives outside `src/` so `npm run build` (tsconfig include `src/**`) never
 * compiles it into `dist/`.
 */
import http from 'http';
import { onTestFinished } from 'vitest';

export async function listenLocal(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  return server;
}
