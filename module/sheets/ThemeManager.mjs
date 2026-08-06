/**
 * Resolves visual assets for character-sheet themes and localizations.
 *
 * ThemeManager owns visual asset selection and verified source-image metadata.
 * Overlay coordinates and section geometry belong to LayoutManager.
 */

const CLASSIC_POLISH_PAGES = Object.freeze([
	Object.freeze({
		number: 1,
		path: "systems/wfrp1ed/assets/sheets/classic/pl/page1.jpg",
		nativeWidth: 2798,
		nativeHeight: 3826,
	}),
	Object.freeze({
		number: 2,
		path: "systems/wfrp1ed/assets/sheets/classic/pl/page2.jpg",
		nativeWidth: 2799,
		nativeHeight: 3827,
	}),
]);

const THEME_DEFINITIONS = Object.freeze({
	classic: Object.freeze({
		id: "classic",
		defaultLanguage: "pl",

		languages: Object.freeze({
			pl: Object.freeze({
				pages: CLASSIC_POLISH_PAGES,
				logo: null,
			}),
		}),
	}),
});

export class ThemeManager {
	/**
	 * Return all currently implemented theme identifiers.
	 *
	 * @returns {string[]}
	 */
	static get supportedThemes() {
		return Object.keys(THEME_DEFINITIONS);
	}

	/**
	 * Return languages for which the selected theme has verified assets.
	 *
	 * @param {string} themeId
	 * @returns {string[]}
	 */
	static supportedLanguages(themeId = "classic") {
		const definition = this._getDefinition(themeId);

		return Object.keys(definition.languages);
	}

	/**
	 * Resolve a complete immutable theme descriptor.
	 *
	 * When Foundry uses a language without localized artwork, the theme's
	 * explicit fallback language is selected.
	 *
	 * @param {string} themeId
	 * @param {Object} options
	 * @param {string} [options.language]
	 * @returns {Object}
	 */
	static getTheme(themeId = "classic", options = {}) {
		const definition = this._getDefinition(themeId);
		const requestedLanguage = this._normalizeLanguage(
			options.language ?? globalThis.game?.i18n?.lang,
		);

		const language = Object.hasOwn(
			definition.languages,
			requestedLanguage,
		)
			? requestedLanguage
			: definition.defaultLanguage;

		const localizedTheme = definition.languages[language];

		if (!localizedTheme) {
			throw new Error(
				`Theme '${themeId}' has no assets for its configured ` +
					`default language '${definition.defaultLanguage}'.`,
			);
		}

		return Object.freeze({
			id: definition.id,
			requestedLanguage,
			language,
			usesLanguageFallback: language !== requestedLanguage,
			pages: localizedTheme.pages,
			logo: localizedTheme.logo,
		});
	}

	/**
	 * Return one page descriptor from a resolved theme.
	 *
	 * @param {string} themeId
	 * @param {number} pageNumber
	 * @param {Object} options
	 * @returns {Object}
	 */
	static page(themeId = "classic", pageNumber = 1, options = {}) {
		const theme = this.getTheme(themeId, options);
		const numericPage = Number(pageNumber);

		if (!Number.isInteger(numericPage) || numericPage < 1) {
			throw new Error(
				`Theme page number must be a positive integer: ` +
					String(pageNumber),
			);
		}

		const page = theme.pages.find(
			(candidate) => candidate.number === numericPage,
		);

		if (!page) {
			throw new Error(
				`Theme '${theme.id}' language '${theme.language}' does not ` +
					`define page ${numericPage}.`,
			);
		}

		return page;
	}

	/**
	 * Return the background path for one theme page.
	 *
	 * @param {string} themeId
	 * @param {number} pageNumber
	 * @param {Object} options
	 * @returns {string}
	 */
	static background(themeId = "classic", pageNumber = 1, options = {}) {
		return this.page(themeId, pageNumber, options).path;
	}

	/**
	 * Return the optional localized logo path.
	 *
	 * @param {string} themeId
	 * @param {Object} options
	 * @returns {string|null}
	 */
	static logo(themeId = "classic", options = {}) {
		return this.getTheme(themeId, options).logo;
	}

	/**
	 * Return a verified theme definition.
	 *
	 * @param {string} themeId
	 * @returns {Object}
	 * @protected
	 */
	static _getDefinition(themeId) {
		const normalizedId = String(themeId ?? "")
			.trim()
			.toLowerCase();

		const definition = THEME_DEFINITIONS[normalizedId];

		if (!definition) {
			throw new Error(
				`Unknown WFRP1ED sheet theme '${String(themeId)}'. ` +
					`Available themes: ${this.supportedThemes.join(", ")}.`,
			);
		}

		return definition;
	}

	/**
	 * Normalize identifiers such as `pl-PL` to `pl`.
	 *
	 * @param {*} language
	 * @returns {string}
	 * @protected
	 */
	static _normalizeLanguage(language) {
		const normalized = String(language ?? "")
			.trim()
			.toLowerCase()
			.split("-")[0];

		return normalized || "en";
	}
}