import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReplRecord, replEntryVersion, ReplRecordError, validateReplRecord } from "../shared/repl-record-reader.js";
import { createReplLiveSource, inspectReplSession, replWindow, REPL_FIELD_DISPLAY_CHARS } from "../shared/repl-live.js";
import { createReplHighlighter } from "../shared/repl-highlight.js";
import { buildReplSessionPage, renderReplEntryCard, replEntryCards, REPL_RESPONSE_BYTES } from "../shared/turn-details-page.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const ID = "0123456789abcdef0123456789abcdef";
const spawnPandoc = () => spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;
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
		// What pi-repl's writer guarantees (R15): the session's runtime, the entry's session, ordered times, its bounds.
		["malformed", record([entry(1)], { session: { ...PIN, runtime: "julia" } })],
		["malformed", record([entry(1, { sessionName: "pi-repl-julia" })])],
		["malformed", record([entry(1, { updatedAt: 1_700_000_000_000 })])],
		["malformed", record([entry(1, { completedAt: 1_700_000_000_000 })])],
		["malformed", record([entry(1, { skippedChunks: 100_001 })])],
		["malformed", record([entry(1, { label: "" })])],
		["malformed", record([entry(1, { requestId: "a\nb" })])],
		["malformed", record([entry(1, { runtime: "Python" })])],
		["malformed", record([entry(1)], { updatedAt: 1_600_000_000_000 })],
	];
	for (const [code, value] of bad) {
		const { root } = await fixture(t, value);
		await refusal(readReplRecord(ID, PIN, { root }), code);
	}
	// Fields a writer may leave out are optional; unknown ones are ignored.
	const { prose, requestId, ...lean } = entry(1);
	assert.ok(validateReplRecord(record([{ ...lean, future: true }]), ID, PIN));
	// Python and IPython share pi-repl-python; tmux may not have said which runtime it runs.
	for (const runtime of ["ipython", "unknown"]) assert.ok(validateReplRecord(record([entry(1)], { session: { ...PIN, runtime } }), ID, PIN), runtime);
	assert.ok(validateReplRecord(record([entry(1, { sessionName: "", skippedChunks: 100_000, completedAt: 1_700_000_000_005 })]), ID, PIN), "An older entry without a session, and the writer's own bounds.");
});

