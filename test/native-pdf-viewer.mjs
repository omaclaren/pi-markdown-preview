// Requires full test-only Chromium, not chrome-headless-shell (which lacks the native PDF viewer).
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

assert.ok(process.env.PUPPETEER_PDF_EXECUTABLE_PATH, "Set PUPPETEER_PDF_EXECUTABLE_PATH to a dedicated full test Chromium executable.");
const root = await mkdtemp(join(tmpdir(), "pmp-native-pdf-"));
const filename = "Gaussian plot α.pdf";
let server, browser;
try {
	await copyFile(new URL("./gaussian_plot.pdf", import.meta.url), join(root, filename));
	server = await createBrowserWatchServer(`<html><head></head><body><main id="preview-root"><a id="pdf" href="${filename}">PDF</a></main></body></html>`, root, { renderLocalDocument: async () => "" });
	browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_PDF_EXECUTABLE_PATH, headless: true, userDataDir: join(root, "browser") });
	const page = await browser.newPage();
	await page.goto(server.url);
	await page.click("#pdf");
	let viewer;
	for (let i = 0; i < 100; i++) {
		viewer = page.frames().find(frame => frame.url().startsWith("chrome-extension:"));
		if (viewer) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(viewer, "Native PDF viewer should open in the same tab");
	await viewer.waitForFunction(() => document.querySelector("pdf-viewer")?.loadProgress_ === 100, { timeout: 10000 });
	assert.equal(await viewer.evaluate(() => document.querySelector("pdf-viewer").shadowRoot.querySelector("viewer-toolbar").shadowRoot.querySelector("#title").textContent), filename);
	await page.goBack();
	await page.waitForSelector("#pdf");
	console.log("PASS native Chromium PDF rendering, filename, and browser Back");
} finally {
	await browser?.close(); await server?.close();
	await rm(root, { recursive: true, force: true });
}
