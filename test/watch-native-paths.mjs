import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBrowserWatchServer, rewriteBrowserWatchLocalDocumentLinks } from "../shared/browser-watch-server.js";
import { nativePathCommand } from "../shared/native-path-action.js";

const doc = body => `<!doctype html><html><head><title>Native paths</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="preview-root">${body}</main></body></html>`;
const href = (html, id) => html.match(new RegExp(`id="${id}" href="([^"]+)"`))[1].replaceAll("&amp;", "&");
const config = html => JSON.parse(html.match(/\{"url":"\/__pi_markdown_preview_native_action__\/[^\n]+?"previewable":(?:true|false)\}/)[0]);
const login = async url => { const r = await fetch(url); return { html: await r.text(), headers: { cookie: r.headers.get("set-cookie").split(";")[0] } }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;

async function fixture(t, action) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "preview-native-paths-")));
 const project = join(root, "project"), outside = join(root, "outside");
 await mkdir(project); await mkdir(outside);
 const zip = join(outside, "bundle & résumé #1 '$&' <tag>.zip");
 await writeFile(zip, Buffer.from([0, 1, 2, 255]));
 await writeFile(join(project, "notebook.ipynb"), '{"cells":[{"source":"NOTEBOOK_CONTENT_MUST_NOT_BE_SERVED"}]}');
 await mkdir(join(project, "folder"));
 await writeFile(join(project, "folder/private-child.md"), "FOLDER_CONTENT_MUST_NOT_BE_SERVED");
 await writeFile(join(project, "report.md"), "# Report");
 await writeFile(join(project, "report.pdf"), "%PDF-1.4\nfixture");
 await writeFile(join(project, "opaque"), "OPAQUE_CONTENT_MUST_NOT_BE_SERVED");
 await symlink(zip, join(project, "alias.zip"));
 const source = doc(`<h1>Local files and folders</h1><p><a id="zip" href="${pathToFileURL(zip).href}">Archive</a></p><p><a id="notebook" href="notebook.ipynb">Notebook</a></p><p><a id="folder" href="folder/">Folder</a></p><p><a id="report" href="report.md">Report</a></p><p><a id="pdf" href="report.pdf">PDF</a></p><p><a id="opaque" href="opaque">Other file</a></p><p><a id="alias" href="alias.zip">Alias</a></p><p><a id="missing" href="missing.zip">Missing file</a></p>`);
 const calls = []; let renders = 0, browser;
 const options = { historyLimit: 4, renderLocalDocument: async () => { renders++; return doc('<h1>Rendered report</h1><a id="nested" href="notebook.ipynb">Nested notebook</a>'); }, nativePathAction: async (...args) => { calls.push(args); await action?.(...args); } };
 const server = await createBrowserWatchServer(source, project, options);
 t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
 const auth = await login(server.url);
 const url = id => new URL(href(auth.html, id), server.url);
 const pathPage = async id => { const u = url(id); u.searchParams.set("view", "path"); const r = await fetch(u, { headers: auth.headers }); assert.equal(r.status, 200); const html = await r.text(); return { html, config: config(html), url: u }; };
 const request = (c, action = "open", opts = {}) => {
  const u = new URL(c.url, server.url); u.searchParams.set("action", action);
  return fetch(u, { method: "POST", headers: { ...auth.headers, origin: new URL(server.url).origin, "x-preview-action": c.key }, ...opts });
 };
 return { root, project, zip, source, server, options, calls, auth, url, pathPage, request, renders: () => renders, async page() {
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
  const page = await browser.newPage(); await page.setViewport({ width: 900, height: 740 });
  await page.evaluateOnNewDocument(() => {
   Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.copiedPath = text; } } });
   document.execCommand = () => { throw new Error("Clipboard fallback intercepted"); };
  });
  await page.goto(server.url, { waitUntil: "load" });
  return { page, browser };
 } };
}

