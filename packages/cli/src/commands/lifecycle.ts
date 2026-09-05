import * as fs from 'node:fs';
import * as path from 'node:path';
import packageJson from '../../package.json';
import { getApiKey } from '../utils/config';
import { writeStructured, writeText } from '../utils/output';
import {
  assertComposeSecretFiles,
  assertProductionDashboardAccess,
  assertProductionHostBind,
  checkCommand,
  checkHttpHealth,
  confirm,
  DEFAULT_DASHBOARD_USER,
  DEFAULT_HOST_BIND,
  developerPortDefaults,
  ensureComposeSecretFiles,
  ensureFileFromExample,
  hashDashboardPassword,
  hostPortDefaults,
  isLoopbackHostBind,
  normalizeHostBindAddress,
  promptMode,
  promptRequired,
  readEnvFile,
  removeEnvValues,
  requiredCommandsForMode,
  resolveDeveloperPorts,
  resolveHostPorts,
  resolveSecret,
  runCommand,
  runInteractiveCommand,
  spawnDetachedProcess,
  syncProductionCaddyfile,
  upsertEnvValues,
  validateDashboardPassword,
  killDetachedProcess,
} from '../utils/lifecycle';
import {
  canUseModernPrompts,
  promptPassword,
  showInfo,
  showIntro,
  showNote,
  showOutro,
  withSpinner,
} from '../utils/ui';
import {
  clearLastStart,
  DEFAULT_BRANCH,
  ensureWorkspaceLayout,
  getRepoUrl,
  getWorkspacePaths,
  readBranch,
  readLastStart,
  readMode,
  writeBranch,
  writeLastStart,
  writeMode,
  type RuntimeState,
  type SetupMode,
} from '../utils/workspace';

interface InitOptions {
  action?: string;
  mode?: SetupMode;
  branch?: string;
  yes?: boolean;
  start?: boolean;
  apiDomain?: string;
  webDomain?: string;
  caddyEmail?: string;
  dashboardUser?: string;
  dashboardPasswordHash?: string;
  hostBind?: string;
}

interface StartOptions {
  quiet?: boolean;
  build?: boolean;
}

interface StatusOptions {
  json?: boolean;
  pretty?: boolean;
  output?: string;
}

interface DoctorOptions {
  json?: boolean;
  pretty?: boolean;
  output?: string;
}

interface LogsOptions {
  service?: string;
  tail?: string;
  follow?: boolean;
}

interface RuntimeSummary {
  configured: boolean;
  workspaceRoot: string;
  repoPath: string;
  mode?: SetupMode;
  branch?: string;
  envFiles: Record<string, boolean>;
  local: Record<string, unknown>;
}

type InitAction = 'bootstrap' | 'update';

function getRepoFile(relativePath: string): string {
  return path.join(getWorkspacePaths().repo, relativePath);
}

function getDockerEnvPath(): string {
  return getRepoFile('infra/docker/.env');
}

function getDockerEnvExamplePath(): string {
  return getRepoFile('infra/docker/.env.example');
}

function getRootEnvPath(): string {
  return getRepoFile('.env');
}

function getRootEnvExamplePath(): string {
  return getRepoFile('.env.example');
}

function getDomainEnvPath(): string {
  return getRepoFile('infra/domain-setup/.env');
}

function getDomainEnvExamplePath(): string {
  return getRepoFile('infra/domain-setup/.env.example');
}

function getDomainCaddyfilePath(): string {
  return getRepoFile('infra/domain-setup/Caddyfile');
}

function getDomainCaddyTemplatePath(): string {
  return getRepoFile('infra/domain-setup/Caddyfile.template');
}

function getDockerComposeDir(): string {
  return getRepoFile('infra/docker');
}

function getDomainComposeDir(): string {
  return getRepoFile('infra/domain-setup');
}

function parseInitAction(value?: string): InitAction {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'bootstrap';
  }
  if (normalized === 'update') {
    return 'update';
  }

  throw new Error(`Unsupported init action "${value}". Use "headlessx init" or "headlessx init update".`);
}

function printChecks(title: string, checks: Array<{ name: string; ok: boolean; detail: string }>): void {
  const lines = [title];
  for (const check of checks) {
    lines.push(`- ${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  writeText(lines.join('\n'));
}

async function reportChecks(
  title: string,
  checks: Array<{ name: string; ok: boolean; detail: string }>
): Promise<void> {
  if (!canUseModernPrompts()) {
    printChecks(title, checks);
    return;
  }

  await showNote(
    title,
    checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`)
  );
}

function requireChecks(checks: Array<{ name: string; ok: boolean; detail: string }>): void {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    return;
  }

  const message = failed.map((check) => `${check.name}: ${check.detail}`).join('\n');
  throw new Error(message);
}

function detectPrerequisites(mode: SetupMode): Array<{ name: string; ok: boolean; detail: string }> {
  const checks = requiredCommandsForMode(mode).map((name) =>
    checkCommand(name, name === 'docker' ? ['compose', 'version'] : ['--version'])
  );
  if (mode === 'developer') {
    const mise = checkCommand('mise', ['--version']);
    if (mise.ok) {
      checks.push(mise);
    }
  }

  return checks;
}

function repoExists(): boolean {
  return fs.existsSync(path.join(getWorkspacePaths().repo, '.git'));
}

