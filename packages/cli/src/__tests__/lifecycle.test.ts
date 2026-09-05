import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPOSE_SECRET_NAMES,
  assertComposeSecretFiles,
  assertProductionDashboardAccess,
  assertProductionHostBind,
  buildHealthProbeCandidates,
  checkHttpHealth,
  ensureComposeSecretFiles,
  hashDashboardPassword,
  isLoopbackHostBind,
  normalizeHostBindAddress,
  readEnvFile,
  removeEnvValues,
  requiredCommandsForMode,
  syncProductionCaddyfile,
  upsertEnvValues,
  type LifecycleCommandRunner,
} from '../utils/lifecycle';
import { DEFAULT_BRANCH, DEFAULT_REPO_URL } from '../utils/workspace';
import { loadDashboardInternalApiKey } from '../../../../apps/web/src/lib/dashboardInternalApiKey';

const temporaryDirectories: string[] = [];
const DOCUMENTED_BCRYPT_VERIFIER =
  '$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function privateCredentialFile(mode = 0o400): { path: string; uid: number; gid: number } {
  const directory = mkdtempSync(join(tmpdir(), 'headlessx-web-secret-'));
  temporaryDirectories.push(directory);
  const secretPath = join(directory, 'dashboard-internal-api-key');
  writeFileSync(secretPath, 'a'.repeat(64), { mode });
  const stat = lstatSync(secretPath);
  return { path: secretPath, uid: stat.uid, gid: stat.gid };
}

describe('buildHealthProbeCandidates', () => {
  test('adds a 127.0.0.1 fallback for localhost URLs', () => {
    expect(buildHealthProbeCandidates('http://localhost:38473/api/health')).toEqual([
      'http://localhost:38473/api/health',
      'http://127.0.0.1:38473/api/health',
    ]);
  });

  test('normalizes 0.0.0.0 to a client-safe loopback fallback', () => {
    expect(buildHealthProbeCandidates('http://0.0.0.0:34872')).toEqual([
      'http://0.0.0.0:34872/',
      'http://127.0.0.1:34872/',
    ]);
  });

  test('leaves non-loopback hosts untouched', () => {
    expect(buildHealthProbeCandidates('https://api.example.com/health')).toEqual([
      'https://api.example.com/health',
    ]);
  });
});

describe('checkHttpHealth', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('127.0.0.1')) {
        return new Response('', { status: 200, statusText: 'OK' });
      }

      throw new Error('fetch failed');
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('falls back from localhost to 127.0.0.1 when the first request fails', async () => {
    const result = await checkHttpHealth('http://localhost:38473/api/health');

    expect(result).toEqual({
      ok: true,
      detail: '200 OK',
      url: 'http://127.0.0.1:38473/api/health',
      tried: [
        'http://localhost:38473/api/health',
        'http://127.0.0.1:38473/api/health',
      ],
    });
  });

  test('treats the production dashboard Basic challenge as reachable', async () => {
    global.fetch = vi.fn(async () => {
      return new Response('', {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'www-authenticate': 'Basic realm="restricted"' },
      });
    }) as typeof fetch;

    const result = await checkHttpHealth('https://dashboard.example.com', {
      acceptBasicAuthChallenge: true,
    });

    expect(result).toEqual({
      ok: true,
      detail: '401 Unauthorized',
      url: 'https://dashboard.example.com/',
      tried: ['https://dashboard.example.com/'],
    });
  });
});

