import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 as win32Path } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ts from "typescript";
import { Check } from "typebox/value";
import {
	createBrowserWatchServer,
	getBrowserWatchAbsoluteImagePath,
	prepareBrowserWatchHtml,
	resolveBrowserWatchResource,
	rewriteBrowserWatchAbsoluteImageSources,
} from "../shared/browser-watch-server.js";

const sourcePath = resolve(process.cwd(), "index.ts");
const src = readFileSync(sourcePath, "utf-8");

assert.doesNotMatch(
	src,
	/import\s*\{[^}]*\ballocateImageId\b[^}]*\}\s*from\s*"@earendil-works\/pi-tui"/s,
	"allocateImageId must not be a named runtime import because compatible host shims may omit it.",
);
assert.ok(
	src.includes('import * as PiTuiCompat from "@earendil-works/pi-tui";')
		&& src.includes('typeof PiTuiCompat.allocateImageId === "function"')
		&& src.includes("allocateImageIdIfAvailable?.()"),
	"Kitty image IDs should be feature-detected and omitted when the host does not expose an allocator.",
);
const stringEnumSource = src.slice(src.indexOf("function stringEnum"), src.indexOf("type ThemeMode"));
assert.ok(
	stringEnumSource.includes("return Type.String({") && !stringEnumSource.includes("return Type.Unsafe({"),
	"String enums should remain composable with Type.Optional in compatible host schema implementations.",
);

