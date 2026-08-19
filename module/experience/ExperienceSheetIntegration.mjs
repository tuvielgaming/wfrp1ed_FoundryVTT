import "../advancement/CharacteristicAdvanceSheetScope.mjs";

const SHEET_SELECTOR = ".wfrp1ed-classic-sheet";
const PAGE_SELECTOR = '.classic-sheet-page[data-page="2"]';

const EXPERIENCE_GEOMETRY = Object.freeze({
	left: 738,
	top: 311,
	width: 248,
	height: 786,
});

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!(element instanceof HTMLElement) ||
		!element.querySelector?.(SHEET_SELECTOR)
	) return;

	const panel = ensureExperiencePanel(actor, element);
	if (!panel) return;

	wireExperienceField(actor, panel, "current");
	wireExperienceField(actor, panel, "total");
});

function ensureExperiencePanel(actor, root) {
	const page = root.querySelector(PAGE_SELECTOR);
	if (!(page instanceof HTMLElement)) return null;

	let panel = page.querySelector('[data-section="experience"][data-wfrp-experience-panel]');
	if (!(panel instanceof HTMLElement)) {
		panel = document.createElement("section");
		panel.className = "sheet-overlay sheet-overlay--experience wfrp1ed-experience-panel";
		panel.dataset.section = "experience";
		panel.dataset.wfrpExperiencePanel = "true";
		Object.assign(panel.style, {
			position: "absolute",
			left: `${EXPERIENCE_GEOMETRY.left}px`,
			top: `${EXPERIENCE_GEOMETRY.top}px`,
			width: `${EXPERIENCE_GEOMETRY.width}px`,
			height: `${EXPERIENCE_GEOMETRY.height}px`,
		});
		page.append(panel);
	}

	const ledger = readLedger(actor);
	panel.replaceChildren(
		buildExperienceField("current", localize("Current", "Aktualne"), ledger.available),
		buildExperienceField("total", localize("Total", "Całkowite"), ledger.totalAwarded),
	);
	return panel;
}

function buildExperienceField(kind, labelText, value) {
	const label = document.createElement("label");
	label.className = `wfrp1ed-experience-field wfrp1ed-experience-field--${kind}`;

	const caption = document.createElement("span");
	caption.className = "wfrp1ed-experience-field__label";
	caption.textContent = labelText;

	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(value);
	input.dataset[`wfrpExperience${kind[0].toUpperCase()}${kind.slice(1)}`] = "true";
	input.setAttribute(
		"aria-label",
		kind === "current"
			? localize("Current Experience Points", "Aktualne Punkty Doświadczenia")
			: localize("Total Experience Points", "Całkowite Punkty Doświadczenia"),
	);

	label.append(caption, input);
	return label;
}

function wireExperienceField(actor, root, kind) {
	const input = root.querySelector(`[data-wfrp-experience-${kind}]`);
	if (!(input instanceof HTMLInputElement)) return;

	/* Experience corrections are deliberately GM-only. Players can still see
	 * both values, while normal purchases continue through the Actor API. */
	input.disabled = game.user?.isGM !== true;
	if (input.disabled) return;

	input.addEventListener("change", () => {
		void persistExperience(actor, kind, input);
	});

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
}

async function persistExperience(actor, kind, input) {
	const next = nonNegativeInteger(input.value);
	const ledger = readLedger(actor);

	try {
		if (kind === "current") {
			if (next > ledger.totalAwarded) {
				throw new Error(localize(
					"Current Experience cannot exceed Total Experience.",
					"Aktualne Punkty Doświadczenia nie mogą przekraczać Całkowitych Punktów Doświadczenia.",
				));
			}

			await actor.update({
				"system.experience.spent": ledger.totalAwarded - next,
			});
			return;
		}

		if (kind === "total") {
			if (next < ledger.spent) {
				throw new Error(localize(
					`Total Experience cannot be lower than already spent Experience (${ledger.spent}).`,
					`Całkowite Punkty Doświadczenia nie mogą być niższe od już wydanych (${ledger.spent}).`,
				));
			}

			await actor.update({
				"system.experience.totalAwarded": next,
			});
		}
	} catch (error) {
		input.value = kind === "current"
			? String(ledger.available)
			: String(ledger.totalAwarded);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Experience Points.",
			"Nie udało się zaktualizować Punktów Doświadczenia.",
		));
	}
}

function readLedger(actor) {
	const experience = actor.system?.experience ?? {};
	const totalAwarded = nonNegativeInteger(experience.totalAwarded);
	const spent = nonNegativeInteger(experience.spent);
	return {
		totalAwarded,
		spent,
		available: Math.max(0, totalAwarded - spent),
	};
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
