import { CriticalWoundApplication } from "./CriticalWoundApplication.mjs";
import {
	detailedCriticalEffectText,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const CORE_PROVIDER_PREFIX = "wfrp1ed.core.detailed.";

/*
 * The Core Rulebook's detailed Critical Effect tables were written to be read
 * vertically on the printed page. Some Leg results therefore say "see 3 above"
 * instead of repeating the complete knockdown consequence, and several results
 * say that later criticals use the Sudden Death chart "below".
 *
 * That shorthand is poor chat-card / persistent-Item presentation: a player may
 * only see the single resolved result. Keep CoreDetailedCriticalTables.mjs as
 * the verbatim audited transcription, but expand those references at the UI and
 * persistent-wound boundary so every resolved Critical Wound is self-contained.
 */
installCriticalWoundCreationExpansion();

Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateDetailedCriticalDescription(message, html);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void migrateExistingCoreCriticalWoundDescriptions().catch((error) => {
		console.error(
			"WFRP1ED | Unable to expand existing detailed Critical Wound descriptions.",
			error,
		);
	});
});

function installCriticalWoundCreationExpansion() {
	if (CriticalWoundApplication.__wfrpReferenceExpansionInstalled === true) return;

	const originalCreate = CriticalWoundApplication.create;
	CriticalWoundApplication.create = async function expandedCriticalWoundCreate(input = {}) {
		const expanded = expandWoundCreateInput(input);
		return originalCreate.call(this, expanded);
	};

	Object.defineProperty(
		CriticalWoundApplication,
		"__wfrpReferenceExpansionInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function expandWoundCreateInput(input) {
	const source = input && typeof input === "object"
		? { ...input }
		: {};
	const resolution = source.resolution?.toObject?.() ?? source.resolution ?? {};
	if (!isCoreDetailedEffectProvider(resolution.providerId)) return source;

	const location = genericLocation(source.hitLocation);
	const effectNumber = positiveInteger(resolution.effectNumber);
	if (!location || !effectNumber) return source;

	const language = canonicalLanguageForDescription(
		String(source.description ?? ""),
		location,
		effectNumber,
	) ?? presentationLanguage();
	const expanded = expandedCoreEffectText(location, effectNumber, language);
	if (!expanded) return source;

	source.description = expanded;
	return source;
}

function decorateDetailedCriticalDescription(message, html) {
	const state = criticalResultState(message);
	const resolution = state?.resolution;
	if (!resolution || !isCoreDetailedEffectProvider(resolution.effect?.providerId)) {
		return;
	}

	const location = String(resolution.effectLocation ?? "").trim();
	const effectNumber = positiveInteger(resolution.effectNumber);
	if (!location || !effectNumber) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	const effect = card?.querySelector?.("[data-wfrp-detailed-effect]");
	if (!(effect instanceof HTMLElement)) return;

	const expanded = expandedCoreEffectText(
		location,
		effectNumber,
		presentationLanguage(),
	);
	if (!expanded) return;

	effect.textContent = expanded;
	effect.dataset.wfrpDetailedReferenceExpanded = "";
}

async function migrateExistingCoreCriticalWoundDescriptions() {
	for (const actor of game.actors ?? []) {
		for (const wound of actor.items ?? []) {
			if (wound?.type !== "criticalWound") continue;

			const resolution = wound.system?.resolution?.toObject?.() ??
				wound.system?.resolution ?? {};
			if (!isCoreDetailedEffectProvider(resolution.providerId)) continue;

			const location = genericLocation(wound.system?.hitLocation);
			const effectNumber = positiveInteger(resolution.effectNumber);
			if (!location || !effectNumber) continue;

			const current = String(wound.system?.description ?? "").trim();
			const language = canonicalLanguageForDescription(
				current,
				location,
				effectNumber,
			);

			/* Do not overwrite a GM/player-authored description. Existing generated
			 * Core wounds are migrated only while their stored text still matches the
			 * canonical Core source (or an older expansion produced by this module). */
			if (!language) continue;

			const expanded = expandedCoreEffectText(location, effectNumber, language);
			if (!expanded || expanded === current) continue;
			await wound.update({ "system.description": expanded });
		}
	}
}

function expandedCoreEffectText(location, effectNumber, language) {
	const lang = normalizeLanguage(language);
	const localized = detailedCriticalEffectText(location, effectNumber, lang);
	const english = detailedCriticalEffectText(location, effectNumber, "en");
	if (!localized) return "";

	let result = String(localized).trim();

	if (english.includes("(see 3 above)")) {
		result = expandLegEffectThreeReference(result, lang);
	}

	if (english.includes("Sudden Death Critical Chart below")) {
		result = makeSuddenDeathRoutingSelfContained(result, lang);
	}

	return result.trim();
}

function expandLegEffectThreeReference(text, language) {
	const expansion = language === "pl"
		? " — Skutek powalenia: jeżeli przeciwnik nie wykona udanego testu Zręczności, wstrząs wytrąca mu z rąk wszystkie przedmioty. Przez następne K4 rundy usiłuje się podnieść i może jedynie parować, ale tylko jeśli nadal trzyma broń lub tarczę"
		: " — Knockdown consequence: any hand-held object is jarred loose unless the opponent passes a Dexterity test. For the next D4 rounds while getting back upright, the opponent may only parry, and only if still in possession of a weapon or shield";

	const referencePattern = language === "pl"
		? /\s*\(patrz\s+punkt\s+3\s+wyżej\)/iu
		: /\s*\(see\s+3\s+above\)/iu;

	if (referencePattern.test(text)) {
		return text.replace(referencePattern, expansion);
	}

	/* The English audited source is authoritative. If a localization ever drops
	 * the printed cross-reference entirely, still expose the required mechanics. */
	return `${text}${expansion}.`;
}

function makeSuddenDeathRoutingSelfContained(text, language) {
	if (language === "pl") {
		const normalized = text
			.replace(
				/\s*Wszystkie\s+następne\s+rzuty\s+krytyczne\s+wykonuj\s+(?:według|wg\.)\s+Tabeli\s+nagłej\s+śmierci\.?/giu,
				"",
			)
			.replace(
				/\s*Wszystkie\s+rzuty\s+krytyczne\s+wykonuj\s+(?:według|wg\.)\s+Tabeli\s+nagłej\s+śmierci\.?/giu,
				"",
			)
			.trim();
		return `${stripTrailingSentencePunctuation(normalized)}. Wszystkie dalsze trafienia krytyczne rozstrzygaj według Tabeli nagłej śmierci.`;
	}

	const normalized = text
		.replace(
			/\s*Roll\s+any\s+further\s+criticals\s+on\s+the\s+Sudden\s+Death\s+Critical\s+Chart\s+below\.?/giu,
			"",
		)
		.replace(
			/\s*Roll\s+all\s+criticals\s+on\s+the\s+Sudden\s+Death\s+Critical\s+Chart\s+below\.?/giu,
			"",
		)
		.trim();
	return `${stripTrailingSentencePunctuation(normalized)}. Resolve all further Critical Hits using the Sudden Death Critical Chart.`;
}

function canonicalLanguageForDescription(description, location, effectNumber) {
	const current = String(description ?? "").trim();
	if (!current) return null;

	for (const language of ["pl", "en"]) {
		const raw = String(
			detailedCriticalEffectText(location, effectNumber, language) ?? "",
		).trim();
		const expanded = expandedCoreEffectText(location, effectNumber, language);
		if (current === raw || current === expanded) return language;
	}
	return null;
}

function criticalResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function genericLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "leftArm":
		case "rightArm":
		case "arm": return "arm";
		case "leftLeg":
		case "rightLeg":
		case "leg": return "leg";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function stripTrailingSentencePunctuation(value) {
	return String(value ?? "").trim().replace(/[.!?]+$/u, "");
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeLanguage(language) {
	return String(language ?? "").toLowerCase() === "pl" ? "pl" : "en";
}

function presentationLanguage() {
	return normalizeLanguage(game.i18n.lang);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}
