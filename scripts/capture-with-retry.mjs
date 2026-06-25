import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const attempts = positiveInteger(process.env.CAPTURE_RETRY_ATTEMPTS, 6);
const retryDelayMs = positiveInteger(process.env.CAPTURE_RETRY_DELAY_MS, 10 * 60 * 1000);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runCaptureWithRetry({ attempts, retryDelayMs });
  process.exitCode = result.ok ? 0 : 1;
}

export async function runCaptureWithRetry({ attempts = 6, retryDelayMs = 10 * 60 * 1000 } = {}) {
  const maxAttempts = Math.max(1, Number(attempts || 1));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(`capture attempt ${attempt}/${maxAttempts}`);
    const code = await runCaptureOnce();

    if (code === 0) {
      log(`capture succeeded on attempt ${attempt}/${maxAttempts}`);
      return { ok: true, attempt };
    }

    log(`capture failed with exit code ${code}`);
    if (attempt < maxAttempts) {
      log(`retrying in ${Math.round(retryDelayMs / 1000)}s`);
      await delay(retryDelayMs);
    }
  }

  log(`capture failed after ${maxAttempts} attempts`);
  return { ok: false, attempt: maxAttempts };
}

function runCaptureOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/capture-ga-snapshot.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      log(`failed to start capture: ${error.message}`);
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        log(`capture exited by signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(Number(code || 0));
    });
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function log(message) {
  console.log(`[capture-retry ${new Date().toISOString()}] ${message}`);
}
