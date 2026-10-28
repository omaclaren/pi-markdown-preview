import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReplRecord, replEntryVersion, ReplRecordError, validateReplRecord } from "../shared/repl-record-reader.js";
import { createReplLiveSource, inspectReplSession, replWindow, REPL_FIELD_DISPLAY_CHARS } from "../shared/repl-live.js";
import { buildReplSessionPage, renderReplEntryCard } from "../shared/turn-details-page.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const ID = "0123456789abcdef0123456789abcdef";
const PIN = { sessionName: "pi-repl-python", tmuxSessionId: "$3", tmuxSessionCreatedAt: 1793150000 };
const entry = (n, fields = {}) => ({ id: `e${n}`, requestId: "", createdAt: 1_700_000_000_000 + n, updatedAt: 1_700_000_000_000 + n, completedAt: null, sessionName: PIN.sessionName, runtime: "python",
	origin: "pi-repl", label: "Claude Code", mode: "raw", prose: "", code: `print(${n})`, output: `${n}\n`, status: "captured", skippedChunks: 0, codeOmittedChars: 0, proseOmittedChars: 0, outputOmittedChars: 0, ...fields });
const record = (entries = [entry(1)], fields = {}) => ({ protocol: "pi-repl-session-record", version: 1, recordId: ID, session: { ...PIN, runtime: "python" }, revision: entries.length,
	createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100, clearedAt: null, droppedEntries: 0, entries, ...fields });
