import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { promptConfirm, promptSelect, promptText } from './ui';
import type { SetupMode } from './workspace';

export type EnvMap = Record<string, string>;
export const COMPOSE_SECRET_NAMES = [
  'postgres-password',
  'dashboard-internal-api-key',
  'credential-encryption-key',
  'evidence-api-key',
] as const;

export type ComposeSecretName = (typeof COMPOSE_SECRET_NAMES)[number];
export type ComposeSecretValues = Partial<Record<ComposeSecretName, string | undefined>>;

export interface CommandCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthCheckResult {
  ok: boolean;
  detail: string;
  url: string;
  tried: string[];
}

export interface ProductionDashboardAccessInput {
  username?: string;
  passwordHash?: string;
}

export interface ProductionDashboardAccess {
  username: string;
  passwordHash: string;
}

export interface LifecycleCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export type LifecycleCommandRunner = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions
) => LifecycleCommandResult;

export interface HostPortConfig {
  api: number;
  web: number;
  postgres: number;
  redis: number;
  htmlToMarkdown: number;
  ytEngine: number;
}

export interface DeveloperPortConfig {
  api: number;
  web: number;
  htmlToMarkdown: number;
  ytEngine: number;
}

const HOST_PORT_DEFAULTS: HostPortConfig = {
  api: 38473,
  web: 34872,
  postgres: 35432,
  redis: 36379,
  htmlToMarkdown: 38081,
  ytEngine: 38090,
};

const DEVELOPER_PORT_DEFAULTS: DeveloperPortConfig = {
  api: 38473,
  web: 34872,
  htmlToMarkdown: 38081,
  ytEngine: 38090,
};

export const DEFAULT_HOST_BIND = '127.0.0.1';
export const DEFAULT_DASHBOARD_USER = 'headlessx';
export const PRODUCTION_CADDY_AUTH_MARKER = '# headlessx-dashboard-auth-v1';

const CADDY_PASSWORD_IMAGE = 'caddy:2.10-alpine';
const DASHBOARD_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const BCRYPT_VERIFIER_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export function normalizeHostBindAddress(value?: string): string {
  const normalized = value?.trim() || DEFAULT_HOST_BIND;
  if (net.isIP(normalized) !== 4) {
    throw new Error('HEADLESSX_HOST_BIND must be an IPv4 address.');
  }
  return normalized;
}

export function isLoopbackHostBind(value?: string): boolean {
  return normalizeHostBindAddress(value).startsWith('127.');
}

export function assertProductionHostBind(value?: string): string {
  const normalized = normalizeHostBindAddress(value);
  if (normalized !== DEFAULT_HOST_BIND) {
    throw new Error(
      'Production core host ports must remain bound to 127.0.0.1 so dashboard access cannot bypass Caddy.'
    );
  }
  return normalized;
}

function quoteIfNeeded(value: string): string {
  if (value.includes('$')) {
    return `'${value.replace(/'/g, "\\'")}'`;
  }
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function decodeEnvValue(rawValue: string): string {
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1).replace(/\\'/g, "'");
  }
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    try {
      return JSON.parse(rawValue) as string;
    } catch {
      return rawValue.slice(1, -1);
    }
  }
  return rawValue;
}

export function readEnvFile(filePath: string): EnvMap {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    env[key] = decodeEnvValue(rawValue);
  }

  return env;
}

export function ensureFileFromExample(examplePath: string, targetPath: string): void {
  if (!fs.existsSync(examplePath)) {
    throw new Error(`Missing bootstrap template: ${examplePath}`);
  }

  if (fs.existsSync(targetPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(examplePath, targetPath);
}

export function syncProductionCaddyfile(templatePath: string, targetPath: string): void {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing bootstrap template: ${templatePath}`);
  }

  const content = fs.readFileSync(templatePath, 'utf-8');
  if (!content.split(/\r?\n/).includes(PRODUCTION_CADDY_AUTH_MARKER)) {
    throw new Error(
      'The production Caddy access boundary is outdated. Run "headlessx init update" before starting.'
    );
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('The generated production Caddyfile metadata is invalid.');
    }
    // Preserve the inode so a stopped Compose container's bind mount sees the
    // refreshed policy when it starts again.
    fs.writeFileSync(targetPath, content, 'utf-8');
    return;
  }
  fs.writeFileSync(targetPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o644 });
}

export function upsertEnvValues(filePath: string, values: EnvMap): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!(key in values)) {
      return line;
    }

    seen.add(key);
    return `${key}=${quoteIfNeeded(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (seen.has(key)) {
      continue;
    }
    nextLines.push(`${key}=${quoteIfNeeded(value)}`);
  }

  const normalized = nextLines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(filePath, normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf-8');
}

export function removeEnvValues(filePath: string, keys: readonly string[]): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const removed = new Set(keys);
  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      return !match || !removed.has(match[1]);
    });
  const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.writeFileSync(filePath, normalized, 'utf-8');
}

export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}