function ensureRepo(branch: string): void {
  const paths = ensureWorkspaceLayout();
  const repoUrl = getRepoUrl();

  if (!repoExists()) {
    runInteractiveCommand('git', ['clone', '--branch', branch, '--single-branch', repoUrl, paths.repo]);
    return;
  }

  runInteractiveCommand('git', ['-C', paths.repo, 'fetch', 'origin', '--prune']);
  runInteractiveCommand('git', ['-C', paths.repo, 'checkout', branch]);
  runInteractiveCommand('git', ['-C', paths.repo, 'pull', '--ff-only', 'origin', branch]);
}

function getRuntimeUrls(mode: SetupMode): { apiUrl?: string; webUrl?: string } {
  if (mode === 'developer') {
    const env = readEnvFile(getRootEnvPath());
    return {
      apiUrl: env.NEXT_PUBLIC_API_URL || (env.PORT ? `http://localhost:${env.PORT}` : undefined),
      webUrl: env.WEB_PORT ? `http://localhost:${env.WEB_PORT}` : undefined,
    };
  }

  const env = readEnvFile(getDockerEnvPath());
  const apiHostPort = env.API_HOST_PORT || env.PORT;
  const webHostPort = env.WEB_HOST_PORT || env.WEB_PORT;

  if (mode === 'production') {
    const domainEnv = readEnvFile(getDomainEnvPath());
    return {
      apiUrl: domainEnv.HEADLESSX_API_DOMAIN ? `https://${domainEnv.HEADLESSX_API_DOMAIN}` : undefined,
      webUrl: domainEnv.HEADLESSX_WEB_DOMAIN ? `https://${domainEnv.HEADLESSX_WEB_DOMAIN}` : undefined,
    };
  }

  const clientHost = clientHostForBind(
    normalizeHostBindAddress(
      process.env.HEADLESSX_HOST_BIND?.trim() || env.HEADLESSX_HOST_BIND
    )
  );
  return {
    apiUrl: apiHostPort ? `http://${clientHost}:${apiHostPort}` : undefined,
    webUrl: webHostPort ? `http://${clientHost}:${webHostPort}` : undefined,
  };
}

function resolveRuntimeTargets(runtime: RuntimeSummary, fallbackApiUrl?: string): {
  apiUrl?: string;
  webUrl?: string;
} {
  const local = runtime.local as Record<string, unknown>;
  const apiUrl = typeof local.apiUrl === 'string' ? local.apiUrl : fallbackApiUrl;
  const webUrl = typeof local.webUrl === 'string' ? local.webUrl : undefined;
  return {
    apiUrl,
    webUrl,
  };
}

function buildCommandChecks(mode?: SetupMode): Array<{ name: string; ok: boolean; detail: string }> {
  const commandNames = mode ? requiredCommandsForMode(mode) : ['git', 'docker', 'node'];
  return commandNames.map((name) =>
    checkCommand(name, name === 'docker' ? ['compose', 'version'] : ['--version'])
  );
}

function readTailLines(filePath: string, maxLines: number): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trimEnd();
}

function parseTailValue(value?: string): number {
  const parsed = Number(value ?? '200');
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Tail must be a positive number.');
  }
  return Math.floor(parsed);
}

function writeRuntimeMetadata(mode: SetupMode, branch: string, extra: Partial<RuntimeState> = {}): void {
  writeMode(mode);
  writeBranch(branch);
  writeLastStart({
    mode,
    branch,
    startedAt: new Date().toISOString(),
    ...extra,
  });
}

function fallbackRuntimeUrls(mode: SetupMode): { apiUrl: string; webUrl: string } {
  const urls = getRuntimeUrls(mode);
  return {
    apiUrl: urls.apiUrl || (mode === 'production' ? '' : 'http://localhost:38473'),
    webUrl: urls.webUrl || (mode === 'production' ? '' : 'http://localhost:34872'),
  };
}

function parseEnvPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientHostForBind(address: string): string {
  return address === '0.0.0.0' ? 'localhost' : address;
}

function warnNonLoopbackHostBind(address: string): void {
  process.stderr.write(
    `Warning: HEADLESSX_HOST_BIND=${address} publishes the self-host dashboard, PostgreSQL, Redis, and sidecars beyond loopback. Use it only behind a trusted private network, firewall, or authenticated reverse proxy.\n`
  );
}

async function resolveComposeHostBind(
  current: Record<string, string>,
  options: InitOptions,
  mode: 'self-host' | 'production'
): Promise<string> {
  const requested = options.hostBind?.trim();
  const existing = current.HEADLESSX_HOST_BIND?.trim();

  if (mode === 'production') {
    if (requested) {
      assertProductionHostBind(requested);
    }
    if (existing && existing !== DEFAULT_HOST_BIND) {
      process.stderr.write(
        'Warning: resetting production core host ports to 127.0.0.1 so dashboard access cannot bypass Caddy.\n'
      );
    }
    return DEFAULT_HOST_BIND;
  }

  const hostBind = normalizeHostBindAddress(requested || existing);
  if (!isLoopbackHostBind(hostBind)) {
    warnNonLoopbackHostBind(hostBind);
    if (requested && !options.yes) {
      const accepted = await confirm(
        'Publish the self-host ports beyond loopback despite this exposure?',
        false
      );
      if (!accepted) {
        throw new Error('Non-loopback self-host binding was not accepted.');
      }
    }
  }
  return hostBind;
}

