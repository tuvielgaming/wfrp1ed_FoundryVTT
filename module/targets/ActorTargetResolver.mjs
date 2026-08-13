const { DialogV2 } = foundry.applications.api;

/**
 * Shared Foundry-facing Actor target resolution used by combat actions and,
 * progressively, other target-dependent workflows.
 *
 * Mechanics do not belong here. This service only answers which Actor the
 * current user targeted, lets a GM choose a world Actor, and resolves standard
 * Foundry Actor/Token drag data.
 */
export class ActorTargetResolver {
	static singleTargetActor() {
		const targets = [...(game.user?.targets ?? [])];
		if (targets.length !== 1) return null;
		return targets[0].actor ?? null;
	}

	static async chooseActor() {
		const actors = [...(game.actors?.contents ?? [])]
			.filter((actor) => actor?.system?.characteristics)
			.sort((first, second) =>
				String(first.name ?? "").localeCompare(
					String(second.name ?? ""),
					game.i18n.lang,
					{ sensitivity: "base" },
				),
			);

		if (actors.length === 0) {
			ui.notifications.warn(localize(
				"No world Actors with characteristics are available.",
				"Brak dostępnych Aktorów z charakterystyką.",
			));
			return null;
		}

		const content = document.createElement("div");
		const group = document.createElement("div");
		group.classList.add("form-group");
		const label = document.createElement("label");
		label.textContent = localize("Target Actor", "Aktor celu");
		const select = document.createElement("select");
		select.name = "actorId";
		select.autofocus = true;

		for (const actor of actors) {
			const option = document.createElement("option");
			option.value = actor.id;
			option.textContent = actor.name;
			select.append(option);
		}

		group.append(label, select);
		content.append(group);

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-pending-target-dialog",
			],
			window: {
				title: localize("Choose target", "Wybierz cel"),
			},
			content,
			buttons: [
				{
					action: "choose",
					label: localize("Choose", "Wybierz"),
					default: true,
					callback: (_event, button) => ({
						actorId: String(
							button.form?.elements?.actorId?.value ?? "",
						).trim(),
					}),
				},
				{
					action: "cancel",
					label: localize("Cancel", "Anuluj"),
					callback: () => null,
				},
			],
			rejectClose: false,
		});

		if (!response?.actorId) return null;
		return game.actors.get(response.actorId) ?? null;
	}

	static async actorFromDropEvent(event) {
		const textEditor =
			foundry.applications?.ux?.TextEditor ??
			globalThis.TextEditor;

		if (typeof textEditor?.getDragEventData !== "function") {
			throw new Error("Foundry TextEditor drag-data API is unavailable.");
		}

		return this.actorFromDropData(
			textEditor.getDragEventData(event),
		);
	}

	static async actorFromDropData(data) {
		if (!data || typeof data !== "object") return null;

		if (data.uuid) {
			const document = await this.fromUuid(data.uuid);
			const actor = this.actorFromDocument(document);
			if (actor) return actor;
		}

		if (data.type === "Actor" && data.id) {
			return game.actors?.get(data.id) ?? null;
		}

		if (data.actorId) {
			return game.actors?.get(data.actorId) ?? null;
		}

		return null;
	}

	static actorFromDocument(document) {
		if (!document) return null;
		if (document.documentName === "Actor") return document;
		if (document.actor?.documentName === "Actor") return document.actor;
		return null;
	}

	static async fromUuid(uuid) {
		if (typeof globalThis.fromUuid !== "function") {
			throw new Error("Foundry fromUuid API is unavailable.");
		}
		return globalThis.fromUuid(uuid);
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
