import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ts from "typescript";
import { normalizeSubSupTags } from "../shared/markdown-sub-sup.js";
import { normalizeDetailsBlocks } from "../shared/markdown-details.js";
import { createBrowserWatchServer } from "../shared/browser-watch-server.js";
import { openWatchControls } from "./watch-controls.mjs";

const affiliation = "Alan Li<sup>1</sup>, Oliver Maclaren<sup>1,2</sup>\n\n<sup>1</sup> Department\n\nH<sub>2</sub>O";
assert.equal(normalizeSubSupTags(affiliation), "Alan Li^1^, Oliver Maclaren^1,2^\n\n^1^ Department\n\nH~2~O");
assert.equal(normalizeSubSupTags("<SUP>1, 2</SUP>"), "^1,\\ 2^");
const literalCases = [
	"`<sup>1</sup>`", "``<sub>2</sub> ` example``", "    <sup>1</sup>\n", "\t<sub>2</sub>\n",
	"```html\n<sup>1</sup>\n```", "~~~html\n<sub>2</sub>\n~~~", "```\n<sup>1</sup>",
	"> ```html\n> <sup>1</sup>\n> ```", "- ```html\n  <sup>1</sup>\n  ```",
	"\\<sup>1</sup>", "<sup>1\\</sup>", "&lt;sup&gt;1&lt;/sup&gt;", "<!-- <sup>1</sup> -->",
	'<a title="<sup>1</sup>">link</a>', '[link](target "<sup>1</sup>")', '[link]: target "<sup>1</sup>"',
	"<sup onclick='alert(1)'>1</sup>", "<sup><em>1</em></sup>", "<sup><sub>1</sub></sup>", "<sup>line\nbreak</sup>",
	"<sup>unclosed", "<sup>1</sub>", "<sup></sup>", "$<sup>1</sup>$", "$$\n<sub>2</sub>\n$$",
	String.raw`\(<sup>1</sup>\)`, String.raw`\[<sub>2</sub>\]`,
	'---\ntitle: "<sup>1</sup>"\n---\n', '\uFEFF---\r\ntitle: "<sup>1</sup>"\r\n---\r\n',
];
for (const literal of literalCases) assert.equal(normalizeSubSupTags(literal), literal, "Preserve literal: " + literal);
assert.equal(normalizeSubSupTags('`<sup>1</sup>` next <sup>2</sup>'), '`<sup>1</sup>` next ^2^');
assert.equal(normalizeSubSupTags('<div>\n`<sup>1</sup>` next <sup>2</sup>\n</div>'), '<div>\n`<sup>1</sup>` next ^2^\n</div>');
assert.equal(normalizeSubSupTags('Prose\r\n\r\n<sup>1</sup>\r\n'), 'Prose\r\n\r\n^1^\r\n');
const pandoc = (source, format) => {
	const result = spawnSync(process.env.PANDOC_PATH || "pandoc", ["-f", "markdown+tex_math_dollars-raw_html-raw_attribute", "-t", format, "--wrap=none"], { input: source, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
};
const latex = pandoc(normalizeSubSupTags(affiliation), "latex");
assert.match(latex, /Li\\textsuperscript\{1\}/);
assert.match(latex, /Maclaren\\textsuperscript\{1,2\}/);
assert.match(latex, /H\\textsubscript\{2\}O/);
assert.match(pandoc(normalizeSubSupTags('<sup>1, 2</sup>'), 'html5'), /<sup>1,\s2<\/sup>/);

// Collapsible blocks: whole-line, paired, outside literal contexts; summary is text.
const collapsible = "Intro\n\n<details>\n<summary>Aliases & `more`</summary>\n\n- Pick: `-p`\n\n<details open><summary>Inner</summary>\n\nNested\n\n</details>\n\n</details>\n\nAfter";
const nonce = "0123456789abcdef";
const detailsMarkdown = normalizeDetailsBlocks(collapsible, nonce);
assert.ok(detailsMarkdown.includes("```{.pi-preview-details-marker}\nPiPreviewDetails0123456789abcdefOpen1\n```\n\n\n```{.pi-preview-details-marker}\nPiPreviewDetails0123456789abcdefSummary1 Aliases & \\`more\\`\n```"), detailsMarkdown);
assert.ok(detailsMarkdown.includes("PiPreviewDetails0123456789abcdefOpenExpanded0\n```\n\n\n```{.pi-preview-details-marker}\nPiPreviewDetails0123456789abcdefSummary0 Inner\n```"));
const detailsLiterals = [
	"```html\n<details>\n<summary>S</summary>\n</details>\n```", "    <details>\n    </details>\n", "> <details>\n> </details>",
	"<!-- <details>\n</details> -->", "<details onclick='alert(1)'>\nBody\n</details>", "<details class=\"x\">\nBody\n</details>",
	"<details>\nNever closed", "Body\n</details>", "  <details>\n  </details>", "Text <details>inline</details> text",
	'---\ntitle: "<details>"\n---\n', "$$\n<details>\nx+y\n</details>\n$$\n", "$<details>$ and $</details>$",
];
for (const literal of detailsLiterals) assert.equal(normalizeDetailsBlocks(literal, nonce), literal, "Preserve literal: " + literal);
const detailsFilter = resolve("shared/pandoc-details.lua");
const pandocDetails = (markdown, format = "html5") => {
	const result = spawnSync(process.env.PANDOC_PATH || "pandoc", ["-f", "markdown+tex_math_dollars-raw_html-raw_attribute", "-t", format, "--wrap=none", `--lua-filter=${detailsFilter}`, `--metadata=pi-preview-details:${nonce}`], { input: normalizeDetailsBlocks(markdown, nonce), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
};
const detailsHtml = pandocDetails(collapsible);
assert.match(detailsHtml, /<details class="pi-preview-details"><summary>Aliases &amp; `more`<\/summary>/);
assert.match(detailsHtml, /<details class="pi-preview-details" open><summary>Inner<\/summary>\s*<p>Nested<\/p>\s*<\/details>\s*<\/details>/);
assert.doesNotMatch(detailsHtml, /&lt;\/?(?:details|summary)|PiPreviewDetails/);
const detailsLatex = pandocDetails(collapsible, "latex");
assert.match(detailsLatex, /\\textbf\{Aliases \\& `more`\}/);
// PDF indents the content under the summary, one list level per block.
assert.match(detailsLatex, /\\textbf\{Inner\}\s+\\begin\{list\}\{\}\{\\setlength\{\\leftmargin\}\{1\.5em\}[^\n]*\\item\\relax\s+Nested\s+\\end\{list\}\s+\\end\{list\}/);
assert.doesNotMatch(pandocDetails("<details>\n<summary>Empty</summary>\n</details>\n", "latex"), /\\begin\{list\}/, "an empty block adds no list");
assert.doesNotMatch(detailsLatex, /details|summary|PiPreviewDetails/i);
// Literal fence lines in the content cannot end the block early.
for (const fence of [":::", "::::::::"]) assert.match(pandocDetails(`<details>\n<summary>S</summary>\n\nBEFORE\n\n${fence}\n\nTAIL\n\n</details>\n`), new RegExp(`<p>BEFORE</p>\\s*<p>${fence}</p>\\s*<p>TAIL</p>\\s*</details>`));
// A rejected inner tag keeps its own partner; the outer block ends at its own close.
for (const inner of ['<details class="example">', "  <details>"]) {
	const html = pandocDetails(`<details>\n<summary>Outer</summary>\n\n${inner}\nNESTED\n</details>\n\nTAIL\n</details>\n`);
	assert.match(html, /<p>TAIL<\/p>\s*<\/details>/, inner);
	assert.doesNotMatch(html, /TAIL &lt;\/details&gt;/, inner);
}
// Rejected tags in every form keep their own partner: quoted >, multiline, a close inside an attribute, math in an attribute, a multiline close.
for (const inner of ['<details title="a > b">', '<details\n class="example">', '<details title="</details>">', '<details title="$x$">']) {
	const html = pandocDetails(`<details>\n<summary>Outer</summary>\n\n${inner}\nINNER\n</details>\n\nTAIL\n</details>\n`);
	assert.match(html, /<p>TAIL<\/p>\s*<\/details>/, inner);
}
assert.match(pandocDetails('<details>\n<summary>Outer</summary>\n\n<details class="x">\nINNER\n</details\n>\n\nTAIL\n</details>\n'), /<details class="pi-preview-details"><summary>Outer<\/summary>[\s\S]*<p>TAIL<\/p>\s*<\/details>/);
// Markers can't be reinterpreted as Markdown structure (tight definition lists), in HTML or PDF output.
for (const tight of ["<details><summary>S</summary>\n: BODY\n</details>\n", "<details>\n: BODY\n</details>\n", "<details><summary>S</summary>\nBODY\n</details>\n: AFTER\n", "<details><summary>S</summary>\n:\tBODY\n</details>\n"]) {
	for (const format of ["html5", "latex"]) assert.doesNotMatch(pandocDetails(tight, format), /PiPreviewDetails|0123456789abcdef/, `${format}: ${tight}`);
	assert.match(pandocDetails(tight), /<details class="pi-preview-details"><summary>(?:S|Details)<\/summary>/, tight);
}
// A tag quoted by inline math stays quoted, and its block pairs around it.
for (const math of ["$<details>$", "$</details>$"]) assert.match(pandocDetails(`<details>\n<summary>Outer</summary>\n\n${math}\n\nTAIL\n</details>\n`), /<details class="pi-preview-details"><summary>Outer<\/summary>[\s\S]*<span class="math inline">[\s\S]*<p>TAIL<\/p>\s*<\/details>/, math);
// Text inside any tag's attributes (namespaced names too) is never read as a tag.
assert.match(pandocDetails('<details><summary>Outer</summary>\n\n<svg:thing title="</details>">literal</svg:thing>\n\nTAIL\n</details>\n'), /<p>TAIL<\/p>\s*<\/details>/);
assert.doesNotMatch(pandocDetails('<svg:thing title="\n<details>\n<summary>S</summary>\nBODY\n</details>\n">\nOther\n</svg:thing>\n'), /<details class/);
// A summary needs both of its tags outside code and escapes.
assert.match(pandocDetails("<details>\n<summary>Literal `</summary>\nBODY`\n</details>\n"), /<summary>Details<\/summary>\s*<p>&lt;summary&gt;Literal <code>&lt;\/summary&gt; BODY<\/code><\/p>/);
assert.match(pandocDetails("<details>\n<summary>Literal \\</summary>\n\nB\n</details>\n"), /<summary>Details<\/summary>/);
assert.doesNotMatch(pandocDetails("<details><summary>Literal \\</summary>\n\nB\n</details>\n"), /<details class/);
// Character references follow Pandoc's own (case-sensitive) table; unknown names stay literal.
assert.match(pandocDetails("<details><summary>A &Lt; &Gt; &Larr; &alpha; &ne; &Amp; &constructor; Z</summary>\n\nB\n\n</details>\n"), /<summary>A ≪ ≫ ↞ α ≠ &amp;Amp; &amp;constructor; Z<\/summary>/);
// Non-ASCII summaries survive intact (no locale-sensitive byte trimming), and lowercasing never shifts positions.
for (const [summary, shown] of [["你", "你"], ["x ≠", "x ≠"], ["x&nbsp;", "x\u00a0"], ["İstanbul", "İstanbul"]]) {
	for (const opening of [`<details><summary>${summary}</summary>`, `<details>\n<summary>${summary}</summary>`]) {
		assert.match(pandocDetails(`${opening}\nBODY\n</details>\n`), new RegExp(`<summary>${shown}</summary>`), opening);
	}
}
// A tag name runs to whitespace, "/" or ">", as browsers read it: <details.x> is not a details tag.
assert.match(pandocDetails("<details><summary>Outer</summary>\n\n<details.panel-example>literal</details.panel-example>\n\nTAIL\n</details>\n"), /<p>TAIL<\/p>\s*<\/details>/);
// The summary is text: references decode, backticks stay literal.
assert.match(pandocDetails("<details><summary>Fish &amp; chips &#x1F41F; &copy; ``` x</summary>\n\nB\n\n</details>\n"), /<summary>Fish &amp; chips 🐟 © ``` x<\/summary>/);
// Display math keeps its source; a marker that crosses a container boundary shows the literal tags; a forged marker is text.
assert.match(pandocDetails("$$\n<details>\nx+y\n</details>\n$$\n"), /<span class="math display">/);
assert.match(pandocDetails("::: note\n<details>\n<summary>Crossing</summary>\n\nBody\n:::\n\n</details>\n"), /<p>&lt;details&gt;<\/p>\s*<p>&lt;summary&gt;Crossing&lt;\/summary&gt;<\/p>/);
assert.match(pandocDetails("PiPreviewDetailsffffffffffffffffOpen0\n"), /<p>PiPreviewDetailsffffffffffffffffOpen0<\/p>/);
// Pandoc's reader passes an unclosed <div> through as raw HTML; the filter shows it as text, attributes and all.
assert.match(pandocDetails("<div ID=x onclick=\"alert(1)\">\n\nBody\n"), /<p>&lt;div ID=x onclick="alert\(1\)"&gt;<\/p>\s*<p>Body<\/p>/);
assert.doesNotMatch(pandocDetails("<div id='x'>\n\n<details><summary>S</summary>\n\nB\n</details>\n"), /<div\b/);
assert.match(pandocDetails("<div id='x'>\n\n<details><summary>S</summary>\n\nB\n</details>\n"), /<details class="pi-preview-details"><summary>S<\/summary>/);
assert.match(pandocDetails("<div class=\"a\">\n\nx\n\n</div>\n"), /<div class="a">\s*<p>x<\/p>\s*<\/div>/);
assert.match(pandocDetails("<div id=x>\n\nBody\n", "latex"), /\\textless div id=x\\textgreater\{\}\s+Body/);

const scratch = await mkdtemp(join(tmpdir(), "pi-markdown-preview-document-updates-"));
const modulePath = resolve(`.pi-markdown-preview-document-updates-${process.pid}.mjs`);
const source = readFileSync(resolve("index.ts"), "utf8");
const compiled = ts.transpileModule(source + '\nexport { getPreviewStyle, prepareBrowserPreviewMarkdown, renderPreviewHtmlDocument, renderPreview, collectPreviewPageLayout, buildBlockAwarePageClips, PAGE_HEIGHT_PX, withStaticScriptPolicy };', {
	compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let preview;
let browser;
const servers = [];
try {
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
	await writeFile(modulePath, compiled);
	try { preview = await import(pathToFileURL(modulePath).href); }
	finally {
		await rm(modulePath, { force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	const style = preview.getPreviewStyle(undefined);
	const html = async markdown => (await preview.renderPreviewHtmlDocument(markdown, style, scratch)).html.replace('</head>', '<style>html { overflow-anchor: none; }</style></head>');
	// Sections: the answer keeps its IDs, and a later section whose prefix one of them starts with gets a free one.
	const laterNote = "Note[^n]\n\n[^n]: SECOND_NOTE\n";
	for (const [answer, later, id] of [["# s1-fn1\n\nAnswer\n", laterNote, "s1-1-fn1"], ["# s1-fn1\n\n# s1-1-fn1\n", laterNote, "s1-2-fn1"], ["# s1-cb1\n\nAnswer\n", "```python\nx = 1\n```\n", "s1-1-cb1"]]) {
		const body = (await preview.renderPreviewHtmlDocument([answer, later], style, scratch)).html.split('id="preview-root"')[1];
		const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
		assert.deepEqual(ids.filter((value, i) => ids.indexOf(value) !== i), [], `${JSON.stringify(answer)}: no duplicate IDs`);
		assert.ok(ids.includes(id) && answer.match(/s1-[\w-]+/g).every(heading => ids.includes(heading)), `${JSON.stringify(answer)}: ${id}, and the answer keeps its IDs`);
		if (later === laterNote) assert.match(body, new RegExp(`href="#${id}" class="footnote-ref"[^]*id="${id}"[^>]*>[^]*?SECOND_NOTE`), "the reference links to its own note");
	}
	for (const sections of [["<div id='s1-fn1'>\n\nBody\n", laterNote], ["Answer\n", '<div id="target">\n\nx\n', '<div id="target">\n\ny\n']]) {
		const body = (await preview.renderPreviewHtmlDocument(sections, style, scratch)).html.split('id="preview-root"')[1];
		assert.doesNotMatch(body, /<div\b[^>]*\bid\s*=\s*["']?(?:s1-fn1|target)\b/i, "an unclosed <div> keeps no ID");
		assert.match(body, /&lt;div id=/, "it is shown as text");
		if (sections[1] === laterNote) assert.match(body, /href="#s1-fn1" class="footnote-ref"[^]*id="s1-fn1"[^>]*>[^]*?SECOND_NOTE/, "the later section keeps s1-");
	}
	const prepared = preview.prepareBrowserPreviewMarkdown(affiliation);
	assert.equal(prepared.normalizedMarkdown, normalizeSubSupTags(affiliation));
	assert.equal(preview.prepareBrowserPreviewMarkdown(affiliation, true).normalizedMarkdown, affiliation, 'Do not normalize LaTeX source.');
	const { executablePath, args } = preview.getPreviewBrowserLaunchOptions();
	browser = await puppeteer.launch({ headless: true, executablePath, args });
	const page = await browser.newPage();
	await page.setViewport({ width: 1000, height: 700 });
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	const ready = () => page.waitForFunction(() => window.__mermaidDone === true);
	const fixture = affiliation + '\n\n`<sup>literal</sup>`\n\n```html\n<sub>literal</sub>\n```\n\n<sup onclick="window.bad = true">unsafe</sup>\n\n<script>window.bad = true</script>';
	await page.setContent(await html(fixture));
	await ready();
	assert.deepEqual(await page.$$eval('#preview-root sup', elements => elements.map(e => e.textContent)), ['1', '1,2', '1']);
	assert.equal(await page.$eval('#preview-root sub', e => e.textContent), '2');
	assert.deepEqual(await page.$$eval('#preview-root code', elements => elements.map(e => e.textContent.trim())), ['<sup>literal</sup>', '<sub>literal</sub>']);
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false);
	assert.equal(await page.$eval('sup', e => getComputedStyle(e).verticalAlign), 'super');
	const punctuated = '<sup>* _ ^ ~ $ [1] &amp; ²</sup>';
	await page.setContent(await html(punctuated));
	await ready();
	assert.equal(await page.$eval('sup', e => e.textContent.replace(/\u00a0/g, ' ')), '* _ ^ ~ $ [1] & ²');
	// A collapsible block renders closed in the browser, opens on click, and keeps code literal.
	await page.setContent(await html(collapsible + '\n\n`<details>`\n\n<details onclick="window.bad = true">\nUnsafe\n</details>'));
	await ready();
	assert.deepEqual(await page.$$eval('#preview-root details.pi-preview-details', elements => elements.map(e => [e.querySelector(':scope > summary').textContent, e.open])), [['Aliases & `more`', false], ['Inner', true]]);
	assert.equal(await page.$eval('#preview-root details.pi-preview-details li', e => e.checkVisibility()), false, 'closed by default');
	await page.click('#preview-root details.pi-preview-details > summary');
	assert.equal(await page.$eval('#preview-root details.pi-preview-details li', e => e.checkVisibility()), true, 'the summary toggles it');
	// An open block's content is indented past its summary, so a nested block's end is visible.
	const left = selector => page.$eval(selector, e => e.getBoundingClientRect().left);
	const [outerSummary, outerList, innerSummary, innerText] = await Promise.all(['#preview-root details > summary', '#preview-root details > ul', '#preview-root details details > summary', '#preview-root details details > p'].map(left));
	assert.ok(outerList > outerSummary && innerSummary > outerSummary && innerText > innerSummary, `indented: ${[outerSummary, outerList, innerSummary, innerText]}`);
	assert.equal(await page.$eval('#preview-root details details', e => getComputedStyle(e, '::details-content').borderLeftStyle), 'solid', 'the open content has a rule');
	assert.match(await page.$eval('#preview-root', e => e.textContent), /<details onclick=.window\.bad = true.>/, 'attributed tags stay literal text (quotes may be curled)');
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false);
	// A static image can't be clicked: hidden content is rendered expanded.
	const tall = '<details>\n<summary>Long</summary>\n\n' + Array.from({ length: 120 }, (_, i) => `Line ${String(i).padStart(3, '0')} of the collapsed content.`).join('\n\n') + '\n\n</details>';
	assert.ok((await preview.renderPreview(tall, style, undefined, scratch, true)).pages.length > 1, 'collapsed content is expanded in terminal images');
	// Page breaks fall between the expanded block's paragraphs, never through one.
	await page.setContent(await html(tall));
	await ready();
	await page.evaluate(() => { for (const details of document.querySelectorAll('details')) details.open = true; });
	const tallHeight = await page.$eval('#preview-root', e => Math.ceil(e.getBoundingClientRect().height + 40));
	const layout = await preview.collectPreviewPageLayout(page);
	const clips = preview.buildBlockAwarePageClips(tallHeight, layout.breakCandidates, layout.protectedRanges, preview.PAGE_HEIGHT_PX);
	assert.ok(clips.length > 1);
	const paragraphs = await page.$$eval('#preview-root details p', elements => elements.map(e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; }));
	for (const clip of clips.slice(1)) assert.equal(paragraphs.some(([top, bottom]) => top < clip.y && bottom > clip.y), false, `page break at ${clip.y} cuts a paragraph`);
	// Pandoc's attribute syntax cannot add event handlers or script URLs, from Markdown or LaTeX.
	const attack = '::: {.review onclick="window.bad = true" ONMOUSEOVER="window.bad = true"}\nTRIGGER [link](#){onclick="window.bad = true"} `code`{onclick="window.bad = true"}\n:::\n\n[js](javascript:window.bad=true) ![img](javascript:window.bad=true) [ok](https://example.com)\n\n# Heading {onclick="window.bad = true"}';
	const attackHtml = await html(attack);
	assert.doesNotMatch(attackHtml.slice(attackHtml.indexOf('id="preview-root"')), /\son[a-z]+=|javascript:/i);
	assert.match(attackHtml, /<a href="https:\/\/example\.com">ok<\/a>/);
	const latexAttack = (await preview.renderPreviewHtmlDocument('\\href{javascript:window.bad=true}{latex link} \\href{https://example.com}{ok}', style, scratch, true)).html;
	assert.doesNotMatch(latexAttack.slice(latexAttack.indexOf('id="preview-root"')), /javascript:/i);
	await page.setContent(attackHtml);
	await ready();
	for (const selector of ['#preview-root .review', '#preview-root .review a', '#preview-root .review code', '#preview-root h1']) await page.click(selector).catch(() => {});
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false, 'no handler survives the filter');
	// MathJax renders \\href in math without a script URL (ui/safe), even without a page policy.
	await page.setContent(await html('Before $\\href{javascript:window.bad=true}{TRIGGER}$ after'));
	await ready();
	await page.waitForSelector('#preview-root mjx-container', { timeout: 20000 });
	assert.equal(await page.$$eval('#preview-root [href]', links => links.filter(link => /^\s*javascript:/i.test(link.getAttribute('href'))).length), 0, 'no javascript: link from math');
	await page.click('#preview-root mjx-container').catch(() => {});
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false);
	// A scheme split by a newline or tab, which browsers drop before reading it, is caught too, from Markdown or LaTeX input.
	const scriptLinks = () => page.$$eval('#preview-root [href]', links => links.filter(link => /^[\u0000-\u0020]*javascript:/i.test(link.getAttribute('href').replace(/[\t\n\r]/g, ''))).length);
	for (const [source, latex] of [['$\\href{java\nscript:window.bad=true}{T}$', false], ['$\\href{java\tscript:window.bad=true}{T}$', false], ['$\\href{java\nscript:window.bad=true}{T}$', true]]) {
		await page.setContent((await preview.renderPreviewHtmlDocument(source, style, scratch, latex)).html);
		await ready();
		await page.waitForSelector('#preview-root mjx-container', { timeout: 20000 });
		assert.equal(await scriptLinks(), 0, JSON.stringify(source));
	}
	// Static HTML carries a script policy: the page's own scripts (Mermaid) still run; an injected inline handler does not.
	const mermaid = '```mermaid\nflowchart LR\n  A --> B\n```';
	const guarded = preview.withStaticScriptPolicy((await html(mermaid)).replace(/<body[^>]*>/, body => `${body}<button id="injected" onclick="window.bad = true">x</button>`));
	assert.match(guarded, /<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-[^']+' 'strict-dynamic'/);
	assert.equal((guarded.match(/<script(?=[\s>])/g) ?? []).length, (guarded.match(/<script nonce="/g) ?? []).length, 'every script carries the nonce');
	// Control: without the policy, the injected handler runs.
	const unguardedFile = join(scratch, 'unguarded.html');
	await writeFile(unguardedFile, (await html(mermaid)).replace(/<body[^>]*>/, body => `${body}<button id="injected" onclick="window.bad = true">x</button>`));
	await page.goto(pathToFileURL(unguardedFile).href);
	await ready();
	await page.click('#injected');
	assert.equal(await page.evaluate(() => Boolean(window.bad)), true, 'control: an unguarded inline handler runs');
	// Loaded from a file, as one-shot previews, exports and terminal renders are.
	const guardedFile = join(scratch, 'guarded.html');
	await writeFile(guardedFile, guarded);
	await page.goto(pathToFileURL(guardedFile).href);
	await ready();
	assert.deepEqual(await page.evaluate(() => window.__mermaidRenderResult), { status: 'success' }, 'Mermaid renders under the policy');
	assert.equal(await page.$$eval('svg', svgs => svgs.length), 1);
	await page.click('#injected');
	assert.equal(await page.evaluate(() => Boolean(window.bad)), false, 'the policy refuses an inline handler');
	assert.equal((await preview.renderPreview(mermaid, style, undefined, scratch, true)).pages.length, 1, 'terminal renders work under the policy');
	const png = await preview.renderPreview(affiliation, style, undefined, scratch, true);
	assert.equal(Buffer.from(png.pages[0].base64Png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

	const document = (prefix = '', label = 'Section') => prefix + '\n\n' + Array.from({ length: 65 }, (_, index) =>
		`## ${label} ${index}\n\nParagraph ${index}: ` + 'A stable reading anchor with enough prose to wrap over several lines. '.repeat(8)
		+ (index === 4 ? '\n\n```text\n' + 'long code '.repeat(100) + '\n```' : ''),
	).join('\n\n');
	const baseHtml = await html(document());
	const updatedHtml = await html(document('## Added above\n\n' + 'Inserted material above the reading position. '.repeat(100)));
	async function serverFor(content, options = {}) {
		const server = await createBrowserWatchServer(content, scratch, options);
		servers.push(server);
		return server;
	}
	const file = await serverFor(baseHtml, { preserveReadingPosition: true, sourceLabel: 'document.md' });
	const navigateUpdate = async (server, content) => {
		const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
		server.updateDocument(content);
		await navigation;
		await ready();
	};
	const target = '#section-35';
	const top = () => page.$eval(target, element => element.getBoundingClientRect().top);
	const scrollToTarget = async () => page.$eval(target, element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 60));
	const assertPosition = async (expected, message) => {
		try {
			await page.waitForFunction((selector, offset) => Math.abs(document.querySelector(selector).getBoundingClientRect().top - offset) < 4, { timeout: 5000 }, target, expected);
		} catch (cause) {
			throw new Error(`${message || 'Reading position'}: expected ${expected}, got ${await top()} on ${new URL(page.url()).search}`, { cause });
		}
		assert.ok(Math.abs(await top() - expected) < 4, message); // Allow cumulative CSS-pixel rounding across revisions.
	};
	await page.goto(file.url, { waitUntil: 'domcontentloaded' });
	await ready();
	await openWatchControls(page);
	await page.click('[data-watch-control="wrap-code"]');
	await scrollToTarget();
	const initialTop = await top();
	await navigateUpdate(file, updatedHtml);
	await assertPosition(initialTop, 'Insertions above the viewport must not displace the reading anchor.');
	assert.equal(await page.$eval('#preview-root', e => e.dataset.wrapCode), 'true', 'Restore after applying persisted wrapping.');
	await navigateUpdate(file, updatedHtml.replace('Paragraph 35:', 'Edited paragraph 35:'));
	await assertPosition(initialTop, 'A nearby unchanged anchor should handle edits to the paragraph being read.');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await ready();
	await assertPosition(initialTop, 'Manual reload of the same file should also preserve position.');
	// Previous/Next are still the same file; history browsing must not auto-follow.
	await openWatchControls(page);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-watch-control="previous"]')]);
	await ready();
	await assertPosition(initialTop, 'Same-file revision navigation should retain the reading position.');
	const olderUrl = page.url();
	file.updateDocument(baseHtml);
	await page.waitForFunction(() => document.querySelector('[data-watch-control="latest"]').textContent.includes('(new)'));
	assert.equal(page.url(), olderUrl);
	await assertPosition(initialTop, 'A new revision must not disturb an older page being read.');
	await openWatchControls(page);
	await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-watch-control="latest"]')]);
	await ready();
	await assertPosition(initialTop);

	// Simulate delayed math/PDF layout without relying on a CDN. The real render
	// completion signal is used; even changes after initial paint must settle first.
	const delayed = baseHtml.replace("window.__mermaidDone = true;", `window.finishLayout = () => {
		const block = document.createElement('div'); block.style.height = '650px'; document.getElementById('preview-root').prepend(block);
		window.__mermaidDone = true; window.dispatchEvent(new Event('pi-markdown-preview-ready'));
	};`);
	let navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await page.waitForFunction(() => typeof window.finishLayout === 'function');
	await page.evaluate(() => window.finishLayout());
	await assertPosition(initialTop, 'Late rendering should preserve the same anchor.');
	// If another revision arrives before that restoration finishes, forward the
	// original snapshot rather than saving a half-rendered page's position.
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await navigateUpdate(file, updatedHtml);
	await assertPosition(initialTop, 'Rapid updates must carry the original reading position forward.');

	// Ordinary images can finish after the renderer's completion event.
	let releaseImage;
	await page.setRequestInterception(true);
	page.on('request', request => {
		if (request.resourceType() === 'image' && !request.url().startsWith('data:')) {
			releaseImage = () => request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="grey"/></svg>' });
		} else void request.continue();
	});
	const withImage = await html(document('![Delayed image](late.svg)'));
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(withImage);
	await navigation;
	for (let attempt = 0; !releaseImage && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(releaseImage, 'The delayed image request must reach the test interceptor.');
	assert.equal(await page.$eval('#preview-root img', image => image.complete), false);
	await releaseImage();
	await ready();
	await page.waitForFunction(() => document.querySelector('#preview-root img').complete);
	await assertPosition(initialTop, 'Images loading after canonical rendering must not move the reading anchor.');
	await navigateUpdate(file, baseHtml);
	await assertPosition(initialTop);
	await page.setRequestInterception(false);
	page.removeAllListeners('request');

	// User interaction cancels late restoration; do not snap back after scrolling.
	navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
	file.updateDocument(delayed);
	await navigation;
	await page.waitForFunction(() => typeof window.finishLayout === 'function');
	await page.evaluate(() => {
		window.dispatchEvent(new WheelEvent('wheel', { deltaY: 400 }));
		window.scrollBy(0, 400);
		window.finishLayout();
	});
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.ok(Math.abs(await top() - initialTop) > 100, 'Late rendering must not undo user scrolling.');

	// A whole-document replacement with no matching anchors falls back to ratio.
	await scrollToTarget();
	const ratio = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight));
	const replacement = await html(document('', 'Replacement').replaceAll('Paragraph', 'Changed text'));
	await navigateUpdate(file, replacement);
	const newRatio = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight));
	assert.ok(Math.abs(ratio - newRatio) < 0.002, 'Missing anchors should fall back to relative scroll position.');

	const otherFile = await serverFor(baseHtml, { preserveReadingPosition: true, sourceLabel: 'document.md' });
	await page.goto(otherFile.url, { waitUntil: 'domcontentloaded' });
	await ready();
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'An independent watcher must not inherit another document position.');
	await navigateUpdate(otherFile, updatedHtml);
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'A reader at the beginning should stay at the beginning when material is inserted.');
	await scrollToTarget();
	const responses = await serverFor(baseHtml, { sourceLabel: 'Assistant responses' });
	await page.goto(responses.url, { waitUntil: 'domcontentloaded' });
	await ready();
	await scrollToTarget();
	await navigateUpdate(responses, updatedHtml);
	assert.equal(await page.evaluate(() => window.scrollY), 0, 'A new assistant response still starts at the top.');
	assert.equal(await page.evaluate(() => typeof window.PiMarkdownPreviewReadingPosition), 'object', 'Response watchers can restore Back navigation within a revision without carrying position into a new response.');

	// Explicit fragments take priority over a stored position at another fragment.
	await page.goto(otherFile.url + '#section-10', { waitUntil: 'domcontentloaded' });
	await ready();
	await page.waitForFunction(() => Math.abs(document.querySelector('#section-10').getBoundingClientRect().top) < 2);
	await scrollToTarget();
	await navigateUpdate(otherFile, updatedHtml);
	await assertPosition(initialTop, 'An unchanged carried hash must not pin every refresh to an old heading.');

	const denied = await browser.newPage();
	await denied.evaluateOnNewDocument(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage denied'); } }); });
	denied.on('pageerror', error => errors.push(String(error)));
	await denied.goto(otherFile.url, { waitUntil: 'domcontentloaded' });
	await denied.waitForFunction(() => window.__mermaidDone === true);
	await denied.evaluate(() => window.scrollTo(0, 1500));
	await Promise.all([denied.waitForNavigation({ waitUntil: 'domcontentloaded' }), Promise.resolve(otherFile.updateDocument(baseHtml))]);
	await denied.waitForFunction(() => window.__mermaidDone === true);
	assert.equal(await denied.evaluate(() => window.scrollY), 0, 'Storage denial degrades to normal navigation without crashing.');
	await denied.close();
	assert.deepEqual(errors, []);
	console.log('Document reading-position and safe sub/sup rendering checks passed.');
} finally {
	await browser?.close();
	await Promise.all(servers.map(server => server.close()));
	await preview?.closeSharedPreviewBrowser();
	await rm(modulePath, { force: true });
	await rm(scratch, { recursive: true, force: true });
}
