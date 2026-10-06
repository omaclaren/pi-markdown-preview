import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBrowserWatchServer, rewriteBrowserWatchLocalDocumentLinks } from "../shared/browser-watch-server.js";
import { createHtmlPageServer } from "../shared/html-page-preview.js";

const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
const prefix = "/__pi_markdown_preview_document__/";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
const doc = body => `<!doctype html><html><head><title>Source</title></head><body><main id="preview-root">${body}</main></body></html>`;
const attr = (html, name) => html.match(new RegExp(`\\b${name}="([^"]+)"`))[1].replaceAll("&amp;", "&");
const login = async url => { const response = await fetch(url); return { html: await response.text(), headers: { cookie: response.headers.get("set-cookie").split(";")[0] } }; };

test("all supported image links rewrite safely, including local file URLs and Windows paths", () => {
	const seen = [];
	for (const extension of Object.keys(types)) {
		const html = rewriteBrowserWatchLocalDocumentLinks(`<a href="../figures/image.${extension.toUpperCase()}#view">Image</a>`, "/work/project", path => { seen.push(path); return "/allowed"; }, "darwin");
		assert.match(html, /href="\/allowed#view" rel="noopener noreferrer"/);
	}
	assert.equal(seen.length, 9);
	assert.ok(seen.every(path => path.startsWith("/work/figures/image.")));
	const paths = [];
	for (const href of ["../figures/plot%20%26%20r%C3%A9sum%C3%A9%20%231.PNG", "/work/figures/plot%20%26%20r%C3%A9sum%C3%A9%20%231.PNG", "file:///work/figures/plot%20%26%20r%C3%A9sum%C3%A9%20%231.PNG"]) {
		rewriteBrowserWatchLocalDocumentLinks(`<a href="${href}">Image</a>`, "/work/project", path => { paths.push(path); return "/allowed"; }, "darwin");
	}
	assert.deepEqual(paths, Array(3).fill("/work/figures/plot & résumé #1.PNG"));
	for (const href of ["file:///C:/figures/plot%20one.png", "C:/figures/plot%20one.png", "../figures/plot%20one.png"]) {
		rewriteBrowserWatchLocalDocumentLinks(`<a href="${href}">Image</a>`, "C:\\project", path => { assert.equal(path, "C:\\figures\\plot one.png"); return "/allowed"; }, "win32");
	}
	for (const href of ["#figure", "?revision=1", "https://example.com/image.png", "//example.com/image.png", "file://remote/image.png", "data:image/png;base64,abc", "bad%00.png", "bad%XX.png"]) {
		const input = `<a href="${href}">Unchanged</a>`;
		assert.equal(rewriteBrowserWatchLocalDocumentLinks(input, "/work", () => assert.fail(href)), input);
	}
	const inert = `<!-- <a href="private.png"> --><script>const example = '<a href="private.png">';</script><textarea><a href="private.png"></textarea><span title="<a href='private.png'>">Example</span>`;
	assert.equal(rewriteBrowserWatchLocalDocumentLinks(inert, "/work", () => assert.fail("not an authored link")), inert);
});

