import { DamageApplication } from "../damage/DamageApplication.mjs";
import { synchronizeFatalStatus } from "./FatalCriticalIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const { DialogV2 } = foundry.applications.api;

/**
 * GM correction boundary for an already-applied detailed Critical consequence.
 *
 * Only the latest applied Damage transaction for the target may be rewound. A
 * non-fatal rollback deletes the Critical Wound Item (and therefore its embedded
 * Active Effects); a fatal rollback reverses the explicit defeated application.
 * The resolved Critical ChatMessage is then removed and the Damage transaction's
 * criticalResolution is cleared, returning the source Damage card to the normal
 * "Resolve Detailed Critical" step without touching the already-applied Wounds.
 *
 * Fate intervention is deliberately a later transaction. Once a Fate Point has
 * been spent this action is blocked until a dedicated Fate rollback exists.
 */
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize("Invalidate critical", "Unieważnij trafienie krytyczne"),
		icon: '<i class="fa-solid fa-rotate-left"></i>',
		visible: (target) => canInvalidateCritical(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (message) void invalidateCritical(message);
		},
	});
});

function canInvalidateCritical(message) {
	if (!game.user?.isGM || !message?.id) return false;
	const context = criticalContext(message);
	if (!context) return false;
	if (context.transaction?.state !== "applied" || !context.transaction.criticalResolution) {
		return false;
	}
	if (latestAppliedDamage(context.actor)?.packetId !== context.packetId) return false;

	if (context.isFatal) {
		if (context.fatalApplication?.state !== "applied") return false;
		if (context.fateIntervention) return false;
		return true;
	}

	return Boolean(context.wound);
}

async function invalidateCritical(message) {
	try {
		if (!game.user?.isGM) {
			throw new Error("Only a GM can invalidate an applied critical result.");
		}

		const context = criticalContext(message);
		if (!context) {
			throw new Error("This ChatMessage is not an applied detailed critical result.");
		}
		if (context.transaction?.state !== "applied" || !context.transaction.criticalResolution) {
			throw new Error("The linked damage no longer owns an applied critical resolution.");
		}
		if (latestAppliedDamage(context.actor)?.packetId !== context.packetId) {
			throw new Error(
				"Only a critical belonging to the latest applied damage transaction for this Actor can be invalidated.",
			);
		}
		if (context.fateIntervention) {
			throw new Error(localize(
				"A Fate Point has already been spent for this fatal result. Fate must be rolled back before the critical can be invalidated.",
				"Dla tego śmiertelnego wyniku wydano już Punkt Przeznaczenia. Najpierw trzeba cofnąć Punkt Przeznaczenia, zanim będzie można unieważnić trafienie krytyczne.",
			));
		}
		if (context.isFatal && context.fatalApplication?.state !== "applied") {
			throw new Error("The fatal consequence has not been applied and therefore has nothing to invalidate yet.");
		}
		if (!context.isFatal && !context.wound) {
			throw new Error("The persistent Critical Wound has not been applied yet.");
		}

		const consequence = context.isFatal
			? localize(
				"the defeated/death consequence will be reverted",
				"zostanie cofnięty skutek pokonania/śmierci",
			)
			: localize(
				"the linked Critical Wound and its Active Effects will be removed",
				"powiązana Rana Krytyczna i jej Aktywne Efekty zostaną usunięte",
			);
		const confirmed = await DialogV2.confirm({
			window: {
				title: localize("Invalidate critical", "Unieważnij trafienie krytyczne"),
			},
			content: `<p>${escapeHtml(localize(
				`Invalidate this applied critical result? ${consequence}. Applied Wounds remain unchanged and the source Damage card returns to Resolve Detailed Critical.`,
				`Unieważnić zastosowane trafienie krytyczne? ${consequence}. Zastosowana Żywotność pozostanie bez zmian, a źródłowa karta Obrażeń wróci do etapu Rozstrzygnij szczegółowe trafienie krytyczne.`,
			))}</p>`,
		});
		if (!confirmed) return;

		if (context.wound) {
			await context.wound.delete();
		}

		const applications = applicationMap(
			context.actor,
			DAMAGE_APPLICATIONS_FLAG_KEY,
		);
		const transaction = foundry.utils.deepClone(applications[context.packetId]);
		const history = Array.isArray(transaction.criticalHistory)
			? foundry.utils.deepClone(transaction.criticalHistory)
			: [];
		history.push({
			resolution: foundry.utils.deepClone(transaction.criticalResolution),
			resultMessageId: String(message.id),
			invalidatedAt: Date.now(),
			invalidatedBy: String(game.user?.id ?? ""),
		});
		transaction.criticalHistory = history;
		transaction.criticalResolution = null;
		transaction.criticalInvalidatedAt = Date.now();
		transaction.criticalInvalidatedBy = String(game.user?.id ?? "");
		applications[context.packetId] = transaction;

		const update = {
			[`flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`]: applications,
		};

		if (context.isFatal) {
			const fatalApplications = applicationMap(
				context.actor,
				FATAL_APPLICATIONS_FLAG_KEY,
			);
			fatalApplications[context.packetId] = {
				...foundry.utils.deepClone(context.fatalApplication),
				state: "reverted",
				revertedAt: Date.now(),
				revertedBy: String(game.user?.id ?? ""),
			};
			update[`flags.${FLAG_SCOPE}.${FATAL_APPLICATIONS_FLAG_KEY}`] =
				fatalApplications;
		}

		await context.actor.update(update);

		/*
		 * FatalCriticalIntegration is the single owner of the derived Foundry
		 * defeated/dead status. Reconcile only after both the damage resolution and
		 * fatal application transaction have been atomically rewritten above.
		 */
		if (context.isFatal) {
			await synchronizeFatalStatus(context.actor);
		}

		if (message.canUserModify?.(game.user, "delete")) {
			await message.delete();
		}
		void context.actor.sheet?.render?.({ force: true });
		void ui.chat?.render?.({ force: true });
	} catch (error) {
		console.error("WFRP1ED | Unable to invalidate critical result.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to invalidate the critical result.",
			"Nie udało się unieważnić trafienia krytycznego.",
		));
	}
}

