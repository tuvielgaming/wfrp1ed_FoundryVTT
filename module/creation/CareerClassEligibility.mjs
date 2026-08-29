import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";
import "./RaceCharacteristicGeneration.mjs";

const CAREER_CLASSES = Object.freeze([
	Object.freeze({ id: "warrior", pl: "Wojownik", en: "Warrior" }),
	Object.freeze({ id: "ranger", pl: "Wędrowiec", en: "Ranger" }),
	Object.freeze({ id: "rogue", pl: "Łotr", en: "Rogue" }),
	Object.freeze({ id: "academic", pl: "Uczony", en: "Academic" }),
]);

/**
 * WFRP 1e Core Career Class eligibility belongs to character creation rules,
 * not to individual Race Items.
 */
export class CareerClassEligibility {
	static classes() { return CAREER_CLASSES; }

	static evaluate(actor, classId) {
		const id = String(classId ?? "").trim();
		const requirements = requirementsFor(actor, id);
		if (!requirements.length) {
			return { eligible: false, requirements: [], failed: [], reason: localize("Unknown Career Class.", "Nieznana Klasa Profesji.") };
		}
		const failed = requirements.filter((requirement) => characteristicValue(actor, requirement.characteristic) < requirement.minimum);
		return { eligible: failed.length === 0, requirements, failed, reason: requirementText(requirements) };
	}

	static options(actor) {
		return CAREER_CLASSES.map((entry) => ({
			...entry,
			label: game.i18n.lang === "pl" ? entry.pl : entry.en,
			...this.evaluate(actor, entry.id),
		}));
	}
}

installCharacterCreationClassSelector();

function installCharacterCreationClassSelector() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		if (!(root instanceof HTMLElement)) return;

		/* Run once immediately and once after the current render-hook queue. Some
		 * Classic-sheet integrations still decorate the header during render;
		 * the deferred pass makes the Career Class selector the final owner of
		 * that field in Character Creation Mode. */
		syncSelector(actor, root);
		queueMicrotask(() => {
			const liveRoot = asElement(application?.element) ?? root;
			if (liveRoot instanceof HTMLElement && CharacterCreationMode.enabled(actor)) {
				syncSelector(actor, liveRoot);
			}
		});
	});

	Hooks.on("updateActor", (actor, changes) => {
		if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
		if (!characteristicsChanged(changes) && !careerClassChanged(changes)) return;
		const root = asElement(actor.sheet?.element);
		if (root instanceof HTMLElement) syncSelector(actor, root);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const root = asElement(actor.sheet?.element);
			if (root instanceof HTMLElement) syncSelector(actor, root);
		});
	}
}

function syncSelector(actor, root) {
	const sheet = classicSheetRoot(root);
	if (!(sheet instanceof HTMLElement)) return;

	const field = sheet.querySelector(".header-field--career-class");
	if (!(field instanceof HTMLElement)) return;

	let select = field.querySelector("select.wfrp1ed-career-class-selector");
	if (!(select instanceof HTMLSelectElement)) {
		/* Do not rely on the input retaining a particular name. Other header
		 * integrations may change/remove form ownership while decorating fields. */
		const input = field.querySelector("input");
		if (!(input instanceof HTMLInputElement)) return;

		select = document.createElement("select");
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
	}

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
		element.textContent = option.eligible ? option.label : `${option.label} — ${option.reason}`;
		element.disabled = !option.eligible;
		element.selected = current === option.id;
		element.title = option.reason;
		element.dataset.tooltip = option.reason;
		select.append(element);
	}

	select.title = localize(
		"Career Classes which do not meet the current Characteristic requirements are disabled. Disabled entries show their requirements in the list.",
		"Klasy Profesji, których aktualne Cechy nie spełniają wymagań, są wyłączone. Wyłączone pozycje pokazują wymagania bezpośrednio na liście.",
	);
}

function requirementsFor(actor, classId) {
	switch (classId) {
		case "warrior": return [{ characteristic: "ws", minimum: 30 }];
		case "ranger": return [{ characteristic: "bs", minimum: 30 }];
		case "rogue": return [{ characteristic: "i", minimum: isWoodElf(actor) ? 65 : 30 }];
		case "academic": return [{ characteristic: "int", minimum: 30 }, { characteristic: "wp", minimum: 30 }];
		default: return [];
	}
}

function characteristicValue(actor, id) {
	const characteristic = actor?.system?.characteristics?.[id];
	const value = Number(characteristic?.current ?? characteristic?.initial ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function isWoodElf(actor) {
	const race = game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ?? actor?.items?.find?.((item) => item.type === "race") ?? null;
	const rulesId = normalize(race?.system?.rulesId);
	return ["wood-elf", "woodelf"].includes(rulesId);
}

function requirementText(requirements) {
	return requirements.map((requirement) => `${characteristicLabel(requirement.characteristic)} ≥ ${requirement.minimum}`).join(localize(" and ", " i "));
}

function characteristicLabel(id) {
	const labels = { ws: ["WW", "WS"], bs: ["US", "BS"], i: ["I", "I"], int: ["Int", "Int"], wp: ["SW", "WP"] };
	const pair = labels[id] ?? [id, id];
	return game.i18n.lang === "pl" ? pair[0] : pair[1];
}

function canonicalClassId(value) {
	const normalized = normalize(value);
	const aliases = {
		warrior: "warrior", wojownik: "warrior",
		ranger: "ranger", "wędrowiec": "ranger", wedrowiec: "ranger",
		rogue: "rogue", "łotr": "rogue", lotr: "rogue", "łotrzyk": "rogue", lotrzyk: "rogue",
		academic: "academic", uczony: "academic",
	};
	return aliases[normalized] ?? "";
}

function classicSheetRoot(root) {
	if (root?.classList?.contains("wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function characteristicsChanged(changes) {
	return Object.keys(foundry.utils.flattenObject(changes ?? {})).some((path) => path.startsWith("system.characteristics."));
}

function careerClassChanged(changes) {
	return foundry.utils.getProperty(changes ?? {}, "system.details.careerClass") !== undefined || Object.hasOwn(changes ?? {}, "system.details.careerClass");
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }
