import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { turnDetailsFromRecords } from "./turn-details.js";

// A request reads a fixed snapshot of the tail, never tails a running turn.
export const TURN_READ_BYTES = 8 * 1024 * 1024;
export const TURN_RECORD_BYTES = 1024 * 1024;
export const TURN_RECORD_LIMIT = 10_000;

export async function readTurnDetails(path, agent, target, signal) {
	const { records, incomplete } = await readRecordTail(path, signal);
	return turnDetailsFromRecords(agent, records, target, incomplete);
}

/**
 * Complete JSONL records from a bounded snapshot of a file's tail, oldest first. Also used to start a live view.
 * `end`: the byte offset just past the last complete line read; a line starting before it is not newer than the snapshot.
 */
export async function readRecordTail(path, signal) {
	signal?.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Session history is not a regular file.");
		const start = Math.max(0, info.size - TURN_READ_BYTES);
		const data = Buffer.alloc(Math.min(info.size, TURN_READ_BYTES));
		let offset = 0;
		while (offset < data.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(data, offset, Math.min(65536, data.length - offset), start + offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		signal?.throwIfAborted();
		// `startsMidway`: earlier records exist that were not read (bounded read).
		let buffer = data.subarray(0, offset), incomplete = start > 0, startsMidway = start > 0;
		const skipped = start ? buffer.indexOf(10) + 1 || buffer.length : 0;
		buffer = buffer.subarray(skipped);
		const records = [];
		// Work backwards so both storage and parse attempts are bounded, even
		// for a damaged file containing millions of tiny invalid lines.
		let end = buffer.lastIndexOf(10), count = 0;
		const complete = start + skipped + end + 1;
		if (end < buffer.length - 1) incomplete = true; // Ignore a still-in-flight last line.
		for (let i = end - 1; i >= -1; i--) {
			if (i >= 0 && buffer[i] !== 10) continue;
			if (++count > TURN_RECORD_LIMIT) { incomplete = startsMidway = true; break; }
			const line = buffer.subarray(i + 1, end); end = i;
			if (!line.length) continue;
			if (line.length > TURN_RECORD_BYTES) { incomplete = true; continue; }
			try { records.push(JSON.parse(line.toString("utf8"))); } catch { incomplete = true; }
		}
		signal?.throwIfAborted();
		return { records: records.reverse(), incomplete, startsMidway, end: complete };
	} finally { await file.close(); }
}
