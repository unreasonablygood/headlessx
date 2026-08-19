import { expect, test } from "bun:test";

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
