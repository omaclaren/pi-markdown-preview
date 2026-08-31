import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
	console.log("Multi-watch RPC lifecycle check is skipped on Windows; parser and path-identity regressions still run.");
	process.exit(0);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-markdown-preview-multi-watch-"));
const bin = join(root, "bin");
const openLog = join(root, "open.log");
const fakeCmuxPath = join(bin, "cmux");
const fakePandocPath = join(bin, "pandoc");
const pandocDelayFile = join(root, "delay-pandoc");
const realPandocPath = process.env.PANDOC_PATH?.trim()
	|| spawnSync("sh", ["-c", "command -v pandoc"], { encoding: "utf8" }).stdout.trim();
assert.ok(realPandocPath, "Pandoc is required for multi-watch integration checks.");
await mkdir(bin);
await writeFile(fakeCmuxPath, '#!/bin/sh\nprintf "%s\\n" "$3" >> "$PMP_OPEN_LOG"\n');
await writeFile(fakePandocPath, '#!/bin/sh\n[ -f "$PMP_PANDOC_DELAY_FILE" ] && sleep 0.6\nexec "$PMP_REAL_PANDOC" "$@"\n');
await chmod(fakeCmuxPath, 0o755);
await chmod(fakePandocPath, 0o755);
await writeFile(openLog, "");

const one = join(root, "one.md");
const two = join(root, "two.md");
await writeFile(one, "# One\n\nVersion one\n");
await writeFile(two, "# Two\n\nIndependent\n");

const env = {
	...process.env,
	CMUX_BUNDLED_CLI_PATH: fakeCmuxPath,
	CMUX_WORKSPACE_ID: "multi-watch-test-workspace",
	PANDOC_PATH: fakePandocPath,
	PI_MARKDOWN_PREVIEW_REGISTER_EXPORT_TOOL: "0",
	PMP_OPEN_LOG: openLog,
	PMP_PANDOC_DELAY_FILE: pandocDelayFile,
	PMP_REAL_PANDOC: realPandocPath,
};
const piCommand = join(repo, "node_modules", ".bin", "pi");
const child = spawn(piCommand, [
	"--mode", "rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--extension", join(repo, "index.ts"),
], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });

let stdoutBuffer = "";
let stderr = "";
const responses = new Map();
const waiters = new Map();
const notifications = [];
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString();
	for (;;) {
		const newlineIndex = stdoutBuffer.indexOf("\n");
		if (newlineIndex < 0) break;
		const line = stdoutBuffer.slice(0, newlineIndex);
		stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
		if (!line) continue;
		const event = JSON.parse(line);
		if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event);
		if (event.type === "response" && event.id) {
			responses.set(event.id, event);
			waiters.get(event.id)?.(event);
			waiters.delete(event.id);
		}
	}
});

let commandSequence = 0;
const waitResponse = (id) => responses.has(id)
	? Promise.resolve(responses.get(id))
	: new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			waiters.delete(id);
			rejectPromise(new Error(`Timed out waiting for ${id}\n${stderr}`));
		}, 30_000);
		waiters.set(id, (event) => {
			clearTimeout(timeout);
			resolvePromise(event);
		});
	});
const sendCommand = (message) => {
	const id = `command-${++commandSequence}`;
	child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	return waitResponse(id).then((response) => {
		assert.equal(response.success, true, `${message}: ${JSON.stringify(response)}`);
	});
};
const command = async (message) => await sendCommand(message);
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = await predicate();
		if (value) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const openedUrls = async () => (await readFile(openLog, "utf8")).trim().split("\n").filter(Boolean);
const waitOpenCount = (count) => waitFor(async () => {
	const urls = await openedUrls();
	return urls.length >= count ? urls : undefined;
}, `${count} browser opens`);
const bootstrap = async (url) => {
	const response = await fetch(url);
	assert.equal(response.status, 200);
	const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
	assert.ok(cookie);
	return { origin: new URL(url).origin, cookie, html: await response.text() };
};
const getPage = async (session) => {
	const response = await fetch(session.origin, { headers: { cookie: session.cookie } });
	assert.equal(response.status, 200);
	return await response.text();
};
const revisionOf = (html) => Number(/const revision = "(\d+)";/.exec(html)?.[1]);
const isClosed = async (session) => {
	try {
		await fetch(session.origin, { headers: { cookie: session.cookie } });
		return false;
	} catch {
		return true;
	}
};