function criticalContext(message) {
	const result = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!result || result.kind !== "detailed") return null;

	const sourceMessage = game.messages?.get(String(result.sourceMessageId ?? ""));
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const actor = actorFromUuidSync(damage?.packet?.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return null;

	const packetId = String(result.packetId ?? damage?.packet?.id ?? "").trim();
	if (!packetId) return null;
	const transaction = DamageApplication.transactionFor(actor, packetId);
	const isFatal = result.resolution?.outcome === KILLED_OUTCOME;
	const wound = [...(actor.items ?? [])].find((item) =>
		item?.type === "criticalWound" &&
		String(item.system?.resolution?.resultMessageId ?? "") === String(message.id),
	) ?? null;
	const fatalApplications = applicationMap(actor, FATAL_APPLICATIONS_FLAG_KEY);
	const fateInterventions = applicationMap(actor, FATE_INTERVENTIONS_FLAG_KEY);

	return {
		message,
		sourceMessage,
		damage,
		actor,
		packetId,
		transaction,
		isFatal,
		wound,
		fatalApplication: fatalApplications[packetId] ?? null,
		fateIntervention: fateInterventions[packetId] ?? null,
	};
}

function latestAppliedDamage(actor) {
	const applications = applicationMap(actor, DAMAGE_APPLICATIONS_FLAG_KEY);
	return Object.entries(applications)
		.map(([packetId, transaction]) => ({
			...foundry.utils.deepClone(transaction),
			packetId: String(transaction?.packetId ?? packetId),
		}))
		.filter((transaction) => transaction.state === "applied")
		.sort((left, right) =>
			(Number(right.appliedAt) - Number(left.appliedAt)) ||
			String(right.id ?? "").localeCompare(String(left.id ?? "")),
		)[0] ?? null;
}

function applicationMap(actor, key) {
	const existing = actor?.getFlag?.(FLAG_SCOPE, key);
	return existing && typeof existing === "object" && !Array.isArray(existing)
		? foundry.utils.deepClone(existing)
		: {};
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const id = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function escapeHtml(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span.innerHTML;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
