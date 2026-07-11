#!/usr/bin/env node
/**
 * headfox-server — persistent Camoufox (anti-detection Firefox) Playwright server.
 *
 * Exposes a wsEndpoint (ws://host:port/<ws_path>) that `browser remote` (the
 * pi-config browser skill) attaches to via `playwright-cli attach`, so pi drives
 * the remote Camoufox for interactive flows that local playwright can't survive
 * (the headlessx SCRAPE api stays the tool for one-shot bulk scraping).
 *
 * Reuses headfox-js's launchServer (firefox.launchServer + Camoufox anti-detection
 * options). Options are env-driven. The ws_path is the secret token; the auth
 * boundary is Tailscale (the port is only reachable on the tailnet) — value-blind:
 * the path is never logged.
 *
 * Run:  node /app/infra/docker/headfox-server.mjs   (working_dir: /app/apps/api)
 * Env:  HEADFOX_PORT (def 9334), HEADFOX_WS_PATH (required, secret token),
 *       HEADFOX_HEADLESS (def true), HEADFOX_HUMANIZE (def 0),
 *       HEADFOX_GEOIP (def false), HEADFOX_BLOCK_WEBRTC (def true),
 *       HEADFOX_BLOCK_IMAGES (def false), HEADFOX_ENABLE_CACHE (def true)
 */
// Dynamic import + full try/catch so ANY failure (incl. module resolution) is
// caught and the container stays alive for log capture (debug; remove keep-alive
// once stable).
try {
	const { firefox } = await import('playwright-core')
	const { launchOptions } = await import('headfox-js')
	const port = Number(process.env.HEADFOX_PORT ?? 9334)
	const wsToken = process.env.HEADFOX_WS_PATH
	if (!wsToken) throw new Error('HEADFOX_WS_PATH must be set (the secret ws_path token).')
	// Playwright launchServer requires ws_path start with '/'. The token is minted
	// without one (secret-bootstrap), so prepend it here.
	const wsPath = '/' + wsToken
	const bool = (v, d) => (v === undefined ? d : v === 'true')
	const num = (v, d) => (v === undefined ? d : Number(v))

	// headfox-js's launchHeadfoxServer wrapper doesn't pass `host`; playwright's
	// launchServer defaults to 127.0.0.1 (not reachable over Tailscale). Call
	// firefox.launchServer directly with host: '0.0.0.0' + the Camoufox options.
	const opts = await launchOptions({
		headless: process.env.HEADFOX_HEADLESS !== 'false', // default true
		humanize: num(process.env.HEADFOX_HUMANIZE, 0),
		geoip: bool(process.env.HEADFOX_GEOIP, false),
		block_webrtc: bool(process.env.HEADFOX_BLOCK_WEBRTC, true),
		block_images: bool(process.env.HEADFOX_BLOCK_IMAGES, false),
		enable_cache: bool(process.env.HEADFOX_ENABLE_CACHE, true),
	})
	const server = await firefox.launchServer({ ...opts, port, wsPath, host: '0.0.0.0' })

	// Do NOT log the wsEndpoint (it carries the secret ws_path token). The browser
	// skill constructs ws://${HEADFOX_HOST}/${token} and resolves the token via opd.
	console.log(`headfox server listening on port ${port} (ws_path configured).`)
	console.log('Connect via: `browser remote` (pi-config browser skill).')

	const shutdown = async (sig) => {
		console.log(`headfox-server: ${sig} received, closing.`)
		try { await server.close() } catch { /* best-effort */ }
		process.exit(0)
	}
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('SIGTERM', () => shutdown('SIGTERM'))
	await new Promise(() => {}) // keep alive
} catch (err) {
	console.error('headfox-server FATAL:', err?.stack || err?.message || String(err))
	await new Promise(() => {}) // keep alive so logs are retrievable for diagnosis
}
