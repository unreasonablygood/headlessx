import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  Request as BrowserRequest,
  Response as BrowserResponse,
  Page,
  Route,
} from 'playwright-core';
import {
  browserService,
  type IsolatedBrowserPage,
  IsolatedEvidenceBrowserError,
} from './BrowserService';
import { evidenceSha256 } from './EvidenceIntegrity';
import { type LogoElementInspection, validateLogoElementEvidence } from './EvidenceLogoElement';
import {
  captureEvidenceStep,
  collectBoundedPublicArtifact,
  collectBoundedPublicLinks,
  EvidenceCaptureStepError,
  selectMainDocumentResponse,
  validateRenderedDocumentFallback,
} from './EvidenceNavigation';

const SCHEMA_VERSION = 'fleet.headlessx-evidence/v1';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINKS = 2_000;
const MAX_ELEMENT_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 55_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_QUEUE_WAIT_MS = boundedEnv('HEADLESSX_EVIDENCE_QUEUE_TIMEOUT_MS', 5_000, 100, 30_000);
const MAX_CONCURRENCY = boundedEnv('HEADLESSX_EVIDENCE_MAX_CONCURRENCY', 2, 1, 8);
const MAX_QUEUE_DEPTH = boundedEnv('HEADLESSX_EVIDENCE_MAX_QUEUE_DEPTH', 8, 0, 64);
const AUTH_PATH = /\/(?:auth|authorize|login|log-in|oauth2?|sign-in|signin)(?:\/|$)/i;
const CREDENTIAL_QUERY =
  /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|cookie|password|session|sig|signature|token)$/i;
const ALLOWED_HEADERS = new Set([
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
]);

export type EvidenceCaptureKind = 'document' | 'artifact' | 'element';

export interface EvidenceElementRequest {
  selector: string;
  expectedIdentity: string;
}

export interface EvidenceCaptureRequest {
  url: string;
  kind: EvidenceCaptureKind;
  element?: EvidenceElementRequest;
  timeoutMs?: number;
  maxBytes?: number;
}

interface CaptureMetrics {
  queueMs: number;
  renderMs: number;
  activeConcurrency: number;
  maxConcurrency: number;
  queuedRequests: number;
  outcome: 'success' | 'failure' | 'timeout';
}

interface EvidenceScreenshot {
  mediaType: 'image/png';
  encoding: 'base64';
  data: string;
  sha256: string;
  byteLength: number;
}

interface EvidenceInteraction {
  ordinal: number;
  action:
    | 'navigate'
    | 'wait_for_document'
    | 'capture_source'
    | 'capture_dom'
    | 'capture_screenshot';
  startedAt: string;
  completedAt: string;
  outcome: 'success';
}

interface EvidenceElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EvidenceElementCapture {
  selector: string;
  stableDescription: string;
  expectedIdentity: string;
  identityEvidence: string;
  tagName: string;
  role: string | null;
  visibleText: string;
  boundingBox: EvidenceElementBounds;
  viewport: { width: number; height: number };
  primitives: {
    imageCount: number;
    svgCount: number;
    backgroundImageCount: number;
    canvasCount: number;
    videoCount: number;
    iframeCount: number;
  };
  screenshot: EvidenceScreenshot;
}

export interface EvidenceCaptureResult {
  schemaVersion: typeof SCHEMA_VERSION;
  producer: {
    name: 'headlessx';
    version: string;
    sourceCommit: string;
  };
  requestedUrl: string;
  finalUrl: string;
  redirectChain: string[];
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: {
    encoding: 'base64';
    data: string;
    sha256: string;
    byteLength: number;
  };
  html: string | null;
  markdown: string | null;
  screenshot: EvidenceScreenshot | null;
  element?: EvidenceElementCapture;
  links: string[];
  metadata: Record<string, unknown>;
  browser: {
    name: 'headfox';
    version: string;
    viewportWidth: number;
    viewportHeight: number;
    javascriptEnabled: true;
    isolatedSession: true;
  };
  interactions: EvidenceInteraction[];
  fetchedAt: string;
  metrics: CaptureMetrics;
}

