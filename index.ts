import { BorderedLoader, DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as PiTuiCompat from "@earendil-works/pi-tui";
import {
	Container,
	deleteKittyImage,
	getCapabilities,
	Image,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, type Stats, unwatchFile, watchFile } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative as relativePath, resolve as resolvePath, sep, win32 as win32Path } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { Type, type TUnsafe } from "typebox";
import {
	hasMarkdownAnnotationMarkers,
	isAnnotationWordChar,
	normalizeAnnotationText,
	prepareMarkdownForPandocPreview,
	readAnnotationProtectedTokenAt,
	replaceInlineAnnotationMarkers,
	transformMarkdownOutsideFences,
} from "./shared/annotation-scanner.js";
import { createBrowserWatchServer } from "./shared/browser-watch-server.js";

// Some compatible hosts support terminal images without Pi's explicit Kitty image-ID API.
// A namespace lookup avoids an ESM load failure and falls back to rendering without targeted deletion.
const allocateImageIdIfAvailable = typeof PiTuiCompat.allocateImageId === "function"
	? PiTuiCompat.allocateImageId
	: undefined;

function resolvePiAgentDir(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	const configured = environment.PI_CODING_AGENT_DIR;
	if (!configured) return join(homeDirectory, ".pi", "agent");
	if (configured === "~") return homeDirectory;
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return join(homeDirectory, configured.slice(2));
	}
	return configured;
}

function getPreviewCacheDir(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	if (!environment.PI_CODING_AGENT_DIR) {
		// Keep the established default while containing custom Pi state under its explicit agent directory.
		return join(homeDirectory, ".pi", "cache", "markdown-preview");
	}
	return join(resolvePiAgentDir(environment, homeDirectory), "cache", "markdown-preview");
}

function getPiManagedMermaidCliPath(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	return join(
		resolvePiAgentDir(environment, homeDirectory),
		"npm", "node_modules", ".bin",
		process.platform === "win32" ? "mmdc.cmd" : "mmdc",
	);
}

const CACHE_DIR = getPreviewCacheDir();
const MERMAID_PDF_CACHE_DIR = join(CACHE_DIR, "mermaid-pdf");
const PREVIEW_ANNOTATION_PLACEHOLDER_PREFIX = "PIMDPREVIEWANNOT";
const ANNOTATION_HELPERS_SOURCE = readFileSync(new URL("./client/annotation-helpers.js", import.meta.url), "utf-8");
const RENDER_VERSION = "v26";
const MERMAID_BROWSER_VERSION = "11.16.0";
const MERMAID_CLI_ICON_PACKS = ["@iconify-json/lucide", "@iconify-json/logos"] as const;
const MERMAID_BROWSER_ICON_PACKS = [
	{ name: "lucide", url: "https://unpkg.com/@iconify-json/lucide@1/icons.json" },
	{ name: "logos", url: "https://unpkg.com/@iconify-json/logos@1/icons.json" },
] as const;
const PI_MERMAID_CLI_PATH = getPiManagedMermaidCliPath();
const DEFAULT_TERMINAL_PREVIEW_FONT_SIZE_PX = 16;
const DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX = 15;
const BROWSER_FILE_WATCH_INTERVAL_MS = 300;
const BROWSER_FILE_WATCH_DEBOUNCE_MS = 150;
const MAX_BROWSER_WATCHES = 8;
const MIN_PREVIEW_FONT_SIZE_PX = 10;
const MAX_PREVIEW_FONT_SIZE_PX = 24;
const DEFAULT_TERMINAL_DEVICE_SCALE_FACTOR = 2;
const MIN_TERMINAL_DEVICE_SCALE_FACTOR = 1;
const MAX_TERMINAL_DEVICE_SCALE_FACTOR = 2.5;
const VIEWPORT_WIDTH_PX = 1200;
const PAGE_HEIGHT_PX = 2200;
const MAX_PREVIEW_PAGES = 30;
const MIN_BLOCK_AWARE_PAGE_FILL_RATIO = 0.65;
const MIN_PROTECTED_PAGE_FILL_RATIO = 0.2;
const MAX_RENDER_HEIGHT_PX = PAGE_HEIGHT_PX * MAX_PREVIEW_PAGES;
const DEFAULT_PDF_RENDER_TIMEOUT_MS = 120000;
const MIN_PDF_RENDER_TIMEOUT_MS = 10000;
const MAX_PDF_RENDER_TIMEOUT_MS = 600000;
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const CMUX_BROWSER_OPEN_TIMEOUT_MS = 5000;

function shouldRegisterPreviewExportTool(): boolean {
	const configured = process.env.PI_MARKDOWN_PREVIEW_REGISTER_EXPORT_TOOL;
	if (configured === undefined) return true;
	return !FALSE_ENV_VALUES.has(configured.trim().toLowerCase());
}

function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
	// Keep the literal-union static type while returning a composable string schema.
	// Some compatible hosts cannot wrap Type.Unsafe schemas with Type.Optional.
	return Type.String({
		enum: values,
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	}) as unknown as TUnsafe<T[number]>;
}

type ThemeMode = "dark" | "light";
type PreviewTarget = "terminal" | "browser" | "pdf";
type PreviewExportFormat = "pdf" | "html" | "png";
type PreviewExportSource = "last_assistant" | "file" | "markdown";
type PreviewInputFormat = "markdown" | "latex";

interface PreviewPalette {
	bg: string;
	card: string;
	panel2: string;
	border: string;
	borderMuted: string;
	text: string;
	muted: string;
	accent: string;
	warn: string;
	error: string;
	ok: string;
	codeBg: string;
	link: string;
	mdHeading: string;
	mdLink: string;
	mdLinkUrl: string;
	mdCode: string;
	mdCodeBlock: string;
	mdCodeBlockBorder: string;
	mdQuote: string;
	mdQuoteBorder: string;
	mdHr: string;
	mdListBullet: string;
	syntaxComment: string;
	syntaxKeyword: string;
	syntaxFunction: string;
	syntaxVariable: string;
	syntaxString: string;
	syntaxNumber: string;
	syntaxType: string;
	syntaxOperator: string;
	syntaxPunctuation: string;
}

interface PreviewStyle {
	themeMode: ThemeMode;
	palette: PreviewPalette;
	cacheKey: string;
}

interface PreviewPage {
	base64Png: string;
	truncatedHeight: boolean;
	index: number;
	total: number;
}

interface RenderPreviewResult {
	pages: PreviewPage[];
	themeMode: ThemeMode;
	truncatedPages: boolean;
}
interface BrowserMermaidRenderResult {
	status: "pending" | "skipped" | "success" | "failed";
	error?: string;
}

function throwIfMermaidRenderFailed(mermaidResult: BrowserMermaidRenderResult | null): void {
	if (mermaidResult?.status !== "failed") return;
	throw new Error(`Mermaid render failed: ${mermaidResult.error?.trim() || "Unknown browser error."}`);
}

interface PreviewPageClip {
	y: number;
	height: number;
}

interface PreviewProtectedRange {
	top: number;
	bottom: number;
}

interface PreviewPageLayout {
	breakCandidates: number[];
	protectedRanges: PreviewProtectedRange[];
}

interface CachedPage {
	buffer: Buffer;
	truncatedHeight: boolean;
	pageCount?: number;
	truncatedPages?: boolean;
}

interface RenderWithLoaderResult {
	preview: RenderPreviewResult;
	supportsCustomUi: boolean;
}

interface PreviewAnnotationPlaceholder {
	token: string;
	text: string;
	title: string;
}

interface ResolvedPreviewInput {
	markdown: string;
	resourcePath: string | undefined;
	isLatex: boolean;
	source: PreviewExportSource;
	sourceDescription: string;
}

interface PreparedFilePreview {
	markdown: string;
	isLatex: boolean;
}

interface PreviewExportToolDetails {
	format: PreviewExportFormat;
	source: PreviewExportSource;
	sourceDescription: string;
	paths: string[];
	mimeType: string;
	opened: boolean;
	openedPaths?: string[];
	pageCount?: number;
	truncatedPages?: boolean;
	warnings?: string[];
}

const PREVIEW_EXPORT_FORMATS = ["pdf", "html", "png"] as const;
const PREVIEW_EXPORT_SOURCES = ["last_assistant", "file", "markdown"] as const;
const PREVIEW_INPUT_FORMATS = ["markdown", "latex"] as const;

const previewExportSchema = Type.Object({
	format: stringEnum(PREVIEW_EXPORT_FORMATS, {
		description: "Artifact format to produce: pdf, html, or png image page(s).",
	}),
	source: Type.Optional(stringEnum(PREVIEW_EXPORT_SOURCES, {
		description: "Where the input content comes from. Defaults to markdown when markdown is provided, file when path is provided, otherwise last_assistant.",
	})),
	path: Type.Optional(Type.String({
		description: "Source file path when source is file. Relative paths resolve against pi's current working directory. A leading @ is ignored.",
	})),
	markdown: Type.Optional(Type.String({
		description: "Markdown or LaTeX content to render when source is markdown. Prefer this for content composed in the same assistant turn.",
	})),
	inputFormat: Type.Optional(stringEnum(PREVIEW_INPUT_FORMATS, {
		description: "Interpret direct markdown content as markdown or latex. File inputs auto-detect .tex.",
	})),
	resourcePath: Type.Optional(Type.String({
		description: "Base directory for resolving relative images/assets when source is markdown. Defaults to pi's current working directory.",
	})),
	outputPath: Type.Optional(Type.String({
		description: "Optional destination path. Relative paths resolve against pi's current working directory. PNG exports with multiple pages append -1-of-N, -2-of-N, etc.",
	})),
	open: Type.Optional(Type.Boolean({
		description: "Open the generated artifact locally after writing it. Defaults to false for headless/remote sessions.",
	})),
	fontSizePx: Type.Optional(Type.Number({
		description: `Font size for HTML/PNG preview output, ${MIN_PREVIEW_FONT_SIZE_PX}-${MAX_PREVIEW_FONT_SIZE_PX}px.`,
		minimum: MIN_PREVIEW_FONT_SIZE_PX,
		maximum: MAX_PREVIEW_FONT_SIZE_PX,
	})),
}, { additionalProperties: false });

const DARK_PREVIEW_PALETTE: PreviewPalette = {
	bg: "#0f1117",
	card: "#171b24",
	panel2: "#11161f",
	border: "#2d3748",
	borderMuted: "#242b38",
	text: "#e6edf3",
	muted: "#9aa5b1",
	accent: "#5ea1ff",
	warn: "#f9c74f",
	error: "#ff6b6b",
	ok: "#73d13d",
	codeBg: "#11161f",
	link: "#81a2be",
	mdHeading: "#f0c674",
	mdLink: "#81a2be",
	mdLinkUrl: "#666666",
	mdCode: "#8abeb7",
	mdCodeBlock: "#b5bd68",
	mdCodeBlockBorder: "#808080",
	mdQuote: "#808080",
	mdQuoteBorder: "#808080",
	mdHr: "#808080",
	mdListBullet: "#8abeb7",
	syntaxComment: "#6A9955",
	syntaxKeyword: "#569CD6",
	syntaxFunction: "#DCDCAA",
	syntaxVariable: "#9CDCFE",
	syntaxString: "#CE9178",
	syntaxNumber: "#B5CEA8",
	syntaxType: "#4EC9B0",
	syntaxOperator: "#D4D4D4",
	syntaxPunctuation: "#D4D4D4",
};

const LIGHT_PREVIEW_PALETTE: PreviewPalette = {
	bg: "#f5f7fb",
	card: "#ffffff",
	panel2: "#f8fafc",
	border: "#d0d7de",
	borderMuted: "#e0e6ee",
	text: "#1f2328",
	muted: "#57606a",
	accent: "#0969da",
	warn: "#9a6700",
	error: "#cf222e",
	ok: "#1a7f37",
	codeBg: "#f8fafc",
	link: "#547da7",
	mdHeading: "#9a7326",
	mdLink: "#547da7",
	mdLinkUrl: "#767676",
	mdCode: "#5a8080",
	mdCodeBlock: "#588458",
	mdCodeBlockBorder: "#6c6c6c",
	mdQuote: "#6c6c6c",
	mdQuoteBorder: "#6c6c6c",
	mdHr: "#6c6c6c",
	mdListBullet: "#588458",
	syntaxComment: "#008000",
	syntaxKeyword: "#0000FF",
	syntaxFunction: "#795E26",
	syntaxVariable: "#001080",
	syntaxString: "#A31515",
	syntaxNumber: "#098658",
	syntaxType: "#267F99",
	syntaxOperator: "#000000",
	syntaxPunctuation: "#000000",
};

function inferThemeModeFromName(name: string): ThemeMode | undefined {
	const lower = name.toLowerCase();
	if (/\b(light|dawn|day|latte)\b/.test(lower) || lower.includes("-light")) return "light";
	if (/\b(dark|night|moon|mocha)\b/.test(lower) || lower.includes("-dark")) return "dark";
	return undefined;
}

function normalizePreviewFontSizePx(fontSizePx?: number, defaultFontSizePx = DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX): number {
	if (!Number.isFinite(fontSizePx)) return defaultFontSizePx;
	const clamped = Math.max(MIN_PREVIEW_FONT_SIZE_PX, Math.min(MAX_PREVIEW_FONT_SIZE_PX, Number(fontSizePx)));
	return Math.round(clamped * 10) / 10;
}

function clampTerminalDeviceScaleFactor(value: number): number {
	const clamped = Math.max(MIN_TERMINAL_DEVICE_SCALE_FACTOR, Math.min(MAX_TERMINAL_DEVICE_SCALE_FACTOR, value));
	return Math.round(clamped * 100) / 100;
}

function getTerminalDeviceScaleFactor(): number {
	const configured = Number(process.env.PI_MARKDOWN_PREVIEW_DEVICE_SCALE_FACTOR ?? "");
	if (Number.isFinite(configured) && configured > 0) return clampTerminalDeviceScaleFactor(configured);
	return DEFAULT_TERMINAL_DEVICE_SCALE_FACTOR;
}

function getPdfRenderTimeoutMs(): number {
	const configured = Number(process.env.PI_MARKDOWN_PREVIEW_PDF_TIMEOUT_MS ?? "");
	if (Number.isFinite(configured) && configured > 0) {
		return Math.round(Math.max(MIN_PDF_RENDER_TIMEOUT_MS, Math.min(MAX_PDF_RENDER_TIMEOUT_MS, configured)));
	}
	return DEFAULT_PDF_RENDER_TIMEOUT_MS;
}

function getLatexEngineName(engine: string): string {
	return basename(engine).toLowerCase().replace(/\.exe$/, "");
}

function getPandocLatexEngineOptions(engine: string): string[] {
	const engineName = getLatexEngineName(engine);
	if (!["pdflatex", "xelatex", "lualatex", "latexmk"].includes(engineName)) return [];
	return ["--pdf-engine-opt=-interaction=nonstopmode", "--pdf-engine-opt=-halt-on-error"];
}