export function resolveSecret(currentValue?: string): string {
  const normalized = currentValue?.trim();
  if (!normalized || normalized.startsWith('replace-with-')) {
    return generateSecret();
  }
  return normalized;
}

export function validateDashboardPassword(value: string | undefined): string | undefined {
  if (!value || !value.trim()) {
    return 'A dashboard password is required.';
  }

  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length < 16) {
    return 'Use at least 16 bytes for the dashboard password.';
  }
  if (bytes.length > 72) {
    return 'The dashboard password cannot exceed 72 bytes with bcrypt.';
  }
  if (bytes.some((byte) => byte < 0x20 || byte === 0x7f)) {
    return 'The dashboard password cannot contain control bytes.';
  }
  return undefined;
}

export function assertProductionDashboardAccess(
  input: ProductionDashboardAccessInput
): ProductionDashboardAccess {
  const username = input.username?.trim();
  if (!username) {
    throw new Error(
      'Production dashboard Basic Auth username is missing. Run "headlessx init update" before starting.'
    );
  }
  if (!DASHBOARD_USER_PATTERN.test(username)) {
    throw new Error(
      'Production dashboard Basic Auth username must use 1-64 letters, numbers, dots, underscores, @, or hyphens.'
    );
  }

  const passwordHash = input.passwordHash?.trim();
  if (!passwordHash) {
    throw new Error(
      'Production dashboard bcrypt verifier is missing. Run "headlessx init update" interactively or provide "--dashboard-password-hash".'
    );
  }

  const match = passwordHash.match(BCRYPT_VERIFIER_PATTERN);
  const cost = match ? Number(match[1]) : Number.NaN;
  if (!match || cost < 10 || cost > 16) {
    throw new Error(
      'Production dashboard password verifier must be a bcrypt hash with cost 10 through 16.'
    );
  }

  return { username, passwordHash };
}

export function hashDashboardPassword(
  password: string,
  execute: LifecycleCommandRunner = runCommand
): string {
  const validationError = validateDashboardPassword(password);
  if (validationError) {
    throw new Error(validationError);
  }

  const result = execute(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      CADDY_PASSWORD_IMAGE,
      'caddy',
      'hash-password',
      '--algorithm',
      'bcrypt',
    ],
    {
      input: password,
    }
  );
  if (!result.success) {
    throw new Error('Caddy could not hash the dashboard password.');
  }

  return assertProductionDashboardAccess({
    username: DEFAULT_DASHBOARD_USER,
    passwordHash: result.stdout.trim(),
  }).passwordHash;
}

function assertSecretValue(name: ComposeSecretName, value: string): void {
  const bytes = Buffer.from(value, 'utf-8');
  const minimumBytes = name === 'postgres-password' ? 1 : 32;
  if (bytes.length < minimumBytes || bytes.length > 16 * 1024) {
    throw new Error(`HeadlessX ${name} credential length is invalid.`);
  }
  if (bytes.some((byte) => byte <= 0x20 || byte === 0x7f)) {
    throw new Error(`HeadlessX ${name} credential contains whitespace or control bytes.`);
  }
}

function assertPrivatePath(filePath: string, kind: 'directory' | 'file'): void {
  const stat = fs.lstatSync(filePath);
  const matchesKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!matchesKind || stat.isSymbolicLink()) {
    throw new Error(`HeadlessX credential ${path.basename(filePath)} metadata is invalid.`);
  }

  if (process.platform !== 'win32') {
    const expectedUid = process.getuid?.();
    if (
      expectedUid === undefined ||
      stat.uid !== expectedUid ||
      (kind === 'file' && (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o400)) ||
      (kind === 'directory' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error(`HeadlessX credential ${path.basename(filePath)} metadata is invalid.`);
    }
  }
}

