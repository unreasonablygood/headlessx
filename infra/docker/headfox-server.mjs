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
 * options: canvas/WebGL/audio spoofing, humanize, geoip, webrtc blocking).
 * Options are env-driven. The ws_path is the secret token; the auth boundary is
 * Tailscale (the port is only reachable on the tailnet) — value-blind: the path
 * is never logged.
 *
 * Run:  node /app/infra/docker/headfox-server.mjs
 * Env:  HEADFOX_PORT (def 9334), HEADFOX_WS_PATH (required, secret token, starts /),
 *       HEADFOX_HEADLESS (def true), HEADFOX_HUMANIZE (def 0),
 *       HEADFOX_GEOIP (def false), HEADFOX_BLOCK_WEBRTC (def true),
 *       HEADFOX_BLOCK_IMAGES (def false), HEADFOX_ENABLE_CACHE (def true)
 */
import { launchServer } from 'headfox-js'

const port = Number(process.env.HEADFOX_PORT ?? 9334)
const wsToken = process.env.HEADFOX_WS_PATH
if (!wsToken) {
	console.error(
		'headfox-server: HEADFOX_WS_PATH must be set (the secret ws_path token).',
	)
	process.exit(2)
}
// Playwright launchServer requires ws_path start with "/". The token is minted
// without one (secret-bootstrap), so prepend it here.
const wsPath = '/' + wsToken

const bool = (v, d) => (v === undefined ? d : v === 'true')
const num = (v, d) => (v === undefined ? d : Number(v))

let server
try {
	server = await launchServer({
		port,
		ws_path: wsPath,
		headless: process.env.HEADFOX_HEADLESS !== 'false', // default true
		humanize: num(process.env.HEADFOX_HUMANIZE, 0),
		geoip: bool(process.env.HEADFOX_GEOIP, false),
		block_webrtc: bool(process.env.HEADFOX_BLOCK_WEBRTC, true),
		block_images: bool(process.env.HEADFOX_BLOCK_IMAGES, false),
		enable_cache: bool(process.env.HEADFOX_ENABLE_CACHE, true),
	})
} catch (err) {
	console.error(
		'headfox-server: launchServer FAILED:',
		err?.stack || err?.message || String(err),
	)
	// keep the container alive so logs are retrievable for diagnosis
	await new Promise(() => {})
}

// Do NOT log the wsEndpoint (it carries the secret ws_path token). The browser
// skill resolves the full wsEndpoint via opd (op://m3_local/HEADFOX_ENDPOINT).
console.log(`headfox server listening on port ${port} (ws_path configured).`)
console.log('Connect via: `browser remote` (pi-config browser skill).')

const shutdown = async (sig) => {
	console.log(`headfox-server: ${sig} received, closing.`)
	try {
		await server.close()
	} catch {
		/* best-effort */
	}
	process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// keep alive
await new Promise(() => {})
