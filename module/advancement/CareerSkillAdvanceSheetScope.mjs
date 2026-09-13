import { CareerProgression } from "../careers/CareerProgression.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { ExperienceTransactionService } from "../experience/ExperienceTransactionService.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CAREER_GRANT_FLAG = "careerGrant";
const LEGACY_TRANSACTION_FLAG = "careerProgressionTransaction";
const CAREER_SKILL_KIND = "career-skill";

const originalPurchaseSkill = CareerProgression.purchaseSkill;

CareerProgression.purchaseSkill = async function transactionAwareCareerSkillPurchase(
	actor,
	offerKey,
) {
	const offer = CareerProgression.skillOffer(actor, offerKey);
	if (!offer) {
		/* Keep CareerProgression's existing validation and localized error as the
		 * authority when the derived offer disappeared between render and click. */
		return originalPurchaseSkill.call(this, actor, offerKey);
	}

	const spentBefore = nonNegativeInteger(actor.system?.experience?.spent);
	const prepared = await ExperienceTransactionService.prepareCareerSkill(actor, {
		careerItemId: offer.careerId,
		careerUuid: offer.careerUuid,
		offerKey,
		skillIdentity: offer.identity,
		sourceUuid: offer.sourceUuid,
		cost: offer.cost,
		spentBefore,
		spentAfter: spentBefore + nonNegativeInteger(offer.cost),
	});
	const previousLegacy = actor.getFlag?.(FLAG_SCOPE, LEGACY_TRANSACTION_FLAG) ?? null;

	let result;
	try {
		result = await originalPurchaseSkill.call(this, actor, offerKey);
	} catch (error) {
		await ExperienceTransactionService.cancelPreparedEvent(actor, prepared.id).catch(() => {});
		throw error;
	}

	const skill = result?.skill;
	try {
		if (!skill?.id) {
			throw new Error("Career Skill purchase did not return the created Skill Item.");
		}

		const grant = skill.getFlag?.(FLAG_SCOPE, CAREER_GRANT_FLAG);
		await skill.setFlag(FLAG_SCOPE, CAREER_GRANT_FLAG, {
			...(grant && typeof grant === "object" ? grant : {}),
			experienceEventId: prepared.id,
		});

		await ExperienceTransactionService.markCareerSkillApplied(actor, prepared.id, {
			skillItemId: skill.id,
			skillUuid: skill.uuid,
		});
		return Object.freeze({
			...result,
			experienceEventId: prepared.id,
		});
	} catch (error) {
		/* Do not leave a paid Skill outside the durable transaction if finalizing
		 * its event fails. This compensates only the purchase currently in flight;
		 * older events in the same open sheet transaction remain untouched. */
		if (skill?.id && actor.items?.has?.(skill.id)) {
			await actor.deleteEmbeddedDocuments("Item", [skill.id]).catch(() => {});
		}
		await actor.update({
			"system.experience.spent": spentBefore,
			[`flags.${FLAG_SCOPE}.${LEGACY_TRANSACTION_FLAG}`]: previousLegacy,
		}).catch(() => {});
		await ExperienceTransactionService.cancelPreparedEvent(actor, prepared.id).catch(() => {});
		throw error;
	}
};

Hooks.on("renderApplicationV2", (application, element) => {
	if (!(application instanceof ClassicActorSheet)) return;
	const actor = application.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!(element instanceof HTMLElement) ||
		!element.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	wireRefundableCareerSkills(application, element);
});

function wireRefundableCareerSkills(sheet, element) {
	const events = ExperienceTransactionService.activeEvents(sheet.document, CAREER_SKILL_KIND);
	if (!events.length) return;
	const refundableIds = new Set(
		events.map((event) => String(event.skillItemId ?? "")).filter(Boolean),
	);

	for (const row of element.querySelectorAll(".skill-row[data-item-id]")) {
		const itemId = String(row.dataset.itemId ?? "");
		if (!refundableIds.has(itemId)) continue;

		const target = row.querySelector('[data-action="openSkill"]') ?? row;
		target.title = localize(
			"Shift + click to undo this Career Skill purchase and refund 100 Experience Points.",
			"Shift + kliknięcie cofa zakup tej Umiejętności Profesji i zwraca 100 Punktów Doświadczenia.",
		);
		target.addEventListener("click", (event) => {
			if (!event.shiftKey) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void refundCareerSkill(sheet, itemId);
		}, { capture: true });
	}
}

async function refundCareerSkill(sheet, itemId) {
	try {
		if (sheet.isEditable !== true) {
			throw new Error(localize(
				"You do not have permission to refund this Skill.",
				"Nie masz uprawnień do zwrotu tej Umiejętności.",
			));
		}
		const event = await ExperienceTransactionService.undoCareerSkill(sheet.document, itemId);
		ui.notifications.info(localize(
			`Undid the Career Skill purchase and refunded ${event.cost} Experience Points.`,
			`Cofnięto zakup Umiejętności Profesji i zwrócono ${event.cost} Punktów Doświadczenia.`,
		));
		void sheet.render?.();
	} catch (error) {
		console.error("WFRP1ED | Unable to refund Career Skill purchase.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to refund the Career Skill purchase.",
			"Nie udało się cofnąć zakupu Umiejętności Profesji.",
		));
	}
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