export function assertComposeSecretFiles(secretDirectory: string): void {
  if (!fs.existsSync(secretDirectory)) {
    throw new Error(
      'HeadlessX Compose credentials are missing. Run "headlessx init update" before starting.'
    );
  }

  assertPrivatePath(secretDirectory, 'directory');
  for (const name of COMPOSE_SECRET_NAMES) {
    const filePath = path.join(secretDirectory, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `HeadlessX Compose credential ${name} is missing. Run "headlessx init update" before starting.`
      );
    }
    assertPrivatePath(filePath, 'file');
    assertSecretValue(name, fs.readFileSync(filePath, 'utf-8'));
  }
}

export function ensureComposeSecretFiles(
  secretDirectory: string,
  legacyValues: ComposeSecretValues = {}
): void {
  if (fs.existsSync(secretDirectory)) {
    assertComposeSecretFiles(secretDirectory);
    return;
  }

  const values = Object.fromEntries(
    COMPOSE_SECRET_NAMES.map((name) => {
      const legacyValue = legacyValues[name];
      const value =
        legacyValue && !legacyValue.startsWith('replace-with-') ? legacyValue : generateSecret(32);
      assertSecretValue(name, value);
      return [name, value];
    })
  ) as Record<ComposeSecretName, string>;

  const parentDirectory = path.dirname(secretDirectory);
  fs.mkdirSync(parentDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(parentDirectory, '.headlessx-secrets-'));

  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(stagingDirectory, 0o700);
    }
    for (const name of COMPOSE_SECRET_NAMES) {
      const filePath = path.join(stagingDirectory, name);
      fs.writeFileSync(filePath, values[name], {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o400,
      });
      if (process.platform !== 'win32') {
        fs.chmodSync(filePath, 0o400);
      }
    }
    fs.renameSync(stagingDirectory, secretDirectory);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  assertComposeSecretFiles(secretDirectory);
}

export function requiredCommandsForMode(mode: SetupMode): string[] {
  return mode === 'developer' ? ['git', 'node', 'pnpm'] : ['git', 'docker'];
}

export function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {}
): LifecycleCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    ...options,
  }) as SpawnSyncReturns<string>;

  return {
    success: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

export function runInteractiveCommand(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

export function spawnDetachedProcess(
  command: string,
  args: string[],
  options: { cwd: string; logPath: string }
): number {
  fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const out = fs.openSync(options.logPath, 'a');
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', out, out],
  });

  child.unref();

  if (!child.pid) {
    throw new Error(`Failed to start ${command}.`);
  }

  return child.pid;
}

export function killDetachedProcess(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `Failed to stop process ${pid}.`);
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
}

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      port,
      host: '127.0.0.1',
    });

    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (
        err.code === 'ECONNREFUSED' ||
        err.code === 'EHOSTUNREACH' ||
        err.code === 'EPERM'
      ) {
        resolve(true);
        return;
      }
      resolve(false);
    });
  });
}

export async function nextFreePort(startingPort: number): Promise<number> {
  let port = startingPort;
  while (!(await isPortFree(port))) {
    port += 1;
  }
  return port;
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  return promptConfirm({
    message: question,
    defaultValue,
  });
}

export async function promptMode(): Promise<SetupMode> {
  return promptSelect<SetupMode>({
    message: 'Which mode do you want to set up?',
    initialValue: 'self-host',
    values: [
      {
        value: 'self-host',
        label: 'Self-Host',
        hint: 'Docker stack on local rare ports',
      },
      {
        value: 'developer',
        label: 'Developer',
        hint: 'Clone main and run the local workspace',
      },
      {
        value: 'production',
        label: 'Production',
        hint: 'Docker plus Caddy with API and dashboard domains',
      },
    ],
  });
}

export async function promptRequired(question: string, value?: string): Promise<string> {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  return promptText({
    message: question,
    validate(inputValue) {
      if (!inputValue?.trim()) {
        return 'A value is required.';
      }
      return undefined;
    },
  });
}

