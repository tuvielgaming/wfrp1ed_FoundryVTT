import { DisplayBuilder } from "../display/DisplayBuilder.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const FLAG_SCOPE = "wfrp1ed";
const INITIAL_CAREER_LOCK_FLAG_KEY = "initialCareerLocked";
const LAST_ADVANCE_FLAG_KEY = "lastCharacteristicAdvance";

installCareerDisplaySource();
installCareerDropHandling();

/**
 * The printed Character sheet displays career identity, but the identity itself
 * belongs to an embedded Career Item. Actor.details.currentCareer/careerClass
 * remain only as migration compatibility until the Career data-model migration
 * removes them; they are never authoritative when an active Career Item exists.
 */
function installCareerDisplaySource() {
	if (DisplayBuilder.__wfrpCareerDisplaySourceInstalled === true) return;

	const original = DisplayBuilder.details;
	DisplayBuilder.details = function linkedCareerDetails(document) {
		const details = original.call(this, document);
		const career = activeCareer(document);
		if (!career) return details;

		return {
			...details,
			currentCareer: String(career.name ?? ""),
			careerClass: careerClassName(career),
		};
	};

	Object.defineProperty(
		DisplayBuilder,
		"__wfrpCareerDisplaySourceInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/**
 * Use ActorSheetV2's already-resolved Item drop, but intercept Career Items
 * before the generic sheet creates an ordinary embedded copy.
 *
 * Character-creation assignment/replacement is deliberately distinct from a
 * later career change:
 * - the sheet must be editable, exactly like the initial characteristic row;
 * - no Experience Point expenditure may ever have begun;
 * - replacing the initial career resets the one-entry career history rather
 *   than recording discarded character-creation choices;
 * - after XP spending begins, a Career drop is rejected until the dedicated
 *   paid Career Transfer workflow owns that operation.
 */
function installCareerDropHandling() {
	if (ClassicActorSheet.prototype.__wfrpCareerDropInstalled === true) return;

	const original = ClassicActorSheet.prototype._onDropItem;
	if (typeof original !== "function") {
		console.error(
			"WFRP1ED | ClassicActorSheet has no _onDropItem method; Career drop integration was not installed.",
		);
		return;
	}

	ClassicActorSheet.prototype._onDropItem = async function careerAwareDrop(
		event,
		item,
	) {
		if (item?.type !== "career") {
			return original.call(this, event, item);
		}

		return assignInitialCareer(this, item);
	};

	Object.defineProperty(
		ClassicActorSheet.prototype,
		"__wfrpCareerDropInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/**
 * Once XP spending has started, character creation is over permanently even if
 * a reversible purchase later refunds the currently-spent total back to zero.
 * Stamp that lifecycle fact on any Actor update which crosses or leaves the
 * first positive spent-XP state.
 */
Hooks.on("preUpdateActor", (actor, changes) => {
	if (actor?.type !== "character" || !isObject(changes)) return;
	if (actor.getFlag?.(FLAG_SCOPE, INITIAL_CAREER_LOCK_FLAG_KEY) === true) return;

	const currentSpent = nonNegativeInteger(actor.system?.experience?.spent);
	const proposedSpent = nonNegativeInteger(changedValue(
		changes,
		"system.experience.spent",
		currentSpent,
	));

	if (currentSpent <= 0 && proposedSpent <= 0) return;

	foundry.utils.setProperty(
		changes,
		`flags.${FLAG_SCOPE}.${INITIAL_CAREER_LOCK_FLAG_KEY}`,
		true,
	);
});

/** Make printed career identity fields linked/read-only and explain drop state. */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	const career = activeCareer(actor);
	const currentInput = element.querySelector(
		".header-field--current-career input",
	);
	const classInput = element.querySelector(
		".header-field--career-class input",
	);

	makeLinkedField(
		currentInput,
		career?.name ?? currentInput?.value ?? "",
		careerFieldTitle(actor, application.isEditable === true),
	);
	makeLinkedField(
		classInput,
		career ? careerClassName(career) : classInput?.value ?? "",
		careerFieldTitle(actor, application.isEditable === true),
	);
});

async function assignInitialCareer(sheet, droppedCareer) {
	const actor = sheet?.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") {
		return null;
	}

	if (sheet.isEditable !== true) {
		ui.notifications.warn(localize(
			"Enable sheet editing before assigning the initial Career.",
			"Włącz edycję karty przed przypisaniem profesji początkowej.",
		));
		return null;
	}

	if (initialCareerLocked(actor)) {
		ui.notifications.warn(localize(
			"The initial Career is locked because Experience Point spending has already begun. Later Career changes must use the Career Transfer workflow; no Career was changed.",
			"Profesja początkowa jest zablokowana, ponieważ rozpoczęto już wydawanie Punktów Doświadczenia. Późniejsze zmiany profesji muszą korzystać z mechanizmu Zmiany Profesji; niczego nie zmieniono.",
		));
		return null;
	}

	let created = false;
	let selected = null;
	const previousActive = activeCareers(actor);
	const previousDetails = cloneDetails(actor);

	try {
		const sameActor = String(droppedCareer.actor?.uuid ?? droppedCareer.parent?.uuid ?? "") ===
			String(actor.uuid ?? "");

		if (sameActor) {
			selected = droppedCareer;
		} else {
			const source = careerCopySource(droppedCareer);
			const createdItems = await actor.createEmbeddedDocuments("Item", [source]);
			selected = createdItems[0] ?? null;
			created = Boolean(selected);
		}

		if (!selected || selected.type !== "career") {
			throw new Error("Foundry did not create or resolve the dropped Career Item.");
		}

		const selectedBefore = careerStateSnapshot(selected);
		const otherActive = previousActive.filter(
			(career) => String(career.id) !== String(selected.id),
		);

		const stateUpdates = [
			...otherActive.map((career) => careerStateUpdate(career, {
				current: false,
			})),
			careerStateUpdate(selected, {
				current: true,
				complete: false,
			}),
		];

		await actor.updateEmbeddedDocuments("Item", stateUpdates);

		const details = cloneDetails(actor);
		/* Legacy text fields are intentionally cleared: the Career Item now owns them. */
		details.currentCareer = "";
		details.careerClass = "";
		details.careerExits = [];
		details.careerHistory = [{
			name: String(selected.name ?? ""),
			uuid: String(selected.uuid ?? ""),
			completed: false,
		}];

		try {
			await actor.update({ "system.details": details });
		} catch (error) {
			await restoreCareerStates(actor, previousActive, selected, selectedBefore, {
				created,
			});
			await actor.update({ "system.details": previousDetails }).catch(() => {});
			throw error;
		}

		if (otherActive.length > 0) {
			try {
				await actor.deleteEmbeddedDocuments(
					"Item",
					otherActive.map((career) => career.id),
				);
			} catch (error) {
				/* The old choices are inactive, so failure to clean them is non-fatal. */
				console.warn(
					"WFRP1ED | Initial Career changed, but obsolete inactive Career Items could not be removed.",
					error,
				);
			}
		}

		const replaced = otherActive.length > 0;
		ui.notifications.info(replaced
			? localize(
				`Initial Career changed to ${selected.name}. No XP has been spent, so the discarded character-creation choice was not added to Career History.`,
				`Profesję początkową zmieniono na ${selected.name}. Nie wydano jeszcze PD, więc odrzucony wybór z tworzenia postaci nie został dodany do Przebiegu kariery.`,
			)
			: localize(
				`Initial Career set to ${selected.name}.`,
				`Ustawiono profesję początkową: ${selected.name}.`,
			));

		void actor.sheet?.render?.();
		return selected;
	} catch (error) {
		if (created && selected?.id && actor.items?.has?.(selected.id)) {
			await actor.deleteEmbeddedDocuments("Item", [selected.id]).catch(() => {});
		}

		console.error("WFRP1ED | Unable to assign initial Career.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to assign the initial Career.",
				"Nie udało się przypisać profesji początkowej.",
			),
		);
		return null;
	}
}

