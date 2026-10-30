// A strict, read-only reader for pi-repl's shared session record (protocol v1,
// REPL_SESSION_RECORD_PROTOCOL.md in pi-repl). It never creates, repairs, locks
// or chmods anything: a record that isn't exactly as the protocol describes is
// refused, and the refusal writes nothing. Record text is untrusted data.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPL_RECORD_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const STATUSES = new Set(["sending", "sent", "captured", "timeout", "error", "note"]);
const ORIGINS = new Set(["pi-repl", "pi-studio", "unknown"]);
const MODES = new Set(["raw", "literate", "agent"]);
// The writer's bounds (repl-session-record.js); a field past them was not written by it.
const FIELD_LIMITS = { code: 200_000, prose: 80_000, output: 200_000 };
const MAX_SKIPPED_CHUNKS = 100_000;

/** Why a record can't be shown; `missing` and `swapped` can be transient. */
export class ReplRecordError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

/** pi-repl's private record root for this user (getReplSessionRecordRoot). */
export function replRecordRoot({ dir = tmpdir(), uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
	return join(dir, `pi-repl-session-records-${uid == null ? "user" : uid}`);
}

/** A session's record-directory key as pi-repl writes it (P0): anything else, read as a key, is malformed. */
export const REPL_ROOT_KEY = /^v1:[a-f0-9]{32}$/;

/** The record-directory key for a directory's device and inode, exact integers: `v1:` and 32 hex characters of SHA-256 of `<dev>:<ino>`. */
export function replRootKeyOf(dev, ino) {
	return `v1:${createHash("sha256").update(`${BigInt(dev)}:${BigInt(ino)}`).digest("hex").slice(0, 32)}`;
}

/**
 * This process's own record directory's key, to compare with a session's: undefined when there's no
 * usable directory here (missing, a symlink, not a directory, another user's, or not mode 0700).
 * Read-only: it never creates the directory.
 */
export async function replRecordRootKey(root = replRecordRoot(), uid = typeof process.getuid === "function" ? process.getuid() : null) {
	const info = await lstat(root, { bigint: true }).catch(() => undefined);
	if (!info?.isDirectory() || (uid != null && info.uid !== BigInt(uid)) || (info.mode & 0o777n) !== 0o700n) return undefined;
	return replRootKeyOf(info.dev, info.ino);
}

const recordIdOk = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const timestamp = value => integer(value, 0, MAX_TIMESTAMP);
const text = (value, max) => typeof value === "string" && value.length <= max;
const ownedBy = (stats, uid) => uid == null || stats.uid === uid;
// A pi-repl-<runtime> session's record names that runtime, or "unknown" when tmux didn't say;
// Python and IPython share pi-repl-python.
const runtimeFits = (sessionName, runtime) => {
	const expected = /^pi-repl-([a-z]+)$/.exec(sessionName)?.[1];
	return !expected || runtime === expected || runtime === "unknown" || (expected === "python" && runtime === "ipython");
};

/** A cheap change stamp for the record file, or null when it is absent. Never proof of unchanged bytes. */
export async function statReplRecord(recordId, { root = replRecordRoot() } = {}) {
	if (!recordIdOk(recordId)) throw new ReplRecordError("malformed", "Invalid shared REPL record ID.");
	const info = await lstat(join(root, `${recordId}.json`)).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
	return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : null;
}

/**
 * Reads and validates one record, pinned to `{ sessionName, tmuxSessionId, tmuxSessionCreatedAt }`.
 * Returns `{ record, stamp }`. The root and file are checked as the protocol requires, the
 * opened descriptor is checked rather than the path, and the path and root must still be the
 * ones checked once the bytes are read: a swap in between discards the read. `signal` stops
 * the work between steps.
 */
// `afterOpen` and `afterRead` let tests replace files between the checks; nothing else passes them.
export async function readReplRecord(recordId, pin, { root = replRecordRoot(), uid = typeof process.getuid === "function" ? process.getuid() : null, maxBytes = REPL_RECORD_MAX_BYTES, signal, afterOpen, afterRead } = {}) {
	if (!recordIdOk(recordId)) throw new ReplRecordError("malformed", "Invalid shared REPL record ID.");
	signal?.throwIfAborted();
	const rootBefore = await lstat(root).catch(error => { throw error?.code === "ENOENT" ? new ReplRecordError("missing", "There is no shared REPL record directory.") : error; });
	if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !ownedBy(rootBefore, uid) || (rootBefore.mode & 0o777) !== 0o700) {
		throw new ReplRecordError("unsafe", "The shared REPL record directory isn't private to this user.");
	}
	const path = join(root, `${recordId}.json`);
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if (error?.code === "ENOENT") throw new ReplRecordError("missing", "The shared REPL record doesn't exist.");
		if (error?.code === "ELOOP" || error?.code === "EMLINK") throw new ReplRecordError("unsafe", "The shared REPL record is a symbolic link.");
		throw error;
	}
	let bytes;
	let info;
	try {
		signal?.throwIfAborted();
		await afterOpen?.();
		info = await handle.stat();
		// The path must still name the opened file; then the file itself must be private.
		const named = await lstat(path).catch(() => null);
		if (!named || named.dev !== info.dev || named.ino !== info.ino) throw new ReplRecordError("swapped", "The shared REPL record changed while it was opened.");
		if (!info.isFile() || !ownedBy(info, uid) || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
			throw new ReplRecordError("unsafe", "The shared REPL record isn't a private regular file with one link.");
		}
		const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, info.size + 1)));
		let length = 0;
		for (;;) {
			if (length === buffer.length) {
				if (buffer.length > maxBytes) break;
				throw new ReplRecordError("swapped", "The shared REPL record grew while it was read.");
			}
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > maxBytes) throw new ReplRecordError("oversize", "The shared REPL record is larger than the protocol allows.");
		bytes = buffer.subarray(0, length);
		// The bytes are the file the path still names, not one already replaced.
		await afterRead?.();
		const namedAfter = await lstat(path).catch(() => null);
		if (!namedAfter || namedAfter.dev !== info.dev || namedAfter.ino !== info.ino) throw new ReplRecordError("swapped", "The shared REPL record was replaced while it was read.");
	} finally { await handle.close(); }
	signal?.throwIfAborted();
	const rootAfter = await lstat(root).catch(() => null);
	if (!rootAfter || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || !rootAfter.isDirectory()) {
		throw new ReplRecordError("swapped", "The shared REPL record directory changed while the record was read.");
	}
	let parsed;
	try { parsed = JSON.parse(bytes.toString("utf8")); }
	catch { throw new ReplRecordError("malformed", "The shared REPL record isn't valid JSON."); }
	return { record: validateReplRecord(parsed, recordId, pin), stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
}

