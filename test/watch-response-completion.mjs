// Full-extension completion handlers: no model calls, user sessions or native opens.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import ts from "typescript";

const root = await realpath(await mkdtemp(join(tmpdir(), "pi-preview-completion-")));
const modulePath = resolve(`.pi-markdown-preview-completion-${process.pid}.mjs`);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let preview;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let sequence = 0;
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], responseId: `fixture-${++sequence}`, timestamp: sequence,
	stopReason: "stop", api: "openai-responses", provider: "openai", model: "fixture", usage });
const waitFor = async (check, label) => {
	for (let i = 0; i < 200; i++) {
		const result = await check();
		if (result) return result;
		await sleep(25);
	}
	throw new Error(`Timed out: ${label}`);
};

async function fixture(run, args = "--watch --live", before) {
	const events = new Map(), commands = new Map(), notifications = [];
	const manager = SessionManager.inMemory(root);
	const prompt = text => manager.appendMessage({ role: "user", content: text, timestamp: ++sequence });
	prompt("Earlier prompt"); manager.appendMessage(assistant("Earlier answer"));
	const ctx = { cwd: root, sessionManager: manager, isIdle: () => true, ui: { theme: undefined, notify: (message, type) => notifications.push({ message, type }) } };
	preview.default({ on: (name, fn) => events.set(name, fn), registerCommand: (name, definition) => commands.set(name, definition), registerTool() {} });
	const emit = (name, messages = []) => events.get(name)({ messages }, ctx);
	before?.({ manager, prompt });
	try {
		await commands.get("preview-browser").handler(args, ctx);
		const url = preview.testOpened.at(-1);
		const bootstrap = await fetch(url);
		assert.equal(bootstrap.status, 200);
		const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
		const html = await bootstrap.text();
		const statePath = /data-live-state="([^"]+)"/.exec(html)?.[1].replaceAll("&amp;", "&");
		const get = path => fetch(new URL(path, url), { headers: { cookie } });
		const state = () => get("/__pi_markdown_preview_state__").then(r => r.json());
		const current = () => get(statePath).then(r => r.json());
		const updates = async () => {
			const live = await current();
			assert.ok(live.liveHref, "The synthetic prompt has a Live turn.");
			return get(live.liveHref.replace("?", "/updates?") + "&cursor=").then(r => r.json());
		};
		const rendered = text => waitFor(async () => (await (await get("/")).text()).includes(`<p>${text}</p>`), "response render");
		const page = async () => (await get("/")).text();
		const linked = async text => {
			const data = await updates();
			assert.equal(data.status, "completed");
			assert.ok(data.completedHref, "Completed Live turn must link to its retained Preview.");
			assert.ok((await (await get(data.completedHref)).text()).includes(`<p>${text}</p>`), "Completion link must lead to the exact response.");
		};
		await run({ manager, prompt, emit, url, cookie, state, current, updates, rendered, linked, page });
		assert.deepEqual(notifications.filter(n => n.type === "error" || n.type === "warning"), []);
	} finally {
		await emit("session_shutdown");
	}
}