function formatTimeoutMs(timeoutMs: number): string {
	return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

function toHexByte(value: number): string {
	const clamped = Math.max(0, Math.min(255, Math.round(value)));
	return clamped.toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
	return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function hexToRgb(color: string): { r: number; g: number; b: number } | undefined {
	const value = color.trim();
	const long = value.match(/^#([0-9a-fA-F]{6})$/);
	if (long) {
		const hex = long[1]!;
		return {
			r: Number.parseInt(hex.slice(0, 2), 16),
			g: Number.parseInt(hex.slice(2, 4), 16),
			b: Number.parseInt(hex.slice(4, 6), 16),
		};
	}

	const short = value.match(/^#([0-9a-fA-F]{3})$/);
	if (short) {
		const hex = short[1]!;
		return {
			r: Number.parseInt(hex[0]! + hex[0]!, 16),
			g: Number.parseInt(hex[1]! + hex[1]!, 16),
			b: Number.parseInt(hex[2]! + hex[2]!, 16),
		};
	}

	return undefined;
}

function xterm256ToHex(index: number): string {
	const basic16 = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];

	if (index >= 0 && index < basic16.length) {
		return basic16[index]!;
	}

	if (index >= 16 && index <= 231) {
		const i = index - 16;
		const r = Math.floor(i / 36);
		const g = Math.floor((i % 36) / 6);
		const b = i % 6;
		const values = [0, 95, 135, 175, 215, 255];
		return rgbToHex(values[r]!, values[g]!, values[b]!);
	}

	if (index >= 232 && index <= 255) {
		const gray = 8 + (index - 232) * 10;
		return rgbToHex(gray, gray, gray);
	}

	return "#000000";
}

function ansiColorToCss(ansi: string): string | undefined {
	const trueColorMatch = ansi.match(/\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
	if (trueColorMatch) {
		return rgbToHex(Number(trueColorMatch[1]), Number(trueColorMatch[2]), Number(trueColorMatch[3]));
	}

	const indexedMatch = ansi.match(/\x1b\[(?:38|48);5;(\d{1,3})m/);
	if (indexedMatch) {
		return xterm256ToHex(Number(indexedMatch[1]));
	}

	return undefined;
}

function safeThemeColor(getter: () => string): string | undefined {
	try {
		return ansiColorToCss(getter());
	} catch {
		return undefined;
	}
}

function withAlpha(color: string, alpha: number, fallback: string): string {
	const rgb = hexToRgb(color);
	if (!rgb) return fallback;
	const clamped = Math.max(0, Math.min(1, alpha));
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped.toFixed(2)})`;
}

function adjustBrightness(color: string, factor: number): string {
	const rgb = hexToRgb(color);
	if (!rgb) return color;
	return rgbToHex(
		Math.round(rgb.r * factor),
		Math.round(rgb.g * factor),
		Math.round(rgb.b * factor),
	);
}

function relativeLuminance(color: string): number {
	const rgb = hexToRgb(color);
	if (!rgb) return 0;
	return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

function blendColors(a: string, b: string, t: number): string {
	const rgbA = hexToRgb(a);
	const rgbB = hexToRgb(b);
	if (!rgbA || !rgbB) return a;
	return rgbToHex(
		Math.round(rgbA.r + (rgbB.r - rgbA.r) * t),
		Math.round(rgbA.g + (rgbB.g - rgbA.g) * t),
		Math.round(rgbA.b + (rgbB.b - rgbA.b) * t),
	);
}

function wcagRelativeLuminance(color: string): number {
	const rgb = hexToRgb(color);
	if (!rgb) return 0;
	const linear = [rgb.r, rgb.g, rgb.b].map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(a: string, b: string): number {
	const lumA = wcagRelativeLuminance(a);
	const lumB = wcagRelativeLuminance(b);
	const lighter = Math.max(lumA, lumB);
	const darker = Math.min(lumA, lumB);
	return (lighter + 0.05) / (darker + 0.05);
}

function capBorderContrast(color: string, surface: string, maxContrast: number): string {
	if (!hexToRgb(color) || !hexToRgb(surface)) return color;
	if (contrastRatio(color, surface) <= maxContrast) return color;

	let low = 0;
	let high = 1;
	let result = color;
	for (let i = 0; i < 12; i += 1) {
		const mid = (low + high) / 2;
		const candidate = blendColors(color, surface, mid);
		if (contrastRatio(candidate, surface) > maxContrast) {
			low = mid;
		} else {
			result = candidate;
			high = mid;
		}
	}
	return result;
}

function deriveCanvasColors(
	baseColor: string,
	themeMode: ThemeMode,
): { pageBg: string; cardBg: string; panel2: string } {
	if (themeMode === "dark") {
		const pageBg = adjustBrightness(baseColor, 0.50);
		const cardBg = adjustBrightness(baseColor, 0.60);
		return {
			pageBg,
			cardBg,
			panel2: adjustBrightness(baseColor, 0.72),
		};
	}
	const lum = relativeLuminance(baseColor);
	const lighten = (c: string, amount: number): string => {
		const rgb = hexToRgb(c);
		if (!rgb) return c;
		return rgbToHex(
			Math.round(rgb.r + (255 - rgb.r) * amount),
			Math.round(rgb.g + (255 - rgb.g) * amount),
			Math.round(rgb.b + (255 - rgb.b) * amount),
		);
	};
	if (lum > 0.92) {
		return { pageBg: baseColor, cardBg: "#ffffff", panel2: lighten(baseColor, 0.3) };
	}
	return {
		pageBg: lighten(baseColor, 0.6),
		cardBg: lighten(baseColor, 0.93),
		panel2: lighten(baseColor, 0.45),
	};
}

function adjustCodeBg(cardHex: string, themeMode: ThemeMode): string {
	const rgb = hexToRgb(cardHex);
	if (!rgb) return cardHex;
	if (themeMode === "dark") {
		const f = 0.85;
		return rgbToHex(Math.round(rgb.r * f), Math.round(rgb.g * f), Math.round(rgb.b * f));
	}
	const f = 0.97;
	return rgbToHex(Math.round(rgb.r * f), Math.round(rgb.g * f), Math.round(rgb.b * f));
}

interface ThemeExportPalette {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
}

interface ThemeSourceJson {
	name?: string;
	vars?: Record<string, string | number>;
	colors?: Record<string, string | number>;
	export?: { pageBg?: string | number; cardBg?: string | number; infoBg?: string | number };
}

const themeSourceJsonCache = new Map<string, { mtimeMs: number; json: ThemeSourceJson | null }>();

function resolveThemeExportValue(
	value: string | number | undefined,
	vars: Record<string, string | number>,
	seen: Set<string> = new Set(),
): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "number") return xterm256ToHex(value);

	const token = value.trim();
	if (!token) return undefined;
	if (token.startsWith("#")) return token;

	const varKey = token.startsWith("$") ? token.slice(1) : token;
	if (!varKey || seen.has(varKey)) return token;

	const referenced = vars[varKey];
	if (referenced == null) return token;

	seen.add(varKey);
	return resolveThemeExportValue(referenced, vars, seen) ?? token;
}

function isCssColorValue(value: string | undefined): value is string {
	if (!value) return false;
	const trimmed = value.trim();
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) || /^rgba?\(/i.test(trimmed);
}

function normalizeResolvedThemeColor(value: string | undefined): string | undefined {
	if (!isCssColorValue(value)) return undefined;
	return value.trim();
}

function readThemeSourceJson(theme?: Theme): ThemeSourceJson | undefined {
	const sourcePath = theme?.sourcePath?.trim();
	if (!sourcePath) return undefined;

	try {
		const mtimeMs = statSync(sourcePath).mtimeMs;
		const cached = themeSourceJsonCache.get(sourcePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.json ?? undefined;

		const raw = readFileSync(sourcePath, "utf-8");
		const parsed = JSON.parse(raw) as ThemeSourceJson;
		themeSourceJsonCache.set(sourcePath, { mtimeMs, json: parsed });
		return parsed;
	} catch {
		themeSourceJsonCache.set(sourcePath, { mtimeMs: -1, json: null });
		return undefined;
	}
}

function resolveThemeJsonValue(
	value: string | number | undefined,
	vars: Record<string, string | number>,
): string | undefined {
	return normalizeResolvedThemeColor(resolveThemeExportValue(value, vars));
}

function readThemeExportPalette(theme?: Theme): ThemeExportPalette | undefined {
	const parsed = readThemeSourceJson(theme);
	if (!parsed) return undefined;
	const vars = parsed.vars ?? {};
	const exportSection = parsed.export ?? {};
	const resolved: ThemeExportPalette = {
		pageBg: resolveThemeJsonValue(exportSection.pageBg, vars),
		cardBg: resolveThemeJsonValue(exportSection.cardBg, vars),
		infoBg: resolveThemeJsonValue(exportSection.infoBg, vars),
	};
	return resolved.pageBg || resolved.cardBg || resolved.infoBg ? resolved : undefined;
}

function readThemeColorToken(theme: Theme | undefined, token: string): string | undefined {
	const parsed = readThemeSourceJson(theme);
	if (!parsed) return undefined;
	return resolveThemeJsonValue(parsed.colors?.[token], parsed.vars ?? {});
}

function readThemeVarColor(theme: Theme | undefined, keys: string[]): string | undefined {
	const parsed = readThemeSourceJson(theme);
	if (!parsed) return undefined;
	const vars = parsed.vars ?? {};
	for (const key of keys) {
		const color = resolveThemeJsonValue(vars[key], vars);
		if (color) return color;
	}
	return undefined;
}

function readThemeAnyColor(theme: Theme | undefined, keys: string[]): string | undefined {
	const parsed = readThemeSourceJson(theme);
	if (!parsed) return undefined;
	const vars = parsed.vars ?? {};
	for (const key of keys) {
		const color = resolveThemeJsonValue(parsed.colors?.[key], vars);
		if (color) return color;
	}
	return undefined;
}

function inferThemeModeFromColor(color: string | undefined): ThemeMode | undefined {
	if (!color || !hexToRgb(color)) return undefined;
	return relativeLuminance(color) >= 0.58 ? "light" : "dark";
}

function inferThemeModeFromColorCandidates(...colors: Array<string | undefined>): ThemeMode | undefined {
	for (const color of colors) {
		const inferred = inferThemeModeFromColor(color);
		if (inferred) return inferred;
	}
	return undefined;
}

function getThemeMode(theme?: Theme): ThemeMode {
	const exported = readThemeExportPalette(theme);
	const inferredFromExport = inferThemeModeFromColorCandidates(exported?.pageBg, exported?.cardBg);
	if (inferredFromExport) return inferredFromExport;

	const inferredFromSurface = inferThemeModeFromColorCandidates(
		inferThemeSurfaceColor(theme, "page"),
		inferThemeSurfaceColor(theme, "card"),
		readThemeColorToken(theme, "userMessageBg"),
		readThemeColorToken(theme, "customMessageBg"),
		readThemeColorToken(theme, "toolPendingBg"),
	);
	if (inferredFromSurface) return inferredFromSurface;

	const inferredFromName = inferThemeModeFromName(theme?.name ?? "");
	if (inferredFromName) return inferredFromName;

	return "dark";
}

function inferThemeTextColor(theme: Theme | undefined, themeMode: ThemeMode): string | undefined {
	return readThemeAnyColor(theme, ["text", "userMessageText", "customMessageText", "mdCodeBlock"])
		?? readThemeVarColor(
			theme,
			themeMode === "light"
				? ["text", "fg", "foreground", "textDark1", "fg0", "fg1", "nord0"]
				: ["text", "fg", "foreground", "fg0", "fg1", "subtext1", "subtext0", "nord4", "gray3"],
		);
}

function inferThemeSurfaceColor(theme: Theme | undefined, role: "page" | "card" | "panel2"): string | undefined {
	if (role === "page") {
		return readThemeVarColor(theme, ["pageBg", "bg", "base", "background", "mantle", "bg_dark", "bg0", "nord0"]);
	}
	if (role === "card") {
		return readThemeVarColor(theme, ["cardBg", "surface", "base", "bg", "bg1", "nord1"]);
	}
	return readThemeVarColor(theme, ["infoBg", "surfaceAlt", "surface0", "overlay", "bg_hl", "bg2", "nord2"]);
}

function getPreviewStyle(theme?: Theme): PreviewStyle {
	const themeMode = getThemeMode(theme);
	const fallback = themeMode === "dark" ? DARK_PREVIEW_PALETTE : LIGHT_PREVIEW_PALETTE;

	if (!theme) {
		return {
			themeMode,
			palette: fallback,
			cacheKey: [themeMode, ...Object.values(fallback)].join("|"),
		};
	}

	const exported = readThemeExportPalette(theme);
	const accent =
		safeThemeColor(() => theme.getFgAnsi("mdLink"))
		?? safeThemeColor(() => theme.getFgAnsi("accent"))
		?? readThemeColorToken(theme, "mdLink")
		?? readThemeColorToken(theme, "accent")
		?? fallback.accent;
	const warn = safeThemeColor(() => theme.getFgAnsi("warning")) ?? readThemeColorToken(theme, "warning") ?? fallback.warn;
	const error = safeThemeColor(() => theme.getFgAnsi("error")) ?? readThemeColorToken(theme, "error") ?? fallback.error;
	const ok = safeThemeColor(() => theme.getFgAnsi("success")) ?? readThemeColorToken(theme, "success") ?? fallback.ok;
	const text = safeThemeColor(() => theme.getFgAnsi("text")) ?? inferThemeTextColor(theme, themeMode) ?? fallback.text;

	const surfaceBase =
		safeThemeColor(() => theme.getBgAnsi("userMessageBg"))
		?? safeThemeColor(() => theme.getBgAnsi("customMessageBg"))
		?? readThemeColorToken(theme, "userMessageBg")
		?? readThemeColorToken(theme, "customMessageBg");
	const derived = surfaceBase ? deriveCanvasColors(surfaceBase, themeMode) : undefined;
	const themePageBg = inferThemeSurfaceColor(theme, "page");
	const themeCardBg = inferThemeSurfaceColor(theme, "card");
	const themePanel2 = inferThemeSurfaceColor(theme, "panel2");

	const card =
		exported?.cardBg
		?? themeCardBg
		?? derived?.cardBg
		?? safeThemeColor(() => theme.getBgAnsi("toolPendingBg"))
		?? readThemeColorToken(theme, "toolPendingBg")
		?? fallback.card;
	const panel2 =
		themePanel2
		?? derived?.panel2
		?? safeThemeColor(() => theme.getBgAnsi("selectedBg"))
		?? readThemeColorToken(theme, "selectedBg")
		?? exported?.infoBg
		?? adjustCodeBg(card, themeMode)
		?? fallback.panel2;
	const mdLink = safeThemeColor(() => theme.getFgAnsi("mdLink")) ?? readThemeColorToken(theme, "mdLink") ?? accent;

	const palette: PreviewPalette = {
		bg:
			exported?.pageBg
			?? themePageBg
			?? derived?.pageBg
			?? fallback.bg,
		card,
		panel2,
		border: safeThemeColor(() => theme.getFgAnsi("border")) ?? readThemeColorToken(theme, "border") ?? fallback.border,
		borderMuted: safeThemeColor(() => theme.getFgAnsi("borderMuted")) ?? readThemeColorToken(theme, "borderMuted") ?? fallback.borderMuted,
		text,
		muted: safeThemeColor(() => theme.getFgAnsi("muted")) ?? readThemeColorToken(theme, "muted") ?? fallback.muted,
		accent,
		warn,
		error,
		ok,
		codeBg: panel2,
		link: mdLink,
		mdHeading: safeThemeColor(() => theme.getFgAnsi("mdHeading")) ?? readThemeColorToken(theme, "mdHeading") ?? fallback.mdHeading,
		mdLink,
		mdLinkUrl: safeThemeColor(() => theme.getFgAnsi("mdLinkUrl")) ?? readThemeColorToken(theme, "mdLinkUrl") ?? fallback.mdLinkUrl,
		mdCode: safeThemeColor(() => theme.getFgAnsi("mdCode")) ?? readThemeColorToken(theme, "mdCode") ?? fallback.mdCode,
		mdCodeBlock: safeThemeColor(() => theme.getFgAnsi("mdCodeBlock")) ?? readThemeColorToken(theme, "mdCodeBlock") ?? text,
		mdCodeBlockBorder: safeThemeColor(() => theme.getFgAnsi("mdCodeBlockBorder")) ?? readThemeColorToken(theme, "mdCodeBlockBorder") ?? fallback.mdCodeBlockBorder,
		mdQuote: safeThemeColor(() => theme.getFgAnsi("mdQuote")) ?? readThemeColorToken(theme, "mdQuote") ?? fallback.mdQuote,
		mdQuoteBorder: safeThemeColor(() => theme.getFgAnsi("mdQuoteBorder")) ?? readThemeColorToken(theme, "mdQuoteBorder") ?? fallback.mdQuoteBorder,
		mdHr: safeThemeColor(() => theme.getFgAnsi("mdHr")) ?? readThemeColorToken(theme, "mdHr") ?? fallback.mdHr,
		mdListBullet: safeThemeColor(() => theme.getFgAnsi("mdListBullet")) ?? readThemeColorToken(theme, "mdListBullet") ?? fallback.mdListBullet,
		syntaxComment: safeThemeColor(() => theme.getFgAnsi("syntaxComment")) ?? readThemeColorToken(theme, "syntaxComment") ?? fallback.syntaxComment,
		syntaxKeyword: safeThemeColor(() => theme.getFgAnsi("syntaxKeyword")) ?? readThemeColorToken(theme, "syntaxKeyword") ?? fallback.syntaxKeyword,
		syntaxFunction: safeThemeColor(() => theme.getFgAnsi("syntaxFunction")) ?? readThemeColorToken(theme, "syntaxFunction") ?? fallback.syntaxFunction,
		syntaxVariable: safeThemeColor(() => theme.getFgAnsi("syntaxVariable")) ?? readThemeColorToken(theme, "syntaxVariable") ?? fallback.syntaxVariable,
		syntaxString: safeThemeColor(() => theme.getFgAnsi("syntaxString")) ?? readThemeColorToken(theme, "syntaxString") ?? fallback.syntaxString,
		syntaxNumber: safeThemeColor(() => theme.getFgAnsi("syntaxNumber")) ?? readThemeColorToken(theme, "syntaxNumber") ?? fallback.syntaxNumber,
		syntaxType: safeThemeColor(() => theme.getFgAnsi("syntaxType")) ?? readThemeColorToken(theme, "syntaxType") ?? fallback.syntaxType,
		syntaxOperator: safeThemeColor(() => theme.getFgAnsi("syntaxOperator")) ?? readThemeColorToken(theme, "syntaxOperator") ?? fallback.syntaxOperator,
		syntaxPunctuation: safeThemeColor(() => theme.getFgAnsi("syntaxPunctuation")) ?? readThemeColorToken(theme, "syntaxPunctuation") ?? fallback.syntaxPunctuation,
	};

	return {
		themeMode,
		palette,
		cacheKey: [themeMode, ...Object.values(palette)].join("|"),
	};
}

interface AssistantMessage {
	index: number;
	markdown: string;
	preview: string;
	responseKey: string;
}

interface AssistantResponseSnapshot {
	markdown: string;
	responseKey: string;
}

function extractAssistantMarkdownContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const textBlocks = content.filter((block): block is { type: "text"; text: string } => {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) return false;
		return typeof block.text === "string" && !!block.text.trim();
	});
	return textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("\n\n") : undefined;
}

function getAssistantResponseKey(message: unknown, fallback: string): string {
	if (!message || typeof message !== "object") return fallback;
	if ("responseId" in message && typeof message.responseId === "string" && message.responseId) {
		return `response:${message.responseId}`;
	}
	if ("timestamp" in message && (typeof message.timestamp === "number" || typeof message.timestamp === "string")) {
		return `response-time:${message.timestamp}`;
	}
	return fallback;
}

function getAssistantMessages(ctx: ExtensionContext): AssistantMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: AssistantMessage[] = [];
	let messageIndex = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "assistant") continue;

		const markdown = extractAssistantMarkdownContent(msg.content);
		if (!markdown) continue;
		const firstLine = markdown.split("\n").find((l) => l.trim().length > 0) ?? "";
		const preview = firstLine.replace(/^#+\s*/, "").slice(0, 80);
		const entryFallback = typeof entry.id === "string" && entry.id ? `session:${entry.id}` : `session-index:${messageIndex}`;
		const responseKey = getAssistantResponseKey(msg, entryFallback);
		messages.push({ index: messageIndex, markdown, preview, responseKey });
		messageIndex++;
	}

	return messages;
}

function getLastAssistantResponse(ctx: ExtensionContext): AssistantResponseSnapshot | undefined {
	const messages = getAssistantMessages(ctx);
	if (messages.length === 0) return undefined;
	const latest = messages[messages.length - 1]!;
	return { markdown: latest.markdown, responseKey: latest.responseKey };
}

function getLastAssistantMarkdown(ctx: ExtensionContext): string | undefined {
	return getLastAssistantResponse(ctx)?.markdown;
}

function resolveUserPath(ctx: ExtensionContext, rawPath: string): string {
	const withoutAtPrefix = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const expanded = withoutAtPrefix.startsWith("~/") ? join(homedir(), withoutAtPrefix.slice(2))
		: withoutAtPrefix === "~" ? homedir()
		: withoutAtPrefix;
	return resolvePath(ctx.cwd, expanded);
}

function getBrowserFileWatchId(filePath: string, platform: NodeJS.Platform = process.platform): string {
	let normalizedPath = platform === "win32" ? win32Path.normalize(filePath) : resolvePath(filePath);
	if (platform === "win32" && /^[A-Z]:/.test(normalizedPath)) {
		normalizedPath = `${normalizedPath[0]!.toLowerCase()}${normalizedPath.slice(1)}`;
	}
	return `file:${normalizedPath}`;
}

function getBrowserFileWatchSourceLabel(ctx: ExtensionContext, filePath: string): string {
	const relativeFilePath = relativePath(ctx.cwd, filePath);
	if (
		relativeFilePath
		&& relativeFilePath !== ".."
		&& !relativeFilePath.startsWith(`..${sep}`)
		&& !isAbsolute(relativeFilePath)
	) return relativeFilePath;
	return basename(filePath);
}

function prepareFilePreview(filePath: string, fileContent: string): PreparedFilePreview {
	if (isLatexFile(filePath)) return { markdown: fileContent, isLatex: true };
	if (isMarkdownFile(filePath)) return { markdown: fileContent, isLatex: false };
	return {
		markdown: wrapCodeAsMarkdown(fileContent, detectLanguageFromPath(filePath), filePath),
		isLatex: false,
	};
}

async function resolvePreviewInput(
	ctx: ExtensionContext,
	options: {
		source?: PreviewExportSource;
		path?: string;
		markdown?: string;
		inputFormat?: PreviewInputFormat;
		resourcePath?: string;
	},
): Promise<ResolvedPreviewInput> {
	const source = options.source ?? (options.markdown !== undefined ? "markdown" : options.path ? "file" : "last_assistant");

	if (source === "file") {
		if (!options.path?.trim()) {
			throw new Error("preview_export source=file requires path.");
		}
		const filePath = resolveUserPath(ctx, options.path);
		const fileContent = await readFile(filePath, "utf-8");
		const prepared = prepareFilePreview(filePath, fileContent);
		return {
			...prepared,
			resourcePath: dirname(filePath),
			source,
			sourceDescription: filePath,
		};
	}

	if (source === "markdown") {
		if (options.markdown === undefined || options.markdown.trim().length === 0) {
			throw new Error("preview_export source=markdown requires markdown content.");
		}
		const resourcePath = options.resourcePath?.trim() ? resolveUserPath(ctx, options.resourcePath) : ctx.cwd;
		const isLatex = options.inputFormat === "latex";
		return {
			markdown: options.markdown,
			resourcePath,
			isLatex,
			source,
			sourceDescription: isLatex ? "provided LaTeX" : "provided markdown",
		};
	}

	const markdown = getLastAssistantMarkdown(ctx);
	if (!markdown) {
		throw new Error("No assistant markdown found in the current branch.");
	}
	return {
		markdown,
		resourcePath: ctx.cwd,
		isLatex: false,
		source,
		sourceDescription: "latest assistant response",
	};
}

function isLikelyMathExpression(expr: string): boolean {
	const content = expr.trim();
	if (content.length === 0) return false;

	if (/\\[a-zA-Z]+/.test(content)) return true; // LaTeX commands like \frac, \alpha
	if (/[0-9]/.test(content)) return true;
	if (/[=+\-*/^_<>≤≥±×÷]/u.test(content)) return true;
	if (/[{}]/.test(content)) return true;
	if (/[α-ωΑ-Ω]/u.test(content)) return true;
	if (/^[A-Za-z]$/.test(content)) return true; // single-variable forms like \(x\)

	// Plain words (e.g. escaped markdown like \[not a link\]) are not math.
	if (/^[A-Za-z][A-Za-z\s'".,:;!?-]*[A-Za-z]$/.test(content)) return false;

	return false;
}

function collapseDisplayMathContent(expr: string): string {
	let content = expr.trim();
	if (/\\begin\{[^}]+\}|\\end\{[^}]+\}/.test(content)) {
		return content;
	}
	if (content.includes("\\\\") || content.includes("\n")) {
		content = content.replace(/\\\\\s*/g, " ");
		content = content.replace(/\s*\n\s*/g, " ");
		content = content.replace(/\s{2,}/g, " ").trim();
	}
	return content;
}

function normalizeMathDelimitersInSegment(markdown: string): string {
	let normalized = markdown.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (match, expr: string) => {
		const content = expr.trim();
		if (!isLikelyMathExpression(content)) return match;
		return content.length > 0 ? `$$\n${content}\n$$` : "$$\n$$";
	});

	normalized = normalized.replace(/\\\(([\s\S]*?)\\\)/g, (match, expr: string) => {
		if (!isLikelyMathExpression(expr)) return match;
		return `$${expr}$`;
	});
	return normalized;
}

function normalizeMathDelimiters(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let plainBuffer: string[] = [];
	let inFence = false;
	let fenceChar: "`" | "~" | undefined;
	let fenceLength = 0;

	const flushPlain = () => {
		if (plainBuffer.length === 0) return;
		out.push(normalizeMathDelimitersInSegment(plainBuffer.join("\n")));
		plainBuffer = [];
	};

	for (const line of lines) {
		const trimmed = line.trimStart();
		const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			const markerChar = marker[0] as "`" | "~";
			const markerLength = marker.length;

			if (!inFence) {
				flushPlain();
				inFence = true;
				fenceChar = markerChar;
				fenceLength = markerLength;
				out.push(line);
				continue;
			}

			if (fenceChar === markerChar && markerLength >= fenceLength) {
				inFence = false;
				fenceChar = undefined;
				fenceLength = 0;
			}

			out.push(line);
			continue;
		}

		if (inFence) {
			out.push(line);
		} else {
			plainBuffer.push(line);
		}
	}

	flushPlain();
	return out.join("\n");
}

function normalizeSubSupTagsInSegment(markdown: string): string {
	let normalized = markdown.replace(/<sub>([^<\n]+)<\/sub>/gi, (_match, content: string) => `~${content}~`);
	normalized = normalized.replace(/<sup>([^<\n]+)<\/sup>/gi, (_match, content: string) => `^${content}^`);
	return normalized;
}

function normalizeSubSupTags(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let plainBuffer: string[] = [];
	let inFence = false;
	let fenceChar: "`" | "~" | undefined;
	let fenceLength = 0;

	const flushPlain = () => {
		if (plainBuffer.length === 0) return;
		out.push(normalizeSubSupTagsInSegment(plainBuffer.join("\n")));
		plainBuffer = [];
	};

	for (const line of lines) {
		const trimmed = line.trimStart();
		const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			const markerChar = marker[0] as "`" | "~";
			const markerLength = marker.length;

			if (!inFence) {
				flushPlain();
				inFence = true;
				fenceChar = markerChar;
				fenceLength = markerLength;
				out.push(line);
				continue;
			}

			if (fenceChar === markerChar && markerLength >= fenceLength) {
				inFence = false;
				fenceChar = undefined;
				fenceLength = 0;
			}

			out.push(line);
			continue;
		}

		if (inFence) {
			out.push(line);
		} else {
			plainBuffer.push(line);
		}
	}

	flushPlain();
	return out.join("\n");
}

function escapeLatexTextFragment(text: string): string {
	return String(text ?? "")
		.replace(/\\/g, "\\textbackslash{}")
		.replace(/([{}%#$&_])/g, "\\$1")
		.replace(/~/g, "\\textasciitilde{}")
		.replace(/\^/g, "\\textasciicircum{}");
}

function getMathPattern(): RegExp {
	return /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;
}

function normalizeLatexAnnotationText(text: string): string {
	return normalizeAnnotationText(text);
}

function escapeLatexText(text: string): string {
	const normalized = normalizeLatexAnnotationText(text);
	if (!normalized) return "";

	const mathPattern = getMathPattern();
	let out = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = mathPattern.exec(normalized)) !== null) {
		const token = match[0] ?? "";
		const start = match.index;
		if (start > lastIndex) {
			out += escapeLatexTextFragment(normalized.slice(lastIndex, start));
		}

		const inlineParenExpr = match[1];
		const displayBracketExpr = match[2];
		const displayDollarExpr = match[3];
		const inlineDollarExpr = match[4];
		let mathLatex = "";

		if (typeof inlineParenExpr === "string" && isLikelyMathExpression(inlineParenExpr)) {
			const content = inlineParenExpr.trim();
			mathLatex = content ? `\\(${content}\\)` : "";
		} else if (typeof displayBracketExpr === "string" && isLikelyMathExpression(displayBracketExpr)) {
			const content = collapseDisplayMathContent(displayBracketExpr);
			mathLatex = content ? `\\(${content}\\)` : "";
		} else if (typeof displayDollarExpr === "string" && isLikelyMathExpression(displayDollarExpr)) {
			const content = collapseDisplayMathContent(displayDollarExpr);
			mathLatex = content ? `\\(${content}\\)` : "";
		} else if (typeof inlineDollarExpr === "string" && isLikelyMathExpression(inlineDollarExpr)) {
			const content = inlineDollarExpr.trim();
			mathLatex = content ? `\\(${content}\\)` : "";
		}

		out += mathLatex || escapeLatexTextFragment(token);
		lastIndex = start + token.length;
		if (token.length === 0) {
			mathPattern.lastIndex += 1;
		}
	}

	if (lastIndex < normalized.length) {
		out += escapeLatexTextFragment(normalized.slice(lastIndex));
	}

	return out.trim();
}

function renderAnnotationCodeSpanPdfLatex(rawToken: string): string {
	const raw = String(rawToken ?? "");
	if (!raw || raw[0] !== "`") return escapeLatexTextFragment(raw);

	let fenceLength = 1;
	while (raw[fenceLength] === "`") fenceLength += 1;
	const fence = "`".repeat(fenceLength);
	if (raw.length < fenceLength * 2 || raw.slice(raw.length - fenceLength) !== fence) {
		return escapeLatexTextFragment(raw);
	}

	return `\\texttt{${escapeLatexTextFragment(raw.slice(fenceLength, raw.length - fenceLength))}}`;
}

function canOpenAnnotationEmphasisDelimiter(source: string, startIndex: number, delimiter: string): boolean {
	if (source.slice(startIndex, startIndex + delimiter.length) !== delimiter) return false;
	const prev = startIndex > 0 ? source[startIndex - 1] ?? "" : "";
	const next = source[startIndex + delimiter.length] ?? "";
	if (!next || /\s/.test(next)) return false;
	return !isAnnotationWordChar(prev);
}

function canCloseAnnotationEmphasisDelimiter(source: string, startIndex: number, delimiter: string): boolean {
	if (source.slice(startIndex, startIndex + delimiter.length) !== delimiter) return false;
	const prev = startIndex > 0 ? source[startIndex - 1] ?? "" : "";
	const next = source[startIndex + delimiter.length] ?? "";
	if (!prev || /\s/.test(prev)) return false;
	return !isAnnotationWordChar(next);
}

function renderAnnotationPdfLatexContent(text: string): string {
	const source = String(text ?? "");
	let out = "";
	let plainStart = 0;
	let index = 0;

	while (index < source.length) {
		const token = readAnnotationProtectedTokenAt(source, index);
		if (!token) {
			index += 1;
			continue;
		}

		if (index > plainStart) {
			out += renderAnnotationPlainTextPdfLatex(source.slice(plainStart, index));
		}

		if (token.type === "code") {
			out += renderAnnotationCodeSpanPdfLatex(token.raw);
		} else if (token.type === "math") {
			out += escapeLatexText(token.raw);
		} else {
			out += escapeLatexTextFragment(token.raw);
		}

		index = token.end;
		plainStart = index;
	}

	if (plainStart < source.length) {
		out += renderAnnotationPlainTextPdfLatex(source.slice(plainStart));
	}

	return out;
}

function readAnnotationPdfEmphasisSpanAt(source: string, startIndex: number, delimiter: string, commandName: string): { end: number; latex: string } | null {
	if (!canOpenAnnotationEmphasisDelimiter(source, startIndex, delimiter)) return null;

	let index = startIndex + delimiter.length;
	while (index < source.length) {
		if (source[index] === "\\") {
			index = Math.min(source.length, index + 2);
			continue;
		}

		const protectedToken = readAnnotationProtectedTokenAt(source, index);
		if (protectedToken) {
			index = protectedToken.end;
			continue;
		}

		if (canCloseAnnotationEmphasisDelimiter(source, index, delimiter)) {
			const inner = source.slice(startIndex + delimiter.length, index);
			return {
				end: index + delimiter.length,
				latex: `\\${commandName}{${renderAnnotationPdfLatexContent(inner)}}`,
			};
		}

		index += 1;
	}

	return null;
}

function renderAnnotationPlainTextPdfLatex(text: string): string {
	const source = String(text ?? "");
	let out = "";
	let index = 0;

	while (index < source.length) {
		const strongMatch = readAnnotationPdfEmphasisSpanAt(source, index, "**", "textbf")
			?? readAnnotationPdfEmphasisSpanAt(source, index, "__", "textbf");
		if (strongMatch) {
			out += strongMatch.latex;
			index = strongMatch.end;
			continue;
		}

		const emphasisMatch = readAnnotationPdfEmphasisSpanAt(source, index, "*", "emph")
			?? readAnnotationPdfEmphasisSpanAt(source, index, "_", "emph");
		if (emphasisMatch) {
			out += emphasisMatch.latex;
			index = emphasisMatch.end;
			continue;
		}

		out += escapeLatexTextFragment(source[index] ?? "");
		index += 1;
	}

	return out;
}

function renderAnnotationPdfLatex(text: string): string {
	const normalized = normalizeAnnotationText(text);
	if (!normalized) return "";
	return renderAnnotationPdfLatexContent(normalized).trim();
}

function replaceAnnotationMarkersForPdfInSegment(text: string): string {
	return replaceInlineAnnotationMarkers(
		String(text ?? ""),
		(marker: { body: string }) => {
			const cleaned = renderAnnotationPdfLatex(marker.body);
			if (!cleaned) return "";
			return `\\piannotation{${cleaned}}`;
		},
	);
}

function highlightAnnotationMarkersForPdf(markdown: string): string {
	if (!hasMarkdownAnnotationMarkers(markdown)) return String(markdown ?? "");
	return transformMarkdownOutsideFences(markdown, (segment: string) => replaceAnnotationMarkersForPdfInSegment(segment));
}

function formatMarkdownImageDestination(rawPath: string): string {
	const path = rawPath.trim();
	if (!path) return "";
	const unwrapped = path.startsWith("<") && path.endsWith(">") ? path.slice(1, -1).trim() : path;
	// Angle brackets keep markdown image destinations valid for spaces/parentheses.
	if (/[\s<>()]/.test(unwrapped)) return `<${unwrapped}>`;
	return unwrapped;
}

function normalizeObsidianImages(markdown: string): string {
	// Convert ![[path|alt]] and ![[path]] to standard markdown ![alt](path)
	return markdown
		.replace(/!\[\[([^|\]]+)\|([^\]]+)\]\]/g, (_match, path: string, alt: string) => {
			return `![${alt}](${formatMarkdownImageDestination(path)})`;
		})
		.replace(/!\[\[([^\]]+)\]\]/g, (_match, path: string) => {
			return `![](${formatMarkdownImageDestination(path)})`;
		});
}

