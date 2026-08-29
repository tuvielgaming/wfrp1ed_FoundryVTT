import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const CAREER_CLASSES = Object.freeze([
	Object.freeze({ id: "warrior", pl: "Wojownik", en: "Warrior" }),
	Object.freeze({ id: "ranger", pl: "Wędrowiec", en: "Ranger" }),
	Object.freeze({ id: "rogue", pl: "Łotr", en: "Rogue" }),
	Object.freeze({ id: "academic", pl: "Uczony", en: "Academic" }),
]);

/**
 * WFRP 1e Core Career Class eligibility belongs to character creation rules,
 * not to individual Race Items.
 *
 * Core requirements:
 * - Warrior: WS >= 30
 * - Ranger: BS >= 30
 * - Rogue: I >= 30
 * - Academic: Int >= 30 and WP >= 30
 * - Wood Elf exception: Rogue requires I >= 65
 *
 * This module is intentionally data/rule focused so a future dedicated rules
 * editor can replace the built-in definitions without changing Race Items.
 */
export class CareerClassEligibility {
	static classes() {
		return CAREER_CLASSES;
	}

	static evaluate(actor, classId) {
		const id = String(classId ?? "").trim();
		const requirements = requirementsFor(actor, id);
		if (!requirements.length) {
			return { eligible: false, requirements: [], reason: localize("Unknown Career Class.", "Nieznana Klasa Profesji.") };
		}

		const failed = requirements.filter((requirement) =>
			characteristicValue(actor, requirement.characteristic) < requirement.minimum,
		);
		return {
			eligible: failed.length === 0,
			requirements,
			failed,
			reason: requirementText(requirements),
		};
	}

	static options(actor) {
		return CAREER_CLASSES.map((entry) => {
			const evaluation = this.evaluate(actor, entry.id);
			return {
				...entry,
				label: game.i18n.lang === "pl" ? entry.pl : entry.en,
				...evaluation,
			};
		});
	}
}

installCharacterCreationClassSelector();

function installCharacterCreationClassSelector() {
	Hooks.on("renderApplicationV2", (application, element) => {
		if (!(application instanceof ClassicActorSheet)) return;
		const actor = application.document;
		if (actor?.type !== "character") return;
		if (!(element instanceof HTMLElement)) return;
		if (!CharacterCreationMode.enabled(actor)) return;
		syncSelector(actor, element);
	});

	Hooks.on("updateActor", (actor, changes) => {
		if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
		if (!characteristicsChanged(changes)) return;
		const root = asElement(actor.sheet?.element);
		if (!(root instanceof HTMLElement)) return;
		syncSelector(actor, root);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const root = asElement(actor.sheet?.element);
			if (!(root instanceof HTMLElement)) return;
			syncSelector(actor, root);
		});
	}
}

function syncSelector(actor, root) {
	const existing = root.querySelector('.header-field--career-class select.wfrp1ed-career-class-selector');
	if (existing instanceof HTMLSelectElement) {
		populateSelector(actor, existing);
		return;
	}

	const input = root.querySelector('.header-field--career-class input[name="system.details.careerClass"]');
	if (!(input instanceof HTMLInputElement)) return;
	const select = document.createElement("select");
	select.name = "system.details.careerClass";
	select.className = "wfrp1ed-career-class-selector";
	select.setAttribute("aria-label", input.getAttribute("aria-label") ?? localize("Career Class", "Klasa Zawodowa"));
	select.addEventListener("change", () => {
		void actor.update({ "system.details.careerClass": select.value }).catch((error) => {
			console.error("WFRP1ED | Unable to set Career Class.", error);
			ui.notifications.error(error?.message ?? String(error));
		});
	});
	input.replaceWith(select);
	populateSelector(actor, select);
}

function populateSelector(actor, select) {
	const current = canonicalClassId(actor.system?.details?.careerClass);
	select.replaceChildren();

	const placeholder = document.createElement("option");
	placeholder.value = "";
	placeholder.textContent = localize("Select Class", "Wybierz Klasę");
	placeholder.selected = !current;
	select.append(placeholder);

	for (const option of CareerClassEligibility.options(actor)) {
		const element = document.createElement("option");
		element.value = option.id;
		element.textContent = option.eligible
			? option.label
			: `${option.label} — ${option.reason}`;
		element.disabled = !option.eligible;
		element.selected = current === option.id;
		element.title = option.reason;
		element.dataset.tooltip = option.reason;
		select.append(element);
	}

	select.title = localize(
		"Career Classes which do not meet the current Characteristic requirements are disabled. Disabled entries include their requirement in the list.",
		"Klasy Profesji, których aktualne Cechy nie spełniają wymagań, są wyłączone. Wyłączone pozycje pokazują wymaganie bezpośrednio na liście.",
	);
}

function requirementsFor(actor, classId) {
	switch (classId) {
		case "warrior":
			return [{ characteristic: "ws", minimum: 30 }];
		case "ranger":
			return [{ characteristic: "bs", minimum: 30 }];
		case "rogue":
			return [{ characteristic: "i", minimum: isWoodElf(actor) ? 65 : 30 }];
		case "academic":
			return [
				{ characteristic: "int", minimum: 30 },
				{ characteristic: "wp", minimum: 30 },
			];
		default:
			return [];
	}
}

function characteristicValue(actor, id) {
	const characteristic = actor?.system?.characteristics?.[id];
	const value = Number(characteristic?.current ?? characteristic?.initial ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function isWoodElf(actor) {
	const race = game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ??
		actor?.items?.find?.((item) => item.type === "race") ?? null;
	const rulesId = normalize(race?.system?.rulesId);
	return ["wood-elf", "woodelf"].includes(rulesId);
}

function requirementText(requirements) {
	return requirements.map((requirement) =>
		`${characteristicLabel(requirement.characteristic)} ≥ ${requirement.minimum}`,
	).join(localize(" and ", " i "));
}

function characteristicLabel(id) {
	const labels = {
		ws: ["WW", "WS"],
		bs: ["US", "BS"],
		i: ["I", "I"],
		int: ["Int", "Int"],
		wp: ["SW", "WP"],
	};
	const pair = labels[id] ?? [id, id];
	return game.i18n.lang === "pl" ? pair[0] : pair[1];
}

function canonicalClassId(value) {
	const normalized = normalize(value);
	const aliases = {
		warrior: "warrior",
		wojownik: "warrior",
		ranger: "ranger",
		"wędrowiec": "ranger",
		wedrowiec: "ranger",
		rogue: "rogue",
		"łotr": "rogue",
		lotr: "rogue",
		"łotrzyk": "rogue",
		lotrzyk: "rogue",
		academic: "academic",
		uczony: "academic",
	};
	return aliases[normalized] ?? "";
}

function characteristicsChanged(changes) {
	return Object.keys(foundry.utils.flattenObject(changes ?? {}))
		.some((path) => path.startsWith("system.characteristics."));
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
