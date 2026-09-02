#!/usr/bin/env tsx
/**
 * HeadlessX load test — trusted-seat throughput probe for the production host.
 *
 * Sends no credential. The fixed scrape routes admit the m3 and ml-infra-02
 * Tailscale source identities. This script cannot read or mutate service
 * configuration.
 *
 * Usage:
 *   loadtest.ts load --url U [--concurrency N] [--total N]
 *     [--endpoint html|html-js|content] [--stealth]
 *     [--timeout-ms N] [--wait-for-selector S]
 *
 * Defaults: concurrency 5, total 20, endpoint html-js, stealth (html-js default).
 * Reports: req/min, p50/p95 latency, error rate, and HTTP status histogram.
 */
const BASE = 'http://100.83.166.127:38473';
const SCRAPE_BASE = '/api/operators/website/scrape';

// ----------------------------- minimal redactor -----------------------------

/** Scrub credential-shaped material from any upstream error body. */
function redact(text: string): string {
  if (!text) return text;
  return text
    .replace(/[A-Za-z0-9._:-]{40,}/g, '<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>');
}

// ----------------------------- arg parsing -----------------------------

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
function flagStr(f: Record<string, string | true>, k: string): string | undefined {
  const v = f[k];
  if (v === true) {
    console.error(`Error: --${k} requires a value.`);
    process.exit(2);
  }
  return v;
}
function flagInt(f: Record<string, string | true>, k: string, def: number): number {
  const v = f[k];
  if (v === undefined) return def;
  if (v === true) {
    console.error(`Error: --${k} requires a number.`);
    process.exit(2);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`Error: --${k} must be a number, got "${v}".`);
    process.exit(2);
  }
  return n;
}

async function fetchJson(
  path: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ----------------------------- load test -----------------------------

interface Sample {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
}

async function oneRequest(
  url: string,
  endpoint: string,
  opts: { stealth?: boolean; timeoutMs: number; waitForSelector?: string },
): Promise<Sample> {
  const start = Date.now();
  const reqBody: Record<string, unknown> = { url };
  if (opts.waitForSelector) reqBody.waitForSelector = opts.waitForSelector;
  if (opts.timeoutMs) reqBody.timeout = opts.timeoutMs;
  if (opts.stealth !== undefined) reqBody.stealth = opts.stealth;
  try {
    const { status, body } = await fetchJson(
      `${SCRAPE_BASE}/${endpoint}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      },
      opts.timeoutMs + 30000,
    );
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      latencyMs: Date.now() - start,
      error: ok ? undefined : redact(body.slice(0, 120)),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function cmdLoad(flags: Record<string, string | true>): Promise<void> {
  const url = flagStr(flags, 'url');
  if (!url) {
    console.error('Error: --url is required');
    process.exit(2);
  }
  const concurrency = flagInt(flags, 'concurrency', 5);
  const total = flagInt(flags, 'total', 20);
  const endpoint = flagStr(flags, 'endpoint') ?? 'html-js';
  const stealthFlag = flags.stealth;
  const stealth = stealthFlag === undefined ? undefined : stealthFlag === true;
  const timeoutMs = flagInt(flags, 'timeout-ms', 60000);
  const waitForSelector = flagStr(flags, 'wait-for-selector');

  console.log(
    `load: url=${url} endpoint=${endpoint} concurrency=${concurrency} total=${total} stealth=${stealth} timeout=${timeoutMs}ms`,
  );
  const samples: Sample[] = [];
  let issued = 0;
  const tStart = Date.now();
  // Simple concurrency pool: keep `concurrency` in flight until `total` issued.
  async function worker() {
    while (issued < total) {
      issued++;
      const s = await oneRequest(url, endpoint, { stealth, timeoutMs, waitForSelector });
      samples.push(s);
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const elapsedSec = (Date.now() - tStart) / 1000;
  const ok = samples.filter((s) => s.ok);
  const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const hist: Record<string, number> = {};
  for (const s of samples) hist[String(s.status)] = (hist[String(s.status)] || 0) + 1;
  const out = {
    requested: total,
    completed: samples.length,
    ok: ok.length,
    errors: samples.length - ok.length,
    errorRate: `${(((samples.length - ok.length) / samples.length) * 100).toFixed(1)}%`,
    elapsedSec: +elapsedSec.toFixed(1),
    reqPerMin: +((samples.length / elapsedSec) * 60).toFixed(1),
    latencyMs: {
      p50: percentile(lat, 50),
      p90: percentile(lat, 90),
      p95: percentile(lat, 95),
      max: lat[lat.length - 1] ?? 0,
    },
    statusHistogram: hist,
    firstErrors: samples
      .filter((s) => !s.ok)
      .slice(0, 3)
      .map((s) => `${s.status}: ${s.error}`),
  };
  console.log(JSON.stringify(out, null, 2));
}

// ----------------------------- main -----------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  switch (cmd) {
    case 'load':
      return cmdLoad(flags);
    default:
      console.error(
        'Usage: loadtest.ts load --url U [--concurrency N --total N --endpoint html|html-js|content --stealth --timeout-ms N]',
      );
      process.exit(2);
  }
}
main().catch((e) => {
  console.error('Fatal:', redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