export class EvidenceCaptureError extends Error {
  public metrics?: CaptureMetrics;

  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly phase: string,
    message: string,
  ) {
    super(message);
  }
}

interface Permit {
  queueMs: number;
  activeConcurrency: number;
  queuedRequests: number;
  release: () => void;
}

interface QueueWaiter {
  enqueuedAt: number;
  settled: boolean;
  timer: NodeJS.Timeout;
  resolve: (permit: Permit) => void;
  reject: (error: EvidenceCaptureError) => void;
}

class BoundedCaptureGate {
  private active = 0;
  private readonly waiters: QueueWaiter[] = [];

  public async acquire(timeoutMs: number): Promise<Permit> {
    if (this.active < MAX_CONCURRENCY) {
      this.active += 1;
      return this.permit(performance.now());
    }
    if (this.waiters.length >= MAX_QUEUE_DEPTH) {
      throw new EvidenceCaptureError(
        429,
        'evidence_queue_full',
        true,
        'queue',
        'the bounded evidence render queue is full',
      );
    }
    const enqueuedAt = performance.now();
    return new Promise<Permit>((resolve, reject) => {
      const waiter: QueueWaiter = {
        enqueuedAt,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new EvidenceCaptureError(
              504,
              'evidence_queue_timeout',
              true,
              'queue',
              'the bounded evidence render queue wait expired',
            ),
          );
        }, timeoutMs),
        resolve,
        reject,
      };
      this.waiters.push(waiter);
    });
  }

  private permit(enqueuedAt: number): Permit {
    let released = false;
    return {
      queueMs: Math.round(performance.now() - enqueuedAt),
      activeConcurrency: this.active,
      queuedRequests: this.waiters.length,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.startNext();
      },
    };
  }

  private startNext(): void {
    while (this.active < MAX_CONCURRENCY) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      this.active += 1;
      waiter.resolve(this.permit(waiter.enqueuedAt));
    }
  }

  public snapshot(): Record<string, number> {
    return {
      activeConcurrency: this.active,
      maxConcurrency: MAX_CONCURRENCY,
      maxQueueDepth: MAX_QUEUE_DEPTH,
      queuedRequests: this.waiters.length,
    };
  }
}

const captureGate = new BoundedCaptureGate();

