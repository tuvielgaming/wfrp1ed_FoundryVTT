import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
	normalizeInventoryHand,
} from "../data-models/item/InventoryItemFields.mjs";
import { ArmourEquipValidator } from "../combat/ArmourEquipValidator.mjs";
import { HandEquipValidator } from "../combat/HandEquipValidator.mjs";
import {
	isStackingRepeatableSkill,
	normalizeSkillAcquisitions,
	skillAcquisitionPolicy,
	SKILL_ACQUISITION_POLICY_KIND,
} from "../skills/SkillAcquisitionPolicy.mjs";

export class Wfrp1edItem extends Item {
	/**
	 * Reject accidental duplicate Actor-owned Skills, merge Core stacking
	 * repeated acquisitions into one owned Skill Item, enforce audited limits
	 * for qualified repeatable Skills, and normalize newly embedded physical
	 * Items before they enter an Actor inventory.
	 *
	 * A World/Compendium Item may carry an equipped state which was valid for a
	 * different Actor. Resetting every newly embedded physical Item to Carried
	 * prevents drag/drop from bypassing armour-layer and hand-slot validation.
	 */
	static async _preCreateOperation(documents, operation, user) {
		const result = await super._preCreateOperation(
			documents,
			operation,
			user,
		);
		if (result === false) return false;

		for (const item of documents) {
			if (
				item?.actor &&
				PHYSICAL_ITEM_TYPES.has(item.type)
			) {
				resetPendingPhysicalItemState(item);
			}
		}

		const acceptedByActor = new Map();
		const pendingStackingByActor = new Map();
		const acceptedQualifiedCountsByActor = new Map();

		for (let index = documents.length - 1; index >= 0; index -= 1) {
			const item = documents[index];
			const actor = item?.actor;
			if (item?.type !== "skill" || !actor) continue;

			const identity = skillIdentityFromItem(item);
			if (!identity) continue;

			if (isStackingRepeatableSkill(identityRulesId(identity))) {
				const existing = actorSkillByIdentity(actor, identity);
				const incomingAcquisitions = normalizeSkillAcquisitions(
					item.system?.acquisitions,
				);

				if (existing) {
					await existing.update({
						"system.acquisitions":
							normalizeSkillAcquisitions(existing.system?.acquisitions) +
							incomingAcquisitions,
					});
					documents.splice(index, 1);
					continue;
				}

				let pending = pendingStackingByActor.get(actor.uuid);
				if (!pending) {
					pending = new Map();
					pendingStackingByActor.set(actor.uuid, pending);
				}

				const key = skillIdentityKey(identity);
				const acceptedPending = pending.get(key);
				if (acceptedPending) {
					acceptedPending.updateSource({
						"system.acquisitions":
							normalizeSkillAcquisitions(
								acceptedPending.system?.acquisitions,
							) + incomingAcquisitions,
					});
					documents.splice(index, 1);
					continue;
				}

				pending.set(key, item);
				continue;
			}

			let accepted = acceptedByActor.get(actor.uuid);
			if (!accepted) {
				accepted = new Set(
					[...(actor.items ?? [])]
						.filter((existing) => existing.type === "skill")
						.map((existing) => skillIdentityKey(skillIdentityFromItem(existing)))
						.filter(Boolean),
				);
				acceptedByActor.set(actor.uuid, accepted);
			}

			const key = skillIdentityKey(identity);
			if (accepted.has(key)) {
				documents.splice(index, 1);
				warnDuplicateSkill(identity, item.name);
				continue;
			}

			const policy = skillAcquisitionPolicy(identityRulesId(identity));
			if (policy?.kind === SKILL_ACQUISITION_POLICY_KIND.QUALIFIED) {
				let counts = acceptedQualifiedCountsByActor.get(actor.uuid);
				if (!counts) {
					counts = new Map();
					acceptedQualifiedCountsByActor.set(actor.uuid, counts);
				}

				const rulesId = identityRulesId(identity);
				let acceptedCount = counts.get(rulesId);
				if (acceptedCount === undefined) {
					acceptedCount = actorSkillCountByRulesId(actor, rulesId);
				}

				if (
					policy.maxAcquisitions !== null &&
					acceptedCount >= policy.maxAcquisitions
				) {
					documents.splice(index, 1);
					warnSkillAcquisitionLimit(item.name, policy.maxAcquisitions);
					continue;
				}

				counts.set(rulesId, acceptedCount + 1);
			}

			accepted.add(key);
		}

		return result;
	}

