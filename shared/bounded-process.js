import { spawn, spawnSync } from "node:child_process";

/** @typedef {"aborted" | "spawn" | "stderr" | "stderr-limit" | "stdin" | "stdout" | "stdout-limit" | "timeout"} BoundedProcessErrorKind */

export class BoundedProcessError extends Error {
	/**
	 * @param {BoundedProcessErrorKind} kind
	 * @param {string} message
	 * @param {{ cause?: unknown }} [options]
	 */
	constructor(kind, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "BoundedProcessError";
		this.kind = kind;
	}
}

/** @param {number} bytes */
function formatByteLimit(bytes) {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
	return `${bytes} bytes`;
}

/** @param {number} timeoutMs */
function formatTimeout(timeoutMs) {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

/** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
function processTreeIsRunning(child) {
	if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
	if (!child.pid) return child.exitCode === null && child.signalCode === null;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return /** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH";
	}
}

/** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
function terminateProcessTree(child) {
	const processId = child.pid;
	if (processId && process.platform === "win32") {
		const result = spawnSync("taskkill", ["/pid", String(processId), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (result.status === 0) return true;
	}
	if (processId && process.platform !== "win32") {
		try {
			process.kill(-processId, "SIGKILL");
			return true;
		} catch {
			// Fall back to the direct child if the process group already disappeared
			// or the runtime does not support negative process-group IDs.
		}
	}
	if (child.exitCode !== null || child.signalCode !== null) return true;
	try {
		return child.kill("SIGKILL");
	} catch {
		return false;
	}
}

function quoteWindowsCmdToken(value) {
	if (/[\0\r\n"%]/.test(value)) {
		throw new TypeError("Windows command-shim arguments cannot contain NUL, newlines, double quotes, or percent expansion.");
	}
	return `"${value}"`;
}

/**
 * Build the single command string consumed by `cmd.exe /d /s /v:off /c`.
 * Every token stays quoted so spaces and shell metacharacters such as `&` and
 * `|` cannot change argument boundaries.
 *
 * @param {string} command
 * @param {string[]} args
 */
export function buildWindowsCmdCommandLine(command, args) {
	return `"${[command, ...args].map(quoteWindowsCmdToken).join(" ")}"`;
}

/**
 * Run a child process with bounded output, a deadline, and optional cancellation.
 * Nonzero exit codes are returned to the caller so it can preserve command-specific
 * diagnostics. Infrastructure failures reject with BoundedProcessError.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   input?: string | Buffer | Uint8Array,
 *   label?: string,
 *   maxStderrBytes: number,
 *   maxStdoutBytes: number,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   windowsCmdShim?: boolean,
 * }} options
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: Buffer, stdout: Buffer }>}
 */
export async function runBoundedProcess(command, args, options) {
	const label = options.label?.trim() || command;
	for (const [name, value] of [
		["timeoutMs", options.timeoutMs],
		["maxStdoutBytes", options.maxStdoutBytes],
		["maxStderrBytes", options.maxStderrBytes],
	]) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new TypeError(`${name} must be a positive safe integer.`);
		}
	}
	if (options.signal?.aborted) {
		throw new BoundedProcessError("aborted", `${label} was cancelled.`);
	}
	const input = options.input ?? "";
	const hasInput = typeof input === "string" ? Buffer.byteLength(input) > 0 : input.byteLength > 0;

	return await new Promise((resolve, reject) => {
		let child;
		try {
			const useWindowsCmd = process.platform === "win32" && options.windowsCmdShim === true;
			const executable = useWindowsCmd ? (process.env.ComSpec?.trim() || "cmd.exe") : command;
			const childArgs = useWindowsCmd
				? ["/d", "/s", "/v:off", "/c", buildWindowsCmdCommandLine(command, args)]
				: args;
			child = spawn(executable, childArgs, {
				cwd: options.cwd,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				windowsVerbatimArguments: useWindowsCmd,
			});
		} catch (error) {
			reject(new BoundedProcessError("spawn", `Failed to start ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
			return;
		}

		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let stdinEpipe;
		let timeout;
		let treePoll;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (treePoll) clearTimeout(treePoll);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error, terminate = false) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (terminate && !terminateProcessTree(child)) {
				error = new BoundedProcessError(error.kind ?? "spawn", `${error.message} The child process could not be terminated.`, { cause: error });
			}
			reject(error);
		};
		const onAbort = () => {
			fail(new BoundedProcessError("aborted", `${label} was cancelled.`), true);
		};

		timeout = setTimeout(() => {
			fail(new BoundedProcessError("timeout", `${label} timed out after ${formatTimeout(options.timeoutMs)}.`), true);
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk) => {
			if (settled) return;
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			stdoutBytes += buffer.length;
			if (stdoutBytes > options.maxStdoutBytes) {
				fail(new BoundedProcessError("stdout-limit", `${label} stdout exceeded ${formatByteLimit(options.maxStdoutBytes)}.`), true);
				return;
			}
			stdoutChunks.push(buffer);
		});
		child.stderr.on("data", (chunk) => {
			if (settled) return;
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			stderrBytes += buffer.length;
			if (stderrBytes > options.maxStderrBytes) {
				fail(new BoundedProcessError("stderr-limit", `${label} stderr exceeded ${formatByteLimit(options.maxStderrBytes)}.`), true);
				return;
			}
			stderrChunks.push(buffer);
		});
		child.stdout.on("error", (error) => {
			fail(new BoundedProcessError("stdout", `Could not read stdout from ${label}: ${error.message}`, { cause: error }), true);
		});
		child.stderr.on("error", (error) => {
			fail(new BoundedProcessError("stderr", `Could not read stderr from ${label}: ${error.message}`, { cause: error }), true);
		});
		child.stdin.on("error", (error) => {
			// Preserve a nonzero command's own diagnostics, but never accept exit 0
			// after the child closed stdin before the requested input was delivered.
			if (error.code === "EPIPE") {
				if (hasInput) stdinEpipe = error;
				return;
			}
			fail(new BoundedProcessError("stdin", `Could not send input to ${label}: ${error.message}`, { cause: error }), true);
		});
		child.once("error", (error) => {
			fail(new BoundedProcessError("spawn", `Failed to start ${label}: ${error.message}`, { cause: error }));
		});
		child.once("close", (code, childSignal) => {
			const finishClose = () => {
				if (settled) return;
				if (processTreeIsRunning(child)) {
					treePoll = setTimeout(finishClose, 25);
					return;
				}
				if (code === 0 && stdinEpipe) {
					fail(new BoundedProcessError("stdin", `${label} closed stdin before all input was delivered.`, { cause: stdinEpipe }));
					return;
				}
				settled = true;
				cleanup();
				resolve({
					code,
					signal: childSignal,
					stdout: Buffer.concat(stdoutChunks),
					stderr: Buffer.concat(stderrChunks),
				});
			};
			finishClose();
		});

		child.stdin.end(input);
	});
}

/** @param {unknown} error */
export function isSpawnNotFoundError(error) {
	return error instanceof BoundedProcessError
		&& error.kind === "spawn"
		&& error.cause instanceof Error
		&& /** @type {NodeJS.ErrnoException} */ (error.cause).code === "ENOENT";
}
