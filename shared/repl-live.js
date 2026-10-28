// The REPL page's data: pi-repl's shared tmux sessions and their clean records,
// read on demand while a page is watching. Discovery only inspects tmux (no
// pane input, no set-option); records are read with the strict reader. Work is
// driven by viewers' requests, bounded, and shared between them.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readReplRecord, replEntryVersion, ReplRecordError, statReplRecord, replRecordRoot } from "./repl-record-reader.js";

/** pi-repl's shared sessions, one per runtime (Python and IPython share one). */
export const REPL_SESSIONS = Object.freeze([
	["python", "Python"], ["julia", "Julia"], ["r", "R"], ["ghci", "Haskell"], ["clojure", "Clojure"], ["ruby", "Ruby"],
	["java", "Java"], ["octave", "Octave"], ["matlab", "MATLAB"], ["gnuplot", "gnuplot"], ["cpp", "C++"],
].map(([runtime, label]) => Object.freeze({ runtime, label, sessionName: `pi-repl-${runtime}` })));

const SESSION_BY_NAME = new Map(REPL_SESSIONS.map(session => [session.sessionName, session]));
// "|" can't occur in any of these fields, and tmux keeps it whether or not it was started with -u.
const PANE_FORMAT = "#{session_id}|#{session_created}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_dead}|#{@pi_repl_record_id}|#{@pi_repl_record_version}";
// As pi-repl reads tmux: only these mean the session isn't there.
const ABSENT = /no server running|can't find session:|(?:error connecting|failed to connect).*?(?:No such file|Connection refused)/i;
const IDENTITY_MS = 5_000, STAT_MS = 1_000, REREAD_MS = 30_000, IDLE_MS = 60_000;
const MAX_SOURCES = 4, MAX_PINS = 16, TMUX_CONCURRENCY = 2, TMUX_TIMEOUT_MS = 2_000;
export const REPL_WINDOW_ENTRIES = 50, REPL_FIELD_DISPLAY_CHARS = 20_000, REPL_WINDOW_BYTES = 2_000_000;

/** Runs tmux as pi-repl does (`tmux -u`, default server, same environment). */
export function runTmux(args, { timeout = TMUX_TIMEOUT_MS } = {}) {
	return new Promise(resolve => execFile("tmux", ["-u", ...args], { timeout, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
		resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error?.killed) });
	}));
}

/**
 * One session's lifetime and record metadata, read from its first pane by index (the
 * pane pi-repl uses). `absent` only on tmux's own absence messages; anything else
 * that fails is `unchecked`, never "stopped".
 */
export async function inspectReplSession(sessionName, run = runTmux) {
	const result = await run(["list-panes", "-s", "-t", `=${sessionName}`, "-F", PANE_FORMAT]);
	if (result.code !== 0) {
		// list-panes reports a missing session as a missing window; has-session says which it is.
		const check = result.timedOut ? result : await run(["has-session", "-t", `=${sessionName}`]);
		if (check.code === 1 && ABSENT.test(check.stderr)) return { state: "absent" };
		const failed = check.code === 0 ? result : check;
		return { state: "unchecked", reason: failed.timedOut ? "tmux didn't answer in time" : (failed.stderr.trim().split("\n")[0] || "tmux failed").slice(0, 200) };
	}
	const panes = result.stdout.split("\n").map(line => line.split("|"))
		.filter(([id, created, window, pane]) => /^\$\d+$/.test(id ?? "") && /^\d+$/.test(created ?? "") && /^\d+$/.test(window ?? "") && /^\d+$/.test(pane ?? ""))
		.sort((a, b) => Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3]));
	if (!panes.length) return { state: "unchecked", reason: "tmux listed no panes" };
	const [tmuxSessionId, created, , , paneId, dead, recordId, recordVersion] = panes[0];
	return {
		state: dead === "1" ? "runtime-ended" : "running",
		tmuxSessionId, tmuxSessionCreatedAt: Number(created), paneId,
		recordId: /^[a-f0-9]{32}$/.test(recordId ?? "") ? recordId : undefined,
		recordVersion: recordVersion || undefined,
	};
}

const clip = (value, limit) => typeof value === "string" && value.length > limit
	? { text: value.slice(0, limit), omitted: value.length - limit } : { text: value ?? "", omitted: 0 };