async function restoreCareerStates(
	actor,
	previousActive,
	selected,
	selectedBefore,
	{ created },
) {
	const updates = previousActive
		.filter((career) => actor.items?.has?.(career.id))
		.map((career) => careerStateUpdate(career, { current: true }));

	if (!created && selected?.id && actor.items?.has?.(selected.id)) {
		updates.push(careerStateUpdate(selected, selectedBefore));
	}

	if (updates.length > 0) {
		await actor.updateEmbeddedDocuments("Item", updates).catch(() => {});
	}
}

function careerCopySource(item) {
	const source = item.toObject();
	delete source._id;
	delete source.folder;
	delete source.sort;
	delete source.ownership;
	delete source._stats;

	source.system = foundry.utils.deepClone(source.system ?? {});
	writeBooleanSource(source.system, "current", false);
	writeBooleanSource(source.system, "complete", false);
	return source;
}

function activeCareer(actor) {
	return activeCareers(actor)[0] ?? null;
}

function activeCareers(actor) {
	return [...(actor?.items ?? [])].filter(
		(item) => item?.type === "career" && readBoolean(item.system?.current),
	);
}

function careerClassName(career) {
	return readText(career?.system?.class);
}

function careerStateSnapshot(career) {
	return {
		current: readBoolean(career?.system?.current),
		complete: readBoolean(career?.system?.complete),
	};
}

