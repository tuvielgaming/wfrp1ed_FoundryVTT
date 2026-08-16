import { consequenceSystemSource } from "../criticals/CriticalConsequenceDefinition.mjs";
import { coreCriticalConsequence } from "../criticals/CoreCriticalConsequences.mjs";
import {
	CORE_DETAILED_EFFECT_PROVIDERS,
	DETAILED_CRITICAL_OUTCOME,
	detailedCriticalEffectOutcome,
	detailedCriticalEffectText,
	detailedCriticalLocationLabel,
} from "../criticals/CoreDetailedCriticalTables.mjs";
import {
	CRITICAL_TABLE_ROLE,
	CRITICAL_TABLE_VARIANT,
} from "../criticals/CriticalTableRegistry.mjs";

const CORE_CATALOG_VERSION = 2;
const LOCATION_ROLES = Object.freeze({
	arm: CRITICAL_TABLE_ROLE.DETAILED_ARM,
	head: CRITICAL_TABLE_ROLE.DETAILED_HEAD,
	body: CRITICAL_TABLE_ROLE.DETAILED_BODY,
	leg: CRITICAL_TABLE_ROLE.DETAILED_LEG,
});
const LOCATIONS = Object.freeze(["arm", "head", "body", "leg"]);

/**
 * Build the 64 Core detailed Critical Wound templates.
 *
 * The Compendium no longer embeds bespoke per-result ActiveEffects. Every Core
 * wound stores the same declarative `system.consequence` data available to a
 * user-created Critical Wound. When the Item is placed on an Actor, the generic
 * CriticalConsequenceEngine materializes any timed/periodic/characteristic/loot
 * runtime state from that declaration.
 */
export function coreCriticalWoundItemSources(language = "en") {
	const lang = normalizeLanguage(language);
	const results = [];

	for (const location of LOCATIONS) {
		const role = LOCATION_ROLES[location];
		const provider = CORE_DETAILED_EFFECT_PROVIDERS[role];
		if (!provider?.id) throw new Error(`Missing Core detailed provider for '${location}'.`);

		for (let effectNumber = 1; effectNumber <= 16; effectNumber += 1) {
			const description = detailedCriticalEffectText(location, effectNumber, lang);
			const outcome = detailedCriticalEffectOutcome(location, effectNumber);
			const consequence = coreCriticalConsequence(location, effectNumber);
			const automation = outcome === DETAILED_CRITICAL_OUTCOME.KILLED
				? "fatal-transaction"
				: consequence
					? "declarative-consequence"
					: "pending-consumer";

			results.push(Object.freeze({
				name: criticalName(location, effectNumber, lang),
				type: "criticalWound",
				img: "icons/svg/blood.svg",
				system: {
					description,
					criticalValue: 0,
					hitLocation: location,
					consequence: consequenceSystemSource(
						consequence ? { enabled: true, ...consequence } : { enabled: false },
					),
					resolution: {
						damagePacketId: "",
						sourceMessageId: "",
						resultMessageId: "",
						tableRole: role,
						tableVariant: CRITICAL_TABLE_VARIANT.DEFAULT,
						providerId: provider.id,
						tableUuid: "",
						tableResultId: "",
						effectNumber,
						roll: 0,
						resolvedByUserId: "",
						resolvedAt: 0,
					},
				},
				effects: [],
				flags: {
					wfrp1ed: {
						coreCatalog: {
							version: CORE_CATALOG_VERSION,
							kind: "criticalWound",
							location,
							effectNumber,
							outcome: outcome ?? "",
							automation,
							source: {
								english: "Core Combat, Critical Effects, pp. 122-124",
								polish: "Core Walka, Efekty trafień krytycznych, pp. 122-124",
							},
						},
					},
				},
			}));
		}
	}

	return Object.freeze(results);
}

function criticalName(location, effectNumber, language) {
	const label = detailedCriticalLocationLabel(location, language);
	return language === "pl"
		? `${label} #${effectNumber} — Rana krytyczna`
		: `${label} #${effectNumber} — Critical Wound`;
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl") ? "pl" : "en";
}
