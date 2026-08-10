import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";
import { SuddenDeathResolver } from "./SuddenDeathResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const AUTHORIZED_DAMAGE_APPLICATION_OPTION =
	"wfrp1edAuthorizedDamageApplication";

/**
 * Bridge applied damage transactions into the critical subsystem.
 *
 * The Actor-side damage transaction remains authoritative. This matters when a
 * target OWNER applies damage from a GM-authored ChatMessage they cannot edit.
 * Critical results are therefore persisted back into that same transaction and
 * projected onto chat client-side.
 */
export function registerCriticalDamageIntegration() {
	Hooks.on(
		"updateActor",
		(actor, changes, options, userId) => {
			refreshActorCriticalCards(actor);

			if (
				userId === game.user?.id &&
				options?.[AUTHORIZED_DAMAGE_APPLICATION_OPTION] === true
			) {
				void resolveFreshDamageCritical(actor, changes, userId);
			}
		},
	);

	Hooks.on(
		"renderChatMessageHTML",
		(message, html) => applyCriticalClientState(message, html),
	);

	Hooks.on(
		"getChatMessageContextOptions",
		(_application, menuItems) => addCriticalContextOptions(menuItems),
	);
}

export async function resolveDamageMessageCritical(message) {
	const state = damageState(message);

	if (!state) {
		throw new Error(
			"This ChatMessage does not contain WFRP damage data.",
		);
	}

	const actor = await foundry.utils.fromUuid(
		String(state.packet?.targetActorUuid ?? ""),
	);

	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The damage target Actor is not available.");
	}

	const transaction = DamageApplication.transactionFor(
		actor,
		state.packet?.id,
	);

	return resolveTransaction(actor, transaction);
}

async function resolveFreshDamageCritical(actor, changes, userId) {
	try {
		if (!(actor instanceof foundry.documents.Actor)) return;

		const applications = changedApplications(changes);
		if (!applications) return;

		const candidates = Object.values(applications)
			.filter((transaction) =>
				transaction?.state === "applied" &&
				Number(transaction.criticalValue) > 0 &&
				transaction.criticalMode === DAMAGE_CRITICAL_MODE.SUDDEN_DEATH &&
				!transaction.criticalResolution &&
				String(transaction.userId ?? "") === String(userId ?? ""),
			)
			.sort((left, right) =>
				Number(right.appliedAt ?? 0) - Number(left.appliedAt ?? 0),
			);

		const transaction = candidates[0];
		if (!transaction) return;

		await resolveTransaction(actor, transaction);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to resolve Sudden Death critical after damage application.",
			error,
		);
		ui.notifications.warn(
			localize(
				"WFRP1ED.Critical.ResolveFailed",
				"Damage was applied, but the critical result could not be resolved. Right-click the message to retry.",
				"Obrażenia zastosowano, ale nie udało się rozstrzygnąć trafienia krytycznego. Kliknij wiadomość prawym przyciskiem, aby spróbować ponownie.",
			),
		);
	}
}

async function resolveTransaction(actor, transaction) {
	if (!transaction || transaction.state !== "applied") {
		throw new Error(
			"Critical resolution requires an applied damage transaction.",
		);
	}

	if (!DamageApplication.canApply(actor, game.user)) {
		throw new Error(
			"You do not have permission to resolve this critical result.",
		);
	}

	const criticalValue = Number(transaction.criticalValue);

	if (!Number.isInteger(criticalValue) || criticalValue <= 0) {
		throw new Error("This damage transaction has no critical overflow.");
	}

	if (transaction.criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH) {
		throw new Error(
			"This critical does not use the Sudden Death resolver.",
		);
	}

	if (transaction.criticalResolution) {
		return transaction.criticalResolution;
	}

	const resolution = await SuddenDeathResolver.resolve(criticalValue);
	const updated = await DamageApplication.recordCriticalResolution({
		actor,
		packetId: transaction.packetId,
		criticalResolution: resolution,
	});

	ui.notifications.info(
		criticalOutcomeLabel(resolution) ||
			localize(
				"WFRP1ED.Critical.Resolved",
				`Sudden Death critical +${criticalValue} resolved.`,
				`Rozstrzygnięto trafienie Nagłej Śmierci +${criticalValue}.`,
			),
	);

	return updated.criticalResolution;
}

function addCriticalContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize(
			"WFRP1ED.Critical.Resolve",
			"Resolve Critical",
			"Rozstrzygnij trafienie krytyczne",
		),
		icon: '<i class="fa-solid fa-skull"></i>',
		visible: (target) => canResolveMessageCritical(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (!message) return;

			void resolveDamageMessageCritical(message).catch((error) => {
				console.error(
					"WFRP1ED | Unable to resolve critical from ChatMessage.",
					error,
				);
				ui.notifications.error(
					error?.message ?? localize(
						"WFRP1ED.Critical.ResolveFailedShort",
						"Unable to resolve critical result.",
						"Nie można rozstrzygnąć trafienia krytycznego.",
					),
				);
			});
		},
	});
}