// A private record root as pi-repl makes it: a 0700 directory holding a 0600 file.
async function fixture(t, value = record()) {
	const base = await mkdtemp(join(tmpdir(), "repl-page-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "records");
	await mkdir(root, { mode: 0o700 });
	await chmod(root, 0o700);
	const file = join(root, `${ID}.json`);
	await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
	await chmod(file, 0o600);
	return { base, root, file };
}
const refusal = async (promise, code) => { await assert.rejects(promise, error => error instanceof ReplRecordError && error.code === code, code); };
const listing = async dir => JSON.stringify(await Promise.all((await readdir(dir)).sort().map(async name => [name, (await stat(join(dir, name))).mtimeMs])));

test("REPL record reader: reads pi-repl's record, pinned to the session lifetime", async t => {
	const { root } = await fixture(t);
	const { record: read, stamp } = await readReplRecord(ID, PIN, { root });
	assert.equal(read.entries[0].code, "print(1)");
	assert.match(stamp, /^\d+:\d+:\d+:/);
	await refusal(readReplRecord(ID, { ...PIN, tmuxSessionId: "$4" }, { root }), "mismatch");
	await refusal(readReplRecord(ID, { ...PIN, tmuxSessionCreatedAt: PIN.tmuxSessionCreatedAt + 1 }, { root }), "mismatch");
	await refusal(readReplRecord("f".repeat(32), PIN, { root }), "missing");
	await refusal(readReplRecord("../etc", PIN, { root }), "malformed");
});

test("REPL record reader: refuses unsafe files and directories, and writes nothing when it does", async t => {
	const { base, root, file } = await fixture(t);
	const before = await listing(root);
	await chmod(file, 0o644);
	await refusal(readReplRecord(ID, PIN, { root }), "unsafe");
	await chmod(file, 0o600);
	await chmod(root, 0o755);
	await refusal(readReplRecord(ID, PIN, { root }), "unsafe");
	await chmod(root, 0o700);
	assert.equal(await listing(root), before, "Refusals change nothing");
	assert.equal((await stat(root)).mode & 0o777, 0o700, "and repair nothing");
	// A hard link, a symbolic link to the record, and a symlinked root.
	await link(file, join(base, "second-name.json"));
	await refusal(readReplRecord(ID, PIN, { root }), "unsafe");
	await rm(join(base, "second-name.json"));
	await rename(file, join(base, "elsewhere.json"));
	await symlink(join(base, "elsewhere.json"), file);
	await refusal(readReplRecord(ID, PIN, { root }), "unsafe");
	await rm(file);
	await rename(join(base, "elsewhere.json"), file);
	await symlink(root, join(base, "linked-root"));
	await refusal(readReplRecord(ID, PIN, { root: join(base, "linked-root") }), "unsafe");
	// A FIFO in the record's place must not block the reader.
	await rename(file, join(base, "kept.json"));
	execFileSync("mkfifo", ["-m", "600", file]);
	await refusal(readReplRecord(ID, PIN, { root }), "unsafe");
	await rm(file);
	await rename(join(base, "kept.json"), file);
	await refusal(readReplRecord(ID, PIN, { root, maxBytes: 100 }), "oversize");
	assert.ok((await readReplRecord(ID, PIN, { root })).record);
});

test("REPL record reader: a swap of the file or its directory between checks discards the read", async t => {
	const { base, root, file } = await fixture(t);
	await writeFile(join(base, "other.json"), JSON.stringify(record([entry(9)])), { mode: 0o600 });
	await refusal(readReplRecord(ID, PIN, { root, afterOpen: () => rename(join(base, "other.json"), file) }), "swapped");
	const swapped = join(base, "records-swapped");
	await mkdir(swapped, { mode: 0o700 });
	await chmod(swapped, 0o700);
	await writeFile(join(swapped, `${ID}.json`), JSON.stringify(record()), { mode: 0o600 });
	await refusal(readReplRecord(ID, PIN, { root, afterOpen: async () => { await rename(root, join(base, "records-old")); await rename(swapped, root); } }), "swapped");
});

test("REPL record reader: validates strictly, without the writer's corrections", async t => {
	const bad = [
		["malformed", "{not json"],
		["unsupported", record([], { version: 2 })],
		["malformed", record([], { recordId: "f".repeat(32) })],
		["malformed", record([entry(1), entry(1)])],
		["malformed", record([entry(1, { status: "done" })])],
		["malformed", record([entry(1, { origin: "someone" })])],
		["malformed", record([entry(1, { output: "x".repeat(200_001) })])],
		["malformed", record([entry(1, { label: "two\nlines" })])],
		["malformed", record([entry(1, { createdAt: -1 })])],
		["malformed", record(Array.from({ length: 301 }, (_, i) => entry(i)))],
	];
	for (const [code, value] of bad) {
		const { root } = await fixture(t, value);
		await refusal(readReplRecord(ID, PIN, { root }), code);
	}
	// Fields a writer may leave out are optional; unknown ones are ignored.
	const { prose, requestId, ...lean } = entry(1);
	assert.ok(validateReplRecord(record([{ ...lean, future: true }]), ID, PIN));
});

test("REPL entry version: covers what the card shows, so a same-millisecond update isn't missed (D1)", () => {
	const sending = entry(1, { status: "sending", output: "" });
	const captured = { ...sending, status: "captured", output: "1\n" };
	assert.equal(sending.updatedAt, captured.updatedAt);
	assert.notEqual(replEntryVersion(sending), replEntryVersion(captured));
	assert.equal(replEntryVersion(captured), replEntryVersion({ ...captured, updatedAt: captured.updatedAt + 5 }), "A time the card doesn't show doesn't change it.");
});

// A scripted tmux: each call returns the next answer for its command.
const tmux = answers => {
	const calls = [];
	const run = async args => { calls.push(args); const next = answers[args[0]]; return typeof next === "function" ? next(args) : next ?? { code: 1, stdout: "", stderr: "can't find session: x" }; };
	return { run, calls };
};
const panes = (rows) => ({ code: 0, stdout: rows.map(row => row.join("|")).join("\n") + "\n", stderr: "" });

test("REPL sessions: read from tmux as pi-repl does, and only tmux's own messages mean absent", async () => {
	assert.deepEqual(await inspectReplSession("pi-repl-python", tmux({ "list-panes": { code: 1, stderr: "no server running on /tmp/tmux-1/default" }, "has-session": { code: 1, stderr: "no server running on /tmp/tmux-1/default" } }).run), { state: "absent" });
	assert.deepEqual(await inspectReplSession("pi-repl-python", tmux({ "list-panes": { code: 1, stderr: "can't find window: pi-repl-python" }, "has-session": { code: 1, stderr: "can't find session: pi-repl-python" } }).run), { state: "absent" });
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": { code: -1, stderr: "", timedOut: true } }).run)).state, "unchecked", "A timeout isn't absence.");
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": { code: 1, stderr: "permission denied" }, "has-session": { code: 1, stderr: "permission denied" } }).run)).state, "unchecked");
	// The first pane by window and pane index, whatever order tmux lists them in.
	const seen = await inspectReplSession("pi-repl-python", tmux({ "list-panes": panes([["$3", "1793150000", "1", "0", "%9", "0", ID, "1"], ["$3", "1793150000", "0", "1", "%5", "1", ID, "1"], ["$3", "1793150000", "0", "0", "%2", "0", ID, "1"]]) }).run);
	assert.deepEqual(seen, { state: "running", tmuxSessionId: "$3", tmuxSessionCreatedAt: 1793150000, paneId: "%2", recordId: ID, recordVersion: "1" });
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "1", "", ""]]) }).run)).state, "runtime-ended");
	const { run, calls } = tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "0", "", ""]]) });
	assert.equal((await inspectReplSession("pi-repl-python", run)).recordId, undefined);
	assert.ok(calls.every(args => ["list-panes", "has-session"].includes(args[0])), "Only read-only commands, never set-option or send-keys.");
});

