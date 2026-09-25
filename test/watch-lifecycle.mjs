// Watch page lifecycle: jump shortcuts, stopped/disconnected status, and
// reconnection after a server restarts on the same port and token.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ts from "typescript";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const eventsPath = "/__pi_markdown_preview_state__";
const conflictStatus = "Disconnected · different preview";
const traceStatus = page => page.evaluate(() => {
	const status = document.querySelector('[data-watch-control="status"]');
	window.__watchStatusChanges = [];
	new MutationObserver(() => window.__watchStatusChanges.push(status.hidden ? null : status.textContent))
		.observe(status, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
});
const waitForClientCount = async (server, count) => {
	const deadline = Date.now() + 5000;
	while (server.clientCount !== count && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
	assert.equal(server.clientCount, count, "Expected recent polling viewer count.");
};
const doc = text => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main id="preview-root"><p id="body">${text}</p></main></body></html>`;
const freePort = () => new Promise((resolvePort, reject) => {
	const probe = createServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});

const scratch = await mkdtemp(join(tmpdir(), "pi-markdown-preview-watch-lifecycle-"));
const modulePath = resolve(`.pi-markdown-preview-watch-lifecycle-${process.pid}.mjs`);
const servers = [];
let browser;
let preview;
const serve = async (html, options) => {
	const server = await createBrowserWatchServer(html, scratch, options);
	servers.push(server);
	return server;
};
try {
	await writeFile(modulePath, ts.transpileModule(readFileSync(resolve("index.ts"), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
	}).outputText);
	try { preview = await import(pathToFileURL(modulePath).href); }
	finally { await rm(modulePath, { force: true }); }

	// Options are validated; a taken port rejects so callers can fall back.
	await assert.rejects(createBrowserWatchServer(doc("x"), scratch, { port: -1 }), /port/);
	await assert.rejects(createBrowserWatchServer(doc("x"), scratch, { token: "short" }), /token/);
	const taken = await serve(doc("x"));
	await assert.rejects(createBrowserWatchServer(doc("x"), scratch, { port: Number(new URL(taken.url).port) }), { code: "EADDRINUSE" });

	// Expired-link hint and title suffix are caller-configurable; defaults unchanged.
	const base = new URL(taken.url);
	const expiredText = async server => (await fetch(new URL("/?token=wrong", server.url))).text();
	assert.match(await expiredText(taken), /Re-run \/preview-browser --watch\./);
	const neutral = await serve(doc("x"), { expiredHint: "Run agent-markdown-preview again.", titleSuffix: "Agent Preview", sourceLabel: "notes.md" });
	assert.equal(await expiredText(neutral), "Invalid or expired preview watch token. Run agent-markdown-preview again.");
	assert.match(await (await fetch(neutral.url)).text(), /<title>notes\.md — Agent Preview<\/title>/);
	assert.match(await (await fetch(base)).text(), /aria-keyshortcuts="Alt\+Shift\+ArrowRight"/);

	const { executablePath, args } = preview.getPreviewBrowserLaunchOptions();
	browser = await puppeteer.launch({ headless: true, executablePath, args });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	const bodyText = () => page.$eval("#body", element => element.textContent);
	const status = () => page.$eval('[data-watch-control="status"]', element => element.hidden ? null : element.textContent);
	const revisionInUrl = () => new URL(page.url()).searchParams.get("revision");
	const shortcut = async (shift, key) => {
		const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
		await page.keyboard.down("Alt");
		if (shift) await page.keyboard.down("Shift");
		await page.keyboard.press(key);
		if (shift) await page.keyboard.up("Shift");
		await page.keyboard.up("Alt");
		await navigation;
	};

	// Option/Alt+Shift+Left/Right jump to the oldest and latest revisions.
	const history = await serve(doc("one"));
	history.updateDocument(doc("two"));
	history.updateDocument(doc("three"));
	await page.goto(history.url, { waitUntil: "domcontentloaded" });
	assert.equal(await bodyText(), "three");
	await waitForClientCount(history, 1);
	const oldestRequest = page.waitForRequest(request => request.isNavigationRequest() && request.frame() === page.mainFrame());
	await shortcut(true, "ArrowLeft");
	assert.match(new URL((await oldestRequest).url()).searchParams.get("identity"), /^[a-f\d]{64}$/,
		"History navigation must carry the same public watcher identity.");
	assert.equal(await bodyText(), "one");
	assert.equal(revisionInUrl(), "1");
	await shortcut(false, "ArrowRight");
	assert.equal(await bodyText(), "two");
	await shortcut(true, "ArrowRight");
	assert.equal(await bodyText(), "three");
	assert.equal(await status(), null, "No status while connected.");

	// Polling detects unavailable servers without holding a permanent connection.
	await waitForClientCount(history, 1);
	await history.close();
	assert.equal(history.clientCount, 0);
	await page.waitForFunction(() => !document.querySelector('[data-watch-control="status"]').hidden);
	assert.equal(await status(), "Disconnected · preview unavailable");

	// Fixed port and token: the page reconnects to the restarted server and
	// follows its (renumbered) latest revision.
	const port = await freePort();
	const token = "t".repeat(40);
	const first = await serve(doc("before restart"), { port, token });
	const firstEvents = page.waitForRequest(request => new URL(request.url()).pathname === eventsPath);
	await page.goto(first.url, { waitUntil: "domcontentloaded" });
	const firstEventsUrl = new URL((await firstEvents).url());
	assert.match(firstEventsUrl.searchParams.get("identity"), /^[a-f\d]{64}$/);
	assert.ok(!firstEventsUrl.href.includes(token), "The polling URL must not expose the authentication token.");
	assert.ok(!(await (await fetch(first.url)).text()).includes(token), "The page must not embed the authentication token.");
	assert.equal((await fetch(firstEventsUrl)).status, 403, "Public identity alone must not authorize a state request.");
	assert.equal(await bodyText(), "before restart");
	await waitForClientCount(first, 1);
	await first.close();
	await page.waitForFunction(() => /Disconnected.*retrying/.test(document.querySelector('[data-watch-control="status"]').textContent));
	const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 });
	const second = await serve(doc("after restart"), { port, token });
	const restartedResponse = await navigation;
	assert.equal(new URL(restartedResponse.url()).searchParams.get("identity"), firstEventsUrl.searchParams.get("identity"),
		"Automatic restart navigation remains bound to the original watcher.");
	assert.equal(await bodyText(), "after restart");
	assert.equal(await status(), null);
	// And it keeps following updates from the new run.
	const updated = page.waitForNavigation({ waitUntil: "domcontentloaded" });
	second.updateDocument(doc("after restart, updated"));
	await updated;
	assert.equal(await bodyText(), "after restart, updated");

	// Something else now owns the port (a different token): the page's live
	// connection is refused, so it reports the disconnection instead of freezing.
	const reused = await freePort();
	const original = await serve(doc("original"), { port: reused, token });
	await page.goto(original.url, { waitUntil: "domcontentloaded" });
	await waitForClientCount(original, 1);
	await original.close();
	const replacement = await serve(doc("someone else"), { port: reused, token: "u".repeat(40) });
	await page.waitForFunction(() => /Disconnected/.test(document.querySelector('[data-watch-control="status"]').textContent), { timeout: 20_000 });
	assert.equal(await bodyText(), "original", "Never shows another server's content.");

	// Bootstrapping B in another tab replaces the port-scoped cookie. The old
	// tab must still identify itself as A rather than silently following B.
	const otherPage = await browser.newPage();
	otherPage.on("pageerror", error => errors.push(String(error)));
	const oldTabReconnect = page.waitForResponse(response =>
		new URL(response.url()).pathname === eventsPath && response.status() !== 403, { timeout: 20_000 });
	await otherPage.goto(replacement.url, { waitUntil: "domcontentloaded" });
	const refused = await oldTabReconnect;
	assert.equal(refused.status(), 409, "Polling can report an identity conflict directly in HTTP.");
	assert.match(refused.headers()["content-type"], /text\/plain/);
	const rejection = await page.evaluate(async url => {
		const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
		return { status: response.status, body: await response.text() };
	}, refused.url());
	assert.deepEqual(rejection, { status: 409, body: "A different preview watcher owns this address." },
		"Rejection must terminate without exposing document state or registering a viewer.");
	assert.equal((await fetch(refused.url())).status, 403, "Even a rejection still requires cookie authentication.");
	await page.waitForFunction(text => document.querySelector('[data-watch-control="status"]').textContent === text, {}, conflictStatus);
	await traceStatus(page);
	for (let retry = 0; retry < 2; retry++) {
		await page.waitForResponse(response => new URL(response.url()).pathname === eventsPath, { timeout: 15_000 });
		await page.waitForFunction(text => document.querySelector('[data-watch-control="status"]').textContent === text, {}, conflictStatus);
		assert.equal(await status(), conflictStatus, "Repeated identity rejections must retain the specific reason.");
	}
	assert.ok((await page.evaluate(() => window.__watchStatusChanges)).every(text => text === conflictStatus),
		"Starting another poll must not briefly clear the conflict message.");
	const oldIdentity = new URL(refused.url()).searchParams.get("identity");
	assert.match(oldIdentity, /^[a-f\d]{64}$/, "Pages send a non-secret, token-derived identity, not the token.");
	assert.notEqual(oldIdentity, token);
	assert.equal(await bodyText(), "original", "Cookie replacement must not retarget an existing tab.");
	assert.equal(await page.evaluate(async identity => (await fetch('/?identity=' + identity)).status, oldIdentity), 409,
		"Bound HTTP navigations must reject a cookie/port switch after state validation too.");
	// Stub both clipboard paths: a failed assertion must never write to the
	// user's clipboard, even if the sharing request regresses to the wrong watch.
	await page.evaluate(() => {
		window.__copyCalls = 0;
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { window.__copyCalls += 1; } } });
		document.execCommand = () => { window.__copyCalls += 1; return true; };
	});
	const copyResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/__pi_markdown_preview_share__");
	await page.click('[data-watch-control="copy-link"]');
	const refusedCopy = await copyResponse;
	assert.equal(refusedCopy.status(), 409, "An old page must not copy a different watcher's link.");
	assert.equal(new URL(refusedCopy.url()).searchParams.get("identity"), oldIdentity);
	assert.equal(await page.evaluate(() => window.__copyCalls), 0);
	await waitForClientCount(replacement, 1);
	const otherUpdated = otherPage.waitForNavigation({ waitUntil: "domcontentloaded" });
	replacement.updateDocument(doc("someone else, updated"));
	await otherUpdated;
	assert.equal(await otherPage.$eval("#body", element => element.textContent), "someone else, updated");
	assert.equal(await bodyText(), "original");
	await otherPage.close();
	await waitForClientCount(replacement, 0);

	// Refusing B must not permanently disable A's reconnection. Once the
	// original watcher and its authenticated cookie return, the old tab resumes.
	await replacement.close();
	const restored = await serve(doc("original, restarted"), { port: reused, token });
	const restoredNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 });
	const bootstrapPage = await browser.newPage();
	bootstrapPage.on("pageerror", error => errors.push(String(error)));
	await bootstrapPage.goto(restored.url, { waitUntil: "domcontentloaded" });
	await restoredNavigation;
	assert.equal(await bodyText(), "original, restarted");
	await waitForClientCount(restored, 2);
	assert.equal(await status(), null, "The conflict clears when the original watcher returns.");
	await bootstrapPage.close();
	await waitForClientCount(restored, 1);

	// Identity also stays stable when the first run generated the token and
	// the host later saves/reuses it (rather than supplying it initially).
	const generatedPort = await freePort();
	const generated = await serve(doc("generated token"), { port: generatedPort });
	const generatedToken = new URL(generated.url).searchParams.get("token");
	await page.goto(generated.url, { waitUntil: "domcontentloaded" });
	await waitForClientCount(generated, 1);
	await generated.close();
	const generatedNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 });
	await serve(doc("generated token, restarted"), { port: generatedPort, token: generatedToken });
	await generatedNavigation;
	assert.equal(await bodyText(), "generated token, restarted");

	// Check the page-side identity guard independently of the server's query
	// check: state with a missing/wrong identity must not navigate, even if it
	// claims a fresh instance and matching revision number.
	for (const responseIdentity of [undefined, "f".repeat(64)]) {
		const guardedPage = await browser.newPage();
		guardedPage.on("pageerror", error => errors.push(String(error)));
		await guardedPage.setRequestInterception(true);
		let navigations = 0;
		guardedPage.on("request", request => {
			if (request.isNavigationRequest() && request.frame() === guardedPage.mainFrame()) navigations += 1;
			const action = new URL(request.url()).pathname === eventsPath
				? request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ identity: responseIdentity, instance: "different-run", revision: 1, revisions: [1] }) })
				: request.continue();
			void action.catch(() => {}); // Closing the test page can cancel requests.
		});
		await guardedPage.goto(neutral.url, { waitUntil: "domcontentloaded" });
		await guardedPage.waitForFunction(() => document.querySelector('[data-watch-control="status"]')?.textContent === "Disconnected · different preview");
		assert.equal(navigations, 1, "An unverified reload message must not navigate away from the loaded page.");
		assert.equal(await guardedPage.$eval("#body", element => element.textContent), "x");
		await guardedPage.close();
	}

	// A known conflict survives both failed HTTP retries and malformed state.
	// Then recover on the SAME server run
	// and revision: no page navigation/reload can incidentally clear the message.
	const retryServer = await serve(doc("retry status"), { port: await freePort() });
	const retryPage = await browser.newPage();
	retryPage.on("pageerror", error => errors.push(String(error)));
	await retryPage.setRequestInterception(true);
	let attempts = 0;
	let retryNavigations = 0;
	let heldReconnect;
	retryPage.on("request", request => {
		if (request.isNavigationRequest() && request.frame() === retryPage.mainFrame()) retryNavigations += 1;
		let action;
		if (new URL(request.url()).pathname !== eventsPath) action = request.continue();
		else if (++attempts === 1) action = request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ identity: "f".repeat(64), instance: "different-run", revisions: [1] }) });
		else if (attempts === 2) action = request.respond({ status: 403, body: "Unavailable" });
		else if (attempts === 3) action = request.respond({ status: 200, contentType: "application/json", body: "not-json" });
		else { heldReconnect = request; return; }
		void action.catch(() => {});
	});
	await retryPage.goto(retryServer.url, { waitUntil: "domcontentloaded" });
	await retryPage.waitForFunction(text => document.querySelector('[data-watch-control="status"]').textContent === text, {}, conflictStatus);
	await traceStatus(retryPage);
	const retryDeadline = Date.now() + 15_000;
	while (!heldReconnect && Date.now() < retryDeadline) await new Promise(done => setTimeout(done, 20));
	assert.ok(heldReconnect, "Expected retries after both the HTTP error and malformed state.");
	assert.equal(attempts, 4);
	assert.equal(await retryPage.$eval('[data-watch-control="status"]', element => element.hidden ? null : element.textContent), conflictStatus);
	assert.ok((await retryPage.evaluate(() => window.__watchStatusChanges)).every(text => text === conflictStatus),
		"Neither generic errors nor malformed state may erase the last known conflict.");
	await heldReconnect.continue();
	await waitForClientCount(retryServer, 1);
	await retryPage.waitForFunction(() => document.querySelector('[data-watch-control="status"]').hidden);
	assert.equal(retryNavigations, 1, "Verification must clear status without navigating away from this document.");
	assert.equal(await retryPage.$eval("#body", element => element.textContent), "retry status");
	await retryPage.close();
	await waitForClientCount(retryServer, 0);

	// More than six same-origin tabs used to exhaust HTTP/1 slots with SSE,
	// leaving later document requests stuck loading. Every poll must finish.
	const many = await serve(doc("many tabs, first"));
	many.updateDocument(doc("many tabs, second"));
	const tabs = [], legacyRequests = [];
	try {
		for (let n = 0; n < 10; n++) {
			const tab = await browser.newPage();
			tabs.push(tab);
			tab.on("pageerror", error => errors.push(String(error)));
			tab.on("request", request => { if (new URL(request.url()).pathname === "/__pi_markdown_preview_events__") legacyRequests.push(request.url()); });
			await tab.goto(many.url, { waitUntil: "load", timeout: 5000 });
		}
		assert.deepEqual(legacyRequests, [], "New pages never start permanent streams.");
		await waitForClientCount(many, 10);
		const last = tabs.at(-1);
		await last.bringToFront();
		await last.click('[data-watch-control="toggle"]');
		await Promise.all([last.waitForNavigation({ waitUntil: "load", timeout: 5000 }), last.click('[data-watch-control="previous"]')]);
		assert.equal(await last.$eval("#body", el => el.textContent), "many tabs, first");
		many.updateDocument(doc("many tabs, third"));
		await last.waitForFunction(() => !document.querySelector('[data-watch-control="new"]').hidden);
		assert.equal(await last.$eval("#body", el => el.textContent), "many tabs, first", "A historical tab stays put.");
		await Promise.all([last.waitForNavigation({ waitUntil: "load", timeout: 5000 }), last.click('[data-watch-control="latest"]')]);
		assert.equal(await last.$eval("#body", el => el.textContent), "many tabs, third");
		const update = last.waitForNavigation({ waitUntil: "load", timeout: 5000 });
		many.updateDocument(doc("many tabs, fourth"));
		await update;
		assert.equal(await last.$eval("#body", el => el.textContent), "many tabs, fourth");
	} finally { await Promise.all(tabs.map(tab => tab.close())); }
	await waitForClientCount(many, 0);

	assert.deepEqual(errors, []);
	console.log("Watch polling, multi-tab navigation, persistent status, identity isolation and restart reconnection checks passed.");
} finally {
	await browser?.close();
	await Promise.allSettled(servers.map(server => server.close()));
	await preview?.closeSharedPreviewBrowser?.();
	await rm(modulePath, { force: true });
	await rm(scratch, { recursive: true, force: true });
}
