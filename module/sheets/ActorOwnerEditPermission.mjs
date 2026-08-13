const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "allowOwnerManagedEdit";
const LEGACY_WOUNDS_FLAG_KEY = "allowOwnerWoundsEdit";
const LEGACY_ATTACK_FLAG_KEY = "allowOwnerAttackEdit";
const MANAGED_FLAG_KEYS = Object.freeze([
	FLAG_KEY,
	LEGACY_WOUNDS_FLAG_KEY,
	LEGACY_ATTACK_FLAG_KEY,
]);

/**
 * One shared Actor-level permission gate for manually adjudicated sheet values.
 *
 * The GM always retains manual adjudication. A non-GM user must be an explicit
 * OWNER of the Actor and this shared switch must be enabled. The legacy Wounds
 * and Attacks flags are synchronized by the central switch so existing worlds
 * and the already-audited Wounds update guard remain compatible during the
 * migration to one sheet-wide permission.
 */
export class ActorOwnerEditPermission {
	static enabled(actor) {
		if (actor?.documentName !== "Actor") return false;

		const canonical = actor.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (typeof canonical === "boolean") return canonical;

		/* Wounds was the first persistent manual-edit contract; preserve it first. */
		const wounds = actor.getFlag?.(FLAG_SCOPE, LEGACY_WOUNDS_FLAG_KEY);
		if (typeof wounds === "boolean") return wounds;

		return actor.getFlag?.(FLAG_SCOPE, LEGACY_ATTACK_FLAG_KEY) === true;
	}

	static canEdit(actor, user = game.user) {
		if (actor?.documentName !== "Actor" || !user) return false;
		if (user.isGM) return true;
		return this.isExplicitPlayerOwner(actor, user) && this.enabled(actor);
	}

	static isExplicitPlayerOwner(actor, user) {
		if (actor?.documentName !== "Actor" || !user || user.isGM) return false;
		const ownership = actor.ownership ?? actor._source?.ownership ?? {};
		return Number(ownership?.[user.id]) === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	}

	static explicitPlayerOwners(actor) {
		return [...(game.users ?? [])].filter(
			(user) => this.isExplicitPlayerOwner(actor, user),
		);
	}

	static async toggle(actor) {
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only a GM can change owner sheet-edit permission.",
				"Tylko MG może zmienić uprawnienie właściciela do edycji karty.",
			));
		}
		if (actor?.documentName !== "Actor") {
			throw new TypeError("Actor owner-edit permission requires an Actor.");
		}

		const next = !this.enabled(actor);
		const owners = this.explicitPlayerOwners(actor);
		if (next && owners.length === 0) {
			throw new Error(localize(
				`${actor.name} has no explicitly assigned player OWNER. Assign one before enabling owner sheet editing.`,
				`${actor.name} nie ma jawnie przypisanego właściciela-gracza. Przypisz właściciela przed włączeniem edycji karty przez gracza.`,
			));
		}

		await actor.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: next,
			[`flags.${FLAG_SCOPE}.${LEGACY_WOUNDS_FLAG_KEY}`]: next,
			[`flags.${FLAG_SCOPE}.${LEGACY_ATTACK_FLAG_KEY}`]: next,
		});

		const ownerNames = owners
			.map((user) => user.name)
			.filter(Boolean)
			.join(", ");
		ui.notifications.info(
			next
				? localize(
					`Managed sheet editing enabled for: ${ownerNames}.`,
					`Edycja zarządzanych pól karty włączona dla: ${ownerNames}.`,
				)
				: localize(
					`Owner managed-sheet editing disabled for ${actor.name}.`,
					`Edycja zarządzanych pól karty przez właściciela została zablokowana: ${actor.name}.`,
				),
		);
		return next;
	}

	static decorate(application, element) {
		const actor = application?.document;
		if (
			!game.user?.isGM ||
			actor?.documentName !== "Actor" ||
			actor.type !== "character"
		) return;

		const root = element?.matches?.(".wfrp1ed-classic-sheet")
			? element
			: element?.querySelector?.(".wfrp1ed-classic-sheet");
		if (!root) return;

		root.querySelector("[data-wfrp-owner-managed-edit-toggle]")?.remove();

		const enabled = this.enabled(actor);
		const button = document.createElement("button");
		button.type = "button";
		button.classList.add(
			"classic-owner-edit-toggle",
			enabled ? "is-enabled" : "is-locked",
		);
		button.dataset.wfrpOwnerManagedEditToggle = "";
		button.title = enabled
			? localize(
				"Owner editing of managed sheet values is enabled — click to lock it.",
				"Edycja zarządzanych wartości karty przez właściciela jest włączona — kliknij, aby ją zablokować.",
			)
			: localize(
				"Owner editing of managed sheet values is locked — click to allow it.",
				"Edycja zarządzanych wartości karty przez właściciela jest zablokowana — kliknij, aby ją włączyć.",
			);
		button.setAttribute("aria-label", button.title);
		button.setAttribute("aria-pressed", String(enabled));

		const icon = document.createElement("i");
		icon.className = "fa-solid fa-user";
		icon.setAttribute("aria-hidden", "true");
		button.append(icon);

		button.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				await this.toggle(actor);
			} catch (error) {
				console.error(
					"WFRP1ED | Unable to change owner sheet-edit permission.",
					error,
				);
				ui.notifications.warn(error?.message ?? String(error));
			}
		});

		root.append(button);
	}

	static flagChanged(changes) {
		if (!changes || typeof changes !== "object") return false;
		return MANAGED_FLAG_KEYS.some((key) => {
			const path = `flags.${FLAG_SCOPE}.${key}`;
			return Object.hasOwn(changes, path) ||
				foundry.utils.getProperty(changes, path) !== undefined;
		});
	}
}

Hooks.on("renderApplicationV2", (application, element) => {
	ActorOwnerEditPermission.decorate(application, element);
});

Hooks.on("updateActor", (actor, changes) => {
	if (
		!ActorOwnerEditPermission.flagChanged(changes) ||
		!actor?.sheet?.rendered
	) return;
	void actor.sheet.render();
});

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
