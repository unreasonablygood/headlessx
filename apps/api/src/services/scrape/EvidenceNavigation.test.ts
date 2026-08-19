import { expect, test } from 'bun:test';

import {
  captureEvidenceStep,
  collectBoundedPublicArtifact,
  collectBoundedPublicLinks,
  EvidenceCaptureStepError,
  selectMainDocumentResponse,
  validateRenderedDocumentFallback,
} from './EvidenceNavigation';

test('waits for a delayed observed response when Headfox goto returns null', async () => {
  const observed = { status: 200 };
  let latest: typeof observed | null = null;

  expect(
    await selectMainDocumentResponse(
      null,
      () => latest,
      async () => {
        latest = observed;
      },
    ),
  ).toBe(observed);
});

test('keeps the direct navigation response when Playwright returns one', async () => {
  const direct = { status: 200 };
  const observed = { status: 302 };

  expect(await selectMainDocumentResponse(direct, () => observed)).toBe(direct);
});

test('accepts an HTML navigation timing fallback with a real HTTP status', () => {
  expect(validateRenderedDocumentFallback(200, 'text/html')).toEqual({
    status: 200,
    contentType: 'text/html',
  });
});

test('rejects missing status and non-HTML navigation timing fallbacks', () => {
  expect(validateRenderedDocumentFallback(0, 'text/html')).toBeNull();
  expect(validateRenderedDocumentFallback(200, 'image/png')).toBeNull();
});

test('labels every bounded browser capture operation without preserving its unsafe error', async () => {
  for (const step of [
    'navigation_timing',
    'dom_source',
    'artifact_fetch',
    'screenshot',
    'links',
    'metadata',
  ] as const) {
    const failure = captureEvidenceStep(step, async () => {
      throw new Error('unsafe browser detail');
    });

    await expect(failure).rejects.toEqual(new EvidenceCaptureStepError(step));
    await expect(failure).rejects.not.toHaveProperty('message', 'unsafe browser detail');
  }
});

test('collects an exact bounded public artifact without credentials', async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestInit = init;
    return new Response(new Uint8Array([0, 1, 2, 255]), {
      status: 200,
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
        'x-private-detail': 'not retained',
      },
    });
  }) as typeof fetch;

  try {
    expect(
      await collectBoundedPublicArtifact({
        url: 'https://example.com/logo.png',
        maxBytes: 4,
        allowedHeaders: ['content-length', 'content-type'],
      }),
    ).toEqual({
      outcome: 'success',
      finalUrl: '',
      status: 200,
      headers: { 'content-length': '4', 'content-type': 'image/png' },
      data: 'AAEC/w==',
      byteLength: 4,
    });
    expect(requestInit).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stops a browser artifact stream at the hard byte bound', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0, 1, 2, 3, 4]), {
      status: 200,
    })) as typeof fetch;

  try {
    expect(
      await collectBoundedPublicArtifact({
        url: 'https://example.com/large.bin',
        maxBytes: 4,
        allowedHeaders: [],
      }),
    ).toEqual({ outcome: 'too_large' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collects public links with browser-side deduplication and a hard result cap', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => [
        { href: 'https://example.com/one' },
        { href: 'mailto:private@example.com' },
        { href: 'https://example.com/one' },
        { href: 'http://example.com/two' },
        { href: 'https://example.com/three' },
      ],
    },
  });

  try {
    expect(collectBoundedPublicLinks(2)).toEqual([
      'https://example.com/one',
      'http://example.com/two',
    ]);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
