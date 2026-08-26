import { CareerProgression } from "../careers/CareerProgression.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CAREER_ACQUISITION_FLAG_KEY = "careerAcquisition";
const OWNER_WOUNDS_EDIT_FLAG_KEY = "allowOwnerWoundsEdit";
const MAGIC_POINTS_TOTAL_FLAG_KEY = "magicPointsTotal";
const MAGIC_SECTION_SELECTOR = '[data-section="magicPoints"]';
const POWER_LEVEL_SECTION_SELECTOR = '[data-section="powerLevel"]';

installMagicCareerProgression();

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!(element instanceof HTMLElement)
	) {
		return;
	}

	const magicSection = element.querySelector(MAGIC_SECTION_SELECTOR);
	if (magicSection instanceof HTMLElement) {
		renderMagicPointsLedger(actor, magicSection);
	}

	const powerLevelSection = element.querySelector(POWER_LEVEL_SECTION_SELECTOR);
	if (powerLevelSection instanceof HTMLElement) {
		renderPowerLevel(application, actor, powerLevelSection);
	}
});

/**
 * Magic Points are a two-value resource ledger.
 *
 * Current is the remaining spendable resource stored in Character.status.
 * Total is persistent Actor ledger state. Before an explicit Total exists it is
 * reconstructed from recorded Career Magic Point grants; old Characters without
 * grant metadata temporarily use their existing Current value as the compatible
 * starting Total. The first manual Current edit freezes that displayed Total so
 * it no longer follows Current.
 *
 * Manual Current editing follows the same permission contract as remaining
 * Wounds: a GM is always allowed, while a player must be the explicitly assigned
 * OWNER and the GM must have enabled the existing owner-Wounds edit flag.
 * Manual Total editing is GM-only.
 */
function renderMagicPointsLedger(actor, section) {
	const ledger = readMagicLedger(actor);

	const current = buildMagicField(
		"current",
		localize("Current", "Aktualne"),
		ledger.current,
	);
	const total = buildMagicField(
		"total",
		localize("Total", "Całkowite"),
		ledger.total,
	);

	section.classList.add("wfrp1ed-magic-points-panel");
	section.replaceChildren(current.label, total.label);

	const currentInput = current.input;
	const totalInput = total.input;
	const canEditCurrent = canUserManuallyEditMagicPoints(actor, game.user);
	const canEditTotal = game.user?.isGM === true;

	currentInput.readOnly = !canEditCurrent;
	currentInput.tabIndex = canEditCurrent ? 0 : -1;
	totalInput.readOnly = !canEditTotal;
	totalInput.tabIndex = canEditTotal ? 0 : -1;

	if (canEditCurrent) {
		currentInput.addEventListener("change", () => {
			void persistCurrentMagicPoints(actor, currentInput);
		});
		currentInput.addEventListener("keydown", commitOnEnter);
	}

	if (canEditTotal) {
		totalInput.addEventListener("change", () => {
			void persistTotalMagicPoints(actor, totalInput);
		});
		totalInput.addEventListener("keydown", commitOnEnter);
	}
}

function buildMagicField(kind, labelText, value) {
	const label = document.createElement("label");
	label.className = `wfrp1ed-magic-points-field wfrp1ed-magic-points-field--${kind}`;

	const caption = document.createElement("span");
	caption.className = "wfrp1ed-magic-points-field__label";
	caption.textContent = labelText;

	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(value);
	input.dataset[`wfrpMagicPoints${kind[0].toUpperCase()}${kind.slice(1)}`] = "true";
	input.setAttribute(
		"aria-label",
		kind === "current"
			? localize("Current Magic Points", "Aktualne Punkty Magii")
			: localize("Total Magic Points", "Całkowite Punkty Magii"),
	);

	label.append(caption, input);
	return { label, input };
}

async function persistCurrentMagicPoints(actor, input) {
	const ledger = readMagicLedger(actor);
	const next = nonNegativeInteger(input.value);

	if (!canUserManuallyEditMagicPoints(actor, game.user)) {
		input.value = String(ledger.current);
		ui.notifications.warn(localize(
			"Manual Magic Points editing is locked by the GM.",
			"Ręczna edycja Punktów Magii jest zablokowana przez MG.",
		));
		return;
	}

	try {
		if (next > ledger.total) {
			throw new Error(localize(
				"Current Magic Points cannot exceed Total Magic Points.",
				"Aktualne Punkty Magii nie mogą przekraczać Całkowitych Punktów Magii.",
			));
		}

		const update = {
			"system.status.magicPoints": next,
		};

		/* Existing Characters may predate a separate Total. Freeze the Total that
		 * is currently displayed before changing Current so Total can never begin
		 * following the remaining resource. */
		if (!ledger.hasStoredTotal) {
			update[`flags.${FLAG_SCOPE}.${MAGIC_POINTS_TOTAL_FLAG_KEY}`] = ledger.total;
		}

		await actor.update(update);
	} catch (error) {
		input.value = String(ledger.current);
		console.error("WFRP1ED | Unable to update current Magic Points.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Magic Points.",
			"Nie udało się zaktualizować Punktów Magii.",
		));
	}
}

