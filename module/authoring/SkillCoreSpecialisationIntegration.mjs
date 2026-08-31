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
	custom.disabled = !editable || selected !== CUSTOM;
	custom.value = selected === CUSTOM ? currentText : "";
	custom.hidden = selected !== CUSTOM;
	custom.placeholder = localize("Custom Specialist Weapon category", "Własna kategoria Specjalnej broni");
	field.append(custom);

	/*
	 * This select is an authoring proxy rather than a real form field. Foundry's
	 * ItemSheetV2 uses submitOnChange for the surrounding form. If this synthetic
	 * change bubbles to that handler while the direct Item update is running, two
	 * competing updates can be submitted from different DOM snapshots. In
	 * particular the older full-form snapshot can overwrite system.rulesId.
	 *
	 * Own the event here, persist both the selected specialisation and the
	 * authoritative Core rules binding in one update, then let the document
	 * rerender normally. This makes changing the category incapable of silently
	 * turning Specialist Weapon back into an unbound custom Skill.
	 */
	select.addEventListener("change", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const value = String(event.currentTarget.value ?? "");
		if (value === CUSTOM) {
			custom.hidden = false;
			custom.disabled = !editable;
			custom.value = "";
			custom.focus();
			return;
		}

		custom.hidden = true;
		custom.disabled = true;
		const label = localizedSelection(options, value);
		void item.update({
			"system.rulesId": SPECIALIST_RULES_ID,
			"system.specialisation": label,
		}).catch(reportError);
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
