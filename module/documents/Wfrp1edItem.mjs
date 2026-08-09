export class Wfrp1edItem extends Item {
	async _preCreate(data, options, user) {
		const result = await super._preCreate(data, options, user);

		if (result === false) {
			return false;
		}

		if (this.#wouldDuplicateActorSkill()) {
			this.#warnDuplicateSkill();
			return false;
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

		if (this.#wouldDuplicateActorSkill(identity)) {
			this.#warnDuplicateSkill(identity);
			return false;
		}

		return result;
	}

	prepareData() {
		super.prepareData();
	}

	#wouldDuplicateActorSkill(identity = skillIdentityFromItem(this)) {
		const actor = this.actor;

		if (this.type !== "skill" || !actor || !identity) {
			return false;
		}

		return [...(actor.items ?? [])].some((item) => {
			if (
				item.type !== "skill" ||
				item.id === this.id
			) {
				return false;
			}

			return sameSkillIdentity(
				identity,
				skillIdentityFromItem(item),
			);
		});
	}

	#warnDuplicateSkill(identity = skillIdentityFromItem(this)) {
		const label = skillIdentityLabel(identity, this.name);
		const message = game.i18n.lang === "pl"
			? `Postać posiada już Umiejętność „${label}”. Duplikat nie został dodany.`
			: `This Actor already has the Skill “${label}”. The duplicate was not added.`;

		ui.notifications.warn(message);
	}
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

function sameSkillIdentity(first, second) {
	if (!first || !second) {
		return false;
	}

	return (
		first.kind === second.kind &&
		first.value === second.value &&
		first.specialisation === second.specialisation
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
		.toLocaleLowerCase(game.i18n.lang || undefined);
}

function skillIdentityLabel(identity, fallbackName) {
	const name = identity?.displayName || String(fallbackName ?? "").trim();
	const specialisation = identity?.displaySpecialisation || "";

	return specialisation
		? `${name} (${specialisation})`
		: name;
}
