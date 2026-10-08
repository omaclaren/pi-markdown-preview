import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { turnDetailsFromRecords } from "./turn-details.js";

// A request reads a fixed snapshot of the tail, never tails a running turn.
export const TURN_READ_BYTES = 8 * 1024 * 1024;
export const TURN_RECORD_BYTES = 1024 * 1024;
export const TURN_RECORD_LIMIT = 10_000;

export async function readTurnDetails(path, agent, target, signal) {
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
		let buffer = data.subarray(0, offset), incomplete = start > 0;
		if (start) buffer = buffer.subarray(buffer.indexOf(10) + 1 || buffer.length);
		const records = [];
		// Work backwards so both storage and parse attempts are bounded, even
		// for a damaged file containing millions of tiny invalid lines.
		let end = buffer.lastIndexOf(10), count = 0;
		if (end < buffer.length - 1) incomplete = true; // Ignore a still-in-flight last line.
		for (let i = end - 1; i >= -1; i--) {
			if (i >= 0 && buffer[i] !== 10) continue;
			if (++count > TURN_RECORD_LIMIT) { incomplete = true; break; }
			const line = buffer.subarray(i + 1, end); end = i;
			if (!line.length) continue;
			if (line.length > TURN_RECORD_BYTES) { incomplete = true; continue; }
			try { records.push(JSON.parse(line.toString("utf8"))); } catch { incomplete = true; }
		}
		signal?.throwIfAborted();
		return turnDetailsFromRecords(agent, records.reverse(), target, incomplete);
	} finally { await file.close(); }
}
