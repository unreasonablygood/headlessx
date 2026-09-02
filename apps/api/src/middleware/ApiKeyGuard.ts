import type { NextFunction, Request, Response } from 'express';
import { apiKeyAuthService } from '../services/auth/ApiKeyAuthService';
import { admitTrustedWebsiteRequest } from '../services/auth/TrustedWebsiteAdmission';

// Add user property to Request
declare global {
  namespace Express {
    interface Request {
      apiKeyId?: string;
      isInternal?: boolean;
    }
  }
}

export const ApiKeyGuard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const trustedAdmission = admitTrustedWebsiteRequest(req, apiKey);
    if (
      trustedAdmission.kind === 'direct-seat' ||
      trustedAdmission.kind === 'web-document-service'
    ) {
      req.isInternal = false;
      req.apiKeyId = `tailnet:${trustedAdmission.identity}`;
      return next();
    }
    if (trustedAdmission.kind === 'refused') {
      return res.status(403).json({
        success: false,
        error: { code: 'TRUSTED_IDENTITY_REFUSED', message: 'Trusted website admission refused' },
      });
    }
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: { code: 'MISSING_API_KEY', message: 'x-api-key header is missing' },
      });
    }

    const authenticatedKey = await apiKeyAuthService.authenticate(apiKey);
    if (!authenticatedKey) {
      return res.status(403).json({
        success: false,
        error: { code: 'INVALID_API_KEY', message: 'Invalid or revoked API Key' },
      });
    }

    req.isInternal = authenticatedKey.isInternal;
    if (!authenticatedKey.isInternal) {
      req.apiKeyId = authenticatedKey.id;
    }

    next();
  } catch (error) {
    console.error('ApiKeyGuard Error:', error);
    res
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Auth service failure' } });
  }
};
