import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
	return translate(key, fallback, params);
}

const bundles = [
	{
		locale: "ja",
		namespace: "pi-markdown-preview",
		messages: {
			"cmd.preview": "レンダリング済み Markdown プレビュー (--pick で応答選択、--file <path> またはパス、--browser で HTML、--pdf で PDF、--terminal でインライン強制、--font-size <px>)",
			"cmd.browser": "レンダリング済み Markdown + LaTeX プレビューを既定ブラウザーで開く (MathML + 必要時のみ MathJax)",
			"cmd.pdf": "pandoc + LaTeX で Markdown を PDF に出力して開く",
			"cmd.clearCache": "レンダリング済みプレビューキャッシュをクリア (~/.pi/cache/markdown-preview)",
			"notify.noAssistantMarkdown": "現在のブランチに assistant の Markdown がありません。",
			"notify.noAssistantMessages": "現在のブランチに assistant メッセージがありません。",
			"notify.previewFailed": "プレビューに失敗しました: {message}",
			"notify.previewCancelled": "プレビューをキャンセルしました。",
			"notify.openedBrowser": "ブラウザープレビューを開きました。",
			"notify.browserFailed": "ブラウザープレビューに失敗しました: {message}",
			"notify.openedPdf": "PDF プレビューを開きました。",
			"notify.pdfFailed": "PDF 出力に失敗しました: {message}",
			"notify.cacheCleared": "プレビューキャッシュをクリアしました: {path}",
			"notify.cacheClearFailed": "プレビューキャッシュのクリアに失敗しました: {message}",
			"picker.title": "プレビューする応答を選択",
			"picker.controls": "↑↓ 移動 • enter 選択 • esc キャンセル",
			"overlay.opening": "ブラウザープレビューを開いています...",
			"overlay.opened": "ブラウザーでプレビューを開きました。",
			"overlay.openFailed": "ブラウザーで開けませんでした: {message}",
			"overlay.refreshing": "現在のテーマでプレビューを更新しています...",
			"overlay.refreshed": "更新しました ({mode} mode)。",
			"overlay.refreshFailed": "更新に失敗しました: {message}",
			"loader.rendering": "Markdown + LaTeX プレビューをレンダリング中...",
		},
	},
	{
		locale: "zh-CN",
		namespace: "pi-markdown-preview",
		messages: {
			"cmd.preview": "渲染 Markdown 预览（--pick 选择回复，--file <path> 或直接路径，--browser 输出 HTML，--pdf 输出 PDF，--terminal 强制内联，--font-size <px>）",
			"cmd.browser": "在默认浏览器中打开渲染后的 Markdown + LaTeX 预览（MathML + 必要时 MathJax）",
			"cmd.pdf": "通过 pandoc + LaTeX 将 Markdown 导出为 PDF 并打开",
			"cmd.clearCache": "清除渲染预览缓存（~/.pi/cache/markdown-preview）",
			"notify.noAssistantMarkdown": "当前分支中没有 assistant Markdown。",
			"notify.noAssistantMessages": "当前分支中没有 assistant 消息。",
			"notify.previewFailed": "预览失败: {message}",
			"notify.previewCancelled": "已取消预览。",
			"notify.openedBrowser": "已在浏览器中打开预览。",
			"notify.browserFailed": "浏览器预览失败: {message}",
			"notify.openedPdf": "已打开 PDF 预览。",
			"notify.pdfFailed": "PDF 导出失败: {message}",
			"notify.cacheCleared": "已清除预览缓存: {path}",
			"notify.cacheClearFailed": "清除预览缓存失败: {message}",
			"picker.title": "选择要预览的回复",
			"picker.controls": "↑↓ 导航 • enter 选择 • esc 取消",
			"overlay.opening": "正在打开浏览器预览...",
			"overlay.opened": "已在浏览器中打开预览。",
			"overlay.openFailed": "浏览器打开失败: {message}",
			"overlay.refreshing": "正在按当前主题刷新预览...",
			"overlay.refreshed": "已刷新（{mode} mode）。",
			"overlay.refreshFailed": "刷新失败: {message}",
			"loader.rendering": "正在渲染 Markdown + LaTeX 预览...",
		},
	},
	{
		locale: "es",
		namespace: "pi-markdown-preview",
		messages: {
			"cmd.preview": "Vista previa renderizada de Markdown (--pick selecciona respuesta, --file <path> o ruta directa, --browser para HTML, --pdf para PDF, --terminal fuerza inline, --font-size <px>)",
			"cmd.browser": "Abrir vista previa renderizada de Markdown + LaTeX en el navegador predeterminado (MathML + fallback selectivo de MathJax)",
			"cmd.pdf": "Exportar Markdown a PDF con pandoc + LaTeX y abrirlo",
			"cmd.clearCache": "Borrar caché de vistas previas renderizadas (~/.pi/cache/markdown-preview)",
			"notify.noAssistantMarkdown": "No se encontró Markdown del assistant en la rama actual.",
			"notify.noAssistantMessages": "No se encontraron mensajes del assistant en la rama actual.",
			"notify.previewFailed": "La vista previa falló: {message}",
			"notify.previewCancelled": "Vista previa cancelada.",
			"notify.openedBrowser": "Vista previa abierta en el navegador.",
			"notify.browserFailed": "La vista previa en navegador falló: {message}",
			"notify.openedPdf": "Vista previa PDF abierta.",
			"notify.pdfFailed": "La exportación PDF falló: {message}",
			"notify.cacheCleared": "Caché de vista previa borrada: {path}",
			"notify.cacheClearFailed": "No se pudo borrar la caché de vista previa: {message}",
			"picker.title": "Seleccionar respuesta para previsualizar",
			"picker.controls": "↑↓ navegar • enter seleccionar • esc cancelar",
			"overlay.opening": "Abriendo vista previa en navegador...",
			"overlay.opened": "Vista previa abierta en el navegador.",
			"overlay.openFailed": "No se pudo abrir el navegador: {message}",
			"overlay.refreshing": "Actualizando vista previa para el tema actual...",
			"overlay.refreshed": "Actualizado (modo {mode}).",
			"overlay.refreshFailed": "La actualización falló: {message}",
			"loader.rendering": "Renderizando vista previa Markdown + LaTeX...",
		},
	},
];

export function initI18n(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
	events.emit("pi-core/i18n/requestApi", {
		namespace: "pi-markdown-preview",
		callback(api: { t?: Translate } | undefined) {
			if (typeof api?.t === "function") translate = api.t;
		},
	});
}
