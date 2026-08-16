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

const CORE_CATALOG_VERSION = 1;
const LOCATION_ROLES = Object.freeze({
	arm: CRITICAL_TABLE_ROLE.DETAILED_ARM,
	head: CRITICAL_TABLE_ROLE.DETAILED_HEAD,
	body: CRITICAL_TABLE_ROLE.DETAILED_BODY,
	leg: CRITICAL_TABLE_ROLE.DETAILED_LEG,
});
const LOCATIONS = Object.freeze(["arm", "head", "body", "leg"]);

/*
 * Persistent characteristic consequences already owned by the audited runtime
 * effect engine. Other Critical Effects frequently require round durations,
 * prone/unconscious state, bleeding, held-item loss, limb-use restrictions,
 * medical-treatment state, or fatal/Fate transactions. Those are intentionally
 * not represented by inert/fake ActiveEffects in the Core compendium.
 */
const CHARACTERISTIC_EFFECTS = Object.freeze({
	leg: Object.freeze({
		5: halfMovementAndInitiative(),
		6: halfMovementAndInitiative(),
		7: halfMovementAndInitiative(),
	}),
});

/** Build the 64 canonical detailed Critical Effect Item templates. */
export function coreCriticalWoundItemSources(language = "en") {
	const lang = normalizeLanguage(language);
	const results = [];

	for (const location of LOCATIONS) {
		const role = LOCATION_ROLES[location];
		const provider = CORE_DETAILED_EFFECT_PROVIDERS[role];
		if (!provider?.id) {
			throw new Error(`Missing Core detailed provider for '${location}'.`);
		}

		for (let effectNumber = 1; effectNumber <= 16; effectNumber += 1) {
			const description = detailedCriticalEffectText(
				location,
				effectNumber,
				lang,
			);
			const outcome = detailedCriticalEffectOutcome(location, effectNumber);
			const characteristicEffects =
				CHARACTERISTIC_EFFECTS[location]?.[effectNumber] ?? null;
			const automation = outcome === DETAILED_CRITICAL_OUTCOME.KILLED
				? "fatal-transaction"
				: characteristicEffects
					? "active-effect"
					: "pending-consumer";

			results.push(Object.freeze({
				name: criticalName(location, effectNumber, lang),
				type: "criticalWound",
				img: "icons/svg/blood.svg",
				system: {
					description,
					criticalValue: 0,
					hitLocation: location,
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
				effects: characteristicEffects
					? [characteristicActiveEffectSource(
						location,
						effectNumber,
						characteristicEffects,
						lang,
					)]
					: [],
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

export function coreCriticalCharacteristicEffects(location, effectNumber) {
	const normalized = String(location ?? "").trim();
	const number = Number(effectNumber);
	const effects = CHARACTERISTIC_EFFECTS[normalized]?.[number] ?? null;
	return effects
		? Object.freeze(effects.map((entry) => Object.freeze({ ...entry })))
		: Object.freeze([]);
}

function characteristicActiveEffectSource(location, effectNumber, effects, language) {
	const condition = language === "pl"
		? "Do czasu otrzymania pomocy medycznej"
		: "Until medical attention is received";
	const changes = effects.map((entry) => ruleChange({
		targetId: `characteristic.${entry.characteristicId}.current`,
		operation: entry.operation,
		formula: String(entry.value),
		condition,
	}));

	return {
		name: language === "pl"
			? "Rana krytyczna — Szybkość i Inicjatywa o połowę"
			: "Critical Wound — Movement and Initiative halved",
		img: "icons/svg/blood.svg",
		disabled: false,
		transfer: true,
		changes: structuredCloneSafe(changes),
		system: { changes: structuredCloneSafe(changes) },
		flags: {
			wfrp1ed: {
				ruleChanges: structuredCloneSafe(changes),
				/*
				 * Compendium templates use generic Arm/Leg locations rather than a
				 * combat hit side. Keep this separate from coreCriticalConsequence so
				 * the side-specific runtime repair does not replace/delete the embedded
				 * transfer effect when a GM manually drags the template to an Actor.
				 */
				coreCatalogEffect: {
					version: CORE_CATALOG_VERSION,
					location,
					effectNumber,
					durationKind: "until-medical-attention",
				},
			},
		},
	};
}

function ruleChange({ targetId, operation, formula, condition }) {
	return {
		type: "wfrp1edRule",
		key: targetId,
		value: JSON.stringify({
			version: 1,
			operation,
			formula,
			applicability: "automatic",
			side: "self",
			stacking: "per-acquisition",
			condition,
		}),
		phase: "final",
		priority: 50,
	};
}

function halfMovementAndInitiative() {
	return Object.freeze([
		Object.freeze({
			characteristicId: "m",
			operation: "multiply",
			value: 0.5,
		}),
		Object.freeze({
			characteristicId: "i",
			operation: "multiply",
			value: 0.5,
		}),
	]);
}

function criticalName(location, effectNumber, language) {
	const label = detailedCriticalLocationLabel(location, language);
	return language === "pl"
		? `Rana krytyczna — ${label} ${effectNumber}`
		: `Critical Wound — ${label} ${effectNumber}`;
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl")
		? "pl"
		: "en";
}

function structuredCloneSafe(value) {
	return JSON.parse(JSON.stringify(value));
}
