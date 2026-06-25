import { chromium, devices } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { GA4_CONFIG, makeGa4MetricKey } from './ga4-data-api.mjs';

const OUTPUT_ROOT = path.resolve('snapshots');
const RUN_ID = process.env.RUN_ID || timestampForPath(new Date());
const RUN_DIR = path.join(OUTPUT_ROOT, RUN_ID);

const targets = [
  {
    id: 'mobile-main',
    label: 'T world Shop Mobile Main',
    url: 'https://m.shop.tworld.co.kr/shop/main',
    context: {
      ...devices['iPhone 13'],
      deviceScaleFactor: 1,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    },
  },
  {
    id: 'pc-main',
    label: 'T world Shop PC Main',
    url: 'https://shop.tworld.co.kr/shop/main',
    context: {
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});

const summaries = [];

try {
  await fs.mkdir(RUN_DIR, { recursive: true });

  for (const target of targets) {
    const summary = await captureTarget(browser, target);
    summaries.push(summary);
  }

  validateCaptureSummaries(summaries);

  await fs.writeFile(
    path.join(RUN_DIR, 'summary.json'),
    `${JSON.stringify({ runId: RUN_ID, capturedAt: new Date().toISOString(), targets: summaries }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(RUN_DIR, 'index.html'), renderIndex(RUN_ID, summaries));
  await pruneSnapshotRunsByDate(OUTPUT_ROOT, RUN_ID);
  await rebuildSnapshotCatalog(OUTPUT_ROOT);

  console.log(JSON.stringify({ outputDir: RUN_DIR, targets: summaries }, null, 2));
} catch (error) {
  await fs.rm(RUN_DIR, { recursive: true, force: true }).catch(() => {});
  console.error(
    JSON.stringify(
      {
        status: 'error',
        outputDir: RUN_DIR,
        error: error instanceof Error ? error.message : String(error),
        targets: summaries,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}

function validateCaptureSummaries(capturedTargets) {
  const requiredIds = new Set(targets.map((target) => target.id));
  const capturedIds = new Set(capturedTargets.map((target) => target.id));
  const errors = [];

  for (const id of requiredIds) {
    if (!capturedIds.has(id)) errors.push(`${id}: missing capture result`);
  }

  for (const target of capturedTargets) {
    if (target.loadError) {
      errors.push(`${target.id}: ${target.loadError}`);
    }

    if (Number(target.counts?.contentDomGaLabelElements || 0) <= 0) {
      errors.push(`${target.id}: no GA DOM elements were captured`);
    }

    const contentHtml = target.archives?.contentHtml;
    const staticHtml = target.archives?.staticHtml;
    if (!contentHtml || !staticHtml) {
      errors.push(`${target.id}: html archives were not created`);
    }
  }

  if (errors.length) {
    throw new Error(`Capture validation failed. ${errors.join(' / ')}`);
  }
}

async function captureTarget(browserInstance, target) {
  const outputDir = path.join(RUN_DIR, target.id);
  await fs.mkdir(outputDir, { recursive: true });

  const context = await browserInstance.newContext({
    ...target.context,
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const consoleMessages = [];
  const failedRequests = [];

  page.on('console', (message) => {
    if (consoleMessages.length >= 50) return;
    consoleMessages.push({
      type: message.type(),
      text: message.text().slice(0, 500),
    });
  });

  page.on('requestfailed', (request) => {
    if (failedRequests.length >= 50) return;
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText || null,
      resourceType: request.resourceType(),
    });
  });

  const startedAt = new Date();
  let loadError = null;

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await dismissPopups(page);
    await autoScroll(page);
    await dismissPopups(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1_000);
    await freezePageMotion(page);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const collected = await collectGaElements(page, target.id);
  const pageMeta = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
      document.documentElement.clientWidth,
    ),
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      document.documentElement.clientHeight,
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }));
  const archiveMeta = await saveHtmlArchives(context, page, outputDir, {
    target,
    pageMeta,
    elements: collected.domElements,
  });

  const snapshot = {
    id: target.id,
    label: target.label,
    requestedUrl: target.url,
    finalUrl: pageMeta.url,
    title: pageMeta.title,
    capturedAt: new Date().toISOString(),
    loadStartedAt: startedAt.toISOString(),
    loadError,
    viewport: target.context.viewport,
    page: pageMeta,
    counts: collected.counts,
    excludedCounts: collected.excludedCounts,
    elements: collected.elements,
    domElements: collected.domElements,
    excludedSamples: collected.excludedSamples,
    archives: archiveMeta,
    diagnostics: {
      consoleMessages,
      failedRequests,
    },
  };

  await fs.writeFile(path.join(outputDir, 'ga-elements.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'ga-elements.csv'), toCsv(snapshot.elements));
  await fs.writeFile(path.join(outputDir, 'ga-dom-elements.json'), `${JSON.stringify(snapshot.domElements, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'ga-dom-elements.csv'), toCsv(snapshot.domElements));

  await context.close();

  return {
    id: target.id,
    label: target.label,
    url: target.url,
    finalUrl: snapshot.finalUrl,
    title: snapshot.title,
    outputDir,
    loadError,
    page: snapshot.page,
    counts: snapshot.counts,
    excludedCounts: snapshot.excludedCounts,
    archives: archiveMeta,
  };
}

async function dismissPopups(page) {
  await page.keyboard.press('Escape').catch(() => {});

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await page.evaluate(() => {
      const popupRootSelector = [
        'dialog',
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="popup" i]',
        '[id*="popup" i]',
        '[class*="modal" i]',
        '[id*="modal" i]',
        '[class*="layer-pop" i]',
        '[class*="layer_popup" i]',
        '[id*="layer-pop" i]',
        '[id*="layer_popup" i]',
      ].join(',');

      const closePattern =
        /(닫기|닫음|close|closed|오늘\s*하루|하루\s*동안|다시\s*보지|보지\s*않|그만\s*보기|×|✕|x)/i;

      const isVisible = (element) => {
        if (!(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const visiblePopupRoots = Array.from(document.querySelectorAll(popupRootSelector)).filter(isVisible);
      const candidates = Array.from(
        document.querySelectorAll(
          'button,a,[role="button"],input[type="button"],input[type="submit"],label,[onclick],[aria-label],[title]',
        ),
      ).filter(isVisible);

      for (const candidate of candidates) {
        const popupRoot = candidate.closest(popupRootSelector);
        if (!popupRoot || !visiblePopupRoots.includes(popupRoot)) continue;

        const text = [
          candidate.textContent,
          candidate.getAttribute('aria-label'),
          candidate.getAttribute('title'),
          candidate.getAttribute('alt'),
          candidate.getAttribute('class'),
          candidate.getAttribute('id'),
          candidate.getAttribute('value'),
        ]
          .filter(Boolean)
          .join(' ');

        if (closePattern.test(text.trim())) {
          candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { action: 'clicked', text: text.trim().slice(0, 120) };
        }
      }

      let removed = 0;
      for (const popupRoot of visiblePopupRoots) {
        const rect = popupRoot.getBoundingClientRect();
        const style = window.getComputedStyle(popupRoot);
        const zIndex = Number.parseInt(style.zIndex || '0', 10);
        const fixedLike = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
        const largeEnough = rect.width >= 80 && rect.height >= 60;

        if (fixedLike || largeEnough || zIndex >= 10) {
          popupRoot.remove();
          removed += 1;
        }
      }

      if (removed) {
        unlockInlineScroll();
      }

      return removed ? { action: 'removed', count: removed } : null;

      function unlockInlineScroll() {
        for (const element of [document.documentElement, document.body]) {
          if (element.style.overflow === 'hidden') element.style.overflow = '';
          if (element.style.overflowY === 'hidden') element.style.overflowY = '';
        }
      }
    });

    if (!result) return;
    await page.waitForTimeout(700);
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const distance = Math.max(300, Math.floor(window.innerHeight * 0.75));
      let y = 0;
      const timer = window.setInterval(() => {
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
        );
        window.scrollTo(0, y);
        y += distance;

        if (y > scrollHeight + window.innerHeight) {
          window.clearInterval(timer);
          resolve();
        }
      }, 220);
    });
  });

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}

async function freezePageMotion(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.swiper, .swiper-container').forEach((element) => {
      try {
        element.swiper?.autoplay?.stop?.();
      } catch {}
    });

    document.querySelectorAll('[ga_label="정지"], .swiper-btn-stop').forEach((element) => {
      try {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0;

        if (visible && !element.classList.contains('is-active')) {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      } catch {}
    });

    document.querySelectorAll('video,audio').forEach((element) => {
      try {
        element.pause();
      } catch {}
    });

    const style = document.createElement('style');
    style.setAttribute('data-ga-snapshot-freeze', 'true');
    style.textContent = `
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        scroll-behavior: auto !important;
      }
    `;
    document.head.append(style);
  });

  await page.waitForTimeout(300);
}

async function captureStitchedFullPage(page, outputPath, outputDir) {
  const segmentsDir = path.join(outputDir, '.segments');
  await fs.rm(segmentsDir, { recursive: true, force: true });
  await fs.mkdir(segmentsDir, { recursive: true });

  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForVisualContent(page);

  let metrics = await getPageMetrics(page);
  const viewportHeight = metrics.viewportHeight;
  const viewportWidth = metrics.viewportWidth;
  let knownDocumentHeight = metrics.documentHeight;
  const segments = [];
  const capturedPositions = new Set();

  let requestedY = 0;

  for (let index = 0; index < 80; index += 1) {
    await scrollToY(page, requestedY);
    await waitForVisualContent(page);
    await scrollToY(page, requestedY);
    await page.waitForTimeout(150);

    const actualY = await page.evaluate(() => Math.round(window.scrollY));
    debugCapture('segment-scroll', { index, requestedY, actualY, viewportHeight, knownDocumentHeight });

    if (capturedPositions.has(actualY)) break;
    capturedPositions.add(actualY);

    const segmentPath = path.join(segmentsDir, `segment-${String(index).padStart(3, '0')}.png`);

    await page.screenshot({
      path: segmentPath,
      animations: 'disabled',
      caret: 'hide',
    });

    const segmentMeta = await sharp(segmentPath).metadata();
    metrics = await getPageMetrics(page);
    knownDocumentHeight = Math.max(knownDocumentHeight, metrics.documentHeight);
    debugCapture('segment-captured', {
      index,
      actualY,
      segmentHeight: segmentMeta.height || viewportHeight,
      documentHeight: metrics.documentHeight,
      knownDocumentHeight,
    });

    segments.push({
      path: segmentPath,
      top: actualY,
      height: segmentMeta.height || viewportHeight,
    });

    if (actualY + viewportHeight >= knownDocumentHeight - 1) break;

    requestedY = Math.min(actualY + viewportHeight, Math.max(0, knownDocumentHeight - viewportHeight));
  }

  const finalMetrics = await getPageMetrics(page);
  const finalHeight = Math.max(
    knownDocumentHeight,
    finalMetrics.documentHeight,
    ...segments.map((segment) => segment.top + segment.height),
  );

  const image = sharp({
    create: {
      width: viewportWidth,
      height: finalHeight,
      channels: 4,
      background: '#ffffff',
    },
  });

  await image
    .composite(
      segments.map((segment) => ({
        input: segment.path,
        top: segment.top,
        left: 0,
      })),
    )
    .png()
    .toFile(outputPath);

  await fs.rm(segmentsDir, { recursive: true, force: true });

  return {
    width: viewportWidth,
    height: finalHeight,
    segments: segments.length,
  };
}

async function scrollToY(page, y) {
  await page.evaluate(
    (targetY) =>
      new Promise((resolve) => {
        const scroll = () => {
          document.documentElement.style.scrollBehavior = 'auto';
          document.body.style.scrollBehavior = 'auto';
          if (document.scrollingElement) document.scrollingElement.scrollTop = targetY;
          document.documentElement.scrollTop = targetY;
          document.body.scrollTop = targetY;
          window.scrollTo({ top: targetY, left: 0, behavior: 'instant' });
        };

        scroll();
        window.requestAnimationFrame(() => {
          scroll();
          window.requestAnimationFrame(resolve);
        });
      }),
    y,
  );
}

async function collectStylesheets(context, page) {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
      .map((link) => new URL(link.getAttribute('href'), location.href).href)
      .filter(Boolean),
  );
  const uniqueHrefs = [...new Set(hrefs)];
  const items = [];
  const failed = [];

  for (const href of uniqueHrefs) {
    try {
      const response = await context.request.get(href, { timeout: 15_000 });
      if (!response.ok()) {
        failed.push({ href, status: response.status() });
        continue;
      }

      const css = rewriteCssUrls(await response.text(), href);
      items.push({ href, css });
    } catch (error) {
      failed.push({ href, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { items, failed };
}

function rewriteCssUrls(css, baseHref) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, rawUrl) => {
      const value = rawUrl.trim();
      if (!value || isAbsoluteAssetUrl(value)) return match;

      try {
        return `url("${new URL(value, baseHref).href}")`;
      } catch {
        return match;
      }
    })
    .replace(/@import\s+(url\()?(['"])([^'"]+)\2\)?/g, (match, urlPrefix, quote, rawUrl) => {
      const value = rawUrl.trim();
      if (!value || isAbsoluteAssetUrl(value)) return match;

      try {
        const absoluteUrl = new URL(value, baseHref).href;
        return urlPrefix ? `@import url("${absoluteUrl}")` : `@import "${absoluteUrl}"`;
      } catch {
        return match;
      }
    });
}

function isAbsoluteAssetUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
}

async function saveHtmlArchives(context, page, outputDir, review) {
  const stylesheets = await collectStylesheets(context, page);
  const contentHtml = await buildClonedHtml(page, {
    disableScripts: true,
    inlineStylesheets: stylesheets.items,
    overlayElements: null,
  });
  const contentFile = 'page-content.html';
  const staticFile = 'page-static.html';

  await fs.writeFile(path.join(outputDir, contentFile), contentHtml);
  await fs.writeFile(
    path.join(outputDir, staticFile),
    renderStaticReviewShell({
      target: review.target,
      pageMeta: review.pageMeta,
      contentFile,
      contentHtml,
      elements: review.elements,
    }),
  );

  return {
    staticHtml: staticFile,
    contentHtml: contentFile,
    inlinedStylesheets: stylesheets.items.length,
    failedStylesheets: stylesheets.failed,
  };
}

async function buildClonedHtml(page, options) {
  return page.evaluate(({ disableScripts, inlineStylesheets, overlayElements }) => {
    const clone = document.documentElement.cloneNode(true);
    const head = ensureHead(clone);
    const body = ensureBody(clone);

    head.querySelectorAll('base[data-ga-snapshot-base]').forEach((node) => node.remove());

    const base = document.createElement('base');
    base.setAttribute('data-ga-snapshot-base', 'true');
    base.href = location.href;
    head.prepend(base);

    const meta = document.createElement('meta');
    meta.name = 'ga-snapshot-captured-url';
    meta.content = location.href;
    head.append(meta);

    if (disableScripts) {
      clone.querySelectorAll('script').forEach((script) => script.remove());
    }

    if (inlineStylesheets?.length) {
      inlineStylesheetLinks(clone, inlineStylesheets);
    }

    for (const element of [clone, body]) {
      if (element.style?.overflow === 'hidden') element.style.overflow = '';
      if (element.style?.overflowY === 'hidden') element.style.overflowY = '';
    }

    if (overlayElements?.length) {
      injectGaOverlay(head, body, overlayElements);
    }

    return `<!doctype html>\n${clone.outerHTML}`;

    function ensureHead(root) {
      let nextHead = root.querySelector('head');
      if (!nextHead) {
        nextHead = document.createElement('head');
        root.prepend(nextHead);
      }
      return nextHead;
    }

    function ensureBody(root) {
      let nextBody = root.querySelector('body');
      if (!nextBody) {
        nextBody = document.createElement('body');
        root.append(nextBody);
      }
      return nextBody;
    }

    function inlineStylesheetLinks(root, stylesheets) {
      const stylesheetByHref = new Map(stylesheets.map((item) => [item.href, item.css]));

      root.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
        const href = new URL(link.getAttribute('href'), location.href).href;
        const css = stylesheetByHref.get(href);
        if (!css) return;

        const style = document.createElement('style');
        style.setAttribute('data-ga-snapshot-href', href);
        style.textContent = css;
        link.replaceWith(style);
      });
    }

    function injectGaOverlay(nextHead, nextBody, items) {
      const style = document.createElement('style');
      style.textContent = `
        #ga-snapshot-overlay-root {
          position: absolute;
          inset: 0 auto auto 0;
          z-index: 2147483647;
          pointer-events: none;
        }

        #ga-snapshot-overlay-root .ga-snapshot-box {
          position: absolute;
          box-sizing: border-box;
          border: 2px solid #f05a28;
          background: rgba(240, 90, 40, 0.14);
          pointer-events: auto;
        }

        #ga-snapshot-overlay-root .ga-snapshot-box::before {
          content: attr(data-index);
          position: absolute;
          top: -2px;
          left: -2px;
          min-width: 18px;
          height: 18px;
          padding: 0 4px;
          display: grid;
          place-items: center;
          background: #f05a28;
          color: #fff;
          font: 700 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        #ga-snapshot-overlay-root .ga-snapshot-box:hover {
          border-color: #0b6bcb;
          background: rgba(11, 107, 203, 0.18);
        }

        #ga-snapshot-overlay-panel {
          position: fixed;
          right: 12px;
          bottom: 12px;
          z-index: 2147483647;
          max-width: min(360px, calc(100vw - 24px));
          max-height: 40vh;
          overflow: auto;
          padding: 10px 12px;
          border: 1px solid rgba(20, 31, 48, 0.18);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.96);
          color: #1d2430;
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 8px 30px rgba(10, 20, 40, 0.16);
        }

        #ga-snapshot-overlay-panel strong {
          display: block;
          margin-bottom: 6px;
          font-size: 13px;
        }
      `;
      nextHead.append(style);

      const overlayRoot = document.createElement('div');
      overlayRoot.id = 'ga-snapshot-overlay-root';

      for (const item of items) {
        const rect = item.clickableBBox;
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        const box = document.createElement('a');
        box.className = 'ga-snapshot-box';
        box.href = item.href || '#';
        if (item.href) {
          box.target = '_blank';
          box.rel = 'noreferrer';
        }
        box.dataset.index = String(item.index);
        box.title = `${item.index}. ${item.ga_action || '(missing)'} / ${item.ga_label}`;
        box.style.left = `${rect.x}px`;
        box.style.top = `${rect.y}px`;
        box.style.width = `${Math.max(rect.width, 1)}px`;
        box.style.height = `${Math.max(rect.height, 1)}px`;
        overlayRoot.append(box);
      }

      const panel = document.createElement('div');
      panel.id = 'ga-snapshot-overlay-panel';
      panel.innerHTML = '<strong>GA Overlay</strong><div>주황색 박스는 현재 화면 기준 ga_label 요소입니다.</div>';

      nextBody.append(overlayRoot, panel);
    }
  }, options);
}