test("image pages are authenticated, bounded, binary-safe and stream named resources without text rendering", { timeout: 20_000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "preview-image-http-"));
	const project = join(root, "project"), assets = join(root, "assets");
	await mkdir(project); await mkdir(assets);
	const name = 'plot & résumé #1 "quote".PNG', path = join(assets, name);
	await writeFile(path, png);
	await writeFile(join(project, "large.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
	await mkdir(join(project, "directory.png"));
	await writeFile(join(project, "next.md"), "next");
	const hrefs = [`../assets/${encodeURIComponent(name)}`, pathToFileURL(path).href, encodeURI(path).replaceAll("#", "%23"), "missing.png", "directory.png", "large.png", "next.md"];
	let renders = 0;
	const source = doc(hrefs.map(href => `<a href="${href}">Link</a>`).join(""));
	const server = await createBrowserWatchServer(source, project, { historyLimit: 1, renderLocalDocument: async () => { renders++; return doc("Next document"); } });
	let ordinary;
	t.after(async () => { await ordinary?.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
	ordinary = await createBrowserWatchServer(doc('<a href="large.png">Original</a>'), project);
	assert.match((await login(ordinary.url)).html, /href="large.png"/, "linked previews remain opt-in");
	const { html, headers } = await login(server.url);
	const urls = [...html.matchAll(/href="(\/__pi_markdown_preview_document__\/[^"#]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), server.url));
	assert.equal(urls.length, 7);
	assert.equal(urls[0].pathname, urls[1].pathname);
	assert.equal(urls[0].pathname, urls[2].pathname);
	assert.equal(decodeURIComponent(urls[0].pathname.split("/").at(-1)), name);
	const request = async (url, options, expected) => { const response = await fetch(url, options); assert.equal(response.status, expected); return response; };
	await (await request(urls[0], {}, 403)).text();
	const wrong = new URL(urls[0]); wrong.searchParams.set("identity", "wrong");
	await (await request(wrong, { headers }, 409)).text();
	await (await request(urls[0], { headers, method: "POST" }, 405)).text();
	assert.equal(await (await request(urls[0], { headers, method: "HEAD" }, 200)).text(), "");
	assert.equal(renders, 0);
	const response = await request(urls[0], { headers }, 200), page = await response.text();
	assert.match(page, /Return to preview/);
	assert.match(page, /Actual size/);
	assert.match(page, /plot &amp; résumé #1 &quot;quote&quot;\.PNG/);
	assert.doesNotMatch(page, /file:|<svg\b|data-watch-control/);
	assert.ok(response.headers.get("content-security-policy").includes(`'nonce-${attr(page, "nonce")}'`));
	const imageUrl = new URL(attr(page, "src"), server.url);
	await (await request(imageUrl, {}, 403)).text();
	const image = await request(imageUrl, { headers }, 200);
	assert.equal(image.headers.get("content-type"), "image/png");
	assert.equal(image.headers.get("cache-control"), "no-store");
	assert.equal(image.headers.get("x-content-type-options"), "nosniff");
	assert.match(image.headers.get("content-security-policy"), /sandbox/);
	assert.equal(decodeURIComponent(image.headers.get("content-disposition").split("filename*=UTF-8''")[1]), name);
	assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
	const head = await request(imageUrl, { headers, method: "HEAD" }, 200);
	assert.equal(head.headers.get("content-length"), String(png.length)); assert.equal(await head.text(), "");
	const range = await request(imageUrl, { headers: { ...headers, range: "bytes=0-7" } }, 206);
	assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
	await writeFile(path, Buffer.concat([png, Buffer.from("revised")]));
	assert.equal((await (await request(imageUrl, { headers }, 200)).arrayBuffer()).byteLength, png.length + 7, "resource refresh rereads bytes");
	await (await request(urls[3], { headers }, 404)).text();
	assert.match(await (await request(urls[4], { headers }, 200)).text(), /Local folder/, "directories with image-like names get a path page");
	const large = await (await request(urls[5], { headers }, 200)).text();
	const largeResource = await request(new URL(attr(large, "src"), server.url), { headers }, 200);
	assert.equal((await largeResource.arrayBuffer()).byteLength, 2 * 1024 * 1024 + 1, "images do not pass through the UTF-8/text size gate");
	assert.equal(renders, 0);
	await (await request(imageUrl, { headers }, 404)).text(); // historyLimit=1 also bounds linked image resources.
	for (const route of [`${prefix}${"0".repeat(64)}/private.png`, `${urls[0].pathname}/extra`, urls[0].pathname.replace(/\/[^/]+$/, "/wrong.png")]) {
		await (await request(new URL(route, server.url), { headers }, 404)).text();
	}
	await (await request(urls[6], { headers }, 200)).text(); assert.equal(renders, 1);
	server.updateDocument(doc("No links"));
	await (await request(urls[0], { headers }, 404)).text();
});

test("image link and isolated HTML asset allowlists agree for every supported format", async t => {
	const root = await mkdtemp(join(tmpdir(), "preview-image-types-"));
	// These are transport/allowlist fixtures, not decoder tests for other formats.
	for (const extension of Object.keys(types)) await writeFile(join(root, `image.${extension}`), png);
	await writeFile(join(root, "page.html"), "<h1>Page</h1>");
	const server = await createBrowserWatchServer(doc(Object.keys(types).map(ext => `<a href="image.${ext}">Image</a>`).join("")), root, { renderLocalDocument: () => assert.fail("images must not use the text renderer") });
	const htmlServer = await createHtmlPageServer(new URL(server.url).origin);
	t.after(async () => { await htmlServer.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
	const { html, headers } = await login(server.url);
	const urls = [...html.matchAll(/href="(\/__pi_markdown_preview_document__\/[^"#]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), server.url));
	const mount = await htmlServer.register(join(root, "page.html"), "<h1>Page</h1>");
	for (const [index, [extension, type]] of Object.entries(types).entries()) {
		const response = await fetch(urls[index], { headers }); assert.equal(response.status, 200);
		const page = await response.text();
		const image = await fetch(new URL(attr(page, "src"), server.url), { headers });
		assert.equal(image.headers.get("content-type"), type); await image.arrayBuffer();
		const asset = await fetch(new URL(`image.${extension}`, mount));
		assert.equal(asset.status, 200, extension); assert.equal(asset.headers.get("content-type"), type); await asset.arrayBuffer();
	}
});

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
test("image viewer supports Back, return, new tabs, nested links, SVG isolation, sizing and narrow screens", {
	skip: !browserPath && "set PUPPETEER_EXECUTABLE_PATH to a dedicated test browser", timeout: 60_000,
}, async t => {
	const root = await mkdtemp(join(tmpdir(), "preview-image-browser-"));
	const project = join(root, "project"), assets = join(root, "assets");
	await mkdir(join(project, "docs"), { recursive: true }); await mkdir(assets);
	let browser, server;
	t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); });
	const { default: puppeteer } = await import("puppeteer-core");
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
	const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 700 });
	const chart = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#fff"/><g font-family="sans-serif" fill="#283747"><text x="110" y="100" font-size="42">Example response curve</text><text x="110" y="145" font-size="25">Synthetic image · local PNG link</text><path d="M120 210 V750 H1480" fill="none" stroke="#6b7280" stroke-width="3"/><path d="M120 700 C400 700 400 300 800 300 S1100 650 1480 240" fill="none" stroke="#367dc9" stroke-width="8"/><text x="760" y="815" font-size="28">Time</text></g></svg>';
	const generated = await page.evaluate(async svg => {
		const image = new Image(); image.src = 'data:image/svg+xml,' + encodeURIComponent(svg); await image.decode();
		const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
		canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
	}, chart);
	const imageName = "plot & résumé #1.png";
	await writeFile(join(assets, imageName), Buffer.from(generated, "base64"));
	await writeFile(join(assets, "danger.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" onload="window.svgRan=true"><view id="detail" viewBox="0 0 800 450"/><rect width="1600" height="900" fill="green"/><script>window.svgRan=true; fetch("/SVG_SCRIPT_RAN");</script></svg>');
	await writeFile(join(assets, "broken.png"), "not an image");
	await writeFile(join(project, "docs", "report.md"), "Report");
	const paragraphs = '<p style="height:80px">Source paragraph</p>'.repeat(25);
	const source = doc(`<h1>Original response</h1>${paragraphs}<p id="anchor">Reading here</p><a id="picture" href="../assets/${encodeURIComponent(imageName)}">Image</a> <a id="report" href="docs/report.md">Report</a> <a id="svg" href="../assets/danger.svg#detail">SVG</a> <a id="broken" href="../assets/broken.png">Broken image</a>`);
	server = await createBrowserWatchServer(source, project, { renderLocalDocument: async () => doc(`<h1>Nested report</h1>${paragraphs}<a id="nested-image" href="../../assets/${encodeURIComponent(imageName)}">Nested image</a>`) });
	await page.goto(server.url, { waitUntil: "load" });
	await page.$eval("#anchor", element => element.scrollIntoView()); const y = await page.evaluate(() => scrollY);
	await Promise.all([page.waitForNavigation(), page.click("#picture")]);
	await page.waitForFunction(() => document.querySelector('#preview-image')?.naturalWidth === 1600);
	assert.equal(await page.title(), `${imageName} — Markdown Preview`);
	assert.ok(await page.$eval("#preview-image", image => image.getBoundingClientRect().width < image.naturalWidth));
	assert.equal(await page.$eval("#image-error", element => element.hidden), true);
	if (process.env.IMAGE_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.IMAGE_PREVIEW_SCREENSHOT });
	await page.click("#image-size");
	assert.equal(await page.$eval("#preview-image", image => image.getBoundingClientRect().width), 1600);
	assert.equal(await page.$eval("#image-size", button => button.getAttribute("aria-pressed")), "true");
	await page.click("#image-size");
	server.updateDocument(source.replace("Original response", "New response"));
	await page.goBack({ waitUntil: "load" });
	await page.waitForFunction(expected => Math.abs(scrollY - expected) < 80, {}, y);
	assert.equal(new URL(page.url()).searchParams.get("revision"), "1");
	assert.equal(await page.$eval("h1", node => node.textContent), "Original response");
	const popupPromise = browser.waitForTarget(target => target.type() === "page" && target !== page.target() && target.url().includes(prefix), { timeout: 10_000 });
	await page.click("#picture", { button: "middle" });
	const popup = await (await popupPromise).page();
	await popup.waitForFunction(() => document.querySelector('#preview-image')?.naturalWidth === 1600);
	assert.equal(await popup.evaluate(() => window.opener), null);
	await popup.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
	await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
	assert.match(await popup.$eval("#preview-image", image => getComputedStyle(image).backgroundImage), /gradient/, "transparency stays visible in either colour scheme");
	assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	assert.ok(await popup.$eval("#image-size", button => button.getBoundingClientRect().height >= 44));
	assert.ok(await popup.$eval('nav[aria-label="Document navigation"] a', link => link.getBoundingClientRect().height >= 44));
	await Promise.all([popup.waitForNavigation(), popup.click('nav[aria-label="Document navigation"] a')]);
	assert.equal(await popup.$eval("h1", node => node.textContent), "Original response");
	await popup.close();
	await Promise.all([page.waitForNavigation(), page.click("#report")]);
	await Promise.all([page.waitForNavigation(), page.click("#nested-image")]);
	await page.waitForFunction(() => document.querySelector('#preview-image')?.naturalWidth === 1600);
	await page.goBack({ waitUntil: "load" }); assert.equal(await page.$eval("h1", node => node.textContent), "Nested report");
	await Promise.all([page.waitForNavigation(), page.click('nav[aria-label="Document navigation"] a')]);
	const requests = []; page.on("request", request => requests.push(request.url()));
	await Promise.all([page.waitForNavigation(), page.click("#svg")]);
	await page.waitForFunction(() => document.querySelector('#preview-image')?.naturalWidth === 1600);
	assert.equal(await page.$eval("#preview-image", image => new URL(image.src).hash), "#detail");
	assert.equal(await page.evaluate(() => window.svgRan), undefined);
	assert.equal(await page.$("svg"), null, "SVG is not inserted into the trusted DOM");
	const rawSvg = await page.$eval("#preview-image", image => image.src);
	await page.goto(rawSvg, { waitUntil: "load" });
	assert.equal(await page.evaluate(() => window.svgRan), undefined, "direct SVG resources are sandboxed too");
	assert.ok(!requests.some(url => url.includes("SVG_SCRIPT_RAN")));
	await page.goto(server.url + "&revision=1", { waitUntil: "load" });
	await Promise.all([page.waitForNavigation(), page.click("#broken")]);
	await page.waitForFunction(() => document.querySelector('#image-error')?.hidden === false);
});