/** The latest entries for display, newest kept first when the byte budget runs out. */
export function replWindow(record) {
	const entries = record.entries.slice(-REPL_WINDOW_ENTRIES);
	const shown = [];
	let bytes = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const code = clip(entry.code, REPL_FIELD_DISPLAY_CHARS), output = clip(entry.output, REPL_FIELD_DISPLAY_CHARS), prose = clip(entry.prose, REPL_FIELD_DISPLAY_CHARS);
		const size = 2 * (code.text.length + output.text.length + prose.text.length) + 2_000;
		if (shown.length && bytes + size > REPL_WINDOW_BYTES) break;
		bytes += size;
		shown.unshift({ ...entry, code: code.text, output: output.text, prose: prose.text, displayOmitted: { code: code.omitted, output: output.omitted, prose: prose.omitted }, version: replEntryVersion(entry) });
	}
	return { entries: shown, notShown: record.entries.length - shown.length };
}

/**
 * The REPL page's source. `list()` gives each shared session's state; `view(name, pinId,
 * version)` gives one session lifetime's window, pinned on first view. Injected
 * `run`, `root` and `now` are for tests.
 */
export function createReplLiveSource({ run = runTmux, root = replRecordRoot(), now = Date.now, readRecord = readReplRecord, statRecord = statReplRecord } = {}) {
	const generation = randomBytes(6).toString("hex");
	const pins = new Map(); // pinId -> pin state
	let inspections = new Map(); // sessionName -> { at, promise }
	let active = 0;
	const queue = [];
	const limited = async task => {
		if (active >= TMUX_CONCURRENCY) await new Promise(resolve => queue.push(resolve));
		active++;
		try { return await task(); } finally { active--; queue.shift()?.(); }
	};
	const inspect = (sessionName, maxAge = IDENTITY_MS) => {
		const cached = inspections.get(sessionName);
		if (cached && now() - cached.at < maxAge) return cached.promise;
		const promise = limited(() => inspectReplSession(sessionName, run)).catch(error => ({ state: "unchecked", reason: String(error?.message ?? error).slice(0, 200) }));
		inspections.set(sessionName, { at: now(), promise });
		return promise;
	};
	const sweep = () => {
		const t = now();
		for (const [id, pin] of pins) if (t - pin.seenAt > IDLE_MS) pins.delete(id);
		// At most MAX_SOURCES pins keep a record in memory; the least recently seen lets go.
		const holding = [...pins.values()].filter(pin => pin.record).sort((a, b) => b.seenAt - a.seenAt);
		for (const pin of holding.slice(MAX_SOURCES)) { pin.record = undefined; pin.window = undefined; pin.stamp = undefined; }
		while (pins.size > MAX_PINS) pins.delete([...pins.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0][0]);
	};

	async function list() {
		const sessions = await Promise.all(REPL_SESSIONS.map(async session => ({ ...session, ...(await inspect(session.sessionName)) })));
		return { checkedAt: now(), sessions: sessions.map(({ sessionName, runtime, label, state, recordId, recordVersion, reason }) => ({ sessionName, runtime, label, state, reason, record: recordId ? (recordVersion === "1" ? "v1" : "unsupported") : "none" })) };
	}

	// Refreshes a pin's identity, then its record when the file changed (or every 30 s).
	async function refresh(pin) {
		const t = now();
		if (pin.ended) return;
		if (t - pin.checkedAt >= IDENTITY_MS || pin.checkedAt === 0) {
			const seen = await inspect(pin.sessionName);
			if (seen.state === "absent") { pin.state = "ended"; pin.ended = true; pin.checkedAt = now(); return; }
			if (seen.state === "unchecked") { pin.state = "unchecked"; pin.reason = seen.reason; return; }
			if (seen.tmuxSessionId !== pin.tmuxSessionId || seen.tmuxSessionCreatedAt !== pin.tmuxSessionCreatedAt) { pin.state = "replaced"; pin.ended = true; pin.checkedAt = now(); return; }
			// A session's first send gives it its record; any other change of record is a new lifetime.
			if (!pin.recordId && seen.recordId) { pin.recordId = seen.recordId; pin.recordVersion = seen.recordVersion; }
			else if (seen.recordId !== pin.recordId) { pin.state = "replaced"; pin.ended = true; pin.checkedAt = now(); return; }
			pin.state = seen.state; pin.reason = undefined; pin.checkedAt = now();
		}
		if (!pin.recordId || pin.recordVersion !== "1") return;
		if (pin.record && now() - pin.statAt < STAT_MS) return;
		pin.statAt = now();
		let stamp;
		try { stamp = await statRecord(pin.recordId, { root }); } catch (error) { pin.readError = String(error?.message ?? error).slice(0, 200); return; }
		if (stamp === null) { pin.readError = "The shared record file isn't there."; return; }
		if (pin.record && stamp === pin.stamp && now() - pin.readAt < REREAD_MS) return;
		pin.reading ??= (async () => {
			try {
				const { record, stamp: read } = await readRecord(pin.recordId, pin, { root });
				const window = replWindow(record);
				const shown = JSON.stringify([record.revision, record.clearedAt, record.droppedEntries, window.notShown, window.entries.map(entry => entry.version)]);
				if (shown !== pin.shown) { pin.shown = shown; pin.sequence++; }
				pin.record = record; pin.window = window; pin.stamp = read; pin.readAt = now(); pin.readError = undefined;
			} catch (error) {
				pin.readError = error instanceof ReplRecordError ? error.message : String(error?.message ?? error).slice(0, 200);
				if (error instanceof ReplRecordError && error.code === "mismatch") { pin.state = "replaced"; pin.ended = true; }
			} finally { pin.reading = undefined; }
		})();
		await pin.reading;
	}

	/** Pins the session's current lifetime (when it has one) and returns its id, or the reason it can't. */
	async function pinSession(sessionName) {
		const session = SESSION_BY_NAME.get(sessionName);
		if (!session) return { error: "unknown" };
		const seen = await inspect(sessionName, 0);
		if (seen.state === "absent") return { error: "absent" };
		if (seen.state === "unchecked") return { error: "unchecked", reason: seen.reason };
		for (const [id, pin] of pins) {
			if (pin.ended || pin.sessionName !== sessionName || pin.tmuxSessionId !== seen.tmuxSessionId || pin.tmuxSessionCreatedAt !== seen.tmuxSessionCreatedAt) continue;
			if (!pin.recordId && seen.recordId) { pin.recordId = seen.recordId; pin.recordVersion = seen.recordVersion; }
			if (pin.recordId === seen.recordId) return { pinId: id };
		}
		const pinId = randomBytes(9).toString("base64url");
		pins.set(pinId, { ...session, tmuxSessionId: seen.tmuxSessionId, tmuxSessionCreatedAt: seen.tmuxSessionCreatedAt, recordId: seen.recordId, recordVersion: seen.recordVersion,
			state: seen.state, checkedAt: now(), statAt: 0, readAt: 0, sequence: 0, seenAt: now() });
		sweep();
		return { pinId };
	}

	/** One pinned lifetime's view. `version` is the client's last `generation:sequence`. */
	async function view(pinId, version) {
		const pin = pins.get(pinId);
		if (!pin) return { gone: true };
		pin.seenAt = now();
		await refresh(pin);
		sweep();
		const current = `${generation}:${pin.sequence}`;
		const base = {
			sessionName: pin.sessionName, runtime: pin.runtime, label: pin.label, state: pin.state, reason: pin.reason,
			record: !pin.recordId ? "none" : pin.recordVersion === "1" ? "v1" : "unsupported",
			checkedAt: pin.checkedAt, readAt: pin.readAt || null, readError: pin.readError, version: current, now: now(), ended: pin.ended === true,
		};
		if (version === current) return { ...base, unchanged: true };
		if (!pin.record) return { ...base, entries: [], notShown: 0, resync: !version || version.split(":")[0] !== generation };
		return { ...base, revision: pin.record.revision, clearedAt: pin.record.clearedAt, droppedEntries: pin.record.droppedEntries, entries: pin.window.entries, notShown: pin.window.notShown, resync: !version || version.split(":")[0] !== generation };
	}

	return { generation, list, pinSession, view, close() { pins.clear(); inspections = new Map(); } };
}