function careerStateUpdate(career, { current, complete } = {}) {
	const update = { _id: career.id };
	if (current !== undefined) {
		update[booleanFieldPath(career, "current")] = Boolean(current);
	}
	if (complete !== undefined) {
		update[booleanFieldPath(career, "complete")] = Boolean(complete);
	}
	return update;
}

function booleanFieldPath(career, key) {
	const value = career?.system?.[key];
	return isObject(value) && Object.hasOwn(value, "value")
		? `system.${key}.value`
		: `system.${key}`;
}

function writeBooleanSource(system, key, value) {
	if (isObject(system?.[key]) && Object.hasOwn(system[key], "value")) {
		system[key].value = Boolean(value);
		return;
	}
	system[key] = Boolean(value);
}

function readBoolean(value) {
	if (isObject(value) && Object.hasOwn(value, "value")) {
		return value.value === true;
	}
	return value === true;
}

function readText(value) {
	if (isObject(value) && Object.hasOwn(value, "value")) {
		return String(value.value ?? "").trim();
	}
	return String(value ?? "").trim();
}

function cloneDetails(actor) {
	const systemSource = typeof actor.system?.toObject === "function"
		? actor.system.toObject()
		: foundry.utils.deepClone(actor.system ?? {});
	return foundry.utils.deepClone(systemSource.details ?? {});
}

function initialCareerLocked(actor) {
	if (actor?.getFlag?.(FLAG_SCOPE, INITIAL_CAREER_LOCK_FLAG_KEY) === true) {
		return true;
	}
	if (nonNegativeInteger(actor?.system?.experience?.spent) > 0) return true;

	/* A recorded purchase proves XP spending began even if it was later undone. */
	return isObject(actor?.getFlag?.(FLAG_SCOPE, LAST_ADVANCE_FLAG_KEY));
}

function makeLinkedField(input, value, title) {
	if (!(input instanceof HTMLInputElement)) return;
	input.value = String(value ?? "");
	input.readOnly = true;
	input.removeAttribute("name");
	input.dataset.wfrpCareerLinked = "";
	input.setAttribute("aria-readonly", "true");
	input.title = title;
}

function careerFieldTitle(actor, editable) {
	if (initialCareerLocked(actor)) {
		return localize(
			"Career is linked to a Career Item. Character-creation replacement is locked because XP spending has begun.",
			"Profesja jest powiązana z Przedmiotem Profesji. Zmiana wyboru z tworzenia postaci jest zablokowana, ponieważ rozpoczęto wydawanie PD.",
		);
	}
	if (!editable) {
		return localize(
			"Career is linked to a Career Item. Enable sheet editing to assign or replace the initial Career.",
			"Profesja jest powiązana z Przedmiotem Profesji. Włącz edycję karty, aby przypisać lub zmienić profesję początkową.",
		);
	}
	return localize(
		"Drop a Career Item on the sheet to assign or replace the initial Career. This closes permanently when XP spending begins.",
		"Upuść Przedmiot Profesji na kartę, aby przypisać lub zmienić profesję początkową. Możliwość ta zostanie trwale zamknięta po rozpoczęciu wydawania PD.",
	);
}

function changedValue(changes, path, fallback) {
	if (Object.hasOwn(changes ?? {}, path)) return changes[path];
	const nested = foundry.utils.getProperty(changes ?? {}, path);
	return nested === undefined ? fallback : nested;
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