try {
	let code = ts.transpileModule(await readFile(resolve("index.ts"), "utf8"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
	}).outputText;
	// Same full-index transpilation pattern as regressions.mjs. Only the native
	// open is intercepted; the real handler, renderer, queue and server run.
	const marker = "async function openFileInDefaultBrowser(pathOrUrl, preferCmuxBrowser = false) {";
	assert.equal(code.split(marker).length, 2);
	code = "export const testOpened = [];\n" + code.replace(marker, marker + " testOpened.push(pathOrUrl); return;");
	await writeFile(modulePath, code);
	try { preview = await import(pathToFileURL(modulePath).href); }
	finally { await rm(modulePath, { force: true }); }

	await test("response completion: settled before fallback links once", () => fixture(async f => {
		const initial = await f.state();
		await f.emit("agent_settled"); await tick();
		assert.equal((await f.state()).revision, initial.revision, "Initial render uses the same identity as subsequent refreshes.");
		f.prompt("Settled first"); const message = assistant("Settled-first answer"); f.manager.appendMessage(message);
		await f.emit("agent_end", [message]); await f.emit("agent_settled");
		await f.rendered("Settled-first answer"); await f.linked("Settled-first answer");
		assert.equal((await f.state()).revisions.length, 2);
	}));

	await test("response completion: fallback before settled links without waiting for settled", () => fixture(async f => {
		f.prompt("Fallback first"); const message = assistant("Fallback-first answer"); f.manager.appendMessage(message);
		await f.emit("agent_end", [message]); await f.rendered("Fallback-first answer");
		await f.linked("Fallback-first answer"); // Also covers hosts that never emit settled.
		const before = await f.state();
		await f.emit("agent_settled"); await tick();
		assert.equal((await f.state()).revision, before.revision, "Settled must not render a duplicate after a matched fallback.");
		assert.equal(before.revisions.length, 2);
	}));

	await test("response completion: later persistence repairs identical rendered text without duplicating history", () => fixture(async f => {
		f.prompt("Persist later"); const message = assistant("Delayed-persistence answer");
		await f.emit("agent_end", [message]); await f.rendered("Delayed-persistence answer");
		const before = await f.state();
		assert.equal((await f.updates()).completedHref, undefined);
		f.manager.appendMessage(message);
		assert.equal((await f.updates()).status, "completed");
		assert.equal((await f.updates()).completedHref, undefined, "An unassociated rendering cannot stand in for the final key.");
		await f.emit("agent_settled");
		await waitFor(async () => (await f.state()).revision !== before.revision, "entry identity repair");
		await f.linked("Delayed-persistence answer");
		assert.equal((await f.state()).revisions.length, before.revisions.length, "Repair replaces the rendering, not the response's history slot.");
		const repaired = await f.state();
		await f.emit("agent_settled"); await tick();
		assert.equal((await f.state()).revision, repaired.revision);
	}));

	for (const kind of ["different key", "different text", "ambiguous", "abandoned branch"]) {
		await test(`response completion: fallback cannot borrow an entry from ${kind}`, () => fixture(async f => {
			const anchor = f.prompt("Only the exact recorded response may link");
			const event = assistant("Unlinked event answer");
			if (kind === "different key") f.manager.appendMessage({ ...event, responseId: "unrelated-response" });
			if (kind === "different text") f.manager.appendMessage({ ...event, content: [{ type: "text", text: "Different recorded answer" }] });
			if (kind === "ambiguous") { f.manager.appendMessage(event); f.manager.appendMessage(event); }
			if (kind === "abandoned branch") {
				f.manager.appendMessage(event); f.manager.branch(anchor);
				f.manager.appendMessage(assistant("Replacement branch answer"));
			}
			await f.emit("agent_end", [event]); await f.rendered("Unlinked event answer");
			assert.equal((await f.updates()).completedHref, undefined, "A mismatched or ambiguous fallback must not associate the Preview with another recorded entry.");
		}));
	}

	// A turn that ran pi-repl's repl_send, then answered.
	const replTurn = f => {
		const code = "import math\nprint(math.pi)";
		f.prompt("What is pi?");
		f.manager.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "repl-call", name: "repl_send", arguments: { code } }], stopReason: "toolUse" });
		f.manager.appendMessage({ role: "toolResult", toolCallId: "repl-call", toolName: "repl_send", content: [{ type: "text", text: `Submitted code:\n${code}\n\nOutput:\n3.141592653589793\n` }], isError: false, timestamp: ++sequence });
		const message = assistant("Pi is about 3.14."); f.manager.appendMessage(message);
		return message;
	};
	for (const [args, working] of [["--watch --working", true], ["--watch --live", true], ["--watch", false]]) {
		await test(`response completion: ${args} ${working ? "folds in" : "leaves out"} the REPL code the turn ran`, () => fixture(async f => {
			const message = replTurn(f);
			await f.emit("agent_end", [message]); await f.rendered("Pi is about 3.14.");
			const html = await f.page();
			if (working) {
				assert.match(html, /<p>Pi is about 3\.14\.<\/p>[^]*<details[^>]*>\s*<summary>REPL · Python · 1 submission in this turn<\/summary>/);
				assert.match(html, /3\.141592653589793/);
			} else assert.doesNotMatch(html, /REPL ·|3\.141592653589793/, "tool output needs Working");
		}, args));
	}
	await test("response completion: a watch opened after a REPL turn folds it in from the start, for the latest and earlier responses", () => fixture(async f => {
		const html = await f.page();
		assert.match(html, /<p>Next answer<\/p>/);
		assert.doesNotMatch(html, /REPL ·/, "The latest turn ran no REPL code.");
		const { revisions } = await f.state();
		const earlier = await (await fetch(new URL(`/?revision=${revisions.at(-2)}`, f.url), { headers: { cookie: f.cookie } })).text();
		assert.match(earlier, /<p>Pi is about 3\.14\.<\/p>[^]*<summary>REPL · Python · 1 submission in this turn<\/summary>/);
	}, "--watch --working", f => { replTurn(f); f.prompt("Next"); f.manager.appendMessage(assistant("Next answer")); }));

	await test("response completion: timestamp-only event matches the exact persisted response", () => fixture(async f => {
		f.prompt("No provider response id"); const message = assistant("Timestamp-only answer"); delete message.responseId;
		f.manager.appendMessage(message);
		await f.emit("agent_end", [message]); await f.rendered("Timestamp-only answer"); await f.linked("Timestamp-only answer");
	}));

	await test("response completion: browser returns from followed Working to the fallback's Preview", async t => {
		if (!process.env.PUPPETEER_EXECUTABLE_PATH) { t.skip("Set PUPPETEER_EXECUTABLE_PATH to a dedicated headless browser"); return; }
		const { default: puppeteer } = await import("puppeteer-core");
		const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
		try {
			await fixture(async f => {
				const page = await browser.newPage(); const errors = [];
				page.on("pageerror", error => errors.push(error.message));
				await page.setViewport({ width: 900, height: 800 });
				await page.goto(f.url);
				await page.click('[data-watch-control="follow-activity"]');
				f.prompt("Browser return");
				await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Working · live", { timeout: 15_000 });
				const message = assistant("Completed browser answer"); f.manager.appendMessage(message);
				await f.emit("agent_end", [message]); await f.rendered("Completed browser answer"); await f.linked("Completed browser answer");
				await page.waitForFunction(() => location.pathname === "/" && document.body.textContent.includes("Completed browser answer"), { timeout: 15_000 });
				assert.equal(await page.$eval('[data-watch-control="preview"]', e => e.getAttribute("aria-current")), "page");
				assert.equal(await page.$eval('[data-watch-control="follow-activity"]', e => e.getAttribute("aria-pressed")), "true");
				assert.deepEqual(errors, []);
				await page.close();
			});
		} finally { await browser.close(); }
	});
} finally {
	await preview?.closeSharedPreviewBrowser();
	await rm(modulePath, { force: true }); await rm(root, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
