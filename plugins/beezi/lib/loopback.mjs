import http from 'node:http';
import { UserError } from './friendly-error.mjs';

const CLOSE_PAGE = '<!doctype html><meta charset="utf-8"><title>Beezi</title>'
  + '<body style="font-family:sans-serif;padding:3rem;text-align:center">'
  + '<h2>✓ Beezi linked</h2><p>You can close this tab and return to the terminal.</p>';
const FAIL_PAGE = '<!doctype html><meta charset="utf-8"><title>Beezi</title>'
  + '<body style="font-family:sans-serif;padding:3rem;text-align:center">'
  + '<h2>Login failed</h2><p>Return to the terminal and try /beezi:login again.</p>';

// One-shot loopback callback receiver. Binds 127.0.0.1:{port} (0 = ephemeral),
// resolves `code` with the authorization code from the first valid /callback hit.
export async function startLoopback({ port = 0, expectedState, timeoutMs = 300_000 }) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

  const code = new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      clearTimeout(timer);
      server.close();
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new UserError('Login timed out before the browser round-trip completed.')),
      timeoutMs,
    );
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const err = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const authCode = url.searchParams.get('code');
      const ok = !err && state === expectedState && authCode;
      res.statusCode = ok ? 200 : 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(ok ? CLOSE_PAGE : FAIL_PAGE);
      if (ok) finish(resolve, authCode);
      else if (err) finish(reject, new UserError(`Authorization failed: ${err}.`));
      else finish(reject, new UserError('Login state mismatch — run /beezi:login again.'));
    });
  });

  return { redirectUri, port: actualPort, code };
}
