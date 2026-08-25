import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";

export const PERIODIC_DIRECT_DAMAGE_TARGET_ID =
	"damage.periodic.direct";

/**
 * Capture periodic direct-damage rules from the exact Item snapshots which
 * participated in one attack. The returned records are JSON-safe delivery
 * instructions; later edits to the source Item cannot rewrite the hit.
 */
export class PeriodicDirectDamageRule {
	static collect(sources = []) {
		if (!Array.isArray(sources)) {
			throw new Error("Periodic damage rule sources must be an array.");
		}

		const deliveries = [];
		for (const descriptor of sources) {
			const kind = String(descriptor?.kind ?? "").trim();
			const source = descriptor?.source;
			if (!kind || !source || typeof source !== "object") continue;
			const effects = Array.isArray(source.effects) ? source.effects : [];

			for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
				const effect = effects[effectIndex];
				if (!effect || effect.disabled === true) continue;
				const changes = ruleChanges(effect);

				for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
					const change = changes[changeIndex];
					const decoded = decodeRuleEffectChange(change);
					if (
						decoded?.targetId !== PERIODIC_DIRECT_DAMAGE_TARGET_ID ||
						decoded.operation !== RULE_EFFECT_OPERATIONS.ADD ||
						decoded.applicability !== RULE_EFFECT_APPLICABILITY.AUTOMATIC ||
						decoded.side !== RULE_EFFECT_SIDES.TARGET
					) {
						continue;
					}

					const sourceUuid = String(source.uuid ?? "");
					const effectId = String(
						effect._id ?? effect.id ?? `effect-${effectIndex}`,
					);
					deliveries.push({
						version: 1,
						id: [kind, sourceUuid, effectId, changeIndex].join("|"),
						sourceKind: kind,
						sourceUuid,
						sourceName: String(source.name ?? kind),
						effectId,
						effectName: String(effect.name ?? "Active Effect"),
						effectImg: String(effect.img ?? source.img ?? "icons/svg/fire.svg"),
						changeIndex,
						formula: String(decoded.formula ?? "").trim(),
						stacking: String(decoded.stacking ?? "once"),
						condition: String(decoded.condition ?? ""),
						duration: durationSnapshot(effect.duration),
						change: foundry.utils.deepClone(change),
					});
				}
			}
		}

		return foundry.utils.deepFreeze(
			foundry.utils.deepClone(deliveries),
		);
	}
}

function ruleChanges(effect) {
	const flagged = effect?.flags?.wfrp1ed?.ruleChanges;
	if (Array.isArray(flagged) && flagged.length > 0) {
		return foundry.utils.deepClone(flagged);
	}
	if (Array.isArray(effect?.changes) && effect.changes.length > 0) {
		return foundry.utils.deepClone(effect.changes);
	}
	if (Array.isArray(effect?.system?.changes)) {
		return foundry.utils.deepClone(effect.system.changes);
	}
	return [];
}

function durationSnapshot(duration) {
	const source = duration && typeof duration === "object" ? duration : {};
	return {
		value: positiveNumber(
			source.value ??
			source.rounds ??
			source.seconds ??
			source.turns,
		),
		units: String(
			source.units ??
			(source.rounds ? "rounds" : source.seconds ? "seconds" : source.turns ? "turns" : ""),
		),
	};
}

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}
