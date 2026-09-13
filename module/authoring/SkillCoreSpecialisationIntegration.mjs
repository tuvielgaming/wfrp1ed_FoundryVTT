import {
	coreSkillSpecialisationId,
	coreSkillSpecialisationOptions,
} from "../core/CoreSkillSpecialisationCatalog.mjs";

const CUSTOM = "custom";

/**
 * Controlled Core authoring for Skills with an audited finite specialisation
 * list. The integration is intentionally catalog-driven rather than keyed to a
 * single Skill. Adding another Skill to CoreSkillSpecialisationCatalog makes
 * the same selector available automatically in every ordinary Skill Item sheet.
 */
Hooks.once("ready", () => {
	Hooks.on("renderApplicationV2", (application, element) => {
		const item = application?.document;
		if (item?.documentName !== "Item" || item.type !== "skill") return;

		const skillId = String(item.system?.skillId ?? "").trim();
		if (!skillId) return;
		const options = coreSkillSpecialisationOptions(skillId, game.i18n.lang);
		if (!options.length) return;

		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement)) return;
		renderCoreSkillSpecialisation(
			root,
			item,
			skillId,
			options,
			application.isEditable === true,
		);
	});
});

function renderCoreSkillSpecialisation(root, item, skillId, options, editable) {
	const input = root.querySelector('input[name="system.specialisation"]');
	const field = input?.closest?.(".skill-sheet-field") ?? input?.closest?.("label");
	if (!(field instanceof HTMLElement)) return;

	const currentText = String(item.system?.specialisation ?? "").trim();
	const currentId = coreSkillSpecialisationId(skillId, currentText);
	const selected = currentId || (currentText ? CUSTOM : "");

	input.remove();
	const select = document.createElement("select");
	select.dataset.coreSkillSpecialisation = skillId;
	select.disabled = !editable;
	select.append(optionElement("", localize("None", "Brak"), selected === ""));
	for (const option of options) {
		select.append(optionElement(option.id, option.label, selected === option.id));
	}
	select.append(optionElement(
		CUSTOM,
		localize("Custom / homebrew", "Własna / autorska"),
		selected === CUSTOM,
	));
	field.append(select);

	const custom = document.createElement("input");
	custom.type = "text";
	custom.name = "system.specialisation";
	custom.autocomplete = "off";
	custom.disabled = !editable || selected !== CUSTOM;
	custom.value = selected === CUSTOM ? currentText : "";
	custom.hidden = selected !== CUSTOM;
	custom.placeholder = localize(
		"Custom Skill specialisation",
		"Własna specjalizacja Umiejętności",
	);
	field.append(custom);

	/*
	 * The selector is an authoring proxy rather than a submitted system field.
	 * Own its change event and persist the authoritative skillId together with
	 * the selected localized specialisation. This avoids ItemSheetV2
	 * submitOnChange racing a direct update with an older DOM snapshot.
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
			"system.skillId": skillId,
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
	console.error("WFRP1ED | Core Skill specialisation authoring failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