try {
	await command(`/preview-browser -w --file ${JSON.stringify(one)}`);
	let urls = await waitOpenCount(1);
	const oneSession = await bootstrap(urls[0]);
	assert.match(oneSession.html, /<title>one\.md — Markdown Preview<\/title>/);
	assert.match(oneSession.html, /data-watch-control="source"[^>]*>one\.md<\/span>/);

	await command(`/preview-browser -w --file ${JSON.stringify(two)}`);
	urls = await waitOpenCount(2);
	const twoSession = await bootstrap(urls[1]);
	assert.notEqual(oneSession.origin, twoSession.origin);

	await command(`/preview-browser -w --file ${JSON.stringify(one)}`);
	urls = await waitOpenCount(3);
	assert.equal(new URL(urls[2]).origin, oneSession.origin, "The same file should reopen its existing server.");

	const oneAlias = join(root, "one-alias.md");
	await symlink(one, oneAlias);
	await command(`/preview-browser -w --file ${JSON.stringify(oneAlias)}`);
	urls = await waitOpenCount(4);
	assert.equal(new URL(urls[3]).origin, oneSession.origin, "A symlink alias should reopen the canonical watcher.");

	await command("/preview-browser -w");
	urls = await waitOpenCount(5);
	const responseSession = await bootstrap(urls[4]);
	assert.match(responseSession.html, /<title>Assistant responses — Markdown Preview<\/title>/);
	assert.equal(new Set([oneSession.origin, twoSession.origin, responseSession.origin]).size, 3);

	const beforeList = notifications.length;
	await command("/preview-browser --list");
	const listNotice = notifications.slice(beforeList).find((event) => event.message.includes("Browser preview watchers"));
	assert.match(listNotice?.message ?? "", /Browser preview watchers \(3\/8\)/);
	assert.match(listNotice?.message ?? "", /assistant responses/);
	assert.ok(listNotice?.message.includes(one));

	await writeFile(one, "# One\n\nVersion two\n");
	const oneUpdated = await waitFor(async () => {
		const html = await getPage(oneSession);
		return revisionOf(html) >= 2 && html.includes("Version two") ? html : undefined;
	}, "first file update");
	assert.equal(revisionOf(oneUpdated), 2);
	assert.equal(revisionOf(await getPage(twoSession)), 1, "The second file must not change with the first.");
	assert.equal(revisionOf(await getPage(responseSession)), 1, "The response watcher must not change with a file.");

	await command(`/preview-browser --stop --file ${JSON.stringify(oneAlias)}`);
	assert.equal(await waitFor(() => isClosed(oneSession), "first watcher shutdown"), true);
	assert.equal(revisionOf(await getPage(twoSession)), 1);

	const beforeAmbiguousStop = notifications.length;
	await command("/preview-browser --stop");
	const ambiguousNotice = notifications.slice(beforeAmbiguousStop).find((event) => event.notifyType === "error");
	assert.ok(ambiguousNotice?.message.includes("Choose a file path, --responses, or --all"));
	assert.equal(revisionOf(await getPage(twoSession)), 1, "Ambiguous stop must not change another watcher.");

	await command("/preview-browser --stop --responses");
	assert.equal(await waitFor(() => isClosed(responseSession), "response watcher shutdown"), true);
	await command("/preview-browser --stop");
	assert.equal(await waitFor(() => isClosed(twoSession), "bare unambiguous shutdown"), true);

	const limitFiles = [];
	for (let index = 0; index < 9; index++) {
		const path = join(root, `limit-${index + 1}.md`);
		await writeFile(path, `# Limit ${index + 1}\n`);
		limitFiles.push(path);
	}
	const opensBeforeLimit = (await openedUrls()).length;
	for (const path of limitFiles) await command(`/preview-browser -w --file ${JSON.stringify(path)}`);
	const limitUrls = await waitOpenCount(opensBeforeLimit + 8);
	assert.equal(limitUrls.length, opensBeforeLimit + 8, "The ninth watcher must not open a browser.");
	assert.ok(notifications.some((event) => event.notifyType === "error" && event.message.includes("At most 8 browser preview watchers")));
	const limitSessions = await Promise.all(limitUrls.slice(-8).map(bootstrap));
	await command("/preview-browser --stop --all");
	await waitFor(async () => (await Promise.all(limitSessions.map(isClosed))).every(Boolean), "stop-all shutdown");

	const beforeEmptyList = notifications.length;
	await command("/preview-browser --list");
	assert.ok(notifications.slice(beforeEmptyList).some((event) => event.message === "No browser preview watchers are running."));

	const raceFile = join(root, "race.md");
	await writeFile(raceFile, "# Stop-during-start race\n");
	await writeFile(pandocDelayFile, "delay");
	const opensBeforeRace = (await openedUrls()).length;
	let staleStartSettledAt = 0;
	const staleStart = sendCommand(`/preview-browser -w --file ${JSON.stringify(raceFile)}`).finally(() => {
		staleStartSettledAt = Date.now();
	});
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
	const stopIssuedAt = Date.now();
	const targetedStop = sendCommand(`/preview-browser --stop --file ${JSON.stringify(raceFile)}`);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	const replacementStart = sendCommand(`/preview-browser -w --file ${JSON.stringify(raceFile)}`);
	await Promise.all([staleStart, targetedStop, replacementStart]);
	assert.ok(staleStartSettledAt - stopIssuedAt < 450, "Stopping a provisional watcher should cancel its in-flight Pandoc render rather than waiting for it.");
	await rm(pandocDelayFile, { force: true });
	await waitOpenCount(opensBeforeRace + 1);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
	assert.equal((await openedUrls()).length, opensBeforeRace + 1, "A stopped provisional start must not open or delete its replacement watcher.");
	const beforeRaceList = notifications.length;
	await command("/preview-browser --list");
	assert.ok(notifications.slice(beforeRaceList).some((event) => /Browser preview watchers \(1\/8\)/.test(event.message)));
	await command("/preview-browser --stop --all");

	console.log(`Multi-watch RPC lifecycle checks passed (${notifications.length} notifications, ${(await openedUrls()).length} opens).`);
} finally {
	child.stdin.end();
	if (child.exitCode === null) await new Promise((resolvePromise) => child.once("exit", resolvePromise));
	await rm(root, { recursive: true, force: true });
}