test("all authored local paths get capabilities, with fixed shell-free native command arguments", () => {
 const paths = [];
 const inputs = ["bundle.zip", "notebook.ipynb", "folder/", "../.env", "opaque", "file:///other/folder/"];
 const html = rewriteBrowserWatchLocalDocumentLinks(inputs.map(x => `<a href="${x}">Path</a>`).join(""), "/project", path => { paths.push(path); return "/authorized"; }, "darwin");
 assert.equal((html.match(/href="\/authorized"/g) || []).length, inputs.length);
 assert.deepEqual(paths, ["/project/bundle.zip", "/project/notebook.ipynb", "/project/folder", "/.env", "/project/opaque", "/other/folder/"]);
 for (const input of ["https://example.com/a.zip", "javascript:alert(1)", "data:text/plain,a", "file://remote/a.zip", "#part", "?revision=1", "/__pi_markdown_preview_document__/id", "bad%00.zip", "bad%XX.zip"]) {
  const source = `<a href="${input}">No</a>`;
  assert.equal(rewriteBrowserWatchLocalDocumentLinks(source, "/project", () => { throw new Error("Unexpected capability"); }), source);
 }
 const path = "/tmp/-name & $(not-a-command); 'résumé'.zip";
 assert.deepEqual(nativePathCommand("open", path, "file", "darwin"), { file: "/usr/bin/open", args: ["--", path] });
 assert.deepEqual(nativePathCommand("reveal", path, "file", "darwin").args, ["-R", "--", path]);
 assert.deepEqual(nativePathCommand("open", "/tmp/folder.app", "directory", "darwin").args, ["-a", "Finder", "--", "/tmp/folder.app"]);
 assert.deepEqual(nativePathCommand("reveal", path, "file", "linux"), { file: "xdg-open", args: ["/tmp"] });
 assert.deepEqual(nativePathCommand("open", path, "file", "linux").args, [path]);
 const win = 'C:\\notes & stuff\\report, final.ipynb';
 assert.deepEqual(nativePathCommand("reveal", win, "file", "win32").args, [`/select,${win}`]);
 assert.deepEqual(nativePathCommand("open", win, "file", "win32").args, [win]);
 assert.throws(() => nativePathCommand("open", "javascript:bad", "file", "darwin"));
 assert.throws(() => nativePathCommand("delete", path, "file", "darwin"));
 assert.throws(() => nativePathCommand("open", path, "file", "freebsd"), { statusCode: 501 });
});

test("path pages never read arbitrary files, list folders, or invoke native actions on navigation", async t => {
 const f = await fixture(t);
 for (const id of ["zip", "notebook", "folder", "opaque", "alias"]) {
  const response = await fetch(f.url(id), { headers: f.auth.headers }); assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('id="pi-preview-native-actions"'));
  assert.ok(!html.includes("NOTEBOOK_CONTENT_MUST_NOT_BE_SERVED") && !html.includes("private-child.md") && !html.includes("OPAQUE_CONTENT_MUST_NOT_BE_SERVED"));
  assert.equal(config(html).kind, id === "folder" ? "directory" : "file");
  assert.equal((await fetch(f.url(id), { headers: f.auth.headers, method: "HEAD" })).status, 200);
 }
 assert.equal(f.renders(), 0); assert.deepEqual(f.calls, []);
 assert.equal((await fetch(f.url("zip"))).status, 403);
 assert.equal((await fetch(f.url("missing"), { headers: f.auth.headers })).status, 404);
 assert.equal((await fetch(new URL("/notebook.ipynb", f.server.url), { headers: f.auth.headers })).status, 415);
 const child = f.url("folder"); child.pathname += "/private-child.md";
 assert.equal((await fetch(child, { headers: f.auth.headers })).status, 404);
 const pdf = await fetch(f.url("pdf"), { headers: f.auth.headers }); assert.equal(pdf.headers.get("content-type"), "application/pdf"); await pdf.text();
 assert.equal((await f.pathPage("pdf")).config.previewable, true);
 assert.equal((await f.pathPage("report")).config.previewable, true); assert.equal(f.renders(), 0);
 const report = await (await fetch(f.url("report"), { headers: f.auth.headers })).text(); assert.equal(f.renders(), 1);
 await f.pathPage("report");
 const nested = new URL(href(report, "nested"), f.server.url);
 assert.equal((await fetch(nested, { headers: f.auth.headers })).status, 200, "a path page must not discard its preview's nested capabilities");
 if (process.platform !== "win32") {
  const c = (await f.pathPage("zip")).config;
  execFileSync("mkfifo", [join(f.project, "pipe.zip")]);
  f.server.updateDocument(doc('<a id="fifo" href="pipe.zip">FIFO</a>'));
  const a = await login(f.server.url);
  const fifo = new URL(href(a.html, "fifo"), f.server.url);
  assert.equal((await fetch(fifo, { headers: a.headers })).status, 415);
  const native = new URL(c.url, f.server.url);
  native.pathname = native.pathname.replace(/[a-f0-9]{64}$/, fifo.pathname.split('/')[2]);
  assert.equal((await f.request({ ...c, url: native.href })).status, 415, "native open must also reject special files without opening them");
  assert.deepEqual(f.calls, []);
 }
});

