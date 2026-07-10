#!/usr/bin/env tsx
/**
 * headlessx load-test — value-blind throughput + knob probe for the v2 host.
 *
 * Resolves HEADLESSX_API_KEY ONCE via the opd daemon (value-blind; never printed,
 * never in argv), then drives /api/config (GET/PATCH) and concurrent scrape load
 * against /api/operators/website/scrape/*. All output is scrubbed (the key is a
 * 46-char token; redact() strips it from any error body that might reflect it).
 *
 * Usage:
 *   loadtest.ts config                                   GET /api/config (current knobs)
 *   loadtest.ts set --max-concurrency N [--browser-timeout-ms N]   PATCH /api/config (runtime, no redeploy)
 *   loadtest.ts load --url U [--concurrency N] [--total N] [--endpoint html|html-js|content]
 *                  [--stealth] [--timeout-ms N] [--wait-for-selector S]
 *
 * Defaults: concurrency 5, total 20, endpoint html-js, stealth (html-js default).
 * Reports: req/min, p50/p95 latency (ms), error rate, http status histogram.
 */
import { spawnSync } from 'node:child_process'

const DEFAULT_TOKEN_REF = 'op://m3_local/DASHBOARD_INTERNAL_API_KEY/credential'
const DEFAULT_BASE_URL = 'http://100.83.166.127:38473'
const SCRAPE_BASE = '/api/operators/website/scrape'

// ----------------------------- value-blind key -----------------------------

function resolveKey(): string {
	const ref = process.env.HEADLESSX_API_KEY || DEFAULT_TOKEN_REF
	if (!ref.startsWith('op://')) return ref // plaintext override (not recommended)
	const r = spawnSync('opd', ['__resolve', ref, 'headlessx-loadtest'], {
		encoding: 'utf8',
		timeout: 15000,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const v = (r.stdout ?? '').replace(/\n+$/, '')
	if (!v) {
		console.error('Error: API key did not resolve via opd. Run `opd warm`.')
		process.exit(2)
	}
	return v
}

const KEY = resolveKey()
const BASE = process.env.HEADLESSX_URL || DEFAULT_BASE_URL

// ----------------------------- minimal redactor -----------------------------

/** Scrub the key (46-char base64) + bearer/apikey/JWT/40+ runs from any output. */
function redact(text: string): string {
	if (!text) return text
	return text
		.replace(/[A-Za-z0-9._:\-]{40,}/g, '<redacted>')
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=\-]+/gi, '$1<redacted>')
		.replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=\-]+/gi, '$1<redacted>')
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>')
}

// ----------------------------- arg parsing -----------------------------

interface Args {
	positional: string[]
	flags: Record<string, string | true>
}
function parseArgs(argv: string[]): Args {
	const positional: string[] = []
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a.startsWith('--')) {
			const k = a.slice(2)
			const next = argv[i + 1]
			if (next !== undefined && !next.startsWith('--')) {
				flags[k] = next
				i++
			} else flags[k] = true
		} else positional.push(a)
	}
	return { positional, flags }
}
function flagStr(f: Record<string, string | true>, k: string): string | undefined {
	const v = f[k]
	if (v === true) {
		console.error(`Error: --${k} requires a value.`)
		process.exit(2)
	}
	return v
}
function flagInt(f: Record<string, string | true>, k: string, def: number): number {
	const v = f[k]
	if (v === undefined) return def
	if (v === true) {
		console.error(`Error: --${k} requires a number.`)
		process.exit(2)
	}
	const n = Number(v)
	if (!Number.isFinite(n)) {
		console.error(`Error: --${k} must be a number, got "${v}".`)
		process.exit(2)
	}
	return n
}

async function fetchJson(path: string, init: RequestInit, timeoutMs = 15000): Promise<{ status: number; body: string }> {
	const ctrl = new AbortController()
	const t = setTimeout(() => ctrl.abort(), timeoutMs)
	try {
		const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
		const body = await res.text()
		return { status: res.status, body }
	} finally {
		clearTimeout(t)
	}
}

function authHeaders(): Record<string, string> {
	return { 'x-api-key': KEY, 'content-type': 'application/json' }
}

// ----------------------------- config GET/PATCH -----------------------------

async function cmdConfig(): Promise<void> {
	const { status, body } = await fetchJson('/api/config', { method: 'GET', headers: { 'x-api-key': KEY } })
	if (status !== 200) {
		console.error(`GET /api/config -> HTTP ${status}`)
		console.error(redact(body.slice(0, 400)))
		process.exit(1)
	}
	console.log(redact(body))
}

