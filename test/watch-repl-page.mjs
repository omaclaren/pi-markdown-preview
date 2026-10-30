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
import { replFilePaths, resolveReplFiles, REPL_FILES_PER_ENTRY } from "../shared/repl-files.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";

const ID = "0123456789abcdef0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
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
	assert.ok(validateReplRecord(record([entry(1)], { updatedAt: 1_600_000_000_000 }), ID, PIN), "After a clock change the writer can give the record an update time before its creation (R21).");
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
	assert.deepEqual(seen, { state: "running", tmuxSessionId: "$3", tmuxSessionCreatedAt: 1793150000, paneId: "%2", cwd: undefined, recordId: ID, recordVersion: "1" });
	// The working directory comes last, whole, even with a "|" in it; only an absolute one counts.
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "0", ID, "1", "/work/a|b"]]) }).run)).cwd, "/work/a|b");
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "0", ID, "1", "relative"]]) }).run)).cwd, undefined);
	assert.equal((await inspectReplSession("pi-repl-python", tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "1", "", ""]]) }).run)).state, "runtime-ended");
	const { run, calls } = tmux({ "list-panes": panes([["$3", "1793150000", "0", "0", "%2", "0", "", ""]]) });
	assert.equal((await inspectReplSession("pi-repl-python", run)).recordId, undefined);
	assert.ok(calls.every(args => ["list-panes", "has-session"].includes(args[0])), "Only read-only commands, never set-option or send-keys.");
});

// A source over a scripted tmux and an in-memory record, with a settable clock.
function source(overrides = {}) {
	let clock = 1_000_000, current = record([entry(1)]), identity = ["$3", String(PIN.tmuxSessionCreatedAt)], alive = true, recordId = overrides.noRecord ? "" : ID, recordVersion = overrides.recordVersion ?? "1", cwd;
	const reads = [], stats = [];
	const run = async args => {
		if (args[0] === "list-panes") {
			if (!alive || args[3] !== "=pi-repl-python") return { code: 1, stdout: "", stderr: `can't find window: ${args[3].slice(1)}` };
			return panes([[...identity, "0", "0", "%1", "0", recordId, recordId ? recordVersion : "", ...(cwd ? [cwd] : [])]]);
		}
		return { code: 1, stdout: "", stderr: `can't find session: ${args[2].slice(1)}` };
	};
	const { noRecord, recordVersion: _, ...rest } = overrides;
	const live = createReplLiveSource({ run, now: () => clock, root: "/unused",
		statRecord: async () => { stats.push(clock); return `stamp-${JSON.stringify(current).length}-${current.revision}`; },
		readRecord: async (id, pin) => { reads.push(clock); return { record: validateReplRecord(structuredClone(current), id, pin), stamp: `stamp-${JSON.stringify(current).length}-${current.revision}` }; }, ...rest });
	return { live, reads, stats, tick: ms => { clock += ms; }, set: value => { current = value; }, replace: () => { identity = ["$8", "1793159999"]; }, end: () => { alive = false; }, record: () => { recordId = ID; }, version: value => { recordVersion = value; }, cwd: value => { cwd = value; } };
}