function groupElementsByAction(elements) {
  const groups = [];
  const groupByAction = new Map();

  for (const item of elements) {
    const action = item.ga_action || '(missing)';
    let group = groupByAction.get(action);

    if (!group) {
      group = {
        id: `group-${groups.length + 1}`,
        action,
        items: [],
      };
      groupByAction.set(action, group);
      groups.push(group);
    }

    group.items.push(item);
  }

  return groups;
}

function renderStaticReviewShell({ target, pageMeta, contentHtml, elements }) {
  const isMobile = target.id.includes('mobile');
  const groups = groupElementsByAction(elements);
  const rows = groups
    .map(
      (group) => `
        <tr class="group-row" data-group-id="${escapeHtml(group.id)}">
          <td colspan="3">
            <button class="group-toggle" type="button">
              <span class="group-state">[-]</span>
              <span>${escapeHtml(group.action)}</span>
              <small>${group.items.length} items</small>
            </button>
          </td>
        </tr>
        ${group.items
          .map(
            (item) => `
              <tr data-index="${item.index}" data-snapshot-id="${escapeHtml(item.snapshotId || '')}" data-period-key="${escapeHtml(
                item.periodKey || item.stableKey || '',
              )}" data-group-id="${escapeHtml(group.id)}">
                <td><code>${escapeHtml(item.ga_action || '(missing)')}</code></td>
                <td><code>${escapeHtml(item.ga_label)}</code></td>
                <td>${item.href ? '<span class="href-pill">link</span>' : ''}</td>
              </tr>`,
          )
          .join('\n')}`,
    )
    .join('\n');

  const viewportWidth = isMobile ? pageMeta.viewportWidth || 390 : null;
  const previewOuterWidth = isMobile ? viewportWidth + 2 : null;
  const sourceViewportWidth = pageMeta.viewportWidth || (isMobile ? 390 : 1440);

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(target.label)} GA Review</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1d2430;
      background: #eef2f7;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      overflow: hidden;
      user-select: none;
    }

    body:not(.is-column-resizing) .panel,
    body:not(.is-column-resizing) .panel * {
      -webkit-user-select: text !important;
      user-select: text !important;
    }

    body.is-dragging iframe {
      pointer-events: none;
    }

    body.is-column-resizing,
    body.is-column-resizing * {
      cursor: col-resize !important;
      user-select: none !important;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) 10px minmax(340px, 520px);
      gap: 0;
      height: 100vh;
      padding: 12px;
    }

    .layout.mobile {
      grid-template-columns: ${previewOuterWidth}px 10px minmax(420px, 1fr);
      justify-content: start;
    }

    .preview {
      min-width: 0;
      height: calc(100vh - 24px);
      overflow: hidden;
      border: 1px solid #d7deea;
      border-radius: 8px;
      background: #fff;
    }

    .layout.pc .preview {
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }

    .splitter {
      position: relative;
      width: 10px;
      height: calc(100vh - 24px);
      cursor: col-resize;
      touch-action: none;
    }

    .splitter::before {
      content: "";
      position: absolute;
      top: 8px;
      bottom: 8px;
      left: 4px;
      width: 2px;
      border-radius: 999px;
      background: #c9d2e1;
    }

    .splitter:hover::before,
    .splitter.dragging::before {
      background: #0b6bcb;
    }

    .layout.mobile .preview {
      width: 100%;
      display: flex;
      justify-content: center;
      background: #e8edf5;
      box-shadow: 0 8px 28px rgba(20, 31, 48, 0.12);
    }

    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
      transform-origin: top center;
    }

    .layout.mobile iframe {
      width: ${viewportWidth}px;
      min-width: ${viewportWidth}px;
      margin: 0 auto;
      transform-origin: top center;
    }

    .panel {
      min-width: 0;
      height: calc(100vh - 24px);
      display: grid;
      grid-template-rows: auto auto 1fr;
      overflow: hidden;
      border: 1px solid #d7deea;
      border-radius: 8px;
      background: #fff;
    }

    .layout.pc .panel,
    .layout.mobile .panel {
      margin-left: 6px;
    }

    .panel-head {
      padding: 14px 16px 12px;
      border-bottom: 1px solid #e5e9f0;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 16px;
    }

    .meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      color: #596579;
      font-size: 12px;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid #edf0f5;
    }

    input {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid #cfd7e5;
      border-radius: 6px;
      font: inherit;
      font-size: 13px;
    }

    .toolbar-actions {
      display: flex;
      gap: 6px;
      white-space: nowrap;
    }

    .toolbar-actions button {
      height: 34px;
      padding: 0 10px;
      border: 1px solid #cfd7e5;
      border-radius: 6px;
      background: #fbfcff;
      color: #263244;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .toolbar-actions button:hover {
      border-color: #0b6bcb;
      color: #0b6bcb;
    }

    .table-wrap {
      min-width: 0;
      width: calc(100% - 4px);
      max-width: calc(100% - 4px);
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    th,
    td {
      padding: 8px 9px;
      border-bottom: 1px solid #edf0f5;
      vertical-align: top;
      text-align: left;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      overflow: visible;
      background: #fbfcfe;
      color: #596579;
      font-size: 11px;
    }

    tr {
      cursor: pointer;
    }

    tr:hover,
    tr.active {
      background: #eaf3ff;
    }

    .group-row {
      cursor: pointer;
      background: #f6f8fb;
    }

    .group-row td {
      padding: 8px 10px;
      border-bottom-color: #dfe5ee;
    }

    .group-row:hover {
      background: #eef4ff;
    }

    .group-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      color: #273244;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .group-toggle small {
      color: #687486;
      font-weight: 600;
    }

    .group-state {
      color: #0b6bcb;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    tr[data-status="hidden"] {
      color: #7b8493;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: nowrap;
    }

    a {
      color: #0b6bcb;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 54px;
      height: 20px;
      padding: 0 7px;
      border-radius: 999px;
      background: #eef2f7;
      color: #536074;
      font-size: 11px;
      font-weight: 700;
    }

    .status.visible {
      background: #e9f8ef;
      color: #176c38;
    }

    .status.offscreen {
      background: #fff3df;
      color: #9a5b00;
    }

    .status.hidden {
      background: #f0f1f4;
      color: #737b88;
    }

    .href-pill {
      color: #0b6bcb;
      font-weight: 700;
    }

    @media (max-width: 980px) {
      body {
        overflow: auto;
      }

      .layout,
      .layout.mobile {
        grid-template-columns: 1fr;
        height: auto;
      }

      .splitter {
        display: none;
      }

      .layout.mobile .preview,
      .preview,
      .panel {
        width: 100%;
        height: 80vh;
      }
    }
  </style>
