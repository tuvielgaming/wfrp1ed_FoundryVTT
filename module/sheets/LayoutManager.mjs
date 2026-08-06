import { ThemeManager } from "./ThemeManager.mjs";
import { ClassicLayout } from "./classic/ClassicLayout.mjs";

const LAYOUT_DEFINITIONS = Object.freeze({
	classic: ClassicLayout,
});

export class LayoutManager {
	/**
	 * Return all implemented layout identifiers.
	 *
	 * @returns {string[]}
	 */
	static get supportedLayouts() {
		return Object.keys(LAYOUT_DEFINITIONS);
	}

	/**
	 * Resolve localization-specific geometry and verify that it matches the
	 * visual assets selected by ThemeManager.
	 *
	 * A layout is never silently borrowed from a different localized scan.
	 * When artwork exists for a language but matching geometry does not, this
	 * method throws instead of rendering overlays at incorrect coordinates.
	 *
	 * @param {string} layoutId
	 * @param {Object} options
	 * @param {string} [options.language]
	 * @param {Object} [options.theme]
	 * @returns {Object}
	 */
	static getLayout(layoutId = "classic", options = {}) {
		const definition = this._getDefinition(layoutId);

		const theme =
			options.theme ??
			ThemeManager.getTheme(layoutId, {
				language: options.language,
			});

		this._assertMatchingTheme(definition, theme);

		const localizedLayout =
			definition.languages?.[theme.language];

		if (!localizedLayout) {
			throw new Error(
				`Layout '${definition.id}' has no geometry for the ` +
					`resolved theme language '${theme.language}'.`,
			);
		}

		this._validateLocalizedLayout(
			definition,
			localizedLayout,
			theme,
		);

		const pages = Object.values(localizedLayout.pages).sort(
			(first, second) => first.number - second.number,
		);

		return Object.freeze({
			id: definition.id,
			coordinateSpace: definition.coordinateSpace,
			logicalPage: definition.logicalPage,

			requestedLanguage: theme.requestedLanguage,
			language: theme.language,
			usesLanguageFallback: theme.usesLanguageFallback,

			pages: Object.freeze(pages),
		});
	}

	/**
	 * Return one resolved page geometry descriptor.
	 *
	 * @param {string} layoutId
	 * @param {number} pageNumber
	 * @param {Object} options
	 * @returns {Object}
	 */
	static page(
		layoutId = "classic",
		pageNumber = 1,
		options = {},
	) {
		const layout = this.getLayout(layoutId, options);

		const numericPage = this._positiveInteger(
			pageNumber,
			"Layout page number",
		);

		const page = layout.pages.find(
			(candidate) => candidate.number === numericPage,
		);

		if (!page) {
			throw new Error(
				`Layout '${layout.id}' language '${layout.language}' ` +
					`does not define page ${numericPage}.`,
			);
		}

		return page;
	}

	/**
	 * Return one named section from a resolved layout page.
	 *
	 * @param {string} layoutId
	 * @param {number} pageNumber
	 * @param {string} sectionId
	 * @param {Object} options
	 * @returns {Object}
	 */
	static section(
		layoutId = "classic",
		pageNumber = 1,
		sectionId,
		options = {},
	) {
		const page = this.page(
			layoutId,
			pageNumber,
			options,
		);

		const normalizedSectionId = String(
			sectionId ?? "",
		).trim();

		if (!normalizedSectionId) {
			throw new Error(
				"Layout section id must not be empty.",
			);
		}

		const section =
			page.sections?.[normalizedSectionId];

		if (!section) {
			throw new Error(
				`Layout '${layoutId}' page ${page.number} has no ` +
					`section '${normalizedSectionId}'.`,
			);
		}

		return section;
	}

	/**
	 * Return a registered layout definition.
	 *
	 * @param {string} layoutId
	 * @returns {Object}
	 * @protected
	 */
	static _getDefinition(layoutId) {
		const normalizedId = String(layoutId ?? "")
			.trim()
			.toLowerCase();

		const definition =
			LAYOUT_DEFINITIONS[normalizedId];

		if (!definition) {
			throw new Error(
				`Unknown WFRP1ED sheet layout ` +
					`'${String(layoutId)}'. Available layouts: ` +
					`${this.supportedLayouts.join(", ")}.`,
			);
		}

		return definition;
	}

	/**
	 * Ensure that a layout and theme describe the same sheet family.
	 *
	 * @param {Object} definition
	 * @param {Object} theme
	 * @protected
	 */
	static _assertMatchingTheme(definition, theme) {
		if (!theme || typeof theme !== "object") {
			throw new Error(
				`Layout '${definition.id}' requires a resolved ` +
					`theme descriptor.`,
			);
		}

		if (theme.id !== definition.id) {
			throw new Error(
				`Layout '${definition.id}' cannot be combined with ` +
					`theme '${String(theme.id)}'.`,
			);
		}
	}

