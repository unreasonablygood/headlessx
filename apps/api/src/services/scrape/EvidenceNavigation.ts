export async function selectMainDocumentResponse<T>(
  navigationResponse: T | null,
  observedMainDocumentResponse: () => T | null,
  waitForObservation?: () => Promise<void>,
): Promise<T | null> {
  if (waitForObservation) await waitForObservation();
  return navigationResponse ?? observedMainDocumentResponse();
}

export interface RenderedDocumentFallback {
  status: number;
  contentType: string;
}

export type EvidenceCaptureStep =
  | 'navigation_timing'
  | 'dom_source'
  | 'artifact_fetch'
  | 'screenshot'
  | 'links'
  | 'metadata';

export type BrowserArtifactCapture =
  | {
      outcome: 'success';
      finalUrl: string;
      status: number;
      headers: Record<string, string>;
      data: string;
      byteLength: number;
    }
  | { outcome: 'too_large' }
  | { outcome: 'missing_body' };

export class EvidenceCaptureStepError extends Error {
  public constructor(public readonly step: EvidenceCaptureStep) {
    super(`evidence capture step failed: ${step}`);
  }
}

export async function captureEvidenceStep<T>(
  step: EvidenceCaptureStep,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new EvidenceCaptureStepError(step);
  }
}

export function collectBoundedPublicLinks(limit: number): string[] {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
  return Array.from(
    new Set(
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((anchor) => anchor.href)
        .filter((url) => url.startsWith('http://') || url.startsWith('https://')),
    ),
  ).slice(0, boundedLimit);
}

export async function collectBoundedPublicArtifact(input: {
  url: string;
  maxBytes: number;
  allowedHeaders: string[];
}): Promise<BrowserArtifactCapture> {
  const response = await fetch(input.url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'follow',
  });
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isSafeInteger(declaredLength) && declaredLength > input.maxBytes) {
    return { outcome: 'too_large' };
  }
  if (!response.body) return { outcome: 'missing_body' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > input.maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { outcome: 'too_large' };
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const allowedHeaders = new Set(input.allowedHeaders.map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (allowedHeaders.has(name.toLowerCase()) && value.length <= 8_192) {
      headers[name.toLowerCase()] = value;
    }
  });
  return {
    outcome: 'success',
    finalUrl: response.url,
    status: response.status,
    headers,
    data: btoa(binary),
    byteLength,
  };
}

export function validateRenderedDocumentFallback(
  status: number,
  contentType: string,
): RenderedDocumentFallback | null {
  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !contentType.toLowerCase().includes('html')
  ) {
    return null;
  }
  return { status, contentType };
}
