import { coreSkillSpecialisationOptions } from "../core/CoreSkillSpecialisationCatalog.mjs";
import { WEAPON_GROUP } from "../data-models/item/WeaponData.mjs";

const CUSTOM_BINDING = "custom";

/**
 * Weapon authoring UX for WFRP 1e Specialist Weapon requirements.
 *
 * The Weapon data model stores a language-neutral Core specialisation id in
 * `system.specialistSkillId`. Normal authoring never asks for that raw id.
 * Instead, the sheet presents the audited Core Specialist Weapon list with
 * localized labels. `custom` reveals an unrestricted homebrew field stored in
 * `system.specialistSkillCustom`.
 *
 * `weaponClass` was a legacy free-text field with no independent rules owner;
 * this integration removes its old template control while content migrates to
 * the structured Weapon model.
 */
export function installWeaponSpecialistBindingAuthoring() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const item = application?.document;
		if (item?.documentName !== "Item" || item.type !== "weapon") return;
		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement)) return;

		removeLegacyWeaponClass(root);
		renderSpecialistBinding(root, item, application.isEditable === true);
	});
}

function removeLegacyWeaponClass(root) {
	const input = root.querySelector('input[name="system.weaponClass"]');
	input?.closest?.("label")?.remove();
}

function renderSpecialistBinding(root, item, editable) {
	const legacyInput = root.querySelector('input[name="system.specialistSkillId"]');
	const field = legacyInput?.closest?.("label");
	if (!(field instanceof HTMLElement)) return;

	if (item.system?.group !== WEAPON_GROUP.SPECIALIST) {
		field.remove();
		return;
	}

	const current = String(item.system?.specialistSkillId ?? "").trim();
	const options = coreSkillSpecialisationOptions("specialistWeapon", game.i18n.lang);
	const known = options.some((option) => option.id === current);
	const selected = known ? current : current === CUSTOM_BINDING ? CUSTOM_BINDING : "";

	field.classList.add("weapon-specialist-binding");
	field.replaceChildren();

	const label = document.createElement("span");
	label.textContent = localize("Required Specialist Weapon Skill", "Wymagana Specjalna broń");
	label.title = localize(
		"Core specialisations are stored by a language-neutral identity. Choose Custom for homebrew specialisations.",
		"Specjalizacje z zasad są zapisywane przez niezależną od języka tożsamość. Wybierz Własna dla specjalizacji autorskiej.",
	);
	field.append(label);

	const select = document.createElement("select");
	select.name = "system.specialistSkillId";
	select.disabled = !editable;
	select.append(optionElement("", localize("None", "Brak"), selected === ""));
	for (const option of options) {
		select.append(optionElement(option.id, option.label, selected === option.id));
	}
	select.append(optionElement(CUSTOM_BINDING, localize("Custom / homebrew", "Własna / autorska"), selected === CUSTOM_BINDING));
	field.append(select);

	if (selected === CUSTOM_BINDING) {
		const custom = document.createElement("input");
		custom.type = "text";
		custom.name = "system.specialistSkillCustom";
		custom.value = String(item.system?.specialistSkillCustom ?? "");
		custom.placeholder = localize("Custom Specialist Weapon specialisation", "Własna specjalizacja Specjalnej broni");
		custom.autocomplete = "off";
		custom.disabled = !editable;
		field.append(custom);
	}
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
