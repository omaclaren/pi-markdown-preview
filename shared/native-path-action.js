import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";

/** Fixed system utilities with separate argv, never a shell command or a URL.
 * The caller must authorize the path and check that it is a regular file/folder.
 * @param {"open" | "reveal"} action
 * @param {string} path
 * @param {"file" | "directory"} kind
 * @param {NodeJS.Platform} [platform]
 */
export function nativePathCommand(action, path, kind, platform = process.platform) {
	const pathApi = platform === "win32" ? win32 : posix;
	if (!["open", "reveal"].includes(action) || !["file", "directory"].includes(kind)
		|| typeof path !== "string" || path.includes("\0") || !pathApi.isAbsolute(path)
		|| path.startsWith("//") || path.startsWith("\\\\")) throw new Error("Invalid local file action.");
	if (platform === "darwin") {
		return { file: "/usr/bin/open", args: action === "reveal" ? ["-R", "--", path]
			: kind === "directory" ? ["-a", "Finder", "--", path] : ["--", path] };
	}
	if (platform === "win32") {
		return { file: win32.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), args: action === "reveal" ? [`/select,${path}`] : [path] };
	}
	if (platform === "linux") {
		// No portable file-selection API: open the containing folder on Linux.
		return { file: "xdg-open", args: [action === "reveal" ? pathApi.dirname(path) : path] };
	}
	throw Object.assign(new Error("Native file actions are unavailable on this operating system."), { statusCode: 501 });
}

/** Ask the desktop to open/reveal a caller-authorized path. Completion means the
 * system utility accepted the request, not that its associated app finished.
 * @param {"open" | "reveal"} action @param {string} path @param {"file" | "directory"} kind
 * @returns {Promise<void>}
 */
export function performNativePathAction(action, path, kind) {
	const { file, args } = nativePathCommand(action, path, kind);
	return new Promise((resolve, reject) => {
		execFile(file, args, { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, error => {
			if (!error) { resolve(); return; }
			reject(Object.assign(new Error(error.killed
				? "The system opener did not respond in time. Check your desktop before trying again."
				: "The system could not open this path. Check its app association or use Copy local path."), { statusCode: error.killed ? 504 : 502 }));
		});
	});
}