export class EvidenceCaptureService {
  public async capture(input: EvidenceCaptureRequest): Promise<EvidenceCaptureResult> {
    const timeoutMs = boundedRequest(
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'invalid_timeout',
    );
    const maxBytes = boundedRequest(
      input.maxBytes ?? DEFAULT_MAX_BYTES,
      MIN_MAX_BYTES,
      HARD_MAX_BYTES,
      'invalid_max_bytes',
    );
    const requestedUrl = await admitPublicUrl(input.url, true);
    const sourceCommit = requireSourceCommit();
    const queueTimeoutMs = Math.min(timeoutMs, MAX_QUEUE_WAIT_MS);
    const permit = await captureGate.acquire(queueTimeoutMs);
    const remainingMs = timeoutMs - permit.queueMs;
    if (remainingMs < MIN_TIMEOUT_MS) {
      permit.release();
      throw new EvidenceCaptureError(
        504,
        'evidence_deadline_exhausted',
        true,
        'queue',
        'the evidence deadline expired before rendering could start',
      );
    }

    const renderStarted = performance.now();
    const work = this.captureWithinBrowser(
      requestedUrl,
      input.kind,
      input.element,
      remainingMs,
      maxBytes,
      sourceCommit,
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new EvidenceCaptureError(
              504,
              'evidence_render_timeout',
              true,
              'render',
              'the bounded evidence render deadline expired',
            ),
          ),
        remainingMs,
      );
    });
    try {
      const result = await Promise.race([work, timeout]);
      const metrics: CaptureMetrics = {
        queueMs: permit.queueMs,
        renderMs: Math.round(performance.now() - renderStarted),
        activeConcurrency: permit.activeConcurrency,
        maxConcurrency: MAX_CONCURRENCY,
        queuedRequests: permit.queuedRequests,
        outcome: 'success',
      };
      console.info('headlessx evidence capture completed', metrics);
      permit.release();
      return { ...result, metrics };
    } catch (error) {
      const mapped = mapCaptureError(error);
      mapped.metrics = {
        queueMs: permit.queueMs,
        renderMs: Math.round(performance.now() - renderStarted),
        activeConcurrency: permit.activeConcurrency,
        maxConcurrency: MAX_CONCURRENCY,
        queuedRequests: permit.queuedRequests,
        outcome: mapped.code.includes('timeout') ? 'timeout' : 'failure',
      };
      console.warn('headlessx evidence capture failed', {
        ...mapped.metrics,
        code: mapped.code,
        phase: mapped.phase,
      });
      if (mapped.code === 'evidence_render_timeout') {
        void work.catch(() => undefined).finally(permit.release);
      } else {
        permit.release();
      }
      throw mapped;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async captureWithinBrowser(
    requestedUrl: string,
    kind: EvidenceCaptureKind,
    elementRequest: EvidenceElementRequest | undefined,
    timeoutMs: number,
    maxBytes: number,
    sourceCommit: string,
  ): Promise<Omit<EvidenceCaptureResult, 'metrics'>> {
    let capture: IsolatedBrowserPage | undefined;
    let browserDeadline: NodeJS.Timeout | undefined;
    try {
      capture = await browserService.getIsolatedEvidencePage();
      const { browser, page, viewport } = capture;
      browserDeadline = setTimeout(() => {
        void browser.close().catch(() => undefined);
      }, timeoutMs);
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      const navigationUrls: string[] = [];
      const artifactFetchUrls: string[] = [];
      let artifactFetchActive = false;
      const interactions: EvidenceInteraction[] = [];
      let blocked: EvidenceCaptureError | undefined;
      let latestDocumentResponse: BrowserResponse | null = null;
      page.on('response', (candidate) => {
        if (
          candidate.request().isNavigationRequest() &&
          candidate.request().frame() === page.mainFrame()
        ) {
          latestDocumentResponse = candidate;
        }
      });
      await page.route('**/*', async (route: Route, request: BrowserRequest) => {
        try {
          const admittedUrl = await admitBrowserRequest(request);
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            navigationUrls.push(admittedUrl);
          }
          if (kind === 'artifact' && artifactFetchActive && request.resourceType() === 'fetch') {
            artifactFetchUrls.push(admittedUrl);
          }
          await route.continue();
        } catch (error) {
          blocked = mapCaptureError(error);
          await route.abort('blockedbyclient').catch(() => undefined);
        }
      });

      let response: BrowserResponse | null;
      const navigationStarted = new Date().toISOString();
      try {
        response = await page.goto(requestedUrl, {
          timeout: timeoutMs,
          waitUntil: kind === 'artifact' ? 'commit' : 'domcontentloaded',
        });
      } catch (error) {
        if (blocked) throw blocked;
        throw error;
      }
      interactions.push(successfulInteraction(1, 'navigate', navigationStarted));
      if (blocked) throw blocked;

      if (kind !== 'artifact') {
        const waitStarted = new Date().toISOString();
        response = await selectMainDocumentResponse(
          response,
          () => latestDocumentResponse,
          async () => {
            await page
              .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 8_000) })
              .catch(() => undefined);
            await page.waitForTimeout(250);
            if (blocked) throw blocked;
            interactions.push(successfulInteraction(2, 'wait_for_document', waitStarted));
          },
        );
        if ((await page.locator('input[type="password"]').count()) > 0) {
          throw invalidTarget();
        }
      } else {
        response = await selectMainDocumentResponse(response, () => latestDocumentResponse);
      }

      let finalUrl = await admitPublicUrl(page.url(), true);
      let redirectChain: string[];
      let headers: Record<string, string>;
      let contentType: string | null;
      let body: Buffer;
      let responseStatus: number;
      let capturedDomHtml: string | null = null;
      let navigationResponseSource: 'network_response' | 'performance_navigation_timing' =
        'network_response';
      const sourceStarted = new Date().toISOString();
      if (response) {
        redirectChain = mergeNavigationChain(
          await responseRedirectChain(response),
          navigationUrls,
          finalUrl,
        );
        headers = allowlistedHeaders(await response.allHeaders());
        contentType = headers['content-type'] ?? null;
        rejectOversizedContentLength(headers['content-length'], maxBytes);
        body = await response.body();
        responseStatus = response.status();
        navigationResponseSource = 'network_response';
      } else if (kind === 'artifact') {
        artifactFetchActive = true;
        const fallback = await captureEvidenceStep('artifact_fetch', () =>
          page.evaluate(collectBoundedPublicArtifact, {
            url: page.url(),
            maxBytes,
            allowedHeaders: [...ALLOWED_HEADERS],
          }),
        ).finally(() => {
          artifactFetchActive = false;
        });
        if (fallback.outcome === 'too_large') {
          throw captureTooLarge();
        }
        if (fallback.outcome === 'missing_body') {
          throw missingNavigationResponse();
        }
        finalUrl = await admitPublicUrl(fallback.finalUrl, true);
        redirectChain = mergeNavigationChain(
          [],
          [...navigationUrls, ...artifactFetchUrls],
          finalUrl,
        );
        headers = allowlistedHeaders(fallback.headers);
        contentType = headers['content-type'] ?? null;
        rejectOversizedContentLength(headers['content-length'], maxBytes);
        body = Buffer.from(fallback.data, 'base64');
        if (body.length !== fallback.byteLength || body.length > maxBytes) {
          throw captureTooLarge();
        }
        responseStatus = fallback.status;
      } else {
        const navigationTiming = await captureEvidenceStep('navigation_timing', () =>
          page.evaluate(() => {
            const navigation = performance.getEntriesByType('navigation')[0] as
              | (PerformanceNavigationTiming & { responseStatus?: number })
              | undefined;
            return {
              status: navigation?.responseStatus ?? 0,
              contentType: document.contentType || '',
            };
          }),
        );
        const fallback = validateRenderedDocumentFallback(
          navigationTiming.status,
          navigationTiming.contentType,
        );
        if (!fallback) throw missingNavigationResponse();
        capturedDomHtml = await captureEvidenceStep('dom_source', () => page.content());
        body = Buffer.from(capturedDomHtml);
        responseStatus = fallback.status;
        contentType = fallback.contentType;
        headers = {};
        redirectChain = mergeNavigationChain([], navigationUrls, finalUrl);
        navigationResponseSource = 'performance_navigation_timing';
      }
      interactions.push(
        successfulInteraction(kind === 'artifact' ? 2 : 3, 'capture_source', sourceStarted),
      );
      enforceAggregateSize(maxBytes, body);

      let html: string | null = null;
      let markdown: string | null = null;
      let screenshot: EvidenceScreenshot | null = null;
      let element: EvidenceElementCapture | undefined;
      let links: string[] = [];
      let metadata: Record<string, unknown> = {};
      if (kind !== 'artifact') {
        if (!contentType?.toLowerCase().includes('html')) {
          throw new EvidenceCaptureError(
            422,
            'evidence_unsupported_content',
            false,
            'response',
            'the rendered document response is not HTML',
          );
        }
        const domStarted = new Date().toISOString();
        html = capturedDomHtml ?? (await captureEvidenceStep('dom_source', () => page.content()));
        markdown = await page
          .locator('body')
          .innerText()
          .catch(() => '');
        interactions.push(successfulInteraction(4, 'capture_dom', domStarted));
        const screenshotStarted = new Date().toISOString();
        const screenshotBytes = await captureEvidenceStep('screenshot', () =>
          page.screenshot({ fullPage: false, type: 'png' }),
        );
        interactions.push(successfulInteraction(5, 'capture_screenshot', screenshotStarted));
        enforceAggregateSize(
          maxBytes,
          body,
          Buffer.from(html),
          Buffer.from(markdown),
          screenshotBytes,
        );
        screenshot = {
          mediaType: 'image/png',
          encoding: 'base64',
          data: screenshotBytes.toString('base64'),
          sha256: evidenceSha256(screenshotBytes),
          byteLength: screenshotBytes.length,
        };
        if (kind === 'element') {
          if (!elementRequest) throw invalidElementRequest();
          element = await captureLogoElement(page, elementRequest, viewport);
          enforceAggregateSize(
            maxBytes,
            body,
            Buffer.from(html),
            Buffer.from(markdown),
            screenshotBytes,
            Buffer.from(element.screenshot.data, 'base64'),
          );
        }
        links = await captureEvidenceStep('links', () =>
          page.evaluate(collectBoundedPublicLinks, MAX_LINKS),
        );
        metadata = await captureEvidenceStep('metadata', () =>
          page.evaluate(() => ({
            language: document.documentElement.lang || null,
            title: document.title,
          })),
        );
        metadata.navigationResponseSource = navigationResponseSource;
      }

      return {
        schemaVersion: SCHEMA_VERSION,
        producer: {
          name: 'headlessx',
          version: process.env.npm_package_version ?? '2.1.2',
          sourceCommit,
        },
        requestedUrl,
        finalUrl,
        redirectChain,
        status: responseStatus,
        headers,
        contentType,
        body: {
          encoding: 'base64',
          data: body.toString('base64'),
          sha256: evidenceSha256(body),
          byteLength: body.length,
        },
        html,
        markdown,
        screenshot,
        element,
        links,
        metadata,
        browser: {
          name: 'headfox',
          version: browser.version(),
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          javascriptEnabled: true,
          isolatedSession: true,
        },
        interactions,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      if (browserDeadline) clearTimeout(browserDeadline);
      if (capture) await browserService.releaseIsolatedEvidencePage(capture);
    }
  }
}