test("REPL record reader: a file replaced after it was read, or a read past its deadline, gives nothing", async t => {
	const { base, root, file } = await fixture(t);
	await writeFile(join(base, "other.json"), JSON.stringify(record([entry(9)])), { mode: 0o600 });
	await refusal(readReplRecord(ID, PIN, { root, afterRead: () => rename(join(base, "other.json"), file) }), "swapped");
	const controller = new AbortController();
	await assert.rejects(readReplRecord(ID, PIN, { root, signal: controller.signal, afterOpen: async () => controller.abort() }), error => error.name === "AbortError");
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
	let clock = 1_000_000, current = record([entry(1)]), identity = ["$3", String(PIN.tmuxSessionCreatedAt)], alive = true, recordId = overrides.noRecord ? "" : ID, recordVersion = overrides.recordVersion ?? "1";
	const reads = [], stats = [];
	const run = async args => {
		if (args[0] === "list-panes") {
			if (!alive || args[3] !== "=pi-repl-python") return { code: 1, stdout: "", stderr: `can't find window: ${args[3].slice(1)}` };
			return panes([[...identity, "0", "0", "%1", "0", recordId, recordId ? recordVersion : ""]]);
		}
		return { code: 1, stdout: "", stderr: `can't find session: ${args[2].slice(1)}` };
	};
	const { noRecord, recordVersion: _, ...rest } = overrides;
	const live = createReplLiveSource({ run, now: () => clock, root: "/unused",
		statRecord: async () => { stats.push(clock); return `stamp-${JSON.stringify(current).length}-${current.revision}`; },
		readRecord: async (id, pin) => { reads.push(clock); return { record: validateReplRecord(structuredClone(current), id, pin), stamp: `stamp-${JSON.stringify(current).length}-${current.revision}` }; }, ...rest });
	return { live, reads, stats, tick: ms => { clock += ms; }, set: value => { current = value; }, replace: () => { identity = ["$8", "1793159999"]; }, end: () => { alive = false; }, record: () => { recordId = ID; }, version: value => { recordVersion = value; } };
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

test("REPL source: a session's first send gives it a record, which the open view adopts", async () => {
	const s = source({ noRecord: true });
	const { pinId } = await s.live.pinSession("pi-repl-python");
	const before = await s.live.view(pinId, "");
	assert.deepEqual([before.state, before.record, before.entries.length], ["running", "none", 0]);
	s.record();
	s.tick(5_100);
	const after = await s.live.view(pinId, before.version);
	assert.deepEqual([after.state, after.record, after.ended], ["running", "v1", false], "Not a replacement: the same lifetime got its record.");
	assert.deepEqual(after.entries.map(e => e.code), ["print(1)"]);
	assert.equal((await s.live.pinSession("pi-repl-python")).pinId, pinId);
});

test("REPL source: a record's version is read afresh at each check, not only with its ID (R10)", async () => {
	// pi-repl sets the record's ID before its version: a view can see the ID alone first.
	const s = source({ recordVersion: "" });
	const { pinId } = await s.live.pinSession("pi-repl-python");
	const staged = await s.live.view(pinId, "");
	assert.deepEqual([staged.record, staged.entries.length, s.reads.length], ["unsupported", 0, 0]);
	s.version("1");
	s.tick(5_100);
	const ready = await s.live.view(pinId, staged.version);
	assert.deepEqual([ready.record, ready.ended, ready.entries.map(e => e.code)], ["v1", false, ["print(1)"]]);
	s.version("2");
	s.tick(5_100);
	const reads = s.reads.length;
	const newer = await s.live.view(pinId, ready.version);
	assert.deepEqual([newer.record, newer.entries.length, newer.ended], ["unsupported", 0, false], "A version this page doesn't read shows nothing from the earlier one…");
	assert.equal(s.reads.length, reads, "…and isn't read.");
	assert.equal((await s.live.pinSession("pi-repl-python")).pinId, pinId, "Still the same lifetime.");
});

test("REPL source: record reads have a deadline, and at most two run at once (R12)", async () => {
	const sessions = ["python", "julia", "r", "ruby", "java"].map(runtime => `pi-repl-${runtime}`);
	const run = async args => args[0] === "list-panes" && sessions.includes(args[3].slice(1))
		? panes([[`$${sessions.indexOf(args[3].slice(1)) + 1}`, "1793150000", "0", "0", "%1", "0", ID, "1"]]) : { code: 1, stdout: "", stderr: "can't find session: x" };
	const hanging = [];
	const live = createReplLiveSource({ run, root: "/unused", readTimeout: 30, statRecord: async () => "stamp",
		readRecord: (id, pin, { signal }) => new Promise((resolve, reject) => hanging.push({ resolve, reject, signal })) });
	const pins = await Promise.all(sessions.map(async name => (await live.pinSession(name)).pinId));
	const views = await Promise.all(pins.map(pinId => live.view(pinId, "")));
	assert.equal(hanging.length, 2, "Two reads admitted…");
	assert.deepEqual(views.map(view => /took too long|being read/.exec(view.readError ?? "")?.[0]), ["took too long", "took too long", "being read", "being read", "being read"], "…each abandoned at its deadline, and the rest told to wait.");
	assert.ok(hanging.every(read => read.signal.aborted), "An abandoned read is told to stop.");
	await live.view(pins[2], "");
	assert.equal(hanging.length, 2, "A read past its deadline still counts until it stops.");
	for (const read of hanging) read.reject(read.signal.reason);
	await new Promise(resolve => setImmediate(resolve));
	await live.view(pins[2], "");
	assert.equal(hanging.length, 3, "Once they stop, another is admitted.");
	for (const read of hanging.slice(2)) read.reject(new Error("done"));
	live.close();
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

test("REPL cards: the newest that fit in 2 MB as sent, numbered from the first shown (R11)", () => {
	// Fifty entries of 20,000 ampersands: about 1 MB of record, five times that escaped.
	const window = replWindow(record(Array.from({ length: 50 }, (_, i) => entry(i, { output: "&".repeat(20_000) }))));
	const { cards, notShown } = replEntryCards({ ...window, label: "Python" }, new Map());
	const bytes = cards.reduce((sum, card) => sum + Buffer.byteLength(JSON.stringify(card.html)), 0);
	assert.ok(bytes <= REPL_RESPONSE_BYTES, `${bytes} bytes`);
	assert.ok(cards.length < 50 && cards.at(-1).id === "e49", "The newest are kept…");
	assert.equal(notShown, 50 - cards.length, "…and the rest are counted.");
	assert.match(cards[0].html, /<span class="number">1<\/span>/);
	// A card too big highlighted is shown plain rather than not at all.
	const one = replEntryCards({ entries: [{ ...entry(1), version: "v", displayOmitted: {} }], label: "Python" }, new Map([["e1", "<b>" + "x".repeat(REPL_RESPONSE_BYTES) + "</b>"]]));
	assert.equal(one.cards.length, 1);
	assert.match(one.cards[0].html, /<pre class="code-input"><code>print\(1\)<\/code><\/pre>/);
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
	assert.doesNotMatch(plainPage, /<a data-watch-control="repl"/, "No REPL link without the option.");
	const s = source();
	const asked = [];
	const server = await createBrowserWatchServer(html, dir, { repl: s.live, replHighlight: async items => { asked.push(...items); return new Map(items.filter(item => item.code === "print(2)").map(item => [item.key, '<div class="sourceCode" id="x"><pre class="sourceCode python"><code class="sourceCode python">HIGHLIGHTED</code></pre></div>'])); } });
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
	assert.equal(unchanged.noticesHtml, undefined, "An unchanged update leaves the page's notices alone (R13).");
	s.set(record([entry(1), entry(2)]));
	s.tick(1_100);
	const changed = await (await get(`${updatesHref}&version=${encodeURIComponent(version)}`)).json();
	assert.deepEqual(changed.ids, ["e1", "e2"]);
	assert.match(changed.cards[1].html, /<div class="repl-code"><div class="sourceCode" id="x">[^]*HIGHLIGHTED/, "Highlighted code replaces the plain block…");
	assert.match(changed.cards[0].html, /<pre class="code-input"><code>print\(1\)<\/code><\/pre>/, "…and code that couldn't be highlighted stays plain.");
	assert.equal(changed.noticesHtml, "", "A changed window brings its notices, here none.");
	assert.deepEqual([...new Set(asked.map(item => item.id))].sort(), ["repl-entry-e1", "repl-entry-e2"], "Highlighted code gets each entry's own IDs (R14).");
	// However the record's text escapes, the update stays within its 2 MB (R11).
	s.set(record(Array.from({ length: 50 }, (_, i) => entry(i, { output: "&".repeat(20_000) }))));
	s.tick(1_100);
	const heavy = await (await get(`${updatesHref}&version=${encodeURIComponent(changed.version)}`)).text();
	assert.ok(Buffer.byteLength(heavy) < REPL_RESPONSE_BYTES + 20_000, `${Buffer.byteLength(heavy)} bytes`);
	assert.match(JSON.parse(heavy).noticesHtml, /older entries aren&#39;t shown here/);
	assert.match(sessions, /aria-keyshortcuts="Alt\+ArrowLeft" aria-disabled="true"/, "No response history on the REPL pages.");
	assert.match(sessions, /Back a page/);
	assert.equal((await get(updatesHref.replace(/instance=[^&]+/, "instance=old"))).status, 409, "A link from an earlier run is refused.");
	// A session that isn't running (such as one a tab was last on, since ended) goes to the list, which says so.
	const notRunning = await get(`${replHref.split("?")[0]}pi-repl-julia?${replHref.split("?")[1]}`);
	assert.equal(notRunning.status, 302);
	assert.match(notRunning.headers.get("location"), /^\/__pi_markdown_preview_repl__\/\?identity=[0-9a-f]+&instance=[^&]+&missing=pi-repl-julia$/);
	assert.match(await (await get(notRunning.headers.get("location"))).text(), /Julia \(pi-repl-julia\) isn&#39;t running now\./);
	assert.doesNotMatch(await (await get(`${replHref}&missing=pi-repl-python`)).text(), /isn&#39;t running now/, "A running session is never called missing.");
	assert.match(sessions, /data-watch-control="repl" href="[^"]+" aria-current="page" title="[^"]*\(Ctrl\+Alt\+R\)" aria-keyshortcuts="Control\+Alt\+R"/);
	assert.match(sessions, /Preview \/ Working \/ REPL/);
	// Copy link on a session's page hands out that session, for a browser without the cookie (R9).
	const query = new URL(replHref, server.url).searchParams;
	const share = path => get(`/__pi_markdown_preview_share__?${path}&identity=${query.get("identity")}`);
	const shared = new URL(await (await share(`view=repl&instance=${query.get("instance")}&session=pi-repl-python`)).text());
	assert.deepEqual([shared.searchParams.get("view"), shared.searchParams.get("session"), shared.searchParams.get("revision")], ["repl", "pi-repl-python", null]);
	const opened = await fetch(shared, { redirect: "manual" });
	assert.equal(opened.status, 302);
	assert.match(opened.headers.get("location"), /^\/__pi_markdown_preview_repl__\/pi-repl-python\?identity=[0-9a-f]+&instance=/);
	const recipient = opened.headers.get("set-cookie").split(";")[0];
	assert.equal((await get(opened.headers.get("location"), { cookie: recipient })).status, 302, "The recipient pins the session's current lifetime.");
	assert.equal((await share(`view=repl&instance=${query.get("instance")}&session=../x`)).status, 404);
	assert.equal((await share(`view=repl&instance=old&session=pi-repl-python`)).status, 404);
	assert.match(sessions, /data-watch-control="preview" href="\/\?identity=[0-9a-f]+"/, "Preview from a REPL page is the latest response.");
	const noRepl = await fetch(new URL(replHref, plain.url), { headers: { cookie: (await fetch(plain.url)).headers.get("set-cookie").split(";")[0] } });
	assert.equal(noRepl.status, 404, "A watcher without the option has no REPL page.");
	// With Live too, Follow activity stays off the REPL pages: it would take the reader to Working (R9).
	const withLive = await createBrowserWatchServer(html, dir, { repl: source().live, live: {} });
	t.after(() => withLive.close());
	const liveFirst = await fetch(withLive.url);
	const liveCookie = liveFirst.headers.get("set-cookie").split(";")[0];
	assert.match(await liveFirst.text(), /<button data-watch-control="follow-activity"/);
	const liveReplHref = (await (await fetch(withLive.url, { headers: { cookie: liveCookie } })).text()).match(/data-watch-control="repl" href="([^"]+)"/)[1].replaceAll("&amp;", "&");
	const liveRepl = await (await fetch(new URL(liveReplHref, withLive.url), { headers: { cookie: liveCookie } })).text();
	assert.doesNotMatch(liveRepl, /<button data-watch-control="follow-activity"|Follow activity on \/ off|With Follow activity on/);
});

test("REPL highlighting: code goes to Pandoc as data, highlighted once and cached", { skip: spawnPandoc() }, async () => {
	let runs = 0;
	const highlight = createReplHighlighter({ run: async (args, input) => { runs++; return (await import("node:child_process")).execFileSync(process.env.PANDOC_PATH || "pandoc", args, { input, encoding: "utf8" }); } });
	const code = 'x = "```"\n# not a heading\n<div id="h1"></div>';
	const first = await highlight([{ key: "a", code }, { key: "b", code: "print(1)" }, { key: "c", code: "" }], "python");
	assert.deepEqual([...first.keys()], ["a", "b"]);
	assert.match(first.get("a"), /^<div class="sourceCode" id="repl-[0-9a-f]+"><pre class="sourceCode python">/);
	assert.doesNotMatch(first.get("a"), /<div id="h1">|<h1/, "Code text is never markup.");
	const before = runs;
	await highlight([{ key: "again", code }], "python");
	assert.equal(runs, before, "A block already highlighted needs no Pandoc run.");
	assert.equal((await highlight([{ key: "z", code: "1" }], "fortran")).size, 0, "An unknown runtime stays plain.");
	const failing = createReplHighlighter({ run: async () => { throw new Error("no pandoc"); } });
	assert.equal((await failing([{ key: "a", code: "1" }], "python")).size, 0, "Without Pandoc, code stays plain.");
});

test("REPL highlighting: one run per block however many ask, one run at a time, IDs per entry (R12, R14)", async () => {
	let runs = 0, active = 0, most = 0;
	const highlight = createReplHighlighter({ run: async (args, input) => {
		if (args.includes("markdown")) return JSON.stringify({ "pandoc-api-version": [1, 22] });
		runs++; active++; most = Math.max(most, active);
		await new Promise(resolve => setTimeout(resolve, 20));
		active--;
		// Stands in for Pandoc: each block's Div, with the CodeBlock's ID on its line anchors.
		return JSON.parse(input).blocks.map(div => { const [[id], [block]] = div.c; const [[blockId]] = block.c; return `<div id="${id}">\n<div class="sourceCode" id="${blockId}"><pre><code><span id="${blockId}-1"><a href="#${blockId}-1"></a>CODE</span></code></pre></div>\n</div>`; }).join("\n");
	} });
	const results = await Promise.all(Array.from({ length: 8 }, (_, i) => highlight([{ key: `k${i}`, code: "print(1)", id: `repl-entry-e${i}` }], "python")));
	assert.equal(runs, 1, "Eight requests for one block share one run.");
	assert.match(results[3].get("k3"), /id="repl-entry-e3"[^]*id="repl-entry-e3-1"><a href="#repl-entry-e3-1"/);
	assert.doesNotMatch(results[3].get("k3"), /repl-[0-9a-f]{20}/, "No ID shared with another entry's copy.");
	await Promise.all([highlight([{ key: "a", code: "1" }], "python"), highlight([{ key: "b", code: "2" }], "python"), highlight([{ key: "c", code: "3" }], "python")]);
	assert.deepEqual([runs, most], [4, 1], "Different blocks wait their turn.");
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
	// Preview → sessions → session in a new tab: Option/Alt+Left steps back through them.
	const tab = await browser.newPage();
	await tab.goto(server.url);
	await Promise.all([tab.waitForNavigation(), tab.click('[data-watch-control="repl"]')]);
	await Promise.all([tab.waitForNavigation(), tab.click(".repl-session-name a")]);
	await tab.waitForSelector(".repl-entry");
	await Promise.all([tab.waitForNavigation(), tab.keyboard.down("Alt").then(() => tab.keyboard.press("ArrowLeft")).then(() => tab.keyboard.up("Alt"))]);
	assert.match(await tab.$eval("h1", h => h.textContent), /REPL sessions/);
	await Promise.all([tab.waitForNavigation(), tab.keyboard.down("Alt").then(() => tab.keyboard.press("ArrowLeft")).then(() => tab.keyboard.up("Alt"))]);
	assert.match(await tab.$eval("#preview-root", root => root.textContent), /Answer/);
	// Opened directly, with no earlier page in the tab: back goes to the sessions list.
	const sessionUrl = replHref.replace("/__pi_markdown_preview_repl__/?", "/__pi_markdown_preview_repl__/pi-repl-python?");
	const fresh = await browser.newPage();
	await fresh.goto(sessionUrl);
	await fresh.waitForSelector(".repl-entry");
	await Promise.all([fresh.waitForNavigation(), fresh.keyboard.down("Alt").then(() => fresh.keyboard.press("ArrowLeft")).then(() => fresh.keyboard.up("Alt"))]);
	assert.match(await fresh.$eval("h1", h => h.textContent), /REPL sessions/);
});

test("REPL page in a browser: notices stay, held numbers settle, Copy link and newer responses (R9, R13, R17)", { skip: !process.env.PUPPETEER_EXECUTABLE_PATH && "no test browser", timeout: 60_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "repl-page-browser-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const s = source();
	s.set(record([entry(1), entry(2), entry(3)], { droppedEntries: 7 }));
	const answer = text => `<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>${text}</p></main></body></html>`;
	const server = await createBrowserWatchServer(answer("Answer"), dir, { repl: s.live });
	t.after(() => server.close());
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(server.url);
	const replHref = await page.$eval('[data-watch-control="repl"]', a => a.href);
	await page.goto(replHref.replace("/__pi_markdown_preview_repl__/?", "/__pi_markdown_preview_repl__/pi-repl-python?"));
	await page.waitForSelector(".repl-entry");
	const notices = () => page.$eval(".repl-window-notices", el => el.hidden ? "" : el.textContent);
	assert.match(await notices(), /7 older entries were dropped/);
	for (let i = 0; i < 2; i++) await page.waitForResponse(response => response.url().includes("/updates"));
	assert.match(await notices(), /7 older entries were dropped/, "Unchanged updates leave the notices (R13).");
	// A held card keeps its number while an earlier one goes, and takes its new one when let go (R17).
	// As a reader's focused window, so that focus and blur fire their events.
	await page.bringToFront();
	await page.emulateFocusedPage(true);
	await page.focus('.repl-entry[data-entry-id="e2"] > summary');
	s.set(record([entry(2), entry(3)], { droppedEntries: 7 }));
	s.tick(1_100);
	await page.waitForFunction(() => !document.querySelector('.repl-entry[data-entry-id="e1"]'), { timeout: 10_000 });
	const numbers = () => page.$$eval(".repl-entry .number", spans => spans.map(span => span.textContent).join(","));
	assert.equal(await numbers(), "2,2");
	await page.evaluate(() => document.activeElement.blur());
	await page.waitForFunction(() => [...document.querySelectorAll(".repl-entry .number")].map(span => span.textContent).join(",") === "1,2", { timeout: 5_000 });
	// Copy link asks for this session's link, never a response's (R9). The clipboard is stubbed.
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
		document.execCommand = () => true;
	});
	const copy = page.waitForResponse(response => new URL(response.url()).pathname === "/__pi_markdown_preview_share__");
	await page.$eval('[data-watch-control="copy-link"]', button => button.click());
	const copied = await copy;
	assert.equal(copied.status(), 200);
	assert.deepEqual(["view", "session", "revision"].map(name => new URL(copied.url()).searchParams.get(name)), ["repl", "pi-repl-python", null]);
	// A newer response: the count follows it, with no New badge or Next link.
	server.updateDocument(answer("Second answer"));
	await page.waitForFunction(() => document.querySelector('[data-watch-control="count"]')?.textContent === "2/2", { timeout: 10_000 });
	assert.deepEqual(await page.evaluate(() => [document.querySelector('[data-watch-control="new"]').hidden, document.querySelector('[data-watch-control="next"]').getAttribute("aria-disabled")]), [true, "true"]);
});

test("REPL page in a browser: the REPL link and Ctrl+Alt+R return to the REPL page this tab was last on", { skip: !process.env.PUPPETEER_EXECUTABLE_PATH && "no test browser", timeout: 60_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "repl-page-browser-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const s = source();
	const server = await createBrowserWatchServer("<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>", dir, { repl: s.live });
	t.after(() => server.close());
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	const heading = () => page.$eval("h1", h => h.textContent);
	const go = action => Promise.all([page.waitForNavigation(), action()]);
	const keys = key => go(async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press(key); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); });
	await page.goto(server.url);
	await go(() => page.click('[data-watch-control="repl"]'));
	await go(() => page.click(".repl-session-name a"));
	assert.equal(await heading(), "REPL · Python");
	// To Preview and back: the REPL link goes straight to the session.
	await go(() => page.click('[data-watch-control="preview"]'));
	assert.match(await page.$eval('[data-watch-control="repl"]', a => a.getAttribute("href")), /\/__pi_markdown_preview_repl__\/pi-repl-python\?/);
	await go(() => page.click('[data-watch-control="repl"]'));
	assert.equal(await heading(), "REPL · Python");
	// And from the keyboard.
	await keys("KeyP");
	assert.match(await page.$eval("#preview-root", root => root.textContent), /Answer/);
	await keys("KeyR");
	assert.equal(await heading(), "REPL · Python");
	// Left on the list, the tab returns to the list.
	await go(() => page.click("main > nav a"));
	assert.equal(await heading(), "REPL sessions");
	await keys("KeyP");
	await keys("KeyR");
	assert.equal(await heading(), "REPL sessions");
	// A session the tab was on that has since ended: the list, saying so.
	await go(() => page.click(".repl-session-name a"));
	await keys("KeyP");
	s.end();
	s.tick(5_100);
	await keys("KeyR");
	assert.equal(await heading(), "REPL sessions");
	assert.match(await page.$eval("main", main => main.textContent), /Python \(pi-repl-python\) isn't running now\./);
});