function assertRuntimeHostBind(mode: 'self-host' | 'production'): void {
  const current = readEnvFile(getDockerEnvPath());
  const hostBind = normalizeHostBindAddress(
    process.env.HEADLESSX_HOST_BIND?.trim() || current.HEADLESSX_HOST_BIND
  );

  if (mode === 'production') {
    assertProductionHostBind(hostBind);
  }
  if (mode === 'self-host' && !isLoopbackHostBind(hostBind)) {
    warnNonLoopbackHostBind(hostBind);
  }
}

const LEGACY_COMPOSE_SECRET_ENV_KEYS = [
  'POSTGRES_PASSWORD',
  'DASHBOARD_INTERNAL_API_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
] as const;

function reconcileComposeCredentials(
  envPath: string,
  current: Record<string, string>,
  useLegacyValues: boolean
): void {
  ensureComposeSecretFiles(
    getWorkspacePaths().secrets,
    useLegacyValues
      ? {
          'postgres-password': current.POSTGRES_PASSWORD,
          'dashboard-internal-api-key': current.DASHBOARD_INTERNAL_API_KEY,
          'credential-encryption-key': current.CREDENTIAL_ENCRYPTION_KEY,
        }
      : {}
  );
  removeEnvValues(envPath, LEGACY_COMPOSE_SECRET_ENV_KEYS);
}

async function syncSelfHostEnvFromCurrent(
  options: InitOptions = {},
  mode: 'self-host' | 'production' = 'self-host'
): Promise<{ apiUrl: string; webUrl: string }> {
  const envPath = getDockerEnvPath();
  const hadExistingEnv = fs.existsSync(envPath);
  ensureFileFromExample(getDockerEnvExamplePath(), envPath);

  const current = readEnvFile(envPath);
  const hostBind = await resolveComposeHostBind(current, options, mode);
  const defaults = hostPortDefaults();
  const ports = {
    postgres: parseEnvPort(current.POSTGRES_HOST_PORT, defaults.postgres),
    redis: parseEnvPort(current.REDIS_HOST_PORT, defaults.redis),
    htmlToMarkdown: parseEnvPort(current.HTML_TO_MARKDOWN_HOST_PORT, defaults.htmlToMarkdown),
    ytEngine: parseEnvPort(current.YT_ENGINE_HOST_PORT, defaults.ytEngine),
    web: parseEnvPort(current.WEB_HOST_PORT, defaults.web),
    api: parseEnvPort(current.API_HOST_PORT, defaults.api),
  };

  const clientHost = clientHostForBind(hostBind);
  const resetClientUrls =
    mode === 'production' || Boolean(options.hostBind?.trim()) || !isLoopbackHostBind(hostBind);
  const apiUrl =
    !resetClientUrls && current.NEXT_PUBLIC_API_URL?.trim()
      ? current.NEXT_PUBLIC_API_URL.trim()
      : `http://${clientHost}:${ports.api}`;
  const webUrl =
    !resetClientUrls && current.FRONTEND_URL?.trim()
      ? current.FRONTEND_URL.trim()
      : `http://${clientHost}:${ports.web}`;
  reconcileComposeCredentials(envPath, current, hadExistingEnv);

  upsertEnvValues(envPath, {
    HEADLESSX_HOST_BIND: hostBind,
    POSTGRES_HOST_PORT: String(ports.postgres),
    REDIS_HOST_PORT: String(ports.redis),
    HTML_TO_MARKDOWN_HOST_PORT: String(ports.htmlToMarkdown),
    YT_ENGINE_HOST_PORT: String(ports.ytEngine),
    WEB_HOST_PORT: String(ports.web),
    API_HOST_PORT: String(ports.api),
    NEXT_PUBLIC_API_URL: apiUrl,
    INTERNAL_API_URL: current.INTERNAL_API_URL?.trim() || 'http://api:8000',
    FRONTEND_URL: webUrl,
  });

  return { apiUrl, webUrl };
}

async function configureSelfHost(
  options: InitOptions,
  mode: 'self-host' | 'production' = 'self-host'
): Promise<{ apiUrl: string; webUrl: string }> {
  const envPath = getDockerEnvPath();
  const hadExistingEnv = fs.existsSync(envPath);
  ensureFileFromExample(getDockerEnvExamplePath(), envPath);

  const ports = await resolveHostPorts(hostPortDefaults(), { yes: options.yes });
  const current = readEnvFile(envPath);
  const hostBind = await resolveComposeHostBind(current, options, mode);
  const clientHost = clientHostForBind(hostBind);
  reconcileComposeCredentials(envPath, current, hadExistingEnv);

  upsertEnvValues(envPath, {
    HEADLESSX_HOST_BIND: hostBind,
    POSTGRES_HOST_PORT: String(ports.postgres),
    REDIS_HOST_PORT: String(ports.redis),
    HTML_TO_MARKDOWN_HOST_PORT: String(ports.htmlToMarkdown),
    YT_ENGINE_HOST_PORT: String(ports.ytEngine),
    WEB_HOST_PORT: String(ports.web),
    API_HOST_PORT: String(ports.api),
    NEXT_PUBLIC_API_URL: `http://${clientHost}:${ports.api}`,
    FRONTEND_URL: `http://${clientHost}:${ports.web}`,
  });

  return {
    apiUrl: `http://${clientHost}:${ports.api}`,
    webUrl: `http://${clientHost}:${ports.web}`,
  };
}