async function persistTotalMagicPoints(actor, input) {
	const ledger = readMagicLedger(actor);
	const next = nonNegativeInteger(input.value);

	if (game.user?.isGM !== true) {
		input.value = String(ledger.total);
		ui.notifications.warn(localize(
			"Only a GM can edit Total Magic Points.",
			"Tylko MG może edytować Całkowite Punkty Magii.",
		));
		return;
	}

	try {
		if (next < ledger.current) {
			throw new Error(localize(
				"Total Magic Points cannot be lower than Current Magic Points.",
				"Całkowite Punkty Magii nie mogą być niższe od Aktualnych Punktów Magii.",
			));
		}

		await actor.update({
			[`flags.${FLAG_SCOPE}.${MAGIC_POINTS_TOTAL_FLAG_KEY}`]: next,
		});
	} catch (error) {
		input.value = String(ledger.total);
		console.error("WFRP1ED | Unable to update Total Magic Points.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Total Magic Points.",
			"Nie udało się zaktualizować Całkowitych Punktów Magii.",
		));
	}
}

/**
 * Power Level uses the same persistence strategy as current Magic Points.
 * Replace the original Handlebars form control after render so Foundry's
 * ActorSheetV2 submit-on-change lifecycle cannot race the explicit Actor update.
 */
function renderPowerLevel(application, actor, section) {
	const input = document.createElement("input");
	input.className = "classic-magic-resource";
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(nonNegativeInteger(actor.system?.status?.powerLevel));
	input.dataset.wfrpPowerLevel = "true";
	input.setAttribute("aria-label", localize("Power Level", "Poziom Mocy"));

	section.replaceChildren(input);

	const editable = application?.isEditable === true;
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;
	if (!editable) return;

	input.addEventListener("change", () => {
		void persistPowerLevel(actor, input);
	});
	input.addEventListener("keydown", commitOnEnter);
}

async function persistPowerLevel(actor, input) {
	const previous = nonNegativeInteger(actor.system?.status?.powerLevel);
	const next = nonNegativeInteger(input.value);
	try {
		await actor.update({
			"system.status.powerLevel": next,
		});
	} catch (error) {
		input.value = String(previous);
		console.error("WFRP1ED | Unable to update Power Level.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Power Level.",
			"Nie udało się zaktualizować Poziomu Mocy.",
		));
	}
}

function commitOnEnter(event) {
	if (event.key !== "Enter") return;
	event.preventDefault();
	event.currentTarget?.blur?.();
}

/**
 * Current points live on Character.status. Total prefers the persistent Actor
 * ledger value, then recorded Career grants, then the legacy Current value as a
 * compatibility starting point for Characters created before this ledger.
 */
export function readMagicLedger(actor) {
	const current = nonNegativeInteger(actor?.system?.status?.magicPoints);
	const storedTotalRaw = actor?.getFlag?.(FLAG_SCOPE, MAGIC_POINTS_TOTAL_FLAG_KEY);
	const hasStoredTotal = isNonNegativeInteger(storedTotalRaw);

	let granted = 0;
	let hasGrantRecord = false;

	for (const career of [...(actor?.items ?? [])]) {
		if (career?.type !== "career") continue;
		const acquisition = career.getFlag?.(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY);
		const magic = acquisition?.magicPoints;
		if (!magic || typeof magic !== "object") continue;
		hasGrantRecord = true;
		granted += nonNegativeInteger(magic.granted);
	}

	const total = hasStoredTotal
		? nonNegativeInteger(storedTotalRaw)
		: hasGrantRecord
			? granted
			: current;

	return Object.freeze({
		current,
		total,
		hasStoredTotal,
		hasGrantRecord,
	});
}

/**
 * The original progression service grants the full package only for the initial
 * Career. WFRP 1e Magic Point increases, however, belong to the Career entry
 * itself and can therefore also occur on a later Career transition. Preserve
 * the existing transfer rules, then resolve only the target Career's Magic Point
 * grant and record that result on the acquired Career.
 */
