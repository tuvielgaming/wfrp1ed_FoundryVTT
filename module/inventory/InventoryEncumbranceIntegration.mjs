import { InventoryEncumbrance } from "./InventoryEncumbrance.mjs";

const OBSERVED_SHEETS = new WeakSet();

Hooks.on("renderApplicationV2", (application, element) => {
	const root = asElement(element);
	if (!root) return;

	const actor = application?.document;
	if (actor instanceof foundry.documents.Actor) {
		requestAnimationFrame(() => {
			const liveRoot = asElement(application?.element) ?? root;
			refreshClassicEncumbrance(liveRoot, actor);
			installClassicObserver(liveRoot, actor);
		});
	}

	requestAnimationFrame(() => {
		const liveRoot = asElement(application?.element) ?? root;
		refreshInventoryManager(liveRoot, application?.actor);
	});
});

function refreshClassicEncumbrance(root, actor) {
	const hosts = root.querySelectorAll?.("[data-wfrp1ed-inventory]") ?? [];
	for (const host of hosts) {
		if (!(host instanceof HTMLElement)) continue;
		const section = normalizeSection(host.dataset.inventorySection);
		refreshClassicRows(host, actor);
		refreshClassicTotal(host, actor, section);
	}

	refreshDisplayedMovement(root, actor);
}

function refreshClassicRows(host, actor) {
	for (const row of host.querySelectorAll(".classic-inventory__row[data-item-id]")) {
		const itemId = String(row.dataset.itemId ?? "");
		const item = actor.items?.get?.(itemId);
		if (!(item instanceof foundry.documents.Item)) continue;

		const cell = row.querySelector(
			".classic-inventory__encumbrance-cell .classic-inventory__number",
		);
		if (!(cell instanceof HTMLElement)) continue;

		const effective = InventoryEncumbrance.itemLoad(item, actor);
		const stack = InventoryEncumbrance.itemStack(item);
		setText(cell, formatNumber(effective));
		cell.title = effective === stack
			? localize(
				"Current Encumbrance contributed by this Item.",
				"Aktualne Obciążenie wnoszone przez ten przedmiot.",
			)
			: localize(
				`Worn clothing: ${formatNumber(stack)} Encumbrance is ignored while worn on the character.`,
				`Noszona odzież: ${formatNumber(stack)} punktów Obciążenia jest pomijane, gdy odzież jest założona na postać.`,
			);
	}
}

function refreshClassicTotal(host, actor, section) {
	let footer = host.querySelector(".classic-inventory__total-value");
	if (!(footer instanceof HTMLElement)) {
		footer = document.createElement("span");
		footer.className = "classic-inventory__total-value";
		footer.setAttribute(
			"aria-label",
			localize("Total Encumbrance", "Łączne Obciążenie"),
		);
		host.append(footer);
	}

	const total = InventoryEncumbrance.equipmentSectionTotal(actor, section);
	setText(footer, formatNumber(total));
	footer.title = section === "wealth"
		? localize(
			"Total effective Encumbrance currently shown in Wealth.",
			"Łączne efektywne Obciążenie przedmiotów widocznych w Majątku.",
		)
		: localize(
			"Total effective Encumbrance currently shown in Equipment.",
			"Łączne efektywne Obciążenie przedmiotów widocznych w Ekwipunku.",
		);
}

function refreshDisplayedMovement(root, actor) {
	const cell = root.querySelector?.(
		"[data-characteristic-row='current'] [data-characteristic='m']",
	);
	if (!(cell instanceof HTMLElement)) return;

	const state = InventoryEncumbrance.evaluate(actor);
	const value = cell.querySelector(".characteristic-current-profile");
	if (value instanceof HTMLElement) {
		setText(value, String(state.effectiveMovement));
	}

	cell.classList.toggle("is-reduced", state.movementPenalty > 0);
	cell.title = state.movementPenalty > 0
		? localize(
			`Encumbrance ${formatNumber(state.load)}/${formatNumber(state.capacity)}. Base Movement ${state.baseMovement}; overload penalty -${state.movementPenalty}; effective Movement ${state.effectiveMovement}.`,
			`Obciążenie ${formatNumber(state.load)}/${formatNumber(state.capacity)}. Bazowy Ruch ${state.baseMovement}; kara za przeciążenie -${state.movementPenalty}; efektywny Ruch ${state.effectiveMovement}.`,
		)
		: localize(
			`Encumbrance ${formatNumber(state.load)}/${formatNumber(state.capacity)}. No Movement penalty.`,
			`Obciążenie ${formatNumber(state.load)}/${formatNumber(state.capacity)}. Brak kary do Ruchu.`,
		);
}

