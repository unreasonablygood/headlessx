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

export type EvidenceCaptureStep = 'navigation_timing' | 'dom_source';

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