function syncDeveloperEnvFromCurrent(): { apiUrl: string; webUrl: string } {
  const envPath = getRootEnvPath();
  ensureFileFromExample(getRootEnvExamplePath(), envPath);

  const current = readEnvFile(envPath);
  const defaults = developerPortDefaults();
  const ports = {
    api: parseEnvPort(current.PORT, defaults.api),
    web: parseEnvPort(current.WEB_PORT, defaults.web),
    htmlToMarkdown: parseEnvPort(current.HTML_TO_MARKDOWN_PORT, defaults.htmlToMarkdown),
    ytEngine: parseEnvPort(current.YT_ENGINE_PORT, defaults.ytEngine),
  };

  upsertEnvValues(envPath, {
    PORT: String(ports.api),
    WEB_PORT: String(ports.web),
    HTML_TO_MARKDOWN_PORT: String(ports.htmlToMarkdown),
    YT_ENGINE_PORT: String(ports.ytEngine),
    YT_ENGINE_URL: current.YT_ENGINE_URL?.trim() || `http://localhost:${ports.ytEngine}`,
    HTML_TO_MARKDOWN_SERVICE_URL:
      current.HTML_TO_MARKDOWN_SERVICE_URL?.trim() || `http://localhost:${ports.htmlToMarkdown}`,
    NEXT_PUBLIC_API_URL: current.NEXT_PUBLIC_API_URL?.trim() || `http://localhost:${ports.api}`,
    INTERNAL_API_URL: current.INTERNAL_API_URL?.trim() || `http://localhost:${ports.api}`,
    DASHBOARD_INTERNAL_API_KEY: resolveSecret(current.DASHBOARD_INTERNAL_API_KEY),
    CREDENTIAL_ENCRYPTION_KEY: resolveSecret(current.CREDENTIAL_ENCRYPTION_KEY),
  });

  return {
    apiUrl: `http://localhost:${ports.api}`,
    webUrl: `http://localhost:${ports.web}`,
  };
}

async function configureDeveloper(options: InitOptions): Promise<{ apiUrl: string; webUrl: string }> {
  const envPath = getRootEnvPath();
  ensureFileFromExample(getRootEnvExamplePath(), envPath);

  const ports = await resolveDeveloperPorts(developerPortDefaults(), { yes: options.yes });
  const current = readEnvFile(envPath);

  upsertEnvValues(envPath, {
    PORT: String(ports.api),
    WEB_PORT: String(ports.web),
    HTML_TO_MARKDOWN_PORT: String(ports.htmlToMarkdown),
    YT_ENGINE_PORT: String(ports.ytEngine),
    YT_ENGINE_URL: `http://localhost:${ports.ytEngine}`,
    HTML_TO_MARKDOWN_SERVICE_URL: `http://localhost:${ports.htmlToMarkdown}`,
    NEXT_PUBLIC_API_URL: `http://localhost:${ports.api}`,
    DASHBOARD_INTERNAL_API_KEY: resolveSecret(current.DASHBOARD_INTERNAL_API_KEY),
    CREDENTIAL_ENCRYPTION_KEY: resolveSecret(current.CREDENTIAL_ENCRYPTION_KEY),
  });

  return {
    apiUrl: `http://localhost:${ports.api}`,
    webUrl: `http://localhost:${ports.web}`,
  };
}

function protectDomainEnv(envPath: string): void {
  const stat = fs.lstatSync(envPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('The production domain environment file metadata is invalid.');
  }
  if (process.platform !== 'win32') {
    const expectedUid = process.getuid?.();
    if (expectedUid === undefined || stat.uid !== expectedUid) {
      throw new Error('The production domain environment file ownership is invalid.');
    }
    fs.chmodSync(envPath, 0o600);
  }
}

function refreshProductionCaddyfile(): void {
  syncProductionCaddyfile(getDomainCaddyTemplatePath(), getDomainCaddyfilePath());
}

async function resolveProductionDashboardAccess(
  current: Record<string, string>,
  options: InitOptions
): Promise<{ username: string; passwordHash: string }> {
  const username =
    options.dashboardUser?.trim() ||
    current.HEADLESSX_DASHBOARD_USER?.trim() ||
    DEFAULT_DASHBOARD_USER;
  const suppliedHash = options.dashboardPasswordHash?.trim();
  const existingHash = current.HEADLESSX_DASHBOARD_PASSWORD_HASH?.trim();
  let passwordHash =
    suppliedHash || (existingHash && !existingHash.startsWith('replace-with-') ? existingHash : '');

  if (!passwordHash) {
    if (!canUseModernPrompts()) {
      return assertProductionDashboardAccess({ username, passwordHash });
    }

    const password = await promptPassword({
      message: 'Production dashboard password',
      validate: validateDashboardPassword,
      cancelMessage: 'Production setup cancelled.',
    });
    await promptPassword({
      message: 'Confirm the production dashboard password',
      validate(value) {
        const validationError = validateDashboardPassword(value);
        if (validationError) {
          return validationError;
        }
        if (value !== password) {
          return 'Dashboard passwords do not match.';
        }
        return undefined;
      },
      cancelMessage: 'Production setup cancelled.',
    });

    passwordHash = await withSpinner(
      'Hashing the dashboard password with Caddy...',
      () => hashDashboardPassword(password),
      {
        successMessage: 'Dashboard access verifier created.',
        errorMessage: 'Dashboard password hashing failed.',
      }
    );
  }

  return assertProductionDashboardAccess({ username, passwordHash });
}

