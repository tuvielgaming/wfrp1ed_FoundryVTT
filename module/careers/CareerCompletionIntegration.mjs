import { CAREER_TIER } from "../data-models/item/CareerData.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { CareerProgression } from "./CareerProgression.mjs";

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

/**
 * Derived Career-completion state.
 *
 * Completion deliberately ignores current XP affordability. A characteristic is
 * complete when its historically purchased advances meet the active Career's
 * scheme. Career Skills are complete when the Character sheet has no remaining
 * derived Career Skill offers (the same grey entries used by the existing UI).
 *
 * Career-specific requirements such as magical spell prerequisites belong on
 * top of this generic state and are intentionally not guessed here before the
 * Spell/Magic subsystem is audited.
 */
export class CareerCompletion {
	static state(actor, career = CareerProgression.activeCareer(actor)) {
		if (!actor || !career) {
			return Object.freeze({
				careerId: "",
				advancesComplete: false,
				skillsComplete: false,
				complete: false,
				missingAdvances: Object.freeze([]),
				missingSkills: Object.freeze([]),
			});
		}

		const missingAdvances = CHARACTERISTIC_IDS.flatMap((id) => {
			const required = nonNegativeInteger(career.system?.advanceScheme?.[id]);
			const purchased = nonNegativeInteger(
				actor.system?.characteristics?.[id]?.purchased,
			);
			if (purchased >= required) return [];
			return [Object.freeze({
				id,
				purchased,
				required,
				remaining: required - purchased,
			})];
		});

		const missingSkills = CareerProgression.skillOffers(actor).map((offer) =>
			Object.freeze({
				key: String(offer.key ?? ""),
				name: String(offer.name ?? ""),
			}),
		);

		const advancesComplete = missingAdvances.length === 0;
		const skillsComplete = missingSkills.length === 0;

		return Object.freeze({
			careerId: String(career.id ?? ""),
			advancesComplete,
			skillsComplete,
			complete: advancesComplete && skillsComplete,
			missingAdvances: Object.freeze(missingAdvances),
			missingSkills: Object.freeze(missingSkills),
		});
	}
}

installCareerCompletionTransferGuard();

/**
 * Keep the legacy Career `system.complete` flag as a compatibility cache only.
 * Every transfer attempt refreshes it from Actor progression before the existing
 * progression service evaluates an Exit's `requiresComplete` restriction.
 *
 * The optional World Setting adds one extra gate only to otherwise recognizable
 * Advanced Career Exits. Illegal arbitrary Advanced-Career drops are left for
 * the existing transfer policy so they retain their proper error reason.
 */
function installCareerCompletionTransferGuard() {
	if (CareerProgression.__wfrpCareerCompletionGuardInstalled === true) return;

	const original = CareerProgression.transferCareer;
	if (typeof original !== "function") {
		console.error(
			"WFRP1ED | Career completion guard could not install: transferCareer is unavailable.",
		);
		return;
	}

	CareerProgression.transferCareer = async function completionAwareTransfer(
		sheet,
		targetCareer,
		options = {},
	) {
		const actor = sheet?.document ?? sheet;
		const current = CareerProgression.activeCareer(actor);

		/* Let the authoritative progression service own malformed calls and
		 * permission errors. Completion is meaningful only for an owned Character
		 * with an active Career. */
		if (
			actor?.documentName !== "Actor" ||
			actor.type !== "character" ||
			actor.isOwner !== true ||
			!current ||
			targetCareer?.type !== "career"
		) {
			return original.call(this, sheet, targetCareer, options);
		}

		const state = CareerCompletion.state(actor, current);
		await synchronizeCompletionCache(current, state.complete);

		const exit = matchingExitOffer(actor, targetCareer, options?.exitIndex);
		const exitRequiresCompletion = exit?.requiresComplete === true;
		const optionalAdvancedGate = Boolean(exit) &&
			readText(targetCareer.system?.tier) === CAREER_TIER.ADVANCED &&
			WfrpRuleSettings.requiresCareerCompletionForAdvancedTransfer();

		if ((exitRequiresCompletion || optionalAdvancedGate) && !state.complete) {
			throw new Error(completionError(state, {
				advancedSetting: optionalAdvancedGate,
			}));
		}

		return original.call(this, sheet, targetCareer, options);
	};

	Object.defineProperty(
		CareerProgression,
		"__wfrpCareerCompletionGuardInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function synchronizeCompletionCache(career, complete) {
	if (readBoolean(career.system?.complete) === Boolean(complete)) return;
	await career.update({ "system.complete": Boolean(complete) });
}

function matchingExitOffer(actor, targetCareer, exitIndex) {
	const offers = CareerProgression.exitOffers(actor);
	const explicitIndex = Number(exitIndex);
	if (Number.isInteger(explicitIndex) && explicitIndex >= 0) {
		const explicit = offers[explicitIndex] ?? null;
		return explicit && targetMatchesExit(targetCareer, explicit)
			? explicit
			: null;
	}
	return offers.find((offer) => targetMatchesExit(targetCareer, offer)) ?? null;
}

function targetMatchesExit(targetCareer, exit) {
	const targetUuid = String(targetCareer?.uuid ?? "").trim();
	const exitUuid = String(exit?.uuid ?? "").trim();
	if (targetUuid && exitUuid && targetUuid === exitUuid) return true;

	const targetRulesId = normalizeReference(readText(targetCareer?.system?.rulesId));
	const exitRulesId = normalizeReference(exit?.rulesId);
	if (targetRulesId && exitRulesId && targetRulesId === exitRulesId) return true;

	const targetName = normalizeReference(targetCareer?.name);
	const exitName = normalizeReference(exit?.name);
	return Boolean(targetName && exitName && targetName === exitName);
}

function completionError(state, { advancedSetting = false } = {}) {
	const clauses = [];
	if (state.missingAdvances.length > 0) {
		const labels = state.missingAdvances
			.map((entry) => characteristicAbbreviation(entry.id))
			.join(", ");
		clauses.push(localize(
			`Remaining characteristic advances: ${labels}.`,
			`Pozostałe rozwinięcia cech: ${labels}.`,
		));
	}
	if (state.missingSkills.length > 0) {
		const labels = state.missingSkills
			.map((entry) => entry.name)
			.filter(Boolean)
			.join(", ");
		clauses.push(localize(
			`Unbought Career Skills: ${labels || state.missingSkills.length}.`,
			`Niewykupione Umiejętności Profesji: ${labels || state.missingSkills.length}.`,
		));
	}

	const prefix = advancedSetting
		? localize(
			"This world requires the current Career to be completed before entering an Advanced Career.",
			"W tym świecie aktualna Profesja musi być ukończona przed przejściem do Profesji Zaawansowanej.",
		)
		: localize(
			"This Career Exit requires the current Career to be completed.",
			"Ta Profesja wyjściowa wymaga ukończenia aktualnej Profesji.",
		);

	return `${prefix} ${clauses.join(" ")}`.trim();
}

function characteristicAbbreviation(id) {
	const localizationId = id === "m" ? "sp" : id;
	const key = `WFRP1ed.CHARAbbrev.${localizationId}`;
	const localized = game.i18n.localize(key);
	return localized === key ? String(id ?? "").toUpperCase() : localized;
}

function normalizeReference(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function readBoolean(value) {
	if (value && typeof value === "object" && Object.hasOwn(value, "value")) {
		return value.value === true;
	}
	return value === true;
}

function readText(value) {
	if (value && typeof value === "object" && Object.hasOwn(value, "value")) {
		return String(value.value ?? "").trim();
	}
	return String(value ?? "").trim();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