async function captureLogoElement(
  page: Page,
  request: EvidenceElementRequest,
  viewport: { width: number; height: number },
): Promise<EvidenceElementCapture> {
  const locator = page.locator(request.selector);
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) {
    throw invalidLogoElement('evidence_element_not_unique_or_visible');
  }
  const boundingBox = await locator.boundingBox();
  if (!boundingBox) throw invalidLogoElement('evidence_element_not_visible');
  const inspection = await locator.evaluate((node): LogoElementInspection => {
    const root = node as HTMLElement;
    const descendants = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    const images = descendants.filter(
      (element) => element.tagName.toLowerCase() === 'img',
    ) as HTMLImageElement[];
    const tagName = root.tagName.toLowerCase();
    const role = root.getAttribute('role') || (tagName === 'a' ? 'link' : null);
    const visibleText = (root.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 512);
    const identityEvidence = [
      visibleText,
      root.getAttribute('aria-label') || '',
      root.getAttribute('title') || '',
      ...images.map((image) => image.alt || ''),
      ...descendants
        .filter((element) => element.tagName.toLowerCase() === 'svg')
        .map((element) => element.querySelector('title')?.textContent || ''),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1_024);
    const contextEvidence = descendants
      .flatMap((element) => [
        element.id,
        element.className && typeof element.className === 'string' ? element.className : '',
        element.getAttribute('src') || '',
        element.getAttribute('href') || '',
      ])
      .filter(Boolean)
      .join(' ')
      .slice(0, 4_096);
    const classSuffix = [...root.classList]
      .slice(0, 4)
      .map((value) => `.${value}`)
      .join('');
    return {
      stableDescription:
        `${tagName}${root.id ? `#${root.id}` : ''}${classSuffix}${role ? ` role=${role}` : ''}`.slice(
          0,
          512,
        ),
      identityEvidence,
      contextEvidence,
      tagName,
      role,
      visibleText,
      imageCount: images.length,
      loadedImageCount: images.filter(
        (image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
      ).length,
      svgCount: descendants.filter((element) => element.tagName.toLowerCase() === 'svg').length,
      backgroundImageCount: descendants.filter((element) => {
        const background = getComputedStyle(element).backgroundImage;
        return background !== 'none' && /url\(/i.test(background);
      }).length,
      canvasCount: descendants.filter((element) => element.tagName.toLowerCase() === 'canvas')
        .length,
      videoCount: descendants.filter((element) => element.tagName.toLowerCase() === 'video').length,
      iframeCount: descendants.filter((element) => element.tagName.toLowerCase() === 'iframe')
        .length,
    };
  });

  const refusal = validateLogoElementEvidence(
    request.expectedIdentity,
    inspection,
    boundingBox,
    viewport,
  );
  if (refusal) throw invalidLogoElement(refusal);

  const screenshotBytes = await locator.screenshot({
    type: 'png',
    animations: 'disabled',
  });
  if (screenshotBytes.length === 0 || screenshotBytes.length > MAX_ELEMENT_SCREENSHOT_BYTES) {
    throw invalidLogoElement('evidence_element_screenshot_refused');
  }
  return {
    selector: request.selector,
    stableDescription: inspection.stableDescription,
    expectedIdentity: request.expectedIdentity,
    identityEvidence: inspection.identityEvidence,
    tagName: inspection.tagName,
    role: inspection.role,
    visibleText: inspection.visibleText,
    boundingBox,
    viewport,
    primitives: {
      imageCount: inspection.imageCount,
      svgCount: inspection.svgCount,
      backgroundImageCount: inspection.backgroundImageCount,
      canvasCount: inspection.canvasCount,
      videoCount: inspection.videoCount,
      iframeCount: inspection.iframeCount,
    },
    screenshot: {
      mediaType: 'image/png',
      encoding: 'base64',
      data: screenshotBytes.toString('base64'),
      sha256: evidenceSha256(screenshotBytes),
      byteLength: screenshotBytes.length,
    },
  };
}