async function syncProductionEnvFromCurrent(
  options: InitOptions
): Promise<{ apiUrl: string; webUrl: string }> {
  await syncSelfHostEnvFromCurrent(options, 'production');

  const envPath = getDomainEnvPath();
  ensureFileFromExample(getDomainEnvExamplePath(), envPath);
  protectDomainEnv(envPath);

  const current = readEnvFile(envPath);
  const webDomain = current.HEADLESSX_WEB_DOMAIN?.trim() || options.webDomain?.trim();
  const apiDomain = current.HEADLESSX_API_DOMAIN?.trim() || options.apiDomain?.trim();
  const caddyEmail = current.CADDY_EMAIL?.trim() || options.caddyEmail?.trim();
  const dashboardAccess = await resolveProductionDashboardAccess(current, options);

  upsertEnvValues(envPath, {
    HEADLESSX_WEB_DOMAIN: webDomain || 'dashboard.example.com',
    HEADLESSX_API_DOMAIN: apiDomain || 'api.example.com',
    CADDY_EMAIL: caddyEmail || 'ops@example.com',
    HEADLESSX_DASHBOARD_USER: dashboardAccess.username,
    HEADLESSX_DASHBOARD_PASSWORD_HASH: dashboardAccess.passwordHash,
    HEADLESSX_WEB_UPSTREAM: current.HEADLESSX_WEB_UPSTREAM?.trim() || 'web:3000',
    HEADLESSX_API_UPSTREAM: current.HEADLESSX_API_UPSTREAM?.trim() || 'api:8000',
    HEADLESSX_DOCKER_NETWORK: current.HEADLESSX_DOCKER_NETWORK?.trim() || 'docker_headlessx-network',
  });
  protectDomainEnv(envPath);
  refreshProductionCaddyfile();

  return {
    apiUrl: apiDomain ? `https://${apiDomain}` : '',
    webUrl: webDomain ? `https://${webDomain}` : '',
  };
}

async function configureProduction(options: InitOptions): Promise<{ apiUrl: string; webUrl: string }> {
  await configureSelfHost(options, 'production');

  const envPath = getDomainEnvPath();
  ensureFileFromExample(getDomainEnvExamplePath(), envPath);
  protectDomainEnv(envPath);

  const current = readEnvFile(envPath);
  const webDomain = await promptRequired('What is the dashboard domain?', options.webDomain);
  const apiDomain = await promptRequired('What is the API domain?', options.apiDomain);
  const caddyEmail = await promptRequired(
    'What email should Caddy use for certificate management?',
    options.caddyEmail
  );
  const dashboardAccess = await resolveProductionDashboardAccess(current, options);

  upsertEnvValues(envPath, {
    HEADLESSX_WEB_DOMAIN: webDomain,
    HEADLESSX_API_DOMAIN: apiDomain,
    CADDY_EMAIL: caddyEmail,
    HEADLESSX_DASHBOARD_USER: dashboardAccess.username,
    HEADLESSX_DASHBOARD_PASSWORD_HASH: dashboardAccess.passwordHash,
  });
  protectDomainEnv(envPath);
  refreshProductionCaddyfile();

  return {
    apiUrl: `https://${apiDomain}`,
    webUrl: `https://${webDomain}`,
  };
}

async function maybeRunDeveloperSetup(options: InitOptions): Promise<void> {
  await showInfo('Installing HeadlessX workspace dependencies with pnpm...');
  runInteractiveCommand('pnpm', ['install'], getWorkspacePaths().repo);

  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  // Prompts are intentionally one at a time.
}

async function maybeRunDeveloperOptionalTasks(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  if (await confirm('Download CAPTCHA models now?', false)) {
    runInteractiveCommand('pnpm', ['run', 'models:download'], getWorkspacePaths().repo);
  }

  if (await confirm('Run database setup now?', false)) {
    runInteractiveCommand('pnpm', ['db:push'], getWorkspacePaths().repo);
  }
}

function startDeveloper(branch: string): { pid: number; logPath: string; apiUrl: string; webUrl: string } {
  const paths = getWorkspacePaths();
  const { apiUrl, webUrl } = getRuntimeUrls('developer');
  const logPath = path.join(paths.logs, 'developer.log');
  const pid = spawnDetachedProcess('pnpm', ['dev'], {
    cwd: paths.repo,
    logPath,
  });

  writeRuntimeMetadata('developer', branch, {
    apiUrl,
    webUrl,
    pid,
    logPath,
  });

  return {
    pid,
    logPath,
    apiUrl: apiUrl || 'http://localhost:38473',
    webUrl: webUrl || 'http://localhost:34872',
  };
}