export async function resolveHostPorts(
  preferred: HostPortConfig,
  options: { yes?: boolean }
): Promise<HostPortConfig> {
  const resolved = { ...preferred };
  const labels: Record<keyof HostPortConfig, string> = {
    api: 'API',
    web: 'Web',
    postgres: 'PostgreSQL',
    redis: 'Redis',
    htmlToMarkdown: 'HTML-to-Markdown',
    ytEngine: 'yt-engine',
  };

  for (const key of Object.keys(resolved) as Array<keyof HostPortConfig>) {
    const preferredPort = resolved[key];
    if (await isPortFree(preferredPort)) {
      continue;
    }

    const suggested = await nextFreePort(preferredPort + 1);
    if (!options.yes) {
      const accepted = await confirm(
        `Port ${preferredPort} is already in use for ${labels[key]}. Use ${suggested} instead?`,
        true
      );
      if (!accepted) {
        throw new Error(`Port ${preferredPort} is already in use. Resolve the conflict and run init again.`);
      }
    }

    resolved[key] = suggested;
  }

  return resolved;
}

export async function resolveDeveloperPorts(
  preferred: DeveloperPortConfig,
  options: { yes?: boolean }
): Promise<DeveloperPortConfig> {
  const resolved = { ...preferred };
  const labels: Record<keyof DeveloperPortConfig, string> = {
    api: 'API',
    web: 'Web',
    htmlToMarkdown: 'HTML-to-Markdown',
    ytEngine: 'yt-engine',
  };

  for (const key of Object.keys(resolved) as Array<keyof DeveloperPortConfig>) {
    const preferredPort = resolved[key];
    if (await isPortFree(preferredPort)) {
      continue;
    }

    const suggested = await nextFreePort(preferredPort + 1);
    if (!options.yes) {
      const accepted = await confirm(
        `Port ${preferredPort} is already in use for ${labels[key]}. Use ${suggested} instead?`,
        true
      );
      if (!accepted) {
        throw new Error(`Port ${preferredPort} is already in use. Resolve the conflict and run init again.`);
      }
    }

    resolved[key] = suggested;
  }

  return resolved;
}

export function hostPortDefaults(): HostPortConfig {
  return { ...HOST_PORT_DEFAULTS };
}

export function developerPortDefaults(): DeveloperPortConfig {
  return { ...DEVELOPER_PORT_DEFAULTS };
}

export function checkCommand(name: string, args = ['--version']): CommandCheck {
  const result = runCommand(name, args);
  return {
    name,
    ok: result.success,
    detail: result.success
      ? (result.stdout.trim().split('\n')[0] || 'available')
      : (result.stderr.trim().split('\n')[0] || 'not available'),
  };
}

export function buildHealthProbeCandidates(url: string): string[] {
  const parsed = new URL(url);
  const candidates = [parsed.toString()];

  if (parsed.hostname === 'localhost') {
    parsed.hostname = '127.0.0.1';
    candidates.push(parsed.toString());
  } else if (parsed.hostname === '0.0.0.0') {
    parsed.hostname = '127.0.0.1';
    candidates.push(parsed.toString());
  }

  return Array.from(new Set(candidates));
}

export async function checkHttpHealth(
  url: string,
  options: { acceptBasicAuthChallenge?: boolean } = {}
): Promise<HealthCheckResult> {
  const candidates = buildHealthProbeCandidates(url);
  let lastFailure = 'request failed';

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        signal: AbortSignal.timeout(5000),
      });
      const basicAuthChallenge =
        options.acceptBasicAuthChallenge === true &&
        response.status === 401 &&
        /^Basic(?:\s|$)/i.test(response.headers.get('www-authenticate') ?? '');
      if (response.ok || basicAuthChallenge) {
        return {
          ok: true,
          detail: `${response.status} ${response.statusText}`,
          url: candidate,
          tried: candidates,
        };
      }

      lastFailure = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'request failed';
    }
  }

  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const candidate of candidates) {
    const curlResult = runCommand('curl', [
      '--silent',
      '--show-error',
      '--location',
      '--max-time',
      '5',
      '--output',
      nullDevice,
      '--write-out',
      '%{http_code}',
      candidate,
    ]);

    const curlCode = Number(curlResult.stdout.trim());
    if (Number.isFinite(curlCode) && curlCode >= 200 && curlCode < 400) {
      return {
        ok: true,
        detail: `${curlCode} via curl`,
        url: candidate,
        tried: candidates,
      };
    }

    if (curlResult.stderr.trim()) {
      lastFailure = curlResult.stderr.trim().split('\n')[0] || lastFailure;
    } else if (Number.isFinite(curlCode) && curlCode > 0) {
      lastFailure = `${curlCode} via curl`;
    }
  }

  return {
    ok: false,
    detail: lastFailure,
    url: candidates[0] ?? url,
    tried: candidates,
  };
}