function canResolveMessageCritical(message, user = game.user) {
	const state = damageState(message);
	if (!state) return false;

	const actor = actorFromStateSync(state);
	if (!(actor instanceof foundry.documents.Actor)) return false;

	const transaction = DamageApplication.transactionFor(
		actor,
		state.packet?.id,
	);

	return Boolean(
		transaction?.state === "applied" &&
		Number(transaction.criticalValue) > 0 &&
		transaction.criticalMode === DAMAGE_CRITICAL_MODE.SUDDEN_DEATH &&
		!transaction.criticalResolution &&
		DamageApplication.canApply(actor, user)
	);
}

function applyCriticalClientState(message, html) {
	const state = damageState(message);
	const root = asElement(html);

	if (!state || !root) return;

	const host =
		root.querySelector?.(".wfrp1e-test-card, .wfrp1e-damage-card") ??
		(root.matches?.(".wfrp1e-test-card, .wfrp1e-damage-card") ? root : null);

	if (!host) return;

	host.querySelector?.("[data-wfrp-critical-result]")?.remove();

	const actor = actorFromStateSync(state);
	const transaction = actor instanceof foundry.documents.Actor
		? DamageApplication.transactionFor(actor, state.packet?.id)
		: state.application ?? null;

	if (
		!transaction ||
		Number(transaction.criticalValue) <= 0 ||
		transaction.criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH
	) {
		return;
	}

	host.append(buildCriticalPanel(transaction));
}

function buildCriticalPanel(transaction) {
	const criticalValue = Number(transaction.criticalValue);
	const resolution = transaction.criticalResolution ?? null;
	const panel = document.createElement("section");
	panel.className = "wfrp1e-critical-result";
	panel.dataset.wfrpCriticalResult = "";

	if (resolution?.outcome) {
		panel.classList.add(`is-${resolution.outcome}`);
	}

	const header = document.createElement("div");
	header.className = "wfrp1e-critical-result__header";

	const title = document.createElement("strong");
	title.textContent = `${localize(
		"WFRP1ED.Critical.SuddenDeath",
		"Sudden Death",
		"Nagła Śmierć",
	)} +${criticalValue}`;
	header.append(title);
	panel.append(header);

	if (!resolution) {
		const pending = document.createElement("div");
		pending.className = "wfrp1e-critical-result__pending";
		pending.textContent = localize(
			"WFRP1ED.Critical.Pending",
			"Awaiting critical roll. Right-click to resolve.",
			"Oczekuje na rzut krytyczny. Kliknij prawym przyciskiem, aby rozstrzygnąć.",
		);
		panel.append(pending);
		return panel;
	}

	const meta = document.createElement("div");
	meta.className = "wfrp1e-critical-result__meta";
	meta.textContent = `${localize(
		"WFRP1ED.Critical.Table",
		"Table",
		"Tabela",
	)} +${resolution.variant} · ${localize(
		"WFRP1ED.Critical.Roll",
		"d100",
		"K100",
	)}: ${resolution.roll?.total ?? "—"}`;
	panel.append(meta);

	const outcome = document.createElement("div");
	outcome.className = "wfrp1e-critical-result__outcome";
	outcome.textContent = criticalOutcomeLabel(resolution) ||
		resolution.results
			?.map((result) => String(result?.text ?? "").trim())
			.filter(Boolean)
			.join(" · ") ||
		localize(
			"WFRP1ED.Critical.CustomResult",
			"Custom table result",
			"Wynik tabeli własnej",
		);
	panel.append(outcome);

	return panel;
}

function criticalOutcomeLabel(resolution) {
	switch (resolution?.outcome) {
		case "killed":
			return localize(
				"WFRP1ED.Critical.Killed",
				"Killed",
				"Śmierć",
			);

		case "no-effect":
			return localize(
				"WFRP1ED.Critical.NoEffect",
				"No Effect",
				"Bez efektu",
			);

		default:
			return "";
	}
}

function refreshActorCriticalCards(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const state = damageState(message);
		if (state?.packet?.targetActorUuid !== actor.uuid) continue;

		const entry = document.querySelector(
			`[data-message-id="${message.id}"]`,
		);
		if (entry) applyCriticalClientState(message, entry);
	}
}

function changedApplications(changes) {
	if (!changes || typeof changes !== "object") return null;

	const dotted = changes[
		`flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`
	];
	const nested = changes.flags?.[FLAG_SCOPE]?.[DAMAGE_APPLICATIONS_FLAG_KEY];
	const value = dotted ?? nested;

	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: null;
}

function damageState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorFromStateSync(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.packet?.targetActorUuid ?? ""),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();

	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}