function invalidElementRequest(): EvidenceCaptureError {
  return new EvidenceCaptureError(
    400,
    'invalid_evidence_request',
    false,
    'request',
    'the element evidence request is invalid',
  );
}

function invalidLogoElement(code: string): EvidenceCaptureError {
  return new EvidenceCaptureError(
    422,
    code,
    false,
    'element',
    'the selected element is not an admitted bounded logo composition',
  );
}

async function admitBrowserRequest(request: BrowserRequest): Promise<string> {
  const value = request.url();
  if (value.startsWith('data:') || value.startsWith('blob:') || value === 'about:blank') {
    return value;
  }
  return admitPublicUrl(value, request.isNavigationRequest());
}

function successfulInteraction(
  ordinal: number,
  action: EvidenceInteraction['action'],
  startedAt: string,
): EvidenceInteraction {
  return {
    ordinal,
    action,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: 'success',
  };
}

function mergeNavigationChain(
  redirects: string[],
  navigations: string[],
  finalUrl: string,
): string[] {
  const chain: string[] = [];
  for (const url of [...navigations, ...redirects]) {
    if (url !== finalUrl && chain.at(-1) !== url) chain.push(url);
  }
  return chain;
}

async function admitPublicUrl(value: string, rejectAuthentication: boolean): Promise<string> {
  if (Buffer.byteLength(value) > MAX_URL_BYTES) throw invalidTarget();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidTarget();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (rejectAuthentication && AUTH_PATH.test(url.pathname)) ||
    (rejectAuthentication && [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY.test(key)))
  ) {
    throw invalidTarget();
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw invalidTarget();
  }
  // Resolve on every browser request. A capture-local positive cache would let
  // DNS rebinding evade the later admission checks.
  await admitHost(host);
  return url.toString();
}