describe('Compose credential bootstrap', () => {
  test('creates the fixed credential set privately without rewriting existing values', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'headlessx-cli-'));
    temporaryDirectories.push(workspace);
    const secretDirectory = join(workspace, 'secrets');
    const legacyValues = {
      'postgres-password': 'existing-postgres-password',
      'dashboard-internal-api-key': 'd'.repeat(64),
      'credential-encryption-key': 'c'.repeat(64),
    };

    ensureComposeSecretFiles(secretDirectory, legacyValues);
    assertComposeSecretFiles(secretDirectory);

    expect(readFileSync(join(secretDirectory, 'postgres-password'), 'utf-8')).toBe(
      legacyValues['postgres-password']
    );
    expect(readFileSync(join(secretDirectory, 'dashboard-internal-api-key'), 'utf-8')).toBe(
      legacyValues['dashboard-internal-api-key']
    );
    expect(readFileSync(join(secretDirectory, 'credential-encryption-key'), 'utf-8')).toBe(
      legacyValues['credential-encryption-key']
    );
    expect(readFileSync(join(secretDirectory, 'evidence-api-key'), 'utf-8')).toHaveLength(64);

    if (process.platform !== 'win32') {
      expect(lstatSync(secretDirectory).mode & 0o777).toBe(0o700);
      for (const name of COMPOSE_SECRET_NAMES) {
        expect(lstatSync(join(secretDirectory, name)).mode & 0o777).toBe(0o400);
      }
    }
  });

  test('refuses an incomplete existing credential set instead of regenerating it', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'headlessx-cli-'));
    temporaryDirectories.push(workspace);
    const secretDirectory = join(workspace, 'secrets');
    ensureComposeSecretFiles(secretDirectory);
    rmSync(join(secretDirectory, 'credential-encryption-key'));

    expect(() => ensureComposeSecretFiles(secretDirectory)).toThrow(
      /credential-encryption-key is missing/
    );
  });

  test('removes migrated credential values from the Compose environment file', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'headlessx-cli-'));
    temporaryDirectories.push(workspace);
    const envPath = join(workspace, '.env');
    writeFileSync(
      envPath,
      [
        'POSTGRES_PASSWORD=legacy-database-secret',
        'DASHBOARD_INTERNAL_API_KEY=legacy-dashboard-secret',
        'CREDENTIAL_ENCRYPTION_KEY=legacy-encryption-secret',
        'API_HOST_PORT=38473',
        '',
      ].join('\n')
    );

    removeEnvValues(envPath, [
      'POSTGRES_PASSWORD',
      'DASHBOARD_INTERNAL_API_KEY',
      'CREDENTIAL_ENCRYPTION_KEY',
    ]);

    expect(readFileSync(envPath, 'utf-8')).toBe('API_HOST_PORT=38473\n');
  });
});

describe('mode-specific lifecycle requirements', () => {
  test('does not require Docker for developer mode', () => {
    expect(requiredCommandsForMode('developer')).toEqual(['git', 'node', 'pnpm']);
  });

  test('requires Docker only for Compose-backed modes', () => {
    expect(requiredCommandsForMode('self-host')).toEqual(['git', 'docker']);
    expect(requiredCommandsForMode('production')).toEqual(['git', 'docker']);
  });

  test('bootstraps the owner fork default branch', () => {
    expect(DEFAULT_REPO_URL).toBe('https://github.com/unreasonablygood/headlessx.git');
    expect(DEFAULT_BRANCH).toBe('master');
  });
});

describe('self-host network boundary', () => {
  test('defaults published ports to loopback and recognizes explicit remote binding', () => {
    expect(normalizeHostBindAddress()).toBe('127.0.0.1');
    expect(isLoopbackHostBind('127.0.0.1')).toBe(true);
    expect(isLoopbackHostBind('0.0.0.0')).toBe(false);
    expect(() => normalizeHostBindAddress('dashboard.example.com')).toThrow(
      /must be an IPv4 address/
    );
    expect(assertProductionHostBind()).toBe('127.0.0.1');
    expect(() => assertProductionHostBind('0.0.0.0')).toThrow(/cannot bypass Caddy/);
  });
});