function extractLikelyImageDestination(rawDestination: string): string {
	const trimmed = rawDestination.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("<")) {
		const close = trimmed.indexOf(">");
		if (close > 0) return trimmed.slice(1, close).trim();
	}
	const firstWhitespace = trimmed.search(/\s/);
	return firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
}

function isLikelyRelativeLocalImageDestination(destination: string): boolean {
	if (!destination) return false;
	if (destination.startsWith("/") || destination.startsWith("#")) return false;
	if (destination.startsWith("\\\\")) return false;
	if (/^[A-Za-z]:[\\/]/.test(destination)) return false;

	const lower = destination.toLowerCase();
	if (
		lower.startsWith("http://")
		|| lower.startsWith("https://")
		|| lower.startsWith("data:")
		|| lower.startsWith("file:")
		|| lower.startsWith("blob:")
		|| lower.startsWith("about:")
	) {
		return false;
	}

	return true;
}

function hasLikelyRelativeLocalImages(markdown: string): boolean {
	const normalized = normalizeObsidianImages(markdown);
	const imageRegex = /!\[[^\]]*]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = imageRegex.exec(normalized)) !== null) {
		const destination = extractLikelyImageDestination(match[1] ?? "");
		if (isLikelyRelativeLocalImageDestination(destination)) {
			return true;
		}
	}
	return false;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "rmd", "qmd"]);

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	py: "python", pyw: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin", kts: "kotlin",
	swift: "swift",
	c: "c", h: "c",
	cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash", bash: "bash", zsh: "bash",
	fish: "fish",
	ps1: "powershell",
	sql: "sql",
	html: "html", htm: "html",
	css: "css", scss: "scss", sass: "sass", less: "less",
	json: "json", jsonc: "json", json5: "json",
	yaml: "yaml", yml: "yaml",
	toml: "toml",
	xml: "xml",
	dockerfile: "dockerfile",
	makefile: "makefile",
	cmake: "cmake",
	lua: "lua",
	perl: "perl", pl: "perl",
	r: "r",
	jl: "julia",
	scala: "scala",
	clj: "clojure",
	ex: "elixir", exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	ml: "ocaml",
	vim: "vim",
	graphql: "graphql",
	proto: "protobuf",
	tf: "hcl", hcl: "hcl",
	tex: "latex", latex: "latex",
	qmd: "markdown",
	diff: "diff", patch: "diff",
	f90: "fortran", f95: "fortran", f03: "fortran", f: "fortran", for: "fortran",
	m: "matlab",
};

function detectLanguageFromPath(filePath: string): string | undefined {
	const ext = extname(filePath).replace(/^\./, "").toLowerCase();
	if (ext) return EXT_TO_LANG[ext];

	const baseLower = basename(filePath).toLowerCase();
	if (baseLower === "dockerfile") return "dockerfile";
	if (baseLower === "makefile") return "makefile";
	return undefined;
}

function isMarkdownFile(filePath: string): boolean {
	const ext = extname(filePath).replace(/^\./, "").toLowerCase();
	return MARKDOWN_EXTENSIONS.has(ext);
}

const LATEX_EXTENSIONS = new Set(["tex", "latex"]);

function isLatexFile(filePath: string): boolean {
	const ext = extname(filePath).replace(/^\./, "").toLowerCase();
	return LATEX_EXTENSIONS.has(ext);
}

function normalizeFenceLanguage(language: string | undefined): string | undefined {
	const trimmed = typeof language === "string" ? language.trim().toLowerCase() : "";
	if (!trimmed) return undefined;
	if (trimmed === "patch" || trimmed === "udiff") return "diff";
	return trimmed;
}

function getLongestFenceRun(text: string, fenceChar: "`" | "~"): number {
	const regex = fenceChar === "`" ? /`+/g : /~+/g;
	let max = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		max = Math.max(max, match[0].length);
	}
	return max;
}

function wrapCodeAsMarkdown(code: string, lang?: string, filePath?: string): string {
	const header = filePath ? `# ${basename(filePath)}\n\n` : "";
	const source = String(code ?? "").replace(/\r\n/g, "\n").trimEnd();
	const language = normalizeFenceLanguage(lang) ?? "";
	const maxBackticks = getLongestFenceRun(source, "`");
	const maxTildes = getLongestFenceRun(source, "~");

	let markerChar: "`" | "~" = "`";
	if (maxBackticks === 0 && maxTildes === 0) {
		markerChar = "`";
	} else if (maxTildes < maxBackticks) {
		markerChar = "~";
	} else if (maxBackticks < maxTildes) {
		markerChar = "`";
	} else {
		markerChar = maxBackticks > 0 ? "~" : "`";
	}

	const markerLength = Math.max(3, (markerChar === "`" ? maxBackticks : maxTildes) + 1);
	const marker = markerChar.repeat(markerLength);
	return `${header}${marker}${language}\n${source}\n${marker}`;
}

function extractFenceInfoLanguage(info: string): string | undefined {
	const firstToken = String(info ?? "").trim().split(/\s+/)[0]?.replace(/^\./, "") ?? "";
	return normalizeFenceLanguage(firstToken || undefined);
}

function normalizeMarkdownFencedBlocks(markdown: string): string {
	const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const openingMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})([^\n]*)$/);
		if (!openingMatch) {
			out.push(line);
			continue;
		}

		const indent = openingMatch[1] ?? "";
		const openingFence = openingMatch[2]!;
		const openingSuffix = openingMatch[3] ?? "";
		const fenceChar = openingFence[0] as "`" | "~";
		const fenceLength = openingFence.length;

		let closingIndex = -1;
		for (let innerIndex = index + 1; innerIndex < lines.length; innerIndex += 1) {
			const innerLine = lines[innerIndex] ?? "";
			const closingMatch = innerLine.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
			if (!closingMatch) continue;
			const closingFence = closingMatch[1]!;
			if (closingFence[0] !== fenceChar || closingFence.length < fenceLength) continue;
			closingIndex = innerIndex;
			break;
		}

		if (closingIndex === -1) {
			out.push(line);
			continue;
		}

		const contentLines = lines.slice(index + 1, closingIndex);
		const content = contentLines.join("\n");
		const maxBackticks = getLongestFenceRun(content, "`");
		const maxTildes = getLongestFenceRun(content, "~");
		const currentMaxRun = fenceChar === "`" ? maxBackticks : maxTildes;

		if (currentMaxRun < fenceLength) {
			out.push(line, ...contentLines, lines[closingIndex] ?? "");
			index = closingIndex;
			continue;
		}

		const neededBackticks = Math.max(3, maxBackticks + 1);
		const neededTildes = Math.max(3, maxTildes + 1);
		let markerChar: "`" | "~" = fenceChar;

		if (neededBackticks < neededTildes) {
			markerChar = "`";
		} else if (neededTildes < neededBackticks) {
			markerChar = "~";
		} else if (fenceChar === "`") {
			markerChar = "~";
		}

		const markerLength = markerChar === "`" ? neededBackticks : neededTildes;
		const marker = markerChar.repeat(markerLength);
		out.push(`${indent}${marker}${openingSuffix}`, ...contentLines, `${indent}${marker}`);
		index = closingIndex;
	}

	return out.join("\n");
}

function hasMarkdownDiffFence(markdown: string): boolean {
	const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const openingMatch = line.match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
		if (!openingMatch) continue;

		const openingFence = openingMatch[1]!;
		const infoLanguage = extractFenceInfoLanguage(openingMatch[2] ?? "");
		if (infoLanguage !== "diff") continue;

		const fenceChar = openingFence[0];
		const fenceLength = openingFence.length;
		for (let innerIndex = index + 1; innerIndex < lines.length; innerIndex += 1) {
			const innerLine = lines[innerIndex] ?? "";
			const closingMatch = innerLine.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
			if (!closingMatch) continue;
			const closingFence = closingMatch[1]!;
			if (closingFence[0] !== fenceChar || closingFence.length < fenceLength) continue;
			return true;
		}
	}

	return false;
}

function deduplicateWindowsPaths(paths: Array<string | undefined>): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const candidate of paths) {
		if (!candidate?.trim()) continue;
		const normalized = win32Path.normalize(candidate.trim());
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(normalized);
	}
	return candidates;
}

function getWindowsBrowserCandidates(env: NodeJS.ProcessEnv): string[] {
	const systemRoots = deduplicateWindowsPaths([
		env.ProgramW6432,
		env.PROGRAMFILES,
		env["PROGRAMFILES(X86)"],
		"C:/Program Files",
		"C:/Program Files (x86)",
	]);
	const browserRelativePaths = [
		["Google", "Chrome", "Application", "chrome.exe"],
		["Microsoft", "Edge", "Application", "msedge.exe"],
		["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
		["Chromium", "Application", "chrome.exe"],
	];
	const systemCandidates = browserRelativePaths.flatMap((relativePath) => (
		systemRoots.map((root) => win32Path.join(root, ...relativePath))
	));
	const localRoot = env.LOCALAPPDATA?.trim();
	const userCandidates = localRoot
		? browserRelativePaths.map((relativePath) => win32Path.join(localRoot, ...relativePath))
		: [];
	return deduplicateWindowsPaths([...systemCandidates, ...userCandidates]);
}

function getBrowserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === "darwin") {
		return [
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		];
	}

	if (platform === "win32") {
		return getWindowsBrowserCandidates(env);
	}

	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
}

function findBrowserExecutable(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	pathExists: (path: string) => boolean = existsSync,
): string | undefined {
	const envPath = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || env.BROWSER;
	if (envPath && pathExists(envPath)) {
		return envPath;
	}
	return getBrowserCandidates(platform, env).find((candidate) => pathExists(candidate));
}

let sharedPreviewBrowser: Browser | undefined;
let sharedPreviewBrowserLaunchPromise: Promise<Browser> | undefined;
let sharedPreviewBrowserLaunchToken = 0;

export function getPreviewBrowserLaunchOptions(): { executablePath: string; args: string[] } {
	const executablePath = findBrowserExecutable();
	if (!executablePath) {
		throw new Error(
			"No Chromium-based browser was found. Set PUPPETEER_EXECUTABLE_PATH to your Chrome/Edge/Chromium binary.",
		);
	}

	const args = ["--disable-gpu", "--font-render-hinting=medium"];
	if (process.platform === "linux") args.push("--no-sandbox", "--disable-setuid-sandbox");
	return { executablePath, args };
}

async function launchPreviewBrowser(): Promise<Browser> {
	return puppeteer.launch({ headless: true, ...getPreviewBrowserLaunchOptions() });
}

async function getSharedPreviewBrowser(): Promise<Browser> {
	if (sharedPreviewBrowser?.connected) return sharedPreviewBrowser;
	sharedPreviewBrowser = undefined;

	if (sharedPreviewBrowserLaunchPromise) return sharedPreviewBrowserLaunchPromise;

	const launchToken = ++sharedPreviewBrowserLaunchToken;
	const launchPromise = (async () => {
		const browser = await launchPreviewBrowser();
		if (sharedPreviewBrowserLaunchToken !== launchToken) {
			await browser.close().catch(() => {});
			throw new Error("Preview browser launch cancelled.");
		}

		sharedPreviewBrowser = browser;
		browser.once("disconnected", () => {
			if (sharedPreviewBrowser === browser) sharedPreviewBrowser = undefined;
		});
		return browser;
	})();

	sharedPreviewBrowserLaunchPromise = launchPromise;
	try {
		return await launchPromise;
	} finally {
		if (sharedPreviewBrowserLaunchPromise === launchPromise) {
			sharedPreviewBrowserLaunchPromise = undefined;
		}
	}
}

export async function closeSharedPreviewBrowser(): Promise<void> {
	sharedPreviewBrowserLaunchToken++;
	const browser = sharedPreviewBrowser;
	const launchPromise = sharedPreviewBrowserLaunchPromise;
	sharedPreviewBrowser = undefined;
	sharedPreviewBrowserLaunchPromise = undefined;

	await browser?.close().catch(() => {});
	await launchPromise?.catch(() => {});
}

function getCachePaths(markdownPage: string, styleKey: string) {
	const hash = createHash("sha256")
		.update(RENDER_VERSION)
		.update("\u0000")
		.update(styleKey)
		.update("\u0000")
		.update(markdownPage)
		.digest("hex");
	return {
		pngPath: join(CACHE_DIR, `${hash}.png`),
		metaPath: join(CACHE_DIR, `${hash}.json`),
	};
}

function buildRenderCacheKey(styleKey: string, resourcePath?: string, isLatex?: boolean): string {
	const format = isLatex ? "latex" : "markdown";
	const resolvedResourcePath = resourcePath ? resolvePath(resourcePath) : "";
	return `${styleKey}\u0000${format}\u0000${resolvedResourcePath}`;
}

async function readCachedPage(markdownPage: string, styleKey: string): Promise<CachedPage | undefined> {
	const { pngPath, metaPath } = getCachePaths(markdownPage, styleKey);
	if (!existsSync(pngPath)) {
		return undefined;
	}

	try {
		const buffer = await readFile(pngPath);
		let truncatedHeight = false;
		let pageCount: number | undefined;
		let truncatedPages = false;
		if (existsSync(metaPath)) {
			const meta = JSON.parse(await readFile(metaPath, "utf-8")) as { truncatedHeight?: boolean; pageCount?: number; truncatedPages?: boolean };
			truncatedHeight = meta.truncatedHeight === true;
			pageCount = meta.pageCount;
			truncatedPages = meta.truncatedPages === true;
		}
		return { buffer, truncatedHeight, pageCount, truncatedPages };
	} catch {
		return undefined;
	}
}

async function writeCachedPage(markdownPage: string, styleKey: string, page: CachedPage): Promise<void> {
	const { pngPath, metaPath } = getCachePaths(markdownPage, styleKey);
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(pngPath, page.buffer);
	const meta: Record<string, unknown> = { truncatedHeight: page.truncatedHeight };
	if (page.pageCount != null) meta.pageCount = page.pageCount;
	if (page.truncatedPages != null) meta.truncatedPages = page.truncatedPages;
	await writeFile(metaPath, JSON.stringify(meta), "utf-8");
}

async function waitForPageRenderReady(page: Page): Promise<void> {
	await page.evaluate(async () => {
		if ("fonts" in document) {
			await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
		}
	});
}

function buildBlockAwarePageClips(
	renderHeight: number,
	breakCandidates: readonly number[],
	protectedRanges: readonly PreviewProtectedRange[] = [],
	pageHeight = PAGE_HEIGHT_PX,
	maxPages = MAX_PREVIEW_PAGES,
): PreviewPageClip[] {
	const normalizedRenderHeight = Math.max(1, Math.ceil(renderHeight));
	const normalizedPageHeight = Math.max(1, Math.floor(pageHeight));
	const normalizedMaxPages = Math.max(1, Math.floor(maxPages));
	if (normalizedRenderHeight <= normalizedPageHeight || normalizedMaxPages === 1) {
		return [{ y: 0, height: normalizedRenderHeight }];
	}

	const candidates = [...new Set(
		breakCandidates
			.filter((candidate) => Number.isFinite(candidate))
			.map((candidate) => Math.round(candidate))
			.filter((candidate) => candidate > 0 && candidate < normalizedRenderHeight),
	)].sort((left, right) => left - right);
	const ranges = protectedRanges
		.filter((range) => Number.isFinite(range.top) && Number.isFinite(range.bottom))
		.map((range) => ({
			top: Math.max(0, Math.floor(range.top)),
			bottom: Math.min(normalizedRenderHeight, Math.ceil(range.bottom)),
		}))
		.filter((range) => range.bottom > range.top && range.bottom - range.top <= normalizedPageHeight)
		.sort((left, right) => left.top - right.top || right.bottom - left.bottom);
	const minimumPreferredHeight = Math.ceil(normalizedPageHeight * MIN_BLOCK_AWARE_PAGE_FILL_RATIO);
	const minimumProtectedHeight = Math.ceil(normalizedPageHeight * MIN_PROTECTED_PAGE_FILL_RATIO);
	const clips: PreviewPageClip[] = [];
	let y = 0;

	while (normalizedRenderHeight - y > normalizedPageHeight && clips.length < normalizedMaxPages - 1) {
		const target = y + normalizedPageHeight;
		const remainingPageSlots = normalizedMaxPages - clips.length - 1;
		const minimumCutToFitRemainingPages = normalizedRenderHeight - remainingPageSlots * normalizedPageHeight;
		const containingRange = ranges.find((range) => (
			range.top >= y + minimumProtectedHeight
			&& range.top >= minimumCutToFitRemainingPages
			&& range.top < target
			&& range.bottom > target
		));
		let cut = containingRange?.top ?? target;

		if (!containingRange) {
			const earliestPreferredCut = Math.max(y + minimumPreferredHeight, minimumCutToFitRemainingPages);
			for (const candidate of candidates) {
				if (candidate < earliestPreferredCut) continue;
				if (candidate > target) break;
				cut = candidate;
			}
		}

		clips.push({ y, height: cut - y });
		y = cut;
	}

	clips.push({ y, height: normalizedRenderHeight - y });
	return clips;
}

async function collectPreviewPageLayout(page: Page): Promise<PreviewPageLayout> {
	return page.evaluate((pageHeight) => {
		const root = document.getElementById("preview-root");
		if (!root) return { breakCandidates: [], protectedRanges: [] };

		const candidates = new Set<number>();
		const protectedRanges: PreviewProtectedRange[] = [];
		const addTop = (value: number) => candidates.add(Math.floor(value));
		const addBottom = (value: number) => candidates.add(Math.ceil(value));
		const protect = (topValue: number, bottomValue: number) => {
			const top = Math.floor(topValue);
			const bottom = Math.ceil(bottomValue);
			if (bottom > top && bottom - top <= pageHeight) protectedRanges.push({ top, bottom });
		};
		const isHeading = (element: Element | undefined) => Boolean(element && /^H[1-6]$/.test(element.tagName));
		const children = Array.from(root.children);

		children.forEach((child, index) => {
			const rect = child.getBoundingClientRect();
			const previous = index > 0 ? children[index - 1] : undefined;
			const next = index + 1 < children.length ? children[index + 1] : undefined;

			if (!isHeading(previous)) addTop(rect.top);
			if (!isHeading(child)) {
				addBottom(rect.bottom);
				protect(rect.top, rect.bottom);
			} else if (next) {
				const nextRect = next.getBoundingClientRect();
				protect(rect.top, nextRect.bottom);
			}

			if (rect.height <= pageHeight) return;
			let nestedSelector: string | undefined;
			if (child.matches("ul, ol")) nestedSelector = ":scope > li";
			else if (child.matches("table")) nestedSelector = "tr";
			else if (child.matches("blockquote, dl")) nestedSelector = ":scope > *";
			if (!nestedSelector) return;

			for (const nestedBlock of child.querySelectorAll(nestedSelector)) {
				const nestedRect = nestedBlock.getBoundingClientRect();
				addTop(nestedRect.top);
				protect(nestedRect.top, nestedRect.bottom);
			}
		});

		const deduplicatedRanges = new Map(
			protectedRanges.map((range) => [`${range.top}:${range.bottom}`, range]),
		);
		return {
			breakCandidates: [...candidates].filter((candidate) => candidate > 0).sort((left, right) => left - right),
			protectedRanges: [...deduplicatedRanges.values()].sort((left, right) => left.top - right.top || right.bottom - left.bottom),
		};
	}, PAGE_HEIGHT_PX);
}

function prepareBrowserPreviewMarkdown(markdown: string, isLatex?: boolean): {
	normalizedMarkdown: string;
	pandocMarkdown: string;
	annotationPlaceholders: PreviewAnnotationPlaceholder[];
} {
	const normalizedMarkdown = isLatex ? markdown : normalizeMarkdownFencedBlocks(normalizeObsidianImages(normalizeMathDelimiters(markdown)));
	if (isLatex || !hasMarkdownAnnotationMarkers(normalizedMarkdown)) {
		return { normalizedMarkdown, pandocMarkdown: normalizedMarkdown, annotationPlaceholders: [] };
	}

	const prepared = prepareMarkdownForPandocPreview(normalizedMarkdown, PREVIEW_ANNOTATION_PLACEHOLDER_PREFIX) as {
		markdown?: string;
		placeholders?: PreviewAnnotationPlaceholder[];
	};
	return {
		normalizedMarkdown,
		pandocMarkdown: typeof prepared.markdown === "string" ? prepared.markdown : normalizedMarkdown,
		annotationPlaceholders: Array.isArray(prepared.placeholders) ? prepared.placeholders : [],
	};
}

async function renderPreview(markdown: string, style: PreviewStyle, signal?: AbortSignal, resourcePath?: string, skipCache?: boolean, isLatex?: boolean, fontSizePx?: number): Promise<RenderPreviewResult> {
	const { normalizedMarkdown, pandocMarkdown, annotationPlaceholders } = prepareBrowserPreviewMarkdown(markdown, isLatex);
	const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_TERMINAL_PREVIEW_FONT_SIZE_PX);
	const deviceScaleFactor = getTerminalDeviceScaleFactor();
	const cacheKey = buildRenderCacheKey(`${style.cacheKey}|fontSize=${previewFontSizePx}|scale=${deviceScaleFactor}`, resourcePath, isLatex);

	// Check cache for the full render (keyed on full markdown content).
	const cached = skipCache ? undefined : await readCachedPage(normalizedMarkdown, cacheKey);
	if (cached) {
		// Cached result stores page count in meta; individual page PNGs are stored separately.
		const meta = cached as CachedPage & { pageCount?: number };
		const pageCount = meta.pageCount ?? 1;
		const pages: PreviewPage[] = [];
		for (let i = 0; i < pageCount; i++) {
			const pageKey = `${normalizedMarkdown}\u0000page${i}`;
			const pageCached = i === 0 ? cached : await readCachedPage(pageKey, cacheKey);
			if (!pageCached) {
				// Cache is incomplete; re-render.
				return renderPreview(markdown, style, signal, resourcePath, true, isLatex, previewFontSizePx);
			}
			pages.push({
				base64Png: pageCached.buffer.toString("base64"),
				truncatedHeight: pageCached.truncatedHeight,
				index: i,
				total: pageCount,
			});
		}
		return { pages, themeMode: style.themeMode, truncatedPages: cached.truncatedPages === true };
	}

	await mkdir(CACHE_DIR, { recursive: true });

	const fragmentHtml = await renderMarkdownToHtmlWithPandoc(pandocMarkdown, resourcePath, isLatex);
	const html = buildBrowserHtmlFromPandocFragment(fragmentHtml, style, resourcePath, annotationPlaceholders, previewFontSizePx);

	let browserPage: Page | undefined;
	let tempHtmlPath: string | undefined;

	try {
		if (signal?.aborted) throw new Error("Preview rendering cancelled.");

		const browser = await getSharedPreviewBrowser();
		if (signal?.aborted) throw new Error("Preview rendering cancelled.");
		browserPage = await browser.newPage();

		const loadHtml = async (height: number) => {
			await browserPage!.setViewport({
				width: VIEWPORT_WIDTH_PX,
				height,
				deviceScaleFactor,
			});
			if (!tempHtmlPath) {
				tempHtmlPath = join(CACHE_DIR, `_render_tmp_${Date.now()}.html`);
				await writeFile(tempHtmlPath, html, "utf-8");
			}
			await browserPage!.goto(pathToFileURL(tempHtmlPath).href, { waitUntil: "domcontentloaded" });
			await waitForPageRenderReady(browserPage!);
			await browserPage!.waitForFunction(
				"window.__mermaidDone === true",
				{ timeout: 15000 },
			);
			const mermaidResult = await browserPage!.evaluate(() => (
				(window as Window & { __mermaidRenderResult?: BrowserMermaidRenderResult }).__mermaidRenderResult ?? null
			));
			throwIfMermaidRenderFailed(mermaidResult);
		};

		// First pass: measure content height.
		await loadHtml(900);
		const contentHeight = await browserPage.evaluate(() => {
			const root = document.getElementById("preview-root");
			if (!root) return 900;
			const rect = root.getBoundingClientRect();
			return Math.ceil(rect.height + 40);
		});

		if (signal?.aborted) throw new Error("Preview rendering cancelled.");

		// Clamp to maximum render height.
		const renderHeight = Math.max(500, Math.min(MAX_RENDER_HEIGHT_PX, contentHeight));
		const truncatedPages = contentHeight > MAX_RENDER_HEIGHT_PX;

		// Second pass: render at full height.
		if (renderHeight !== 900) {
			await loadHtml(renderHeight);
		}

		const pageLayout = renderHeight > PAGE_HEIGHT_PX
			? await collectPreviewPageLayout(browserPage)
			: { breakCandidates: [], protectedRanges: [] };
		const pageClips = buildBlockAwarePageClips(
			renderHeight,
			pageLayout.breakCandidates,
			pageLayout.protectedRanges,
		);

		if (tempHtmlPath) await unlink(tempHtmlPath).catch(() => {});
		tempHtmlPath = undefined;

		const pageCount = pageClips.length;
		const pages: PreviewPage[] = [];

		for (const [index, clip] of pageClips.entries()) {
			if (signal?.aborted) throw new Error("Preview rendering cancelled.");

			const pageScreenshot = (await browserPage.screenshot({
				type: "png",
				...(pageCount > 1 ? {
					clip: {
						x: 0,
						y: clip.y,
						width: VIEWPORT_WIDTH_PX,
						height: clip.height,
					},
				} : {}),
			})) as Buffer;

			pages.push({
				base64Png: pageScreenshot.toString("base64"),
				truncatedHeight: false,
				index,
				total: pageCount,
			});

			const pageKey = index === 0 ? normalizedMarkdown : `${normalizedMarkdown}\u0000page${index}`;
			await writeCachedPage(pageKey, cacheKey, {
				buffer: pageScreenshot,
				truncatedHeight: false,
				pageCount: index === 0 ? pageCount : undefined,
				truncatedPages: index === 0 ? truncatedPages : undefined,
			}).catch(() => {});
		}

		return { pages, themeMode: style.themeMode, truncatedPages };
	} finally {
		if (tempHtmlPath) await unlink(tempHtmlPath).catch(() => {});
		if (browserPage) await browserPage.close().catch(() => {});
	}
}


