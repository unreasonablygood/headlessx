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