function installMagicCareerProgression() {
	if (CareerProgression.__wfrpMagicCareerProgressionInstalled === true) return;

	const originalTransferCareer = CareerProgression.transferCareer;
	if (typeof originalTransferCareer !== "function") {
		console.error(
			"WFRP1ED | Magic Career progression could not install: transferCareer is unavailable.",
		);
		return;
	}

	CareerProgression.transferCareer = async function magicAwareCareerTransfer(
		sheet,
		targetCareer,
		options = {},
	) {
		const result = await originalTransferCareer.call(this, sheet, targetCareer, options);
		const actor = sheet?.document ?? sheet;
		const acquiredCareer = result?.career;

		if (
			actor?.documentName === "Actor" &&
			actor.type === "character" &&
			acquiredCareer?.type === "career"
		) {
			await grantCareerMagicPoints(actor, acquiredCareer);
		}

		return result;
	};

	Object.defineProperty(
		CareerProgression,
		"__wfrpMagicCareerProgressionInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function grantCareerMagicPoints(actor, career) {
	const acquisition = career.getFlag?.(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY);
	if (acquisition?.magicPoints && typeof acquisition.magicPoints === "object") {
		return acquisition.magicPoints;
	}

	const definition = matchingMagicPointDefinition(actor, career);
	if (!definition?.formula) return null;

	const ledgerBefore = readMagicLedger(actor);
	const roll = await new Roll(String(definition.formula)).evaluate({
		allowInteractive: false,
	});
	await showDice(roll);

	const granted = nonNegativeInteger(roll.total);
	const before = ledgerBefore.current;
	const after = before + granted;
	const totalAfter = ledgerBefore.total + granted;
	const magicPoints = Object.freeze({
		formula: String(definition.formula),
		roll: granted,
		granted,
		before,
		after,
		careerTransfer: true,
	});

	const previousAcquisition = acquisition && typeof acquisition === "object"
		? foundry.utils.deepClone(acquisition)
		: null;
	const nextAcquisition = {
		...(previousAcquisition ?? {}),
		magicPoints: foundry.utils.deepClone(magicPoints),
	};

	await career.setFlag(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY, nextAcquisition);
	try {
		await actor.update({
			"system.status.magicPoints": after,
			[`flags.${FLAG_SCOPE}.${MAGIC_POINTS_TOTAL_FLAG_KEY}`]: totalAfter,
		});
	} catch (error) {
		if (previousAcquisition) {
			await career.setFlag(
				FLAG_SCOPE,
				CAREER_ACQUISITION_FLAG_KEY,
				previousAcquisition,
			).catch(() => {});
		} else {
			await career.unsetFlag?.(FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY).catch(() => {});
		}
		throw error;
	}

	await ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content: `<section class="wfrp1ed career-acquisition-summary"><div><strong>${escapeHtml(localize("Magic Points", "Punkty Magii"))}:</strong> ${escapeHtml(`${definition.formula} → +${granted}`)}</div></section>`,
	});
	void actor.sheet?.render?.();
	return magicPoints;
}

function matchingMagicPointDefinition(actor, career) {
	const entries = Array.isArray(career.system?.magicPoints)
		? career.system.magicPoints
		: [];
	if (!entries.length) return null;

	const race = normalizeIdentity(actor.system?.details?.race);
	return entries.find((entry) => {
		const races = Array.isArray(entry?.races) ? entry.races : [];
		return races.length > 0 &&
			races.some((candidate) => normalizeIdentity(candidate) === race);
	}) ?? entries.find((entry) => !Array.isArray(entry?.races) || entry.races.length === 0) ?? null;
}

function canUserManuallyEditMagicPoints(actor, user = game.user) {
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!user
	) {
		return false;
	}

	if (user.isGM) return true;
	if (!isExplicitPlayerOwner(actor, user)) return false;

	return actor.getFlag?.(
		FLAG_SCOPE,
		OWNER_WOUNDS_EDIT_FLAG_KEY,
	) === true;
}

function isExplicitPlayerOwner(actor, user) {
	if (
		!(actor instanceof foundry.documents.Actor) ||
		!user ||
		user.isGM
	) {
		return false;
	}

	const ownership = actor.ownership ?? actor._source?.ownership ?? {};
	const level = Number(ownership?.[user.id]);
	return level === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

async function showDice(roll) {
	if (!game.dice3d?.showForRoll) return;
	try {
		await game.dice3d.showForRoll(roll, game.user, true);
	} catch (_error) {
		// Dice So Nice is presentation only.
	}
}

function normalizeIdentity(value) {
	return String(value ?? "")
		.trim()
		.toLocaleLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function isNonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isInteger(numeric) && numeric >= 0;
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = String(value ?? "");
	return div.innerHTML;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