/** Validates without the writer's corrections; returns the record as read. */
export function validateReplRecord(record, recordId, pin) {
	const fail = message => { throw new ReplRecordError("malformed", message); };
	if (!record || typeof record !== "object" || Array.isArray(record)) fail("The shared REPL record isn't an object.");
	if (record.protocol !== "pi-repl-session-record" || record.version !== 1) throw new ReplRecordError("unsupported", "The shared REPL record uses another protocol or version.");
	if (record.recordId !== recordId) fail("The shared REPL record's ID doesn't match its name.");
	const session = record.session;
	if (!session || typeof session !== "object") fail("The shared REPL record has no session identity.");
	if (!text(session.sessionName, 240) || !session.sessionName || /[\r\n\0]/.test(session.sessionName)) fail("The shared REPL record's session name is invalid.");
	if (typeof session.tmuxSessionId !== "string" || !/^\$[0-9]+$/.test(session.tmuxSessionId)) fail("The shared REPL record's tmux session ID is invalid.");
	if (!integer(session.tmuxSessionCreatedAt, 1, MAX_TIMESTAMP)) fail("The shared REPL record's session creation time is invalid.");
	if (typeof session.runtime !== "string" || !/^[a-z0-9_.+-]{1,40}$/.test(session.runtime)) fail("The shared REPL record's runtime is invalid.");
	if (pin && (session.sessionName !== pin.sessionName || session.tmuxSessionId !== pin.tmuxSessionId || session.tmuxSessionCreatedAt !== pin.tmuxSessionCreatedAt)) {
		throw new ReplRecordError("mismatch", "The shared REPL record belongs to another session lifetime.");
	}
	if (!runtimeFits(session.sessionName, session.runtime)) fail("The shared REPL record names a runtime its session doesn't run.");
	// The writer sets the record's update time straight from the clock, so after a clock change it
	// can come before its creation time (unlike an entry's).
	if (!integer(record.revision) || !timestamp(record.createdAt) || !timestamp(record.updatedAt)) fail("The shared REPL record's revision or times are invalid.");
	if (record.clearedAt !== null && !timestamp(record.clearedAt)) fail("The shared REPL record's clear time is invalid.");
	if (!integer(record.droppedEntries)) fail("The shared REPL record's dropped-entry count is invalid.");
	if (!Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) fail("The shared REPL record's entries are invalid.");
	const ids = new Set();
	for (const entry of record.entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("A shared REPL record entry isn't an object.");
		if (typeof entry.id !== "string" || !/^[A-Za-z0-9_.:-]{1,240}$/.test(entry.id)) fail("A shared REPL record entry has an invalid ID.");
		if (ids.has(entry.id)) fail("The shared REPL record repeats an entry ID.");
		ids.add(entry.id);
		// The writer never lets an entry's update or completion come before its creation.
		if (!timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entry.updatedAt < entry.createdAt
			|| (entry.completedAt != null && (!timestamp(entry.completedAt) || entry.completedAt < entry.createdAt))) fail("A shared REPL record entry has invalid times.");
		if (!ORIGINS.has(entry.origin) || !MODES.has(entry.mode) || !STATUSES.has(entry.status)) fail("A shared REPL record entry has an invalid origin, mode or status.");
		if (!text(entry.label, 240) || !entry.label || /[\r\n\0]/.test(entry.label)) fail("A shared REPL record entry has an invalid label.");
		for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
			if (entry[field] !== undefined && !text(entry[field], limit)) fail(`A shared REPL record entry's ${field} is invalid.`);
		}
		if (typeof entry.code !== "string" || typeof entry.output !== "string") fail("A shared REPL record entry has no code or output.");
		if (entry.requestId !== undefined && (!text(entry.requestId, 300) || /[\r\n\0]/.test(entry.requestId))) fail("A shared REPL record entry has an invalid request ID.");
		// The writer gives each entry its record's session; an older entry may have none.
		if (entry.sessionName !== undefined && entry.sessionName !== "" && entry.sessionName !== session.sessionName) fail("A shared REPL record entry names another session.");
		if (entry.runtime !== undefined && (!text(entry.runtime, 40) || !entry.runtime || entry.runtime !== entry.runtime.toLowerCase())) fail("A shared REPL record entry has an invalid runtime.");
		if (entry.skippedChunks !== undefined && !integer(entry.skippedChunks, 0, MAX_SKIPPED_CHUNKS)) fail("A shared REPL record entry's skippedChunks is invalid.");
		for (const field of ["codeOmittedChars", "proseOmittedChars", "outputOmittedChars"]) {
			if (entry[field] !== undefined && !integer(entry[field])) fail(`A shared REPL record entry's ${field} is invalid.`);
		}
	}
	return record;
}

/** A version of everything an entry's card shows: its update time alone can stay put while status and output change. */
export function replEntryVersion(entry) {
	const shown = [entry.id, entry.status, entry.origin, entry.label, entry.mode, entry.requestId ?? "", entry.runtime ?? "", entry.createdAt, entry.completedAt ?? "",
		entry.code, entry.output, entry.prose ?? "", entry.codeOmittedChars ?? 0, entry.outputOmittedChars ?? 0, entry.proseOmittedChars ?? 0, entry.skippedChunks ?? 0];
	return createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 16);
}
