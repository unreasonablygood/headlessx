// Load environment variables FIRST
import './env';

// Now import app after env is loaded
import app from './app';
import { loadEvidenceApiKey } from './services/auth/TrustedWebsiteAdmission';
import { browserService } from './services/scrape/BrowserService';
import { assertSecurityConfiguration } from './utils/security';

const PORT = parseInt(process.env.PORT || '38473', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  try {
    assertSecurityConfiguration();
    if (process.env.NODE_ENV === 'production') {
      loadEvidenceApiKey();
    }

    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 HeadlessX Backend running on http://${HOST}:${PORT}`);
      console.log(`📂 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    const shutdown = async (signal: string) => {
      console.log(`🛑 Received ${signal}. Shutting down browser profile...`);
      await browserService.closeAll();
      server.close(() => process.exit(0));
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