async function admitHost(host: string): Promise<void> {
  if (isIP(host)) {
    if (!isGlobalIp(host)) throw invalidTarget();
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EvidenceCaptureError(
      502,
      'evidence_dns_failed',
      true,
      'admission',
      'the public target could not be resolved',
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isGlobalIp(address))) {
    throw invalidTarget();
  }
}

function isGlobalIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isGlobalIp(normalized.slice(7));
    const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !normalized.startsWith('2001:db8:') &&
      normalized !== '2001:db8::'
    );
  }
  return false;
}

async function responseRedirectChain(response: BrowserResponse): Promise<string[]> {
  const chain: string[] = [];
  let request: BrowserRequest | null = response.request().redirectedFrom();
  while (request) {
    chain.unshift(await admitPublicUrl(request.url(), true));
    request = request.redirectedFrom();
  }
  return chain;
}

function allowlistedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name, value]) => ALLOWED_HEADERS.has(name) && Buffer.byteLength(value) <= 8_192),
  );
}

function enforceAggregateSize(maxBytes: number, ...values: Buffer[]): void {
  const total = values.reduce((sum, value) => sum + value.length, 0);
  if (total > maxBytes) {
    throw captureTooLarge();
  }
}

function captureTooLarge(): EvidenceCaptureError {
  return new EvidenceCaptureError(
    413,
    'evidence_capture_too_large',
    false,
    'response',
    'the evidence capture exceeded its configured byte bound',
  );
}