</head>
<body>
  <main class="layout ${isMobile ? 'mobile' : 'pc'}">
    <section class="preview" aria-label="Static page preview">
      <iframe id="pageFrame" title="${escapeHtml(target.label)}"></iframe>
    </section>
    <div class="splitter" id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize preview and GA Attributes"></div>
    <aside class="panel" aria-label="GA Attributes">
      <div class="panel-head">
        <h1>GA Attributes</h1>
        <div class="meta">
          <span>${escapeHtml(target.id)}</span>
          <span>${elements.length} DOM labels</span>
          <span>${escapeHtml(pageMeta.url)}</span>
        </div>
      </div>
      <div class="toolbar">
        <input id="filterInput" type="search" placeholder="ga_action, ga_label 검색">
        <div class="toolbar-actions">
          <button id="expandAll" type="button">전체 펼치기</button>
          <button id="collapseAll" type="button">전체 접기</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ga_action</th>
              <th>ga_label</th>
              <th>Href</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </aside>
  </main>
  <script id="page-source" type="application/json">${jsonForScript(contentHtml)}</script>
  <script id="ga-data" type="application/json">${jsonForScript(elements)}</script>
  <script>
    const frame = document.getElementById('pageFrame');
    const preview = document.querySelector('.preview');
    const layout = document.querySelector('.layout');
    const panel = document.querySelector('.panel');
    const splitter = document.getElementById('splitter');
    const filterInput = document.getElementById('filterInput');
    const expandAllButton = document.getElementById('expandAll');
    const collapseAllButton = document.getElementById('collapseAll');
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const itemRows = Array.from(document.querySelectorAll('tbody tr[data-index]'));
    const groupRows = Array.from(document.querySelectorAll('tbody tr.group-row'));
    const items = JSON.parse(document.getElementById('ga-data').textContent);
    const itemByIndex = new Map(items.map((item) => [String(item.index), item]));
    const itemBySnapshotId = new Map(items.filter((item) => item.snapshotId).map((item) => [item.snapshotId, item]));
    const itemByPeriodKey = new Map(items.filter((item) => item.periodKey).map((item) => [item.periodKey, item]));
    const isMobilePreview = ${isMobile ? 'true' : 'false'};
    const sourceViewportWidth = ${sourceViewportWidth};
    let highlightedElement = null;
    let dragging = false;
    let activePointerId = null;
    const collapsedGroups = new Set();

    frame.srcdoc = JSON.parse(document.getElementById('page-source').textContent);
    frame.addEventListener('load', () => {
      fitPreview();
      installPreviewClickBridge();
    });
    window.addEventListener('resize', fitPreview);
    fitPreview();
    installSplitter();

    function fitPreview() {
      if (isMobilePreview || !preview) return;

      const scale = Math.min(1, preview.clientWidth / sourceViewportWidth);
      frame.style.width = sourceViewportWidth + 'px';
      frame.style.height = Math.ceil(preview.clientHeight / scale) + 'px';
      frame.style.transform = 'scale(' + scale + ')';
    }

    function installSplitter() {
      splitter.addEventListener('pointerdown', (event) => {
        dragging = true;
        activePointerId = event.pointerId;
        splitter.classList.add('dragging');
        document.body.classList.add('is-dragging');
        try {
          splitter.setPointerCapture(event.pointerId);
        } catch {}
        event.preventDefault();
      });

      window.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        if (event.buttons === 0) {
          stopDragging(event);
          return;
        }

        const rect = layout.getBoundingClientRect();
        const splitterWidth = splitter.getBoundingClientRect().width || 10;
        const minPreview = isMobilePreview ? 280 : 520;
        const minPanel = 360;
        const available = rect.width;
        const rawPreviewWidth = event.clientX - rect.left;
        const previewWidth = Math.max(minPreview, Math.min(rawPreviewWidth, available - splitterWidth - minPanel));
        const panelWidth = Math.max(minPanel, available - previewWidth - splitterWidth);

        layout.style.gridTemplateColumns = previewWidth + 'px ' + splitterWidth + 'px ' + panelWidth + 'px';
        fitPreview();
      });

      const stopDragging = (event) => {
        if (!dragging) return;
        dragging = false;
        activePointerId = null;
        splitter.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        try {
          splitter.releasePointerCapture(event?.pointerId ?? activePointerId);
        } catch {}
      };

      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      window.addEventListener('blur', stopDragging);
    }

    filterInput.addEventListener('input', () => {
      updateTable();
    });

    expandAllButton.addEventListener('click', () => {
      collapsedGroups.clear();
      updateTable();
    });

    collapseAllButton.addEventListener('click', () => {
      for (const groupRow of groupRows) {
        collapsedGroups.add(groupRow.dataset.groupId);
      }
      updateTable();
    });

    for (const groupRow of groupRows) {
      groupRow.addEventListener('click', () => {
        const groupId = groupRow.dataset.groupId;
        if (collapsedGroups.has(groupId)) {
          collapsedGroups.delete(groupId);
        } else {
          collapsedGroups.add(groupId);
        }

        updateTable();
      });
    }

    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'ga-focus') return;
      const item = findItemFromPayload(event.data);
      if (item) activateItem(item, { clearFilter: true, focusPreview: true });
    });

    updateTable();

    function updateTable() {
      const query = filterInput.value.trim().toLowerCase();
      const groupHasMatch = new Map();

      for (const row of itemRows) {
        const item = itemByIndex.get(row.dataset.index);
        const haystack = [
          item?.ga_action,
          item?.ga_label,
          item?.href,
        ].filter(Boolean).join(' ').toLowerCase();
        const matches = !query || haystack.includes(query);
        row.dataset.matches = matches ? 'true' : 'false';

        if (matches) {
          groupHasMatch.set(row.dataset.groupId, true);
        }
      }

      for (const row of itemRows) {
        const matches = row.dataset.matches === 'true';
        const collapsed = collapsedGroups.has(row.dataset.groupId);
        row.hidden = !matches || collapsed;
      }

      for (const row of groupRows) {
        const groupId = row.dataset.groupId;
        const collapsed = collapsedGroups.has(groupId);
        const hasMatch = groupHasMatch.get(groupId) || false;
        row.hidden = query && !hasMatch;
        row.classList.toggle('collapsed', collapsed);
        const state = row.querySelector('.group-state');
        if (state) state.textContent = collapsed ? '[+]' : '[-]';
      }
    }

    for (const row of itemRows) {
      row.addEventListener('click', () => {
        activateItem(itemByIndex.get(row.dataset.index), { focusPreview: true });
      });
    }

    function activateItem(item, options = {}) {
      if (!item) return;
      const { clearFilter = false, focusPreview = true } = options;
      const row = document.querySelector('tbody tr[data-index="' + cssEscape(String(item.index)) + '"]');
      if (!row) return;

      if (clearFilter && filterInput.value) {
        filterInput.value = '';
      }

      collapsedGroups.delete(row.dataset.groupId);
      updateTable();

      for (const candidate of itemRows) candidate.classList.toggle('active', candidate === row);
      row.scrollIntoView({ block: 'center', inline: 'nearest' });

      if (focusPreview) focusInPreview(item);
    }

    function findItemFromPayload(payload) {
      if (payload.snapshotId && itemBySnapshotId.has(payload.snapshotId)) {
        return itemBySnapshotId.get(payload.snapshotId);
      }

      if (payload.periodKey && itemByPeriodKey.has(payload.periodKey)) {
        return itemByPeriodKey.get(payload.periodKey);
      }

      return items.find((item) => {
        if (payload.ga_label && item.ga_label !== payload.ga_label) return false;
        if (payload.ga_action && item.ga_action !== payload.ga_action) return false;
        if (payload.href && item.href !== payload.href) return false;
        return payload.ga_label || payload.ga_action || payload.href;
      });
    }

    function installPreviewClickBridge() {
      const doc = getPreviewDocument();
      if (!doc || doc.__gaSnapshotClickBridgeInstalled) return;
      doc.__gaSnapshotClickBridgeInstalled = true;

      doc.addEventListener(
        'click',
        (event) => {
          event.preventDefault();
          event.stopPropagation();

          const item = findItemFromPreviewTarget(event.target);
          if (item) activateItem(item, { clearFilter: true, focusPreview: true });
        },
        true,
      );

      const style = doc.createElement('style');
      style.textContent = 'a, button, [role="button"], [ga_label] { cursor: pointer !important; }';
      doc.head?.append(style);
    }

    function findItemFromPreviewTarget(target) {
      if (!target || typeof target.closest !== 'function') return null;

      const idElement = target.closest('[data-ga-snapshot-id]');
      const snapshotId = idElement?.getAttribute('data-ga-snapshot-id');
      if (snapshotId && itemBySnapshotId.has(snapshotId)) return itemBySnapshotId.get(snapshotId);

      const highlightElement = target.closest('[data-ga-highlight-ids]');
      const highlightIds = (highlightElement?.getAttribute('data-ga-highlight-ids') || '').split(/\\s+/).filter(Boolean);
      for (const highlightId of highlightIds) {
        if (itemBySnapshotId.has(highlightId)) return itemBySnapshotId.get(highlightId);
      }

      const labelElement = target.closest('[ga_label]');
      if (!labelElement) return null;

      const gaLabel = labelElement.getAttribute('ga_label') || '';
      const gaAction = labelElement.closest('[ga_action]')?.getAttribute('ga_action') || null;
      const anchor = labelElement.closest('a[href]');
      const href = anchor?.href || null;

      return findItemFromPayload({ ga_label: gaLabel, ga_action: gaAction, href });
    }

    function focusInPreview(item) {
      const doc = getPreviewDocument();
      if (!item || !doc) return;

      const target = findTarget(doc, item);
      if (!target) return;
      revealTargetContext(target);
      revealHiddenContext(target);
      const highlightTarget = resolveHighlightTarget(doc, target);

      highlightTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      highlightedElement = highlightTarget;
      doc.defaultView.requestAnimationFrame(() => drawHighlightBoxes(doc, [highlightTarget]));
    }

    function getPreviewDocument() {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    }

    function findTarget(doc, item) {
      if (item.snapshotId) {
        const direct = doc.querySelector('[data-ga-snapshot-id="' + cssEscape(item.snapshotId) + '"]');
        if (direct) {
          return direct.closest('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]') || direct;
        }

        const highlighted = doc.querySelector('[data-ga-highlight-ids~="' + cssEscape(item.snapshotId) + '"]');
        if (highlighted) return highlighted;
      }

      for (const selector of [item.clickableSelector, item.selector]) {
        if (!selector) continue;

        try {
          const element = doc.querySelector(selector);
          if (element) return element;
        } catch {
          continue;
        }
      }

      const candidates = Array.from(doc.querySelectorAll('[ga_label]')).filter(
        (element) => element.getAttribute('ga_label') === item.ga_label,
      );
      const actionMatches = candidates.filter(
        (element) => (element.closest('[ga_action]')?.getAttribute('ga_action') || null) === item.ga_action,
      );
      const hrefMatches = actionMatches.filter((element) => {
        const anchor = element.closest('a[href]');
        return item.href && anchor?.href === item.href;
      });
      const fallback = hrefMatches[0] || actionMatches[0] || candidates[0] || null;

      if (fallback) {
        return fallback.closest('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]') || fallback;
      }

      return null;
    }

    function revealTargetContext(element) {
      const slide = element.closest?.('.swiper-slide');
      const wrapper = slide?.parentElement;

      if (slide && wrapper) {
        const offset = slide.offsetLeft || 0;
        rememberElementState(wrapper);
        wrapper.style.transitionDuration = '0ms';
        wrapper.style.transitionProperty = 'none';
        wrapper.style.transform = 'translate3d(' + -offset + 'px, 0px, 0px)';

        wrapper.querySelectorAll('.swiper-slide-active, .swiper-slide-prev, .swiper-slide-next').forEach((candidate) => {
          rememberElementState(candidate);
          candidate.classList.remove('swiper-slide-active', 'swiper-slide-prev', 'swiper-slide-next');
        });

        rememberElementState(slide);
        slide.classList.add('swiper-slide-active');
        if (slide.previousElementSibling) rememberElementState(slide.previousElementSibling);
        slide.previousElementSibling?.classList.add('swiper-slide-prev');
        if (slide.nextElementSibling) rememberElementState(slide.nextElementSibling);
        slide.nextElementSibling?.classList.add('swiper-slide-next');
      }

      let current = element.parentElement;
      while (current && current !== element.ownerDocument.body) {
        const style = element.ownerDocument.defaultView.getComputedStyle(current);
        const canScrollX = /(auto|scroll)/.test(style.overflowX) && current.scrollWidth > current.clientWidth;

        if (canScrollX) {
          const currentRect = current.getBoundingClientRect();
          const elementRect = element.getBoundingClientRect();
          current.scrollLeft += elementRect.left - currentRect.left - current.clientWidth / 2 + elementRect.width / 2;
          break;
        }

        current = current.parentElement;
      }
    }

    function revealHiddenContext(element) {
      const doc = element.ownerDocument;
      const win = doc.defaultView;
      let current = element;

      while (current && current !== doc.body && current !== doc.documentElement) {
        rememberElementState(current);
        if (current.hasAttribute?.('hidden')) current.removeAttribute('hidden');

        const style = win.getComputedStyle(current);
        const rect = current.getBoundingClientRect();

        if (style.display === 'none') {
          current.style.display = preferredDisplay(current);
        }

        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          current.style.visibility = 'visible';
        }

        if (Number(style.opacity || '1') === 0) {
          current.style.opacity = '1';
        }

        if ((rect.width === 0 || rect.height === 0) && current !== element) {
          current.style.maxWidth = 'none';
          current.style.maxHeight = 'none';
          if (style.height === '0px') current.style.height = 'auto';
          if (style.overflow === 'hidden') current.style.overflow = 'visible';
        }

        current.classList?.add?.('on', 'active', 'is-active');
        current = current.parentElement;
      }

      const card = element.closest?.('.item-card, .flipcard, .swiper-slide');
      if (card) {
        rememberElementState(card);
        card.style.visibility = 'visible';
        card.style.opacity = '1';
        card.style.backfaceVisibility = 'visible';
        card.style.transformStyle = 'flat';
      }
    }

    function preferredDisplay(element) {
      const tagName = element.tagName?.toLowerCase();
      if (tagName === 'span' || tagName === 'img' || tagName === 'button' || tagName === 'a') return 'inline-block';
      if (tagName === 'li') return 'list-item';
      if (tagName === 'tr') return 'table-row';
      if (tagName === 'td' || tagName === 'th') return 'table-cell';
      return 'block';
    }

    function drawHighlightBoxes(doc, elements) {
      const layer = ensureHighlightLayer(doc);
      layer.replaceChildren();
      const win = doc.defaultView;
      const uniqueElements = Array.from(new Set(elements.filter(Boolean)));

      for (const element of uniqueElements) {
        const rect = element.getBoundingClientRect();
        const width = Math.max(rect.width, 24);
        const height = Math.max(rect.height, 24);
        const box = doc.createElement('div');
        box.className = 'ga-snapshot-highlight-box';
        box.style.left = rect.left + win.scrollX + 'px';
        box.style.top = rect.top + win.scrollY + 'px';
        box.style.width = width + 'px';
        box.style.height = height + 'px';
        layer.append(box);
      }

      layer.hidden = uniqueElements.length === 0;
    }

    function ensureHighlightLayer(doc) {
      let layer = doc.getElementById('ga-snapshot-highlight-layer');
      if (layer) return layer;

      const style = doc.createElement('style');
      style.textContent = [
        'html, body, * { scroll-behavior: auto !important; }',
        '#ga-snapshot-highlight-layer {',
        '  position: absolute;',
        '  inset: 0;',
        '  z-index: 2147483647;',
        '  pointer-events: none;',
        '}',
        '.ga-snapshot-highlight-box {',
        '  position: absolute;',
        '  z-index: 2147483647;',
        '  pointer-events: none;',
        '  box-sizing: border-box;',
        '  border: 4px solid #f05a28;',
        '  border-radius: 6px;',
        '  background: rgba(240, 90, 40, 0.08);',
        '  box-shadow: 0 0 0 2px #fff, 0 0 0 7px rgba(240, 90, 40, 0.24);',
        '}',
      ].join('\\n');
      doc.head?.append(style);

      layer = doc.createElement('div');
      layer.id = 'ga-snapshot-highlight-layer';
      layer.hidden = true;
      doc.body.append(layer);
      return layer;
    }

    function resetPreviewContext(doc = getContentDocument()) {
      if (!doc) return;

      for (const restore of revealRestorers.slice().reverse()) {
        restore();
      }
      revealRestorers = [];
      revealedElements = new Set();

      doc.getElementById('ga-snapshot-highlight-layer')?.remove();
      doc.getElementById('ga-snapshot-highlight-box')?.remove();
    }

    function rememberElementState(element) {
      if (!element || revealedElements.has(element)) return;
      revealedElements.add(element);

      const className = element.getAttribute?.('class');
      const styleText = element.getAttribute?.('style');
      const hadHidden = element.hasAttribute?.('hidden') || false;

      revealRestorers.push(() => {
        if (!element.isConnected) return;
        if (className === null || className === undefined) element.removeAttribute?.('class');
        else element.setAttribute?.('class', className);

        if (styleText === null || styleText === undefined) element.removeAttribute?.('style');
        else element.setAttribute?.('style', styleText);

        if (hadHidden) element.setAttribute?.('hidden', '');
        else element.removeAttribute?.('hidden');
      });
    }

    function resolveHighlightTarget(doc, element) {
      if (isElementVisible(element)) return element;

      const id = element.getAttribute?.('id');
      if (id) {
        const label = doc.querySelector('label[for="' + cssEscape(id) + '"]');
        if (label && isElementVisible(label)) return label;
      }

      const closestLabel = element.closest?.('label');
      if (closestLabel && isElementVisible(closestLabel)) return closestLabel;

      let current = element.parentElement;
      while (current && current !== doc.body) {
        if (isElementVisible(current)) return current;
        current = current.parentElement;
      }

      return element;
    }

    function isElementVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function cssEscape(value) {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }
  </script>
