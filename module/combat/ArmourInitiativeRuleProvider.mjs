import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import {
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { ArmourEquipValidator } from "./ArmourEquipValidator.mjs";

const TARGET_PATTERN = /^test\.(?:characteristic|standard)\.([^.]+)\.target$/;
const LEG_LOCATIONS = new Set(["rightLeg", "leftLeg"]);
const ARM_LOCATIONS = new Set(["rightArm", "leftArm"]);

/**
 * Virtual contextual rule candidates for the two GM-optional Core p.121
 * Initiative penalties caused by legal armour layering.
 *
 * ArmourEquipValidator remains the single source of truth for which armour
 * combinations produce the optional penalty. The Core gives one optional -10 I
 * condition for the leg combination and another for the arm combination, but
 * does not explicitly state whether those two penalties stack when both are
 * present. They are therefore exposed as two independent unchecked choices.
 */
export class ArmourInitiativeRuleProvider {
	static candidates({ actor, targetId }) {
		if (!actor || !usesActorInitiative(targetId)) {
			return Object.freeze([]);
		}

		return Object.freeze(
			initiativePenaltyConditions(actor).map((condition) => Object.freeze({
				id: `virtual:armour-initiative:${actor.uuid}:${condition.id}`,
				targetId,
				target: null,
				operation: RULE_EFFECT_OPERATIONS.SUBTRACT,
				formula: "10",
				applicability: RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
				side: RULE_EFFECT_SIDES.SELF,
				stacking: "once",
				condition: condition.tooltip,
				priority: 50,
				defaultSelected: false,
				actorUuid: actor.uuid,
				effectUuid: null,
				effectName: condition.effectName,
				itemUuid: null,
				itemName: condition.itemNames.join(" + "),
				itemType: "armour",
			})),
		);
	}
}

function usesActorInitiative(targetId) {
	const match = TARGET_PATTERN.exec(String(targetId ?? "").trim());
	if (!match) return false;

	const test = game.WFRP1ED?.tests?.manager?.get?.(match[1]);
	if (!test) return false;

	if (String(test.characteristic ?? "") === "i") {
		return true;
	}

	const formula = String(test.formula ?? "");
	return /(^|[^A-Za-z0-9_.])i(?=$|[^A-Za-z0-9_.])/.test(formula);
}

function initiativePenaltyConditions(actor) {
	const worn = [...(actor.items ?? [])].filter((item) =>
		item?.type === "armour" &&
		item.system?.state?.mode === INVENTORY_MODE.WORN,
	);
	const buckets = new Map();

	for (const candidate of worn) {
		const validation = ArmourEquipValidator.validate(actor, candidate);

		for (const warning of validation.warnings ?? []) {
			const category = penaltyCategory(warning.location);
			if (!category) continue;

			let bucket = buckets.get(category);
			if (!bucket) {
				bucket = new Map();
				buckets.set(category, bucket);
			}

			bucket.set(
				String(candidate.uuid ?? candidate.id ?? candidate.name),
				String(candidate.name ?? ""),
			);
			if (warning.existingItemName) {
				bucket.set(
					String(warning.existingItemUuid ?? warning.existingItemName),
					String(warning.existingItemName),
				);
			}
		}
	}

	const result = [];

	for (const category of ["legs", "arms"]) {
		const items = buckets.get(category);
		if (!items?.size) continue;

		const label = category === "legs"
			? localize("Armour layering (legs)", "Warstwy pancerza (nogi)")
			: localize("Armour layering (arms)", "Warstwy pancerza (ramiona)");
		const ambiguity = localize(
			"Core p.121 makes this -10 Initiative penalty optional for the GM. The Core does not explicitly state whether the separate arm and leg penalties stack.",
			"Zasady podstawowe, s. 121, pozostawiają ten modyfikator -10 do Inicjatywy decyzji MG. Podręcznik nie rozstrzyga wprost, czy osobne kary za ramiona i nogi kumulują się.",
		);

		result.push(Object.freeze({
			id: category,
			effectName: label,
			itemNames: Object.freeze([...items.values()].filter(Boolean)),
			tooltip: ambiguity,
		}));
	}

	return Object.freeze(result);
}

function penaltyCategory(location) {
	if (LEG_LOCATIONS.has(location)) return "legs";
	if (ARM_LOCATIONS.has(location)) return "arms";
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
