type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
	es: {
		"preview.overlay.title": "Vista previa de Markdown",
		"preview.overlay.pageControl": "←/→ página",
		"preview.overlay.close": "cerrar",
		"preview.overlay.refresh": "r actualizar",
		"preview.overlay.openBrowser": "o abrir navegador",
		"preview.overlay.openingBrowser": "Abriendo vista previa en el navegador...",
		"preview.overlay.openedBrowser": "Vista previa abierta en el navegador.",
		"preview.overlay.browserOpenFailed": "No se pudo abrir el navegador: {message}",
		"preview.overlay.refreshing": "Actualizando vista previa para el tema actual...",
		"preview.overlay.refreshed": "Actualizada (modo {mode}).",
		"preview.overlay.refreshFailed": "No se pudo actualizar: {message}",
	},
	fr: {
		"preview.overlay.title": "Aperçu Markdown",
		"preview.overlay.pageControl": "←/→ page",
		"preview.overlay.close": "fermer",
		"preview.overlay.refresh": "r actualiser",
		"preview.overlay.openBrowser": "o ouvrir le navigateur",
		"preview.overlay.openingBrowser": "Ouverture de l’aperçu dans le navigateur...",
		"preview.overlay.openedBrowser": "Aperçu ouvert dans le navigateur.",
		"preview.overlay.browserOpenFailed": "Échec de l’ouverture du navigateur : {message}",
		"preview.overlay.refreshing": "Actualisation de l’aperçu pour le thème actuel...",
		"preview.overlay.refreshed": "Actualisé (mode {mode}).",
		"preview.overlay.refreshFailed": "Échec de l’actualisation : {message}",
	},
	"pt-BR": {
		"preview.overlay.title": "Prévia de Markdown",
		"preview.overlay.pageControl": "←/→ página",
		"preview.overlay.close": "fechar",
		"preview.overlay.refresh": "r atualizar",
		"preview.overlay.openBrowser": "o abrir navegador",
		"preview.overlay.openingBrowser": "Abrindo prévia no navegador...",
		"preview.overlay.openedBrowser": "Prévia aberta no navegador.",
		"preview.overlay.browserOpenFailed": "Falha ao abrir o navegador: {message}",
		"preview.overlay.refreshing": "Atualizando prévia para o tema atual...",
		"preview.overlay.refreshed": "Atualizada (modo {mode}).",
		"preview.overlay.refreshFailed": "Falha ao atualizar: {message}",
	},
};

let currentLocale: Locale = "en";

export function initI18n(pi: { events?: { emit?: (event: string, payload: unknown) => void } }): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", {
		namespace: "pi-markdown-preview",
		defaultLocale: "en",
		locales: translations,
	});
	pi.events?.emit?.("pi-core/i18n/requestApi", {
		onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
			const locale = api.getLocale?.();
			if (isLocale(locale)) currentLocale = locale;
			api.onLocaleChange?.((next) => {
				if (isLocale(next)) currentLocale = next;
			});
		},
	});
}

export function t(key: string, fallback: string, params: Params = {}): string {
	const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
	return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
	return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
