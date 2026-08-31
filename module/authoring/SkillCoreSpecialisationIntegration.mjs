import {
	coreSkillSpecialisationId,
	coreSkillSpecialisationOptions,
} from "../core/CoreSkillSpecialisationCatalog.mjs";

const SPECIALIST_RULES_ID = "specialistWeapon";
const CUSTOM = "custom";

/** Controlled Core authoring for finite Skill specialisations. */
Hooks.once("ready", () => {
	Hooks.on("renderApplicationV2", (application, element) => {
		const item = application?.document;
		if (item?.documentName !== "Item" || item.type !== "skill") return;
		if (String(item.system?.rulesId ?? "").trim() !== SPECIALIST_RULES_ID) return;
		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement)) return;
		renderSpecialistWeaponSpecialisation(root, item, application.isEditable === true);
	});
});

function renderSpecialistWeaponSpecialisation(root, item, editable) {
	const input = root.querySelector('input[name="system.specialisation"]');
	const field = input?.closest?.(".skill-sheet-field") ?? input?.closest?.("label");
	if (!(field instanceof HTMLElement)) return;

	const currentText = String(item.system?.specialisation ?? "").trim();
	const currentId = coreSkillSpecialisationId(SPECIALIST_RULES_ID, currentText);
	const selected = currentId || (currentText ? CUSTOM : "");
	const options = coreSkillSpecialisationOptions(SPECIALIST_RULES_ID, game.i18n.lang);

	input.remove();
	const select = document.createElement("select");
	select.dataset.specialistWeaponSpecialisation = "true";
	select.disabled = !editable;
	select.append(optionElement("", localize("None", "Brak"), selected === ""));
	for (const option of options) select.append(optionElement(option.id, option.label, selected === option.id));
	select.append(optionElement(CUSTOM, localize("Custom / homebrew", "Własna / autorska"), selected === CUSTOM));
	field.append(select);

	const custom = document.createElement("input");
	custom.type = "text";
	custom.name = "system.specialisation";
	custom.autocomplete = "off";
	custom.disabled = !editable;
	custom.value = selected === CUSTOM ? currentText : localizedSelection(options, selected);
	custom.hidden = selected !== CUSTOM;
	custom.placeholder = localize("Custom Specialist Weapon category", "Własna kategoria Specjalnej broni");
	field.append(custom);

	select.addEventListener("change", (event) => {
		const value = String(event.currentTarget.value ?? "");
		if (value === CUSTOM) {
			custom.hidden = false;
			custom.value = "";
			custom.focus();
			return;
		}
		custom.hidden = true;
		const label = localizedSelection(options, value);
		void item.update({ "system.specialisation": label }).catch(reportError);
	});
}

function localizedSelection(options, id) {
	return options.find((option) => option.id === id)?.label ?? "";
}

function optionElement(value, label, selected) {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	option.selected = selected;
	return option;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportError(error) {
	console.error("WFRP1ED | Specialist Weapon Skill authoring failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
