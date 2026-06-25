import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryGa4Metrics } from './ga4-data-api.mjs';

const SNAPSHOTS_ROOT = path.resolve('snapshots');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(readArg('--port') || process.env.PORT || 4173);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);

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
