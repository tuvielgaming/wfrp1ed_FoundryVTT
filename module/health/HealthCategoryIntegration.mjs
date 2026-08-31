import { CriticalWoundsWindow } from "../sheets/CriticalWoundsWindow.mjs";

const CRITICAL_WOUND_CATEGORY = "criticalWound";

/**
 * Activate the compact health-category launcher rendered by the Classic sheet.
 *
 * The sheet owns only category entry points. Each category owns its own window
 * and item lifecycle, allowing Critical Wounds and later health-state document
 * types to evolve independently.
 */
Hooks.on(
	"renderApplicationV2",
	(application, element) => {
		const launcher = element.querySelector(
			`[data-wfrp1ed-health-category="${CRITICAL_WOUND_CATEGORY}"]`,
		);

		if (!launcher) return;

		const actor = application.document;
		if (actor?.documentName !== "Actor") return;

		prepareCriticalWoundLauncher(launcher, actor);
	},
);

for (const hookName of ["createItem", "updateItem", "deleteItem"]) {
	Hooks.on(hookName, (item) => {
		const actor = item?.actor ?? item?.parent;

		if (
			actor?.documentName !== "Actor" ||
			item?.type !== CRITICAL_WOUND_CATEGORY
		) {
			return;
		}

		void CriticalWoundsWindow.refresh(actor).catch((error) => {
			console.error(
				"WFRP1ED | Unable to refresh Critical Wounds window.",
				error,
			);
		});
	});
}

function prepareCriticalWoundLauncher(button, actor) {
	const count = [...(actor.items ?? [])].filter(
		(item) => item.type === CRITICAL_WOUND_CATEGORY,
	).length;
	const countElement = button.querySelector(
		"[data-health-category-count]",
	);
	const labelElement = button.querySelector(
		"[data-health-category-label]",
	);

	if (labelElement) {
		labelElement.classList.add("classic-health-category__label--two-lines");
		labelElement.replaceChildren();
		const lines = game.i18n.lang === "pl"
			? ["Rany", "krytyczne"]
			: ["Critical", "Wounds"];
		for (const lineText of lines) {
			const line = document.createElement("span");
			line.textContent = lineText;
			labelElement.append(line);
		}
	}

	if (countElement) {
		countElement.textContent = String(count);
		countElement.hidden = count === 0;
	}

	button.title = localize(
		"Open this character's Critical Wounds",
		"Otwórz rany krytyczne tej postaci",
	);
	button.setAttribute("aria-label", button.title);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		void CriticalWoundsWindow.open(actor).catch((error) => {
			console.error(
				"WFRP1ED | Unable to open Critical Wounds window.",
				error,
			);
			ui.notifications.error(
				localize(
					"Unable to open Critical Wounds.",
					"Nie udało się otworzyć ran krytycznych.",
				),
			);
		});
	});
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
