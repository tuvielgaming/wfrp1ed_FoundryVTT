import {
	coreSkillSpecialisationId,
	coreSkillSpecialisationLabel,
} from "../core/CoreSkillSpecialisationCatalog.mjs";
import { WEAPON_GROUP } from "../data-models/item/WeaponData.mjs";

const SPECIALIST_RULES_ID = "specialistWeapon";
const CUSTOM_BINDING = "custom";
const UNTRAINED_EFFECTIVE_VALUE = 10;

/**
 * Canonical WFRP 1e Specialist Weapon training resolver.
 *
 * RAW: an Actor without the appropriate Specialist Weapon Skill may still use
 * the weapon, but does so with effective WS 10 (melee) or BS 10 (missile).
 * The GM may additionally call for a Risk test where misuse can hurt the user.
 *
 * English Core: Specialist Weapon, printed pp. 56-57.
 * Polish Core: Specjalna broń, printed p. 54.
 */
export class WeaponSpecialistTraining {
	static resolve(actor, weapon, characteristic) {
		if (weapon?.type !== "weapon" || weapon.system?.group !== WEAPON_GROUP.SPECIALIST) {
			return Object.freeze({ required: false, configured: true, trained: true, modifier: 0 });
		}

		const bindingId = String(weapon.system?.specialistSkillId ?? "").trim();
		const custom = String(weapon.system?.specialistSkillCustom ?? "").trim();
		const configured = Boolean(bindingId && (bindingId !== CUSTOM_BINDING || custom));
		if (!configured) {
			throw new Error(localize(
				`Specialist weapon '${weapon.name}' has no required Specialist Weapon specialisation configured.`,
				`Broń specjalistyczna „${weapon.name}” nie ma skonfigurowanej wymaganej specjalizacji Specjalnej broni.`,
			));
		}

		const requiredLabel = bindingId === CUSTOM_BINDING
			? custom
			: coreSkillSpecialisationLabel(SPECIALIST_RULES_ID, bindingId, game.i18n.lang) || bindingId;
		const trained = [...(actor?.items ?? [])].some((item) => this.#matchesSkill(item, bindingId, custom));
		const base = finiteCharacteristic(actor, characteristic);
		const modifier = trained ? 0 : UNTRAINED_EFFECTIVE_VALUE - base;

		return Object.freeze({
			required: true,
			configured: true,
			trained,
			bindingId,
			requiredLabel,
			effectiveBase: trained ? base : UNTRAINED_EFFECTIVE_VALUE,
			modifier,
		});
	}

	static modifierRow(training) {
		if (!training?.required || training.trained || !training.modifier) return null;
		return Object.freeze({
			id: "specialist-weapon-untrained",
			value: training.modifier,
			source: localize(
				`Untrained Specialist Weapon — ${training.requiredLabel} (effective characteristic 10)`,
				`Brak Specjalnej broni — ${training.requiredLabel} (efektywna cecha 10)`,
			),
			type: "specialist-weapon",
			enabled: true,
		});
	}

	static warnIfUntrained(training) {
		if (!training?.required || training.trained) return;
		ui.notifications.warn(localize(
			`Missing Specialist Weapon (${training.requiredLabel}). RAW effective characteristic: 10.`,
			`Brak Specjalnej broni (${training.requiredLabel}). Zgodnie z zasadami efektywna cecha wynosi 10.`,
		));
	}

	static #matchesSkill(item, bindingId, custom) {
		if (item?.type !== "skill" || String(item.system?.skillId ?? "").trim() !== SPECIALIST_RULES_ID) return false;
		const specialization = String(item.system?.specialisation ?? "").trim();
		if (bindingId === CUSTOM_BINDING) return normalize(specialization) === normalize(custom);
		return coreSkillSpecialisationId(SPECIALIST_RULES_ID, specialization) === bindingId;
	}
}

function finiteCharacteristic(actor, key) {
	const getter = actor?.getCharacteristicValue;
	if (typeof getter === "function") {
		const value = Number(getter.call(actor, key));
		if (Number.isFinite(value)) return value;
	}
	const source = actor?.system?.characteristics?.[key]?.current;
	const raw = source && typeof source === "object" && "value" in source ? source.value : source;
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
