import { expect, test } from 'bun:test';

import {
  captureEvidenceStep,
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
