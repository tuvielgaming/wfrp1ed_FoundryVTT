import { CharacterCreationMode } from "../creation/CharacterCreationModeIntegration.mjs";
import {
	applyCreationValuePresentation,
	canonicalGender,
	CHARACTER_GENDER,
	genderFullLabel,
	genderShortLabel,
} from "../creation/CharacterCreationValuePresentation.mjs";

export { canonicalGender, CHARACTER_GENDER, genderFullLabel, genderShortLabel };

installStyle();
installCharacterGenderPresentation();

function installCharacterGenderPresentation() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;

		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (!(sheet instanceof HTMLElement)) return;

		const field = sheet.querySelector(".header-field--gender");
		if (!(field instanceof HTMLElement)) return;

		if (!CharacterCreationMode.enabled(actor)) {
			applyCreationValuePresentation(field, {
				inputName: "system.details.gender",
				displayValue: genderShortLabel(actor.system?.details?.gender),
				fullLabel: genderFullLabel(actor.system?.details?.gender),
			});
			return;
		}

		syncCreationSelector(application, actor, field);
	});
}

function syncCreationSelector(application, actor, field) {
	const existing = field.querySelector("select.wfrp1ed-gender-selector");
	if (existing instanceof HTMLSelectElement) {
		populateSelector(existing, actor.system?.details?.gender);
		return;
	}

	const input = field.querySelector('input[name="system.details.gender"]');
	if (!(input instanceof HTMLInputElement)) return;

	const select = document.createElement("select");
	select.name = "system.details.gender";
	select.className = "wfrp1ed-gender-selector";
	select.disabled = input.disabled || application?.isEditable === false;
	select.setAttribute("aria-label", localize("Gender", "Płeć"));
	populateSelector(select, actor.system?.details?.gender);

	select.addEventListener("change", () => {
		void actor.update({ "system.details.gender": select.value }).catch((error) => {
			console.error("WFRP1ED | Unable to set Character gender.", error);
			ui.notifications.error(error?.message ?? String(error));
		});
	});

	input.replaceWith(select);
}

function populateSelector(select, currentValue) {
	const current = canonicalGender(currentValue);
	select.replaceChildren();

	select.append(option("", "—", localize("Gender not selected", "Płeć nie została wybrana"), !current));
	select.append(option(
		CHARACTER_GENDER.MALE,
		"M",
		localize("Male (stored value: male)", "Mężczyzna (wartość silnika: male)"),
		current === CHARACTER_GENDER.MALE,
	));
	select.append(option(
		CHARACTER_GENDER.FEMALE,
		game.i18n.lang === "pl" ? "K" : "F",
		localize("Female (stored value: female)", "Kobieta (wartość silnika: female)"),
		current === CHARACTER_GENDER.FEMALE,
	));

	select.title = current
		? `${genderFullLabel(current)} — ${genderShortLabel(current)}`
		: localize("Select Gender", "Wybierz Płeć");
}

function option(value, label, title, selected) {
	const element = document.createElement("option");
	element.value = value;
	element.textContent = label;
	element.title = title;
	element.selected = selected;
	return element;
}

function installStyle() {
	if (document.getElementById("wfrp1ed-character-gender-selector-style")) return;
	const style = document.createElement("style");
	style.id = "wfrp1ed-character-gender-selector-style";
	style.textContent = `
		.wfrp1ed-classic-sheet .header-field--gender .wfrp1ed-gender-selector {
			display:block;width:100%;height:100%;margin:0;padding:2px 18px 2px 4px;
			border:0;border-radius:0;background-color:transparent;color:inherit;
			font:inherit;font-weight:700;text-align:center;cursor:pointer;
		}
		.wfrp1ed-classic-sheet .header-field--gender .wfrp1ed-gender-selector:hover,
		.wfrp1ed-classic-sheet .header-field--gender .wfrp1ed-gender-selector:focus {
			background-color:var(--rollable-hover-background);outline:1px solid var(--focus-color);outline-offset:-1px;
		}
		.wfrp1ed-classic-sheet .header-field--gender .wfrp1ed-gender-selector:disabled {
			cursor:default;opacity:.78;
		}
	`;
	document.head.append(style);
}

function classicSheetRoot(root) {
	if (root?.classList?.contains("wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