function assertProductionAccessBoundary(): void {
  assertRuntimeHostBind('production');
  const envPath = getDomainEnvPath();
  const current = readEnvFile(envPath);
  const dashboardAccess = assertProductionDashboardAccess({
    username: current.HEADLESSX_DASHBOARD_USER,
    passwordHash: current.HEADLESSX_DASHBOARD_PASSWORD_HASH,
  });
  if (
    (process.env.HEADLESSX_DASHBOARD_USER !== undefined &&
      process.env.HEADLESSX_DASHBOARD_USER.trim() !== dashboardAccess.username) ||
    (process.env.HEADLESSX_DASHBOARD_PASSWORD_HASH !== undefined &&
      process.env.HEADLESSX_DASHBOARD_PASSWORD_HASH.trim() !== dashboardAccess.passwordHash)
  ) {
    throw new Error(
      'Production dashboard access must come from infra/domain-setup/.env. Remove the shell environment override before starting.'
    );
  }
  upsertEnvValues(envPath, {
    HEADLESSX_DASHBOARD_USER: dashboardAccess.username,
    HEADLESSX_DASHBOARD_PASSWORD_HASH: dashboardAccess.passwordHash,
  });
  protectDomainEnv(envPath);
  refreshProductionCaddyfile();
}

function startSelfHost(branch: string, options: { build?: boolean } = {}): { apiUrl: string; webUrl: string } {
  assertRuntimeHostBind('self-host');
  assertComposeSecretFiles(getWorkspacePaths().secrets);
  const args = ['compose', '--profile', 'all', 'up'];
  if (options.build) {
    args.push('--build');
  }
  args.push('-d');
  runInteractiveCommand('docker', args, getDockerComposeDir());
  const { apiUrl, webUrl } = getRuntimeUrls('self-host');
  writeRuntimeMetadata('self-host', branch, { apiUrl, webUrl });
  return {
    apiUrl: apiUrl || 'http://localhost:38473',
    webUrl: webUrl || 'http://localhost:34872',
  };
}

function startProduction(branch: string, options: { build?: boolean } = {}): { apiUrl: string; webUrl: string } {
  assertProductionAccessBoundary();
  assertComposeSecretFiles(getWorkspacePaths().secrets);
  const coreArgs = ['compose', '--profile', 'all', 'up'];
  if (options.build) {
    coreArgs.push('--build');
  }
  coreArgs.push('-d');
  runInteractiveCommand('docker', coreArgs, getDockerComposeDir());
  runInteractiveCommand('docker', ['compose', 'up', '-d'], getDomainComposeDir());
  const { apiUrl, webUrl } = getRuntimeUrls('production');
  writeRuntimeMetadata('production', branch, { apiUrl, webUrl });
  return {
    apiUrl: apiUrl || '',
    webUrl: webUrl || '',
  };
}

function stopDockerStack(mode: SetupMode): void {
  if (mode === 'production') {
    runInteractiveCommand('docker', ['compose', 'stop'], getDomainComposeDir());
  }
  runInteractiveCommand('docker', ['compose', '--profile', 'all', 'stop'], getDockerComposeDir());
}

function readDockerServices(cwd: string, args: string[]): string[] {
  const result = runCommand('docker', ['compose', ...args], { cwd });
  if (!result.success) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildRuntimeSummary(): Promise<RuntimeSummary> {
  const paths = getWorkspacePaths();
  const mode = readMode();
  const branch = readBranch() ?? undefined;
  const lastStart = readLastStart();
  const rootEnvPath = getRootEnvPath();
  const dockerEnvPath = getDockerEnvPath();
  const domainEnvPath = getDomainEnvPath();

  const summary: RuntimeSummary = {
    configured: Boolean(mode && repoExists()),
    workspaceRoot: paths.root,
    repoPath: paths.repo,
    mode: mode ?? undefined,
    branch,
    envFiles: {
      root: fs.existsSync(rootEnvPath),
      docker: fs.existsSync(dockerEnvPath),
      domain: fs.existsSync(domainEnvPath),
    },
    local: {},
  };

  if (!mode) {
    return summary;
  }

  if (mode === 'developer') {
    const urls = getRuntimeUrls(mode);
    let processRunning = false;
    if (lastStart?.pid) {
      try {
        process.kill(lastStart.pid, 0);
        processRunning = true;
      } catch {
        processRunning = false;
      }
    }

    summary.local = {
      apiUrl: urls.apiUrl,
      webUrl: urls.webUrl,
      pid: lastStart?.pid ?? null,
      processRunning,
      logPath: lastStart?.logPath ?? null,
    };
    return summary;
  }

  const running = readDockerServices(getDockerComposeDir(), [
    '--profile',
    'all',
    'ps',
    '--services',
    '--status',
    'running',
  ]);

  if (mode === 'production') {
    const domains = readEnvFile(getDomainEnvPath());
    const urls = getRuntimeUrls(mode);
    const proxy = readDockerServices(getDomainComposeDir(), ['ps', '--services', '--status', 'running']);
    summary.local = {
      apiUrl: urls.apiUrl ?? null,
      webUrl: urls.webUrl ?? null,
      apiDomain: domains.HEADLESSX_API_DOMAIN || null,
      webDomain: domains.HEADLESSX_WEB_DOMAIN || null,
      coreServices: running,
      domainServices: proxy,
    };
    return summary;
  }

  const urls = getRuntimeUrls('self-host');
  summary.local = {
    apiUrl: urls.apiUrl ?? null,
    webUrl: urls.webUrl ?? null,
    services: running,
  };

  return summary;
}

export async function handleInitCommand(options: InitOptions): Promise<void> {
  const action = parseInitAction(options.action);
  await showIntro(
    action === 'update' ? 'Update' : 'Setup',
    action === 'update'
      ? 'Update the existing HeadlessX workspace under ~/.headlessx and keep the saved setup mode.'
      : 'Bootstrap HeadlessX into ~/.headlessx with a guided install flow.'
  );

  const savedMode = readMode();
  const mode =
    action === 'update'
      ? options.mode ?? savedMode ?? null
      : options.mode ?? (await promptMode());
  const branch = options.branch?.trim() || DEFAULT_BRANCH;

  if (!mode) {
    throw new Error('HeadlessX is not initialized yet. Run "headlessx init" first.');
  }

  if (action === 'update' && !repoExists()) {
    throw new Error('HeadlessX is not initialized yet. Run "headlessx init" first.');
  }

  await showNote('Setup Plan', [
    `Workspace: ${getWorkspacePaths().root}`,
    `Mode: ${mode}`,
    `Branch: ${branch}`,
    `Action: ${action}`,
  ]);

  const checks = await withSpinner(
    'Checking required runtime tools...',
    () => {
      const detected = detectPrerequisites(mode);
      requireChecks(detected);
      return detected;
    },
    {
      successMessage: 'Runtime prerequisites look good.',
      errorMessage: 'Runtime prerequisites check failed.',
    }
  );
  await reportChecks('Runtime Checks', checks);

  await showInfo('Preparing ~/.headlessx workspace and syncing the repository...');
  ensureWorkspaceLayout();
  ensureRepo(branch);

  if (action === 'update') {
    let urls: { apiUrl: string; webUrl: string };
    if (mode === 'developer') {
      urls = syncDeveloperEnvFromCurrent();
      await maybeRunDeveloperSetup(options);
    } else if (mode === 'production') {
      urls = await syncProductionEnvFromCurrent(options);
    } else {
      urls = await syncSelfHostEnvFromCurrent(options);
    }

    writeMode(mode);
    writeBranch(branch);

    const dashboardUser =
      mode === 'production'
        ? readEnvFile(getDomainEnvPath()).HEADLESSX_DASHBOARD_USER
        : undefined;

    const nextSteps = ['headlessx restart', 'headlessx status', 'headlessx doctor'];
    const summary = {
      workspaceRoot: getWorkspacePaths().root,
      repoPath: getWorkspacePaths().repo,
      mode,
      branch,
      updated: true,
      apiUrl: urls.apiUrl,
      webUrl: urls.webUrl,
      ...(dashboardUser ? { dashboardUser } : {}),
      nextSteps,
    };

    if (canUseModernPrompts()) {
      await showNote('Update Ready', [
        `Mode: ${mode}`,
        `API: ${urls.apiUrl || 'configured in domain setup'}`,
        `Dashboard: ${urls.webUrl || 'configured in domain setup'}`,
        ...(dashboardUser ? [`Dashboard user: ${dashboardUser}`] : []),
        `Next steps: ${nextSteps.join('  |  ')}`,
      ]);
      await showOutro('HeadlessX is updated. Run headlessx restart to rebuild and load the latest version.');
      return;
    }

    writeStructured(summary, {
      title: 'headlessx update complete',
    });
    return;
  }

  let urls: { apiUrl: string; webUrl: string };
  if (mode === 'developer') {
    urls = await configureDeveloper(options);
    await maybeRunDeveloperSetup(options);
    if (!options.yes) {
      await maybeRunDeveloperOptionalTasks();
    }
  } else if (mode === 'production') {
    urls = await configureProduction(options);
  } else {
    urls = await configureSelfHost(options);
  }

  writeMode(mode);
  writeBranch(branch);
  clearLastStart();

  const skipStart = options.start === false;
  let started = false;
  if (!skipStart) {
    const shouldStart = options.yes
      ? true
      : await confirm(
          mode === 'developer'
            ? 'Start HeadlessX in developer mode now?'
            : mode === 'production'
              ? 'Start the production Docker stack now?'
              : 'Start HeadlessX with Docker now?',
          true
        );

    if (shouldStart) {
      if (mode === 'developer') {
        startDeveloper(branch);
      } else if (mode === 'production') {
        startProduction(branch);
      } else {
        startSelfHost(branch);
      }
      started = true;
    }
  }

  const dashboardUser =
    mode === 'production'
      ? readEnvFile(getDomainEnvPath()).HEADLESSX_DASHBOARD_USER
      : undefined;

  const nextSteps = started
    ? ['headlessx status', 'headlessx doctor']
    : ['headlessx start', 'headlessx status', 'headlessx doctor'];
  const summary = {
    workspaceRoot: getWorkspacePaths().root,
    repoPath: getWorkspacePaths().repo,
    mode,
    branch,
    started,
    apiUrl: urls.apiUrl,
    webUrl: urls.webUrl,
    ...(dashboardUser ? { dashboardUser } : {}),
    nextSteps,
  };

  if (canUseModernPrompts()) {
    await showNote('Ready', [
      `Mode: ${mode}`,
      `API: ${urls.apiUrl}`,
      `Dashboard: ${urls.webUrl}`,
      ...(dashboardUser ? [`Dashboard user: ${dashboardUser}`] : []),
      `Started: ${started ? 'yes' : 'no'}`,
      `Next steps: ${nextSteps.join('  |  ')}`,
    ]);
    await showOutro(
      started
        ? 'HeadlessX is running. Use headlessx status to confirm services.'
        : 'HeadlessX is configured. Use headlessx start when you are ready.'
    );
    return;
  }

  writeStructured(summary, {
    title: `headlessx init complete`,
  });
}

export async function handleStartCommand(options: StartOptions = {}): Promise<void> {
  const mode = readMode();
  const branch = readBranch() ?? DEFAULT_BRANCH;
  if (!mode) {
    throw new Error('HeadlessX is not initialized yet. Run "headlessx init" first.');
  }

  const result =
    mode === 'developer'
      ? startDeveloper(branch)
      : mode === 'production'
        ? startProduction(branch, { build: options.build })
        : startSelfHost(branch, { build: options.build });

  writeStructured(
    {
      mode,
      branch,
      rebuilt: Boolean(options.build && mode !== 'developer'),
      ...result,
    },
    { title: 'headlessx start' }
  );
}

export async function handleStopCommand(): Promise<void> {
  const mode = readMode();
  if (!mode) {
    throw new Error('HeadlessX is not initialized yet. Run "headlessx init" first.');
  }

  if (mode === 'developer') {
    const lastStart = readLastStart();
    if (!lastStart?.pid) {
      clearLastStart();
      writeText('No running developer process was recorded.');
      return;
    }
    killDetachedProcess(lastStart.pid);
    clearLastStart();
    writeText('Stopped HeadlessX developer mode.');
    return;
  }

  stopDockerStack(mode);
  clearLastStart();
  writeText(mode === 'production' ? 'Stopped HeadlessX production stack.' : 'Stopped HeadlessX self-host stack.');
}

export async function handleRestartCommand(): Promise<void> {
  await handleStopCommand();
  await handleStartCommand({ build: true });
}

export async function handleBootstrapStatusCommand(options: StatusOptions): Promise<RuntimeSummary> {
  const runtime = await buildRuntimeSummary();
  writeStructured(runtime, {
    json: options.json,
    outputPath: options.output,
    pretty: options.pretty,
    title: `headlessx runtime`,
  });
  return runtime;
}

export async function collectBootstrapStatus(): Promise<RuntimeSummary> {
  return buildRuntimeSummary();
}

export async function handleLogsCommand(options: LogsOptions): Promise<void> {
  const mode = readMode();
  if (!mode) {
    throw new Error('HeadlessX is not initialized yet. Run "headlessx init" first.');
  }

  const tail = parseTailValue(options.tail);
  const follow = options.follow ?? true;
  const service = options.service?.trim();

  if (mode === 'developer') {
    const lastStart = readLastStart();
    const logPath = lastStart?.logPath ?? path.join(getWorkspacePaths().logs, 'developer.log');
    if (!fs.existsSync(logPath)) {
      throw new Error(`Developer log file not found at ${logPath}.`);
    }

    if (follow && process.platform !== 'win32') {
      runInteractiveCommand('tail', ['-n', String(tail), '-f', logPath]);
      return;
    }

    writeText(readTailLines(logPath, tail));
    return;
  }

  if (mode === 'production' && service === 'caddy') {
    const caddyArgs = ['compose', 'logs', '--tail', String(tail)];
    if (follow) {
      caddyArgs.push('--follow');
    }
    caddyArgs.push('caddy');
    runInteractiveCommand('docker', caddyArgs, getDomainComposeDir());
    return;
  }

  const args = ['compose', '--profile', 'all', 'logs', '--tail', String(tail)];
  if (follow) {
    args.push('--follow');
  }
  if (service) {
    args.push(service);
  }

  runInteractiveCommand('docker', args, getDockerComposeDir());
}

export async function handleDoctorCommand(options: DoctorOptions): Promise<void> {
  const mode = readMode();
  const repoPath = getWorkspacePaths().repo;
  const runtime = await buildRuntimeSummary();
  const checks = buildCommandChecks(mode ?? undefined);
  const runtimeTargets = resolveRuntimeTargets(runtime);
  const apiKey = getApiKey();

  const modelsDir = path.join(repoPath, 'apps/api/models');
  const modelChecks = {
    classificationModel: fs.existsSync(path.join(modelsDir, 'recaptcha_classification_57k.onnx')),
    detectionModel:
      fs.existsSync(path.join(modelsDir, 'yolo26x.onnx')) ||
      fs.existsSync(path.join(modelsDir, 'yolo26x.pt')),
  };

  const apiHealth = runtimeTargets.apiUrl
    ? await checkHttpHealth(`${runtimeTargets.apiUrl.replace(/\/$/, '')}/api/health`)
    : { ok: false, detail: 'not configured', url: '', tried: [] };
  const webHealth = runtimeTargets.webUrl
    ? await checkHttpHealth(runtimeTargets.webUrl, {
        acceptBasicAuthChallenge: mode === 'production',
      })
    : { ok: false, detail: 'not configured', url: '', tried: [] };

  const payload = {
    name: 'headlessx',
    version: packageJson.version,
    auth: {
      configured: Boolean(apiKey),
      detail:
        mode === 'developer'
          ? 'Authentication is optional for local lifecycle management.'
          : apiKey
            ? 'API key available for authenticated operator routes.'
            : 'Not logged in. Operator-specific checks will be limited until you run `headlessx login`.',
    },
    targets: runtimeTargets,
    runtime,
    commands: checks,
    envFiles: runtime.envFiles,
    models: modelChecks,
    reachability: {
      api: apiHealth,
      web: webHealth,
    },
  };

  writeStructured(payload, {
    json: options.json,
    outputPath: options.output,
    pretty: options.pretty,
    title: 'headlessx doctor',
  });
}