</body>
</html>`;
}

function debugCapture(label, payload) {
  if (process.env.DEBUG_CAPTURE !== '1') return;
  console.log(`[capture:${label}] ${JSON.stringify(payload)}`);
}

async function getPageMetrics(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
      document.documentElement.clientWidth,
    ),
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      document.documentElement.clientHeight,
    ),
  }));
}

async function waitForVisualContent(page) {
  await page.waitForTimeout(650);
  await page.evaluate(async () => {
    await document.fonts?.ready?.catch?.(() => {});

    const visibleImages = Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect();
      return (
        rect.bottom >= -100 &&
        rect.top <= window.innerHeight + 100 &&
        rect.right >= -100 &&
        rect.left <= window.innerWidth + 100
      );
    });

    await Promise.allSettled(
      visibleImages.map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return;
        if (typeof image.decode === 'function') {
          await image.decode();
          return;
        }

        await new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
          window.setTimeout(resolve, 1500);
        });
      }),
    );
  });
  await page.waitForTimeout(250);
}

async function collectGaElements(page, pageId) {
  return page.evaluate((snapshotPageId) => {
    const contentRoot = findContentRoot();
    const rawElements = Array.from(document.querySelectorAll('[ga_label]'));
    const elements = [];
    const domElements = [];
    const excluded = [];
    const periodKeyCounts = new Map();

    for (const [rawIndex, labelElement] of rawElements.entries()) {
      const actionElement = labelElement.closest('[ga_action]');
      const clickableElement =
        labelElement.closest('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]') ||
        labelElement;
      const measurementElement = getMeasurementElement(labelElement, clickableElement);
      const snapshotId = `${snapshotPageId}-${String(rawIndex + 1).padStart(4, '0')}`;
      const domReasons = getDomExclusionReasons(labelElement, clickableElement, contentRoot);
      const screenReasons = [...domReasons];
      if (!isVisible(labelElement) || !isVisible(clickableElement)) screenReasons.push('hidden');
      if (!intersectsCapturedPage(clickableElement)) screenReasons.push('outside-screenshot');
      const labelRect = rectToObject(labelElement.getBoundingClientRect());
      const clickableRect = rectToObject(measurementElement.getBoundingClientRect());
      const visible = isVisible(labelElement) && isVisible(clickableElement);
      const inViewport = intersectsViewport(clickableElement);
      const gaAction = actionElement?.getAttribute('ga_action') || null;
      const gaLabel = labelElement.getAttribute('ga_label') || '';
      const href = getHref(clickableElement);
      const actionSelector = actionElement ? cssPath(actionElement) : null;
      const labelSelector = cssPath(labelElement);
      const clickableSelector = cssPath(clickableElement);
      const periodBaseKey = `${snapshotPageId}:${hashString([gaAction, gaLabel, href].join('|'))}`;
      const periodOrdinal = (periodKeyCounts.get(periodBaseKey) || 0) + 1;
      periodKeyCounts.set(periodBaseKey, periodOrdinal);
      const periodKey = `${periodBaseKey}:${periodOrdinal}`;

      labelElement.setAttribute('data-ga-snapshot-id', snapshotId);
      appendTokenAttribute(measurementElement, 'data-ga-highlight-ids', snapshotId);
      appendTokenAttribute(clickableElement, 'data-ga-highlight-ids', snapshotId);

      const item = {
        snapshotId,
        highlightSnapshotId: snapshotId,
        periodKey,
        stableKey: `${snapshotPageId}:${hashString([gaAction, gaLabel, href, actionSelector].join('|'))}`,
        sourceIndex: rawIndex + 1,
        ga_action: gaAction,
        ga_label: gaLabel,
        text: getMeaningfulText(clickableElement, labelElement),
        href,
        labelTag: labelElement.tagName.toLowerCase(),
        clickableTag: clickableElement.tagName.toLowerCase(),
        selector: labelSelector,
        actionSelector,
        clickableSelector,
        labelBBox: withPageOffset(labelRect),
        clickableBBox: withPageOffset(clickableRect),
        visible,
        inViewport,
        status: visible ? (inViewport ? 'visible' : 'offscreen') : 'hidden',
        domHash: hashString(labelElement.outerHTML),
      };

      if (!domReasons.length) {
        domElements.push(item);
      }

      if (screenReasons.length) {
        excluded.push({ ...item, excludedReasons: screenReasons });
      } else {
        elements.push(item);
      }
    }

    const sortedElements = sortItemsAndReindex(elements);
    const sortedDomElements = sortItemsAndReindex(domElements);

    const excludedCounts = {};
    for (const item of excluded) {
      for (const reason of item.excludedReasons) {
        excludedCounts[reason] = (excludedCounts[reason] || 0) + 1;
      }
    }

    return {
      counts: {
        rawGaLabelElements: rawElements.length,
        contentGaLabelElements: sortedElements.length,
        contentDomGaLabelElements: sortedDomElements.length,
        excludedGaLabelElements: excluded.length,
        missingGaAction: sortedElements.filter((item) => !item.ga_action).length,
        missingDomGaAction: sortedDomElements.filter((item) => !item.ga_action).length,
      },
      excludedCounts,
      elements: sortedElements,
      domElements: sortedDomElements,
      excludedSamples: excluded.slice(0, 20),
    };

    function findContentRoot() {
      return (
        document.querySelector('main') ||
        document.querySelector('#content') ||
        document.querySelector('#contents') ||
        document.querySelector('.content') ||
        document.querySelector('.contents') ||
        document.querySelector('#container') ||
        document.querySelector('.container') ||
        document.body
      );
    }

    function sortItemsAndReindex(items) {
      return items
        .slice()
        .sort((left, right) => {
          const leftY = normalizeSortCoordinate(left.clickableBBox.y);
          const rightY = normalizeSortCoordinate(right.clickableBBox.y);

          if (leftY !== rightY) return leftY - rightY;
          if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1;
          if (left.visible !== right.visible) return left.visible ? -1 : 1;

          const leftX = normalizeSortCoordinate(left.clickableBBox.x);
          const rightX = normalizeSortCoordinate(right.clickableBBox.x);
          if (leftX !== rightX) return leftX - rightX;

          return left.sourceIndex - right.sourceIndex;
        })
        .map((item, index) => ({ index: index + 1, ...item }));
    }

    function normalizeSortCoordinate(value) {
      if (typeof value !== 'number' || Number.isNaN(value)) return Number.MAX_SAFE_INTEGER;
      return Math.round(value);
    }

    function getDomExclusionReasons(element, clickableElement, root) {
      const reasons = [];
      if (root && root !== document.body && !root.contains(element)) reasons.push('outside-content-root');
      if (isInsideShell(element)) reasons.push('gnb-header-footer');
      if (isInsidePopup(element)) reasons.push('popup');
      if (isFixedOverlay(element)) reasons.push('floating-overlay');
      return reasons;
    }

    function isInsideShell(element) {
      return Boolean(
        element.closest(
          [
            'header',
            'footer',
            'nav',
            '[role="navigation"]',
            '[role="banner"]',
            '[role="contentinfo"]',
            '#gnb',
            '.gnb',
            '[id*="gnb" i]',
            '[class*="gnb" i]',
            '#footer',
            '.footer',
            '[id*="footer" i]',
            '[class*="footer" i]',
          ].join(','),
        ),
      );
    }

    function isInsidePopup(element) {
      return Boolean(
        element.closest(
          [
            'dialog',
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[class*="popup" i]',
            '[id*="popup" i]',
            '[class*="modal" i]',
            '[id*="modal" i]',
            '[class*="layer-pop" i]',
            '[class*="layer_popup" i]',
          ].join(','),
        ),
      );
    }

    function isFixedOverlay(element) {
      const fixedAncestor = element.closest('*');
      let current = fixedAncestor;

      while (current && current !== document.body && current !== document.documentElement) {
        const style = window.getComputedStyle(current);
        const rect = current.getBoundingClientRect();
        const zIndex = Number.parseInt(style.zIndex || '0', 10);

        if (
          (style.position === 'fixed' || style.position === 'sticky') &&
          zIndex >= 10 &&
          rect.width >= window.innerWidth * 0.6 &&
          rect.height >= 40
        ) {
          return true;
        }

        current = current.parentElement;
      }

      return false;
    }

    function isVisible(element) {
      if (!(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function intersectsViewport(element) {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    }

    function intersectsCapturedPage(element) {
      const rect = element.getBoundingClientRect();
      const pageX = rect.x + window.scrollX;
      const pageY = rect.y + window.scrollY;
      const captureWidth = window.innerWidth;
      const captureHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        document.documentElement.clientHeight,
      );

      return (
        pageX + rect.width > 0 &&
        pageX < captureWidth &&
        pageY + rect.height > 0 &&
        pageY < captureHeight
      );
    }

    function rectToObject(rect) {
      return {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left),
      };
    }

    function withPageOffset(rect) {
      return {
        x: round(rect.x + window.scrollX),
        y: round(rect.y + window.scrollY),
        width: rect.width,
        height: rect.height,
      };
    }

    function normalizeText(text) {
      return text.replace(/\s+/g, ' ').trim().slice(0, 180);
    }

    function getMeaningfulText(clickableElement, labelElement) {
      const imageAlt = labelElement.querySelector?.('img[alt]')?.getAttribute('alt');
      const clickableImageAlt = clickableElement.querySelector?.('img[alt]')?.getAttribute('alt');
      const associatedLabelText = getAssociatedLabel(labelElement)?.innerText;
      const candidates = [
        labelElement.getAttribute('aria-label'),
        labelElement.getAttribute('title'),
        labelElement.getAttribute('alt'),
        associatedLabelText,
        imageAlt,
        clickableElement.getAttribute('aria-label'),
        clickableElement.getAttribute('title'),
        clickableElement.getAttribute('alt'),
        clickableImageAlt,
        clickableElement.getAttribute('value'),
        cleanTextContent(clickableElement),
      ];

      for (const candidate of candidates) {
        const text = normalizeText(candidate || '');
        if (!text) continue;
        if (looksLikeCss(text)) continue;
        return text;
      }

      return '';
    }

    function getMeasurementElement(labelElement, clickableElement) {
      if (isVisible(clickableElement)) return clickableElement;

      const associatedLabel = getAssociatedLabel(labelElement);
      if (associatedLabel && isVisible(associatedLabel)) return associatedLabel;

      const closestLabel = labelElement.closest?.('label') || clickableElement.closest?.('label');
      if (closestLabel && isVisible(closestLabel)) return closestLabel;

      let current = labelElement.parentElement || clickableElement.parentElement;
      while (current && current !== document.body) {
        if (isVisible(current)) return current;
        current = current.parentElement;
      }

      return clickableElement;
    }

    function getAssociatedLabel(element) {
      const id = element.getAttribute?.('id');
      if (!id) return null;

      try {
        return document.querySelector(`label[for="${escapeCssString(id)}"]`);
      } catch {
        return null;
      }
    }

    function escapeCssString(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function cleanTextContent(element) {
      const clone = element.cloneNode(true);
      clone.querySelectorAll?.('script,style,noscript,template,svg').forEach((node) => node.remove());
      return clone.textContent || '';
    }

    function looksLikeCss(text) {
      return text.startsWith('/*') || text.includes('{') || text.includes('}') || text.includes('function(');
    }

    function getHref(element) {
      const anchor = element.closest?.('a[href]') || (element.matches?.('a[href]') ? element : null);
      return anchor ? anchor.href : null;
    }

    function cssPath(element) {
      if (!(element instanceof Element)) return '';
      const parts = [];
      let current = element;

      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        let selector = current.nodeName.toLowerCase();
        const id = current.getAttribute('id');

        if (id && !/^\d/.test(id)) {
          selector += `#${escapeCssIdent(id)}`;
          parts.unshift(selector);
          break;
        }

        const classNames = Array.from(current.classList || [])
          .filter(Boolean)
          .slice(0, 2)
          .map((className) => `.${escapeCssIdent(className)}`)
          .join('');

        selector += classNames;

        if (current.parentElement) {
          const sameTagSiblings = Array.from(current.parentElement.children).filter(
            (sibling) => sibling.nodeName === current.nodeName,
          );
          if (sameTagSiblings.length > 1) {
            selector += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
          }
        }

        parts.unshift(selector);
        current = current.parentElement;
      }

      return `body > ${parts.join(' > ')}`;
    }

    function escapeCssIdent(value) {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function hashString(value) {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) {
        hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
      }
      return `h${(hash >>> 0).toString(16)}`;
    }

    function appendTokenAttribute(element, name, token) {
      if (!element || !token) return;
      const tokens = new Set((element.getAttribute(name) || '').split(/\s+/).filter(Boolean));
      tokens.add(token);
      element.setAttribute(name, Array.from(tokens).join(' '));
    }

    function round(value) {
      return Math.round(value * 100) / 100;
    }
  }, pageId);
}

function renderReport(snapshot) {
  const rows = snapshot.elements
    .map(
      (item) => `
        <tr data-index="${item.index}">
          <td>${item.index}</td>
          <td><code>${escapeHtml(item.ga_action || '(missing)')}</code></td>
          <td><code>${escapeHtml(item.ga_label)}</code></td>
          <td>${escapeHtml(item.text || '')}</td>
          <td>${escapeHtml(item.clickableTag)}</td>
          <td>${item.href ? `<a href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">link</a>` : ''}</td>
        </tr>`,
    )
    .join('\n');

  const boxes = snapshot.elements
    .map((item) => {
      const { x, y, width, height } = item.clickableBBox;
      return `
        <button class="box" data-index="${item.index}" style="left:${x}px;top:${y}px;width:${Math.max(
          width,
          1,
        )}px;height:${Math.max(height, 1)}px;" title="${escapeHtml(item.index)}. ${escapeHtml(
          item.ga_action || '(missing)',
        )} / ${escapeHtml(item.ga_label)}">
          <span>${item.index}</span>
        </button>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(snapshot.label)} GA Snapshot</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
      color: #1d1f24;
      background: #f4f6f8;
    }

    body {
      margin: 0;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid #d9dee7;
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(10px);
    }

    h1 {
      margin: 0;
      font-size: 18px;
    }

    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      font-size: 13px;
      color: #4c5566;
    }

    .meta a {
      color: #0b6bcb;
      font-weight: 600;
      text-decoration: none;
    }

    .meta a:hover {
      text-decoration: underline;
    }

    main {
      display: grid;
      grid-template-columns: minmax(420px, 1fr) minmax(520px, 0.8fr);
      gap: 16px;
      padding: 16px;
    }

    .panel {
      min-width: 0;
      background: #fff;
      border: 1px solid #dfe4ec;
      border-radius: 8px;
      overflow: hidden;
    }

    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid #e5e9f0;
      font-size: 14px;
    }

    .stage-wrap {
      overflow: auto;
      max-height: calc(100vh - 150px);
      background: #e8ecf2;
    }

    .stage {
      position: relative;
      width: ${snapshot.screenshot.width}px;
      min-height: ${snapshot.screenshot.height}px;
      background: white;
    }

    .stage img {
      display: block;
      width: ${snapshot.screenshot.width}px;
      height: auto;
    }

    .box {
      position: absolute;
      margin: 0;
      padding: 0;
      border: 2px solid #f05a28;
      background: rgba(240, 90, 40, 0.12);
      cursor: pointer;
    }

    .box span {
      position: absolute;
      top: -1px;
      left: -1px;
      display: grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      background: #f05a28;
      color: white;
      font-size: 11px;
      font-weight: 700;
    }

    .box.active {
      border-color: #0b6bcb;
      background: rgba(11, 107, 203, 0.18);
      z-index: 2;
    }

    .box.active span {
      background: #0b6bcb;
    }

    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 150px);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      padding: 9px 10px;
      border-bottom: 1px solid #edf0f5;
      vertical-align: top;
      text-align: left;
    }

    th {
      position: sticky;
      top: 0;
      background: #fbfcfe;
      z-index: 1;
      font-size: 12px;
      color: #596579;
    }

    tr.active {
      background: #eaf3ff;
    }

    code {
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    @media (max-width: 980px) {
      main {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(snapshot.label)}</h1>
      <div class="meta">
        <span>${escapeHtml(snapshot.finalUrl)}</span>
        <span>${escapeHtml(snapshot.capturedAt)}</span>
      </div>
    </div>
    <div class="meta">
      <strong>${snapshot.counts.contentGaLabelElements}</strong>
      <span>visible labels</span>
      <strong>${snapshot.counts.contentDomGaLabelElements}</strong>
      <span>DOM labels</span>
      <span>${snapshot.counts.missingGaAction} missing action</span>
      <a href="page-static.html">static HTML</a>
      <a href="page-live.html">live HTML</a>
      <a href="page-overlay.html">HTML overlay</a>
      ${snapshot.archives?.mhtml ? '<a href="page.mhtml">MHTML</a>' : ''}
      <a href="ga-dom-elements.csv">DOM CSV</a>
    </div>
  </header>
  <main>
    <section class="panel">
      <h2>Screenshot Overlay</h2>
      <div class="stage-wrap">
        <div class="stage">
          <img src="fullpage.png" alt="Full-page screenshot">
          ${boxes}
        </div>
      </div>
    </section>
    <section class="panel">
      <h2>GA Attributes</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>ga_action</th>
              <th>ga_label</th>
              <th>Text</th>
              <th>Tag</th>
              <th>Href</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const boxes = Array.from(document.querySelectorAll('.box'));
    const rows = Array.from(document.querySelectorAll('tbody tr'));

    function setActive(index) {
      for (const element of boxes.concat(rows)) {
        element.classList.toggle('active', element.dataset.index === index);
      }
    }

    for (const element of boxes.concat(rows)) {
      element.addEventListener('mouseenter', () => setActive(element.dataset.index));
      element.addEventListener('focus', () => setActive(element.dataset.index));
      element.addEventListener('mouseleave', () => setActive(''));
      element.addEventListener('blur', () => setActive(''));
      element.addEventListener('click', () => {
        const target = document.querySelector('.box[data-index="' + element.dataset.index + '"]');
        target?.scrollIntoView({ block: 'center', inline: 'center' });
      });
    }
  </script>
</body>
</html>`;
}

function renderIndex(runId, targetSummaries) {
  const cards = targetSummaries
    .map(
      (target) => `
        <article class="card">
          <strong>${escapeHtml(target.id)}</strong>
          <span>${escapeHtml(target.title || '')}</span>
          <dl>
            <div><dt>visible labels</dt><dd>${target.counts.contentGaLabelElements}</dd></div>
            <div><dt>DOM labels</dt><dd>${target.counts.contentDomGaLabelElements}</dd></div>
            <div><dt>missing action</dt><dd>${target.counts.missingGaAction}</dd></div>
          </dl>
          <div class="links">
            <a href="./${escapeHtml(target.id)}/page-static.html">review</a>
            <a href="./${escapeHtml(target.id)}/ga-dom-elements.csv">DOM CSV</a>
            <a href="./${escapeHtml(target.id)}/ga-dom-elements.json">DOM JSON</a>
          </div>
        </article>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GA Snapshot ${escapeHtml(runId)}</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f232b;
      background: #f5f7fa;
    }

    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 20px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
    }

    p {
      margin: 0 0 20px;
      color: #5a6475;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
    }

    .card {
      padding: 18px;
      border: 1px solid #dde3ec;
      border-radius: 8px;
      background: white;
      color: inherit;
    }

    .card strong,
    .card span {
      display: block;
    }

    .card strong {
      margin-bottom: 4px;
      font-size: 18px;
    }

    .card span {
      margin-bottom: 14px;
      color: #5a6475;
    }

    dl {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin: 0;
    }

    dt {
      font-size: 12px;
      color: #6b7483;
    }

    dd {
      margin: 2px 0 0;
      font-size: 20px;
      font-weight: 700;
    }

    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }

    .links a {
      padding: 7px 9px;
      border: 1px solid #d7deea;
      border-radius: 6px;
      color: #0b6bcb;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      background: #fbfcff;
    }

    .links a:hover {
      border-color: #0b6bcb;
    }
  </style>
</head>
<body>
  <main>
    <h1>GA Snapshot ${escapeHtml(runId)}</h1>
    <p>왼쪽은 정적 HTML 미리보기, 오른쪽은 DOM 기준 GA Attributes 목록입니다.</p>
    <div class="grid">${cards}</div>
  </main>