class MarkdownPreviewOverlay {
	private container = new Container();
	private pageIndex = 0;
	private statusLine: string | undefined;
	private isRefreshing = false;
	private isOpeningBrowser = false;
	private imageIdsByPage = new Map<number, number>();
	private readonly useKittyImageDeletion = getCapabilities().images === "kitty"
		&& allocateImageIdIfAvailable !== undefined;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private preview: RenderPreviewResult,
		private done: () => void,
		private refresh: () => Promise<RenderPreviewResult>,
		private openInBrowser: () => Promise<void>,
	) {
		this.rebuild();
	}

	private currentPage(): PreviewPage {
		return this.preview.pages[this.pageIndex]!;
	}

	private getImageIdForPage(pageIndex: number): number | undefined {
		if (!this.useKittyImageDeletion) return undefined;
		const existing = this.imageIdsByPage.get(pageIndex);
		if (existing !== undefined) return existing;
		const created = allocateImageIdIfAvailable?.();
		if (created === undefined) return undefined;
		this.imageIdsByPage.set(pageIndex, created);
		return created;
	}

	private clearRenderedImages(): void {
		if (!this.useKittyImageDeletion) return;
		for (const imageId of this.imageIdsByPage.values()) {
			try {
				this.tui.terminal.write(deleteKittyImage(imageId));
			} catch {
				// no-op
			}
		}
		this.imageIdsByPage.clear();
	}

	private rebuild(): void {
		this.container.clear();

		const title = `${this.theme.bold("Markdown preview")} ${this.theme.fg("dim", `(${this.pageIndex + 1}/${this.preview.pages.length})`)}`;
		this.container.addChild(new Text(this.theme.fg("accent", title), 0, 0));

		const controls: string[] = [];
		if (this.preview.pages.length > 1) controls.push("←/→ page");
		controls.push(`${keyHint("tui.select.cancel", "close")}`, "r refresh", "o open browser");
		this.container.addChild(new Text(this.theme.fg("dim", controls.join(" • ")), 0, 0));

		const page = this.currentPage();
		if (this.preview.truncatedPages || page.truncatedHeight) {
			const notes: string[] = [];
			if (this.preview.truncatedPages) notes.push("message split into max preview pages");
			if (page.truncatedHeight) notes.push("current page clipped for terminal preview");
			this.container.addChild(new Text(this.theme.fg("warning", `Note: ${notes.join("; ")}.`), 0, 0));
		}

		if (this.statusLine) {
			this.container.addChild(new Text(this.statusLine, 0, 0));
		}

		this.container.addChild(new Spacer(1));
		this.container.addChild(
			new Image(
				page.base64Png,
				"image/png",
				{ fallbackColor: (str) => this.theme.fg("muted", str) },
				{ maxWidthCells: 280, imageId: this.getImageIdForPage(page.index) },
			),
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.clearRenderedImages();
			this.done();
			return;
		}

		if (matchesKey(data, "left") && this.pageIndex > 0) {
			this.clearRenderedImages();
			this.pageIndex--;
			this.statusLine = undefined;
			this.rebuild();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "right") && this.pageIndex < this.preview.pages.length - 1) {
			this.clearRenderedImages();
			this.pageIndex++;
			this.statusLine = undefined;
			this.rebuild();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "o") && !this.isOpeningBrowser) {
			this.isOpeningBrowser = true;
			this.statusLine = this.theme.fg("warning", "Opening browser preview...");
			this.rebuild();
			this.tui.requestRender();

			void this.openInBrowser()
				.then(() => {
					this.statusLine = this.theme.fg("success", "Opened preview in browser.");
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					this.statusLine = this.theme.fg("error", `Browser open failed: ${message}`);
				})
				.finally(() => {
					this.isOpeningBrowser = false;
					this.rebuild();
					this.tui.requestRender();
				});
			return;
		}

		if (matchesKey(data, "r") && !this.isRefreshing) {
			this.isRefreshing = true;
			this.statusLine = this.theme.fg("warning", "Refreshing preview for current theme...");
			this.rebuild();
			this.tui.requestRender();

			void this.refresh()
				.then((preview) => {
					this.clearRenderedImages();
					this.preview = preview;
					this.pageIndex = Math.min(this.pageIndex, Math.max(0, preview.pages.length - 1));
					this.statusLine = this.theme.fg("success", `Refreshed (${preview.themeMode} mode).`);
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					this.statusLine = this.theme.fg("error", `Refresh failed: ${message}`);
				})
				.finally(() => {
					this.isRefreshing = false;
					this.rebuild();
					this.tui.requestRender();
				});
		}
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
		this.rebuild();
	}

	dispose(): void {
		this.clearRenderedImages();
	}
}

async function renderWithLoader(ctx: ExtensionCommandContext, markdown: string, resourcePath?: string, isLatex?: boolean, fontSizePx?: number): Promise<RenderWithLoaderResult | null> {
	type LoaderResult = { ok: true; preview: RenderPreviewResult } | { ok: false; error: string } | { ok: false; cancelled: true };

	const result = await ctx.ui.custom<LoaderResult>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Rendering markdown + LaTeX preview...");
		let settled = false;
		const resolve = (value: LoaderResult) => {
			if (settled) return;
			settled = true;
			done(value);
		};

		loader.onAbort = () => resolve({ ok: false, cancelled: true });

		void (async () => {
			try {
				const style = getPreviewStyle(ctx.ui.theme);
				const preview = await renderPreview(markdown, style, loader.signal, resourcePath, undefined, isLatex, fontSizePx);
				if (loader.signal.aborted) {
					resolve({ ok: false, cancelled: true });
					return;
				}
				resolve({ ok: true, preview });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				resolve({ ok: false, error: message });
			}
		})();

		return loader;
	});

	if (!result) {
		try {
			const style = getPreviewStyle(ctx.ui.theme);
			const preview = await renderPreview(markdown, style, undefined, resourcePath, undefined, isLatex, fontSizePx);
			return { preview, supportsCustomUi: false };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Preview failed: ${message}`, "error");
			return null;
		}
	}

	if (!result.ok) {
		if ("cancelled" in result && result.cancelled) {
			ctx.ui.notify("Preview cancelled.", "info");
			return null;
		}
		if ("error" in result) {
			ctx.ui.notify(`Preview failed: ${result.error}`, "error");
			return null;
		}
		ctx.ui.notify("Preview failed.", "error");
		return null;
	}

	return {
		preview: result.preview,
		supportsCustomUi: true,
	};
}

async function pickAssistantMessage(ctx: ExtensionCommandContext): Promise<string | null> {
	const messages = getAssistantMessages(ctx);

	if (messages.length === 0) {
		ctx.ui.notify("No assistant messages found in the current branch.", "warning");
		return null;
	}

	if (messages.length === 1) {
		return messages[0]!.markdown;
	}

	const items: SelectItem[] = messages.map((msg, i) => ({
		value: String(i),
		label: `Response ${msg.index + 1}`,
		description: msg.preview,
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Response to Preview")), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		// Start with the last (most recent) item selected
		for (let i = 0; i < items.length - 1; i++) {
			selectList.handleInput("\x1b[B"); // simulate down arrow
		}

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (result === null) return null;
	const selected = messages[Number(result)];
	return selected ? selected.markdown : null;
}

export async function openPreview(ctx: ExtensionCommandContext, markdownOverride?: string, resourcePath?: string, isLatex?: boolean, fontSizePx?: number): Promise<void> {
	const markdown = markdownOverride ?? getLastAssistantMarkdown(ctx);
	if (!markdown) {
		ctx.ui.notify("No assistant markdown found in the current branch.", "warning");
		return;
	}

	const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_TERMINAL_PREVIEW_FONT_SIZE_PX);
	const rendered = await renderWithLoader(ctx, markdown, resourcePath, isLatex, previewFontSizePx);
	if (!rendered) return;

	const { preview: initialPreview, supportsCustomUi } = rendered;
	if (!supportsCustomUi) {
		const pageCount = initialPreview.pages.length;
		ctx.ui.notify(
			`Preview rendered (${pageCount} page${pageCount === 1 ? "" : "s"}), but interactive preview display isn't available in this mode.`,
			"info",
		);
		return;
	}

	// NOTE: Keep this in non-overlay mode.
	// Overlay compositing currently truncates terminal image protocol sequences
	// (kitty/iTerm), which causes raw image payload fragments to appear instead
	// of the rendered preview.
	await ctx.ui.custom<void>((tui, theme, _kb, done) =>
		new MarkdownPreviewOverlay(
			tui,
			theme,
			initialPreview,
			done,
			async () => {
				const style = getPreviewStyle(ctx.ui.theme);
				const refreshed = await renderPreview(markdown, style, undefined, resourcePath, true, isLatex, previewFontSizePx);
				return refreshed;
			},
			async () => {
				await openPreviewInBrowser(ctx, markdown, resourcePath, isLatex, previewFontSizePx);
			},
		),
	);
}

function getBrowserOpenTarget(pathOrUrl: string): string {
	return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : pathToFileURL(pathOrUrl).href;
}

