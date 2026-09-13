import { CareerProgression } from "../careers/CareerProgression.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { ExperienceTransactionService } from "../experience/ExperienceTransactionService.mjs";

const { DialogV2 } = foundry.applications.api;
const CAREER_TRANSFER_KIND = "career-transfer";

const originalTransferCareer = CareerProgression.transferCareer;

CareerProgression.transferCareer = async function transactionAwareCareerTransfer(
	sheet,
	targetCareer,
	options = {},
) {
	const actor = sheet?.document ?? sheet;
	const current = CareerProgression.activeCareer(actor);
	if (!current) return originalTransferCareer.call(this, sheet, targetCareer, options);

	const prepared = await ExperienceTransactionService.prepareCareerTransfer(actor, {
		fromCareerItemId: current.id,
		targetCareerUuid: targetCareer?.uuid,
		targetCareerName: targetCareer?.name,
	});

	let result;
	try {
		result = await originalTransferCareer.call(this, sheet, targetCareer, options);
	} catch (error) {
		await ExperienceTransactionService.cancelPreparedEvent(actor, prepared.id).catch(() => {});
		throw error;
	}

	if (!result) {
		await ExperienceTransactionService.cancelPreparedEvent(actor, prepared.id);
		return null;
	}

	try {
		const selected = result.career;
		const existedBefore = prepared.careerItemIdsBefore?.includes?.(String(selected?.id ?? "")) === true;
		await ExperienceTransactionService.markCareerTransferApplied(actor, prepared.id, {
			toCareerItemId: selected?.id,
			toCareerUuid: selected?.uuid,
			cost: result.cost,
			policy: result.policy,
			spentAfter: result.spentAfter,
			createdCareer: !existedBefore,
		});
		void actor.sheet?.render?.();
		return Object.freeze({
			...result,
			experienceEventId: prepared.id,
		});
	} catch (error) {
		/* Finalization failure leaves the Actor in an ambiguous partially-applied
		 * progression state. Roll back the whole still-open sheet transaction,
		 * matching the database-integrity policy used for crash recovery. */
		await ExperienceTransactionService.rollbackOpen(
			actor,
			null,
			"career-transfer-finalization-failed",
		).catch(() => {});
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

	wireCareerTransferUndo(application, element);
});

function wireCareerTransferUndo(sheet, element) {
	const preview = ExperienceTransactionService.careerTransferUndoPreview(sheet.document);
	if (!preview?.event) return;
	const activeCareer = CareerProgression.activeCareer(sheet.document);
	if (!activeCareer || String(activeCareer.id) !== String(preview.event.toCareerItemId ?? "")) return;

	const input = element.querySelector(".header-field--current-career input");
	if (!(input instanceof HTMLInputElement)) return;
	input.title = localize(
		"Changed in the current Experience transaction. Shift + click to undo this Career change.",
		"Zmieniono w bieżącej transakcji PD. Shift + kliknięcie cofa tę zmianę Profesji.",
	);
	input.addEventListener("click", (event) => {
		if (!event.shiftKey) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		void undoCareerTransfer(sheet);
	}, { capture: true });
}

async function undoCareerTransfer(sheet) {
	try {
		if (sheet.isEditable !== true) {
			throw new Error(localize(
				"You do not have permission to undo this Career change.",
				"Nie masz uprawnień do cofnięcia tej zmiany Profesji.",
			));
		}

		const preview = ExperienceTransactionService.careerTransferUndoPreview(sheet.document);
		if (!preview?.event) {
			throw new Error(localize(
				"The current Career was not purchased in this Experience transaction.",
				"Aktualna Profesja nie została wykupiona w tej transakcji Punktów Doświadczenia.",
			));
		}

		if (preview.dependentCount > 0) {
			const confirmed = await DialogV2.confirm({
				window: { title: localize("Undo Career change", "Cofnij zmianę Profesji") },
				content: `<p>${escapeHtml(localize(
					`Undoing this Career change will also undo ${preview.dependentCount} later purchase${preview.dependentCount === 1 ? "" : "s"} from the current transaction and restore ${preview.refund} Experience Points. Continue?`,
					`Cofnięcie tej zmiany Profesji cofnie również ${preview.dependentCount} późniejsze zakupy z bieżącej transakcji i zwróci ${preview.refund} Punktów Doświadczenia. Kontynuować?`,
				))}</p>`,
				rejectClose: false,
				modal: true,
			});
			if (!confirmed) return;
		}

		const event = await ExperienceTransactionService.undoCareerTransfer(sheet.document);
		ui.notifications.info(localize(
			`Career change undone. Experience was restored to ${event.spentBefore} spent points for that transaction point.`,
			`Cofnięto zmianę Profesji. Przywrócono stan wydanych PD sprzed tej zmiany.`,
		));
		void sheet.render?.();
	} catch (error) {
		console.error("WFRP1ED | Unable to undo Career change.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to undo the Career change.",
			"Nie udało się cofnąć zmiany Profesji.",
		));
	}
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
