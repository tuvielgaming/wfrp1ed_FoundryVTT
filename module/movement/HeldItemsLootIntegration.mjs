import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import { LootPileService } from "../loot/LootPileService.mjs";
import { HeldItemsCheck } from "./HeldItemsCheck.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "heldItemsCheck";
const CONSEQUENCE_KIND = "drop-held-items";
const CONSEQUENCE_STATE = Object.freeze({
	APPLIED: "applied",
	NO_ITEMS: "no-items",
});

/*
 * Complete the physical consequence of the Core Jump/Fall held-items check.
 *
 * HeldItemsCheck owns the d100 and its Luck semantics. LootPileService already
 * owns authoritative Item moves, GM socket routing, and ground-pile chat. This
 * integration only connects the two existing contracts:
 *
 *   d100 <= 50 -> every physical Item currently in HELD state is moved to one
 *   Loot Pile.
 *
 * Once a physical move has happened the roll is finalized. Rewriting the d100
 * afterward without first rolling the Item transfer back would split the rules
 * state from the world state, so Luck options are hidden for an applied physical
 * drop. A failed check with no held physical Items remains adjustable because no
 * external consequence occurred.
 */
installHeldItemsLootIntegration();

function installHeldItemsLootIntegration() {
	if (HeldItemsCheck.__wfrpLootIntegrationInstalled === true) return;

	const originalPublish = HeldItemsCheck.publish;
	const originalLuckOptions = HeldItemsCheck.luckOptions;

	HeldItemsCheck.publish = async function heldItemsPublishWithLoot(options = {}) {
		const message = await originalPublish.call(this, options);
		const state = this.stateFor(message);

		if (state?.outcome !== "drop") {
			return message;
		}

		const actor = options?.actor;
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("Held-items Loot consequence requires its source Actor.");
		}

		/* Keep the dependent world mutation behind the visible d100 animation. */
		if (
			message?.id &&
			game.dice3d?.waitFor3DAnimationByMessageID
		) {
			await game.dice3d.waitFor3DAnimationByMessageID(message.id);
		}

		const heldItems = [...(actor.items ?? [])].filter((item) =>
			LootPileService.isPhysicalItem(item) &&
			String(item.system?.state?.mode ?? "") === INVENTORY_MODE.HELD,
		);

		let lootResult = null;
		try {
			if (heldItems.length > 0) {
				lootResult = await LootPileService.createFromActorItems({
					sourceActor: actor,
					items: heldItems,
					reason: "held-items-check",
					sourceLabel: actor.name,
				});
			}
		} catch (error) {
			/* The d100 and the physical consequence are one interaction. Remove the
			 * orphan result when the move failed so the source Jump/Fall can safely
			 * offer the held-items action again instead of leaving a false UPUSZCZA
			 * result with no items on the ground. */
			if (message?.canUserModify?.(game.user, "delete") === true) {
				await message.delete().catch(() => {});
			}
			throw error;
		}

		const updated = foundry.utils.deepClone(state);
		updated.consequence = {
			kind: CONSEQUENCE_KIND,
			state: lootResult?.pileUuid
				? CONSEQUENCE_STATE.APPLIED
				: CONSEQUENCE_STATE.NO_ITEMS,
			pileUuid: String(lootResult?.pileUuid ?? ""),
			moved: Number(lootResult?.moved ?? 0),
			appliedAt: lootResult?.pileUuid ? Date.now() : null,
		};
		updated.updatedAt = Date.now();

		await message.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});
		return message;
	};

	HeldItemsCheck.luckOptions = function heldItemsLuckAfterPhysicalConsequence(message) {
		const state = this.stateFor(message);
		if (
			state?.consequence?.kind === CONSEQUENCE_KIND &&
			state?.consequence?.state === CONSEQUENCE_STATE.APPLIED
		) {
			return [];
		}
		return originalLuckOptions.call(this, message);
	};

	Object.defineProperty(
		HeldItemsCheck,
		"__wfrpLootIntegrationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}
