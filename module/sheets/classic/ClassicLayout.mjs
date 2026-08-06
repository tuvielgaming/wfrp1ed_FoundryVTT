/**
 * Classic WFRP 1e character-sheet geometry.
 *
 * ThemeManager owns background assets and native image metadata.
 * ClassicLayout owns normalized page and section geometry.
 *
 * All coordinates in this file use a logical 1000 × 1367 canvas. The browser
 * may render a page at any visual width, provided the background and overlays
 * are scaled together from this coordinate space.
 *
 * Each localization may provide its own section geometry because scans can
 * differ through cropping, translation, and small layout shifts.
 */

const LOGICAL_PAGE = Object.freeze({
	width: 1000,
	height: 1367,
});

const POLISH_CLASSIC_LAYOUT = {
	language: "pl",

	pages: {
		1: {
			number: 1,

			source: {
				width: 2798,
				height: 3826,
			},

			canvas: LOGICAL_PAGE,

			sections: {
				header: {
					x: 28,
					y: 0,
					width: 944,
					height: 242,
				},

				characteristics: {
					x: 0,
					y: 242,
					width: 1000,
					height: 226,
				},

				melee: {
					x: 34,
					y: 468,
					width: 462,
					height: 253,
				},

				ranged: {
					x: 28,
					y: 720,
					width: 468,
					height: 302,
				},

				armour: {
					x: 28,
					y: 1017,
					width: 468,
					height: 270,
				},

				skillsPrimary: {
					x: 500,
					y: 468,
					width: 239,
					height: 413,
				},

				armourPoints: {
					x: 500,
					y: 881,
					width: 239,
					height: 406,
				},

				skillsSecondary: {
					x: 741,
					y: 468,
					width: 230,
					height: 819,
				},

				footer: {
					x: 108,
					y: 1287,
					width: 786,
					height: 80,
				},
			},
		},

		2: {
			number: 2,

			source: {
				width: 2799,
				height: 3827,
			},

			canvas: LOGICAL_PAGE,

			sections: {
				spells: {
					x: 30,
					y: 4,
					width: 704,
					height: 307,
				},

				fate: {
					x: 737,
					y: 5,
					width: 229,
					height: 105,
				},

				magicPoints: {
					x: 737,
					y: 112,
					width: 229,
					height: 99,
				},

				powerLevel: {
					x: 737,
					y: 215,
					width: 229,
					height: 94,
				},

				equipment: {
					x: 14,
					y: 311,
					width: 320,
					height: 480,
				},

				movement: {
					x: 337,
					y: 311,
					width: 398,
					height: 258,
				},

				languages: {
					x: 337,
					y: 570,
					width: 126,
					height: 201,
				},

				psychology: {
					x: 465,
					y: 570,
					width: 146,
					height: 201,
				},

				insanity: {
					x: 613,
					y: 570,
					width: 122,
					height: 201,
				},

				experience: {
					x: 738,
					y: 311,
					width: 248,
					height: 786,
				},

				wealth: {
					x: 14,
					y: 797,
					width: 320,
					height: 273,
				},

				history: {
					x: 337,
					y: 773,
					width: 398,
					height: 238,
				},

				socialLevel: {
					x: 337,
					y: 1013,
					width: 238,
					height: 85,
				},

				religion: {
					x: 577,
					y: 1013,
					width: 158,
					height: 85,
				},

				companions: {
					x: 31,
					y: 1101,
					width: 938,
					height: 194,
				},

				footer: {
					x: 112,
					y: 1295,
					width: 778,
					height: 72,
				},
			},
		},
	},
};

export const ClassicLayout = deepFreeze({
	id: "classic",

	coordinateSpace: "normalized-page",

	logicalPage: LOGICAL_PAGE,

	defaultLanguage: "pl",

	languages: {
		pl: POLISH_CLASSIC_LAYOUT,
	},
});

/**
 * Recursively freeze layout configuration so an open sheet cannot mutate the
 * shared source geometry.
 *
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.isFrozen(value)
	) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}