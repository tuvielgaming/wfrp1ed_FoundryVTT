import { CareerProgression } from "../careers/CareerProgression.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CAREER_ACQUISITION_FLAG_KEY = "careerAcquisition";
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
		renderMagicPointsLedger(application, actor, magicSection);
	}

	const powerLevelSection = element.querySelector(POWER_LEVEL_SECTION_SELECTOR);
	if (powerLevelSection instanceof HTMLElement) {
		renderPowerLevel(application, actor, powerLevelSection);
	}
});

/**
 * Magic Points are a resource ledger:
 * - current is the mutable number of points remaining;
 * - total is derived from race-specific Magic Point grants recorded when
 *   Careers are acquired.
 *
 * The total is deliberately not another editable Actor field. Career
 * acquisition is the authoritative source and some grants are rolled, so the
 * resolved grant has to remain attached to the acquired Career transaction.
 */
function renderMagicPointsLedger(application, actor, section) {
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
	const editable = application?.isEditable === true;

	currentInput.readOnly = !editable;
	currentInput.tabIndex = editable ? 0 : -1;
	totalInput.readOnly = true;
	totalInput.tabIndex = -1;

	if (!editable) return;

	currentInput.addEventListener("change", () => {
		void persistCurrentMagicPoints(actor, currentInput);
	});
	currentInput.addEventListener("keydown", commitOnEnter);
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

	try {
		if (ledger.hasDerivedTotal && next > ledger.total) {
			throw new Error(localize(
				"Current Magic Points cannot exceed Total Magic Points.",
				"Aktualne Punkty Magii nie mogą przekraczać Całkowitych Punktów Magii.",
			));
		}

		await actor.update({
			"system.status.magicPoints": next,
		});
	} catch (error) {
		input.value = String(ledger.current);
		console.error("WFRP1ED | Unable to update current Magic Points.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Magic Points.",
			"Nie udało się zaktualizować Punktów Magii.",
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
 * Current points live on Character.status. Total points are reconstructed from
 * immutable Career-acquisition results. Existing characters which predate
 * acquisition metadata temporarily use their current value as a compatibility
 * total so no points disappear merely because the metadata did not exist yet.
 */
export function readMagicLedger(actor) {
	const current = nonNegativeInteger(actor?.system?.status?.magicPoints);
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

	return Object.freeze({
		current,
		total: hasGrantRecord ? granted : current,
		hasDerivedTotal: hasGrantRecord,
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

	const roll = await new Roll(String(definition.formula)).evaluate({
		allowInteractive: false,
	});
	await showDice(roll);

	const granted = nonNegativeInteger(roll.total);
	const before = nonNegativeInteger(actor.system?.status?.magicPoints);
	const after = before + granted;
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
