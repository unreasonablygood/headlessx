import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  EvidenceCaptureError,
  evidenceCaptureService,
  getEvidenceCaptureMetrics,
} from '../../services/scrape/EvidenceCaptureService';

const EvidenceCaptureRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(8 * 1024),
    kind: z.enum(['document', 'artifact', 'element']).default('document'),
    element: z
      .object({
        selector: z
          .string()
          .min(2)
          .max(129)
          .regex(/^(?:#[A-Za-z_][A-Za-z0-9_.:-]*|\.[A-Za-z_][A-Za-z0-9_-]*)$/),
        expectedIdentity: z.string().trim().min(2).max(160),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(2_000).max(55_000).optional(),
    maxBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === 'element') !== Boolean(value.element)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'element evidence is required only for element captures',
        path: ['element'],
      });
    }
  });

export class EvidenceCaptureController {
  public static metrics(_req: Request, res: Response): void {
    res.json(getEvidenceCaptureMetrics());
  }

  public static async capture(req: Request, res: Response): Promise<void> {
    const parsed = EvidenceCaptureRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_evidence_request',
          message: 'the evidence capture request is invalid',
          phase: 'request',
          retryable: false,
        },
      });
      return;
    }
    try {
      res.json(await evidenceCaptureService.capture(parsed.data));
    } catch (error) {
      const mapped =
        error instanceof EvidenceCaptureError
          ? error
          : new EvidenceCaptureError(
              500,
              'evidence_internal_error',
              false,
              'internal',
              'the evidence capture failed internally',
            );
      res.status(mapped.status).json({
        error: {
          code: mapped.code,
          message: mapped.message,
          phase: mapped.phase,
          retryable: mapped.retryable,
        },
        metrics: mapped.metrics,
      });
    }
  }
}
