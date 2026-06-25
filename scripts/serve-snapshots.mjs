import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { queryGa4Metrics } from './ga4-data-api.mjs';

const SNAPSHOTS_ROOT = path.resolve('snapshots');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(readArg('--port') || process.env.PORT || 4173);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'jellyfish';
const DASHBOARD_AUTH_SECRET = process.env.DASHBOARD_AUTH_SECRET || 'change-this-dashboard-secret';
const DASHBOARD_COOKIE_NAME = process.env.DASHBOARD_COOKIE_NAME || 'skt_dashboard_auth';
const DASHBOARD_COOKIE_DAYS = Number(process.env.DASHBOARD_COOKIE_DAYS || 7);
const REQUIRE_HTTPS = process.env.DASHBOARD_REQUIRE_HTTPS === 'true';

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (REQUIRE_HTTPS && !isSecureRequest(request)) {
      redirect(response, `https://${request.headers.host || '34.47.71.229'}${url.pathname}${url.search}`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      await handleLogin(request, response, url);
      return;
    }

    if (!isAuthenticated(request)) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 401, { status: 'error', error: 'Authentication required.' });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(response, 405, 'Method Not Allowed');
        return;
      }

      sendLoginPage(response, { returnTo: `${url.pathname}${url.search}` });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/ga4-metrics') {
      await handleGa4Metrics(url, response);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      redirect(response, '/snapshots/index.html');
      return;
    }

    if (url.pathname.startsWith('/snapshots/')) {
      await serveSnapshotFile(url.pathname, request, response);
      return;
    }

    sendText(response, 404, 'Not Found');
  } catch (error) {
    sendJson(response, 500, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GA Snapshot server: http://${HOST}:${PORT}/snapshots/index.html`);
});

async function handleLogin(request, response, url) {
  const body = await readRequestBody(request);
  const params = new URLSearchParams(body);
  const password = params.get('password') || '';
  const returnTo = safeReturnTo(params.get('returnTo') || url.searchParams.get('returnTo') || '/snapshots/index.html');

  if (!constantTimeEqual(password, DASHBOARD_PASSWORD)) {
    sendLoginPage(response, { returnTo, error: '비밀번호가 올바르지 않습니다.' });
    return;
  }

  response.writeHead(302, {
    Location: returnTo,
    'Set-Cookie': authCookie(request),
    'Cache-Control': 'no-store',
  });
  response.end();
}

async function handleGa4Metrics(url, response) {
  const targetId = url.searchParams.get('targetId') || '';
  const startDate = url.searchParams.get('startDate') || '';
  const endDate = url.searchParams.get('endDate') || '';

  if (!targetId) {
    sendJson(response, 400, { status: 'error', error: 'targetId is required.' });
    return;
  }

  try {
    const result = await queryGa4Metrics({ targetId, startDate, endDate });
    sendJson(response, 200, { status: 'ok', ...result });
  } catch (error) {
    sendJson(response, 500, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function serveSnapshotFile(pathname, request, response) {
  const relativePath = decodeURIComponent(pathname.slice('/snapshots/'.length));
  const filePath = path.resolve(SNAPSHOTS_ROOT, relativePath);

  if (!filePath.startsWith(SNAPSHOTS_ROOT + path.sep) && filePath !== SNAPSHOTS_ROOT) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    sendText(response, 404, 'Not Found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`${text}\n`);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendLoginPage(response, { returnTo = '/snapshots/index.html', error = '' } = {}) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GA Snapshot Login</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      background: #eef2f7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(380px, 100%);
      padding: 28px;
      border: 1px solid #d9e0eb;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 16px 40px rgba(23, 32, 51, 0.12);
    }
    h1 {
      margin: 0 0 18px;
      font-size: 20px;
    }
    label {
      display: grid;
      gap: 8px;
      color: #5d687a;
      font-size: 12px;
      font-weight: 700;
    }
    input {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      border: 1px solid #cbd4e2;
      border-radius: 6px;
      font: inherit;
      font-size: 15px;
    }
    button {
      width: 100%;
      height: 42px;
      margin-top: 14px;
      border: 0;
      border-radius: 6px;
      background: #0b6bcb;
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    .error {
      margin: 0 0 14px;
      color: #c73922;
      font-size: 13px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <h1>GA Snapshot</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo(returnTo))}">
      <label>
        비밀번호
        <input name="password" type="password" autocomplete="current-password" autofocus required>
      </label>
      <button type="submit">들어가기</button>
    </form>
  </main>
</body>
</html>`);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  );
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function isAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie || '');
  const token = cookies[DASHBOARD_COOKIE_NAME];
  if (!token) return false;

  const [version, expiresText, signature] = String(token).split('.');
  if (version !== 'v1' || !expiresText || !signature) return false;

  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires <= Date.now()) return false;

  return constantTimeEqual(signature, signAuthCookie(expiresText));
}

function authCookie(request) {
  const maxAge = Math.max(1, Math.floor(DASHBOARD_COOKIE_DAYS * 24 * 60 * 60));
  const expires = String(Date.now() + maxAge * 1000);
  const token = `v1.${expires}.${signAuthCookie(expires)}`;
  const secure = isSecureRequest(request) || REQUIRE_HTTPS ? '; Secure' : '';
  return `${DASHBOARD_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function signAuthCookie(value) {
  return crypto.createHmac('sha256', DASHBOARD_AUTH_SECRET).update(value).digest('base64url');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function isSecureRequest(request) {
  return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeReturnTo(value) {
  const fallback = '/snapshots/index.html';
  const text = String(value || fallback);
  if (!text.startsWith('/') || text.startsWith('//')) return fallback;
  if (text === '/login') return fallback;
  return text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
