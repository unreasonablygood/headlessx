import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchWithHeadfox } from "../src/sync_api";

test("persistent contexts disable Playwright's incompatible default viewport", async () => {
	let receivedOptions: Record<string, unknown> | undefined;
	const context = { close: async () => undefined };
	const browserType = {
		launchPersistentContext: async (
			_userDataDir: string,
			options: Record<string, unknown>,
		) => {
			receivedOptions = options;
			return context;
		},
	};

	const result = await launchWithHeadfox(
		browserType as never,
		true,
		{ headless: true, viewport: { width: 1280, height: 720 } },
		"/private/tmp/headfox-persistent-test",
	);

	expect(result).toBe(context);
	expect(receivedOptions?.viewport).toBeNull();
});

test("local capture and remote browser use separate Playwright protocol pins", () => {
	const repositoryRoot = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../..",
	);
	const apiPackage = JSON.parse(
		readFileSync(resolve(repositoryRoot, "apps/api/package.json"), "utf8"),
	) as { dependencies: Record<string, string> };
	const remoteServer = readFileSync(
		resolve(repositoryRoot, "infra/docker/headfox-server.mjs"),
		"utf8",
	);

	expect(apiPackage.dependencies["playwright-core"]).toBe("1.58.2");
	expect(apiPackage.dependencies["playwright-core-remote"]).toBe(
		"npm:playwright-core@1.61.0-alpha-1781023400000",
	);
	expect(remoteServer).toContain("import('playwright-core-remote')");
});