</body>
</html>`;
}

async function pruneSnapshotRunsByDate(root, protectedRunId) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const runIdsByDate = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const date = dateFromRunId(entry.name);
    if (!date) continue;
    const runIds = runIdsByDate.get(date) || [];
    runIds.push(entry.name);
    runIdsByDate.set(date, runIds);
  }

  for (const runIds of runIdsByDate.values()) {
    const keepRunId = runIds.includes(protectedRunId)
      ? protectedRunId
      : runIds.slice().sort((left, right) => right.localeCompare(left))[0];

    for (const runId of runIds) {
      if (runId === keepRunId) continue;
      await fs.rm(path.join(root, runId), { recursive: true, force: true });
    }
  }
}

async function rebuildSnapshotCatalog(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const runSummaries = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runDir = path.join(root, entry.name);
    const summaryPath = path.join(runDir, 'summary.json');
    const summary = await readJsonFile(summaryPath);
    if (!summary) continue;

    const runId = summary.runId || entry.name;
    const date = dateFromRunId(runId) || dateFromIso(summary.capturedAt);
    if (!date) continue;

    runSummaries.push({ runDir, runId, date, summary });
  }

  const latestByDate = new Map();
  for (const item of runSummaries) {
    const current = latestByDate.get(item.date);
    if (!current || item.runId.localeCompare(current.runId) > 0) {
      latestByDate.set(item.date, item);
    }
  }

  const runs = [];
  const selectedRuns = Array.from(latestByDate.values()).sort((left, right) => right.runId.localeCompare(left.runId));

  for (const item of selectedRuns) {
    const runTargets = Array.isArray(item.summary.targets) ? item.summary.targets : [];
    const catalogTargets = [];

    for (const target of runTargets) {
      const targetDir = path.join(item.runDir, target.id);
      const snapshot = await readJsonFile(path.join(targetDir, 'ga-elements.json'));
      const domElements = (await readJsonFile(path.join(targetDir, 'ga-dom-elements.json'))) || [];
      const page = snapshot?.page || target.page || {};
      const compactElements = Array.isArray(domElements)
        ? domElements.map((element) => ({
            periodKey: element.periodKey || makePeriodKey(target.id, element),
            stableKey: element.stableKey || null,
            snapshotId: element.snapshotId || null,
            ga_action: element.ga_action || null,
            ga_label: element.ga_label || '',
            ga4MetricKey: makeGa4MetricKey(element.ga_action || '(missing)', element.ga_label || ''),
            href: element.href || null,
            index: element.index || null,
            sourceIndex: element.sourceIndex || null,
          }))
        : [];
      const relativeTargetDir = `${encodeURIComponent(item.runId)}/${encodeURIComponent(target.id)}`;
      const compactElementsFile = 'ga-elements-compact.json';

      await fs.writeFile(
        path.join(targetDir, compactElementsFile),
        `${JSON.stringify({ runId: item.runId, date: item.date, targetId: target.id, elements: compactElements }, null, 2)}\n`,
      );

      catalogTargets.push({
        id: target.id,
        label: target.label || snapshot?.label || target.id,
        title: target.title || snapshot?.title || '',
        url: target.url || snapshot?.requestedUrl || target.finalUrl || '',
        finalUrl: target.finalUrl || snapshot?.finalUrl || '',
        loadError: target.loadError || null,
        page,
        counts: target.counts || snapshot?.counts || {},
        excludedCounts: target.excludedCounts || snapshot?.excludedCounts || {},
        contentPath: `${relativeTargetDir}/page-content.html`,
        reviewPath: `${relativeTargetDir}/page-static.html`,
        elementsPath: `${relativeTargetDir}/${compactElementsFile}`,
        domJsonPath: `${relativeTargetDir}/ga-dom-elements.json`,
        domCsvPath: `${relativeTargetDir}/ga-dom-elements.csv`,
      });
    }

    if (catalogTargets.length) {
      runs.push({
        runId: item.runId,
        date: item.date,
        capturedAt: item.summary.capturedAt || null,
        targets: catalogTargets,
      });
    }
  }

  const catalog = {
    generatedAt: new Date().toISOString(),
    ga4: {
      ...GA4_CONFIG,
      mode: 'runtime-api',
      status: 'runtime-api',
    },
    runs,
  };

  await fs.writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'index.html'), renderSnapshotCatalog());
}

function renderSnapshotCatalog() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GA Snapshot Catalog</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1d2430;
      background: #eef2f7;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      overflow: hidden;
      user-select: none;
    }

    body:not(.is-column-resizing) .panel,
    body:not(.is-column-resizing) .panel * {
      -webkit-user-select: text !important;
      user-select: text !important;
    }

    body.is-dragging iframe {
      pointer-events: none;
    }

    body.is-column-resizing,
    body.is-column-resizing * {
      cursor: col-resize !important;
      user-select: none !important;
    }

    .period-app {
      display: grid;
      grid-template-rows: auto 1fr;
      height: 100vh;
      min-width: 0;
      min-height: 0;
    }

    .bar {
      display: grid;
      grid-template-columns: auto minmax(170px, 260px) minmax(150px, 190px) minmax(150px, 190px) minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-width: 0;
      padding: 12px 14px;
      border-bottom: 1px solid #d7deea;
      background: #fff;
    }

    h1 {
      margin: 0;
      font-size: 16px;
      white-space: nowrap;
    }

    label {
      display: grid;
      gap: 4px;
      color: #596579;
      font-size: 11px;
      font-weight: 700;
    }

    select,
    input {
      width: 100%;
      height: 34px;
      padding: 0 10px;
      border: 1px solid #cfd7e5;
      border-radius: 6px;
      background: #fbfcff;
      color: #1d2430;
      font: inherit;
      font-size: 13px;
    }

    .stats {
      display: flex;
      min-width: 0;
      gap: 12px;
      align-items: center;
      color: #596579;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .stats strong {
      color: #1d2430;
    }

    .help-button {
      white-space: nowrap;
    }

    .help-popover {
      position: fixed;
      top: 58px;
      right: 14px;
      z-index: 30;
      width: min(360px, calc(100vw - 28px));
      padding: 16px;
      border: 1px solid #bed3ef;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 16px 44px rgba(20, 31, 48, 0.18);
      color: #263244;
      font-size: 13px;
      line-height: 1.55;
    }

    .help-popover[hidden],
    .help-modal[hidden] {
      display: none;
    }

    .help-popover::before {
      content: "";
      position: absolute;
      top: -8px;
      right: 24px;
      width: 14px;
      height: 14px;
      border-top: 1px solid #bed3ef;
      border-left: 1px solid #bed3ef;
      background: #fff;
      transform: rotate(45deg);
    }

    .help-popover strong,
    .help-modal strong {
      color: #172033;
    }

    .help-popover p {
      margin: 0 0 10px;
    }

    .help-popover ul,
    .help-modal ul {
      margin: 0;
      padding-left: 18px;
    }

    .help-popover li,
    .help-modal li {
      margin: 4px 0;
    }

    .help-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }

    .help-actions button {
      height: 32px;
    }

    .help-primary {
      border-color: #0b6bcb;
      background: #0b6bcb;
      color: #fff;
    }

    .help-primary:hover {
      color: #fff;
    }

    .help-modal {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(23, 32, 51, 0.48);
    }

    .help-dialog {
      width: min(760px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      display: grid;
      grid-template-rows: auto 1fr auto;
      overflow: hidden;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 24px 70px rgba(16, 24, 40, 0.34);
    }

    .help-dialog-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 20px;
      border-bottom: 1px solid #e3e8f0;
    }

    .help-dialog-head h2 {
      margin: 0;
      font-size: 18px;
    }

    .help-dialog-body {
      overflow: auto;
      padding: 18px 20px 20px;
      color: #39465a;
      font-size: 14px;
      line-height: 1.65;
    }

    .help-section + .help-section {
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid #edf0f5;
    }

    .help-section h3 {
      margin: 0 0 8px;
      color: #172033;
      font-size: 15px;
    }

    .help-section p {
      margin: 0 0 8px;
    }

    .help-dialog-foot {
      display: flex;
      justify-content: flex-end;
      padding: 14px 20px;
      border-top: 1px solid #e3e8f0;
      background: #fbfcfe;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) 10px minmax(380px, 560px);
      gap: 0;
      min-width: 0;
      min-height: 0;
      height: 100%;
      padding: 12px;
      overflow: hidden;
    }

    .workspace.mobile {
      grid-template-columns: minmax(392px, 392px) 10px minmax(380px, 1fr);
    }

    .preview {
      min-width: 0;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow: hidden;
      border: 1px solid #d7deea;
      border-radius: 8px;
      background: #fff;
    }

    .workspace.mobile .preview {
      background: #e8edf5;
      box-shadow: 0 8px 28px rgba(20, 31, 48, 0.12);
    }

    .splitter {
      position: relative;
      width: 10px;
      height: 100%;
      cursor: col-resize;
      touch-action: none;
    }

    .splitter::before {
      content: "";
      position: absolute;
      top: 8px;
      bottom: 8px;
      left: 4px;
      width: 2px;
      border-radius: 999px;
      background: #c9d2e1;
    }

    .splitter:hover::before,
    .splitter.dragging::before {
      background: #0b6bcb;
    }

    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
      transform-origin: top center;
    }

    .panel {
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr;
      overflow: hidden;
      border: 1px solid #d7deea;
      border-radius: 8px;
      background: #fff;
    }

    .panel-head {
      padding: 14px 16px 12px;
      border-bottom: 1px solid #e5e9f0;
    }

    .panel-head h2 {
      margin: 0 0 6px;
      font-size: 16px;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid #edf0f5;
    }

    .toolbar-actions {
      display: flex;
      gap: 6px;
      white-space: nowrap;
    }

    button {
      height: 34px;
      padding: 0 10px;
      border: 1px solid #cfd7e5;
      border-radius: 6px;
      background: #fbfcff;
      color: #263244;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    button:hover {
      border-color: #0b6bcb;
      color: #0b6bcb;
    }

    .table-wrap {
      min-width: 0;
      min-height: 0;
      width: 100%;
      max-width: 100%;
      height: 100%;
      overflow: auto;
      scrollbar-gutter: stable both-edges;
    }

    table {
      width: 100%;
      min-width: 820px;
      border-collapse: collapse;
      font-size: 12px;
      table-layout: fixed;
    }

    th,
    td {
      padding: 8px 9px;
      border-bottom: 1px solid #edf0f5;
      vertical-align: top;
      text-align: left;
      overflow: hidden;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      overflow: visible;
      background: #fbfcfe;
      color: #596579;
      font-size: 11px;
    }

    .col-resizer {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 2;
      width: 14px;
      height: 100%;
      cursor: col-resize;
      touch-action: none;
    }

    .col-resizer::after {
      content: "";
      position: absolute;
      top: 8px;
      right: 5px;
      bottom: 8px;
      width: 2px;
      border-radius: 999px;
      background: transparent;
    }

    th:hover .col-resizer::after,
    .col-resizer.dragging::after {
      background: #0b6bcb;
    }

    tr[data-key] {
      cursor: default;
    }

    .panel td,
    .panel th,
    .panel code {
      cursor: text;
    }

    tr[data-key]:hover,
    tr.active {
      background: #eaf3ff;
    }

    .item-row small {
      display: block;
      margin-top: 4px;
      color: #687486;
      font-weight: 700;
      white-space: nowrap;
    }

    .total-row {
      position: sticky;
      top: 30px;
      z-index: 1;
      background: #fff8e6;
      font-weight: 800;
    }

    .total-row td {
      border-bottom-color: #e2c878;
    }

    .total-row small {
      margin-left: 8px;
      color: #687486;
      font-weight: 700;
    }

    .group-row {
      cursor: pointer;
      background: #f6f8fb;
    }

    .group-row td {
      padding: 8px 10px;
      border-bottom-color: #dfe5ee;
    }

    .group-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      color: #273244;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .group-toggle small {
      color: #687486;
      font-weight: 600;
    }

    .group-state,
    .period {
      color: #0b6bcb;
      font-weight: 700;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .metric {
      color: #1d2430;
      font-weight: 700;
      text-align: right;
      white-space: nowrap;
    }

    @media (max-width: 900px) {
      body {
        overflow: auto;
      }

      .period-app {
        height: auto;
        min-height: 100vh;
      }

      .bar {
        grid-template-columns: 1fr;
        align-items: stretch;
      }

      .stats {
        justify-content: start;
        flex-wrap: wrap;
        white-space: normal;
      }

      .help-popover {
        top: 66px;
      }

      .workspace,
      .workspace.mobile {
        grid-template-columns: 1fr;
        height: auto;
      }

      .splitter {
        display: none;
      }

      .preview,
      .panel,
      iframe {
        height: 82vh;
      }

      .panel {
        margin: 12px 0 0;
      }
    }
  </style>
</head>
<body>
  <main class="period-app">
    <section class="bar" aria-label="Snapshot controls">
      <h1>GA Snapshot</h1>
      <label>
        페이지
        <select id="targetSelect"></select>
      </label>
      <label>
        시작일
        <input id="startDate" type="date">
      </label>
      <label>
        종료일
        <input id="endDate" type="date">
      </label>
      <div class="stats" id="stats"></div>
      <button class="help-button" id="helpButton" type="button">도움말</button>
    </section>
    <section class="help-popover" id="introTip" hidden aria-label="Quick help">
      <p><strong>처음 사용하시나요?</strong></p>
      <ul>
        <li>페이지 선택으로 PC/MO 메인페이지를 전환할 수 있습니다.</li>
        <li>기간을 선택하면 해당 기간의 요소 유지기간과 GA4 데이터를 봅니다.</li>
        <li>왼쪽 요소를 클릭하면 표로, 표 행을 클릭하면 왼쪽 요소로 이동합니다.</li>
      </ul>
      <div class="help-actions">
        <button id="introClose" type="button">닫기</button>
        <button class="help-primary" id="introOpenHelp" type="button">자세히 보기</button>
      </div>
    </section>
    <section class="help-modal" id="helpModal" hidden role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="help-dialog">
        <div class="help-dialog-head">
          <h2 id="helpTitle">대시보드 도움말</h2>
          <button id="helpClose" type="button">닫기</button>
        </div>
        <div class="help-dialog-body">
          <section class="help-section">
            <h3>이 화면이 하는 일</h3>
            <p>매일 오전 10시 KST에 봇이 T world Shop PC/MO 메인페이지에 접속해서 콘텐츠 HTML을 저장합니다. 팝업은 닫고, GNB와 푸터를 제외한 콘텐츠 영역에서 <strong>ga_action</strong>, <strong>ga_label</strong> 어트리뷰트를 가진 클릭 요소를 수집합니다.</p>
            <p>왼쪽 화면은 매일 오전 10시에 봇이 사이트에 직접 들어가 캡처한 HTML 화면이고, 오른쪽 표는 선택한 기간 동안 발견된 GA 요소와 GA4 클릭 데이터를 함께 보여줍니다.</p>
          </section>
          <section class="help-section">
            <h3>페이지와 기간 선택</h3>
            <ul>
              <li><strong>페이지</strong>: T world Shop Mobile Main과 PC Main을 선택합니다.</li>
              <li><strong>시작일/종료일</strong>: 선택한 기간에 존재했던 요소를 한눈에 봅니다.</li>
              <li>기본 왼쪽 화면은 선택 기간 안에서 가장 최신 캡처본입니다.</li>
              <li>표에서 최신 캡처본에 없는 과거 요소를 클릭하면, 그 요소가 존재하던 기간 안의 가장 최신 캡처본으로 왼쪽 화면이 바뀝니다.</li>
            </ul>
          </section>
          <section class="help-section">
            <h3>GA4 데이터 기준</h3>
            <ul>
              <li>이벤트명은 <strong>click</strong>입니다.</li>
              <li>PC는 <strong>event_category = TWD_main</strong> 기준입니다.</li>
              <li>MO는 <strong>event_category = MTWD_main</strong>과 <strong>hostName = m.shop.tworld.co.kr</strong> 기준입니다.</li>
              <li>표의 수치는 <strong>값 (전체 대비 비율)</strong> 형식입니다.</li>
              <li>오늘 날짜를 포함하면 GA4 특성상 일반적으로 현재 시점 기준 약 4시간 전 데이터까지만 조회될 수 있습니다. 확정 데이터는 보통 다음 날 이후가 더 안정적입니다.</li>
            </ul>
          </section>
          <section class="help-section">
            <h3>좌우 클릭 연동</h3>
            <ul>
              <li>왼쪽 캡처 화면의 요소를 클릭하면 오른쪽 표에서 해당 행으로 이동합니다.</li>
              <li>오른쪽 표의 행을 클릭하면 왼쪽 화면이 해당 요소 위치로 이동하고 빨간 박스를 표시합니다.</li>
              <li>같은 ga_action/ga_label/유지기간을 가진 요소가 여러 개면 표에서는 하나로 합쳐지고, 반복 클릭하면 해당 요소들을 차례로 포커스합니다.</li>
              <li>왼쪽 캡처 화면의 원래 링크 이동 기능은 막혀 있습니다.</li>
            </ul>
          </section>
          <section class="help-section">
            <h3>표 사용법</h3>
            <ul>
              <li><strong>전체 펼치기/전체 접기</strong>로 ga_action 그룹을 한 번에 열고 닫을 수 있습니다.</li>
              <li>각 ga_action 그룹 행을 클릭하면 해당 그룹만 접거나 펼칩니다.</li>
              <li>검색창에서 ga_action, ga_label, 유지기간을 검색할 수 있습니다.</li>
              <li>열 경계선을 드래그해서 표 열 너비를 조정할 수 있습니다.</li>
              <li>왼쪽 화면과 표 사이 경계선을 드래그해서 화면 비율을 조정할 수 있습니다.</li>
            </ul>
          </section>
          <section class="help-section">
            <h3>유지기간</h3>
            <p>유지기간은 선택한 기간 안에서 같은 요소가 계속 발견된 날짜 구간입니다. 형식은 <strong>YYYY-MM-DD ~ YYYY-MM-DD</strong>입니다.</p>
            <p>중간에 요소가 사라졌다가 다시 생기거나, ga_action/ga_label 조합이 바뀌면 유지기간이 나뉠 수 있습니다.</p>
          </section>
          <section class="help-section">
            <h3>자동 수집</h3>
            <p>수집 봇은 매일 오전 10시에 사이트에 접속해 HTML과 GA 어트리뷰트 목록을 저장합니다. 수집이 실패하면 10분 간격으로 최대 6번 재시도하고, 성공한 날짜별 데이터는 PC/MO 각각 하나의 캡처본만 유지합니다.</p>
          </section>
        </div>
        <div class="help-dialog-foot">
          <button class="help-primary" id="helpCloseBottom" type="button">확인</button>
        </div>
      </div>
    </section>
    <section class="workspace" id="workspace">
      <section class="preview" id="preview" aria-label="Snapshot preview">
        <iframe id="contentFrame" title="Snapshot content"></iframe>
      </section>
      <div class="splitter" id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize preview and GA Attributes"></div>
      <aside class="panel" aria-label="GA Attributes">
        <div class="panel-head">
          <h2>GA Attributes</h2>
          <div class="stats" id="panelMeta"></div>
        </div>
        <div class="toolbar">
          <input id="filterInput" type="search" placeholder="ga_action, ga_label 검색">
          <div class="toolbar-actions">
            <button id="expandAll" type="button">전체 펼치기</button>
            <button id="collapseAll" type="button">전체 접기</button>
          </div>
        </div>
        <div class="table-wrap" id="tableWrap">
          <table id="gaTable">
            <colgroup id="tableColGroup">
              <col style="width: 145px">
              <col style="width: 225px">
              <col style="width: 135px">
              <col style="width: 105px">
              <col style="width: 105px">
              <col style="width: 105px">
            </colgroup>
            <thead>
              <tr>
                <th>ga_action<span class="col-resizer" data-col-index="0"></span></th>
                <th>ga_label<span class="col-resizer" data-col-index="1"></span></th>
                <th>유지 기간<span class="col-resizer" data-col-index="2"></span></th>
                <th>이벤트 수<span class="col-resizer" data-col-index="3"></span></th>
                <th>세션 수<span class="col-resizer" data-col-index="4"></span></th>
                <th>사용자 수<span class="col-resizer" data-col-index="5"></span></th>
              </tr>
            </thead>
            <tbody id="periodRows"></tbody>
          </table>
        </div>
      </aside>
    </section>
  </main>
  <script>
    const targetSelect = document.getElementById('targetSelect');
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const stats = document.getElementById('stats');
    const panelMeta = document.getElementById('panelMeta');
    const workspace = document.getElementById('workspace');
    const preview = document.getElementById('preview');
    const splitter = document.getElementById('splitter');
    const contentFrame = document.getElementById('contentFrame');
    const filterInput = document.getElementById('filterInput');
    const expandAllButton = document.getElementById('expandAll');
    const collapseAllButton = document.getElementById('collapseAll');
    const helpButton = document.getElementById('helpButton');
    const introTip = document.getElementById('introTip');
    const introClose = document.getElementById('introClose');
    const introOpenHelp = document.getElementById('introOpenHelp');
    const helpModal = document.getElementById('helpModal');
    const helpClose = document.getElementById('helpClose');
    const helpCloseBottom = document.getElementById('helpCloseBottom');
    const tableWrap = document.getElementById('tableWrap');
    const gaTable = document.getElementById('gaTable');
    const tableColGroup = document.getElementById('tableColGroup');
    const periodRows = document.getElementById('periodRows');
    const HELP_SEEN_KEY = 'ga-snapshot-help-seen-v2';
    const collapsedGroups = new Set();
    const elementsCache = new Map();
    let catalog = { runs: [] };
    let runsAscending = [];
    let periodRecords = [];
    let recordByKey = new Map();
    let recordByOccurrenceId = new Map();
    let currentRun = null;
    let currentTarget = null;
    let highlightedElement = null;
    let pendingOccurrence = null;
    let pendingRecordFocus = null;
    let activeRecordKey = null;
    let focusCycleByRecord = new Map();
    let revealRestorers = [];
    let revealedElements = new Set();
    let sourceViewportWidth = 1440;
    let isMobilePreview = false;
    let lastPreviewMode = null;
    let dragging = false;
    let layoutSyncFrame = 0;
    let periodViewRequestId = 0;
    let ga4RequestId = 0;
    let ga4RefreshTimer = null;
    let ga4Status = {
      state: 'idle',
      message: '대기',
      totals: emptyMetrics(),
      rowCount: 0,
    };

    init();

    async function init() {
      installControls();
      installSplitter();
      installColumnResizers();
      try {
        await loadCatalog();
        renderTargetOptions();
        updatePeriodView();
        scheduleStartupLayoutSync();
        window.setTimeout(showIntroTip, 700);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.textContent = 'catalog.json을 불러오지 못했습니다. npm run serve로 연 뒤 다시 확인하세요.';
        panelMeta.textContent = message;
        renderStatusRow('catalog.json 로딩 실패');
      }
    }

    async function loadCatalog() {
      const response = await fetch('catalog.json', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('catalog.json HTTP ' + response.status);
      catalog = await response.json();
      runsAscending = (catalog.runs || []).slice().sort((left, right) => {
        return left.date.localeCompare(right.date) || left.runId.localeCompare(right.runId);
      });
    }

    function renderTargetOptions() {
      const targetIds = [];
      const seen = new Set();
      for (const run of runsAscending) {
        for (const target of run.targets || []) {
          if (seen.has(target.id)) continue;
          seen.add(target.id);
          targetIds.push({ id: target.id, label: target.label || target.id });
        }
      }

      targetSelect.innerHTML = targetIds
        .map((target) => '<option value="' + escapeHtml(target.id) + '">' + escapeHtml(target.label) + '</option>')
        .join('');

      const hash = readHashState();
      if (hash.target && seen.has(hash.target)) targetSelect.value = hash.target;

      const dates = runsAscending.map((run) => run.date);
      const minDate = dates[0] || '';
      const maxDate = dates.at(-1) || '';
      startDateInput.min = minDate;
      startDateInput.max = maxDate;
      endDateInput.min = minDate;
      endDateInput.max = maxDate;
      startDateInput.value = hash.start || minDate;
      endDateInput.value = hash.end || maxDate;
    }

    function installControls() {
      targetSelect.addEventListener('change', updatePeriodView);
      startDateInput.addEventListener('change', updatePeriodView);
      endDateInput.addEventListener('change', updatePeriodView);
      filterInput.addEventListener('input', renderPeriodRows);
      expandAllButton.addEventListener('click', () => {
        collapsedGroups.clear();
        renderPeriodRows();
      });
      collapseAllButton.addEventListener('click', () => {
        for (const record of periodRecords) collapsedGroups.add(groupIdForAction(record.ga_action));
        renderPeriodRows();
      });
      helpButton.addEventListener('click', openHelp);
      introClose.addEventListener('click', hideIntroTip);
      introOpenHelp.addEventListener('click', () => {
        hideIntroTip();
        openHelp();
      });
      helpClose.addEventListener('click', closeHelp);
      helpCloseBottom.addEventListener('click', closeHelp);
      helpModal.addEventListener('click', (event) => {
        if (event.target === helpModal) closeHelp();
      });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          closeHelp();
          hideIntroTip();
        }
      });
      window.addEventListener('resize', scheduleLayoutSync);
      window.addEventListener('load', scheduleStartupLayoutSync);
      window.addEventListener('pageshow', scheduleStartupLayoutSync);
      contentFrame.addEventListener('load', () => {
        scheduleLayoutSync();
        installContentClickBridge();
        if (pendingRecordFocus) {
          highlightRecord(pendingRecordFocus.record, pendingRecordFocus.focusOccurrence);
          pendingRecordFocus = null;
        }
        if (pendingOccurrence) {
          highlightOccurrence(pendingOccurrence);
          pendingOccurrence = null;
        }
      });

      if (window.ResizeObserver) {
        const observer = new ResizeObserver(scheduleLayoutSync);
        observer.observe(workspace);
        observer.observe(tableWrap);
      }
    }

    function installColumnResizers() {
      const cols = Array.from(tableColGroup.children);
      const minWidths = [120, 160, 120, 90, 90, 90];

      for (const handle of document.querySelectorAll('.col-resizer')) {
        handle.addEventListener('pointerdown', (event) => {
          const colIndex = Number(handle.dataset.colIndex);
          const col = cols[colIndex];
          if (!col) return;

          const startX = event.clientX;
          const startWidth = col.getBoundingClientRect().width;
          handle.classList.add('dragging');
          document.body.classList.add('is-column-resizing');
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {}

          const onPointerMove = (moveEvent) => {
            const nextWidth = Math.max(minWidths[colIndex] || 100, startWidth + moveEvent.clientX - startX);
            col.style.width = nextWidth + 'px';
            syncTableWidth();
          };

          const stop = (upEvent) => {
            handle.classList.remove('dragging');
            document.body.classList.remove('is-column-resizing');
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            try {
              handle.releasePointerCapture(upEvent?.pointerId);
            } catch {}
          };

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
          event.preventDefault();
          event.stopPropagation();
        });
      }

      syncTableWidth();
    }

    function syncTableWidth() {
      const totalWidth = Array.from(tableColGroup.children).reduce((sum, col) => {
        return sum + (Number.parseFloat(col.style.width) || col.getBoundingClientRect().width || 0);
      }, 0);
      const visibleWidth = Math.max(0, tableWrap.clientWidth - 1);
      const nextWidth = Math.max(820, Math.ceil(totalWidth), visibleWidth);
      gaTable.style.width = nextWidth + 'px';
      gaTable.style.minWidth = nextWidth + 'px';
    }

    function scheduleLayoutSync() {
      window.cancelAnimationFrame(layoutSyncFrame);
      layoutSyncFrame = window.requestAnimationFrame(() => {
        normalizeWorkspaceColumns();
        fitContentFrame();
        syncTableWidth();
        window.requestAnimationFrame(() => {
          normalizeWorkspaceColumns();
          fitContentFrame();
          syncTableWidth();
        });
      });
    }

    function scheduleStartupLayoutSync() {
      for (const delay of [0, 40, 120, 260, 520, 900]) {
        window.setTimeout(scheduleLayoutSync, delay);
      }
    }

    function normalizeWorkspaceColumns() {
      if (window.matchMedia('(max-width: 900px)').matches) {
        workspace.style.gridTemplateColumns = '';
        return;
      }

      const available = getWorkspaceTrackWidth();
      if (available <= 0) return;

      const splitterWidth = splitter.getBoundingClientRect().width || 10;
      const minPreview = isMobilePreview ? 300 : 320;
      const minPanel = 360;
      const maxPreview = Math.max(minPreview, available - splitterWidth - minPanel);
      const computedColumns = window.getComputedStyle(workspace).gridTemplateColumns.split(' ');
      const currentPreview = Number.parseFloat(computedColumns[0]) || minPreview;
      const previewWidth = Math.max(minPreview, Math.min(currentPreview, maxPreview));
      const panelWidth = Math.max(minPanel, available - previewWidth - splitterWidth);

      workspace.style.gridTemplateColumns = previewWidth + 'px ' + splitterWidth + 'px ' + panelWidth + 'px';
    }

    function getWorkspaceTrackWidth() {
      const style = window.getComputedStyle(workspace);
      const paddingX = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
      return Math.max(0, workspace.clientWidth - paddingX);
    }

    async function updatePeriodView() {
      const periodRequestId = ++periodViewRequestId;
      normalizeDateRange();
      const targetId = targetSelect.value;
      const runs = getSelectedRuns(targetId);
      const latestRun = runs.at(-1) || null;
      const latestTarget = latestRun ? getTarget(latestRun, targetId) : null;

      ga4RequestId += 1;
      ga4Status = {
        state: runs.length ? 'loading' : 'idle',
        message: runs.length ? '조회 중' : '대기',
        totals: emptyMetrics(),
        rowCount: 0,
      };
      periodRecords = [];
      recordByKey = new Map();
      recordByOccurrenceId = new Map();
      activeRecordKey = null;
      focusCycleByRecord.clear();
      collapsedGroups.clear();
      renderStatusRow(runs.length ? '요소 데이터를 불러오는 중입니다.' : '선택 기간에 저장된 데이터가 없습니다.');
      updateMeta(runs, latestRun, latestTarget);
      updateHash();

      if (!latestRun || !latestTarget) {
        contentFrame.removeAttribute('src');
        return;
      }

      try {
        await hydrateTargetsForRuns(runs, targetId);
      } catch (error) {
        if (periodRequestId !== periodViewRequestId) return;
        const message = error instanceof Error ? error.message : String(error);
        renderStatusRow('요소 데이터를 불러오지 못했습니다: ' + message);
        updateMeta(runs, latestRun, latestTarget);
        return;
      }

      if (periodRequestId !== periodViewRequestId) return;

      periodRecords = buildPeriodRecords(runs, targetId);
      rebuildRecordIndexes();
      renderPeriodRows();
      tableWrap.scrollLeft = 0;
      updateMeta(runs, latestRun, latestTarget);
      loadContent(latestRun, latestTarget);
      scheduleGa4MetricsRefresh({ targetId, startDate: startDateInput.value, endDate: endDateInput.value, requestId: ga4RequestId });
    }

    function getSelectedRuns(targetId) {
      const start = startDateInput.value;
      const end = endDateInput.value;
      return runsAscending.filter((run) => run.date >= start && run.date <= end && getTarget(run, targetId));
    }

    async function hydrateTargetsForRuns(runs, targetId) {
      await Promise.all(
        runs.map(async (run) => {
          const target = getTarget(run, targetId);
          if (!target || Array.isArray(target.elements)) return;
          target.elements = await loadTargetElements(target);
        }),
      );
    }

    async function loadTargetElements(target) {
      const elementsPath = target.elementsPath || target.domJsonPath;
      if (!elementsPath) return [];
      if (elementsCache.has(elementsPath)) return elementsCache.get(elementsPath);

      const response = await fetch(elementsPath, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(elementsPath + ' HTTP ' + response.status);
      const payload = await response.json();
      const elements = Array.isArray(payload) ? payload : Array.isArray(payload.elements) ? payload.elements : [];
      elementsCache.set(elementsPath, elements);
      return elements;
    }

    function scheduleGa4MetricsRefresh(params) {
      window.clearTimeout(ga4RefreshTimer);
      ga4RefreshTimer = window.setTimeout(() => refreshGa4Metrics(params), 150);
    }

    async function refreshGa4Metrics({ targetId, startDate, endDate, requestId }) {
      if (location.protocol === 'file:') {
        ga4Status = {
          state: 'error',
          message: '서버 필요',
          detail: 'GA4 실시간 조회는 npm run serve 또는 배포 서버에서 열어야 합니다.',
          totals: emptyMetrics(),
          rowCount: 0,
        };
        renderPeriodRows();
        updateMetaForCurrentSelection();
        return;
      }

      try {
        const params = new URLSearchParams({ targetId, startDate, endDate });
        const response = await fetch('/api/ga4-metrics?' + params.toString(), {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({}));
        if (requestId !== ga4RequestId) return;

        if (!response.ok || payload.status === 'error') {
          throw new Error(payload.error || 'GA4 데이터를 불러오지 못했습니다.');
        }

        applyGa4Metrics(payload.metrics || {});
        ga4Status = {
          state: 'ok',
          message: 'ok',
          totals: payload.totals || sumMetrics(periodRecords.map((record) => record.ga4)),
          rowCount: payload.rowCount || 0,
          eventCategory: payload.eventCategory || '',
        };
      } catch (error) {
        if (requestId !== ga4RequestId) return;
        ga4Status = {
          state: 'error',
          message: '오류',
          detail: error instanceof Error ? error.message : String(error),
          totals: emptyMetrics(),
          rowCount: 0,
        };
        applyGa4Metrics({});
      }

      renderPeriodRows();
      updateMetaForCurrentSelection();
    }

    function applyGa4Metrics(metrics) {
      for (const record of periodRecords) {
        record.ga4 = metrics[record.metricKey] || emptyMetrics();
        for (const occurrence of record.occurrences) {
          occurrence.ga4 = record.ga4;
        }
      }
    }

    function updateMetaForCurrentSelection() {
      const targetId = targetSelect.value;
      const runs = getSelectedRuns(targetId);
      const latestRun = runs.at(-1) || null;
      const latestTarget = latestRun ? getTarget(latestRun, targetId) : null;
      updateMeta(runs, latestRun, latestTarget);
    }

    function buildPeriodRecords(runs, targetId) {
      const selectedDates = runs.map((run) => run.date);
      const byKey = new Map();

      for (const run of runs) {
        const target = getTarget(run, targetId);
        for (const element of target?.elements || []) {
          const key = element.periodKey || element.stableKey || [targetId, element.ga_action, element.ga_label, element.href].join('|');
          const metricKey = element.ga4MetricKey || ga4MetricKey(element.ga_action || '(missing)', element.ga_label || '');
          let record = byKey.get(key);
          if (!record) {
            record = {
              key,
              ga_action: element.ga_action || '(missing)',
              ga_label: element.ga_label || '',
              href: element.href || null,
              metricKey,
              occurrences: [],
            };
            byKey.set(key, record);
          }

          record.occurrences.push({
            key,
            rawKey: key,
            runId: run.runId,
            date: run.date,
            capturedAt: run.capturedAt,
            targetId,
            contentPath: target.contentPath,
            snapshotId: element.snapshotId,
            periodKey: element.periodKey,
            ga_action: element.ga_action || '(missing)',
            ga_label: element.ga_label || '',
            href: element.href || null,
            index: element.index || 0,
            ga4: emptyMetrics(),
          });
        }
      }

      let records = Array.from(byKey.values());
      for (const record of records) {
        record.occurrences.sort(compareOccurrences);
        record.latestOccurrence = latestVisibleOccurrence(record.occurrences);
        record.periods = buildDatePeriods(record.occurrences, selectedDates);
        record.ga4 = emptyMetrics();
      }

      records = mergeDuplicatePeriodRecords(records);

      records.sort((left, right) => {
        const dateCompare = right.latestOccurrence.date.localeCompare(left.latestOccurrence.date);
        if (dateCompare) return dateCompare;
        return (left.latestOccurrence.index || 0) - (right.latestOccurrence.index || 0);
      });

      return records;
    }

    function mergeDuplicatePeriodRecords(records) {
      const mergedByKey = new Map();

      for (const record of records) {
        const periodText = formatPeriods(record.periods);
        const mergeKey = 'merged:' + record.metricKey + ':' + periodText;
        let merged = mergedByKey.get(mergeKey);
        if (!merged) {
          merged = {
            ...record,
            key: mergeKey,
            hrefs: new Set(),
            occurrences: [],
          };
          mergedByKey.set(mergeKey, merged);
        }

        if (record.href) merged.hrefs.add(record.href);
        for (const occurrence of record.occurrences) {
          merged.occurrences.push({ ...occurrence, key: mergeKey });
        }
      }

      return Array.from(mergedByKey.values()).map((record) => {
        record.occurrences.sort(compareOccurrences);
        record.latestOccurrence = latestVisibleOccurrence(record.occurrences);
        record.periods = record.periods || [];
        record.href = record.hrefs.size === 1 ? Array.from(record.hrefs)[0] : record.hrefs.size > 1 ? 'multiple' : null;
        record.currentOccurrenceCount = record.occurrences.filter((occurrence) => occurrence.runId === record.latestOccurrence?.runId).length;
        record.ga4 = emptyMetrics();
        return record;
      });
    }

    function rebuildRecordIndexes() {
      recordByKey = new Map(periodRecords.map((record) => [record.key, record]));
      recordByOccurrenceId = new Map();
      for (const record of periodRecords) {
        for (const occurrence of record.occurrences) {
          if (occurrence.snapshotId) {
            recordByOccurrenceId.set(occurrenceId(occurrence.runId, occurrence.snapshotId), record);
          }
        }
      }
    }

    function compareOccurrences(left, right) {
      return left.date.localeCompare(right.date) ||
        left.runId.localeCompare(right.runId) ||
        Number(left.index || 0) - Number(right.index || 0) ||
        String(left.snapshotId || '').localeCompare(String(right.snapshotId || ''));
    }

    function latestVisibleOccurrence(occurrences) {
      const latestDate = occurrences.at(-1)?.date || '';
      return occurrences.filter((occurrence) => occurrence.date === latestDate).sort(compareOccurrences)[0] || occurrences.at(-1);
    }

    function occurrenceId(runId, snapshotId) {
      return runId + ':' + snapshotId;
    }

    function renderPeriodRows() {
      const query = filterInput.value.trim().toLowerCase();
      const groups = [];
      const groupByAction = new Map();

      for (const record of periodRecords) {
        const haystack = [record.ga_action, record.ga_label, record.href, formatPeriods(record.periods)].filter(Boolean).join(' ').toLowerCase();
        if (query && !haystack.includes(query)) continue;

        const action = record.ga_action || '(missing)';
        let group = groupByAction.get(action);
        if (!group) {
          group = { id: groupIdForAction(action), action, records: [] };
          groupByAction.set(action, group);
          groups.push(group);
        }
        group.records.push(record);
      }

      periodRows.innerHTML = groups
        .map((group) => {
          const collapsed = collapsedGroups.has(group.id);
          const groupMetrics = sumMetrics(group.records.map((record) => record.ga4));
          const rows = collapsed
            ? ''
            : group.records
                .map((record) => {
                  const active = activeRecordKey === record.key ? ' active' : '';
                  const occurrenceBadge = record.currentOccurrenceCount > 1 ? '<small>' + record.currentOccurrenceCount + ' elements</small>' : '';
                  return '<tr class="item-row' + active + '" data-key="' + escapeHtml(record.key) + '" data-group-id="' + escapeHtml(group.id) + '">' +
                    '<td><code>' + escapeHtml(record.ga_action || '(missing)') + '</code></td>' +
                    '<td><code>' + escapeHtml(record.ga_label) + '</code>' + occurrenceBadge + '</td>' +
                    '<td><span class="period">' + escapeHtml(formatPeriods(record.periods)) + '</span></td>' +
                    '<td class="metric">' + formatMetric(record.ga4.eventCount, 'eventCount') + '</td>' +
                    '<td class="metric">' + formatMetric(record.ga4.sessions, 'sessions') + '</td>' +
                    '<td class="metric">' + formatMetric(record.ga4.activeUsers, 'activeUsers') + '</td>' +
                  '</tr>';
                })
                .join('');

          return '<tr class="group-row" data-group-id="' + escapeHtml(group.id) + '">' +
            '<td colspan="3"><button class="group-toggle" type="button">' +
            '<span class="group-state">' + (collapsed ? '[+]' : '[-]') + '</span>' +
            '<span>' + escapeHtml(group.action) + '</span>' +
            '<small>' + group.records.length + ' items</small>' +
            '</button></td>' +
            '<td class="metric">' + formatMetric(groupMetrics.eventCount, 'eventCount') + '</td>' +
            '<td class="metric">' + formatMetric(groupMetrics.sessions, 'sessions') + '</td>' +
            '<td class="metric">' + formatMetric(groupMetrics.activeUsers, 'activeUsers') + '</td>' +
            '</tr>' + rows;
        })
        .join('');

      periodRows.insertAdjacentHTML('afterbegin', renderTotalRow());

      for (const row of periodRows.querySelectorAll('tr.group-row')) {
        row.addEventListener('click', () => {
          if (hasSelectedText()) return;
          const groupId = row.dataset.groupId;
          if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId);
          else collapsedGroups.add(groupId);
          renderPeriodRows();
        });
      }

      for (const row of periodRows.querySelectorAll('tr[data-key]')) {
        row.addEventListener('click', () => {
          if (hasSelectedText()) return;
          const record = recordByKey.get(row.dataset.key);
          if (record) focusRecord(record, { clearFilter: false, scrollRow: false, cycle: true });
        });
      }

      scheduleLayoutSync();
    }

    function renderStatusRow(message) {
      periodRows.innerHTML = '<tr class="status-row"><td colspan="6">' + escapeHtml(message) + '</td></tr>';
    }

    function renderTotalRow() {
      const category = ga4Status.eventCategory || (targetSelect.value.includes('mobile') ? 'MTWD_main' : 'TWD_main');
      return '<tr class="total-row">' +
        '<td colspan="3"><strong>총합</strong><small>click · ' + escapeHtml(category) + '</small></td>' +
        '<td class="metric">' + formatMetric(ga4Status.totals.eventCount, 'eventCount') + '</td>' +
        '<td class="metric">' + formatMetric(ga4Status.totals.sessions, 'sessions') + '</td>' +
        '<td class="metric">' + formatMetric(ga4Status.totals.activeUsers, 'activeUsers') + '</td>' +
      '</tr>';
    }

    function hasSelectedText() {
      return Boolean(window.getSelection?.().toString().trim());
    }

    function showIntroTip() {
      if (localStorageAvailable() && window.localStorage.getItem(HELP_SEEN_KEY) === '1') return;
      introTip.hidden = false;
    }

    function hideIntroTip() {
      introTip.hidden = true;
      if (localStorageAvailable()) window.localStorage.setItem(HELP_SEEN_KEY, '1');
    }

    function openHelp() {
      introTip.hidden = true;
      helpModal.hidden = false;
      document.body.classList.add('is-help-open');
      helpClose.focus();
      if (localStorageAvailable()) window.localStorage.setItem(HELP_SEEN_KEY, '1');
    }

    function closeHelp() {
      helpModal.hidden = true;
      document.body.classList.remove('is-help-open');
      helpButton.focus();
    }

    function localStorageAvailable() {
      try {
        const key = '__ga_snapshot_storage_test__';
        window.localStorage.setItem(key, '1');
        window.localStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    }

    function focusOccurrence(occurrence, options = {}) {
      if (!occurrence) return;
      const record = recordByKey.get(occurrence.key) || recordByOccurrenceId.get(occurrenceId(occurrence.runId, occurrence.snapshotId));
      if (record) {
        focusRecord(record, { ...options, focusOccurrence: occurrence, cycle: false });
        return;
      }

      focusSingleOccurrence(occurrence, options);
    }

    function focusRecord(record, options = {}) {
      if (!record) return;
      const { clearFilter = true, scrollRow = true, cycle = false, focusOccurrence = null } = options;
      if (cycle && activeRecordKey !== record.key) focusCycleByRecord.set(record.key, 0);
      const occurrence = focusOccurrence || nextFocusOccurrence(record, cycle);
      if (!occurrence) return;
      const run = catalog.runs.find((candidate) => candidate.runId === occurrence.runId);
      const target = run ? getTarget(run, occurrence.targetId) : null;
      if (!run || !target) return;

      if (clearFilter && filterInput.value) {
        filterInput.value = '';
        renderPeriodRows();
      }

      setActiveRow(record.key, { scrollRow });

      if (!currentRun || currentRun.runId !== run.runId || !currentTarget || currentTarget.id !== target.id) {
        pendingRecordFocus = { record, focusOccurrence: occurrence };
        loadContent(run, target);
        return;
      }

      highlightRecord(record, occurrence);
    }

    function focusSingleOccurrence(occurrence, options = {}) {
      const { clearFilter = true, scrollRow = true } = options;
      const run = catalog.runs.find((candidate) => candidate.runId === occurrence.runId);
      const target = run ? getTarget(run, occurrence.targetId) : null;
      if (!run || !target) return;

      if (clearFilter && filterInput.value) {
        filterInput.value = '';
        renderPeriodRows();
      }

      setActiveRow(occurrence.key, { scrollRow });

      if (!currentRun || currentRun.runId !== run.runId || !currentTarget || currentTarget.id !== target.id) {
        pendingOccurrence = occurrence;
        loadContent(run, target);
        return;
      }

      highlightOccurrence(occurrence);
    }

    function nextFocusOccurrence(record, cycle) {
      const runId = record.latestOccurrence?.runId;
      if (!runId) return record.latestOccurrence;
      const occurrences = record.occurrences.filter((occurrence) => occurrence.runId === runId).sort(compareOccurrences);
      if (!occurrences.length) return record.latestOccurrence;
      if (!cycle) return occurrences[0];

      const index = focusCycleByRecord.get(record.key) || 0;
      focusCycleByRecord.set(record.key, index + 1);
      return occurrences[index % occurrences.length];
    }

    function setActiveRow(key, options = {}) {
      const { scrollRow = true } = options;
      const record = recordByKey.get(key);
      if (record) collapsedGroups.delete(groupIdForAction(record.ga_action));
      const previousScrollTop = tableWrap.scrollTop;
      const previousScrollLeft = tableWrap.scrollLeft;
      activeRecordKey = key;
      renderPeriodRows();
      const row = periodRows.querySelector('tr[data-key="' + cssEscape(key) + '"]');
      if (!row) return;
      for (const candidate of periodRows.querySelectorAll('tr[data-key]')) {
        candidate.classList.toggle('active', candidate === row);
      }
      if (scrollRow) {
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
      } else {
        tableWrap.scrollTop = previousScrollTop;
        tableWrap.scrollLeft = previousScrollLeft;
      }
    }

    function loadContent(run, target) {
      currentRun = run;
      currentTarget = target;
      const nextMobilePreview = target.id.includes('mobile');
      const nextPreviewMode = nextMobilePreview ? 'mobile' : 'pc';
      if (lastPreviewMode !== nextPreviewMode) {
        workspace.style.gridTemplateColumns = '';
        lastPreviewMode = nextPreviewMode;
      }
      isMobilePreview = nextMobilePreview;
      sourceViewportWidth = target.page?.viewportWidth || (isMobilePreview ? 390 : 1440);
      workspace.classList.toggle('mobile', isMobilePreview);
      workspace.classList.toggle('pc', !isMobilePreview);
      contentFrame.removeAttribute('srcdoc');
      contentFrame.src = target.contentPath;
      panelMeta.textContent = run.date + ' · ' + target.label;
      scheduleLayoutSync();
    }

    function fitContentFrame() {
      if (!currentTarget) return;

      if (isMobilePreview) {
        contentFrame.style.width = sourceViewportWidth + 'px';
        contentFrame.style.minWidth = sourceViewportWidth + 'px';
        contentFrame.style.height = '100%';
        contentFrame.style.transform = 'none';
        return;
      }

      const scale = Math.min(1, preview.clientWidth / sourceViewportWidth);
      contentFrame.style.width = sourceViewportWidth + 'px';
      contentFrame.style.minWidth = sourceViewportWidth + 'px';
      contentFrame.style.height = Math.ceil(preview.clientHeight / scale) + 'px';
      contentFrame.style.transform = 'scale(' + scale + ')';
    }

    function installContentClickBridge() {
      const doc = getContentDocument();
      if (!doc || doc.__gaPeriodBridgeInstalled) return;
      doc.__gaPeriodBridgeInstalled = true;

      doc.addEventListener(
        'click',
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          const occurrence = findOccurrenceFromContentTarget(event.target);
          if (occurrence) focusOccurrence(occurrence, { clearFilter: true });
        },
        true,
      );

      const style = doc.createElement('style');
      style.textContent = 'a, button, [role="button"], [ga_label] { cursor: pointer !important; }';
      doc.head?.append(style);
    }

    function findOccurrenceFromContentTarget(target) {
      if (!target || typeof target.closest !== 'function' || !currentTarget || !currentRun) return null;

      const snapshotIds = [];
      const direct = target.closest('[data-ga-snapshot-id]');
      const directId = direct?.getAttribute('data-ga-snapshot-id');
      if (directId) snapshotIds.push(directId);

      const highlighted = target.closest('[data-ga-highlight-ids]');
      snapshotIds.push(...(highlighted?.getAttribute('data-ga-highlight-ids') || '').split(/\\s+/).filter(Boolean));

      for (const snapshotId of snapshotIds) {
        const record = recordByOccurrenceId.get(occurrenceId(currentRun.runId, snapshotId));
        const occurrence = record?.occurrences.find((item) => item.runId === currentRun.runId && item.snapshotId === snapshotId);
        if (occurrence) return occurrence;
      }

      const labelElement = target.closest('[ga_label]');
      if (!labelElement) return null;
      const gaLabel = labelElement.getAttribute('ga_label') || '';
      const gaAction = labelElement.closest('[ga_action]')?.getAttribute('ga_action') || null;
      const anchor = labelElement.closest('a[href]');
      const href = anchor?.href || null;

      for (const record of periodRecords) {
        const occurrence = record.occurrences.find(
          (item) => item.runId === currentRun.runId && item.ga_label === gaLabel && item.ga_action === gaAction && (!href || item.href === href),
        );
        if (occurrence) return occurrence;
      }

      return null;
    }

    function highlightOccurrence(occurrence) {
      const doc = getContentDocument();
      if (!doc || !occurrence) return;
      const target = findTarget(doc, occurrence);
      if (!target) return;

      resetPreviewContext(doc);
      revealTargetContext(target);
      revealHiddenContext(target);
      const highlightTarget = resolveHighlightTarget(doc, target);

      highlightTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      highlightedElement = highlightTarget;
      doc.defaultView.requestAnimationFrame(() => drawHighlightBoxes(doc, [highlightTarget]));
    }

    function highlightRecord(record, focusOccurrence) {
      const doc = getContentDocument();
      if (!doc || !record || !focusOccurrence) return;

      resetPreviewContext(doc);
      const focusTarget = findTarget(doc, focusOccurrence);
      if (!focusTarget) return;

      revealTargetContext(focusTarget);
      revealHiddenContext(focusTarget);

      const currentRunOccurrences = record.occurrences
        .filter((occurrence) => occurrence.runId === focusOccurrence.runId)
        .sort(compareOccurrences);
      const highlightTargets = [];

      for (const occurrence of currentRunOccurrences) {
        const target = findTarget(doc, occurrence);
        if (!target) continue;
        highlightTargets.push(resolveHighlightTarget(doc, target));
      }

      const focusHighlightTarget = resolveHighlightTarget(doc, findTarget(doc, focusOccurrence) || focusTarget);
      focusHighlightTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      highlightedElement = focusHighlightTarget;
      doc.defaultView.requestAnimationFrame(() => drawHighlightBoxes(doc, highlightTargets.length ? highlightTargets : [focusHighlightTarget]));
    }

    function findTarget(doc, occurrence) {
      if (occurrence.snapshotId) {
        const direct = doc.querySelector('[data-ga-snapshot-id="' + cssEscape(occurrence.snapshotId) + '"]');
        if (direct) {
          return direct.closest('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]') || direct;
        }

        const highlighted = doc.querySelector('[data-ga-highlight-ids~="' + cssEscape(occurrence.snapshotId) + '"]');
        if (highlighted) return highlighted;
      }

      const candidates = Array.from(doc.querySelectorAll('[ga_label]')).filter(
        (element) => element.getAttribute('ga_label') === occurrence.ga_label,
      );
      const actionMatches = candidates.filter(
        (element) => (element.closest('[ga_action]')?.getAttribute('ga_action') || null) === occurrence.ga_action,
      );
      const hrefMatches = actionMatches.filter((element) => {
        const anchor = element.closest('a[href]');
        return occurrence.href && anchor?.href === occurrence.href;
      });
      const fallback = hrefMatches[0] || actionMatches[0] || candidates[0] || null;
      return fallback?.closest('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]') || fallback || null;
    }

    function revealTargetContext(element) {
      const slide = element.closest?.('.swiper-slide');
      const wrapper = slide?.parentElement;

      if (slide && wrapper) {
        const offset = slide.offsetLeft || 0;
        rememberElementState(wrapper);
        wrapper.style.transitionDuration = '0ms';
        wrapper.style.transitionProperty = 'none';
        wrapper.style.transform = 'translate3d(' + -offset + 'px, 0px, 0px)';

        wrapper.querySelectorAll('.swiper-slide-active, .swiper-slide-prev, .swiper-slide-next').forEach((candidate) => {
          rememberElementState(candidate);
          candidate.classList.remove('swiper-slide-active', 'swiper-slide-prev', 'swiper-slide-next');
        });

        rememberElementState(slide);
        slide.classList.add('swiper-slide-active');
        if (slide.previousElementSibling) rememberElementState(slide.previousElementSibling);
        slide.previousElementSibling?.classList.add('swiper-slide-prev');
        if (slide.nextElementSibling) rememberElementState(slide.nextElementSibling);
        slide.nextElementSibling?.classList.add('swiper-slide-next');
      }

      let current = element.parentElement;
      while (current && current !== element.ownerDocument.body) {
        const style = element.ownerDocument.defaultView.getComputedStyle(current);
        const canScrollX = /(auto|scroll)/.test(style.overflowX) && current.scrollWidth > current.clientWidth;
        if (canScrollX) {
          const currentRect = current.getBoundingClientRect();
          const elementRect = element.getBoundingClientRect();
          current.scrollLeft += elementRect.left - currentRect.left - current.clientWidth / 2 + elementRect.width / 2;
          break;
        }
        current = current.parentElement;
      }
    }

    function revealHiddenContext(element) {
      const doc = element.ownerDocument;
      const win = doc.defaultView;
      let current = element;

      while (current && current !== doc.body && current !== doc.documentElement) {
        rememberElementState(current);
        if (current.hasAttribute?.('hidden')) current.removeAttribute('hidden');

        const style = win.getComputedStyle(current);
        const rect = current.getBoundingClientRect();

        if (style.display === 'none') {
          current.style.display = preferredDisplay(current);
        }

        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          current.style.visibility = 'visible';
        }

        if (Number(style.opacity || '1') === 0) {
          current.style.opacity = '1';
        }

        if ((rect.width === 0 || rect.height === 0) && current !== element) {
          current.style.maxWidth = 'none';
          current.style.maxHeight = 'none';
          if (style.height === '0px') current.style.height = 'auto';
          if (style.overflow === 'hidden') current.style.overflow = 'visible';
        }

        current.classList?.add?.('on', 'active', 'is-active');
        current = current.parentElement;
      }

      const card = element.closest?.('.item-card, .flipcard, .swiper-slide');
      if (card) {
        rememberElementState(card);
        card.style.visibility = 'visible';
        card.style.opacity = '1';
        card.style.backfaceVisibility = 'visible';
        card.style.transformStyle = 'flat';
      }
    }

    function preferredDisplay(element) {
      const tagName = element.tagName?.toLowerCase();
      if (tagName === 'span' || tagName === 'img' || tagName === 'button' || tagName === 'a') return 'inline-block';
      if (tagName === 'li') return 'list-item';
      if (tagName === 'tr') return 'table-row';
      if (tagName === 'td' || tagName === 'th') return 'table-cell';
      return 'block';
    }

    function drawHighlightBoxes(doc, elements) {
      const layer = ensureHighlightLayer(doc);
      layer.replaceChildren();
      const win = doc.defaultView;
      const uniqueElements = Array.from(new Set(elements.filter(Boolean)));

      for (const element of uniqueElements) {
        const rect = element.getBoundingClientRect();
        const width = Math.max(rect.width, 24);
        const height = Math.max(rect.height, 24);
        const box = doc.createElement('div');
        box.className = 'ga-snapshot-highlight-box';
        box.style.left = rect.left + win.scrollX + 'px';
        box.style.top = rect.top + win.scrollY + 'px';
        box.style.width = width + 'px';
        box.style.height = height + 'px';
        layer.append(box);
      }

      layer.hidden = uniqueElements.length === 0;
    }

    function ensureHighlightLayer(doc) {
      let layer = doc.getElementById('ga-snapshot-highlight-layer');
      if (layer) return layer;

      const style = doc.createElement('style');
      style.textContent = [
        'html, body, * { scroll-behavior: auto !important; }',
        '#ga-snapshot-highlight-layer {',
        '  position: absolute;',
        '  inset: 0;',
        '  z-index: 2147483647;',
        '  pointer-events: none;',
        '}',
        '.ga-snapshot-highlight-box {',
        '  position: absolute;',
        '  z-index: 2147483647;',
        '  pointer-events: none;',
        '  box-sizing: border-box;',
        '  border: 4px solid #f05a28;',
        '  border-radius: 6px;',
        '  background: rgba(240, 90, 40, 0.08);',
        '  box-shadow: 0 0 0 2px #fff, 0 0 0 7px rgba(240, 90, 40, 0.24);',
        '}',
      ].join('\\n');
      doc.head?.append(style);

      layer = doc.createElement('div');
      layer.id = 'ga-snapshot-highlight-layer';
      layer.hidden = true;
      doc.body.append(layer);
      return layer;
    }

    function resetPreviewContext(doc = getContentDocument()) {
      if (!doc) return;

      for (const restore of revealRestorers.slice().reverse()) {
        restore();
      }
      revealRestorers = [];
      revealedElements = new Set();

      doc.getElementById('ga-snapshot-highlight-layer')?.remove();
      doc.getElementById('ga-snapshot-highlight-box')?.remove();
    }

    function rememberElementState(element) {
      if (!element || revealedElements.has(element)) return;
      revealedElements.add(element);

      const className = element.getAttribute?.('class');
      const styleText = element.getAttribute?.('style');
      const hadHidden = element.hasAttribute?.('hidden') || false;

      revealRestorers.push(() => {
        if (!element.isConnected) return;
        if (className === null || className === undefined) element.removeAttribute?.('class');
        else element.setAttribute?.('class', className);

        if (styleText === null || styleText === undefined) element.removeAttribute?.('style');
        else element.setAttribute?.('style', styleText);

        if (hadHidden) element.setAttribute?.('hidden', '');
        else element.removeAttribute?.('hidden');
      });
    }

    function resolveHighlightTarget(doc, element) {
      if (isElementVisible(element)) return element;

      const id = element.getAttribute?.('id');
      if (id) {
        const label = doc.querySelector('label[for="' + cssEscape(id) + '"]');
        if (label && isElementVisible(label)) return label;
      }

      const closestLabel = element.closest?.('label');
      if (closestLabel && isElementVisible(closestLabel)) return closestLabel;

      let current = element.parentElement;
      while (current && current !== doc.body) {
        if (isElementVisible(current)) return current;
        current = current.parentElement;
      }

      return element;
    }

    function isElementVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function installSplitter() {
      splitter.addEventListener('pointerdown', (event) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.classList.add('is-dragging');
        try {
          splitter.setPointerCapture(event.pointerId);
        } catch {}
        event.preventDefault();
      });

      window.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        if (event.buttons === 0) {
          stopDragging(event);
          return;
        }

        const rect = workspace.getBoundingClientRect();
        const style = window.getComputedStyle(workspace);
        const trackLeft = rect.left + Number.parseFloat(style.paddingLeft || '0');
        const splitterWidth = splitter.getBoundingClientRect().width || 10;
        const minPreview = isMobilePreview ? 300 : 320;
        const minPanel = 360;
        const available = getWorkspaceTrackWidth();
        const rawPreviewWidth = event.clientX - trackLeft;
        const previewWidth = Math.max(minPreview, Math.min(rawPreviewWidth, available - splitterWidth - minPanel));
        const panelWidth = Math.max(minPanel, available - previewWidth - splitterWidth);

        workspace.style.gridTemplateColumns = previewWidth + 'px ' + splitterWidth + 'px ' + panelWidth + 'px';
        fitContentFrame();
        syncTableWidth();
      });

      const stopDragging = (event) => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        try {
          splitter.releasePointerCapture(event?.pointerId);
        } catch {}
      };

      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      window.addEventListener('blur', stopDragging);
    }

    function updateMeta(runs, latestRun, latestTarget) {
      if (!runs.length || !latestRun || !latestTarget) {
        stats.textContent = '선택 기간에 저장된 데이터가 없습니다.';
        panelMeta.textContent = '';
        return;
      }

      const counts = latestTarget.counts || {};
      const ga4Text = ga4Status.state === 'ok'
        ? 'ok ' + formatNumber(ga4Status.totals.eventCount) + ' events'
        : ga4Status.message + (ga4Status.detail ? ' (' + ga4Status.detail + ')' : '');
      stats.innerHTML = [
        '<strong>' + escapeHtml(String(runs.length)) + '</strong> days',
        '<strong>' + escapeHtml(String(periodRecords.length)) + '</strong> elements',
        '<strong>' + escapeHtml(String(counts.contentDomGaLabelElements || latestTarget.elements?.length || 0)) + '</strong> latest DOM labels',
        '<strong>GA4</strong> ' + escapeHtml(ga4Text),
        escapeHtml(latestTarget.finalUrl || latestTarget.url || ''),
      ].join('<span>|</span>');
    }

    function buildDatePeriods(occurrences, selectedDates) {
      const occurrenceDates = new Set(occurrences.map((item) => item.date));
      const periods = [];
      let start = null;
      let end = null;

      for (const date of selectedDates) {
        if (occurrenceDates.has(date)) {
          if (!start) start = date;
          end = date;
        } else if (start) {
          periods.push({ start, end });
          start = null;
          end = null;
        }
      }

      if (start) periods.push({ start, end });
      return periods;
    }

    function formatPeriods(periods) {
      return periods.map((period) => period.start + ' ~ ' + period.end).join(', ');
    }

    function ga4MetricKey(action, label) {
      return encodeURIComponent(action || '(missing)') + '::' + encodeURIComponent(label || '');
    }

    function emptyMetrics() {
      return { eventCount: 0, sessions: 0, activeUsers: 0 };
    }

    function sumMetrics(items) {
      return items.reduce((total, item) => ({
        eventCount: total.eventCount + Number(item?.eventCount || 0),
        sessions: total.sessions + Number(item?.sessions || 0),
        activeUsers: total.activeUsers + Number(item?.activeUsers || 0),
      }), emptyMetrics());
    }

    function formatMetric(value, metricName) {
      if (ga4Status.state === 'loading') return '...';
      if (ga4Status.state === 'error') return '-';
      const number = Number(value || 0);
      const total = Number(ga4Status.totals?.[metricName] || 0);
      const percent = total > 0 ? Math.round((number / total) * 100) : 0;
      return formatNumber(number) + ' (' + percent + '%)';
    }

    function formatNumber(value) {
      return new Intl.NumberFormat('ko-KR').format(Number(value || 0));
    }

    function getTarget(run, targetId) {
      return run?.targets?.find((target) => target.id === targetId) || null;
    }

    function normalizeDateRange() {
      if (startDateInput.value && endDateInput.value && startDateInput.value > endDateInput.value) {
        const start = startDateInput.value;
        startDateInput.value = endDateInput.value;
        endDateInput.value = start;
      }
    }

    function updateHash() {
      const params = new URLSearchParams();
      params.set('target', targetSelect.value || '');
      params.set('start', startDateInput.value || '');
      params.set('end', endDateInput.value || '');
      location.hash = params.toString();
    }

    function readHashState() {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      return {
        target: params.get('target') || '',
        start: params.get('start') || '',
        end: params.get('end') || '',
      };
    }

    function getContentDocument() {
      try {
        return contentFrame.contentDocument;
      } catch {
        return null;
      }
    }

    function groupIdForAction(action) {
      return 'group-' + btoa(unescape(encodeURIComponent(action || '(missing)'))).replace(/=+$/g, '').replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    function cssEscape(value) {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
  </script>
</body>
</html>`;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function dateFromRunId(runId) {
  const match = /^(\d{4})(\d{2})(\d{2})T\d{6}$/.exec(String(runId));
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateFromIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function makePeriodKey(targetId, element) {
  const base = [element.ga_action || '', element.ga_label || '', element.href || ''].join('|');
  const ordinal = element.sourceIndex || element.index || 1;
  return `${targetId}:${hashStringNode(base)}:${ordinal}`;
}

function hashStringNode(value) {
  return `h${crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12)}`;
}

function toCsv(elements) {
  const headers = [
    'index',
    'snapshotId',
    'periodKey',
    'stableKey',
    'sourceIndex',
    'status',
    'ga_action',
    'ga_label',
    'text',
    'href',
    'labelTag',
    'clickableTag',
    'selector',
    'actionSelector',
    'clickableSelector',
    'x',
    'y',
    'width',
    'height',
    'visible',
    'inViewport',
    'domHash',
  ];

  const rows = elements.map((element) =>
    [
      element.index,
      element.snapshotId,
      element.periodKey,
      element.stableKey,
      element.sourceIndex,
      element.status,
      element.ga_action,
      element.ga_label,
      element.text,
      element.href,
      element.labelTag,
      element.clickableTag,
      element.selector,
      element.actionSelector,
      element.clickableSelector,
      element.clickableBBox.x,
      element.clickableBBox.y,
      element.clickableBBox.width,
      element.clickableBBox.height,
      element.visible,
      element.inViewport,
      element.domHash,
    ].map(csvCell).join(','),
  );

  return `${headers.join(',')}\n${rows.join('\n')}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) return `"${stringValue.replaceAll('"', '""')}"`;
  return stringValue;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function timestampForPath(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
