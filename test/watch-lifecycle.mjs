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
	await assert.rejects(createBrowserWatchServer(doc("x"), scratch, { port: Number(new URL(taken.url).port) }), /EADDRINUSE/);

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
	await page.waitForFunction(() => true);
	for (let i = 0; i < 50 && history.clientCount === 0; i++) await new Promise(done => setTimeout(done, 20));
	assert.equal(history.clientCount, 1, "The open page counts as a connected client.");
	await shortcut(true, "ArrowLeft");
	assert.equal(await bodyText(), "one");
	assert.equal(revisionInUrl(), "1");
	await shortcut(false, "ArrowRight");
	assert.equal(await bodyText(), "two");
	await shortcut(true, "ArrowRight");
	assert.equal(await bodyText(), "three");
	assert.equal(await status(), null, "No status while connected.");

	// A stopped server without a fixed port never returns: say so, once.
	await history.close();
	await page.waitForFunction(() => !document.querySelector('[data-watch-control="status"]').hidden);
	assert.equal(await status(), "Preview stopped · this page no longer updates");

	// Fixed port and token: the page reconnects to the restarted server and
	// follows its (renumbered) latest revision.
	const port = await freePort();
	const token = "t".repeat(40);
	const first = await serve(doc("before restart"), { port, token });
	await page.goto(first.url, { waitUntil: "domcontentloaded" });
	assert.equal(await bodyText(), "before restart");
	await first.close();
	await page.waitForFunction(() => /reconnects when it restarts/.test(document.querySelector('[data-watch-control="status"]').textContent));
	const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 });
	const second = await serve(doc("after restart"), { port, token });
	await navigation;
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
	await original.close();
	await serve(doc("someone else"), { port: reused, token: "u".repeat(40) });
	await page.waitForFunction(() => /Disconnected/.test(document.querySelector('[data-watch-control="status"]').textContent), { timeout: 20_000 });
	assert.equal(await bodyText(), "original", "Never shows another server's content.");

	assert.deepEqual(errors, []);
	console.log("Watch shortcuts, stopped/disconnected status and restart reconnection checks passed.");
} finally {
	await browser?.close();
	await Promise.allSettled(servers.map(server => server.close()));
	await preview?.closeSharedPreviewBrowser?.();
	await rm(modulePath, { force: true });
	await rm(scratch, { recursive: true, force: true });
}