	async _preUpdate(changes, options, user) {
		const result = await super._preUpdate(changes, options, user);
		if (result === false) return false;

		if (
			this.type === "skill" &&
			this.actor &&
			skillIdentityChanged(changes)
		) {
			const identity = skillIdentity({
				name: changedValue(changes, "name", this.name),
				rulesId: changedValue(changes, "system.rulesId", this.system?.rulesId),
				specialisation: changedValue(
					changes,
					"system.specialisation",
					this.system?.specialisation,
				),
			});

			const policy = skillAcquisitionPolicy(identityRulesId(identity));
			if (
				policy?.kind === SKILL_ACQUISITION_POLICY_KIND.QUALIFIED &&
				policy.maxAcquisitions !== null &&
				actorSkillCountByRulesId(
					this.actor,
					identityRulesId(identity),
					this.id,
				) >= policy.maxAcquisitions
			) {
				warnSkillAcquisitionLimit(this.name, policy.maxAcquisitions);
				return false;
			}

			if (wouldDuplicateActorSkill(this, identity)) {
				warnDuplicateSkill(identity, this.name);
				return false;
			}
		}

		if (
			this.actor &&
			PHYSICAL_ITEM_TYPES.has(this.type) &&
			options?.wfrp1edValidatedEquipmentState !== true
		) {
			const equipmentResult = validatePhysicalItemUpdate(this, changes);
			if (equipmentResult === false) return false;
		}

		return result;
	}

	prepareData() {
		super.prepareData();
	}
}

const PHYSICAL_ITEM_TYPES = new Set(["weapon", "armour", "equipment"]);

function resetPendingPhysicalItemState(item) {
	const system = typeof item.system?.toObject === "function"
		? item.system.toObject(true)
		: foundry.utils.deepClone(item.system ?? {});

	system.state = {
		...(system.state ?? {}),
		mode: INVENTORY_MODE.CARRIED,
		hand: INVENTORY_HAND.NONE,
	};

	item.updateSource({ system });
}

function validatePhysicalItemUpdate(item, changes) {
	const currentMode = String(item.system?.state?.mode ?? INVENTORY_MODE.CARRIED);
	const proposedMode = String(changedValue(
		changes,
		"system.state.mode",
		currentMode,
	));

	if (
		currentMode !== INVENTORY_MODE.CARRIED &&
		wouldChangeUsedLoadoutDefinition(item, changes)
	) {
		ui.notifications.warn(
			game.i18n.lang === "pl"
				? "Najpierw oznacz przedmiot jako przenoszony, zanim zmienisz dane wpływające na sposób jego używania."
				: "Mark the Item as carried before changing data which defines how it is equipped.",
		);
		return false;
	}

	if (proposedMode === INVENTORY_MODE.CARRIED) return true;

	if (proposedMode === INVENTORY_MODE.WORN) {
		if (
			item.type !== "armour" ||
			item.system?.armourClass === ARMOUR_CLASS.SHIELD
		) {
			warnInvalidEquipmentState();
			return false;
		}

		const validation = ArmourEquipValidator.validate(item.actor, item);
		if (!validation.valid) {
			warnValidation(validation);
			return false;
		}
		return true;
	}

	if (proposedMode === INVENTORY_MODE.HELD) {
		if (
			item.type === "armour" &&
			item.system?.armourClass !== ARMOUR_CLASS.SHIELD
		) {
			warnInvalidEquipmentState();
			return false;
		}

		let proposedHand = normalizeInventoryHand(changedValue(
			changes,
			"system.state.hand",
			item.system?.state?.hand,
		));
		const allowed = HandEquipValidator.allowedHands(item);
		if (!allowed.includes(proposedHand)) {
			proposedHand = HandEquipValidator.defaultHand(item);
			foundry.utils.setProperty(changes, "system.state.hand", proposedHand);
		}

		const validation = HandEquipValidator.validate(item.actor, item, proposedHand);
		if (!validation.valid) {
			warnValidation(validation);
			return false;
		}
		return true;
	}

	warnInvalidEquipmentState();
	return false;
}

function wouldChangeUsedLoadoutDefinition(item, changes) {
	if (item.type === "weapon") {
		return String(changedValue(
			changes,
			"system.handedness",
			item.system?.handedness,
		)) !== String(item.system?.handedness ?? "");
	}

	if (item.type === "armour") {
		if (
			String(changedValue(
				changes,
				"system.armourClass",
				item.system?.armourClass,
			)) !== String(item.system?.armourClass ?? "")
		) return true;

		if (
			String(changedValue(
				changes,
				"system.piece",
				item.system?.piece,
			)) !== String(item.system?.piece ?? "")
		) return true;

		return ARMOUR_LOCATIONS.some((location) => {
			const current = item.system?.coverage?.[location] === true;
			const proposed = Boolean(changedValue(
				changes,
				`system.coverage.${location}`,
				current,
			));
			return proposed !== current;
		});
	}

	return false;
}