test("native actions require POST, cookie, exact origin/identity/instance, secret header and a retained path", async t => {
 const f = await fixture(t);
 const { config: c } = await f.pathPage("zip");
 const u = new URL(c.url, f.server.url); u.searchParams.set("action", "reveal");
 const headers = { ...f.auth.headers, origin: new URL(f.server.url).origin, "x-preview-action": c.key };
 for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) assert.equal((await fetch(u, { headers, method })).status, 405);
 for (const change of [{ cookie: "" }, { origin: "" }, { origin: "null" }, { origin: "https://attacker.example" }, { "x-preview-action": "" }, { "x-preview-action": "wrong" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-dest": "document" }]) {
  assert.equal((await fetch(u, { method: "POST", headers: { ...headers, ...change } })).status, 403);
 }
 // Fetch normalizes Host itself; use a raw HTTP request to test rebinding.
 const wrongHostStatus = await new Promise((resolve, reject) => {
  const req = httpRequest(u, { method: "POST", headers: { ...headers, host: "attacker.example" } }, response => { response.resume(); resolve(response.statusCode); });
  req.on("error", reject); req.end();
 });
 assert.equal(wrongHostStatus, 403);
 for (const [key, value, status] of [["identity", "wrong", 409], ["identity", null, 403], ["instance", "old", 403], ["instance", null, 403], ["action", "delete", 400]]) {
  const bad = new URL(u); value === null ? bad.searchParams.delete(key) : bad.searchParams.set(key, value);
  assert.equal((await fetch(bad, { method: "POST", headers })).status, status);
 }
 const unknown = new URL(u); unknown.pathname = unknown.pathname.replace(/[a-f0-9]{64}$/, "0".repeat(64));
 assert.equal((await fetch(unknown, { method: "POST", headers })).status, 404);
 assert.deepEqual(f.calls, []);
 assert.equal((await fetch(u, { method: "POST", headers, body: JSON.stringify({ path: "/NOT_AUTHORIZED", action: "delete" }) })).status, 204);
 assert.deepEqual(f.calls, [["reveal", f.zip, "file"]], "no caller-supplied path or action body may be used");
 assert.equal((await f.request(c)).status, 429);
 f.server.updateDocument(doc("No links"));
 for (let i = 0; i < 4; i++) f.server.updateDocument(doc("No links " + i));
 assert.equal((await f.request(c)).status, 404);
});

test("native requests preserve symlink paths, report failures, gate concurrency and reject stale instances", async t => {
 let finish;
 const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
 const { config: c } = await f.pathPage("alias");
 const pending = f.request(c);
 for (let i = 0; i < 100 && !finish; i++) await sleep(10);
 assert.ok(finish); assert.equal((await f.request(c)).status, 429);
 finish(); assert.equal((await pending).status, 204);
 assert.deepEqual(f.calls[0], ["open", join(f.project, "alias.zip"), "file"]);
 const token = new URL(f.server.url).searchParams.get("token"); const port = Number(new URL(f.server.url).port);
 await f.server.close();
 const restarted = await createBrowserWatchServer(f.source, f.project, { ...f.options, token, port });
 try { await login(restarted.url); assert.equal((await f.request(c)).status, 403, "remembered cookies cannot authorize stale native action pages after restart"); } finally { await restarted.close(); }
 const broken = await fixture(t, () => { throw Object.assign(new Error("Desktop unavailable"), { statusCode: 502 }); });
 const p = await broken.pathPage("folder"); const response = await broken.request(p.config);
 assert.equal(response.status, 502); assert.equal(await response.text(), "Desktop unavailable");
 assert.deepEqual(broken.calls[0], ["open", join(broken.project, "folder"), "directory"]);
 await sleep(620); await rm(join(broken.project, "folder"), { recursive: true });
 assert.equal((await broken.request(p.config)).status, 404);
});

test("browser path actions are explicit, accessible, copyable, preserve native links and work on touch", { skip: !browserPath && "dedicated browser required", timeout: 60_000 }, async t => {
 const f = await fixture(t); const { page, browser } = await f.page();
 const errors = []; page.on("pageerror", error => errors.push(String(error)));
 assert.equal(await page.$$eval('.pi-preview-file-actions-inline', nodes => nodes.length), 8);
 assert.equal(await page.$eval('#zip', a => a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))), true);
 await page.focus('#zip'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(() => document.activeElement.className), 'pi-preview-file-actions-inline');
 await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
 await page.waitForSelector('[data-native-action="open"]');
 assert.deepEqual(f.calls, []);
 await page.$eval('[data-native-action="open"]', b => b.click()); assert.deepEqual(f.calls, [], 'script-generated clicks do not invoke native apps');
 await page.click('#pi-preview-native-actions .pi-preview-copy-path');
 await page.waitForFunction(() => !!window.copiedPath); assert.equal(await page.evaluate(() => window.copiedPath), f.zip);
 await page.click('[data-native-action="reveal"]');
 await page.waitForFunction(() => document.querySelector('#pi-preview-native-result').textContent.includes('Request sent'));
 assert.deepEqual(f.calls, [["reveal", f.zip, "file"]]);
 if (process.env.NATIVE_PATH_SCREENSHOT) await page.screenshot({ path: process.env.NATIVE_PATH_SCREENSHOT });
 await page.reload({ waitUntil: 'load' }); assert.equal(f.calls.length, 1, 'reload must not repeat an action');
 await page.goBack({ waitUntil: 'load' });
 await Promise.all([page.waitForNavigation(), page.click('#folder')]);
 assert.equal(await page.$eval('[data-native-action="open"]', b => b.textContent), 'Open folder');
 assert.equal(await page.$('[data-native-action="reveal"]'), null);
 assert.ok(!(await page.$eval('#preview-root', e => e.textContent)).includes('private-child'));
 await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 await sleep(620); await page.tap('[data-native-action="open"]');
 await page.waitForFunction(() => document.querySelector('#pi-preview-native-result').textContent.includes('Request sent'));
 assert.equal(f.calls.at(-1)[2], 'directory');
 await page.goBack({ waitUntil: 'load' });
 const more = '.pi-preview-local-link:has(#pdf) .pi-preview-file-actions-inline';
 assert.equal(await page.$eval(more, a => getComputedStyle(a).opacity), '1');
 const popupPromise = browser.waitForTarget(target => target.type() === 'page' && target !== page.target() && target.url().includes('view=path'));
 await page.click(more, { button: 'middle' });
 const popup = await (await popupPromise).page(); await popup.waitForSelector('[data-native-action="open"]');
 assert.equal(await popup.evaluate(() => window.opener), null); await popup.close();
 await Promise.all([page.waitForNavigation(), page.click('#report')]);
 assert.ok(await page.$('.pi-preview-document-nav .pi-preview-file-actions'));
 await Promise.all([page.waitForNavigation(), page.click('.pi-preview-document-nav .pi-preview-file-actions')]);
 assert.equal(await page.$eval('#pi-preview-native-actions a', a => a.textContent), 'Preview');
 await Promise.all([page.waitForNavigation(), page.click('#pi-preview-native-actions a')]);
 assert.ok((await page.$eval('#preview-root', e => e.textContent)).includes('Rendered report'));
 assert.equal(f.calls.length, 2); assert.deepEqual(errors, []);
 const broken = await fixture(t, () => { throw Object.assign(new Error('Desktop unavailable'), { statusCode: 502 }); });
 const b = await broken.page();
 await Promise.all([b.page.waitForNavigation(), b.page.click('#zip')]);
 await b.page.click('[data-native-action="open"]');
 await b.page.waitForFunction(() => document.querySelector('#pi-preview-native-result').textContent === 'Desktop unavailable');
 assert.equal(await b.page.$eval('[data-native-action="open"]', button => button.hasAttribute('aria-disabled')), false);
 assert.equal(broken.calls.length, 1);
});