	/**
	 * Validate a localized layout against ThemeManager metadata.
	 *
	 * @param {Object} definition
	 * @param {Object} localizedLayout
	 * @param {Object} theme
	 * @protected
	 */
	static _validateLocalizedLayout(
		definition,
		localizedLayout,
		theme,
	) {
		if (localizedLayout.language !== theme.language) {
			throw new Error(
				`Layout '${definition.id}' language ` +
					`'${localizedLayout.language}' does not match ` +
					`theme language '${theme.language}'.`,
			);
		}

		const layoutPages = Object.values(
			localizedLayout.pages ?? {},
		);

		const themePages = Array.isArray(theme.pages)
			? theme.pages
			: [];

		if (layoutPages.length !== themePages.length) {
			throw new Error(
				`Layout '${definition.id}' language ` +
					`'${theme.language}' defines ` +
					`${layoutPages.length} pages, but its theme ` +
					`defines ${themePages.length}.`,
			);
		}

		for (const layoutPage of layoutPages) {
			this._validatePage(
				definition,
				layoutPage,
				themePages,
			);
		}
	}

	/**
	 * Validate one page against the corresponding theme asset.
	 *
	 * @param {Object} definition
	 * @param {Object} layoutPage
	 * @param {Object[]} themePages
	 * @protected
	 */
	static _validatePage(
		definition,
		layoutPage,
		themePages,
	) {
		const pageNumber = this._positiveInteger(
			layoutPage.number,
			"Layout page number",
		);

		const themePage = themePages.find(
			(candidate) =>
				candidate.number === pageNumber,
		);

		if (!themePage) {
			throw new Error(
				`Theme '${definition.id}' has no page ` +
					`${pageNumber} required by the layout.`,
			);
		}

		this._positiveInteger(
			layoutPage.source?.width,
			"Source width",
		);

		this._positiveInteger(
			layoutPage.source?.height,
			"Source height",
		);

		this._positiveInteger(
			layoutPage.canvas?.width,
			"Canvas width",
		);

		this._positiveInteger(
			layoutPage.canvas?.height,
			"Canvas height",
		);

		if (
			layoutPage.source.width !==
				themePage.nativeWidth ||
			layoutPage.source.height !==
				themePage.nativeHeight
		) {
			throw new Error(
				`Layout '${definition.id}' page ${pageNumber} ` +
					`expects source ${layoutPage.source.width} × ` +
					`${layoutPage.source.height}, but ThemeManager ` +
					`selected ${themePage.nativeWidth} × ` +
					`${themePage.nativeHeight}.`,
			);
		}

		if (
			layoutPage.canvas.width !==
				definition.logicalPage.width ||
			layoutPage.canvas.height !==
				definition.logicalPage.height
		) {
			throw new Error(
				`Layout '${definition.id}' page ${pageNumber} ` +
					`does not use the declared logical canvas ` +
					`${definition.logicalPage.width} × ` +
					`${definition.logicalPage.height}.`,
			);
		}

		if (
			!layoutPage.sections ||
			typeof layoutPage.sections !== "object"
		) {
			throw new Error(
				`Layout '${definition.id}' page ${pageNumber} ` +
					`has no section geometry.`,
			);
		}

		for (
			const [sectionId, section]
			of Object.entries(layoutPage.sections)
		) {
			this._validateSection(
				definition,
				pageNumber,
				sectionId,
				section,
				layoutPage.canvas,
			);
		}
	}

	/**
	 * Validate one rectangular section in logical page coordinates.
	 *
	 * @param {Object} definition
	 * @param {number} pageNumber
	 * @param {string} sectionId
	 * @param {Object} section
	 * @param {Object} canvas
	 * @protected
	 */
	static _validateSection(
		definition,
		pageNumber,
		sectionId,
		section,
		canvas,
	) {
		const x = this._nonNegativeNumber(
			section?.x,
			`${sectionId}.x`,
		);

		const y = this._nonNegativeNumber(
			section?.y,
			`${sectionId}.y`,
		);

		const width = this._positiveNumber(
			section?.width,
			`${sectionId}.width`,
		);

		const height = this._positiveNumber(
			section?.height,
			`${sectionId}.height`,
		);

		if (
			x + width > canvas.width ||
			y + height > canvas.height
		) {
			throw new Error(
				`Layout '${definition.id}' page ${pageNumber} ` +
					`section '${sectionId}' exceeds the ` +
					`logical canvas.`,
			);
		}
	}

	/**
	 * Convert and validate a positive integer.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	static _positiveInteger(value, label) {
		const number = Number(value);

		if (!Number.isInteger(number) || number < 1) {
			throw new Error(
				`${label} must be a positive integer: ` +
					String(value),
			);
		}

		return number;
	}

	/**
	 * Convert and validate a positive finite number.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	static _positiveNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number) || number <= 0) {
			throw new Error(
				`${label} must be a positive finite number: ` +
					String(value),
			);
		}

		return number;
	}

	/**
	 * Convert and validate a non-negative finite number.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	static _nonNegativeNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number) || number < 0) {
			throw new Error(
				`${label} must be a non-negative finite number: ` +
					String(value),
			);
		}

		return number;
	}
}