describe('production dashboard access boundary', () => {
  test('passes plaintext to the fixed Caddy hasher only over stdin', () => {
    const password = 'correct horse battery staple';
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    let capturedInput: unknown;
    const execute: LifecycleCommandRunner = (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedInput = options?.input;
      return {
        success: true,
        stdout: `${DOCUMENTED_BCRYPT_VERIFIER}\n`,
        stderr: '',
        status: 0,
      };
    };

    expect(hashDashboardPassword(password, execute)).toBe(DOCUMENTED_BCRYPT_VERIFIER);
    expect(capturedCommand).toBe('docker');
    expect(capturedArgs).not.toContain('--plaintext');
    expect(capturedArgs).toContain('caddy:2.10-alpine');
    expect(capturedArgs.join(' ')).not.toContain(password);
    expect(capturedInput).toBe(password);
  });

  test('does not surface plaintext when Caddy hashing fails', () => {
    const password = 'another private dashboard password';
    const execute: LifecycleCommandRunner = () => ({
      success: false,
      stdout: '',
      stderr: `failed to hash ${password}`,
      status: 1,
    });

    expect(() => hashDashboardPassword(password, execute)).toThrow(
      'Caddy could not hash the dashboard password.'
    );
  });

  test('persists only a Compose-safe bcrypt verifier', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'headlessx-dashboard-auth-'));
    temporaryDirectories.push(workspace);
    const envPath = join(workspace, '.env');
    const password = 'private dashboard password for test';
    const execute: LifecycleCommandRunner = () => ({
      success: true,
      stdout: DOCUMENTED_BCRYPT_VERIFIER,
      stderr: '',
      status: 0,
    });
    const passwordHash = hashDashboardPassword(password, execute);

    upsertEnvValues(envPath, {
      HEADLESSX_DASHBOARD_USER: 'headlessx',
      HEADLESSX_DASHBOARD_PASSWORD_HASH: passwordHash,
    });

    const persisted = readFileSync(envPath, 'utf-8');
    expect(persisted).toContain(
      `HEADLESSX_DASHBOARD_PASSWORD_HASH='${DOCUMENTED_BCRYPT_VERIFIER}'`
    );
    expect(persisted).not.toContain(password);
    expect(readEnvFile(envPath)).toEqual({
      HEADLESSX_DASHBOARD_USER: 'headlessx',
      HEADLESSX_DASHBOARD_PASSWORD_HASH: DOCUMENTED_BCRYPT_VERIFIER,
    });
  });

  test('fails closed on missing or invalid dashboard access configuration', () => {
    expect(() =>
      assertProductionDashboardAccess({
        username: 'headlessx',
      })
    ).toThrow(/bcrypt verifier is missing/);
    expect(() =>
      assertProductionDashboardAccess({
        username: 'headlessx',
        passwordHash: 'plaintext-is-not-a-verifier',
      })
    ).toThrow(/must be a bcrypt hash/);
    expect(() =>
      assertProductionDashboardAccess({
        username: 'operator }',
        passwordHash: DOCUMENTED_BCRYPT_VERIFIER,
      })
    ).toThrow(/username must use/);

    expect(
      assertProductionDashboardAccess({
        username: 'headlessx',
        passwordHash: DOCUMENTED_BCRYPT_VERIFIER,
      })
    ).toEqual({
      username: 'headlessx',
      passwordHash: DOCUMENTED_BCRYPT_VERIFIER,
    });
  });

  test('refuses to reuse a legacy Caddy template without the access boundary', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'headlessx-caddy-config-'));
    temporaryDirectories.push(workspace);
    const templatePath = join(workspace, 'Caddyfile.template');
    const targetPath = join(workspace, 'Caddyfile');
    writeFileSync(templatePath, 'dashboard.example.com { reverse_proxy web:3000 }\n');
    writeFileSync(targetPath, 'existing-safe-target\n');

    expect(() => syncProductionCaddyfile(templatePath, targetPath)).toThrow(
      /access boundary is outdated/
    );
    expect(readFileSync(targetPath, 'utf-8')).toBe('existing-safe-target\n');

    const protectedTemplate = [
      '# headlessx-dashboard-auth-v1',
      'dashboard.example.com {',
      '  basic_auth { headlessx bcrypt-verifier }',
      '}',
      '',
    ].join('\n');
    writeFileSync(templatePath, protectedTemplate);
    syncProductionCaddyfile(templatePath, targetPath);
    expect(readFileSync(targetPath, 'utf-8')).toBe(protectedTemplate);
  });
});

describe('dashboard production credential source', () => {
  test('reads the fixed private file instead of the environment value', () => {
    const secret = privateCredentialFile();

    expect(
      loadDashboardInternalApiKey({
        nodeEnv: 'production',
        environmentValue: 'must-not-be-used',
        productionSecretPath: secret.path,
        requiredUid: secret.uid,
        requiredGid: secret.gid,
      })
    ).toBe('a'.repeat(64));
  });

  test('does not fall back to an environment credential in production', () => {
    expect(
      loadDashboardInternalApiKey({
        nodeEnv: 'production',
        environmentValue: 'must-not-be-used',
        productionSecretPath: '/missing/headlessx-dashboard-internal-api-key',
      })
    ).toBeNull();
  });

  test('rejects a writable production credential file', () => {
    const secret = privateCredentialFile(0o600);

    expect(
      loadDashboardInternalApiKey({
        nodeEnv: 'production',
        productionSecretPath: secret.path,
        requiredUid: secret.uid,
        requiredGid: secret.gid,
      })
    ).toBeNull();
  });

  test('continues to read the environment in development', () => {
    expect(
      loadDashboardInternalApiKey({
        nodeEnv: 'development',
        environmentValue: ' local-dashboard-key ',
        productionSecretPath: '/missing/headlessx-dashboard-internal-api-key',
      })
    ).toBe('local-dashboard-key');
  });
});