// A source over a scripted tmux and an in-memory record, with a settable clock.
function source(overrides = {}) {
	let clock = 1_000_000, current = record([entry(1)]), identity = ["$3", String(PIN.tmuxSessionCreatedAt)], alive = true;
	const reads = [], stats = [];
	const run = async args => {
		if (args[0] === "list-panes") {
			if (!alive || args[3] !== "=pi-repl-python") return { code: 1, stdout: "", stderr: `can't find window: ${args[3].slice(1)}` };
			return panes([[...identity, "0", "0", "%1", "0", ID, "1"]]);
		}
		return { code: 1, stdout: "", stderr: `can't find session: ${args[2].slice(1)}` };
	};
	const live = createReplLiveSource({ run, now: () => clock, root: "/unused",
		statRecord: async () => { stats.push(clock); return `stamp-${JSON.stringify(current).length}-${current.revision}`; },
		readRecord: async (id, pin) => { reads.push(clock); return { record: validateReplRecord(structuredClone(current), id, pin), stamp: `stamp-${JSON.stringify(current).length}-${current.revision}` }; }, ...overrides });
	return { live, reads, stats, tick: ms => { clock += ms; }, set: value => { current = value; }, replace: () => { identity = ["$8", "1793159999"]; }, end: () => { alive = false; } };
}

test("REPL source: lists the shared sessions, pins one lifetime, and sends its window only when it changed", async () => {
	const s = source();
	const list = await s.live.list();
	assert.equal(list.sessions.length, 11);
	assert.deepEqual(list.sessions.filter(x => x.state !== "absent").map(x => [x.sessionName, x.state, x.record]), [["pi-repl-python", "running", "v1"]]);
	assert.equal((await s.live.pinSession("pi-repl-julia")).error, "absent");
	assert.equal((await s.live.pinSession("not-a-session")).error, "unknown");
	const { pinId } = await s.live.pinSession("pi-repl-python");
	const first = await s.live.view(pinId, "");
	assert.equal(first.state, "running");
	assert.deepEqual(first.entries.map(e => e.code), ["print(1)"]);
	assert.equal((await s.live.view(pinId, first.version)).unchanged, true, "Nothing changed, nothing sent.");
	// Same update time, new status and output (D1): the window changes.
	s.set(record([entry(1), entry(2, { status: "sending", output: "" })]));
	s.tick(1_100);
	const second = await s.live.view(pinId, first.version);
	assert.notEqual(second.version, first.version);
	s.set(record([entry(1), entry(2)]));
	s.tick(1_100);
	const third = await s.live.view(pinId, second.version);
	assert.equal(third.entries[1].status, "captured");
	assert.notEqual(third.entries[1].version, second.entries[1].version);
	assert.equal((await s.live.pinSession("pi-repl-python")).pinId, pinId, "The same lifetime keeps its pin.");
	assert.equal((await s.live.view("nope", "")).gone, true);
});