test("REPL source: lists the shared sessions, pins one lifetime, and sends its window only when it changed", async () => {
	const s = source();
	const list = await s.live.list();
	assert.equal(list.sessions.length, 12);
	assert.deepEqual(list.sessions.at(-1), { sessionName: "pi-repl-lfortran", runtime: "lfortran", label: "LFortran", state: "absent", reason: undefined, record: "none" }, "LFortran's shared session is listed too.");
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

// Several running sessions, each with its own record and version; `readHeld` makes a session's reads wait until released.
function sessions(names) {
	let clock = 1_000_000;
	const state = Object.fromEntries(names.map((name, i) => [name, { version: "1", id: `$${i + 1}`, readHeld: false, reads: 0, waiting: [] }]));
	const run = async args => args[0] === "list-panes" && state[args[3].slice(1)]
		? panes([[state[args[3].slice(1)].id, "1793150000", "0", "0", "%1", "0", ID, state[args[3].slice(1)].version]]) : { code: 1, stdout: "", stderr: "can't find session: x" };
	const held = (s, kind) => new Promise(resolve => s.waiting.push({ kind, resolve }));
	const live = createReplLiveSource({ run, root: "/unused", now: () => clock, readTimeout: 30,
		statRecord: async () => "stamp",
		readRecord: async (id, pin) => {
			const s = state[pin.sessionName];
			s.reads++;
			if (s.readHeld) await held(s, "read");
			const value = record([entry(1, { sessionName: pin.sessionName, runtime: pin.runtime })], { session: { sessionName: pin.sessionName, tmuxSessionId: s.id, tmuxSessionCreatedAt: 1793150000, runtime: pin.runtime } });
			return { record: validateReplRecord(structuredClone(value), id, pin), stamp: "stamp" };
		} });
	return { live, state, tick: ms => { clock += ms; }, release: name => { for (const w of state[name].waiting.splice(0)) w.resolve(); } };
}

test("REPL source: an unreadable record version resets what browsers show, and a read begun before it is discarded (R18)", async () => {
	const names = ["python", "julia", "r", "ruby", "java"].map(runtime => `pi-repl-${runtime}`);
	const s = sessions(names);
	const { pinId } = await s.live.pinSession("pi-repl-python");
	const shown = await s.live.view(pinId, "");
	assert.deepEqual(shown.entries.map(e => e.id), ["e1"]);
	// Four other sessions viewed since: this pin no longer holds its record in memory…
	for (const name of names.slice(1)) { s.tick(10); const other = await s.live.pinSession(name); await s.live.view(other.pinId, ""); }
	s.state["pi-repl-python"].version = "2";
	s.tick(5_100);
	const after = await s.live.view(pinId, shown.version);
	assert.deepEqual([after.unchanged, after.record, after.entries?.length], [undefined, "unsupported", 0], "…but the browser, which still shows its cards, is told to drop them.");
	// A read running when the version changes doesn't land.
	const t = sessions(["pi-repl-python"]);
	const pinned = await t.live.pinSession("pi-repl-python");
	t.state["pi-repl-python"].readHeld = true;
	const viewing = t.live.view(pinned.pinId, "");
	await new Promise(resolve => setImmediate(resolve));
	t.state["pi-repl-python"].version = "2";
	assert.equal((await t.live.pinSession("pi-repl-python")).pinId, pinned.pinId);
	t.release("pi-repl-python");
	const landed = await viewing;
	assert.deepEqual([landed.record, landed.entries.length], ["unsupported", 0]);
	// Nor does its deadline notice (R27).
	const u = sessions(["pi-repl-python"]);
	const again = await u.live.pinSession("pi-repl-python");
	u.state["pi-repl-python"].readHeld = true;
	const slow = u.live.view(again.pinId, "");
	await new Promise(resolve => setImmediate(resolve));
	u.state["pi-repl-python"].version = "2";
	await u.live.pinSession("pi-repl-python");
	const late = await slow;
	assert.deepEqual([late.record, late.readError], ["unsupported", undefined]);
	u.release("pi-repl-python");
});

test("REPL source: a stuck read holds at most one slot, and its session starts no second one (R19)", async () => {
	const s = sessions(["pi-repl-python", "pi-repl-julia"]);
	const python = await s.live.pinSession("pi-repl-python"), julia = await s.live.pinSession("pi-repl-julia");
	s.state["pi-repl-python"].readHeld = true;
	assert.match((await s.live.view(python.pinId, "")).readError, /took too long/);
	s.tick(1_100);
	await s.live.view(python.pinId, "");
	assert.equal(s.state["pi-repl-python"].reads, 1, "No second read of the stuck session…");
	const healthy = await s.live.view(julia.pinId, "");
	assert.deepEqual([healthy.readError, healthy.entries.map(e => e.id)], [undefined, ["e1"]], "…and another session still reads.");
	s.release("pi-repl-python");
	await new Promise(resolve => setImmediate(resolve));
	s.state["pi-repl-python"].readHeld = false;
	s.tick(1_100);
	assert.deepEqual((await s.live.view(python.pinId, "")).entries.map(e => e.id), ["e1"], "Once it stops, the session reads again.");
});

test("REPL source: a stuck read's pin outlasts its viewers, so reopening the session starts no second read (R24)", async () => {
	const s = sessions(["pi-repl-python", "pi-repl-julia", "pi-repl-r"]);
	const python = await s.live.pinSession("pi-repl-python"), julia = await s.live.pinSession("pi-repl-julia");
	s.state["pi-repl-python"].readHeld = true;
	assert.match((await s.live.view(python.pinId, "")).readError, /took too long/);
	// Nobody views Python past the idle period; Julia's view sweeps.
	s.tick(61_000);
	assert.equal((await s.live.view(julia.pinId, "")).readError, undefined);
	const reopened = await s.live.pinSession("pi-repl-python");
	assert.equal(reopened.pinId, python.pinId, "Reopening finds the pin whose read is still running…");
	assert.match((await s.live.view(reopened.pinId, "")).readError, /took too long/);
	assert.equal(s.state["pi-repl-python"].reads, 1, "…and starts no second read of the stuck file…");
	const r = await s.live.pinSession("pi-repl-r");
	assert.deepEqual((await s.live.view(r.pinId, "")).entries.map(e => e.id), ["e1"], "…so another session still has a slot.");
	s.release("pi-repl-python");
	await new Promise(resolve => setImmediate(resolve));
	s.tick(61_000);
	await s.live.view(julia.pinId, "");
	assert.notEqual((await s.live.pinSession("pi-repl-python")).pinId, python.pinId, "Once its read stops, an idle pin goes as usual.");
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
	assert.match(one.cards[0].html, /<pre class="code-input"><code><span>print\(1\)<\/span><\/code><\/pre>/);
});

test("REPL page: record text stays inert, and the page says what it shows", () => {
	const card = renderReplEntryCard({ ...entry(1, { code: "<script>alert(1)</script>", output: "<b>bold</b>", label: "Claude <Code>", status: "timeout" }), version: "v" }, 1, "Python");
	assert.doesNotMatch(card, /<script>|<b>bold|<Code>/);
	assert.match(card, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(card, /title="The sender stopped waiting; the code may have kept running\."/);
	assert.match(renderReplEntryCard({ ...entry(1, { status: "sending", output: "" }), version: "v" }, 1, "Python"),
		/<span class="repl-status repl-status-sending" title="Written before the code was sent; not proof that it&#39;s still running or that its sender is still waiting\.">pending<\/span>/, "A pending entry says what it can't promise.");
	assert.match(renderReplEntryCard({ ...entry(1), version: "v" }, 1, "Python"), /<span class="repl-status repl-status-captured">done<\/span>/, "A captured entry is shown as done.");
	assert.match(renderReplEntryCard({ ...entry(1, { status: "sent", output: "" }), version: "v" }, 1, "LFortran"),
		/<span class="repl-status repl-status-sent" title="Sent, with no result recorded yet; not proof that it&#39;s still running or that its sender is still waiting\.">pending<\/span>[^]*No output recorded yet/, "LFortran's and Studio's sent is pending too.");
	const long = renderReplEntryCard({ ...entry(1, { output: Array(60).fill("line").join("\n") }), version: "v" }, 1, "Python");
	assert.match(long, /<details class="repl-output"><summary>Output · 60 lines<\/summary>/);
	assert.match(long, /<label class="output-wrap"><input type="checkbox" aria-label="Wrap output lines">Wrap lines<\/label>/);
	assert.doesNotMatch(renderReplEntryCard({ ...entry(1, { status: "sending", output: "" }), version: "v" }, 1, "Python"), /output-wrap/, "Nothing to wrap, no Wrap lines.");
	// Each line of code carries its own indent, plain or highlighted, for wrapping.
	const indented = { ...entry(1, { code: `def f():\n\tif x:\n        pass\n${" ".repeat(100)}y` }), version: "v" };
	assert.match(renderReplEntryCard(indented, 1, "Python"), /<code><span>def f\(\):<\/span>\n<span style="--indent:4ch">\tif x:<\/span>\n<span style="--indent:8ch"> {8}pass<\/span>\n<span style="--indent:32ch"> {100}y<\/span><\/code>/);
	const pandoc = '<div class="sourceCode" id="r"><pre class="sourceCode python"><code class="sourceCode python"><span id="r-1"><a href="#r-1"></a>def f():</span>\n<span id="r-2"><a href="#r-2"></a>\tif x:</span>\n<span id="r-3"><a href="#r-3"></a>        pass</span></code></pre></div>';
	assert.match(renderReplEntryCard(indented, 1, "Python", pandoc), /<div class="repl-code"><div class="sourceCode" id="r"><pre class="sourceCode python"><code class="sourceCode python"><span id="r-1"><a href="#r-1"><\/a>def f\(\):<\/span>\n<span id="r-2" style="--indent:4ch"><a href="#r-2"><\/a>\tif x:<\/span>\n<span id="r-3" style="--indent:8ch"><a/);
	const page = buildReplSessionPage({ sessionName: "pi-repl-python", label: "Python", state: "running", record: "v1", checkedAt: 1, readAt: 1, now: 2, version: "g:1", entries: [] }, { updatesHref: "/u", sessionsHref: "/s" });
	assert.match(page, /Recent recorded submissions/);
	assert.match(page, /Code typed directly into the terminal isn&#39;t recorded here\./);
	assert.match(page, /No submissions recorded yet\./);
});

test("REPL page: who sent each entry, an agent by its label and a person by a name a prefix vouches for", () => {
	const who = fields => renderReplEntryCard({ ...entry(1, fields), version: "v" }, 1, "Python").match(/<span class="number">1<\/span> (.*?) · <span class="repl-status/)[1];
	assert.equal(who({ mode: "agent", label: "Claude Code", requestId: "tool:mcp-1" }), "Claude Code");
	assert.equal(who({ mode: "agent", origin: "pi-studio", label: "Pi", requestId: "tool:1" }), "Pi (Pi Studio)", "Agents keep their labels, as before.");
	assert.equal(who({ mode: "raw", label: "/repl send", requestId: "command:send:1" }), "User", "An older person's entry names a command, not a person.");
	assert.equal(who({ mode: "raw", origin: "pi-studio", label: "selection", requestId: "r1" }), "User · via Pi Studio", "Studio's older labels describe the selection.");
	assert.equal(who({ mode: "raw", label: "Sam", requestId: "pi:send:1" }), "Sam · via Pi");
	assert.equal(who({ mode: "raw", label: "Sam", requestId: "cli:env:1" }), "Sam · via terminal");
	assert.equal(who({ mode: "literate", origin: "pi-studio", label: "Ana", requestId: "studio:note:1" }), "Ana · via Pi Studio");
	assert.equal(who({ mode: "raw", origin: "pi-studio", label: "Ana", requestId: "studio:send:1" }), "Ana · via Pi Studio");
	assert.equal(who({ mode: "raw", label: "Ana", requestId: "studio:send:1" }), "User", "A prefix from another client's route vouches for nothing.");
	assert.equal(who({ mode: "raw", label: "Sam" }), "User");
	assert.equal(who({ mode: "raw", label: "<b>Sam</b>", requestId: "cli:send:1" }), "&lt;b&gt;Sam&lt;/b&gt; · via terminal");
	assert.notEqual(replEntryVersion({ ...entry(1), requestId: "command:send:1" }), replEntryVersion({ ...entry(1), requestId: "cli:send:1" }), "A change of route changes the card.");
});

test("REPL files: image and PDF paths an entry names, resolved against the session's directory, only if they're files", async t => {
	assert.deepEqual(replFilePaths({ code: `plt.savefig("out/fit.png")\npng('plot.PNG'); x = "notes.txt"`, output: "Saved to /tmp/ab/c.png and ~/figs/d.pdf.\nalso out/fit.png" }),
		["/tmp/ab/c.png", "~/figs/d.pdf", "out/fit.png", "plot.PNG"], "Output first; quoted and bare; a full stop isn't part of a path; repeats once; other files never.");
	assert.deepEqual(replFilePaths({ code: `f = "a.png.bak"; g = 'x.svg'`, output: "" }), ["x.svg"]);
	const dir = await mkdtemp(join(tmpdir(), "repl-files-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "out"));
	await writeFile(join(dir, "out", "fit.png"), PNG);
	await mkdir(join(dir, "folder.png"));
	const entries = [{ id: "e1", code: `savefig("out/fit.png"); savefig("missing.png"); savefig("folder.png"); savefig("${join(dir, "out", "fit.png")}")`, output: "" }, { id: "e2", code: "x = 1", output: "" }];
	const found = await resolveReplFiles(entries, dir);
	assert.deepEqual([...found.keys()], ["e1"]);
	assert.deepEqual(found.get("e1").map(file => [file.written, file.path, file.contentType]), [["out/fit.png", join(dir, "out", "fit.png"), "image/png"]],
		"Only regular files that exist, each path once, however it was written.");
	assert.equal((await resolveReplFiles(entries, undefined)).get("e1")?.length, 1, "Without a directory, only absolute paths resolve.");
	const many = await resolveReplFiles([{ id: "e", code: Array.from({ length: 10 }, (_, i) => `savefig("out/fit.png?${i}")`).join("\n"), output: Array.from({ length: 10 }, (_, i) => `/f${i}.png`).join("\n") }], dir,
		{ statFile: async () => ({ isFile: () => true, mtimeMs: 1 }) });
	assert.equal(many.get("e").length, REPL_FILES_PER_ENTRY, "A bounded number per entry.");
	const card = renderReplEntryCard({ ...entry(1), version: "v" }, 1, "Python", undefined, [
		{ written: "out/<fit>.png", url: "/__pi_markdown_preview_absolute_image__/abc?v=1", image: true }, { written: "/tmp/<fit>.pdf", url: "/p", image: false }, { written: "reports/2026/q3.pdf", url: "/r", image: false }]);
	assert.match(card, /<h3>Files<\/h3><div class="repl-files"><figure class="repl-file"><a class="repl-file-image" href="\/__pi_markdown_preview_absolute_image__\/abc\?v=1" target="_blank" rel="noopener noreferrer" title="out\/&lt;fit&gt;.png"><img src="\/__pi_markdown_preview_absolute_image__\/abc\?v=1" alt="out\/&lt;fit&gt;.png" loading="lazy"><\/a><figcaption><span title="out\/&lt;fit&gt;.png">&lt;fit&gt;.png<\/span> · <a class="repl-file-alt" href="\/p" target="_blank" rel="noopener noreferrer" title="\/tmp\/&lt;fit&gt;.pdf">PDF<\/a><\/figcaption><\/figure><\/div><div class="repl-file-links"><a class="repl-file-link" href="\/r" target="_blank" rel="noopener noreferrer" title="reports\/2026\/q3.pdf"><span class="repl-file-format">PDF<\/span><span>q3.pdf<\/span><\/a><\/div>/,
		"One figure in two formats is one thumbnail captioned with the other format; a PDF of its own follows, tagged; each labelled with its name, the path as written its tooltip.");
	assert.doesNotMatch(renderReplEntryCard({ ...entry(1), version: "v" }, 1, "Python"), /repl-files/, "No files, no section.");
	const cards = replEntryCards({ label: "Python", entries: [{ ...entry(1), version: "v1" }] }, new Map(), undefined, new Map([["e1", { items: [{ written: "a.png", url: "/a", image: true }], signature: "s1" }]]));
	assert.equal(cards.cards[0].version, "v1.s1", "A card's version covers its files.");
	assert.match(cards.cards[0].html, /data-entry-version="v1\.s1"/);
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
	assert.match(changed.cards[0].html, /<pre class="code-input"><code><span>print\(1\)<\/span><\/code><\/pre>/, "…and code that couldn't be highlighted stays plain.");
	assert.equal(changed.noticesHtml, "", "A changed window brings its notices, here none.");
	const ids = [...new Set(asked.map(item => item.id))];
	assert.ok(ids.length === 2 && ids.every(id => /^repl-entry-[0-9a-f]{16}$/.test(id)), "Highlighted code gets each entry's own IDs, of fixed width (R14, R22)…");
	s.set(record([entry(1), entry(2, { id: "e1-1" })]));
	s.tick(1_100);
	asked.length = 0;
	await get(`${updatesHref}&version=${encodeURIComponent(version)}`);
	const [plainId, suffixedId] = asked.map(item => item.id);
	assert.ok(plainId !== suffixedId && !suffixedId.startsWith(`${plainId}-`), "…so entry e1's line IDs can't be entry e1-1's.");
	// However the record's text escapes, and however long its IDs, the update stays within 2 MB (R11, R23).
	let heavy;
	for (const entries of [Array.from({ length: 50 }, (_, i) => entry(i, { output: "&".repeat(20_000) })), Array.from({ length: 20 }, (_, i) => entry(i, { id: `${"x".repeat(236)}-${String(i).padStart(2, "0")}`, output: "&".repeat(19_913) }))]) {
		s.set(record(entries));
		s.tick(1_100);
		heavy = await (await get(`${updatesHref}&version=`)).text();
		assert.ok(Buffer.byteLength(heavy) <= REPL_RESPONSE_BYTES, `${Buffer.byteLength(heavy)} bytes`);
	}
	assert.match(JSON.parse(heavy).noticesHtml, /older entr(y isn|ies aren)&#39;t shown here/);
	assert.match(sessions, /aria-keyshortcuts="Alt\+ArrowLeft" aria-disabled="true"/, "No response history on the REPL pages.");
	assert.match(sessions, /Up: REPL sessions, then Preview/);
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
	assert.match((await highlight([{ key: "f", code: "print *, 'hi'" }], "lfortran")).get("f"), /<pre class="sourceCode fortranfree">/, "LFortran's code is free-form Fortran.");
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

test("REPL highlighting: a bounded queue, and runs nobody waits for any more are skipped (R20)", async () => {
	let gate, ran = [];
	const highlight = createReplHighlighter({ run: async (args, input) => {
		if (args.includes("markdown")) return JSON.stringify({ "pandoc-api-version": [1, 22] });
		const blocks = JSON.parse(input).blocks;
		ran.push(blocks[0].c[1][0].c[1]);
		if (ran.length === 1) await new Promise(resolve => { gate = resolve; });
		return blocks.map(div => `<div id="${div.c[0][0]}">\n<div class="sourceCode" id="${div.c[1][0].c[0][0]}"><pre><code>C</code></pre></div>\n</div>`).join("\n");
	} });
	const first = highlight([{ key: "k0", code: "x = 0" }], "python");
	await new Promise(resolve => setTimeout(resolve, 10));
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const waiting = controllers.map((controller, i) => highlight([{ key: `k${i + 1}`, code: `x = ${i + 1}` }], "python", { signal: controller.signal }));
	const full = await highlight([{ key: "k5", code: "x = 5" }], "python");
	assert.equal(full.size, 0, "With four runs waiting, more code stays plain at once.");
	for (const controller of controllers.slice(0, 3)) controller.abort();
	assert.deepEqual((await Promise.all(waiting.slice(0, 3))).map(result => result.size), [0, 0, 0], "A request that has gone stops waiting…");
	gate();
	await first;
	assert.equal((await waiting[3]).size, 1);
	assert.deepEqual(ran, ["x = 0", "x = 4"], "…and runs nobody waits for are skipped.");
});

test("REPL highlighting: at most 32 requests wait, one that has gone holds nothing, and nobody waiting means no run (R25, R26)", async () => {
	let gate, api, renders = 0;
	const highlight = createReplHighlighter({ run: async (args, input) => {
		if (args.includes("markdown")) { await api; return JSON.stringify({ "pandoc-api-version": [1, 22] }); }
		renders++;
		await new Promise(resolve => { gate = resolve; });
		return JSON.parse(input).blocks.map(div => `<div id="${div.c[0][0]}">\n<div class="sourceCode" id="${div.c[1][0].c[0][0]}"><pre><code>C</code></pre></div>\n</div>`).join("\n");
	} });
	const first = highlight([{ key: "a", code: "print(1)" }], "python");
	await new Promise(resolve => setTimeout(resolve, 10));
	// Requests for the running block come and go; count what each promise has attached.
	const then = Promise.prototype.then, attached = new WeakMap();
	let most = 0;
	Promise.prototype.then = function (...args) { const n = (attached.get(this) ?? 0) + 1; attached.set(this, n); most = Math.max(most, n); return then.apply(this, args); };
	try {
		for (let i = 0; i < 200; i++) {
			const controller = new AbortController();
			const asked = highlight([{ key: "a", code: "print(1)" }], "python", { signal: controller.signal });
			controller.abort();
			await asked;
		}
	} finally { Promise.prototype.then = then; }
	assert.ok(most < 10, `Requests that have gone leave nothing on the job (${most} on one promise).`);
	let answered = 0;
	const more = Array.from({ length: 40 }, () => highlight([{ key: "a", code: "print(1)" }], "python").then(result => { answered++; return result.size; }));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(answered, 9, "With 32 waiting, more requests get plain code at once.");
	gate();
	assert.equal((await first).size, 1);
	assert.deepEqual([(await Promise.all(more)).filter(Boolean).length, renders], [31, 1]);
	// The only request goes while Pandoc's version is being found: no run starts afterwards.
	let found;
	api = new Promise(resolve => { found = resolve; });
	const fresh = createReplHighlighter({ run: async args => { if (args.includes("markdown")) { await api; return JSON.stringify({ "pandoc-api-version": [1, 22] }); } renders++; return ""; } });
	const controller = new AbortController();
	const asked = fresh([{ key: "b", code: "print(2)" }], "python", { signal: controller.signal });
	await new Promise(resolve => setTimeout(resolve, 10));
	controller.abort();
	assert.equal((await asked).size, 0);
	found();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(renders, 1, "Nobody waits any more, so Pandoc isn't run.");
});

test("REPL highlighting: a Pandoc that ignores SIGTERM is still stopped at its timeout (R28)", { skip: process.platform === "win32" && "POSIX shell", timeout: 20_000 }, async t => {
	const base = await mkdtemp(join(tmpdir(), "repl-pandoc-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const pandoc = join(base, "pandoc");
	await writeFile(pandoc, `#!/bin/sh\ncase "$*" in *markdown*) echo '{"pandoc-api-version":[1,22]}' ;; *) trap '' TERM; exec sleep 60 ;; esac\n`, { mode: 0o700 });
	const before = process.env.PANDOC_PATH;
	process.env.PANDOC_PATH = pandoc;
	try {
		const started = Date.now();
		assert.equal((await createReplHighlighter()([{ key: "a", code: "print(1)" }], "python")).size, 0, "Plain code once it's stopped…");
		assert.ok(Date.now() - started < 10_000, "…at the 5 s timeout, not when it chooses to exit.");
	} finally {
		if (before === undefined) delete process.env.PANDOC_PATH; else process.env.PANDOC_PATH = before;
	}
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
	assert.match(cards[0].text, /· done ·/);
	assert.doesNotMatch(cards[0].text, /No output recorded yet/);
	assert.equal(cards[0].open, true, "The card is updated in place: still open.");
	assert.match(cards[1].text, /print\('second'\)[^]*second/);
	assert.match(await page.$eval(".repl-session-status", el => el.textContent), /Session checked .*record read/);
	// Code wraps; output is terminal text, wrapped only with Wrap lines, which an update keeps.
	const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
	s.set(record([entry(1), entry(2, { code: `def f():\n\n    print("${words}")`, output: `${words}\n` })]));
	s.tick(1_100);
	await page.waitForFunction(() => /word79/.test(document.querySelector('.repl-entry[data-entry-id="e2"]')?.textContent ?? ""), { timeout: 10_000 });
	const overflows = () => page.$eval('.repl-entry[data-entry-id="e2"]', card => ["tool-path", "tool-field"].map(part => { const pre = card.querySelector(`.${part} pre`); return pre.scrollWidth > pre.clientWidth; }));
	assert.deepEqual(await overflows(), [false, true], "The code wraps; the output scrolls.");
	// A wrapped line continues 4 columns past its own indent, and a blank line keeps its height.
	const wrapped = await page.$eval('.repl-entry[data-entry-id="e2"] .tool-path pre code', code => {
		const [first, , line] = code.children;
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode()) && !node.data.includes("print"));
		const range = document.createRange();
		range.setStart(node, node.data.indexOf("print"));
		range.setEnd(node, node.data.indexOf("print") + 1);
		const p = range.getBoundingClientRect();
		range.selectNodeContents(line);
		const rects = [...range.getClientRects()].filter(r => r.width > 0);
		const continued = Math.min(...rects.filter(r => r.top > p.top + 1).map(r => r.left));
		return { lines: new Set(rects.map(r => Math.round(r.top))).size, columns: (continued - p.left) / p.width,
			gap: (line.getBoundingClientRect().top - first.getBoundingClientRect().top) / parseFloat(getComputedStyle(code).lineHeight) };
	});
	assert.ok(wrapped.lines > 2, "The long line wraps.");
	assert.ok(Math.abs(wrapped.columns - 4) < 0.1, `Continued 4 columns past its indent, not ${wrapped.columns}.`);
	assert.ok(Math.abs(wrapped.gap - 2) < 0.1, `Two lines down, the blank one included, not ${wrapped.gap}.`);
	const copied = await page.$eval('.repl-entry[data-entry-id="e2"] .tool-path pre code', code => { const selection = getSelection(); selection.selectAllChildren(code); const text = selection.toString(); selection.removeAllRanges(); return text; });
	assert.equal(copied, `def f():\n\n    print("${words}")`, "Copying gives the code as sent.");
	await page.click('.repl-entry[data-entry-id="e2"] .output-wrap input');
	assert.deepEqual(await overflows(), [false, false], "With Wrap lines, the output wraps too.");
	await page.$eval('.repl-entry[data-entry-id="e2"] .output-wrap input', input => input.blur());
	s.set(record([entry(1), entry(2, { code: `def f():\n\n    print("${words}")`, output: `${words} again\n` })]));
	s.tick(1_100);
	await page.waitForFunction(() => /again/.test(document.querySelector('.repl-entry[data-entry-id="e2"]')?.textContent ?? ""), { timeout: 10_000 });
	assert.equal(await page.$eval('.repl-entry[data-entry-id="e2"] .output-wrap input', input => input.checked), true, "An update keeps Wrap lines.");
	assert.deepEqual(await overflows(), [false, false]);
	// Option/Alt+Left goes up: from a session to the sessions, then to Preview.
	const altLeft = target => Promise.all([target.waitForNavigation(), target.keyboard.down("Alt").then(() => target.keyboard.press("ArrowLeft")).then(() => target.keyboard.up("Alt"))]);
	const tab = await browser.newPage();
	await tab.goto(server.url);
	await Promise.all([tab.waitForNavigation(), tab.click('[data-watch-control="repl"]')]);
	await Promise.all([tab.waitForNavigation(), tab.click(".repl-session-name a")]);
	await tab.waitForSelector(".repl-entry");
	await altLeft(tab);
	assert.match(await tab.$eval("h1", h => h.textContent), /REPL sessions/);
	await altLeft(tab);
	assert.match(await tab.$eval("#preview-root", root => root.textContent), /Answer/);
	// Whatever path the tab took: here Preview is the page before the session, but up is still the sessions.
	await Promise.all([tab.waitForNavigation(), tab.click('[data-watch-control="repl"]')]);
	await Promise.all([tab.waitForNavigation(), tab.click(".repl-session-name a")]);
	await Promise.all([tab.waitForNavigation(), tab.click('[data-watch-control="preview"]')]);
	await Promise.all([tab.waitForNavigation(), tab.click('[data-watch-control="repl"]')]);
	assert.match(await tab.$eval("h1", h => h.textContent), /REPL · Python/);
	await altLeft(tab);
	assert.match(await tab.$eval("h1", h => h.textContent), /REPL sessions/);
	// Opened directly, with no earlier page in the tab: up is the sessions too.
	const sessionUrl = replHref.replace("/__pi_markdown_preview_repl__/?", "/__pi_markdown_preview_repl__/pi-repl-python?");
	const fresh = await browser.newPage();
	await fresh.goto(sessionUrl);
	await fresh.waitForSelector(".repl-entry");
	await altLeft(fresh);
	assert.match(await fresh.$eval("h1", h => h.textContent), /REPL sessions/);
});

test("REPL page in a browser: a file an entry saves shows as a thumbnail, through a route only a card has shown", { skip: !process.env.PUPPETEER_EXECUTABLE_PATH && "no test browser", timeout: 60_000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "repl-page-files-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "fit.png"), PNG);
	const s = source();
	s.cwd(dir);
	s.set(record([entry(1, { code: 'plt.savefig("fit.png")\nprint("and missing.png")', output: "and missing.png\n" })]));
	const server = await createBrowserWatchServer("<!doctype html><html><head><title>R</title></head><body><main id='preview-root'><p>Answer</p></main></body></html>", dir, { repl: s.live });
	t.after(() => server.close());
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(server.url);
	const replHref = await page.$eval('[data-watch-control="repl"]', a => a.href);
	await page.goto(replHref.replace("/__pi_markdown_preview_repl__/?", "/__pi_markdown_preview_repl__/pi-repl-python?"));
	await page.waitForSelector(".repl-file img");
	await page.waitForFunction(() => document.querySelector(".repl-file img").complete);
	const shown = await page.$$eval(".repl-file", figures => figures.map(figure => ({ text: figure.querySelector("figcaption").textContent, target: figure.querySelector("a").target, width: figure.querySelector("img")?.naturalWidth ?? 0, href: figure.querySelector("a").getAttribute("href") })));
	assert.deepEqual(shown.map(file => [file.text, file.target, file.width]), [["fit.png", "_blank", 1]], "The saved file shows, loaded under the page's policy; a missing one doesn't.");
	// Fetched as the page does, with its cookie: without one, the route refuses anything.
	const fetched = href => page.evaluate(url => fetch(url).then(response => [response.status, response.headers.get("content-type")]), href);
	assert.deepEqual(await fetched(shown[0].href), [200, "image/png"]);
	assert.equal((await fetched(`/__pi_markdown_preview_absolute_image__/${"0".repeat(64)}`))[0], 404, "Only a route a card has shown is served.");
	assert.equal((await fetch(new URL(shown[0].href, server.url))).status, 403, "Not without the preview's cookie.");
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
