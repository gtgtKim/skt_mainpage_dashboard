import { setTimeout as delay } from 'node:timers/promises';
import { runCaptureWithRetry } from './capture-with-retry.mjs';

process.env.TZ ||= 'Asia/Seoul';

const scheduleHour = integerInRange(process.env.CAPTURE_SCHEDULE_HOUR, 10, 0, 23);
const scheduleMinute = integerInRange(process.env.CAPTURE_SCHEDULE_MINUTE, 0, 0, 59);
const attempts = positiveInteger(process.env.CAPTURE_RETRY_ATTEMPTS, 6);
const retryDelayMs = positiveInteger(process.env.CAPTURE_RETRY_DELAY_MS, 10 * 60 * 1000);
const once = process.argv.includes('--once');
const printNext = process.argv.includes('--print-next');

if (printNext) {
  const next = nextScheduledAt(new Date());
  console.log(JSON.stringify({ nextRunAt: next.toISOString(), local: next.toString() }, null, 2));
  process.exit(0);
}

if (once) {
  const result = await runCaptureWithRetry({ attempts, retryDelayMs });
  process.exit(result.ok ? 0 : 1);
}

log(`scheduler started; daily capture time ${pad(scheduleHour)}:${pad(scheduleMinute)} ${process.env.TZ}`);

while (true) {
  const next = nextScheduledAt(new Date());
  const waitMs = Math.max(0, next.getTime() - Date.now());
  log(`next capture at ${next.toString()}`);
  await delay(waitMs);
  await runCaptureWithRetry({ attempts, retryDelayMs });
}

function nextScheduledAt(now) {
  const next = new Date(now);
  next.setHours(scheduleHour, scheduleMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function positiveInteger(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function integerInRange(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function log(message) {
  console.log(`[capture-scheduler ${new Date().toISOString()}] ${message}`);
}