async function cmdSet(flags: Record<string, string | true>): Promise<void> {
	// Generic pass-through: any --<flag> <value> becomes a PATCH field.
	// Booleans: --block-images true|false. Numbers: --humanize 0 --max-concurrency 10.
	const boolKeys = new Set(['proxyEnabled', 'camoufoxBblockWebrtc', 'camoufoxBlockImages', 'camoufoxEnableCache', 'camoufoxGeoip', 'profileRotation'])
	const numKeys = new Set(['maxConcurrency', 'browserTimeout', 'profileRotationInterval', 'camoufoxHumanize'])
	const body: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(flags)) {
		if (v === true) continue // flag without value
		if (boolKeys.has(k)) body[k] = v === 'true'
		else if (numKeys.has(k)) body[k] = Number(v)
		else body[k] = v
	}
	if (Object.keys(body).length === 0) {
		console.error('Error: provide one or more --<flag> <value> (e.g. --max-concurrency 10 --camoufoxBlockImages true --camoufoxHumanize 0)')
		process.exit(2)
	}
	const { status, body: resp } = await fetchJson('/api/config', {
		method: 'PATCH',
		headers: authHeaders(),
		body: JSON.stringify(body),
	})
	console.log(`PATCH /api/config -> HTTP ${status}`)
	console.log(redact(resp.slice(0, 600)))
}

// ----------------------------- load test -----------------------------

interface Sample {
	ok: boolean
	status: number
	latencyMs: number
	error?: string
}

async function oneRequest(
	url: string,
	endpoint: string,
	opts: { stealth?: boolean; timeoutMs: number; waitForSelector?: string },
): Promise<Sample> {
	const start = Date.now()
	const reqBody: Record<string, unknown> = { url }
	if (opts.waitForSelector) reqBody.waitForSelector = opts.waitForSelector
	if (opts.timeoutMs) reqBody.timeout = opts.timeoutMs
	if (opts.stealth !== undefined) reqBody.stealth = opts.stealth
	try {
		const { status, body } = await fetchJson(
			`${SCRAPE_BASE}/${endpoint}`,
			{ method: 'POST', headers: authHeaders(), body: JSON.stringify(reqBody) },
			opts.timeoutMs + 30000,
		)
		const ok = status >= 200 && status < 300
		return { ok, status, latencyMs: Date.now() - start, error: ok ? undefined : redact(body.slice(0, 120)) }
	} catch (e) {
		return { ok: false, status: 0, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) }
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
	return sorted[Math.max(0, idx)]
}

async function cmdLoad(flags: Record<string, string | true>): Promise<void> {
	const url = flagStr(flags, 'url')
	if (!url) {
		console.error('Error: --url is required')
		process.exit(2)
	}
	const concurrency = flagInt(flags, 'concurrency', 5)
	const total = flagInt(flags, 'total', 20)
	const endpoint = flagStr(flags, 'endpoint') ?? 'html-js'
	const stealthFlag = flags['stealth']
	const stealth = stealthFlag === undefined ? undefined : stealthFlag === true
	const timeoutMs = flagInt(flags, 'timeout-ms', 60000)
	const waitForSelector = flagStr(flags, 'wait-for-selector')

	console.log(`load: url=${url} endpoint=${endpoint} concurrency=${concurrency} total=${total} stealth=${stealth} timeout=${timeoutMs}ms`)
	const samples: Sample[] = []
	let issued = 0
	const tStart = Date.now()
	// Simple concurrency pool: keep `concurrency` in flight until `total` issued.
	async function worker() {
		while (issued < total) {
			issued++
			const s = await oneRequest(url, endpoint, { stealth, timeoutMs, waitForSelector })
			samples.push(s)
		}
	}
	const workers = Array.from({ length: concurrency }, () => worker())
	await Promise.all(workers)
	const elapsedSec = (Date.now() - tStart) / 1000
	const ok = samples.filter((s) => s.ok)
	const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b)
	const hist: Record<string, number> = {}
	for (const s of samples) hist[String(s.status)] = (hist[String(s.status)] || 0) + 1
	const out = {
		requested: total,
		completed: samples.length,
		ok: ok.length,
		errors: samples.length - ok.length,
		errorRate: `${(((samples.length - ok.length) / samples.length) * 100).toFixed(1)}%`,
		elapsedSec: +elapsedSec.toFixed(1),
		reqPerMin: +(samples.length / elapsedSec * 60).toFixed(1),
		latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90), p95: percentile(lat, 95), max: lat[lat.length - 1] ?? 0 },
		statusHistogram: hist,
		firstErrors: samples.filter((s) => !s.ok).slice(0, 3).map((s) => `${s.status}: ${s.error}`),
	}
	console.log(JSON.stringify(out, null, 2))
}

// ----------------------------- main -----------------------------

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2))
	const cmd = positional[0]
	switch (cmd) {
		case 'config': return cmdConfig()
		case 'set': return cmdSet(flags)
		case 'load': return cmdLoad(flags)
		default:
			console.error('Usage: loadtest.ts config | set --max-concurrency N | load --url U [--concurrency N --total N --endpoint html|html-js --stealth --timeout-ms N]')
			process.exit(2)
	}
}
main().catch((e) => {
	console.error('Fatal:', redact(e instanceof Error ? e.message : String(e)))
	process.exit(1)
})