function rejectOversizedContentLength(value: string | undefined, maxBytes: number): void {
  if (!value) return;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
    throw new EvidenceCaptureError(
      413,
      'evidence_capture_too_large',
      false,
      'response',
      'the evidence capture exceeded its configured byte bound',
    );
  }
}

function boundedRequest(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EvidenceCaptureError(400, code, false, 'request', 'the evidence request is invalid');
  }
  return value;
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function requireSourceCommit(): string {
  const value = process.env.HEADLESSX_SOURCE_COMMIT?.trim() ?? '';
  if (![40, 64].includes(value.length) || !/^[0-9a-f]+$/.test(value)) {
    throw new EvidenceCaptureError(
      503,
      'evidence_source_version_unavailable',
      false,
      'configuration',
      'the evidence producer source version is unavailable',
    );
  }
  return value;
}

function invalidTarget(): EvidenceCaptureError {
  return new EvidenceCaptureError(
    422,
    'unsafe_or_authenticated_target',
    false,
    'admission',
    'the target is not an unauthenticated public HTTP URL',
  );
}

function missingNavigationResponse(): EvidenceCaptureError {
  return new EvidenceCaptureError(
    502,
    'evidence_missing_response',
    true,
    'navigation',
    'the browser did not expose a verifiable main response',
  );
}

function mapCaptureError(error: unknown): EvidenceCaptureError {
  if (error instanceof EvidenceCaptureError) return error;
  if (error instanceof EvidenceCaptureStepError) {
    return new EvidenceCaptureError(
      502,
      `evidence_${error.step}_failed`,
      true,
      error.step,
      `the isolated browser could not complete its ${error.step} capture step`,
    );
  }
  if (error instanceof IsolatedEvidenceBrowserError) {
    return new EvidenceCaptureError(
      502,
      `evidence_browser_${error.stage}_failed`,
      true,
      `browser_${error.stage}`,
      `the isolated browser could not complete its ${error.stage} stage`,
    );
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timeout')) {
    return new EvidenceCaptureError(
      504,
      'evidence_render_timeout',
      true,
      'render',
      'the bounded evidence render deadline expired',
    );
  }
  return new EvidenceCaptureError(
    502,
    'evidence_browser_failed',
    true,
    'render',
    'the isolated browser could not produce a verified capture',
  );
}

export const evidenceCaptureService = new EvidenceCaptureService();

export function getEvidenceCaptureMetrics(): Record<string, number> {
  return captureGate.snapshot();
}