test("REPL source: bounded work, shared by viewers and driven by them", async () => {
	const s = source();
	const { pinId } = await s.live.pinSession("pi-repl-python");
	await s.live.view(pinId, "");
	const [stats, reads] = [s.stats.length, s.reads.length];
	await Promise.all([s.live.view(pinId, ""), s.live.view(pinId, ""), s.live.view(pinId, "")]);
	assert.equal(s.stats.length, stats, "No more than one stat a second, however many viewers.");
	s.tick(1_100);
	await s.live.view(pinId, "");
	assert.equal(s.stats.length, stats + 1);
	assert.equal(s.reads.length, reads, "An unchanged stamp isn't read again…");
	s.tick(30_000);
	await s.live.view(pinId, "");
	assert.equal(s.reads.length, reads + 1, "…until 30 seconds have passed.");
	s.tick(61_000);
	s.replace();
	await s.live.pinSession("pi-repl-python");
	assert.equal((await s.live.view(pinId, "")).gone, true, "A pin nobody watched for a minute is dropped.");
});

test("REPL source: a replaced or ended session stays on its own lifetime and stops reading", async () => {
	const s = source();
	const { pinId } = await s.live.pinSession("pi-repl-python");
	await s.live.view(pinId, "");
	s.replace();
	s.tick(5_100);
	const replaced = await s.live.view(pinId, "");
	assert.equal(replaced.state, "replaced");
	assert.equal(replaced.ended, true);
	const reads = s.reads.length;
	s.tick(60_000 - 1);
	await s.live.view(pinId, "");
	assert.equal(s.reads.length, reads, "An ended view reads nothing more.");
	const fresh = await s.live.pinSession("pi-repl-python");
	assert.notEqual(fresh.pinId, pinId, "The new lifetime gets its own pin.");
	const t = source();
	const pinned = await t.live.pinSession("pi-repl-python");
	await t.live.view(pinned.pinId, "");
	t.end();
	t.tick(5_100);
	assert.equal((await t.live.view(pinned.pinId, "")).state, "ended");
});

test("REPL window: the latest 50 entries, each field and the whole response bounded", () => {
	const many = record(Array.from({ length: 80 }, (_, i) => entry(i)));
	const window = replWindow(many);
	assert.equal(window.entries.length, 50);
	assert.equal(window.entries[0].id, "e30");
	assert.equal(window.notShown, 30);
	const big = replWindow(record([entry(1, { output: "y".repeat(150_000) })]));
	assert.equal(big.entries[0].output.length, REPL_FIELD_DISPLAY_CHARS);
	assert.equal(big.entries[0].displayOmitted.output, 150_000 - REPL_FIELD_DISPLAY_CHARS);
	const heavy = replWindow(record(Array.from({ length: 50 }, (_, i) => entry(i, { output: "z".repeat(150_000), code: "c".repeat(150_000) }))));
	assert.ok(heavy.entries.length < 50 && heavy.entries.at(-1).id === "e49", "Newest entries are kept when the byte budget runs out.");
});

