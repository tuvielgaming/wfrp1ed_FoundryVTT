const CORE_RACE_IDENTITIES = Object.freeze([
	Object.freeze({ id: "", en: "Custom / no Core identity", pl: "Niestandardowa / bez tożsamości z zasad" }),
	Object.freeze({ id: "human", en: "Human", pl: "Człowiek" }),
	Object.freeze({ id: "wood-elf", en: "Wood Elf", pl: "Elf" }),
	Object.freeze({ id: "dwarf", en: "Dwarf", pl: "Krasnolud" }),
	Object.freeze({ id: "halfling", en: "Halfling", pl: "Niziołek" }),
]);

/**
 * Race keeps a stable language-neutral identity because Character Creation and
 * cross-compendium references may need it. The raw key is implementation data,
 * however, so Race authoring exposes only a controlled localized selector.
 *
 * This is deliberately a thin compatibility integration around the current
 * Race template. Once the Race sheet is next structurally refactored, the
 * selector should move into its native Handlebars context/template.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const item = application?.document;
	if (item?.documentName !== "Item" || item.type !== "race") return;

	const root = asElement(element) ?? asElement(application.element);
	if (!(root instanceof HTMLElement)) return;

	const input = root.querySelector('input[name="system.rulesId"]');
	if (!(input instanceof HTMLInputElement)) return;

	const select = document.createElement("select");
	select.name = "system.rulesId";
	select.className = input.className;
	select.disabled = input.disabled || application.isEditable !== true;
	select.title = localize(
		"Stable Core race identity used by references and audited creation rules. Custom races normally use no Core identity.",
		"Stała tożsamość Rasy z zasad używana przez odwołania i zaudytowane reguły tworzenia postaci. Rasy własne zwykle pozostają bez tożsamości z zasad.",
	);
	select.setAttribute("aria-label", localize(
		"Core identity / rules binding",
		"Tożsamość / powiązanie z zasadami",
	));

	const current = canonicalIdentity(item.system?.rulesId);
	for (const entry of CORE_RACE_IDENTITIES) {
		const option = document.createElement("option");
		option.value = entry.id;
		option.textContent = game.i18n.lang === "pl" ? entry.pl : entry.en;
		option.selected = current === entry.id;
		select.append(option);
	}

	if (current && !CORE_RACE_IDENTITIES.some((entry) => entry.id === current)) {
		const option = document.createElement("option");
		option.value = current;
		option.textContent = localize(
			`Legacy / unknown identity (${current})`,
			`Starsza / nieznana tożsamość (${current})`,
		);
		option.selected = true;
		select.append(option);
	}

	const label = input.closest(".race-sheet-field")?.querySelector("label, span");
	if (label instanceof HTMLElement) {
		label.textContent = localize(
			"Core identity / rules binding",
			"Tożsamość / powiązanie z zasadami",
		);
		label.title = select.title;
	}

	input.replaceWith(select);
});

function canonicalIdentity(value) {
	const normalized = String(value ?? "").trim().toLocaleLowerCase();
	const aliases = {
		woodelf: "wood-elf",
		"wood elf": "wood-elf",
	};
	return aliases[normalized] ?? normalized;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
