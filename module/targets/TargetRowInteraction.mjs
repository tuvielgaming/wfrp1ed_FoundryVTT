import { ActorTargetResolver } from "./ActorTargetResolver.mjs";

/**
 * Reusable dialog-row interaction for target-aware adjudication UIs.
 *
 * The target snapshot deliberately keeps Actor and Token identity separate:
 * - Actor UUID lets a GM/owner inspect the authoritative Actor sheet;
 * - Token UUID identifies one exact Scene representation for temporary hover
 *   highlighting. World Actors which were selected without a Scene token still
 *   open normally and simply have nothing to highlight.
 */
export class TargetRowInteraction {
	static bind(element, target = {}) {
		if (!(element instanceof HTMLElement)) return;

		const actorUuid = String(target.actorUuid ?? target.actor?.uuid ?? "").trim();
		const tokenUuid = String(target.tokenUuid ?? target.token?.document?.uuid ?? "").trim();
		const identity = element.querySelector?.("[data-wfrp-target-identity]") ?? element;
		if (!(identity instanceof HTMLElement)) return;

		if (actorUuid) element.dataset.wfrpTargetActorUuid = actorUuid;
		if (tokenUuid) element.dataset.wfrpTargetTokenUuid = tokenUuid;

		identity.title = localize(
			"Hover to highlight the Scene token. Double-click to open the Actor sheet.",
			"Najedź, aby podświetlić token na Scenie. Kliknij dwukrotnie, aby otworzyć kartę Aktora.",
		);

		identity.addEventListener("mouseenter", () => setTokenHover(tokenUuid, true));
		identity.addEventListener("mouseleave", () => setTokenHover(tokenUuid, false));
		identity.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openActorSheet(actorUuid);
		});
	}
}

function openActorSheet(actorUuid) {
	const actor = ActorTargetResolver.actorFromUuidSync(actorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return;
	actor.sheet?.render?.({ force: true });
}

function setTokenHover(tokenUuid, hovered) {
	const token = tokenPlaceable(tokenUuid);
	if (!token) return;

	try {
		token.hover = hovered === true;
		if (typeof token.renderFlags?.set === "function") {
			token.renderFlags.set({ refreshState: true });
		} else if (typeof token.refresh === "function") {
			token.refresh();
		}
	} catch (_error) {
		/* Hover feedback is optional presentation and must never block a rule dialog. */
	}
}

function tokenPlaceable(tokenUuid) {
	const uuid = String(tokenUuid ?? "").trim();
	if (!uuid) return null;

	try {
		const document = foundry.utils.fromUuidSync(uuid);
		if (document?.documentName === "Token") return document.object ?? null;
		if (document?.object?.document?.documentName === "Token") return document.object;
	} catch (_error) {
		return null;
	}
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