function getCmuxBrowserOpenCommand(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | undefined {
	const workspaceId = String(env.CMUX_WORKSPACE_ID ?? "").trim();
	const termProgram = String(env.TERM_PROGRAM ?? "").trim().toLowerCase();
	const term = String(env.TERM ?? "").trim().toLowerCase();
	const bundleId = String(env.CMUX_BUNDLE_ID ?? "").trim().toLowerCase();
	const detected = Boolean(workspaceId || termProgram === "cmux" || term.includes("cmux") || bundleId.includes("cmux"));
	if (!detected) return undefined;

	const command = String(env.CMUX_BUNDLED_CLI_PATH ?? "").trim() || "cmux";
	const args = ["browser", "open", target];
	if (workspaceId) args.push("--workspace", workspaceId);
	args.push("--focus", "true");
	return { command, args };
}

async function tryOpenBrowserPreviewInCmux(target: string): Promise<boolean> {
	const openCommand = getCmuxBrowserOpenCommand(target);
	if (!openCommand) return false;

	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const child = spawn(openCommand.command, openCommand.args, { stdio: "ignore" });
		const finish = (opened: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(opened);
		};
		const timeout = setTimeout(() => {
			child.kill();
			finish(false);
		}, CMUX_BROWSER_OPEN_TIMEOUT_MS);
		timeout.unref?.();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

async function openFileInDefaultBrowser(pathOrUrl: string, preferCmuxBrowser = false): Promise<void> {
	const target = getBrowserOpenTarget(pathOrUrl);
	if (preferCmuxBrowser && await tryOpenBrowserPreviewInCmux(target)) return;
	const openCommand =
		process.platform === "darwin"
			? { command: "open", args: [target] }
			: process.platform === "win32"
				? { command: "cmd", args: ["/c", "start", "", target] }
				: { command: "xdg-open", args: [target] };

	await new Promise<void>((resolve, reject) => {
		const child = spawn(openCommand.command, openCommand.args, {
			stdio: "ignore",
			detached: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

async function renderMarkdownToHtmlWithPandoc(markdown: string, resourcePath?: string, isLatex?: boolean): Promise<string> {
	const pandocCommand = process.env.PANDOC_PATH?.trim() || "pandoc";
	const pandocInput = isLatex ? markdown : normalizeMarkdownFencedBlocks(markdown);
	const inputFormat = isLatex ? "latex" : "markdown+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header+tex_math_dollars+autolink_bare_uris-raw_html";
	const args = ["-f", inputFormat, "-t", "html5", "--mathml", "--wrap=none"];
	if (resourcePath) args.push(`--resource-path=${resourcePath}`);

	return await new Promise<string>((resolve, reject) => {
		const child = spawn(pandocCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const succeed = (html: string) => {
			if (settled) return;
			settled = true;
			resolve(html);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});

		child.once("error", (error) => {
			const errno = error as NodeJS.ErrnoException;
			if (errno.code === "ENOENT") {
				fail(
					new Error(
						`pandoc was not found. Install pandoc or set PANDOC_PATH to the pandoc binary.`,
					),
				);
				return;
			}
			fail(error);
		});

		child.once("close", (code) => {
			if (settled) return;
			if (code === 0) {
				succeed(Buffer.concat(stdoutChunks).toString("utf-8"));
				return;
			}
			const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
			fail(new Error(`pandoc failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
		});

		child.stdin.end(pandocInput);
	});
}

const PDF_PREAMBLE = `% Optional styling: keep PDF export usable on smaller TeX installs.
\\IfFileExists{titlesec.sty}{%
  \\usepackage{titlesec}%
  \\titleformat{\\section}{\\Large\\bfseries\\sffamily}{}{0pt}{}[\\vspace{2pt}\\titlerule]%
  \\titleformat{\\subsection}{\\large\\bfseries\\sffamily}{}{0pt}{}%
  \\titleformat{\\subsubsection}{\\normalsize\\bfseries\\sffamily}{}{0pt}{}%
  \\titlespacing*{\\section}{0pt}{1.5ex plus 0.5ex minus 0.2ex}{1ex plus 0.2ex}%
  \\titlespacing*{\\subsection}{0pt}{1.2ex plus 0.4ex minus 0.2ex}{0.6ex plus 0.1ex}%
}{}
\\IfFileExists{enumitem.sty}{%
  \\usepackage{enumitem}%
  \\setlist[itemize]{nosep, leftmargin=1.5em}%
  \\setlist[enumerate]{nosep, leftmargin=1.5em}%
}{}
\\IfFileExists{parskip.sty}{\\usepackage{parskip}}{}
\\IfFileExists{xcolor.sty}{%
  \\usepackage{xcolor}%
  \\definecolor{PiAnnotationBg}{HTML}{EAF3FF}%
  \\definecolor{PiAnnotationBorder}{HTML}{8CB8FF}%
  \\definecolor{PiAnnotationText}{HTML}{1F5FBF}%
  \\definecolor{PiDiffAddText}{HTML}{1A7F37}%
  \\definecolor{PiDiffDelText}{HTML}{CF222E}%
  \\definecolor{PiDiffMetaText}{HTML}{57606A}%
  \\definecolor{PiDiffHunkText}{HTML}{0969DA}%
  \\definecolor{PiCodeBg}{HTML}{F6F8FA}%
}{%
  \\providecommand{\\textcolor}[2]{#2}%
  \\providecommand{\\fcolorbox}[3]{#3}%
}
\\IfFileExists{framed.sty}{%
  \\ifcsname definecolor\\endcsname
    \\usepackage{framed}%
    \\definecolor{shadecolor}{HTML}{F6F8FA}%
    \\ifcsname Shaded\\endcsname
      \\renewenvironment{Shaded}{\\begin{snugshade}}{\\end{snugshade}}%
    \\else
      \\newenvironment{Shaded}{\\begin{snugshade}}{\\end{snugshade}}%
    \\fi
  \\fi
}{}
\\newif\\ifPiMarkdownPreviewHasVarwidth
\\IfFileExists{varwidth.sty}{\\usepackage{varwidth}\\PiMarkdownPreviewHasVarwidthtrue}{\\PiMarkdownPreviewHasVarwidthfalse}
\\newcommand{\\piannotation}[1]{%
  \\begingroup
  \\setlength{\\fboxsep}{1.5pt}%
  \\fcolorbox{PiAnnotationBorder}{PiAnnotationBg}{%
    \\ifPiMarkdownPreviewHasVarwidth
      \\begin{varwidth}{\\dimexpr\\linewidth-2\\fboxsep-2\\fboxrule\\relax}%
      \\raggedright\\textcolor{PiAnnotationText}{\\sffamily\\strut #1}%
      \\end{varwidth}%
    \\else
      \\parbox{\\dimexpr\\linewidth-2\\fboxsep-2\\fboxrule\\relax}{\\raggedright\\textcolor{PiAnnotationText}{\\sffamily\\strut #1}}%
    \\fi
  }%
  \\endgroup
}
\\newcommand{\\PiDiffAddTok}[1]{\\textcolor{PiDiffAddText}{#1}}
\\newcommand{\\PiDiffDelTok}[1]{\\textcolor{PiDiffDelText}{#1}}
\\newcommand{\\PiDiffMetaTok}[1]{\\textcolor{PiDiffMetaText}{#1}}
\\newcommand{\\PiDiffHunkTok}[1]{\\textcolor{PiDiffHunkText}{#1}}
\\newcommand{\\PiDiffHeaderTok}[1]{\\textcolor{PiDiffHunkText}{\\textbf{#1}}}
\\IfFileExists{fvextra.sty}{%
  \\usepackage{fvextra}%
  \\ifcsname Highlighting\\endcsname
    \\RecustomVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},breaklines,breakanywhere}%
  \\else
    \\DefineVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},breaklines,breakanywhere}%
  \\fi
}{}
`;

const PDF_PREAMBLE_PATH = join(CACHE_DIR, "_pdf_preamble.tex");

async function ensurePdfPreamble(): Promise<string> {
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(PDF_PREAMBLE_PATH, PDF_PREAMBLE, "utf-8");
	return PDF_PREAMBLE_PATH;
}

async function compileLatexToPdf(latexSource: string, outputPath: string, resourcePath?: string): Promise<void> {
	const engine = process.env.PANDOC_PDF_ENGINE?.trim() || "xelatex";
	const tmpDir = join(CACHE_DIR, `_latex_${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });

	const texPath = join(tmpDir, "input.tex");
	await writeFile(texPath, latexSource, "utf-8");

	// Symlink resource directory contents so \includegraphics can find figures
	if (resourcePath) {
		const { readdirSync } = await import("node:fs");
		try {
			for (const entry of readdirSync(resourcePath)) {
				const src = join(resourcePath, entry);
				const dest = join(tmpDir, entry);
				try { await import("node:fs/promises").then(fs => fs.symlink(src, dest)); } catch { /* ignore collisions */ }
			}
		} catch { /* resource dir unreadable, skip */ }
	}

	return await new Promise<void>((resolve, reject) => {
		// Run twice for cross-references (\ref, \eqref, \label)
		const runLatex = (pass: number) => {
			const child = spawn(engine, [
				"-interaction=nonstopmode",
				"-halt-on-error",
				"-output-directory", tmpDir,
				texPath,
			], { stdio: ["pipe", "pipe", "pipe"], cwd: tmpDir });

			const stderrChunks: Buffer[] = [];
			const stdoutChunks: Buffer[] = [];
			let passSettled = false;
			const timeoutMs = getPdfRenderTimeoutMs();
			const timeout = setTimeout(() => {
				if (passSettled) return;
				passSettled = true;
				child.kill("SIGTERM");
				reject(new Error(`${engine} timed out after ${formatTimeoutMs(timeoutMs)} on pass ${pass}.`));
			}, timeoutMs);
			timeout.unref?.();

			child.stdout.on("data", (chunk: Buffer | string) => {
				stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			});

			child.once("error", (error) => {
				if (passSettled) return;
				passSettled = true;
				clearTimeout(timeout);
				const errno = error as NodeJS.ErrnoException;
				if (errno.code === "ENOENT") {
					reject(new Error(
						`${engine} was not found. Install TeX Live (brew install --cask mactex) or set PANDOC_PDF_ENGINE.`,
					));
					return;
				}
				reject(error);
			});

			child.once("close", (code) => {
				if (passSettled) return;
				passSettled = true;
				clearTimeout(timeout);
				if (code !== 0 && pass === 2) {
					const log = `${Buffer.concat(stdoutChunks).toString("utf-8")}\n${Buffer.concat(stderrChunks).toString("utf-8")}`;
					// Extract the first LaTeX error line for a useful message
					const errorMatch = log.match(/^! .+$/m);
					const hint = errorMatch ? errorMatch[0] : log.trim().slice(-2000);
					reject(new Error(`${engine} failed (exit ${code})${hint ? `: ${hint}` : ""}`));
					return;
				}
				if (pass === 1) {
					runLatex(2);
				} else {
					// Copy PDF to output path
					const generatedPdf = join(tmpDir, "input.pdf");
					import("node:fs/promises").then(fs =>
						fs.copyFile(generatedPdf, outputPath).then(() => resolve())
					).catch(reject);
				}
			});

			child.stdin.end();
		};

		runLatex(1);
	});
}

async function renderMarkdownToPdf(markdown: string, outputPath: string, resourcePath?: string): Promise<void> {
	const pandocCommand = process.env.PANDOC_PATH?.trim() || "pandoc";
	const pandocInput = normalizeMarkdownFencedBlocks(markdown);
	const pdfEngine = process.env.PANDOC_PDF_ENGINE?.trim() || "xelatex";
	const preamblePath = await ensurePdfPreamble();
	const args = [
		"-f", "markdown+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header+tex_math_dollars+autolink_bare_uris+superscript+subscript-raw_html",
		"-o", outputPath,
		`--pdf-engine=${pdfEngine}`,
		...getPandocLatexEngineOptions(pdfEngine),
		"-V", "geometry:margin=2.2cm",
		"-V", "fontsize=11pt",
		"-V", "linestretch=1.25",
		"-V", "urlcolor=blue",
		"-V", "linkcolor=blue",
		"--include-in-header", preamblePath,
	];
	if (resourcePath) args.push(`--resource-path=${resourcePath}`);

	return await new Promise<void>((resolve, reject) => {
		const child = spawn(pandocCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;
		const timeoutMs = getPdfRenderTimeoutMs();
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			fail(new Error(`pandoc PDF export timed out after ${formatTimeoutMs(timeoutMs)}.`));
		}, timeoutMs);
		timeout.unref?.();

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});

		child.once("error", (error) => {
			const errno = error as NodeJS.ErrnoException;
			if (errno.code === "ENOENT") {
				fail(
					new Error(
						`pandoc was not found. Install pandoc or set PANDOC_PATH to the pandoc binary.`,
					),
				);
				return;
			}
			fail(error);
		});

		child.once("close", (code) => {
			if (settled) return;
			clearTimeout(timeout);
			if (code === 0) {
				settled = true;
				resolve();
				return;
			}
			const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
			const details = stderr || stdout.slice(-4000);
			const hint = details.includes("not found") || details.includes("pdflatex") || details.includes("xelatex") || details.includes(".sty")
				? "\nPDF export requires a LaTeX engine and common LaTeX packages. Install a fuller TeX Live package set (e.g. texlive-latexextra on Arch) or set PANDOC_PDF_ENGINE to your preferred engine."
				: "";
			fail(new Error(`pandoc PDF export failed with exit code ${code}${details ? `: ${details}` : ""}${hint}`));
		});

		child.stdin.end(pandocInput);
	});
}

function isGeneratedDiffHighlightingBlock(lines: string[]): boolean {
	const body = lines.join("\n");
	const hasAdditionOrDeletion = /\\VariableTok\{\+|\\StringTok\{\{-\}/.test(body);
	const hasDiffStructure = /\\DataTypeTok\{@@|\\NormalTok\{diff \{-\}\{-\}git |\\KeywordTok\{\{-\}\{-\}\{-\}|\\DataTypeTok\{\+\+\+/.test(body);
	return hasAdditionOrDeletion && hasDiffStructure;
}

function decodeGeneratedLatexCodeText(text: string): string {
	return String(text ?? "")
		.replace(/\\textbackslash\{\}/g, "\\")
		.replace(/\\textasciigrave\{\}/g, "`")
		.replace(/\\textasciitilde\{\}/g, "~")
		.replace(/\\textasciicircum\{\}/g, "^")
		.replace(/\\\^\{\}/g, "^")
		.replace(/\\~\{\}/g, "~")
		.replace(/\\([{}_#$%&])/g, "$1");
}

function readVerbatimMathOperand(expr: string, startIndex: number): { operand: string; nextIndex: number } | null {
	if (startIndex >= expr.length) return null;
	const first = expr[startIndex]!;

	if (first === "{") {
		let depth = 1;
		let index = startIndex + 1;
		while (index < expr.length) {
			const char = expr[index]!;
			if (char === "{") {
				depth += 1;
			} else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					return {
						operand: expr.slice(startIndex + 1, index),
						nextIndex: index + 1,
					};
				}
			}
			index += 1;
		}
		return {
			operand: expr.slice(startIndex + 1),
			nextIndex: expr.length,
		};
	}

	if (first === "\\") {
		let index = startIndex + 1;
		while (index < expr.length && /[A-Za-z]/.test(expr[index]!)) {
			index += 1;
		}
		if (index === startIndex + 1 && index < expr.length) {
			index += 1;
		}
		return {
			operand: expr.slice(startIndex, index),
			nextIndex: index,
		};
	}

	return {
		operand: first,
		nextIndex: startIndex + 1,
	};
}

function makeHighlightingMathScriptsVerbatimSafe(text: string): string {
	const rewriteExpr = (expr: string): string => {
		let out = "";
		for (let index = 0; index < expr.length; index += 1) {
			const char = expr[index]!;
			if (char !== "_" && char !== "^") {
				out += char;
				continue;
			}

			const operand = readVerbatimMathOperand(expr, index + 1);
			if (!operand || !operand.operand) {
				out += char;
				continue;
			}

			out += char === "_" ? `\\sb{${operand.operand}}` : `\\sp{${operand.operand}}`;
			index = operand.nextIndex - 1;
		}
		return out;
	};

	return String(text ?? "")
		.replace(/\\\(([\s\S]*?)\\\)/g, (_match, expr: string) => `\\(${rewriteExpr(expr)}\\)`)
		.replace(/\\\[([\s\S]*?)\\\]/g, (_match, expr: string) => `\\[${rewriteExpr(expr)}\\]`)
		.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expr: string) => `$$${rewriteExpr(expr)}$$`)
		.replace(/\$([^$\n]+?)\$/g, (_match, expr: string) => `$${rewriteExpr(expr)}$`);
}

function replaceAnnotationMarkersInDiffTokenLine(line: string, macroName: string): string {
	const tokenMatch = line.match(new RegExp(`^\\\\${macroName}\\{([\\s\\S]*)\\}$`));
	if (!tokenMatch) return line;

	const body = tokenMatch[1] ?? "";
	const wrapText = (text: string): string => text ? `\\${macroName}{${text}}` : "";
	const rewritten = replaceInlineAnnotationMarkers(
		body,
		(marker: { body: string }) => {
			const markerText = decodeGeneratedLatexCodeText(normalizeAnnotationText(marker.body));
			const cleaned = makeHighlightingMathScriptsVerbatimSafe(renderAnnotationPdfLatex(markerText));
			if (!cleaned) return "";
			return `\\piannotation{${cleaned}}`;
		},
		(segment: string) => wrapText(segment),
	);

	return rewritten === body ? line : (rewritten || wrapText(body));
}

function rewriteGeneratedDiffHighlighting(latex: string): string {
	const lines = String(latex ?? "").split("\n");
	const out: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!/^\\begin\{Highlighting\}/.test(line)) {
			out.push(line);
			continue;
		}

		let closingIndex = -1;
		for (let innerIndex = index + 1; innerIndex < lines.length; innerIndex += 1) {
			if (/^\\end\{Highlighting\}/.test(lines[innerIndex] ?? "")) {
				closingIndex = innerIndex;
				break;
			}
		}

		if (closingIndex === -1) {
			out.push(line);
			continue;
		}

		const blockLines = lines.slice(index, closingIndex + 1);
		if (!isGeneratedDiffHighlightingBlock(blockLines)) {
			out.push(...blockLines);
			index = closingIndex;
			continue;
		}

		const rewrittenBlock = blockLines.map((blockLine) => {
			if (/^\\VariableTok\{/.test(blockLine)) {
				return replaceAnnotationMarkersInDiffTokenLine(
					blockLine.replace(/^\\VariableTok\{/, "\\PiDiffAddTok{"),
					"PiDiffAddTok",
				);
			}
			if (/^\\StringTok\{/.test(blockLine)) {
				return replaceAnnotationMarkersInDiffTokenLine(
					blockLine.replace(/^\\StringTok\{/, "\\PiDiffDelTok{"),
					"PiDiffDelTok",
				);
			}
			if (/^\\DataTypeTok\{@@/.test(blockLine)) return blockLine.replace(/^\\DataTypeTok\{/, "\\PiDiffHunkTok{");
			if (/^\\DataTypeTok\{\+\+\+/.test(blockLine)) return blockLine.replace(/^\\DataTypeTok\{/, "\\PiDiffHeaderTok{");
			if (/^\\KeywordTok\{\{-\}\{-\}\{-\}/.test(blockLine)) return blockLine.replace(/^\\KeywordTok\{/, "\\PiDiffHeaderTok{");
			if (/^\\NormalTok\{(?:diff \{-\}\{-\}git |index |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files )/.test(blockLine)) {
				return replaceAnnotationMarkersInDiffTokenLine(
					blockLine.replace(/^\\NormalTok\{/, "\\PiDiffMetaTok{"),
					"PiDiffMetaTok",
				);
			}
			return blockLine;
		});

		out.push(...rewrittenBlock);
		index = closingIndex;
	}

	return out.join("\n");
}

async function renderMarkdownToPdfViaGeneratedLatex(markdown: string, outputPath: string, resourcePath?: string): Promise<void> {
	const pandocCommand = process.env.PANDOC_PATH?.trim() || "pandoc";
	const pandocInput = normalizeMarkdownFencedBlocks(markdown);
	const preamblePath = await ensurePdfPreamble();
	const args = [
		"-f", "markdown+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header+tex_math_dollars+autolink_bare_uris+superscript+subscript-raw_html",
		"-t", "latex",
		"-s",
		"-V", "geometry:margin=2.2cm",
		"-V", "fontsize=11pt",
		"-V", "linestretch=1.25",
		"-V", "urlcolor=blue",
		"-V", "linkcolor=blue",
		"--include-in-header", preamblePath,
	];
	if (resourcePath) args.push(`--resource-path=${resourcePath}`);

	const generatedLatex = await new Promise<string>((resolve, reject) => {
		const child = spawn(pandocCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;
		const timeoutMs = getPdfRenderTimeoutMs();
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			fail(new Error(`pandoc LaTeX generation timed out after ${formatTimeoutMs(timeoutMs)}.`));
		}, timeoutMs);
		timeout.unref?.();

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});

		child.once("error", (error) => {
			const errno = error as NodeJS.ErrnoException;
			if (errno.code === "ENOENT") {
				fail(
					new Error(
						`pandoc was not found. Install pandoc or set PANDOC_PATH to the pandoc binary.`,
					),
				);
				return;
			}
			fail(error);
		});

		child.once("close", (code) => {
			if (settled) return;
			if (code === 0) {
				settled = true;
				clearTimeout(timeout);
				resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
				return;
			}
			const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
			fail(new Error(`pandoc LaTeX generation failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
		});

		child.stdin.end(pandocInput);
	});

	await compileLatexToPdf(rewriteGeneratedDiffHighlighting(generatedLatex), outputPath, resourcePath);
}

class MermaidCliMissingError extends Error {}

interface MermaidPdfPreprocessResult {
	markdown: string;
	found: number;
	replaced: number;
	failed: number;
	missingCli: boolean;
}

function getMermaidPdfTheme(): "default" | "forest" | "dark" | "neutral" {
	const requested = process.env.MERMAID_PDF_THEME?.trim().toLowerCase();
	if (requested === "default" || requested === "forest" || requested === "dark" || requested === "neutral") {
		return requested;
	}
	return "default";
}

function getMermaidCliCommand(): string {
	return process.env.MERMAID_CLI_PATH?.trim()
		|| (existsSync(PI_MERMAID_CLI_PATH) ? PI_MERMAID_CLI_PATH : "mmdc");
}

function usesSupportedMermaidIconPack(source: string): boolean {
	return /@\{[^\r\n}]*\bicon\s*:\s*["'](?:lucide|logos):/.test(source);
}

async function renderMermaidDiagramForPdf(source: string, outputPath: string): Promise<void> {
	const mermaidCommand = getMermaidCliCommand();
	const mermaidTheme = getMermaidPdfTheme();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-markdown-preview-mermaid-"));
	const inputPath = join(tempDir, "diagram.mmd");

	await mkdir(dirname(outputPath), { recursive: true });

	try {
		await writeFile(inputPath, source, "utf-8");
		await new Promise<void>((resolve, reject) => {
			const args = ["-i", inputPath, "-o", outputPath, "-t", mermaidTheme, "-f"];
			if (usesSupportedMermaidIconPack(source)) {
				args.push("--iconPacks", ...MERMAID_CLI_ICON_PACKS);
			}
			const child = spawn(mermaidCommand, args, { stdio: ["ignore", "ignore", "pipe"] });
			const stderrChunks: Buffer[] = [];
			let settled = false;
			const timeoutMs = getPdfRenderTimeoutMs();
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				fail(new Error(`Mermaid CLI timed out after ${formatTimeoutMs(timeoutMs)}.`));
			}, timeoutMs);
			timeout.unref?.();

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(error);
			};

			child.stderr.on("data", (chunk: Buffer | string) => {
				stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			});

			child.once("error", (error) => {
				const errno = error as NodeJS.ErrnoException;
				if (errno.code === "ENOENT") {
					fail(
						new MermaidCliMissingError(
							"Mermaid CLI (mmdc) not found. Install with `npm install -g @mermaid-js/mermaid-cli` or set MERMAID_CLI_PATH.",
						),
					);
					return;
				}
				fail(error);
			});

			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (code === 0) {
					resolve();
					return;
				}
				const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
				reject(new Error(`Mermaid CLI failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
			});
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function preprocessMermaidForPdf(markdown: string): Promise<MermaidPdfPreprocessResult> {
	const mermaidRegex = /```mermaid[^\n]*\n([\s\S]*?)```/gi;
	const matches: Array<{ start: number; end: number; raw: string; source: string; number: number }> = [];
	let match: RegExpExecArray | null;
	let blockNumber = 1;

	while ((match = mermaidRegex.exec(markdown)) !== null) {
		const raw = match[0]!;
		const source = (match[1] ?? "").trimEnd();
		matches.push({
			start: match.index,
			end: match.index + raw.length,
			raw,
			source,
			number: blockNumber++,
		});
	}

	if (matches.length === 0) {
		return {
			markdown,
			found: 0,
			replaced: 0,
			failed: 0,
			missingCli: false,
		};
	}

	await mkdir(MERMAID_PDF_CACHE_DIR, { recursive: true });

	const renderedBySource = new Map<string, string | null>();
	let missingCli = false;
	const mermaidTheme = getMermaidPdfTheme();

	for (const block of matches) {
		if (renderedBySource.has(block.source)) continue;

		const hash = createHash("sha256")
			.update(RENDER_VERSION)
			.update("\u0000")
			.update("pdf-mermaid")
			.update("\u0000")
			.update(mermaidTheme)
			.update("\u0000")
			.update(block.source)
			.digest("hex");
		const outputPath = join(MERMAID_PDF_CACHE_DIR, `${hash}.pdf`);

		if (existsSync(outputPath)) {
			renderedBySource.set(block.source, outputPath);
			continue;
		}

		if (missingCli) {
			renderedBySource.set(block.source, null);
			continue;
		}

		try {
			await renderMermaidDiagramForPdf(block.source, outputPath);
			renderedBySource.set(block.source, outputPath);
		} catch (error) {
			if (error instanceof MermaidCliMissingError) {
				missingCli = true;
			}
			renderedBySource.set(block.source, null);
		}
	}

	let transformed = "";
	let cursor = 0;
	let replaced = 0;
	let failed = 0;

	for (const block of matches) {
		transformed += markdown.slice(cursor, block.start);
		const renderedPath = renderedBySource.get(block.source) ?? null;
		if (renderedPath) {
			replaced++;
			const imageRef = pathToFileURL(renderedPath).href;
			transformed += `\n![Mermaid diagram ${block.number}](<${imageRef}>)\n`;
		} else {
			failed++;
			transformed += block.raw;
		}
		cursor = block.end;
	}

	transformed += markdown.slice(cursor);

	return {
		markdown: transformed,
		found: matches.length,
		replaced,
		failed,
		missingCli,
	};
}

async function renderPreviewPdfToFile(
	markdown: string,
	outputPath?: string,
	resourcePath?: string,
	isLatex?: boolean,
	onWarning?: (message: string) => void,
): Promise<string> {
	const normalizedMarkdown = isLatex
		? markdown
		: normalizeSubSupTags(normalizeMarkdownFencedBlocks(normalizeObsidianImages(normalizeMathDelimiters(markdown))));
	const mermaidPrepared = isLatex ? { markdown: normalizedMarkdown, found: 0, replaced: 0, failed: 0, missingCli: false } : await preprocessMermaidForPdf(normalizedMarkdown);

	if (mermaidPrepared.missingCli) {
		onWarning?.("Mermaid CLI (mmdc) not found; Mermaid blocks are kept as code in PDF. Install @mermaid-js/mermaid-cli or set MERMAID_CLI_PATH.");
	} else if (mermaidPrepared.failed > 0) {
		onWarning?.(`Failed to render ${mermaidPrepared.failed} Mermaid block${mermaidPrepared.failed === 1 ? "" : "s"} for PDF. Unrendered blocks are kept as code.`);
	}

	const markdownForPdf = isLatex ? mermaidPrepared.markdown : highlightAnnotationMarkersForPdf(mermaidPrepared.markdown);
	const hash = createHash("sha256")
		.update(RENDER_VERSION)
		.update("\u0000")
		.update("pdf")
		.update("\u0000")
		.update(buildRenderCacheKey("pdf", resourcePath, isLatex))
		.update("\u0000")
		.update(markdownForPdf)
		.digest("hex");
	const pdfPath = outputPath ?? join(CACHE_DIR, `${hash}.pdf`);

	await mkdir(dirname(pdfPath), { recursive: true });
	if (isLatex) {
		await compileLatexToPdf(markdownForPdf, pdfPath, resourcePath);
	} else if (hasMarkdownDiffFence(markdownForPdf)) {
		await renderMarkdownToPdfViaGeneratedLatex(markdownForPdf, pdfPath, resourcePath);
	} else {
		await renderMarkdownToPdf(markdownForPdf, pdfPath, resourcePath);
	}
	return pdfPath;
}

async function exportPdf(ctx: ExtensionCommandContext, markdownOverride?: string, resourcePath?: string, isLatex?: boolean): Promise<void> {
	const markdown = markdownOverride ?? getLastAssistantMarkdown(ctx);
	if (!markdown) {
		ctx.ui.notify("No assistant markdown found in the current branch.", "warning");
		return;
	}

	const pdfPath = await renderPreviewPdfToFile(markdown, undefined, resourcePath, isLatex, (message) => ctx.ui.notify(message, "warning"));
	await openFileInDefaultBrowser(pdfPath);
}

function buildPreviewCssVars(style: PreviewStyle, fontSizePx?: number): Record<string, string> {
	const palette = style.palette;
	const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx);
	const rawBorderSubtle = blendColors(palette.borderMuted, palette.card, style.themeMode === "light" ? 0.58 : 0.48);
	const rawPanelBorder = blendColors(palette.borderMuted, palette.card, style.themeMode === "light" ? 0.42 : 0.36);
	const borderSubtle = capBorderContrast(rawBorderSubtle, palette.card, style.themeMode === "light" ? 1.10 : 1.12);
	const panelBorder = capBorderContrast(rawPanelBorder, palette.card, style.themeMode === "light" ? 1.15 : 1.18);
	const blockquoteBg = withAlpha(
		palette.mdQuoteBorder,
		style.themeMode === "light" ? 0.10 : 0.16,
		style.themeMode === "light" ? "rgba(15, 23, 42, 0.04)" : "rgba(255, 255, 255, 0.05)",
	);
	const tableAltBg = withAlpha(
		palette.mdCodeBlockBorder,
		style.themeMode === "light" ? 0.10 : 0.14,
		style.themeMode === "light" ? "rgba(15, 23, 42, 0.03)" : "rgba(255, 255, 255, 0.04)",
	);
	const inlineCodeBg = withAlpha(
		palette.mdCodeBlockBorder,
		style.themeMode === "light" ? 0.13 : 0.18,
		style.themeMode === "light" ? "rgba(15, 23, 42, 0.06)" : "rgba(255, 255, 255, 0.07)",
	);
	const rawCodeBlockBorder = blendColors(palette.mdCodeBlockBorder, palette.panel2, style.themeMode === "light" ? 0.62 : 0.72);
	const codeBlockBorder = capBorderContrast(rawCodeBlockBorder, palette.panel2, style.themeMode === "light" ? 1.16 : 1.18);
	const diffAddedBg = withAlpha(palette.ok, style.themeMode === "light" ? 0.10 : 0.14, "rgba(46, 160, 67, 0.12)");
	const diffRemovedBg = withAlpha(palette.error, style.themeMode === "light" ? 0.10 : 0.14, "rgba(248, 81, 73, 0.12)");

	return {
		"color-scheme": style.themeMode,
		"--preview-font-size": `${previewFontSizePx}px`,
		"--bg": palette.bg,
		"--card": palette.card,
		"--panel-2": palette.panel2,
		"--border": palette.border,
		"--border-muted": palette.borderMuted,
		"--border-subtle": borderSubtle,
		"--panel-border": panelBorder,
		"--text": palette.text,
		"--muted": palette.muted,
		"--accent": palette.accent,
		"--warn": palette.warn,
		"--error": palette.error,
		"--ok": palette.ok,
		"--code-bg": palette.codeBg,
		"--link": palette.link,
		"--md-heading": palette.mdHeading,
		"--md-link": palette.mdLink,
		"--md-link-url": palette.mdLinkUrl,
		"--md-code": palette.mdCode,
		"--md-codeblock": palette.mdCodeBlock,
		"--md-codeblock-border": codeBlockBorder,
		"--md-quote": palette.mdQuote,
		"--md-quote-border": palette.mdQuoteBorder,
		"--md-hr": palette.mdHr,
		"--md-list-bullet": palette.mdListBullet,
		"--syntax-keyword": palette.syntaxKeyword,
		"--syntax-function": palette.syntaxFunction,
		"--syntax-variable": palette.syntaxVariable,
		"--syntax-string": palette.syntaxString,
		"--syntax-number": palette.syntaxNumber,
		"--syntax-type": palette.syntaxType,
		"--syntax-comment": palette.syntaxComment,
		"--syntax-operator": palette.syntaxOperator,
		"--syntax-punctuation": palette.syntaxPunctuation,
		"--syntax-error": palette.error,
		"--annotation-bg": withAlpha(palette.accent, style.themeMode === "light" ? 0.13 : 0.25, style.themeMode === "light" ? "rgba(9, 105, 218, 0.14)" : "rgba(88, 166, 255, 0.22)"),
		"--annotation-border": withAlpha(palette.accent, style.themeMode === "light" ? 0.45 : 0.65, style.themeMode === "light" ? "rgba(9, 105, 218, 0.40)" : "rgba(88, 166, 255, 0.62)"),
		"--annotation-text": palette.text,
		"--blockquote-bg": blockquoteBg,
		"--inline-code-bg": inlineCodeBg,
		"--table-alt-bg": tableAltBg,
		"--md-table-border": borderSubtle,
		"--diff-add-bg": diffAddedBg,
		"--diff-add-text": palette.ok,
		"--diff-del-bg": diffRemovedBg,
		"--diff-del-text": palette.error,
		"--diff-meta-text": palette.muted,
		"--diff-header-bg": withAlpha(palette.accent, style.themeMode === "light" ? 0.08 : 0.10, style.themeMode === "light" ? "rgba(9, 105, 218, 0.08)" : "rgba(88, 166, 255, 0.10)"),
		"--diff-header-text": palette.accent,
		"--diff-hunk-bg": withAlpha(palette.accent, style.themeMode === "light" ? 0.12 : 0.16, style.themeMode === "light" ? "rgba(9, 105, 218, 0.12)" : "rgba(88, 166, 255, 0.16)"),
		"--diff-hunk-text": palette.accent,
	};
}

export function buildMermaidBrowserModule(mermaidConfigJson: string, mermaidIconPacksJson: string): string {
	return String.raw`
    const setMermaidRenderResult = (status, error) => {
      window.__mermaidRenderResult = error ? { status, error } : { status };
    };
    const renderMermaidFailure = (wrappers, message) => {
      wrappers.forEach((wrapper) => {
        const failure = document.createElement('pre');
        failure.className = 'mermaid-error';
        failure.setAttribute('role', 'alert');
        failure.style.cssText = 'margin:0;padding:12px 14px;border:1px solid var(--error,#cf222e);border-radius:8px;background:var(--panel-2,#f8fafc);color:var(--error,#cf222e);text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;';
        failure.textContent = 'Mermaid render failed: ' + message;
        wrapper.replaceChildren(failure);
      });
    };
    const renderMermaid = async () => {
      const mermaidBlocks = document.querySelectorAll('pre.mermaid');
      if (mermaidBlocks.length === 0) {
        setMermaidRenderResult('skipped');
        return;
      }

      setMermaidRenderResult('pending');
      const wrappers = Array.from(mermaidBlocks).map((pre) => {
        const code = pre.querySelector('code');
        const src = code ? code.textContent : pre.textContent;
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-container';
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = src;
        wrapper.appendChild(div);
        pre.replaceWith(wrapper);
        return wrapper;
      });

      try {
        const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_BROWSER_VERSION}/dist/mermaid.esm.min.mjs');
        const packs = ${mermaidIconPacksJson};
        const pending = new Map();
        let iconPackError = null;
        const load = (pack) => {
          if (!pending.has(pack.name)) {
            pending.set(pack.name, fetch(pack.url).then((response) => {
              if (!response.ok) throw new Error('Failed to load Mermaid icon pack ' + pack.name + ': HTTP ' + response.status);
              return response.json();
            }).catch((error) => {
              iconPackError ??= error instanceof Error ? error : new Error(String(error));
              throw error;
            }));
          }
          return pending.get(pack.name);
        };
        mermaid.registerIconPacks(packs.map((pack) => ({ name: pack.name, loader: () => load(pack) })));
        mermaid.initialize(${mermaidConfigJson});
        await mermaid.run();
        if (iconPackError) throw iconPackError;
        const parseRgb = (value) => {
          const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
          return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
        };
        const isOpaqueColor = (value) => {
          if (!parseRgb(value)) return false;
          const alphaMatch = value.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/);
          return !alphaMatch || Number(alphaMatch[1]) >= 1;
        };
        const findOpaqueFill = (root) => {
          if (!(root instanceof Element)) return null;
          const shape = Array.from(root.querySelectorAll('rect, polygon, path, circle, ellipse')).find((candidate) => {
            const fill = getComputedStyle(candidate).fill;
            return isOpaqueColor(fill);
          });
          return shape ? getComputedStyle(shape).fill : null;
        };
        const findOpaqueBackground = (element, fallback) => {
          let current = element instanceof Element ? element : null;
          while (current) {
            const background = getComputedStyle(current).backgroundColor;
            if (current instanceof HTMLElement && isOpaqueColor(background)) return background;
            current = current.parentElement;
          }
          return fallback;
        };
        const relativeLuminance = (color) => {
          const linear = color.map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        };
        const contrastRatio = (foreground, background) => {
          const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
          const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
          return (lighter + 0.05) / (darker + 0.05);
        };
        const toRgb = (color) => 'rgb(' + color.map((channel) => Math.round(channel)).join(', ') + ')';
        const ensureReadableColor = (foregroundCss, backgroundCss) => {
          const foreground = parseRgb(foregroundCss);
          const background = parseRgb(backgroundCss);
          if (!foreground || !background || contrastRatio(foreground, background) >= 4.5) return foregroundCss;
          const readableCandidates = [[0, 0, 0], [255, 255, 255]].flatMap((target) => {
            for (let step = 1; step <= 20; step += 1) {
              const amount = step / 20;
              const color = foreground.map((channel, index) => channel + (target[index] - channel) * amount);
              if (contrastRatio(color, background) >= 4.5) return [{ amount, color }];
            }
            return [];
          });
          readableCandidates.sort((left, right) => left.amount - right.amount);
          if (readableCandidates.length > 0) return toRgb(readableCandidates[0].color);
          const black = [0, 0, 0];
          const white = [255, 255, 255];
          return toRgb(contrastRatio(black, background) >= contrastRatio(white, background) ? black : white);
        };
        const pageBackground = getComputedStyle(document.body).backgroundColor;
        document.querySelectorAll('.mermaid-container .icon-shape').forEach((node) => {
          const icon = node.querySelector('svg');
          if (!icon) return;
          const semanticColor = getComputedStyle(icon).color;
          const iconSurface = findOpaqueFill(node.firstElementChild)
            || findOpaqueBackground(icon, pageBackground);
          const iconColor = ensureReadableColor(semanticColor, iconSurface);
          icon.style.setProperty('color', iconColor, 'important');
          node.querySelectorAll('.labelBkg, .nodeLabel').forEach((label) => {
            if (!(label instanceof HTMLElement)) return;
            const labelSurface = findOpaqueBackground(label, pageBackground);
            const labelColor = ensureReadableColor(semanticColor, labelSurface);
            label.style.setProperty('color', labelColor, 'important');
          });
        });
        document.querySelectorAll('.mermaid-container .node:not(.icon-shape)').forEach((node) => {
          const shape = Array.from(node.querySelectorAll('rect, polygon, path, circle, ellipse')).find((candidate) => {
            const fill = getComputedStyle(candidate).fill;
            return fill && fill !== 'none' && fill !== 'rgba(0, 0, 0, 0)';
          });
          if (!shape) return;
          const shapeFill = getComputedStyle(shape).fill;
          node.querySelectorAll('.nodeLabel').forEach((label) => {
            if (!(label instanceof HTMLElement)) return;
            const labelColor = ensureReadableColor(getComputedStyle(label).color, shapeFill);
            label.style.setProperty('color', labelColor, 'important');
          });
        });
        setMermaidRenderResult('success');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setMermaidRenderResult('failed', message);
        renderMermaidFailure(wrappers, message);
        console.error('Mermaid render failed:', error);
      }
    };
  `;
}

function buildBrowserHtmlFromPandocFragment(
	fragmentHtml: string,
	style: PreviewStyle,
	resourcePath?: string,
	annotationPlaceholders: PreviewAnnotationPlaceholder[] = [],
	fontSizePx?: number,
): string {
	const palette = style.palette;
	const cssVarsBlock = Object.entries(buildPreviewCssVars(style, fontSizePx)).map(([key, value]) => `  ${key}: ${value};`).join("\n");
	const mermaidConfig = {
		startOnLoad: false,
		theme: "base",
		themeVariables: {
			background: palette.bg,
			primaryColor: palette.panel2,
			primaryTextColor: palette.text,
			primaryBorderColor: palette.mdCodeBlockBorder,
			secondaryColor: palette.card,
			secondaryTextColor: palette.text,
			secondaryBorderColor: palette.mdCodeBlockBorder,
			tertiaryColor: palette.card,
			tertiaryTextColor: palette.text,
			tertiaryBorderColor: palette.mdCodeBlockBorder,
			lineColor: palette.mdQuote,
			textColor: palette.text,
			edgeLabelBackground: palette.panel2,
			nodeBorder: palette.mdCodeBlockBorder,
			clusterBkg: palette.card,
			clusterBorder: palette.mdCodeBlockBorder,
			titleColor: palette.mdHeading,
		},
	};
	const mermaidConfigJson = JSON.stringify(mermaidConfig).replace(/</g, "\\u003c");
	const mermaidIconPacksJson = JSON.stringify(MERMAID_BROWSER_ICON_PACKS).replace(/</g, "\\u003c");
	const baseTag = resourcePath ? `\n<base href="${pathToFileURL(resourcePath + "/").href}" />` : "";
	const annotationHelpersScript = ANNOTATION_HELPERS_SOURCE.replace(/<\/script/gi, "<\\/script");
	const annotationPlaceholdersJson = JSON.stringify(annotationPlaceholders).replace(/</g, "\\u003c");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />${baseTag}
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Markdown Preview</title>
<style>
:root {
${cssVarsBlock}
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
}
body {
  min-height: 100vh;
  padding: 28px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
#preview-root {
  width: min(1100px, 100%);
  margin: 0 auto;
  background: var(--card);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  padding: 24px 28px;
  overflow-wrap: anywhere;
  line-height: 1.58;
  font-size: var(--preview-font-size);
}
#preview-root h1, #preview-root h2, #preview-root h3, #preview-root h4, #preview-root h5, #preview-root h6 {
  margin-top: 1.2em;
  margin-bottom: 0.5em;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--md-heading);
}
#preview-root h1 { font-size: 1.6em; border-bottom: 0; padding-bottom: 0; }
#preview-root h2 { font-size: 1.25em; border-bottom: 0; padding-bottom: 0; }
#preview-root p, #preview-root ul, #preview-root ol, #preview-root blockquote, #preview-root table {
  margin-top: 0;
  margin-bottom: 1em;
}
#preview-root li::marker { color: var(--md-list-bullet); }
#preview-root a { color: var(--md-link); text-decoration: none; }
#preview-root a:hover { text-decoration: underline; }
#preview-root a.uri, #preview-root .uri { color: var(--md-link-url); }
#preview-root blockquote {
  margin-left: 0;
  padding: 0.2em 1em;
  border-left: 0.25em solid var(--md-quote-border);
  border-radius: 0 8px 8px 0;
  background: var(--blockquote-bg);
  color: var(--md-quote);
}
#preview-root pre {
  background: var(--panel-2);
  border: 1px solid var(--md-codeblock-border);
  border-radius: 8px;
  padding: 12px 14px;
  overflow: auto;
}
#preview-root code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
  color: var(--md-code);
}
#preview-root pre code {
  color: var(--text);
}
#preview-root :not(pre) > code {
  background: var(--inline-code-bg);
  border: 1px solid var(--md-codeblock-border);
  border-radius: 6px;
  padding: 0.12em 0.35em;
}
#preview-root .annotation-marker {
  display: inline;
  border-radius: 4px;
  border: 1px solid var(--annotation-border);
  background: var(--annotation-bg);
  color: var(--annotation-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  padding: 0 0.28em;
}
#preview-root .annotation-marker mjx-container {
  margin: 0;
}
#preview-root pre.sourceCode.diff code > .diff-line {
  display: block;
  margin: 0 -4px;
  padding: 0 4px;
  border-radius: 4px;
}
#preview-root pre.sourceCode.diff code > .diff-add-line {
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
}
#preview-root pre.sourceCode.diff code > .diff-del-line {
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
}
#preview-root pre.sourceCode.diff code > .diff-meta-line {
  color: var(--diff-meta-text);
}
#preview-root pre.sourceCode.diff code > .diff-header-line {
  background: var(--diff-header-bg);
  color: var(--diff-header-text);
  font-weight: 600;
}
#preview-root pre.sourceCode.diff code > .diff-hunk-line {
  background: var(--diff-hunk-bg);
  color: var(--diff-hunk-text);
}
#preview-root pre.sourceCode.diff code > .diff-line .kw,
#preview-root pre.sourceCode.diff code > .diff-line .dt,
#preview-root pre.sourceCode.diff code > .diff-line .st,
#preview-root pre.sourceCode.diff code > .diff-line .va {
  color: inherit;
  font-weight: inherit;
}
#preview-root code span.kw,
#preview-root code span.cf,
#preview-root code span.im {
  color: var(--syntax-keyword);
  font-weight: 600;
}
#preview-root code span.dt {
  color: var(--syntax-type);
  font-weight: 600;
}
#preview-root code span.fu,
#preview-root code span.bu {
  color: var(--syntax-function);
}
#preview-root code span.va,
#preview-root code span.ot {
  color: var(--syntax-variable);
}
#preview-root code span.st,
#preview-root code span.ss,
#preview-root code span.sc,
#preview-root code span.ch {
  color: var(--syntax-string);
}
#preview-root code span.dv,
#preview-root code span.bn,
#preview-root code span.fl {
  color: var(--syntax-number);
}
#preview-root code span.co {
  color: var(--syntax-comment);
  font-style: italic;
}
#preview-root code span.op {
  color: var(--syntax-operator);
}
#preview-root code span.pp,
#preview-root code span.pu {
  color: var(--syntax-punctuation);
}
#preview-root code span.er,
#preview-root code span.al {
  color: var(--syntax-error);
  font-weight: 600;
}
#preview-root table {
  border-collapse: collapse;
  display: block;
  max-width: 100%;
  overflow: auto;
}
#preview-root th, #preview-root td {
  border: 1px solid var(--md-table-border);
  padding: 6px 12px;
}
#preview-root thead th {
  background: var(--panel-2);
}
#preview-root tbody tr:nth-child(even) {
  background: var(--table-alt-bg);
}
#preview-root hr {
  border: 0;
  border-top: 1px solid var(--md-hr);
  margin: 1.25em 0;
}
#preview-root img { max-width: 100%; }
#preview-root math[display="block"] {
  display: block;
  margin: 1em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
#preview-root mjx-container[display="true"] {
  display: block;
  margin: 1em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
#preview-root .mermaid-container {
  text-align: center;
  margin: 1em 0;
  overflow-x: auto;
}
#preview-root .mermaid-container svg {
  max-width: 100%;
  height: auto;
}
</style>
</head>
<body>
  <article id="preview-root">${fragmentHtml}</article>
  <script>
${annotationHelpersScript}
  </script>
  <script type="module">
  (async () => {
    const annotationHelpers = window.PiMarkdownPreviewAnnotationHelpers || null;
    const previewAnnotationPlaceholders = ${annotationPlaceholdersJson};
    const DIFF_META_LINE_REGEX = /^(diff --git |index |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files )/;

    const escapeRegExp = (text) => {
      const backslash = String.fromCharCode(92);
      const specials = '.+*?^' + '$' + '{}|[]' + backslash;
      return Array.from(String(text || '')).map((ch) => specials.includes(ch) ? backslash + ch : ch).join('');
    };

    const setAnnotationMarkerContent = (marker, text) => {
      if (!(marker instanceof HTMLElement)) return;
      const rendered = annotationHelpers && typeof annotationHelpers.renderPreviewAnnotationHtml === 'function'
        ? annotationHelpers.renderPreviewAnnotationHtml(text)
        : String(text || '');
      marker.innerHTML = rendered;
    };

    const replaceAnnotationTextNode = (textNode) => {
      if (!annotationHelpers || typeof annotationHelpers.collectInlineAnnotationMarkers !== 'function') return;
      const text = typeof textNode.nodeValue === 'string' ? textNode.nodeValue : '';
      if (!text || text.toLowerCase().indexOf('[an:') === -1) return;

      const markers = annotationHelpers.collectInlineAnnotationMarkers(text);
      if (!Array.isArray(markers) || markers.length === 0) return;

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      markers.forEach((markerInfo) => {
        const token = markerInfo && typeof markerInfo.raw === 'string' ? markerInfo.raw : '';
        const start = markerInfo && typeof markerInfo.start === 'number' ? markerInfo.start : lastIndex;
        const end = markerInfo && typeof markerInfo.end === 'number' ? markerInfo.end : start;
        if (start > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        }

        const markerText = annotationHelpers && typeof annotationHelpers.normalizePreviewAnnotationLabel === 'function'
          ? annotationHelpers.normalizePreviewAnnotationLabel(markerInfo.body)
          : String(markerInfo && markerInfo.body || '').trim();
        if (markerText) {
          const markerEl = document.createElement('span');
          markerEl.className = 'annotation-marker';
          markerEl.title = token || markerText;
          setAnnotationMarkerContent(markerEl, markerText);
          fragment.appendChild(markerEl);
        }

        lastIndex = end;
      });

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    };

    const applyPreviewAnnotationPlaceholders = (root) => {
      if (!root || !Array.isArray(previewAnnotationPlaceholders) || previewAnnotationPlaceholders.length === 0) return;
      const placeholderMap = new Map();
      const placeholderTokens = [];
      previewAnnotationPlaceholders.forEach((entry) => {
        const token = entry && typeof entry.token === 'string' ? entry.token : '';
        if (!token) return;
        placeholderMap.set(token, entry);
        placeholderTokens.push(token);
      });
      if (placeholderTokens.length === 0) return;

      const placeholderPattern = new RegExp(placeholderTokens.map(escapeRegExp).join('|'), 'g');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node = walker.nextNode();
      while (node) {
        const textNode = node;
        const value = typeof textNode.nodeValue === 'string' ? textNode.nodeValue : '';
        if (value && value.indexOf('${PREVIEW_ANNOTATION_PLACEHOLDER_PREFIX}') !== -1) {
          const parent = textNode.parentElement;
          const tag = parent && parent.tagName ? parent.tagName.toUpperCase() : '';
          if (tag !== 'CODE' && tag !== 'PRE' && tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'TEXTAREA') {
            textNodes.push(textNode);
          }
        }
        node = walker.nextNode();
      }

      textNodes.forEach((textNode) => {
        const text = typeof textNode.nodeValue === 'string' ? textNode.nodeValue : '';
        if (!text) return;
        placeholderPattern.lastIndex = 0;
        if (!placeholderPattern.test(text)) return;
        placeholderPattern.lastIndex = 0;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        while ((match = placeholderPattern.exec(text)) !== null) {
          const token = match[0] || '';
          const entry = placeholderMap.get(token);
          const start = typeof match.index === 'number' ? match.index : 0;
          if (start > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
          }
          if (entry) {
            const markerEl = document.createElement('span');
            markerEl.className = 'annotation-marker';
            const markerText = typeof entry.text === 'string' ? entry.text : token;
            markerEl.title = typeof entry.title === 'string' ? entry.title : markerText;
            setAnnotationMarkerContent(markerEl, markerText);
            fragment.appendChild(markerEl);
          } else {
            fragment.appendChild(document.createTextNode(token));
          }
          lastIndex = start + token.length;
          if (token.length === 0) {
            placeholderPattern.lastIndex += 1;
          }
        }

        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        if (textNode.parentNode) {
          textNode.parentNode.replaceChild(fragment, textNode);
        }
      });
    };

    const decorateDiffCodeBlocks = (root) => {
      if (!root) return;
      const diffBlocks = Array.from(root.querySelectorAll('pre.sourceCode.diff code'));

      diffBlocks.forEach((codeBlock) => {
        const lineElements = Array.from(codeBlock.children).filter((child) => child instanceof HTMLElement);
        lineElements.forEach((lineEl) => {
          const text = typeof lineEl.textContent === 'string' ? lineEl.textContent : '';
          if (!text) return;

          if (/^\\+(?!\\+\\+)/.test(text)) {
            lineEl.classList.add('diff-line', 'diff-add-line');
          } else if (/^-(?!--)/.test(text)) {
            lineEl.classList.add('diff-line', 'diff-del-line');
          } else if (/^@@/.test(text)) {
            lineEl.classList.add('diff-line', 'diff-hunk-line');
          } else if (/^(?:\\+\\+\\+ |--- )/.test(text)) {
            lineEl.classList.add('diff-line', 'diff-header-line');
          } else if (DIFF_META_LINE_REGEX.test(text)) {
            lineEl.classList.add('diff-line', 'diff-meta-line');
          }

          const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
          const matches = [];
          let node = walker.nextNode();
          while (node) {
            const textNode = node;
            const value = typeof textNode.nodeValue === 'string' ? textNode.nodeValue : '';
            const parent = textNode.parentElement;
            if (value && value.toLowerCase().indexOf('[an:') !== -1 && parent && !parent.closest('a, .annotation-marker')) {
              matches.push(textNode);
            }
            node = walker.nextNode();
          }

          matches.forEach(replaceAnnotationTextNode);
        });
      });
    };

    const MATHJAX_CDN_URL = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js';

    const waitForFonts = async () => {
      if ('fonts' in document) {
        try {
          await document.fonts.ready;
        } catch {}
      }
    };

    const waitForPaint = async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };

    const extractMathFallbackTex = (text, displayMode) => {
      const source = typeof text === 'string' ? text.trim() : '';
      if (!source) return '';

      if (displayMode) {
        if (source.startsWith('$$') && source.endsWith('$$') && source.length >= 4) {
          return source.slice(2, -2).trim();
        }
        if (source.startsWith('\\\\[') && source.endsWith('\\\\]') && source.length >= 4) {
          return source.slice(2, -2).trim();
        }
        return source;
      }

      if (source.startsWith('\\\\(') && source.endsWith('\\\\)') && source.length >= 4) {
        return source.slice(2, -2).trim();
      }
      if (source.startsWith('$') && source.endsWith('$') && source.length >= 2) {
        return source.slice(1, -1).trim();
      }
      return source;
    };

    const collectMathFallbackTargets = (root) => {
      if (!root) return [];
      const nodes = Array.from(root.querySelectorAll('.math.display, .math.inline'));
      const targets = [];
      const seenTargets = new Set();

      nodes.forEach((node) => {
        const displayMode = node.classList.contains('display');
        const rawText = typeof node.textContent === 'string' ? node.textContent : '';
        const tex = extractMathFallbackTex(rawText, displayMode);
        if (!tex) return;

        let renderTarget = node;
        if (displayMode) {
          const parent = node.parentElement;
          const parentText = parent && typeof parent.textContent === 'string' ? parent.textContent.trim() : '';
          if (parent && parent.tagName === 'P' && parentText === rawText.trim()) {
            renderTarget = parent;
          }
        }

        if (seenTargets.has(renderTarget)) return;
        seenTargets.add(renderTarget);
        targets.push({ renderTarget, displayMode, tex });
      });

      return targets;
    };

    let mathJaxPromise = null;
    const ensureMathJax = () => {
      if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
        return Promise.resolve(window.MathJax);
      }
      if (mathJaxPromise) return mathJaxPromise;

      mathJaxPromise = new Promise((resolve, reject) => {
        window.MathJax = {
          loader: { load: ['[tex]/ams', '[tex]/noerrors', '[tex]/noundefined'] },
          tex: {
            inlineMath: [['\\\\(', '\\\\)'], ['$', '$']],
            displayMath: [['\\\\[', '\\\\]'], ['$$', '$$']],
            packages: { '[+]': ['ams', 'noerrors', 'noundefined'] },
          },
          options: {
            skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
          },
          startup: { typeset: false },
        };

        const script = document.createElement('script');
        script.src = MATHJAX_CDN_URL;
        script.async = true;
        script.onload = () => {
          const api = window.MathJax;
          if (api && api.startup && api.startup.promise && typeof api.startup.promise.then === 'function') {
            api.startup.promise.then(() => resolve(api)).catch(reject);
            return;
          }
          if (api && typeof api.typesetPromise === 'function') {
            resolve(api);
            return;
          }
          reject(new Error('MathJax did not initialize.'));
        };
        script.onerror = () => reject(new Error('Failed to load MathJax.'));
        document.head.appendChild(script);
      }).catch((error) => {
        mathJaxPromise = null;
        throw error;
      });

      return mathJaxPromise;
    };

    const markerNeedsMath = (text) => {
      const source = typeof text === 'string' ? text : '';
      if (!source) return false;
      const backslash = String.fromCharCode(92);
      if (source.includes(backslash + '(') || source.includes(backslash + '[') || source.includes('$$')) return true;
      for (let index = 0; index < source.length - 1; index += 1) {
        const char = source[index];
        const next = source[index + 1] || '';
        if (char === '$' && next.trim() !== '') return true;
        if (char === backslash && /[A-Za-z]/.test(next)) return true;
      }
      return false;
    };

    const renderAnnotationMarkerMath = async (root) => {
      if (!root) return;
      const markers = Array.from(root.querySelectorAll('.annotation-marker')).filter((marker) => {
        if (!(marker instanceof HTMLElement)) return false;
        if (marker.querySelector('math, mjx-container')) return false;
        const text = typeof marker.textContent === 'string' ? marker.textContent : '';
        return markerNeedsMath(text);
      });
      if (markers.length === 0) return;

      let mathJax;
      try {
        mathJax = await ensureMathJax();
      } catch (e) {
        console.error('MathJax load failed:', e);
        return;
      }

      try {
        await mathJax.typesetPromise(markers);
      } catch (e) {
        console.error('Annotation math render failed:', e);
      }
    };

    const renderMathFallback = async (root) => {
      const fallbackTargets = collectMathFallbackTargets(root);
      if (fallbackTargets.length === 0) return;

      let mathJax;
      try {
        mathJax = await ensureMathJax();
      } catch (e) {
        console.error('MathJax load failed:', e);
        return;
      }

      fallbackTargets.forEach(({ renderTarget, displayMode, tex }) => {
        renderTarget.textContent = displayMode ? '\\\\[\\n' + tex + '\\n\\\\]' : '\\\\(' + tex + '\\\\)';
      });

      try {
        await mathJax.typesetPromise(fallbackTargets.map(({ renderTarget }) => renderTarget));
      } catch (e) {
        console.error('MathJax render failed:', e);
      }
    };

${buildMermaidBrowserModule(mermaidConfigJson, mermaidIconPacksJson)}

    const root = document.getElementById('preview-root');
    try {
      await renderMermaid();
      applyPreviewAnnotationPlaceholders(root);
      decorateDiffCodeBlocks(root);
      await renderAnnotationMarkerMath(root);
      await renderMathFallback(root);
      await waitForFonts();
      await waitForPaint();
    } finally {
      window.__mermaidDone = true;
    }
  })();
  </script>
</body>
</html>`;
}

async function renderPreviewHtmlDocument(
	markdown: string,
	style: PreviewStyle,
	resourcePath?: string,
	isLatex?: boolean,
	fontSizePx?: number,
): Promise<{ html: string; normalizedMarkdown: string; fontSizePx: number }> {
	const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
	const { normalizedMarkdown, pandocMarkdown, annotationPlaceholders } = prepareBrowserPreviewMarkdown(markdown, isLatex);
	const fragmentHtml = await renderMarkdownToHtmlWithPandoc(pandocMarkdown, resourcePath, isLatex);
	return {
		html: buildBrowserHtmlFromPandocFragment(fragmentHtml, style, resourcePath, annotationPlaceholders, previewFontSizePx),
		normalizedMarkdown,
		fontSizePx: previewFontSizePx,
	};
}

async function renderPreviewHtmlToFile(
	markdown: string,
	style: PreviewStyle,
	resourcePath?: string,
	isLatex?: boolean,
	fontSizePx?: number,
	outputPath?: string,
): Promise<string> {
	const rendered = await renderPreviewHtmlDocument(markdown, style, resourcePath, isLatex, fontSizePx);
	const hash = createHash("sha256")
		.update(RENDER_VERSION)
		.update("\u0000")
		.update("browser-native")
		.update("\u0000")
		.update(style.cacheKey)
		.update("\u0000")
		.update(`fontSize=${rendered.fontSizePx}`)
		.update("\u0000")
		.update(buildRenderCacheKey("html", resourcePath, isLatex))
		.update("\u0000")
		.update(rendered.normalizedMarkdown)
		.digest("hex");
	const htmlPath = outputPath ?? join(CACHE_DIR, `${hash}.html`);

	await mkdir(dirname(htmlPath), { recursive: true });
	await writeFile(htmlPath, rendered.html, "utf-8");
	return htmlPath;
}

export async function openPreviewInBrowser(ctx: ExtensionCommandContext, markdownOverride?: string, resourcePath?: string, isLatex?: boolean, fontSizePx?: number): Promise<void> {
	const markdown = markdownOverride ?? getLastAssistantMarkdown(ctx);
	if (!markdown) {
		throw new Error("No assistant markdown found in the current branch.");
	}

	const style = getPreviewStyle(ctx.ui.theme);
	const htmlPath = await renderPreviewHtmlToFile(markdown, style, resourcePath, isLatex, fontSizePx);
	await openFileInDefaultBrowser(htmlPath, true);
}

function buildPagedPngOutputPaths(basePath: string, pageCount: number): string[] {
	if (pageCount <= 1) return [basePath];
	const extension = extname(basePath) || ".png";
	const stem = extname(basePath) ? basePath.slice(0, -extension.length) : basePath;
	return Array.from({ length: pageCount }, (_value, index) => `${stem}-${index + 1}-of-${pageCount}${extension}`);
}

async function renderPreviewPngFiles(
	markdown: string,
	style: PreviewStyle,
	outputPath?: string,
	resourcePath?: string,
	isLatex?: boolean,
	fontSizePx?: number,
	signal?: AbortSignal,
): Promise<{ paths: string[]; pageCount: number; truncatedPages: boolean; themeMode: ThemeMode }> {
	const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_TERMINAL_PREVIEW_FONT_SIZE_PX);
	const preview = await renderPreview(markdown, style, signal, resourcePath, undefined, isLatex, previewFontSizePx);
	const artifactKey = buildRenderCacheKey(`${style.cacheKey}|artifact=png|fontSize=${previewFontSizePx}|scale=${getTerminalDeviceScaleFactor()}`, resourcePath, isLatex);
	const hash = createHash("sha256")
		.update(RENDER_VERSION)
		.update("\u0000")
		.update("png-artifact")
		.update("\u0000")
		.update(artifactKey)
		.update("\u0000")
		.update(markdown)
		.digest("hex");
	const basePath = outputPath ?? join(CACHE_DIR, `${hash}.png`);
	const paths = buildPagedPngOutputPaths(basePath, preview.pages.length);

	await Promise.all(paths.map((filePath, index) => (async () => {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, Buffer.from(preview.pages[index]!.base64Png, "base64"));
	})()));

	return {
		paths,
		pageCount: preview.pages.length,
		truncatedPages: preview.truncatedPages || preview.pages.some((page) => page.truncatedHeight),
		themeMode: preview.themeMode,
	};
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	const s = input.trim();
	let i = 0;

	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i]!)) i++;
		if (i >= s.length) break;

		const ch = s[i]!;
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			let token = "";
			while (i < s.length && s[i] !== quote) {
				token += s[i];
				i++;
			}
			if (i < s.length) i++; // skip closing quote
			tokens.push(token);
		} else {
			let token = "";
			while (i < s.length && !/\s/.test(s[i]!)) {
				token += s[i];
				i++;
			}
			tokens.push(token);
		}
	}

	return tokens;
}

function parsePreviewFontSize(raw: string): { value?: number; error?: string } {
	const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
	if (!match) {
		return { error: `Invalid font size "${raw}". Use a number in px, e.g. --font-size 14.` };
	}
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < MIN_PREVIEW_FONT_SIZE_PX || value > MAX_PREVIEW_FONT_SIZE_PX) {
		return { error: `Font size must be between ${MIN_PREVIEW_FONT_SIZE_PX} and ${MAX_PREVIEW_FONT_SIZE_PX}px.` };
	}
	return { value: normalizePreviewFontSizePx(value) };
}

interface ParsedPreviewArgs {
	target?: PreviewTarget;
	pick?: boolean;
	file?: string;
	fontSizePx?: number;
	watch?: boolean;
	stop?: boolean;
	stopAll?: boolean;
	stopResponses?: boolean;
	list?: boolean;
	help?: boolean;
	error?: string;
}

function parsePreviewArgs(args: string): ParsedPreviewArgs {
	const tokens = tokenizeArgs(args);
	let target: PreviewTarget = "terminal";
	let explicitTarget = false;
	let pick = false;
	let file: string | undefined;
	let fontSizePx: number | undefined;
	let watch = false;
	let stop = false;
	let stopAll = false;
	let stopResponses = false;
	let list = false;
	let optionsEnded = false;

	const setFile = (value: string): string | undefined => {
		if (file !== undefined) return "Only one preview file path may be supplied.";
		file = value;
		return undefined;
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		if (optionsEnded) {
			const error = setFile(token);
			if (error) return { error };
			continue;
		}
		if (token === "--") {
			optionsEnded = true;
			continue;
		}

		if (token === "--help" || token === "-h" || token === "help") {
			return { help: true };
		}

		if (token === "--pick" || token === "pick" || token === "-p") {
			pick = true;
			continue;
		}

		if (token === "--watch" || token === "-w") {
			watch = true;
			continue;
		}

		if (token === "--stop") {
			stop = true;
			continue;
		}

		if (token === "--list") {
			list = true;
			continue;
		}

		if (token === "--all") {
			stopAll = true;
			continue;
		}

		if (token === "--responses") {
			stopResponses = true;
			continue;
		}

		if (token === "--file" || token === "-f") {
			const next = tokens[i + 1];
			if (next === undefined) return { error: "Missing file path after --file." };
			const error = setFile(next);
			if (error) return { error };
			i++;
			continue;
		}

		if (token === "--font-size" || token === "--font-size-px" || token === "--fs") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("-")) {
				return { error: "Missing font size after --font-size." };
			}
			const parsedFontSize = parsePreviewFontSize(next);
			if (parsedFontSize.error || parsedFontSize.value === undefined) return { error: parsedFontSize.error ?? "Invalid font size." };
			fontSizePx = parsedFontSize.value;
			i++;
			continue;
		}

		const fontSizeEquals = token.match(/^--(?:font-size|font-size-px|fs)=(.+)$/);
		if (fontSizeEquals) {
			const parsedFontSize = parsePreviewFontSize(fontSizeEquals[1]!);
			if (parsedFontSize.error || parsedFontSize.value === undefined) return { error: parsedFontSize.error ?? "Invalid font size." };
			fontSizePx = parsedFontSize.value;
			continue;
		}

		if (
			token === "--browser" ||
			token === "-b" ||
			token === "browser" ||
			token === "--external" ||
			token === "external" ||
			token === "--browser-native" ||
			token === "native"
		) {
			if (explicitTarget && target !== "browser") {
				return { error: "Conflicting output targets. Choose one of terminal, browser, or pdf." };
			}
			target = "browser";
			explicitTarget = true;
			continue;
		}

		if (token === "--pdf" || token === "pdf") {
			if (explicitTarget && target !== "pdf") {
				return { error: "Conflicting output targets. Choose one of terminal, browser, or pdf." };
			}
			target = "pdf";
			explicitTarget = true;
			continue;
		}

		if (token === "--terminal" || token === "terminal") {
			if (explicitTarget && target !== "terminal") {
				return { error: "Conflicting output targets. Choose one of terminal, browser, or pdf." };
			}
			target = "terminal";
			explicitTarget = true;
			continue;
		}

		if (token.startsWith("--engine") || token.startsWith("-engine")) {
			return { error: "Engine selection was removed. Use /preview or /preview --browser." };
		}

		if (!token.startsWith("-")) {
			const error = setFile(token);
			if (error) return { error };
			continue;
		}

		return { error: `Unknown argument \"${token}\". Use /preview [--pick|-p] [--file|-f <path>] [--browser|-b [--watch|-w [<path>]|--list|--stop [<path>|--responses|--all]]] [--pdf] [--terminal] [--font-size <px>]` };
	}

	if (file && pick) return { error: "Cannot use --pick and --file together." };
	if (watch && stop) return { error: "Cannot use --watch and --stop together." };
	if (watch && list) return { error: "Cannot use --watch and --list together." };
	if (stop && list) return { error: "Cannot use --stop and --list together." };
	if ((watch || stop || list) && target !== "browser") {
		const operation = watch ? "--watch" : stop ? "--stop" : "--list";
		return { error: `${operation} is only available for browser previews.` };
	}
	if (watch && pick) return { error: "Browser watch cannot be combined with --pick." };
	if (!stop && (stopAll || stopResponses)) return { error: `${stopAll ? "--all" : "--responses"} is only valid with --stop.` };
	if (stop && (pick || fontSizePx !== undefined)) return { error: "--stop cannot be combined with --pick or --font-size." };
	if (Number(file !== undefined) + Number(stopAll) + Number(stopResponses) > 1) {
		return { error: "Choose only one stop target: a file path, --responses, or --all." };
	}
	if (list && (file !== undefined || pick || fontSizePx !== undefined || stopAll || stopResponses)) {
		return { error: "--list cannot be combined with a file, --pick, --font-size, --responses, or --all." };
	}

	return { target, pick, file, fontSizePx, watch, stop, stopAll, stopResponses, list };
}

export default function (pi: ExtensionAPI) {
	type BrowserWatchServer = Awaited<ReturnType<typeof createBrowserWatchServer>>;
	type BrowserWatchId = "responses" | `file:${string}`;
	interface ResponseBrowserWatchSource {
		kind: "responses";
		lastResponseKey?: string;
		queuedResponseOverride?: AssistantResponseSnapshot;
	}
	interface FileBrowserWatchSource {
		kind: "file";
		filePath: string;
		lastContentHash: string;
		refreshSequence: number;
		lastError?: string;
		listener?: (current: Stats, previous: Stats) => void;
		debounceTimer?: ReturnType<typeof setTimeout>;
	}
	interface BrowserWatchState {
		id: BrowserWatchId;
		operationId: number;
		server: BrowserWatchServer;
		source: ResponseBrowserWatchSource | FileBrowserWatchSource;
		sourceLabel: string;
		resourcePath: string;
		fontSizePx: number;
		lastRenderKey: string;
		pendingRenderKey?: string;
		renderGeneration: number;
		renderInFlight?: Promise<boolean>;
		renderQueued: boolean;
		forceRenderQueued: boolean;
		lastSuccessfulAt: number;
	}
	interface BrowserWatchOperation {
		id: BrowserWatchId;
		operationId: number;
		registryEpoch: number;
	}
	interface ProvisionalBrowserWatch {
		id: BrowserWatchId;
		operation: BrowserWatchOperation;
		filePath?: string;
		sourceLabel: string;
		requestedFontSizePx: number;
		promise: Promise<void>;
		server?: BrowserWatchServer;
		fileSource?: FileBrowserWatchSource;
	}
	interface BrowserWatchCleanupResource {
		id: BrowserWatchId;
		sourceDescription: string;
		server?: BrowserWatchServer;
		source?: ResponseBrowserWatchSource | FileBrowserWatchSource;
		lastError?: string;
	}

	const RESPONSE_BROWSER_WATCH_ID: BrowserWatchId = "responses";
	const browserWatches = new Map<BrowserWatchId, BrowserWatchState>();
	const provisionalBrowserWatches = new Map<BrowserWatchId, ProvisionalBrowserWatch>();
	const pendingBrowserWatchCleanups = new Map<BrowserWatchId, BrowserWatchCleanupResource[]>();
	const browserFileWatchAliases = new Map<BrowserWatchId, BrowserWatchId>();
	const browserWatchOperationOwners = new Map<BrowserWatchId, number>();
	let nextBrowserWatchOperationId = 0;
	let browserWatchRegistryEpoch = 0;
	let agentEndFallbackSequence = 0;
	let agentEndFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let hasShownBrowserWatchHint = false;

	const getResponseBrowserWatch = (): BrowserWatchState | undefined => {
		const watch = browserWatches.get(RESPONSE_BROWSER_WATCH_ID);
		return watch?.source.kind === "responses" ? watch : undefined;
	};

	const isBrowserWatchActive = (watch: BrowserWatchState): boolean => browserWatches.get(watch.id) === watch;

	const hasBrowserWatchLifecycle = (id: BrowserWatchId): boolean =>
		browserWatches.has(id) || provisionalBrowserWatches.has(id) || pendingBrowserWatchCleanups.has(id);

	const pruneBrowserFileWatchAliases = (id: BrowserWatchId) => {
		if (id === RESPONSE_BROWSER_WATCH_ID || hasBrowserWatchLifecycle(id)) return;
		for (const [alias, target] of browserFileWatchAliases) {
			if (target === id) browserFileWatchAliases.delete(alias);
		}
	};

	const resolveBrowserFileWatchId = async (filePath: string): Promise<BrowserWatchId> => {
		const lexicalId = getBrowserFileWatchId(filePath) as BrowserWatchId;
		const aliasedId = browserFileWatchAliases.get(lexicalId);
		if (aliasedId && hasBrowserWatchLifecycle(aliasedId)) return aliasedId;
		if (aliasedId) browserFileWatchAliases.delete(lexicalId);

		const canonicalPath = await realpath(filePath);
		const canonicalId = getBrowserFileWatchId(canonicalPath) as BrowserWatchId;
		browserFileWatchAliases.set(lexicalId, canonicalId);
		browserFileWatchAliases.set(canonicalId, canonicalId);
		return canonicalId;
	};

	const resolveBrowserFileWatchIdForStop = async (filePath: string): Promise<BrowserWatchId> => {
		const lexicalId = getBrowserFileWatchId(filePath) as BrowserWatchId;
		const aliasedId = browserFileWatchAliases.get(lexicalId);
		if (aliasedId && hasBrowserWatchLifecycle(aliasedId)) return aliasedId;
		try {
			return await resolveBrowserFileWatchId(filePath);
		} catch {
			return lexicalId;
		}
	};

	const claimBrowserWatchOperation = (id: BrowserWatchId): BrowserWatchOperation => {
		const operation: BrowserWatchOperation = {
			id,
			operationId: ++nextBrowserWatchOperationId,
			registryEpoch: browserWatchRegistryEpoch,
		};
		browserWatchOperationOwners.set(id, operation.operationId);
		return operation;
	};

	const ownsBrowserWatchOperation = (operation: BrowserWatchOperation): boolean =>
		operation.registryEpoch === browserWatchRegistryEpoch
		&& browserWatchOperationOwners.get(operation.id) === operation.operationId;

	const getBrowserWatchIds = (): BrowserWatchId[] => [
		...new Set([...browserWatches.keys(), ...provisionalBrowserWatches.keys(), ...pendingBrowserWatchCleanups.keys()]),
	];

	const getBrowserWatchSourceDescription = (id: BrowserWatchId): string => {
		if (id === RESPONSE_BROWSER_WATCH_ID) return "assistant responses";
		const watch = browserWatches.get(id);
		if (watch?.source.kind === "file") return watch.source.filePath;
		return provisionalBrowserWatches.get(id)?.filePath
			?? pendingBrowserWatchCleanups.get(id)?.[0]?.sourceDescription
			?? id.slice("file:".length);
	};

	const formatBrowserWatchList = (): string => {
		const ids = getBrowserWatchIds();
		if (ids.length === 0) return "No browser preview watchers are running.";
		const lines = [`Browser preview watchers (${ids.length}/${MAX_BROWSER_WATCHES}):`];
		for (const id of ids) {
			const watch = browserWatches.get(id);
			const provisional = provisionalBrowserWatches.get(id);
			const pendingCleanup = pendingBrowserWatchCleanups.get(id);
			let status = "starting";
			if (watch) {
				status = watch.source.kind === "file" && watch.source.lastError
					? `retaining last good preview (${watch.source.lastError})`
					: `healthy, ${watch.server.historySize} ${watch.server.historySize === 1 ? "revision" : "revisions"}`;
			} else if (pendingCleanup) {
				status = `cleanup failed (${pendingCleanup[0]?.lastError ?? "retry stop"})`;
			} else if (!provisional) {
				status = "stopping";
			}
			lines.push(`- ${getBrowserWatchSourceDescription(id)} — ${status}`);
		}
		return lines.join("\n");
	};

	const clearResponseWatchFallback = () => {
		if (!agentEndFallbackTimer) return;
		clearTimeout(agentEndFallbackTimer);
		agentEndFallbackTimer = undefined;
	};

	const invalidateBrowserWatch = (watch: BrowserWatchState) => {
		watch.renderGeneration += 1;
		watch.renderQueued = false;
		watch.forceRenderQueued = false;
		watch.pendingRenderKey = undefined;
		if (watch.source.kind === "file") watch.source.refreshSequence += 1;
	};

	const cleanupBrowserWatchResources = async (
		server: BrowserWatchServer | undefined,
		source: ResponseBrowserWatchSource | FileBrowserWatchSource | undefined,
	): Promise<void> => {
		const errors: unknown[] = [];
		if (source?.kind === "file") {
			if (source.debounceTimer) {
				clearTimeout(source.debounceTimer);
				source.debounceTimer = undefined;
			}
			if (source.listener) {
				try {
					unwatchFile(source.filePath, source.listener);
					source.listener = undefined;
				} catch (error) {
					errors.push(error);
				}
			}
		}
		try {
			await server?.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Browser preview watcher cleanup failed.");
	};

	const stopBrowserWatchById = async (id: BrowserWatchId): Promise<boolean> => {
		const tombstone = claimBrowserWatchOperation(id);
		const activeWatch = browserWatches.get(id);
		const provisionalWatch = provisionalBrowserWatches.get(id);
		const existingCleanups = pendingBrowserWatchCleanups.get(id) ?? [];
		const sourceDescription = getBrowserWatchSourceDescription(id);
		if (activeWatch && browserWatches.get(id) === activeWatch) browserWatches.delete(id);
		if (provisionalWatch && provisionalBrowserWatches.get(id) === provisionalWatch) provisionalBrowserWatches.delete(id);
		pendingBrowserWatchCleanups.delete(id);
		if (id === RESPONSE_BROWSER_WATCH_ID) clearResponseWatchFallback();
		if (activeWatch) invalidateBrowserWatch(activeWatch);

		const resources: BrowserWatchCleanupResource[] = [
			...existingCleanups,
			...(activeWatch ? [{ id, sourceDescription, server: activeWatch.server, source: activeWatch.source }] : []),
			...(provisionalWatch ? [{ id, sourceDescription, server: provisionalWatch.server, source: provisionalWatch.fileSource }] : []),
		];
		const results = await Promise.allSettled(resources.map((resource) => cleanupBrowserWatchResources(resource.server, resource.source)));
		const failedResources: BrowserWatchCleanupResource[] = [];
		const cleanupErrors: unknown[] = [];
		for (let index = 0; index < results.length; index++) {
			const result = results[index]!;
			if (result.status === "fulfilled") continue;
			const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
			failedResources.push({ ...resources[index]!, lastError: message });
			cleanupErrors.push(result.reason);
		}
		if (failedResources.length > 0) pendingBrowserWatchCleanups.set(id, failedResources);
		if (browserWatchOperationOwners.get(id) === tombstone.operationId) browserWatchOperationOwners.delete(id);
		pruneBrowserFileWatchAliases(id);
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `Failed to clean up browser preview watch for ${sourceDescription}.`);
		return resources.length > 0;
	};

	const stopAllBrowserWatches = async (): Promise<number> => {
		browserWatchRegistryEpoch += 1;
		const activeWatches = [...browserWatches.values()];
		const provisionalWatches = [...provisionalBrowserWatches.values()];
		const existingCleanups = [...pendingBrowserWatchCleanups.values()].flat();
		const ids = new Set([
			...activeWatches.map((watch) => watch.id),
			...provisionalWatches.map((watch) => watch.id),
			...existingCleanups.map((resource) => resource.id),
		]);
		const resources: BrowserWatchCleanupResource[] = [
			...existingCleanups,
			...activeWatches.map((watch) => ({
				id: watch.id,
				sourceDescription: watch.source.kind === "file" ? watch.source.filePath : "assistant responses",
				server: watch.server,
				source: watch.source,
			})),
			...provisionalWatches.map((watch) => ({
				id: watch.id,
				sourceDescription: watch.filePath ?? "assistant responses",
				server: watch.server,
				source: watch.fileSource,
			})),
		];
		browserWatches.clear();
		provisionalBrowserWatches.clear();
		pendingBrowserWatchCleanups.clear();
		browserWatchOperationOwners.clear();
		clearResponseWatchFallback();
		for (const watch of activeWatches) invalidateBrowserWatch(watch);

		const results = await Promise.allSettled(resources.map((resource) => cleanupBrowserWatchResources(resource.server, resource.source)));
		const cleanupErrors: unknown[] = [];
		for (let index = 0; index < results.length; index++) {
			const result = results[index]!;
			if (result.status === "fulfilled") continue;
			const resource = resources[index]!;
			const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
			const failures = pendingBrowserWatchCleanups.get(resource.id) ?? [];
			failures.push({ ...resource, lastError: message });
			pendingBrowserWatchCleanups.set(resource.id, failures);
			cleanupErrors.push(result.reason);
		}
		for (const id of ids) pruneBrowserFileWatchAliases(id);
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Failed to clean up one or more browser preview watchers.");
		return ids.size;
	};

	const reserveProvisionalBrowserWatch = (watch: ProvisionalBrowserWatch): void => {
		if (getBrowserWatchIds().length >= MAX_BROWSER_WATCHES) {
			throw new Error(`At most ${MAX_BROWSER_WATCHES} browser preview watchers may run in one Pi session.\n${formatBrowserWatchList()}`);
		}
		provisionalBrowserWatches.set(watch.id, watch);
	};

	const getBrowserWatchRenderKey = (
		contentKey: string,
		markdown: string,
		style: PreviewStyle,
		resourcePath: string,
		fontSizePx: number,
		isLatex = false,
	): string =>
		createHash("sha256")
			.update(RENDER_VERSION)
			.update("\u0000browser-watch\u0000")
			.update(contentKey)
			.update("\u0000")
			.update(style.cacheKey)
			.update("\u0000")
			.update(resourcePath)
			.update("\u0000")
			.update(String(fontSizePx))
			.update("\u0000")
			.update(isLatex ? "latex" : "markdown")
			.update("\u0000")
			.update(markdown)
			.digest("hex");

	const performBrowserResponseWatchRefresh = async (
		ctx: ExtensionContext,
		activeWatch: BrowserWatchState,
		force = false,
		responseOverride?: AssistantResponseSnapshot,
	): Promise<boolean> => {
		if (!isBrowserWatchActive(activeWatch) || activeWatch.source.kind !== "responses") return false;
		const response = responseOverride ?? getLastAssistantResponse(ctx);
		if (!response) return false;
		const style = getPreviewStyle(ctx.ui.theme);
		const renderKey = getBrowserWatchRenderKey(response.responseKey, response.markdown, style, activeWatch.resourcePath, activeWatch.fontSizePx);
		if (!force && renderKey === activeWatch.lastRenderKey) return false;

		activeWatch.pendingRenderKey = renderKey;
		const renderGeneration = ++activeWatch.renderGeneration;
		try {
			const rendered = await renderPreviewHtmlDocument(response.markdown, style, activeWatch.resourcePath, false, activeWatch.fontSizePx);
			if (!isBrowserWatchActive(activeWatch) || activeWatch.renderGeneration !== renderGeneration || activeWatch.source.kind !== "responses") return false;
			activeWatch.server.updateDocument(rendered.html, {
				appendToHistory: response.responseKey !== activeWatch.source.lastResponseKey,
			});
			activeWatch.lastRenderKey = renderKey;
			activeWatch.source.lastResponseKey = response.responseKey;
			activeWatch.lastSuccessfulAt = Date.now();
			return true;
		} catch (error) {
			if (isBrowserWatchActive(activeWatch) && activeWatch.renderGeneration === renderGeneration) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Browser response watch refresh failed: ${message}`, "warning");
			}
			return false;
		} finally {
			if (activeWatch.pendingRenderKey === renderKey) activeWatch.pendingRenderKey = undefined;
		}
	};

	const refreshBrowserResponseWatch = (
		ctx: ExtensionContext,
		activeWatch: BrowserWatchState,
		force = false,
		responseOverride?: AssistantResponseSnapshot,
	): Promise<boolean> => {
		if (!isBrowserWatchActive(activeWatch) || activeWatch.source.kind !== "responses") return Promise.resolve(false);
		const responseSource = activeWatch.source;
		activeWatch.renderQueued = true;
		activeWatch.forceRenderQueued ||= force;
		if (responseOverride !== undefined) responseSource.queuedResponseOverride = responseOverride;
		if (activeWatch.renderInFlight) return activeWatch.renderInFlight;

		let renderPromise: Promise<boolean>;
		renderPromise = (async () => {
			let changed = false;
			while (isBrowserWatchActive(activeWatch) && activeWatch.renderQueued && activeWatch.source.kind === "responses") {
				activeWatch.renderQueued = false;
				const nextForce = activeWatch.forceRenderQueued;
				activeWatch.forceRenderQueued = false;
				const nextOverride = responseSource.queuedResponseOverride;
				responseSource.queuedResponseOverride = undefined;
				changed = await performBrowserResponseWatchRefresh(ctx, activeWatch, nextForce, nextOverride) || changed;
			}
			return changed;
		})().finally(() => {
			if (activeWatch.renderInFlight === renderPromise) activeWatch.renderInFlight = undefined;
		});
		activeWatch.renderInFlight = renderPromise;
		return renderPromise;
	};

	const readBrowserFileWatchSnapshot = async (filePath: string) => {
		const fileContent = await readFile(filePath, "utf-8");
		const prepared = prepareFilePreview(filePath, fileContent);
		const contentHash = createHash("sha256").update(fileContent).digest("hex");
		return { ...prepared, contentHash };
	};

	const notifyBrowserFileWatchError = (ctx: ExtensionContext, activeWatch: BrowserWatchState, error: unknown) => {
		if (activeWatch.source.kind !== "file" || !isBrowserWatchActive(activeWatch)) return;
		const message = error instanceof Error ? error.message : String(error);
		if (activeWatch.source.lastError === message) return;
		activeWatch.source.lastError = message;
		ctx.ui.notify(`Browser file watch refresh failed for ${activeWatch.source.filePath}; keeping the last good preview: ${message}`, "warning");
	};

	const performBrowserFileWatchRefresh = async (
		ctx: ExtensionContext,
		activeWatch: BrowserWatchState,
		force = false,
	): Promise<boolean> => {
		if (!isBrowserWatchActive(activeWatch) || activeWatch.source.kind !== "file") return false;
		const refreshSequence = ++activeWatch.source.refreshSequence;

		let snapshot: Awaited<ReturnType<typeof readBrowserFileWatchSnapshot>>;
		try {
			snapshot = await readBrowserFileWatchSnapshot(activeWatch.source.filePath);
		} catch (error) {
			if (
				isBrowserWatchActive(activeWatch)
				&& activeWatch.source.kind === "file"
				&& activeWatch.source.refreshSequence === refreshSequence
			) notifyBrowserFileWatchError(ctx, activeWatch, error);
			return false;
		}
		if (
			!isBrowserWatchActive(activeWatch)
			|| activeWatch.source.kind !== "file"
			|| activeWatch.source.refreshSequence !== refreshSequence
		) return false;

		const style = getPreviewStyle(ctx.ui.theme);
		const renderKey = getBrowserWatchRenderKey(
			`file:${snapshot.contentHash}`,
			snapshot.markdown,
			style,
			activeWatch.resourcePath,
			activeWatch.fontSizePx,
			snapshot.isLatex,
		);
		if (!force && renderKey === activeWatch.lastRenderKey) {
			activeWatch.source.lastError = undefined;
			return false;
		}

		activeWatch.pendingRenderKey = renderKey;
		const renderGeneration = ++activeWatch.renderGeneration;
		try {
			const rendered = await renderPreviewHtmlDocument(
				snapshot.markdown,
				style,
				activeWatch.resourcePath,
				snapshot.isLatex,
				activeWatch.fontSizePx,
			);
			if (!isBrowserWatchActive(activeWatch) || activeWatch.renderGeneration !== renderGeneration || activeWatch.source.kind !== "file") return false;
			activeWatch.server.updateDocument(rendered.html, {
				appendToHistory: snapshot.contentHash !== activeWatch.source.lastContentHash,
			});
			activeWatch.lastRenderKey = renderKey;
			activeWatch.source.lastContentHash = snapshot.contentHash;
			activeWatch.source.lastError = undefined;
			activeWatch.lastSuccessfulAt = Date.now();
			// Reconcile once more after a successful render. A save can land while
			// an earlier read/render is in flight, and filesystem events may coalesce.
			scheduleBrowserFileWatchRefresh(ctx, activeWatch);
			return true;
		} catch (error) {
			if (isBrowserWatchActive(activeWatch) && activeWatch.renderGeneration === renderGeneration) {
				notifyBrowserFileWatchError(ctx, activeWatch, error);
			}
			return false;
		} finally {
			if (activeWatch.pendingRenderKey === renderKey) activeWatch.pendingRenderKey = undefined;
		}
	};

	const refreshBrowserFileWatch = (
		ctx: ExtensionContext,
		activeWatch: BrowserWatchState,
		force = false,
	): Promise<boolean> => {
		if (!isBrowserWatchActive(activeWatch) || activeWatch.source.kind !== "file") return Promise.resolve(false);
		activeWatch.renderQueued = true;
		activeWatch.forceRenderQueued ||= force;
		if (activeWatch.renderInFlight) return activeWatch.renderInFlight;

		let renderPromise: Promise<boolean>;
		renderPromise = (async () => {
			let changed = false;
			while (isBrowserWatchActive(activeWatch) && activeWatch.renderQueued && activeWatch.source.kind === "file") {
				activeWatch.renderQueued = false;
				const nextForce = activeWatch.forceRenderQueued;
				activeWatch.forceRenderQueued = false;
				changed = await performBrowserFileWatchRefresh(ctx, activeWatch, nextForce) || changed;
			}
			return changed;
		})().finally(() => {
			if (activeWatch.renderInFlight === renderPromise) activeWatch.renderInFlight = undefined;
		});
		activeWatch.renderInFlight = renderPromise;
		return renderPromise;
	};

	const scheduleBrowserFileWatchRefresh = (ctx: ExtensionContext, activeWatch: BrowserWatchState) => {
		if (!isBrowserWatchActive(activeWatch) || activeWatch.source.kind !== "file") return;
		if (activeWatch.source.debounceTimer) clearTimeout(activeWatch.source.debounceTimer);
		activeWatch.source.debounceTimer = setTimeout(() => {
			if (activeWatch.source.kind === "file") activeWatch.source.debounceTimer = undefined;
			void refreshBrowserFileWatch(ctx, activeWatch);
		}, BROWSER_FILE_WATCH_DEBOUNCE_MS);
	};

	const startBrowserResponseWatch = async (ctx: ExtensionCommandContext, fontSizePx?: number): Promise<void> => {
		const id = RESPONSE_BROWSER_WATCH_ID;
		if (pendingBrowserWatchCleanups.has(id)) {
			throw new Error("The previous assistant-response watcher did not clean up completely. Retry /preview-browser --stop --responses first.");
		}
		const existingWatch = browserWatches.get(id);
		if (existingWatch) {
			if (existingWatch.source.kind !== "responses") throw new Error("Invalid response watcher state.");
			const operation = claimBrowserWatchOperation(id);
			const previewFontSizePx = fontSizePx === undefined
				? existingWatch.fontSizePx
				: normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
			const fontChanged = existingWatch.fontSizePx !== previewFontSizePx;
			existingWatch.fontSizePx = previewFontSizePx;
			if (fontChanged) await refreshBrowserResponseWatch(ctx, existingWatch, true);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(existingWatch)) return;
			await openFileInDefaultBrowser(existingWatch.server.url, true);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(existingWatch)) return;
			hasShownBrowserWatchHint = true;
			ctx.ui.notify("Browser response watch is already running; opened it again. Stop with /preview-browser --stop --responses.", "info");
			return;
		}

		const existingProvisional = provisionalBrowserWatches.get(id);
		if (existingProvisional) {
			if (fontSizePx !== undefined) {
				existingProvisional.requestedFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
			}
			await existingProvisional.promise;
			return;
		}

		const operation = claimBrowserWatchOperation(id);
		const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
		const provisional: ProvisionalBrowserWatch = {
			id,
			operation,
			sourceLabel: "Assistant responses",
			requestedFontSizePx: previewFontSizePx,
			promise: Promise.resolve(),
		};
		try {
			reserveProvisionalBrowserWatch(provisional);
		} catch (error) {
			if (browserWatchOperationOwners.get(id) === operation.operationId) browserWatchOperationOwners.delete(id);
			throw error;
		}

		let newWatch: BrowserWatchState | undefined;
		const startPromise = (async () => {
			const resourcePath = ctx.cwd;
			const style = getPreviewStyle(ctx.ui.theme);
			const response = getLastAssistantResponse(ctx);
			let html: string;
			let renderKey: string;
			if (response) {
				const rendered = await renderPreviewHtmlDocument(response.markdown, style, resourcePath, false, previewFontSizePx);
				html = rendered.html;
				renderKey = getBrowserWatchRenderKey(response.responseKey, response.markdown, style, resourcePath, previewFontSizePx);
			} else {
				html = buildBrowserHtmlFromPandocFragment(
					"<p>Waiting for the next completed assistant response…</p>",
					style,
					resourcePath,
					[],
					previewFontSizePx,
				);
				renderKey = getBrowserWatchRenderKey("waiting", "", style, resourcePath, previewFontSizePx);
			}
			if (!ownsBrowserWatchOperation(operation) || provisionalBrowserWatches.get(id) !== provisional) return;

			const server = await createBrowserWatchServer(html, resourcePath, {
				initialDocumentIsHistory: !!response,
				sourceLabel: provisional.sourceLabel,
			});
			if (!ownsBrowserWatchOperation(operation) || provisionalBrowserWatches.get(id) !== provisional) {
				await server.close();
				return;
			}
			provisional.server = server;
			newWatch = {
				id,
				operationId: operation.operationId,
				server,
				source: { kind: "responses", lastResponseKey: response?.responseKey },
				sourceLabel: provisional.sourceLabel,
				resourcePath,
				fontSizePx: provisional.requestedFontSizePx,
				lastRenderKey: renderKey,
				renderGeneration: 0,
				renderQueued: false,
				forceRenderQueued: false,
				lastSuccessfulAt: Date.now(),
			};
			browserWatches.set(id, newWatch);
			if (provisionalBrowserWatches.get(id) === provisional) provisionalBrowserWatches.delete(id);

			await refreshBrowserResponseWatch(ctx, newWatch, newWatch.fontSizePx !== previewFontSizePx);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(newWatch)) return;
			await openFileInDefaultBrowser(server.url, true);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(newWatch)) return;
			hasShownBrowserWatchHint = true;
			ctx.ui.notify("Watching completed assistant responses in browser. Stop with /preview-browser --stop --responses.", "info");
		})();
		provisional.promise = startPromise;
		try {
			await startPromise;
		} catch (error) {
			const shouldReportError = ownsBrowserWatchOperation(operation)
				&& (!newWatch || browserWatches.get(id) === newWatch);
			if (newWatch && browserWatches.get(id) === newWatch) {
				await stopBrowserWatchById(id);
			} else {
				await cleanupBrowserWatchResources(provisional.server, provisional.fileSource);
			}
			if (shouldReportError) throw error;
		} finally {
			if (provisionalBrowserWatches.get(id) === provisional) provisionalBrowserWatches.delete(id);
			if (!browserWatches.has(id) && browserWatchOperationOwners.get(id) === operation.operationId) {
				browserWatchOperationOwners.delete(id);
			}
		}
	};

	const startBrowserFileWatch = async (ctx: ExtensionCommandContext, rawFilePath: string, fontSizePx?: number): Promise<void> => {
		const filePath = resolveUserPath(ctx, rawFilePath);
		const id = await resolveBrowserFileWatchId(filePath);
		if (pendingBrowserWatchCleanups.has(id)) {
			throw new Error(`The previous watcher for ${filePath} did not clean up completely. Retry /preview-browser --stop --file ${rawFilePath} first.`);
		}
		const existingWatch = browserWatches.get(id);
		if (existingWatch) {
			if (existingWatch.source.kind !== "file") throw new Error(`Invalid file watcher state for ${filePath}.`);
			const operation = claimBrowserWatchOperation(id);
			const previewFontSizePx = fontSizePx === undefined
				? existingWatch.fontSizePx
				: normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
			const fontChanged = existingWatch.fontSizePx !== previewFontSizePx;
			existingWatch.fontSizePx = previewFontSizePx;
			await refreshBrowserFileWatch(ctx, existingWatch, fontChanged);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(existingWatch)) return;
			await openFileInDefaultBrowser(existingWatch.server.url, true);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(existingWatch)) return;
			hasShownBrowserWatchHint = true;
			ctx.ui.notify(`Browser file watch is already running for ${filePath}; opened it again.`, "info");
			return;
		}

		const existingProvisional = provisionalBrowserWatches.get(id);
		if (existingProvisional) {
			if (fontSizePx !== undefined) {
				existingProvisional.requestedFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
			}
			await existingProvisional.promise;
			return;
		}

		const operation = claimBrowserWatchOperation(id);
		const previewFontSizePx = normalizePreviewFontSizePx(fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
		const provisional: ProvisionalBrowserWatch = {
			id,
			operation,
			filePath,
			sourceLabel: getBrowserFileWatchSourceLabel(ctx, filePath),
			requestedFontSizePx: previewFontSizePx,
			promise: Promise.resolve(),
		};
		try {
			reserveProvisionalBrowserWatch(provisional);
		} catch (error) {
			if (browserWatchOperationOwners.get(id) === operation.operationId) browserWatchOperationOwners.delete(id);
			pruneBrowserFileWatchAliases(id);
			throw error;
		}

		let newWatch: BrowserWatchState | undefined;
		const startPromise = (async () => {
			const snapshot = await readBrowserFileWatchSnapshot(filePath);
			const resourcePath = dirname(filePath);
			const style = getPreviewStyle(ctx.ui.theme);
			const rendered = await renderPreviewHtmlDocument(snapshot.markdown, style, resourcePath, snapshot.isLatex, previewFontSizePx);
			const renderKey = getBrowserWatchRenderKey(
				`file:${snapshot.contentHash}`,
				snapshot.markdown,
				style,
				resourcePath,
				previewFontSizePx,
				snapshot.isLatex,
			);
			if (!ownsBrowserWatchOperation(operation) || provisionalBrowserWatches.get(id) !== provisional) return;

			const server = await createBrowserWatchServer(rendered.html, resourcePath, {
				initialDocumentIsHistory: true,
				sourceLabel: provisional.sourceLabel,
			});
			if (!ownsBrowserWatchOperation(operation) || provisionalBrowserWatches.get(id) !== provisional) {
				await server.close();
				return;
			}
			provisional.server = server;
			const fileSource: FileBrowserWatchSource = {
				kind: "file",
				filePath,
				lastContentHash: snapshot.contentHash,
				refreshSequence: 0,
			};
			provisional.fileSource = fileSource;
			newWatch = {
				id,
				operationId: operation.operationId,
				server,
				source: fileSource,
				sourceLabel: provisional.sourceLabel,
				resourcePath,
				fontSizePx: provisional.requestedFontSizePx,
				lastRenderKey: renderKey,
				renderGeneration: 0,
				renderQueued: false,
				forceRenderQueued: false,
				lastSuccessfulAt: Date.now(),
			};
			const listener = (_current: Stats, _previous: Stats) => scheduleBrowserFileWatchRefresh(ctx, newWatch!);
			fileSource.listener = listener;
			watchFile(filePath, { interval: BROWSER_FILE_WATCH_INTERVAL_MS }, listener);
			if (!ownsBrowserWatchOperation(operation) || provisionalBrowserWatches.get(id) !== provisional) {
				await cleanupBrowserWatchResources(server, fileSource);
				return;
			}
			browserWatches.set(id, newWatch);
			if (provisionalBrowserWatches.get(id) === provisional) provisionalBrowserWatches.delete(id);

			await refreshBrowserFileWatch(ctx, newWatch, newWatch.fontSizePx !== previewFontSizePx);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(newWatch)) return;
			await openFileInDefaultBrowser(server.url, true);
			if (!ownsBrowserWatchOperation(operation) || !isBrowserWatchActive(newWatch)) return;
			hasShownBrowserWatchHint = true;
			ctx.ui.notify(`Watching file changes in browser: ${filePath}.`, "info");
		})();
		provisional.promise = startPromise;
		try {
			await startPromise;
		} catch (error) {
			const shouldReportError = ownsBrowserWatchOperation(operation)
				&& (!newWatch || browserWatches.get(id) === newWatch);
			if (newWatch && browserWatches.get(id) === newWatch) {
				await stopBrowserWatchById(id);
			} else {
				await cleanupBrowserWatchResources(provisional.server, provisional.fileSource);
			}
			if (shouldReportError) throw error;
		} finally {
			if (provisionalBrowserWatches.get(id) === provisional) provisionalBrowserWatches.delete(id);
			if (!browserWatches.has(id) && browserWatchOperationOwners.get(id) === operation.operationId) {
				browserWatchOperationOwners.delete(id);
			}
			pruneBrowserFileWatchAliases(id);
		}
	};

	// Standard Pi emits agent_settled after retries and queued continuations.
	// Compatible hosts without that newer event still emit agent_end, so use a
	// short idle-check fallback there; agent_settled cancels it in standard Pi.
	pi.on("agent_end", (event, ctx) => {
		const responseWatch = getResponseBrowserWatch();
		if (!responseWatch || ("willContinue" in event && event.willContinue === true)) return;
		if (agentEndFallbackTimer) clearTimeout(agentEndFallbackTimer);
		let fallbackResponse: AssistantResponseSnapshot | undefined;
		const fallbackSequence = ++agentEndFallbackSequence;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index]!;
			if (message.role !== "assistant") continue;
			const markdown = extractAssistantMarkdownContent(message.content);
			if (!markdown) continue;
			const responseKey = getAssistantResponseKey(message, `agent-fallback:${fallbackSequence}:${index}`);
			fallbackResponse = { markdown, responseKey };
			break;
		}
		const refreshWhenCompatibleHostIsIdle = (attempt: number) => {
			agentEndFallbackTimer = setTimeout(() => {
				agentEndFallbackTimer = undefined;
				if (getResponseBrowserWatch() !== responseWatch) return;
				if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
					if (attempt < 200) refreshWhenCompatibleHostIsIdle(attempt + 1);
					return;
				}
				void refreshBrowserResponseWatch(ctx, responseWatch, false, fallbackResponse);
			}, attempt === 0 ? 0 : 50);
		};
		refreshWhenCompatibleHostIsIdle(0);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const responseWatch = getResponseBrowserWatch();
		if (!responseWatch) return;
		clearResponseWatchFallback();
		void refreshBrowserResponseWatch(ctx, responseWatch);
	});

	pi.on("session_shutdown", async () => {
		hasShownBrowserWatchHint = false;
		await Promise.all([stopAllBrowserWatches(), closeSharedPreviewBrowser()]);
	});

	const run = async (args: string, ctx: ExtensionCommandContext) => {
		const parsed = parsePreviewArgs(args);
		if (parsed.help) {
			ctx.ui.notify("Usage: /preview [--pick|-p] [--file|-f <path>] [--browser|-b [--watch|-w [<path>]|--list|--stop [<path>|--responses|--all]]] [--pdf] [--terminal] [--font-size <px>]  or  /preview <path>", "info");
			return;
		}
		if (parsed.error || !parsed.target) {
			ctx.ui.notify(parsed.error ?? "Invalid preview arguments.", "error");
			return;
		}

		if (parsed.list) {
			ctx.ui.notify(formatBrowserWatchList(), "info");
			return;
		}

		if (parsed.stop) {
			try {
				if (parsed.stopAll) {
					const stoppedCount = await stopAllBrowserWatches();
					ctx.ui.notify(stoppedCount > 0
						? `Stopped ${stoppedCount} browser preview ${stoppedCount === 1 ? "watcher" : "watchers"}.`
						: "Browser preview watch is not running.", "info");
					return;
				}

				let id: BrowserWatchId | undefined;
				let description: string | undefined;
				if (parsed.stopResponses) {
					id = RESPONSE_BROWSER_WATCH_ID;
					description = "assistant responses";
				} else if (parsed.file) {
					const filePath = resolveUserPath(ctx, parsed.file);
					id = await resolveBrowserFileWatchIdForStop(filePath);
					description = filePath;
				} else {
					const ids = getBrowserWatchIds();
					if (ids.length > 1) {
						ctx.ui.notify(`${formatBrowserWatchList()}\nChoose a file path, --responses, or --all.`, "error");
						return;
					}
					id = ids[0];
					description = id ? getBrowserWatchSourceDescription(id) : undefined;
				}

				const stopped = id ? await stopBrowserWatchById(id) : false;
				ctx.ui.notify(stopped
					? `Stopped browser preview watch for ${description}.`
					: description
						? `No browser preview watcher is running for ${description}.`
						: "Browser preview watch is not running.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to stop browser preview watch: ${message}`, "error");
			}
			return;
		}

		if (parsed.watch) {
			try {
				if (parsed.file) {
					await startBrowserFileWatch(ctx, parsed.file, parsed.fontSizePx);
				} else {
					await startBrowserResponseWatch(ctx, parsed.fontSizePx);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Browser preview watch failed: ${message}`, "error");
			}
			return;
		}

		await ctx.waitForIdle();

		let markdown: string | undefined;
		let resourcePath: string | undefined;
		let isLatex = false;
		if (parsed.file) {
			try {
				const filePath = resolveUserPath(ctx, parsed.file);
				const fileContent = await readFile(filePath, "utf-8");
				const prepared = prepareFilePreview(filePath, fileContent);
				resourcePath = dirname(filePath);
				markdown = prepared.markdown;
				isLatex = prepared.isLatex;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to read file: ${message}`, "error");
				return;
			}
		} else if (parsed.pick) {
			const picked = await pickAssistantMessage(ctx);
			if (picked === null) return;
			markdown = picked;
		}

		const effectiveMarkdown = markdown ?? getLastAssistantMarkdown(ctx);
		if (!resourcePath && effectiveMarkdown) {
			// Assistant-response previews do not have a source file, so resolve
			// relative local images and other assets against pi's current cwd.
			resourcePath = ctx.cwd;
		}

		if (parsed.target === "browser") {
			try {
				await openPreviewInBrowser(ctx, markdown, resourcePath, isLatex, parsed.fontSizePx);
				const watchHint = hasShownBrowserWatchHint
					? ""
					: " Tip: /preview-browser --watch auto-refreshes completed responses; add a file path to watch that file.";
				hasShownBrowserWatchHint = true;
				ctx.ui.notify(`Opened preview in browser.${watchHint}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Browser preview failed: ${message}`, "error");
			}
			return;
		}

		if (parsed.target === "pdf") {
			try {
				ctx.ui.notify("Exporting PDF preview...", "info");
				await exportPdf(ctx, markdown, resourcePath, isLatex);
				ctx.ui.notify("Opened PDF preview.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`PDF export failed: ${message}`, "error");
			}
			return;
		}

		await openPreview(ctx, markdown, resourcePath, isLatex, parsed.fontSizePx);
	};

	if (shouldRegisterPreviewExportTool()) {
		pi.registerTool<typeof previewExportSchema, PreviewExportToolDetails | undefined>({
			name: "preview_export",
			label: "Preview Export",
			description: "Render Markdown/LaTeX, a local file, or the latest assistant response to PDF, HTML, or PNG artifact files. Use for remote/headless/Telegram-style sessions where slash-command previews cannot display interactively.",
			promptSnippet: "Export rendered Markdown/LaTeX previews as PDF, HTML, or PNG artifact files",
			promptGuidelines: [
				"Use preview_export when the user asks to turn the latest response, provided Markdown/LaTeX, or a local Markdown/LaTeX/code file into a PDF, HTML page, or image file.",
				"If exporting content composed in the same assistant turn, preview_export should receive that content in its markdown parameter instead of relying on last_assistant.",
				"preview_export returns local artifact paths; use another available sending/uploading tool to deliver those files to the user when requested.",
			],
			parameters: previewExportSchema,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Preview export cancelled." }], details: undefined };
				}

				const input = await resolvePreviewInput(ctx, params);
				const outputPath = params.outputPath?.trim() ? resolveUserPath(ctx, params.outputPath) : undefined;
				const warnings: string[] = [];
				const format = params.format;
				const style = getPreviewStyle(ctx.ui.theme);
				const openedPaths: string[] = [];
				let paths: string[] = [];
				let pageCount: number | undefined;
				let truncatedPages: boolean | undefined;

				onUpdate?.({
					content: [{ type: "text", text: `Rendering ${format.toUpperCase()} preview from ${input.sourceDescription}...` }],
					details: undefined,
				});

				if (format === "pdf") {
					const pdfPath = await renderPreviewPdfToFile(input.markdown, outputPath, input.resourcePath, input.isLatex, (message) => {
						warnings.push(message);
						onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
					});
					paths = [pdfPath];
				} else if (format === "html") {
					const htmlPath = await renderPreviewHtmlToFile(input.markdown, style, input.resourcePath, input.isLatex, params.fontSizePx, outputPath);
					paths = [htmlPath];
				} else {
					const pngResult = await renderPreviewPngFiles(input.markdown, style, outputPath, input.resourcePath, input.isLatex, params.fontSizePx, signal);
					paths = pngResult.paths;
					pageCount = pngResult.pageCount;
					truncatedPages = pngResult.truncatedPages;
				}

				if (params.open && paths.length > 0) {
					const toOpen = format === "png" ? [paths[0]!] : paths;
					for (const filePath of toOpen) {
						await openFileInDefaultBrowser(filePath);
						openedPaths.push(filePath);
					}
				}

				const mimeType = format === "pdf" ? "application/pdf" : format === "html" ? "text/html" : "image/png";
				const details: PreviewExportToolDetails = {
					format,
					source: input.source,
					sourceDescription: input.sourceDescription,
					paths,
					mimeType,
					opened: openedPaths.length > 0,
					...(openedPaths.length > 0 ? { openedPaths } : {}),
					...(pageCount !== undefined ? { pageCount } : {}),
					...(truncatedPages !== undefined ? { truncatedPages } : {}),
					...(warnings.length > 0 ? { warnings } : {}),
				};

				const title = format === "png" && paths.length > 1 ? `Exported PNG preview pages (${paths.length})` : `Exported ${format.toUpperCase()} preview`;
				const lines = [
					`${title} from ${input.sourceDescription}.`,
					...paths.map((filePath) => `- ${filePath}`),
				];
				if (openedPaths.length > 0) {
					lines.push(`Opened ${openedPaths.length === 1 ? "artifact" : "artifacts"}: ${openedPaths.join(", ")}`);
				}
				if (warnings.length > 0) {
					lines.push("Warnings:", ...warnings.map((warning) => `- ${warning}`));
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details,
				};
			},
		});
	}

	pi.registerCommand("preview", {
		description: "Rendered markdown preview (--pick select response, --file <path> or bare path, --browser/-b for HTML, --watch/-w to auto-refresh responses or files, --list/--stop manage watchers, --pdf for PDF, --terminal to force inline, --font-size <px>)",
		handler: run,
	});

	pi.registerCommand("preview-browser", {
		description: "Open browser preview (--watch/-w starts or reopens response/file watchers; --list and --stop manage them)",
		handler: async (args, ctx) => {
			await run(`--browser ${args}`.trim(), ctx);
		},
	});

	pi.registerCommand("preview-pdf", {
		description: "Export markdown to PDF via pandoc + LaTeX and open it",
		handler: async (args, ctx) => {
			// Re-use the main run handler with --pdf prepended
			await run(`--pdf ${args}`.trim(), ctx);
		},
	});

	pi.registerCommand("preview-clear-cache", {
		description: `Clear rendered preview cache (${CACHE_DIR})`,
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				await rm(CACHE_DIR, { recursive: true, force: true });
				ctx.ui.notify(`Cleared preview cache: ${CACHE_DIR}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to clear preview cache: ${message}`, "error");
			}
		},
	});
}