assert.match(src, /function buildRenderCacheKey\s*\(/, "Missing buildRenderCacheKey helper.");
assert.match(
	src,
	/const DEFAULT_TERMINAL_PREVIEW_FONT_SIZE_PX = 16;/,
	"Terminal preview should keep the known-good crisp default font size.",
);
assert.match(
	src,
	/const DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX = 15;/,
	"Browser preview default font size should match Studio's compact markdown rendering.",
);
assert.ok(
	src.includes("watchFile(filePath, { interval: BROWSER_FILE_WATCH_INTERVAL_MS }, listener)")
		&& src.includes("unwatchFile(activeWatch.source.filePath, activeWatch.source.listener)")
		&& src.includes("appendToHistory: snapshot.contentHash !== activeWatch.source.lastContentHash")
		&& src.includes("activeWatch.source.refreshSequence !== refreshSequence")
		&& src.includes("scheduleBrowserFileWatchRefresh(ctx, activeWatch);"),
	"Browser file watch should poll one path, clean up its exact listener, retain only genuinely changed versions, and reconcile async races.",
);
assert.match(
	src,
	/const DEFAULT_TERMINAL_DEVICE_SCALE_FACTOR = 2;/,
	"Terminal preview should keep the known-good screenshot density.",
);
assert.match(
	src,
	/const cacheKey = buildRenderCacheKey\(`\$\{style\.cacheKey\}\|fontSize=\$\{previewFontSizePx\}\|scale=\$\{deviceScaleFactor\}`,[\s\S]*?resourcePath,[\s\S]*?isLatex\)/,
	"renderPreview should scope cache by style/resourcePath/isLatex/fontSize/deviceScaleFactor.",
);
assert.ok(
	src.includes("truncatedPages: cached.truncatedPages === true")
		&& src.includes("truncatedPages: index === 0 ? truncatedPages : undefined"),
	"Preview caches should preserve maximum-height truncation warnings.",
);

assert.match(
	src,
	/markdown\+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header\+tex_math_dollars\+autolink_bare_uris-raw_html/,
	"HTML preview input format should allow lists, blockquotes, and headings without a preceding blank line and disable raw HTML.",
);
assert.match(
	src,
	/\["-f", inputFormat, "-t", "html5", "--mathml", "--wrap=none"\]/,
	"HTML preview should pass --wrap=none so long annotation markers survive pandoc wrapping.",
);
assert.match(
	src,
	/markdown\+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header\+tex_math_dollars\+autolink_bare_uris\+superscript\+subscript-raw_html/,
	"PDF input format should allow lists, blockquotes, and headings without a preceding blank line and disable raw HTML.",
);
assert.ok(
	src.includes(String.raw`\\IfFileExists{titlesec.sty}`) && src.includes(String.raw`\\IfFileExists{enumitem.sty}`),
	"PDF preamble should make cosmetic heading/list packages optional.",
);
assert.ok(
	src.includes(String.raw`\\IfFileExists{varwidth.sty}`) && src.includes(String.raw`\\parbox{\\dimexpr\\linewidth-2\\fboxsep-2\\fboxrule\\relax}`),
	"PDF annotation boxes should use varwidth when available and a parbox fallback otherwise.",
);
assert.ok(
	src.includes(String.raw`\\newcommand{\\piannotation}[1]{%`) && src.includes(String.raw`\\fcolorbox{PiAnnotationBorder}{PiAnnotationBg}{%`),
	"PDF annotation macro should use a boxed annotation style instead of raw soul highlighting.",
);
assert.ok(
	src.includes(String.raw`\\newcommand{\\PiDiffAddTok}[1]{\\textcolor{PiDiffAddText}{#1}}`),
	"PDF preamble should define dedicated diff add token colours.",
);
assert.ok(
	src.includes(String.raw`\\IfFileExists{framed.sty}`) &&
		src.includes(String.raw`\\definecolor{shadecolor}{HTML}{F6F8FA}`) &&
		src.includes(String.raw`\\renewenvironment{Shaded}{\\begin{snugshade}}{\\end{snugshade}}`),
	"PDF preamble should add a light code-block background when framed is available.",
);
assert.ok(
	src.includes(String.raw`\\IfFileExists{fvextra.sty}`) && src.includes(String.raw`\\RecustomVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},breaklines,breakanywhere}`),
	"PDF preamble should enable wrap-friendly highlighted verbatim blocks when fvextra is available.",
);
assert.ok(
	src.includes("--pdf-engine-opt=-interaction=nonstopmode") && src.includes("--pdf-engine-opt=-halt-on-error"),
	"PDF export should pass non-interactive LaTeX engine options when using LaTeX engines.",
);
assert.match(
	src,
	/child\.stdout\.on\("data", \(chunk: Buffer \| string\) => \{\s*stdoutChunks\.push/s,
	"PDF subprocess stdout should be drained so verbose LaTeX output cannot block the command.",
);
assert.ok(
	src.includes("PI_MARKDOWN_PREVIEW_PDF_TIMEOUT_MS") && src.includes("pandoc PDF export timed out"),
	"PDF export should have a configurable timeout instead of hanging indefinitely.",
);

assert.match(
	src,
	/resolvePath\(ctx\.cwd,\s*expanded\)/,
	"--file paths should resolve against ctx.cwd.",
);

assert.match(
	src,
	/if \(baseLower === "dockerfile"\) return "dockerfile";/,
	"Dockerfile basename detection should be supported.",
);
assert.match(
	src,
	/if \(baseLower === "makefile"\) return "makefile";/,
	"Makefile basename detection should be supported.",
);
assert.match(
	src,
	/const MARKDOWN_EXTENSIONS = new Set\(\["md", "markdown", "mdx", "rmd", "qmd"\]\);/,
	"Markdown extension detection should include .qmd files.",
);

assert.match(
	src,
	/function formatMarkdownImageDestination\s*\(/,
	"Missing markdown image destination formatter.",
);
assert.match(
	src,
	/formatMarkdownImageDestination\(path\)/,
	"Obsidian image normalization should use destination formatter.",
);

assert.match(
	src,
	/resourcePath = ctx\.cwd;/,
	"Assistant-response previews should resolve relative local images against ctx.cwd.",
);

assert.match(src, /function getLongestFenceRun\s*\(/, "Missing adaptive fence-length helper.");
assert.match(src, /function normalizeMarkdownFencedBlocks\s*\(/, "Missing fenced-block normalization helper.");
assert.match(
	src,
	/normalizeMarkdownFencedBlocks\(normalizeObsidianImages\(normalizeMathDelimiters\(markdown\)\)\)/,
	"Preview/browser paths should normalize fenced blocks before pandoc rendering.",
);
assert.match(
	src,
	/normalizeSubSupTags\(normalizeMarkdownFencedBlocks\(normalizeObsidianImages\(normalizeMathDelimiters\(markdown\)\)\)\)/,
	"PDF export should normalize fenced blocks before pandoc rendering.",
);
assert.match(
	src,
	/const markerLength = Math\.max\(3, \(markerChar === "`" \? maxBackticks : maxTildes\) \+ 1\);/,
	"Code-file wrapping should choose a fence longer than any inner fence run.",
);

assert.match(src, /from "\.\/shared\/annotation-scanner\.js"/, "Markdown preview should import the shared annotation scanner.");
assert.match(src, /const PREVIEW_ANNOTATION_PLACEHOLDER_PREFIX = "PIMDPREVIEWANNOT";/, "Missing browser preview annotation placeholder prefix.");
assert.match(src, /const ANNOTATION_HELPERS_SOURCE = readFileSync\(new URL\("\.\/client\/annotation-helpers\.js", import\.meta\.url\), "utf-8"\);/, "Browser preview should embed the annotation helper script.");
assert.match(src, /function prepareBrowserPreviewMarkdown\s*\(/, "Missing browser preview annotation preparation helper.");
assert.match(src, /prepareMarkdownForPandocPreview\(normalizedMarkdown, PREVIEW_ANNOTATION_PLACEHOLDER_PREFIX\)/, "Browser preview should replace prose annotations with placeholders before pandoc.");
assert.match(src, /buildBrowserHtmlFromPandocFragment\(fragmentHtml, style, resourcePath, annotationPlaceholders(?:,\s*(?:previewFontSizePx|fontSizePx))?\)/, "Browser preview HTML builder should receive annotation placeholders.");

assert.match(src, /function escapeLatexText\s*\(/, "Missing PDF annotation LaTeX escaping helper.");
assert.match(src, /function getMathPattern\s*\(/, "Missing shared PDF annotation math-pattern helper.");
assert.ok(
	src.includes(String.raw`return /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;`),
	"PDF annotation escaping should preserve inline and display math segments.",
);
assert.match(src, /function renderAnnotationPdfLatex\s*\(/, "Missing markdown-ish PDF annotation renderer.");
assert.match(src, /function renderAnnotationCodeSpanPdfLatex\s*\(/, "Missing PDF annotation code-span renderer.");
assert.match(src, /function renderAnnotationPlainTextPdfLatex\s*\(/, "Missing PDF annotation emphasis renderer.");
assert.match(src, /const cleaned = renderAnnotationPdfLatex\(marker\.body\);/, "PDF prose annotation replacement should use the markdown-ish annotation renderer.");
assert.match(src, /return transformMarkdownOutsideFences\(markdown, \(segment(?::\s*string)?\) => replaceAnnotationMarkersForPdfInSegment\(segment\)\);/, "PDF prose annotation replacement should transform only markdown outside fences.");

assert.match(src, /function decodeGeneratedLatexCodeText\s*\(/, "Missing generated-LaTeX code-text decode helper.");
assert.ok(
	src.includes("decodeGeneratedLatexCodeText")
		&& src.includes("textbackslash")
		&& src.includes("textasciigrave")
		&& src.includes("textasciitilde")
		&& src.includes("textasciicircum")
		&& src.includes(String.raw`.replace(/\\\^\{\}/g, "^")`),
	"Diff annotation PDF rewrite should decode pandoc's escaped code-text sequences before preserving math and inline code spans.",
);
assert.match(src, /function readVerbatimMathOperand\s*\(/, "Missing verbatim-safe diff math operand reader.");
assert.match(src, /function makeHighlightingMathScriptsVerbatimSafe\s*\(/, "Missing verbatim-safe diff math rewrite helper.");
assert.ok(src.includes("\\sb") && src.includes("\\sp"), "Verbatim-safe diff math should rewrite sub/superscripts via \\sb/\\sp.");
assert.match(src, /const cleaned = makeHighlightingMathScriptsVerbatimSafe\(renderAnnotationPdfLatex\(markerText\)\);/, "Diff token annotation rewrite should use the markdown-ish PDF annotation renderer plus verbatim-safe math rewrite.");
assert.match(src, /function replaceAnnotationMarkersInDiffTokenLine\s*\(/, "Missing diff-token annotation rewrite helper.");
assert.match(src, /function rewriteGeneratedDiffHighlighting\s*\(/, "Missing generated LaTeX diff rewrite helper.");
assert.match(src, /function renderMarkdownToPdfViaGeneratedLatex\s*\(/, "Missing generated-LaTeX PDF path for diff exports.");
assert.match(
	src,
	/hasMarkdownDiffFence\(markdownForPdf\)/,
	"PDF export should route diff-containing markdown through the generated-LaTeX rewrite path.",
);

assert.match(src, /const annotationHelpers = window\.PiMarkdownPreviewAnnotationHelpers \|\| null;/, "Browser preview should use the embedded annotation helper bundle.");
assert.match(src, /const applyPreviewAnnotationPlaceholders = \(root\) =>/, "Missing browser preview annotation placeholder application helper.");
assert.match(src, /typeof annotationHelpers\.renderPreviewAnnotationHtml === 'function'/, "Browser preview markers should render safe inline emphasis/code HTML from the helper.");
assert.match(src, /const decorateDiffCodeBlocks = \(root\) =>/, "Missing diff-preview decoration helper.");
assert.ok(src.includes("diff-add-line"), "Browser preview should classify added diff lines.");
assert.ok(src.includes("diff-del-line"), "Browser preview should classify deleted diff lines.");
assert.ok(src.includes("diff-header-line"), "Browser preview should classify diff header lines.");
assert.ok(src.includes("diff-meta-line"), "Browser preview should classify diff metadata lines.");
assert.ok(src.includes("diff-hunk-line"), "Browser preview should classify diff hunk lines.");
assert.ok(
	src.includes("if (/^\\\\+(?!\\\\+\\\\+)/.test(text)) {"),
	"Browser diff styling should avoid misclassifying +++ header lines as added lines.",
);
assert.ok(
	src.includes("} else if (/^-(?!--)/.test(text)) {"),
	"Browser diff styling should avoid misclassifying --- header lines as deleted lines.",
);
assert.match(src, /const renderAnnotationMarkerMath = async \(root\) =>/, "Missing annotation-marker math rendering helper.");
assert.match(src, /await mathJax\.typesetPromise\(markers\);/, "Browser annotation math rendering should typeset full marker elements so emphasis/code markup survives.");

assert.ok(
	src.includes("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"),
	"Browser/terminal preview should include a MathJax fallback loader for unsupported pandoc math.",
);
assert.match(
	src,
	/const renderMathFallback = async \(root\) =>/,
	"Expected targeted MathJax fallback for pandoc-unsupported preview equations.",
);
assert.match(
	src,
	/await renderMermaid\(\);\s*applyPreviewAnnotationPlaceholders\(root\);\s*decorateDiffCodeBlocks\(root\);\s*await renderAnnotationMarkerMath\(root\);\s*await renderMathFallback\(root\);/s,
	"Browser preview should apply preview placeholders, decorate diffs, render annotation math, then run general math fallback.",
);

const annotationFixture = await readFile(new URL("./annotation-markdownish.md", import.meta.url), "utf8");
const scanner = await import(new URL("../shared/annotation-scanner.js", import.meta.url));
await import(new URL("../client/annotation-helpers.js", import.meta.url));
const browserHelpers = globalThis.PiMarkdownPreviewAnnotationHelpers;

assert.ok(browserHelpers, "PiMarkdownPreviewAnnotationHelpers did not load for regression checks.");

assert.deepEqual(
	scanner.collectInlineAnnotationMarkers("A [an: use [docs](https://example.com/docs)] and [an: prefer `npm test` here] plus `[an: literal]`.").map((marker) => marker.body),
	["use [docs](https://example.com/docs)", "prefer `npm test` here"],
	"Shared annotation scanner should keep markdown-ish annotation bodies intact while ignoring inline-code literals.",
);
assert.equal(
	scanner.hasMarkdownAnnotationMarkers("Literal `[an: note]` sample"),
	false,
	"Shared annotation scanner should ignore annotation-like inline-code literals.",
);
assert.equal(
	scanner.replaceInlineAnnotationMarkers("Before [an: first] and [an: second [docs](https://example.com/second)].", (marker) => `{ANNOT:${scanner.normalizeAnnotationText(marker.body)}}`),
	"Before {ANNOT:first} and {ANNOT:second [docs](https://example.com/second)}.",
	"Shared annotation replacement should preserve nested markdown-ish annotation bodies.",
);
const preparedShared = scanner.prepareMarkdownForPandocPreview(annotationFixture, "TESTANNOT");
assert.equal(preparedShared.placeholders.length, 7, "Shared pandoc-preview preparation should replace all prose annotations outside fences.");
assert.deepEqual(
	preparedShared.placeholders.map((entry) => entry.text),
	[
		"note",
		"see https://example.com/docs?a=1&b=2",
		"use [docs](https://example.com/docs)",
		"prefer `npm test` here",
		"keep *focus* and _tone_",
		"first",
		"second [docs](https://example.com/second)",
	],
	"Shared pandoc-preview preparation should preserve markdown-ish annotation label text.",
);
assert.match(
	preparedShared.markdown,
	/```md\n\[an: literal \[docs\]\(https:\/\/example\.com\/literal\)\] should stay literal inside fenced code\n```/,
	"Shared pandoc-preview preparation should leave fenced annotation-like literals untouched.",
);

assert.deepEqual(
	browserHelpers.collectInlineAnnotationMarkers("Multiple [an: first] markers [an: second [docs](https://example.com/second)] here.").map((marker) => marker.body),
	["first", "second [docs](https://example.com/second)"],
	"Browser annotation helper should parse multiple markdown-ish annotations on one line.",
);
assert.equal(
	browserHelpers.renderPreviewAnnotationHtml("keep *focus* and **tone** plus `npm test`"),
	"keep <em>focus</em> and <strong>tone</strong> plus <code>npm test</code>",
	"Browser annotation helper should render safe inline emphasis and code.",
);
assert.equal(
	browserHelpers.renderPreviewAnnotationHtml("use [docs](https://example.com/docs) and https://example.com/docs"),
	"use [docs](https://example.com/docs) and https://example.com/docs",
	"Browser annotation helper should not activate links inside annotation badges.",
);
const preparedBrowser = browserHelpers.prepareMarkdownForPandocPreview(annotationFixture, "TESTANNOT");
assert.equal(preparedBrowser.placeholders.length, 7, "Browser annotation helper should prepare preview placeholders for prose annotations.");
assert.ok(preparedBrowser.markdown.includes("TESTANNOT0TOKEN") && preparedBrowser.markdown.includes("TESTANNOT6TOKEN"), "Browser annotation helper should inject deterministic preview placeholder tokens.");
assert.equal(
	browserHelpers.prepareMarkdownForPandocPreview("- `[an: prefer \\`npm test\\` here]`\n- [an: keep *focus* and _tone_!]", "TESTANNOT").placeholders.length,
	1,
	"Browser annotation helper should ignore fully inline-code annotation examples without desynchronizing later parsing.",
);

const transpiledIndexPath = resolve(process.cwd(), `.pi-markdown-preview-registration-test-${process.pid}.mjs`);
const transpiledIndexOutput = ts.transpileModule(src, {
	compilerOptions: {
		module: ts.ModuleKind.ES2022,
		target: ts.ScriptTarget.ES2022,
	},
	fileName: sourcePath,
}).outputText;
function exposeTranspiledFunction(transpiledSource, functionName) {
	for (const prefix of ["async function", "function"]) {
		const marker = `${prefix} ${functionName}(`;
		if (!transpiledSource.includes(marker)) continue;
		return transpiledSource.replace(marker, `export ${marker}`);
	}
	assert.fail(`Regression harness could not expose ${functionName}.`);
}

let transpiledIndex = transpiledIndexOutput;
for (const functionName of [
	"throwIfMermaidRenderFailed",
	"usesSupportedMermaidIconPack",
	"buildBlockAwarePageClips",
	"collectPreviewPageLayout",
	"extractAssistantMarkdownContent",
	"getAssistantResponseKey",
	"findBrowserExecutable",
	"getBrowserCandidates",
	"getBrowserOpenTarget",
	"getCmuxBrowserOpenCommand",
	"getLastAssistantResponse",
	"getPiManagedMermaidCliPath",
	"getPreviewCacheDir",
	"parsePreviewArgs",
	"prepareFilePreview",
	"resolvePiAgentDir",
]) {
	transpiledIndex = exposeTranspiledFunction(transpiledIndex, functionName);
}

let extensionFactory;
let buildBlockAwarePageClips;
let buildMermaidBrowserModule;
let collectPreviewPageLayout;
let extractAssistantMarkdownContent;
let getAssistantResponseKey;
let findBrowserExecutable;
let getBrowserCandidates;
let getBrowserOpenTarget;
let getCmuxBrowserOpenCommand;
let getLastAssistantResponse;
let getPiManagedMermaidCliPath;
let getPreviewBrowserLaunchOptions;
let getPreviewCacheDir;
let parsePreviewArgs;
let prepareFilePreview;
let resolvePiAgentDir;
let throwIfMermaidRenderFailed;
let usesSupportedMermaidIconPack;
try {
	await writeFile(transpiledIndexPath, transpiledIndex, "utf8");
	({ default: extensionFactory, buildBlockAwarePageClips, buildMermaidBrowserModule, collectPreviewPageLayout, extractAssistantMarkdownContent, getAssistantResponseKey, findBrowserExecutable, getBrowserCandidates, getBrowserOpenTarget, getCmuxBrowserOpenCommand, getLastAssistantResponse, getPiManagedMermaidCliPath, getPreviewBrowserLaunchOptions, getPreviewCacheDir, parsePreviewArgs, prepareFilePreview, resolvePiAgentDir, throwIfMermaidRenderFailed, usesSupportedMermaidIconPack } = await import(`${pathToFileURL(transpiledIndexPath).href}?test=${Date.now()}`));
} finally {
	await rm(transpiledIndexPath, { force: true });
}

const testHomeDirectory = join(process.cwd(), ".pi-markdown-preview-test-home");
const customPiAgentDir = join(testHomeDirectory, ".local", "share", "pi");
assert.equal(
	resolvePiAgentDir({}, testHomeDirectory),
	join(testHomeDirectory, ".pi", "agent"),
	"Pi agent directory resolution should preserve the standard default.",
);
assert.equal(
	getPreviewCacheDir({}, testHomeDirectory),
	join(testHomeDirectory, ".pi", "cache", "markdown-preview"),
	"Preview caching should preserve the standard default location.",
);
assert.equal(
	resolvePiAgentDir({ PI_CODING_AGENT_DIR: customPiAgentDir }, testHomeDirectory),
	customPiAgentDir,
	"Pi agent directory resolution should honor PI_CODING_AGENT_DIR.",
);
assert.equal(
	getPreviewCacheDir({ PI_CODING_AGENT_DIR: customPiAgentDir }, testHomeDirectory),
	join(customPiAgentDir, "cache", "markdown-preview"),
	"Preview caching should stay under a custom Pi agent directory.",
);
assert.equal(
	getPreviewCacheDir({ PI_CODING_AGENT_DIR: "~/custom-pi" }, testHomeDirectory),
	join(testHomeDirectory, "custom-pi", "cache", "markdown-preview"),
	"Preview caching should expand a home-relative Pi agent directory.",
);
const mermaidCliExecutable = process.platform === "win32" ? "mmdc.cmd" : "mmdc";
assert.equal(
	getPiManagedMermaidCliPath({}, testHomeDirectory),
	join(testHomeDirectory, ".pi", "agent", "npm", "node_modules", ".bin", mermaidCliExecutable),
	"Managed Mermaid CLI discovery should preserve the standard Pi agent directory.",
);
assert.equal(
	getPiManagedMermaidCliPath({ PI_CODING_AGENT_DIR: customPiAgentDir }, testHomeDirectory),
	join(customPiAgentDir, "npm", "node_modules", ".bin", mermaidCliExecutable),
	"Managed Mermaid CLI discovery should stay under a custom Pi agent directory.",
);

assert.equal(getBrowserOpenTarget("https://127.0.0.1:4321/?token=test"), "https://127.0.0.1:4321/?token=test", "Browser opening should preserve HTTP URLs used by watch mode.");
const browserOpenFixturePath = join(testHomeDirectory, "preview.html");
assert.equal(getBrowserOpenTarget(browserOpenFixturePath), pathToFileURL(browserOpenFixturePath).href, "Browser opening should continue converting local paths to file URLs.");
assert.deepEqual(
	getCmuxBrowserOpenCommand("http://127.0.0.1:4321/?token=test", {
		CMUX_WORKSPACE_ID: "workspace-id",
		CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
	}),
	{
		command: "/Applications/cmux.app/Contents/Resources/bin/cmux",
		args: ["browser", "open", "http://127.0.0.1:4321/?token=test", "--workspace", "workspace-id", "--focus", "true"],
	},
	"Browser previews launched inside cmux should open a focused browser split in the caller workspace.",
);
assert.equal(getCmuxBrowserOpenCommand("https://example.com", {}), undefined, "Browser previews outside cmux should retain the system-browser opener.");

const parsedBrowserWatch = parsePreviewArgs("--browser --watch --font-size 14");
assert.equal(parsedBrowserWatch.target, "browser");
assert.equal(parsedBrowserWatch.watch, true);
assert.equal(parsedBrowserWatch.fontSizePx, 14);
const parsedShortBrowserWatch = parsePreviewArgs("-b -w");
assert.equal(parsedShortBrowserWatch.target, "browser", "-b should select the browser target.");
assert.equal(parsedShortBrowserWatch.watch, true, "-w should enable browser watch mode.");
assert.equal(parsePreviewArgs("--browser --stop").stop, true, "Browser watch should support an explicit stop operation.");
assert.equal(parsePreviewArgs("watch").file, "watch", "Bare watch should remain a valid file path rather than becoming a new alias.");
assert.equal(parsePreviewArgs("w").file, "w", "Bare w should remain a valid file path rather than becoming a short flag.");
assert.match(parsePreviewArgs("-w").error ?? "", /only available for browser previews/, "Short watch mode should still require the browser target.");
const parsedExplicitFileWatch = parsePreviewArgs("--browser -w --file report.md");
assert.equal(parsedExplicitFileWatch.watch, true);
assert.equal(parsedExplicitFileWatch.file, "report.md", "Browser watch should accept an explicit file input.");
const parsedBareFileWatch = parsePreviewArgs("-b -w report.md");
assert.equal(parsedBareFileWatch.target, "browser");
assert.equal(parsedBareFileWatch.watch, true);
assert.equal(parsedBareFileWatch.file, "report.md", "Browser watch should accept a bare file path.");
assert.equal(parsePreviewArgs('-b -w "reports/my report.md"').file, "reports/my report.md", "Browser file watch should preserve quoted paths with spaces.");
assert.match(parsePreviewArgs("-b -w --pick").error ?? "", /cannot be combined with --pick/, "File/response watch should remain incompatible with the response picker.");
assert.match(parsePreviewArgs("-b --stop report.md").error ?? "", /--stop cannot be combined with a file/, "Stopping the single active watcher should not accept a file target.");
assert.match(parsePreviewArgs("-b -w --stop").error ?? "", /Cannot use --watch and --stop together/, "Short watch and stop operations should be mutually exclusive.");
assert.deepEqual(prepareFilePreview("report.md", "# Report"), { markdown: "# Report", isLatex: false });
assert.deepEqual(prepareFilePreview("report.tex", "\\section{Report}"), { markdown: "\\section{Report}", isLatex: true });
const preparedCodeFile = prepareFilePreview("example.ts", "const answer = 42;");
assert.equal(preparedCodeFile.isLatex, false);
assert.match(preparedCodeFile.markdown, /```typescript/);
assert.match(preparedCodeFile.markdown, /const answer = 42;/);
assert.equal(
	extractAssistantMarkdownContent([
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: "First block" },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
		{ type: "text", text: "Second block" },
	]),
	"First block\n\nSecond block",
	"Browser watch should retain only visible assistant text when reconciling compatible-host agent_end messages.",
);
assert.equal(extractAssistantMarkdownContent([{ type: "thinking", thinking: "private" }]), undefined, "Browser watch should not expose thinking-only content.");
assert.equal(getAssistantResponseKey({ responseId: "provider-response", timestamp: 10 }, "fallback"), "response:provider-response");
assert.equal(getAssistantResponseKey({ timestamp: 10 }, "fallback"), "response-time:10", "Session and compatible-host events should derive the same response identity from timestamps.");
assert.equal(getAssistantResponseKey({}, "fallback"), "fallback");
assert.equal(getBrowserWatchAbsoluteImagePath("/private/tmp/a%20b.png", "darwin"), "/private/tmp/a b.png");
assert.equal(getBrowserWatchAbsoluteImagePath("file:///private/tmp/a%20b.png", "linux"), "/private/tmp/a b.png");
assert.equal(getBrowserWatchAbsoluteImagePath("C:\\Users\\Oliver\\plot.png", "win32"), "C:\\Users\\Oliver\\plot.png");
assert.equal(getBrowserWatchAbsoluteImagePath("file:///C:/Users/Oliver/My%20Plot.png", "win32"), "C:\\Users\\Oliver\\My Plot.png");
assert.equal(getBrowserWatchAbsoluteImagePath("https://example.com/plot.png", "darwin"), undefined);
assert.equal(getBrowserWatchAbsoluteImagePath("//example.com/plot.png", "darwin"), undefined);
assert.equal(getBrowserWatchAbsoluteImagePath("images/plot.png", "darwin"), undefined);
assert.equal(getBrowserWatchAbsoluteImagePath("\\\\server\\share\\plot.png", "win32"), undefined, "Watch mode should not turn UNC image references into network filesystem reads.");
const rewrittenAbsoluteImages = [];
const rewrittenAbsoluteImageHtml = rewriteBrowserWatchAbsoluteImageSources(
	'<p><img src="/private/tmp/a%20b.png" /><img src="images/plot.png" /><img src="https://example.com/plot.png" /><img src="/private/tmp/notes.txt" /></p>',
	(absolutePath, contentType) => {
		rewrittenAbsoluteImages.push({ absolutePath, contentType });
		return "/authenticated-image/one";
	},
	"darwin",
);
assert.deepEqual(rewrittenAbsoluteImages, [{ absolutePath: "/private/tmp/a b.png", contentType: "image/png" }]);
assert.match(rewrittenAbsoluteImageHtml, /src="\/authenticated-image\/one"/);
assert.match(rewrittenAbsoluteImageHtml, /src="images\/plot\.png"/);
assert.match(rewrittenAbsoluteImageHtml, /src="https:\/\/example\.com\/plot\.png"/);
assert.match(rewrittenAbsoluteImageHtml, /src="\/private\/tmp\/notes\.txt"/, "Unsupported absolute file types should not gain an authenticated route.");
assert.deepEqual(
	getLastAssistantResponse({
		sessionManager: {
			getBranch: () => [
				{ type: "message", id: "response-one", message: { role: "assistant", content: [{ type: "text", text: "Repeated response" }] } },
				{ type: "message", id: "response-two", message: { role: "assistant", content: [{ type: "text", text: "Repeated response" }] } },
			],
		},
	}),
	{ markdown: "Repeated response", responseKey: "session:response-two" },
	"Watch history should distinguish separate assistant messages even when their rendered Markdown is identical.",
);

async function assertBrowserWatchServer() {
	const parent = await mkdtemp(join(tmpdir(), "pi-markdown-preview-watch-"));
	const resourceRoot = join(parent, "resources");
	await mkdir(resourceRoot);
	await writeFile(join(resourceRoot, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFile(join(resourceRoot, "notes.txt"), "not a browser preview asset");
	await writeFile(join(parent, "outside.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	const absoluteImagePath = join(parent, "outside.png");
	const initialHtml = `<!doctype html><html><head><base href="file:///tmp/old/" /></head><body><p>Initial response</p><img id="absolute-image" src="${absoluteImagePath}" /><img id="file-url-image" src="${pathToFileURL(absoluteImagePath).href}" /></body></html>`;
	const preparedHtml = prepareBrowserWatchHtml(initialHtml, { revision: 7, revisions: [5, 7, 9] });
	assert.doesNotMatch(preparedHtml, /<base\s/i, "Watch HTML should remove the file base so anchors remain in-page and relative resources use the authenticated local server.");
	assert.match(preparedHtml, /EventSource/, "Watch HTML should subscribe for completion notifications.");
	assert.match(preparedHtml, /const revision = "7";/, "Watch HTML should identify its rendered revision.");
	assert.match(preparedHtml, />2 of 3</, "Watch HTML should identify the selected response within bounded history.");
	assert.match(preparedHtml, /id="pi-markdown-preview-watch-previous"[^>]*href="\/?\?revision=5"/, "Watch HTML should link to the previous rendered response.");
	assert.match(preparedHtml, /id="pi-markdown-preview-watch-next"[^>]*href="\/?\?revision=9"/, "Watch HTML should link to the next rendered response.");
	assert.match(preparedHtml, /id="pi-markdown-preview-watch-copy-link"/, "Watch HTML should offer an explicit way to copy an authenticated link for another browser.");
	await assert.rejects(
		createBrowserWatchServer(initialHtml, resourceRoot, { historyLimit: 0 }),
		/positive integer/,
		"Browser watch should reject an invalid history bound.",
	);

	const server = await createBrowserWatchServer(initialHtml, resourceRoot);
	try {
		const watchUrl = new URL(server.url);
		assert.equal(watchUrl.hostname, "127.0.0.1", "Browser watch must bind to loopback only.");
		assert.ok(watchUrl.searchParams.get("token"), "Browser watch URL should carry an unguessable bootstrap token.");

		const unauthorized = await fetch(watchUrl.origin);
		assert.equal(unauthorized.status, 403, "Browser watch routes should reject requests without a token or session cookie.");
		const unauthorizedShare = await fetch(new URL("/__pi_markdown_preview_share__?revision=1", watchUrl.origin));
		assert.equal(unauthorizedShare.status, 403, "Transferable watch links should only be issued to an authenticated preview session.");

		const initialResponse = await fetch(server.url);
		assert.equal(initialResponse.status, 200);
		const contentSecurityPolicy = initialResponse.headers.get("content-security-policy") ?? "";
		assert.match(contentSecurityPolicy, /default-src 'none'/, "Browser watch pages should send a restrictive CSP.");
		assert.match(contentSecurityPolicy, /script-src 'nonce-[^']+' 'strict-dynamic'/, "Browser watch scripts should require a per-response nonce.");
		assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/, "Browser watch pages should block assistant-authored javascript links.");
		const setCookie = initialResponse.headers.get("set-cookie") ?? "";
		assert.match(setCookie, /^pi_markdown_preview_watch_\d+=/, "The bootstrap response should establish a port-specific watch cookie.");
		const cookie = setCookie.split(";", 1)[0];
		const initialBody = await initialResponse.text();
		assert.match(initialBody, /Initial response/);
		assert.match(initialBody, /<script nonce="[^"]+">/, "Trusted preview scripts should carry the CSP nonce.");
		assert.doesNotMatch(initialBody, new RegExp(watchUrl.searchParams.get("token")), "The watch token should not be embedded in the served HTML.");
		assert.match(initialBody, /id="pi-markdown-preview-watch-copy-link"/, "Authenticated watch pages should expose the transferable-link control.");
		const shareResponse = await fetch(new URL("/__pi_markdown_preview_share__?revision=1", watchUrl.origin), { headers: { cookie } });
		assert.equal(shareResponse.status, 200);
		const transferableWatchUrl = new URL(await shareResponse.text());
		assert.equal(transferableWatchUrl.origin, watchUrl.origin);
		assert.equal(transferableWatchUrl.searchParams.get("token"), watchUrl.searchParams.get("token"));
		assert.equal(transferableWatchUrl.searchParams.get("revision"), "1");
		const transferredBootstrap = await fetch(transferableWatchUrl);
		assert.equal(transferredBootstrap.status, 200, "A copied watch link should bootstrap an independent browser without sharing cookies.");
		assert.match(transferredBootstrap.headers.get("set-cookie") ?? "", /^pi_markdown_preview_watch_\d+=/);
		await transferredBootstrap.body?.cancel();
		assert.doesNotMatch(initialBody, new RegExp(absoluteImagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Absolute filesystem paths should not be exposed as browser resource URLs.");
		const absoluteImageRoute = /id="absolute-image" src="([^"]+)"/.exec(initialBody)?.[1];
		const fileUrlImageRoute = /id="file-url-image" src="([^"]+)"/.exec(initialBody)?.[1];
		assert.match(absoluteImageRoute ?? "", /^\/__pi_markdown_preview_absolute_image__\/[a-f\d]{64}$/);
		assert.equal(fileUrlImageRoute, absoluteImageRoute, "Equivalent absolute paths and file URLs should share one authenticated image route.");
		const unauthorizedAbsoluteImage = await fetch(new URL(absoluteImageRoute, watchUrl.origin));
		assert.equal(unauthorizedAbsoluteImage.status, 403, "Absolute image routes should require the watch session cookie.");
		const absoluteImageResponse = await fetch(new URL(absoluteImageRoute, watchUrl.origin), { headers: { cookie } });
		assert.equal(absoluteImageResponse.status, 200, "An exact absolute image referenced by retained watch HTML should be served.");
		assert.equal(absoluteImageResponse.headers.get("content-type"), "image/png");
		assert.deepEqual(new Uint8Array(await absoluteImageResponse.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		const unknownAbsoluteImage = await fetch(new URL(`/__pi_markdown_preview_absolute_image__/${"0".repeat(64)}`, watchUrl.origin), { headers: { cookie } });
		assert.equal(unknownAbsoluteImage.status, 404, "Authenticated clients should not be able to guess arbitrary absolute image paths.");

		const resourceResponse = await fetch(new URL("/pixel.png", watchUrl.origin), { headers: { cookie } });
		assert.equal(resourceResponse.status, 200, "Authenticated watch pages should load relative local images.");
		assert.equal(resourceResponse.headers.get("content-type"), "image/png");
		assert.deepEqual(new Uint8Array(await resourceResponse.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		const unsupportedResource = await fetch(new URL("/__pi_markdown_preview_resource__/notes.txt", watchUrl.origin), { headers: { cookie } });
		assert.equal(unsupportedResource.status, 415, "The local resource route should not expose arbitrary files.");
		assert.equal(await resolveBrowserWatchResource(resourceRoot, "../outside.png"), undefined, "The local resource resolver should reject paths outside the preview working directory.");

		server.updateDocument('<!doctype html><html><head></head><body><p>Updated response</p></body></html>');
		assert.equal(server.revision, 2);
		assert.deepEqual(server.revisions, [1, 2]);
		assert.equal(server.historySize, 2);
		const eventResponse = await fetch(new URL("/__pi_markdown_preview_events__?revision=1&latest=1", watchUrl.origin), { headers: { cookie } });
		assert.equal(eventResponse.status, 200);
		const reader = eventResponse.body.getReader();
		try {
			let eventText = "";
			for (let chunkIndex = 0; chunkIndex < 3 && !eventText.includes("event: reload"); chunkIndex++) {
				const eventChunk = await reader.read();
				eventText += Buffer.from(eventChunk.value ?? []).toString("utf8");
				if (eventChunk.done) break;
			}
			assert.match(eventText, /event: reload/, "A stale browser revision should receive one reload event.");
			assert.match(eventText, /"revision":2,"revisions":\[1,2\]/, "Revision events should include the bounded navigation history.");
		} finally {
			await reader.cancel();
		}

		const historicalResponse = await fetch(new URL("/?revision=1", watchUrl.origin), { headers: { cookie } });
		const historicalBody = await historicalResponse.text();
		assert.match(historicalBody, /Initial response/, "Historical revision URLs should retain earlier rendered responses.");
		assert.match(historicalBody, />1 of 2</, "Historical pages should expose their position in watch history.");
		const updatedResponse = await fetch(watchUrl.origin, { headers: { cookie } });
		assert.equal(updatedResponse.status, 200);
		assert.match(await updatedResponse.text(), /Updated response/, "The root watch URL should serve the latest canonical document.");

		server.updateDocument('<!doctype html><html><head></head><body><p>Restyled response</p></body></html>', { appendToHistory: false });
		assert.equal(server.revision, 3);
		assert.deepEqual(server.revisions, [1, 3], "Replacing the current rendering should not create a duplicate response entry.");
		const replacedRevisionResponse = await fetch(new URL("/?revision=2", watchUrl.origin), { headers: { cookie } });
		const replacedRevisionBody = await replacedRevisionResponse.text();
		assert.match(replacedRevisionBody, /Restyled response/, "An obsolete rendering revision should resolve to its nearest retained response.");
		assert.match(replacedRevisionBody, /const revision = "3";/, "Obsolete URLs should canonicalize to the retained replacement revision.");

		for (let index = 0; index < 20; index++) {
			server.updateDocument(`<!doctype html><html><head></head><body><p>History response ${index}</p></body></html>`);
		}
		assert.equal(server.historySize, 20, "Browser watch should retain at most 20 rendered responses by default.");
		assert.equal(server.revisions.length, 20);
		const evictedRevisionResponse = await fetch(new URL("/?revision=1", watchUrl.origin), { headers: { cookie } });
		const evictedRevisionBody = await evictedRevisionResponse.text();
		assert.match(evictedRevisionBody, /History response 0/, "Evicted revision URLs should resolve to the oldest retained response.");
		assert.match(evictedRevisionBody, /const revision = "4";/, "Evicted revision URLs should be canonicalized to the oldest retained revision.");
		const evictedAbsoluteImage = await fetch(new URL(absoluteImageRoute, watchUrl.origin), { headers: { cookie } });
		assert.equal(evictedAbsoluteImage.status, 404, "Absolute image access should expire when its last referencing response leaves watch history.");

		const waitingServer = await createBrowserWatchServer(initialHtml, resourceRoot, { initialDocumentIsHistory: false });
		try {
			const waitingBody = await (await fetch(waitingServer.url)).text();
			assert.match(waitingBody, /pi-markdown-preview-watch-count[^>]*[^>]*>Waiting</, "The pre-response waiting page should not present itself as response history.");
			waitingServer.updateDocument('<!doctype html><html><head></head><body><p>First completed response</p></body></html>');
			assert.deepEqual(waitingServer.revisions, [2], "The first completed response should replace, rather than follow, the waiting page.");
			assert.equal(waitingServer.historySize, 1);
		} finally {
			await waitingServer.close();
		}
	} finally {
		await server.close();
		await rm(parent, { recursive: true, force: true });
	}
}

await assertBrowserWatchServer();

assert.match(src, /const RENDER_VERSION = "v26";/, "Block-aware pagination should invalidate fixed-slice preview caches.");
assert.match(src, /const MERMAID_BROWSER_VERSION = "11\.16\.0";/, "Browser Mermaid version should match the CLI validator.");
assert.match(
	src,
	/if \(usesSupportedMermaidIconPack\(source\)\) \{\s*args\.push\("--iconPacks", \.\.\.MERMAID_CLI_ICON_PACKS\);\s*\}/,
	"PDF Mermaid rendering should forward icon packs only when a supported icon is present.",
);
assert.equal(usesSupportedMermaidIconPack("flowchart LR\n  source --> target"), false, "Ordinary Mermaid diagrams should remain compatible with older Mermaid CLI versions.");
assert.equal(usesSupportedMermaidIconPack('source@{ icon: "lucide:file-code-2", label: "Source" }'), true, "Lucide icon metadata should enable CLI icon packs.");
assert.equal(usesSupportedMermaidIconPack('github@{ label: "GitHub", icon: "logos:github-icon" }'), true, "Logos icon metadata should enable CLI icon packs.");
assert.equal(usesSupportedMermaidIconPack('custom@{ icon: "custom:thing", label: "Custom" }'), false, "Unregistered icon prefixes should not enable unrelated CLI packs.");

const edgeX86Path = win32Path.join("C:/Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
const defaultWindowsBrowserCandidates = getBrowserCandidates("win32", {});
assert.ok(
	defaultWindowsBrowserCandidates.includes(edgeX86Path),
	"Windows browser discovery should include Edge under Program Files (x86).",
);
const customWindowsEnv = {
	ProgramW6432: "D:/Program Files",
	PROGRAMFILES: "D:/Program Files",
	"PROGRAMFILES(X86)": "D:/Program Files (x86)",
	LOCALAPPDATA: "E:/Users/Ryan/AppData/Local",
};
const customWindowsBrowserCandidates = getBrowserCandidates("win32", customWindowsEnv);
const customEdgeX86Path = win32Path.join(customWindowsEnv["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe");
const perUserEdgePath = win32Path.join(customWindowsEnv.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe");
assert.ok(customWindowsBrowserCandidates.includes(customEdgeX86Path), "Windows discovery should honor the PROGRAMFILES(X86) environment root.");
assert.ok(customWindowsBrowserCandidates.includes(perUserEdgePath), "Windows discovery should include per-user Edge installations under LOCALAPPDATA.");
assert.equal(
	customWindowsBrowserCandidates.filter((candidate) => candidate === win32Path.join(customWindowsEnv.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")).length,
	1,
	"Equivalent Windows program-file roots should not create duplicate browser candidates.",
);
assert.equal(
	findBrowserExecutable("win32", {}, (candidate) => candidate.toLowerCase() === edgeX86Path.toLowerCase()),
	edgeX86Path,
	"Windows discovery should select Edge from Program Files (x86) when it is the installed candidate.",
);
const explicitBrowserPath = "Z:\\Portable\\Chromium\\chrome.exe";
assert.equal(
	findBrowserExecutable(
		"win32",
		{ ...customWindowsEnv, PUPPETEER_EXECUTABLE_PATH: explicitBrowserPath },
		(candidate) => candidate === explicitBrowserPath || candidate === customEdgeX86Path,
	),
	explicitBrowserPath,
	"PUPPETEER_EXECUTABLE_PATH should remain higher priority than discovered Windows installations.",
);

assert.deepEqual(
	buildBlockAwarePageClips(2500, [880, 1700], [], 1000, 10),
	[
		{ y: 0, height: 880 },
		{ y: 880, height: 820 },
		{ y: 1700, height: 800 },
	],
	"Pagination should move cuts to nearby block boundaries without losing pixels.",
);
assert.deepEqual(
	buildBlockAwarePageClips(2500, [], [], 1000, 10),
	[
		{ y: 0, height: 1000 },
		{ y: 1000, height: 1000 },
		{ y: 2000, height: 500 },
	],
	"Pagination should retain fixed-height fallback cuts when no suitable boundary exists.",
);
assert.deepEqual(
	buildBlockAwarePageClips(
		5000,
		[700, 2600, 3400, 4200, 5000],
		[
			{ top: 700, bottom: 2600 },
			{ top: 800, bottom: 2600 },
			{ top: 2600, bottom: 3400 },
			{ top: 3400, bottom: 4200 },
			{ top: 4200, bottom: 5000 },
		],
		2200,
		30,
	),
	[
		{ y: 0, height: 700 },
		{ y: 700, height: 1900 },
		{ y: 2600, height: 1600 },
		{ y: 4200, height: 800 },
	],
	"Pagination should keep fitting blocks and heading groups intact even when that creates a short page.",
);
assert.deepEqual(
	buildBlockAwarePageClips(2100, [100], [{ top: 100, bottom: 1100 }], 1000, 10),
	[
		{ y: 0, height: 1000 },
		{ y: 1000, height: 1000 },
		{ y: 2000, height: 100 },
	],
	"Protected blocks should not create pathologically short pages.",
);
assert.deepEqual(
	buildBlockAwarePageClips(3000, [650, 1300, 1950, 2600], [{ top: 650, bottom: 1100 }], 1000, 3),
	[
		{ y: 0, height: 1000 },
		{ y: 1000, height: 1000 },
		{ y: 2000, height: 1000 },
	],
	"Block-aware cuts should not exceed the configured maximum page count.",
);
assert.deepEqual(buildBlockAwarePageClips(900, [400], [{ top: 400, bottom: 700 }], 1000, 10), [{ y: 0, height: 900 }], "Single-page previews should remain unsplit.");

async function assertPreviewPageLayoutCollection() {
	const { executablePath, args } = getPreviewBrowserLaunchOptions();
	const browser = await puppeteer.launch({ headless: true, executablePath, args });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1200, height: 5200 });
		await page.setContent(`<!doctype html><style>*{box-sizing:border-box}html,body{margin:0}#preview-root>*{margin:0;padding:0}li{display:block;height:800px}</style><div id="preview-root"><p style="height:700px">Intro</p><h2 style="height:100px">Code</h2><pre style="height:1800px">block</pre><ul style="height:2400px"><li>One</li><li>Two</li><li>Three</li></ul></div>`);
		const layout = await collectPreviewPageLayout(page);
		assert.deepEqual(layout.breakCandidates, [700, 2600, 3400, 4200, 5000], "DOM pagination should collect top-level and oversized-list boundaries.");
		assert.ok(layout.protectedRanges.some((range) => range.top === 700 && range.bottom === 2600), "A heading and its following block should form one protected range.");
		assert.ok(layout.protectedRanges.some((range) => range.top === 3400 && range.bottom === 4200), "Oversized lists should protect individual fitting items.");
		assert.ok(!layout.breakCandidates.includes(800), "The collector should not offer an orphaning cut between a heading and its following block.");
	} finally {
		await browser.close();
	}
}

await assertPreviewPageLayoutCollection();

async function assertBrowserWatchReload() {
	const resourceRoot = await mkdtemp(join(tmpdir(), "pi-markdown-preview-watch-browser-"));
	const pixelBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const absoluteImagePath = `${resourceRoot}-absolute.png`;
	await writeFile(join(resourceRoot, "pixel.png"), pixelBytes);
	await writeFile(absoluteImagePath, pixelBytes);
	const server = await createBrowserWatchServer(
		'<!doctype html><html><head></head><body><p>Initial watch document</p><script>window.previewTrustedScriptRan = true;</script></body></html>',
		resourceRoot,
	);
	const { executablePath, args } = getPreviewBrowserLaunchOptions();
	const browser = await puppeteer.launch({ headless: true, executablePath, args });
	try {
		const page = await browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.location.search === "?revision=1");
		assert.equal(await page.evaluate(() => window.previewTrustedScriptRan), true, "Nonce-bearing preview scripts should run under the watch CSP.");
		assert.equal(await page.$eval("#pi-markdown-preview-watch-count", (element) => element.textContent), "1 of 1");

		server.updateDocument('<!doctype html><html><head></head><body><p>Second watch document</p></body></html>');
		await page.waitForFunction(() => window.location.search === "?revision=2" && document.body.textContent?.includes("Second watch document"));
		assert.equal(await page.$eval("#pi-markdown-preview-watch-count", (element) => element.textContent), "2 of 2");

		await page.goBack({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.location.search === "?revision=1" && document.body.textContent?.includes("Initial watch document"));
		await page.goForward({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.location.search === "?revision=2" && document.body.textContent?.includes("Second watch document"));
		await page.goBack({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.location.search === "?revision=1" && document.body.textContent?.includes("Initial watch document"));

		server.updateDocument('<!doctype html><html><head></head><body><p>Third watch document</p></body></html>');
		await page.waitForFunction(() => document.getElementById("pi-markdown-preview-watch-latest")?.textContent === "Latest (new)");
		assert.equal(await page.evaluate(() => window.location.search), "?revision=1", "A historical response should not auto-follow a newly rendered response.");
		assert.match(await page.$eval("body", (element) => element.textContent ?? ""), /Initial watch document/);

		await page.click("#pi-markdown-preview-watch-next");
		await page.waitForFunction(() => window.location.search === "?revision=2" && document.body.textContent?.includes("Second watch document"));
		assert.equal(await page.$eval("#pi-markdown-preview-watch-count", (element) => element.textContent), "2 of 3");
		await page.click("#pi-markdown-preview-watch-latest");
		await page.waitForFunction(() => window.location.search === "?revision=3" && document.body.textContent?.includes("Third watch document"));

		server.updateDocument(`<!doctype html><html><head></head><body><h1 id="updated">Updated watch document</h1><a id="jump" href="#updated">Jump</a><a id="unsafe" href="javascript:window.previewUnsafeLinkRan = true">Unsafe</a><img id="relative-pixel" src="pixel.png" /><img id="absolute-pixel" src="${absoluteImagePath}" /></body></html>`);
		await page.waitForFunction(() => window.location.search === "?revision=4" && document.body.textContent?.includes("Updated watch document"));
		await page.waitForFunction(() => {
			const images = [...document.querySelectorAll("img")];
			return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
		});
		assert.match(
			await page.$eval("#absolute-pixel", (image) => image.getAttribute("src") ?? ""),
			/^\/__pi_markdown_preview_absolute_image__\/[a-f\d]{64}$/,
			"Browser watch should rewrite an explicit absolute image to its authenticated route.",
		);
		await page.click("#jump");
		assert.equal(await page.evaluate(() => window.location.hash), "#updated", "Removing the file base should preserve in-page fragment links.");
		await page.click("#unsafe");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		assert.notEqual(await page.evaluate(() => window.previewUnsafeLinkRan), true, "The watch CSP should block javascript links from rendered Markdown.");
	} finally {
		await browser.close();
		await server.close();
		await rm(resourceRoot, { recursive: true, force: true });
		await rm(absoluteImagePath, { force: true });
	}
}

await assertBrowserWatchReload();

assert.ok(src.includes("const mermaidResult = await browserPage!.evaluate"), "Puppeteer rendering should read structured Mermaid status.");
assert.ok(src.includes("throwIfMermaidRenderFailed(mermaidResult);"), "Puppeteer rendering should invoke the production Mermaid failure guard.");
assert.doesNotMatch(
	src,
	/window\.__mermaidDone === true"[\s\S]{0,100}\.catch\(\(\) => \{\}\)/,
	"Puppeteer rendering should not discard Mermaid readiness timeouts.",
);

const parseRgb = (value) => {
	const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
	assert.equal(channels?.length, 3, `Expected an RGB color, received ${value}`);
	return channels;
};
const relativeLuminance = (color) => {
	const linear = color.map((channel) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrastRatio = (foreground, background) => {
	const lighter = Math.max(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
	const darker = Math.min(relativeLuminance(parseRgb(foreground)), relativeLuminance(parseRgb(background)));
	return (lighter + 0.05) / (darker + 0.05);
};

const mermaidIconFixture = [
	"flowchart LR",
	'  source@{ icon: "lucide:file-code-2", form: "rounded", label: "Source", pos: "b", h: 56 }',
	'  payload@{ shape: "doc", label: "Payload" }',
	'  store@{ shape: "cyl", label: "Store" }',
	'  midtone@{ shape: "rounded", label: "Midtone" }',
	'  github@{ icon: "logos:github-icon", form: "rounded", label: "GitHub", pos: "b", h: 56 }',
	"  source -->|prepare| payload -->|persist| store -->|review| midtone -->|publish| github",
	"  classDef unchanged fill:#f8f9fa,stroke:#868e96,stroke-width:2px",
	"  classDef changed fill:#f3f0ff,stroke:#7950f2,stroke-width:2px",
	"  classDef midtone fill:#808080,stroke:#666666,stroke-width:2px",
	"  class source,store unchanged",
	"  class payload,github changed",
	"  class midtone midtone",
].join("\n");

async function renderMermaidBrowserFixture(theme, fixture, options = {}) {
	const palette = theme === "dark"
		? { background: "#0f1117", surface: "#171b24", text: "#e6edf3", line: "#9aa5b1" }
		: { background: "#f5f7fb", surface: "#ffffff", text: "#1f2328", line: "#57606a" };
	const mermaidConfig = {
		startOnLoad: false,
		theme: "base",
		themeVariables: {
			background: palette.background,
			primaryColor: palette.surface,
			primaryTextColor: palette.text,
			secondaryColor: palette.surface,
			secondaryTextColor: palette.text,
			tertiaryColor: palette.surface,
			tertiaryTextColor: palette.text,
			textColor: palette.text,
			lineColor: palette.line,
			edgeLabelBackground: palette.surface,
		},
	};
	const { executablePath, args } = getPreviewBrowserLaunchOptions();
	const browser = await puppeteer.launch({ headless: true, executablePath, args });
	try {
		const page = await browser.newPage();
		const consoleErrors = [];
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		const fixtureRoot = resolve(process.cwd(), "node_modules");
		const servedFixtures = new Set();
		const iconFixtures = new Map([
			["/@iconify-json/lucide@1/icons.json", { name: "lucide", path: resolve(fixtureRoot, "@iconify-json/lucide/icons.json") }],
			["/@iconify-json/logos@1/icons.json", { name: "logos", path: resolve(fixtureRoot, "@iconify-json/logos/icons.json") }],
		]);
		await page.setRequestInterception(true);
		page.on("request", async (request) => {
			const url = new URL(request.url());
			const mermaidFixture = url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/mermaid@11.16.0/")
				? resolve(fixtureRoot, "mermaid", url.pathname.slice("/npm/mermaid@11.16.0/".length))
				: undefined;
			const iconFixture = url.hostname === "unpkg.com" ? iconFixtures.get(url.pathname) : undefined;
			if (iconFixture && options.failIconPack === iconFixture.name) {
				servedFixtures.add(`failed:${iconFixture.name}`);
				return request.respond({
					status: 503,
					body: JSON.stringify({ error: "fixture unavailable" }),
					contentType: "application/json",
					headers: { "access-control-allow-origin": "*" },
				});
			}
			const localPath = mermaidFixture ?? iconFixture?.path;
			if (!localPath) {
				if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") return request.abort("blockedbyclient");
				return request.continue();
			}
			servedFixtures.add(mermaidFixture ? "mermaid" : iconFixture.name);
			await request.respond({
				body: await readFile(localPath),
				contentType: localPath.endsWith(".json") ? "application/json" : "application/javascript",
				headers: { "access-control-allow-origin": "*" },
			});
		});
		const browserModule = buildMermaidBrowserModule(
			JSON.stringify(mermaidConfig),
			JSON.stringify([
				{ name: "lucide", url: "https://unpkg.com/@iconify-json/lucide@1/icons.json" },
				{ name: "logos", url: "https://unpkg.com/@iconify-json/logos@1/icons.json" },
			]),
		);
		await page.setContent(`<!doctype html><body style="background:${palette.background};color:${palette.text}"><div id="preview-root" style="background:${palette.surface}"><pre class="mermaid"><code>${fixture}</code></pre></div><script type="module">${browserModule}\n(async () => { try { await renderMermaid(); } finally { window.__mermaidDone = true; } })();</script></body>`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => window.__mermaidDone === true, { timeout: 30000 });
		const result = await page.evaluate(() => {
			const isOpaqueColor = (value) => {
				const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
				if (!match) return false;
				const alphaMatch = value.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/);
				return !alphaMatch || Number(alphaMatch[1]) >= 1;
			};
			const findOpaqueFill = (root) => {
				if (!(root instanceof Element)) return "";
				const shape = Array.from(root.querySelectorAll("rect, polygon, path, circle, ellipse")).find((candidate) => (
					isOpaqueColor(getComputedStyle(candidate).fill)
				));
				return shape ? getComputedStyle(shape).fill : "";
			};
			const findOpaqueBackground = (element) => {
				let current = element instanceof Element ? element : null;
				while (current) {
					const background = getComputedStyle(current).backgroundColor;
					if (current instanceof HTMLElement && isOpaqueColor(background)) return background;
					current = current.parentElement;
				}
				return getComputedStyle(document.body).backgroundColor;
			};
			const edgeLabel = document.querySelector(".edgeLabel");
			const failure = document.querySelector(".mermaid-error");
			return {
				mermaidRenderResult: window.__mermaidRenderResult ?? null,
				failurePanel: failure ? { role: failure.getAttribute("role"), text: failure.textContent?.trim() } : null,
				iconCount: document.querySelectorAll(".icon-shape svg").length,
				edgeColor: edgeLabel ? getComputedStyle(edgeLabel).color : "",
				bodyColor: getComputedStyle(document.body).color,
				bodyBackground: getComputedStyle(document.body).backgroundColor,
				previewRootBackground: getComputedStyle(document.querySelector("#preview-root")).backgroundColor,
				iconNodes: Array.from(document.querySelectorAll(".icon-shape")).map((node) => {
					const label = node.querySelector(".nodeLabel");
					const icon = node.querySelector("svg");
					return {
						label: label?.textContent?.trim(),
						labelColor: label ? getComputedStyle(label).color : "",
						labelSurface: findOpaqueBackground(label),
						iconColor: icon ? getComputedStyle(icon).color : "",
						iconSurfaceFill: findOpaqueFill(node.firstElementChild),
						hasPath: Boolean(icon?.querySelector("path")),
					};
				}),
				shapeNodes: Array.from(document.querySelectorAll(".node:not(.icon-shape)")).map((node) => {
					const label = node.querySelector(".nodeLabel");
					const shape = Array.from(node.querySelectorAll("rect, polygon, path, circle, ellipse")).find((candidate) => {
						const fill = getComputedStyle(candidate).fill;
						return fill && fill !== "none" && fill !== "rgba(0, 0, 0, 0)";
					});
					return {
						label: label?.textContent?.trim(),
						labelColor: label ? getComputedStyle(label).color : "",
						shapeFill: shape ? getComputedStyle(shape).fill : "",
					};
				}),
			};
		});
		return { result, consoleErrors, servedFixtures };
	} finally {
		await browser.close();
	}
}

async function assertMermaidIconBrowserRendering(theme) {
	const { result, consoleErrors, servedFixtures } = await renderMermaidBrowserFixture(theme, mermaidIconFixture);
	assert.deepEqual(result.mermaidRenderResult, { status: "success" }, `${theme} Mermaid fixture should report successful rendering.`);
	assert.equal(result.failurePanel, null, `${theme} successful Mermaid rendering should not show a failure panel.`);
	assert.ok(result.iconCount >= 2, `${theme} icon rendering should render icon SVGs rather than placeholders.`);
	assert.deepEqual(result.iconNodes.map(({ label }) => label), ["Source", "GitHub"]);
	assert.ok(result.iconNodes.every((node) => node.hasPath), `${theme} icon nodes should contain rendered SVG paths.`);
	assert.deepEqual(result.shapeNodes.map(({ label }) => label), ["Payload", "Store", "Midtone"]);
	assert.deepEqual(servedFixtures, new Set(["mermaid", "lucide", "logos"]), `${theme} fixture rendering should not use the network.`);
	for (const node of result.iconNodes) {
		assert.ok(contrastRatio(node.iconColor, node.iconSurfaceFill) >= 4.5, `${theme} icon glyphs should meet accessible contrast against their rendered shapes.`);
		assert.ok(contrastRatio(node.labelColor, node.labelSurface) >= 4.5, `${theme} icon labels should meet accessible contrast against their rendered backgrounds.`);
	}
	for (const node of result.shapeNodes) {
		assert.ok(contrastRatio(node.labelColor, node.shapeFill) >= 4.5, `${theme} shape labels should meet accessible contrast.`);
	}
	assert.ok(result.iconNodes.every((node) => node.iconSurfaceFill !== result.bodyBackground), `${theme} icon fixture shapes should differ from the page background.`);
	assert.notEqual(result.previewRootBackground, result.bodyBackground, `${theme} preview card surface should differ from the page background.`);
	assert.ok(result.iconNodes.every((node) => node.labelSurface === result.previewRootBackground), `${theme} icon labels should resolve the preview card as their nearest opaque background.`);
	assert.equal(result.edgeColor, result.bodyColor, `${theme} edge labels should retain theme text color.`);
	assert.ok(result.iconNodes.every((node) => node.labelColor !== result.edgeColor), `${theme} icon labels should remain semantically colored.`);
	assert.notEqual(result.iconNodes[0]?.iconColor, result.iconNodes[1]?.iconColor, `${theme} gray and violet attribution icons should remain distinct.`);
	assert.deepEqual(consoleErrors, [], `${theme} Mermaid rendering should not log console errors.`);
	return result;
}

const darkMermaidResult = await assertMermaidIconBrowserRendering("dark");
const lightMermaidResult = await assertMermaidIconBrowserRendering("light");
assert.ok(
	[...darkMermaidResult.iconNodes, ...lightMermaidResult.iconNodes].some((node) => node.iconColor !== node.labelColor),
	"Surface-aware rendering should allow an icon glyph and label to use different compliant colors.",
);

async function assertMermaidFailurePropagation() {
	const fixture = [
		"flowchart LR",
		'  source@{ icon: "lucide:file-code-2", form: "rounded", label: "Source", pos: "b", h: 56 }',
	].join("\n");
	const { result, consoleErrors, servedFixtures } = await renderMermaidBrowserFixture("dark", fixture, { failIconPack: "lucide" });
	assert.equal(result.mermaidRenderResult?.status, "failed", "Failed icon-pack loading should produce failed Mermaid status.");
	assert.match(result.mermaidRenderResult?.error ?? "", /Failed to load Mermaid icon pack lucide: HTTP 503/);
	assert.equal(result.failurePanel?.role, "alert", "Failed Mermaid rendering should expose an alert panel.");
	assert.match(result.failurePanel?.text ?? "", /Mermaid render failed: Failed to load Mermaid icon pack lucide: HTTP 503/);
	assert.deepEqual(servedFixtures, new Set(["mermaid", "failed:lucide"]), "Failure fixture should remain network-isolated.");
	assert.ok(consoleErrors.some((message) => message.includes("Mermaid render failed:")), "Failed Mermaid rendering should log a browser diagnostic.");
	assert.throws(
		() => throwIfMermaidRenderFailed(result.mermaidRenderResult),
		/Mermaid render failed: Failed to load Mermaid icon pack lucide: HTTP 503/,
		"The production Puppeteer failure guard should reject serialized failed Mermaid status.",
	);
}

await assertMermaidFailurePropagation();

function extractReadmeMermaidIconFixture(readmeSource) {
	const heading = /^### Mermaid icons\s*$/m.exec(readmeSource);
	assert.ok(heading, "README should contain a Mermaid icons section.");
	const remainder = readmeSource.slice(heading.index + heading[0].length);
	const nextHeading = /^#{1,3}\s+\S/m.exec(remainder);
	const section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
	const fence = /```mermaid[^\n]*\r?\n([\s\S]*?)\r?\n```/.exec(section);
	assert.ok(fence?.[1]?.trim(), "README Mermaid icons section should contain a non-empty Mermaid fence.");
	return fence[1].trim();
}

const readmeSource = await readFile(new URL("../README.md", import.meta.url), "utf8");
assert.match(readmeSource, /PDF icon nodes require Mermaid CLI 11\.6\+\./, "README should document the Mermaid CLI version required for PDF icons.");
const readmeMermaidIconFixture = extractReadmeMermaidIconFixture(readmeSource);
const readmeIconMetadataLines = readmeMermaidIconFixture.split("\n").filter((line) => line.includes(" icon: "));
assert.equal(readmeIconMetadataLines.length, 2, "README Mermaid example should document both supported icon packs.");
for (const line of readmeIconMetadataLines) {
	assert.match(
		line,
		/@\{[^{}\r\n]*icon:\s*"(?:lucide|logos):[^"]+"[^{}\r\n]*\}\s*$/,
		"README icon metadata declarations should remain on one source line.",
	);
}

async function assertReadmeMermaidIconRendering(theme) {
	const { result, consoleErrors, servedFixtures } = await renderMermaidBrowserFixture(theme, readmeMermaidIconFixture);
	assert.deepEqual(result.mermaidRenderResult, { status: "success" }, `${theme} README Mermaid example should render successfully.`);
	assert.equal(result.failurePanel, null, `${theme} README Mermaid example should not show a failure panel.`);
	assert.equal(result.iconCount, 2, `${theme} README Mermaid example should render both documented icons.`);
	assert.deepEqual(result.iconNodes.map(({ label }) => label), ["Source", "GitHub"]);
	assert.ok(result.iconNodes.every((node) => node.hasPath), `${theme} README Mermaid icons should contain SVG paths.`);
	assert.deepEqual(servedFixtures, new Set(["mermaid", "lucide", "logos"]), `${theme} README Mermaid example should remain network-isolated.`);
	for (const node of result.iconNodes) {
		assert.ok(contrastRatio(node.iconColor, node.iconSurfaceFill) >= 4.5, `${theme} README icon glyphs should meet accessible contrast.`);
		assert.ok(contrastRatio(node.labelColor, node.labelSurface) >= 4.5, `${theme} README icon labels should meet accessible contrast.`);
	}
	assert.deepEqual(consoleErrors, [], `${theme} README Mermaid example should not log console errors.`);
}

await assertReadmeMermaidIconRendering("dark");
await assertReadmeMermaidIconRendering("light");
function collectExtensionRegistrations() {
	const commands = [];
	const commandDefinitions = new Map();
	const toolDefinitions = [];
	const events = [];
	const pi = {
		on(event) {
			events.push(event);
		},
		registerCommand(name, definition) {
			commands.push(name);
			commandDefinitions.set(name, definition);
		},
		registerTool(definition) {
			toolDefinitions.push(definition);
		},
	};
	extensionFactory(pi);
	return { commands, commandDefinitions, tools: toolDefinitions.map((definition) => definition.name), toolDefinitions, events };
}

const exportToolEnvName = "PI_MARKDOWN_PREVIEW_REGISTER_EXPORT_TOOL";
const previousExportToolEnv = process.env[exportToolEnvName];
try {
	delete process.env[exportToolEnvName];
	const defaultRegistrations = collectExtensionRegistrations();
	assert.deepEqual(defaultRegistrations.events, ["agent_end", "agent_settled", "session_shutdown"], "Browser watch should prefer agent_settled, retain an agent_end fallback for compatible hosts, and clean up on session shutdown.");
	assert.match(defaultRegistrations.commandDefinitions.get("preview-browser").description, /--watch\/-w auto-refreshes completed responses or a file/, "The browser command description should advertise response and file watch modes.");
	assert.deepEqual(
		defaultRegistrations.tools,
		["preview_export"],
		"preview_export should remain registered by default for backward compatibility.",
	);
	const previewExportParameters = defaultRegistrations.toolDefinitions[0].parameters;
	assert.deepEqual(previewExportParameters.required, ["format"], "Only preview_export format should be required.");
	assert.deepEqual(previewExportParameters.properties.format.enum, ["pdf", "html", "png"], "preview_export format should retain its enum values.");
	assert.deepEqual(previewExportParameters.properties.source.enum, ["last_assistant", "file", "markdown"], "Optional preview_export source should retain its enum values.");
	assert.deepEqual(previewExportParameters.properties.inputFormat.enum, ["markdown", "latex"], "Optional preview_export input format should retain its enum values.");
	assert.equal(previewExportParameters.properties.source.type, "string", "Optional enum properties should remain string schemas.");
	assert.equal(Check(previewExportParameters, { format: "pdf" }), true, "preview_export should accept required parameters without optional fields.");
	assert.equal(Check(previewExportParameters, { format: "png", source: "file", path: "report.md", inputFormat: "markdown" }), true, "preview_export should accept valid optional enum values.");
	assert.equal(Check(previewExportParameters, { format: "docx" }), false, "preview_export should reject invalid format values.");
	assert.equal(Check(previewExportParameters, { format: "pdf", source: "other" }), false, "preview_export should reject invalid optional enum values.");
	assert.equal(Check(previewExportParameters, { source: "file" }), false, "preview_export should continue requiring format.");
	assert.equal(Check(previewExportParameters, { format: "pdf", unexpected: true }), false, "preview_export should continue rejecting additional properties.");

	for (const disabledValue of ["0", "false", "FALSE", " no ", "off"]) {
		process.env[exportToolEnvName] = disabledValue;
		const registrations = collectExtensionRegistrations();
		assert.deepEqual(
			registrations.tools,
			[],
			`${exportToolEnvName}=${JSON.stringify(disabledValue)} should omit preview_export registration.`,
		);
		assert.deepEqual(
			registrations.commands,
			["preview", "preview-browser", "preview-pdf", "preview-clear-cache"],
			"Disabling preview_export should not remove slash commands.",
		);
	}

	process.env[exportToolEnvName] = "true";
	assert.deepEqual(
		collectExtensionRegistrations().tools,
		["preview_export"],
		`${exportToolEnvName}=true should explicitly enable preview_export registration.`,
	);
} finally {
	if (previousExportToolEnv === undefined) {
		delete process.env[exportToolEnvName];
	} else {
		process.env[exportToolEnvName] = previousExportToolEnv;
	}
}

console.log("Regression checks passed.");