function warnValidation(validation) {
	const first = validation?.conflicts?.[0];
	ui.notifications.warn(
		first?.message || (
			game.i18n.lang === "pl"
				? "Nie można użyć przedmiotu w tej konfiguracji."
				: "The Item cannot be equipped in that configuration."
		),
	);
}

function warnInvalidEquipmentState() {
	ui.notifications.warn(
		game.i18n.lang === "pl"
			? "Ten stan wyposażenia nie jest prawidłowy dla tego typu przedmiotu."
			: "That equipment state is not valid for this Item type.",
	);
}

function actorSkillByIdentity(actor, identity) {
	return [...(actor?.items ?? [])].find((existing) => {
		if (existing.type !== "skill") return false;
		return sameSkillIdentity(identity, skillIdentityFromItem(existing));
	}) ?? null;
}

function actorSkillCountByRulesId(actor, rulesId, excludedItemId = "") {
	const normalizedRulesId = normalizeIdentityText(rulesId);
	if (!normalizedRulesId) return 0;
	return [...(actor?.items ?? [])].filter((existing) => {
		if (
			existing.type !== "skill" ||
			String(existing.id ?? "") === String(excludedItemId ?? "")
		) return false;
		return identityRulesId(skillIdentityFromItem(existing)) === normalizedRulesId;
	}).length;
}

function wouldDuplicateActorSkill(item, identity = skillIdentityFromItem(item)) {
	const actor = item?.actor;
	if (item?.type !== "skill" || !actor || !identity) return false;

	return [...(actor.items ?? [])].some((existing) => {
		if (existing.type !== "skill" || existing.id === item.id) return false;
		return sameSkillIdentity(identity, skillIdentityFromItem(existing));
	});
}

function skillIdentityFromItem(item) {
	if (!item) return null;
	return skillIdentity({
		name: item.name,
		rulesId: item.system?.rulesId,
		specialisation: item.system?.specialisation,
	});
}

function skillIdentity({ name, rulesId, specialisation }) {
	const normalizedRulesId = normalizeIdentityText(rulesId);
	const normalizedName = normalizeIdentityText(name);
	const normalizedSpecialisation = normalizeIdentityText(specialisation);
	if (!normalizedRulesId && !normalizedName) return null;

	return Object.freeze({
		kind: normalizedRulesId ? "rules" : "name",
		value: normalizedRulesId || normalizedName,
		specialisation: normalizedSpecialisation,
		displayName: String(name ?? "").trim(),
		displaySpecialisation: String(specialisation ?? "").trim(),
	});
}

function identityRulesId(identity) {
	return identity?.kind === "rules" ? identity.value : "";
}

function skillIdentityKey(identity) {
	if (!identity) return "";
	return [identity.kind, identity.value, identity.specialisation].join("::");
}

function sameSkillIdentity(first, second) {
	return Boolean(
		first &&
		second &&
		skillIdentityKey(first) === skillIdentityKey(second),
	);
}

function skillIdentityChanged(changes) {
	return (
		Object.hasOwn(changes ?? {}, "name") ||
		hasChangedPath(changes, "system.rulesId") ||
		hasChangedPath(changes, "system.specialisation")
	);
}

function hasChangedPath(changes, path) {
	if (!changes || typeof changes !== "object") return false;
	if (Object.hasOwn(changes, path)) return true;
	return foundry.utils.getProperty(changes, path) !== undefined;
}

function changedValue(changes, path, fallback) {
	if (!changes || typeof changes !== "object") return fallback;
	if (Object.hasOwn(changes, path)) return changes[path];
	const nested = foundry.utils.getProperty(changes, path);
	return nested === undefined ? fallback : nested;
}

function normalizeIdentityText(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function warnDuplicateSkill(identity, fallbackName) {
	const label = skillIdentityLabel(identity, fallbackName);
	const message = game.i18n.lang === "pl"
		? `Postać posiada już Umiejętność „${label}”. Duplikat nie został dodany.`
		: `This Actor already has the Skill “${label}”. The duplicate was not added.`;
	ui.notifications.warn(message);
}

function warnSkillAcquisitionLimit(name, limit) {
	const label = String(name ?? "").trim();
	const message = game.i18n.lang === "pl"
		? `Umiejętność „${label}” można nabyć najwyżej ${limit} razy.`
		: `The Skill “${label}” can be acquired at most ${limit} times.`;
	ui.notifications.warn(message);
}

function skillIdentityLabel(identity, fallbackName) {
	const name = identity?.displayName || String(fallbackName ?? "").trim();
	const specialisation = identity?.displaySpecialisation || "";
	return specialisation ? `${name} (${specialisation})` : name;
}
