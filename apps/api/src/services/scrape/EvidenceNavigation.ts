export async function selectMainDocumentResponse<T>(
  navigationResponse: T | null,
  observedMainDocumentResponse: () => T | null,
  waitForObservation?: () => Promise<void>,
): Promise<T | null> {
  if (waitForObservation) await waitForObservation();
  return navigationResponse ?? observedMainDocumentResponse();
}