test("REPL page: record text stays inert, and the page says what it shows", () => {
	const card = renderReplEntryCard({ ...entry(1, { code: "<script>alert(1)</script>", output: "<b>bold</b>", label: "Claude <Code>", status: "timeout" }), version: "v" }, 1, "Python");
	assert.doesNotMatch(card, /<script>|<b>bold|<Code>/);
	assert.match(card, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(card, /title="The sender stopped waiting; the code may have kept running\."/);
	const long = renderReplEntryCard({ ...entry(1, { output: Array(60).fill("line").join("\n") }), version: "v" }, 1, "Python");
	assert.match(long, /<details class="repl-output"><summary>Output · 60 lines<\/summary>/);
	const page = buildReplSessionPage({ sessionName: "pi-repl-python", label: "Python", state: "running", record: "v1", checkedAt: 1, readAt: 1, now: 2, version: "g:1", entries: [] }, { updatesHref: "/u", sessionsHref: "/s" });
	assert.match(page, /Recent recorded submissions/);
	assert.match(page, /Code typed directly into the terminal isn&#39;t recorded here\./);
	assert.match(page, /No submissions recorded yet\./);
});

test("REPL page in the watcher: only with the option, behind the cookie, linked from Preview", async t => {
	const dir = await mkdtemp(join(tmpdir(), "repl-page-server-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const html = "<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>";
	const plain = await createBrowserWatchServer(html, dir, {});
	t.after(() => plain.close());
	const plainPage = await (await fetch(plain.url)).text();
	assert.doesNotMatch(plainPage, /data-watch-control="repl"/, "No REPL link without the option.");
	const s = source();
	const server = await createBrowserWatchServer(html, dir, { repl: s.live });
	t.after(() => server.close());
	const first = await fetch(server.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const page = await first.text();
	const replHref = page.match(/data-watch-control="repl" href="([^"]+)"/)[1].replaceAll("&amp;", "&");
	const get = (path, headers = { cookie }) => fetch(new URL(path, server.url), { headers, redirect: "manual" });
	assert.equal((await get(replHref, {})).status, 403, "The REPL page needs the watcher's cookie.");
	const sessions = await (await get(replHref)).text();
	assert.match(sessions, /<h1>REPL sessions<\/h1>/);
	assert.match(sessions, /data-watch-control="repl" href="[^"]+" aria-current="page"/);
	const sessionHref = sessions.match(/<a href="([^"]*pi-repl-python[^"]*)">Python<\/a>/)[1].replaceAll("&amp;", "&");
	const redirect = await get(sessionHref);
	assert.equal(redirect.status, 302);
	const pinPage = await (await get(redirect.headers.get("location"))).text();
	assert.match(pinPage, /<h1>REPL · Python<\/h1>/);
	assert.match(pinPage, /print\(1\)/);
	const updatesHref = pinPage.match(/data-repl-updates="([^"]+)"/)[1].replaceAll("&amp;", "&");
	const version = pinPage.match(/data-repl-version="([^"]+)"/)[1];
	const unchanged = await (await get(`${updatesHref}&version=${encodeURIComponent(version)}`)).json();
	assert.equal(unchanged.unchanged, true);
	assert.equal(unchanged.cards, undefined);
	s.set(record([entry(1), entry(2)]));
	s.tick(1_100);
	const changed = await (await get(`${updatesHref}&version=${encodeURIComponent(version)}`)).json();
	assert.deepEqual(changed.ids, ["e1", "e2"]);
	assert.match(changed.cards[1].html, /print\(2\)/);
	assert.equal((await get(updatesHref.replace(/instance=[^&]+/, "instance=old"))).status, 409, "A link from an earlier run is refused.");
	assert.equal((await get(`${replHref.split("?")[0]}pi-repl-julia?${replHref.split("?")[1]}`)).status, 404, "A session that isn't running.");
	const noRepl = await fetch(new URL(replHref, plain.url), { headers: { cookie: (await fetch(plain.url)).headers.get("set-cookie").split(";")[0] } });
	assert.equal(noRepl.status, 404, "A watcher without the option has no REPL page.");
});

test("REPL page in a browser: new entries arrive, and a changed entry updates in place", { skip: !process.env.PUPPETEER_EXECUTABLE_PATH && "no test browser", timeout: 60_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "repl-page-browser-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const s = source();
	s.set(record([entry(1, { status: "sending", output: "" })]));
	const server = await createBrowserWatchServer("<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>", dir, { repl: s.live });
	t.after(() => server.close());
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(server.url);
	const replHref = await page.$eval('[data-watch-control="repl"]', a => a.href);
	await page.goto(replHref.replace("/__pi_markdown_preview_repl__/?", "/__pi_markdown_preview_repl__/pi-repl-python?"));
	await page.waitForSelector(".repl-entry");
	assert.match(await page.$eval(".repl-entry", card => card.textContent), /No output recorded yet/);
	await page.$eval(".repl-entry", card => { card.querySelector("summary").dataset.marker = "kept"; });
	// The entry settles (same id, same update time) and a second one arrives.
	s.set(record([entry(1), entry(2, { code: "print('second')", output: "second\n" })]));
	s.tick(1_100);
	await page.waitForFunction(() => document.querySelectorAll(".repl-entry").length === 2, { timeout: 10_000 });
	const cards = await page.$$eval(".repl-entry", list => list.map(card => ({ id: card.dataset.entryId, open: card.open, text: card.textContent, marker: card.querySelector("summary")?.dataset.marker ?? null })));
	assert.deepEqual(cards.map(card => card.id), ["e1", "e2"]);
	assert.match(cards[0].text, /captured/);
	assert.doesNotMatch(cards[0].text, /No output recorded yet/);
	assert.equal(cards[0].open, true, "The card is updated in place: still open.");
	assert.match(cards[1].text, /print\('second'\)[^]*second/);
	assert.match(await page.$eval(".repl-session-status", el => el.textContent), /Session checked .*record read/);
});
