export class Wfrp1edItem extends Item {
	/**
	 * Reject duplicate Actor-owned Skills at the batch creation boundary.
	 *
	 * Foundry constructs pending embedded Items with their Actor parent before
	 * this hook runs. Mutating the pending documents array therefore covers
	 * drag/drop, Actor-sheet creation, macros, and other Item creation paths
	 * without depending on Item.actor being available during _preCreate.
	 */
	static async _preCreateOperation(documents, operation, user) {
		const result = await super._preCreateOperation(
			documents,
			operation,
			user,
		);

		if (result === false) {
			return false;
		}

		const acceptedByActor = new Map();

		for (let index = documents.length - 1; index >= 0; index -= 1) {
			const item = documents[index];
			const actor = item?.actor;

			if (item?.type !== "skill" || !actor) {
				continue;
			}

			const identity = skillIdentityFromItem(item);

			if (!identity) {
				continue;
			}

			let accepted = acceptedByActor.get(actor.uuid);

			if (!accepted) {
				accepted = new Set(
					[...(actor.items ?? [])]
						.filter((existing) => existing.type === "skill")
						.map((existing) => skillIdentityKey(
							skillIdentityFromItem(existing),
						))
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

			accepted.add(key);
		}

		return result;
	}

	async _preUpdate(changes, options, user) {
		const result = await super._preUpdate(changes, options, user);

		if (result === false) {
			return false;
		}

		if (
			this.type !== "skill" ||
			!this.actor ||
			!skillIdentityChanged(changes)
		) {
			return result;
		}

		const identity = skillIdentity({
			name: changedValue(changes, "name", this.name),
			rulesId: changedValue(
				changes,
				"system.rulesId",
				this.system?.rulesId,
			),
			specialisation: changedValue(
				changes,
				"system.specialisation",
				this.system?.specialisation,
			),
		});

		if (wouldDuplicateActorSkill(this, identity)) {
			warnDuplicateSkill(identity, this.name);
			return false;
		}

		return result;
	}

	prepareData() {
		super.prepareData();
	}
}

function wouldDuplicateActorSkill(item, identity = skillIdentityFromItem(item)) {
	const actor = item?.actor;

	if (item?.type !== "skill" || !actor || !identity) {
		return false;
	}

	return [...(actor.items ?? [])].some((existing) => {
		if (
			existing.type !== "skill" ||
			existing.id === item.id
		) {
			return false;
		}

		return sameSkillIdentity(
			identity,
			skillIdentityFromItem(existing),
		);
	});
}

function skillIdentityFromItem(item) {
	if (!item) {
		return null;
	}

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

	if (!normalizedRulesId && !normalizedName) {
		return null;
	}

	return Object.freeze({
		kind: normalizedRulesId ? "rules" : "name",
		value: normalizedRulesId || normalizedName,
		specialisation: normalizedSpecialisation,
		displayName: String(name ?? "").trim(),
		displaySpecialisation: String(specialisation ?? "").trim(),
	});
}

function skillIdentityKey(identity) {
	if (!identity) {
		return "";
	}

	return [
		identity.kind,
		identity.value,
		identity.specialisation,
	].join("::");
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
	if (!changes || typeof changes !== "object") {
		return false;
	}

	if (Object.hasOwn(changes, path)) {
		return true;
	}

	return foundry.utils.getProperty(changes, path) !== undefined;
}

function changedValue(changes, path, fallback) {
	if (!changes || typeof changes !== "object") {
		return fallback;
	}

	if (Object.hasOwn(changes, path)) {
		return changes[path];
	}

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

function skillIdentityLabel(identity, fallbackName) {
	const name = identity?.displayName || String(fallbackName ?? "").trim();
	const specialisation = identity?.displaySpecialisation || "";

	return specialisation
		? `${name} (${specialisation})`
		: name;
}