function installClassicObserver(root, actor) {
	const sheet = root.matches?.(".wfrp1ed-classic-sheet")
		? root
		: root.querySelector?.(".wfrp1ed-classic-sheet");
	if (!(sheet instanceof HTMLElement) || OBSERVED_SHEETS.has(sheet)) return;
	OBSERVED_SHEETS.add(sheet);

	let queued = false;
	const observer = new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			if (!sheet.isConnected) {
				observer.disconnect();
				return;
			}
			refreshClassicEncumbrance(sheet, actor);
		});
	});
	observer.observe(sheet, { childList: true, subtree: true });
}

function refreshInventoryManager(root, actor) {
	const content = root.matches?.(".inventory-manager__content")
		? root
		: root.querySelector?.(".inventory-manager__content");
	if (!(content instanceof HTMLElement)) return;
	if (!(actor instanceof foundry.documents.Actor)) return;

	const state = InventoryEncumbrance.evaluate(actor);
	let summary = content.querySelector(".inventory-manager__summary");
	if (!(summary instanceof HTMLElement)) {
		summary = document.createElement("div");
		summary.className = "inventory-manager__summary";
		content.prepend(summary);
	}

	summary.classList.toggle("is-overloaded", state.overloaded);
	setText(
		summary,
		state.movementPenalty > 0
			? localize(
				`Encumbrance: ${formatNumber(state.load)} / ${formatNumber(state.capacity)} · Movement: ${state.effectiveMovement} (${state.baseMovement} − ${state.movementPenalty})`,
				`Obciążenie: ${formatNumber(state.load)} / ${formatNumber(state.capacity)} · Ruch: ${state.effectiveMovement} (${state.baseMovement} − ${state.movementPenalty})`,
			)
			: localize(
				`Encumbrance: ${formatNumber(state.load)} / ${formatNumber(state.capacity)} · Movement: ${state.effectiveMovement}`,
				`Obciążenie: ${formatNumber(state.load)} / ${formatNumber(state.capacity)} · Ruch: ${state.effectiveMovement}`,
			),
	);
	summary.title = state.overloaded
		? localize(
			`Over capacity by ${formatNumber(state.excess)}. Every started 50 Encumbrance above capacity reduces Movement by 1.`,
			`Przekroczono udźwig o ${formatNumber(state.excess)}. Każde rozpoczęte 50 punktów Obciążenia ponad udźwig zmniejsza Ruch o 1.`,
		)
		: localize(
			"The character is within normal carrying capacity.",
			"Postać mieści się w normalnym udźwigu.",
		);

	for (const row of content.querySelectorAll(".inventory-manager__row[data-item-id]")) {
		const item = actor.items?.get?.(String(row.dataset.itemId ?? ""));
		if (!(item instanceof foundry.documents.Item)) continue;
		const encumbranceCell = row.children?.[3];
		if (!(encumbranceCell instanceof HTMLElement)) continue;
		setText(
			encumbranceCell,
			formatNumber(InventoryEncumbrance.itemLoad(item, actor)),
		);
	}
}

function setText(element, value) {
	const text = String(value ?? "");
	if (element.textContent !== text) element.textContent = text;
}

function normalizeSection(value) {
	return String(value ?? "").trim().toLowerCase() === "wealth"
		? "wealth"
		: "equipment";
}

function formatNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "0";
	if (Number.isInteger(number)) return String(number);
	return String(Number(number.toFixed(2)));
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
