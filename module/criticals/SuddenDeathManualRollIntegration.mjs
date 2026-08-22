import { DamageApplication } from "../damage/DamageApplication.mjs";
import { SuddenDeathResolver } from "./SuddenDeathResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const RESULT_TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/critical-result.hbs";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "sudden-death-roll-edit-request";
const RESPONSE_TYPE = "sudden-death-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/*
 * Physical-dice support for the WFRP 1e Sudden Death d100.
 *
 * CriticalDamageIntegration remains the owner of initial resolution and the
 * native Foundry Roll attached to the result ChatMessage. This layer changes
 * only the post-roll adjudicated total:
 * - the GM or the same player who is allowed to resolve the source critical may
 *   enter a physical d100 result;
 * - a player edit is committed by the primary active GM because the authoritative
 *   criticalResolution lives on the target Actor damage transaction;
 * - the original Foundry total remains untouched in ChatMessage.rolls and is
 *   also copied to `originalRoll` on the result snapshot for audit;
 * - the Sudden Death table is resolved again from the fixed entered total, not
 *   rerolled;
 * - once a fatal outcome has actually been applied, or Fate has been spent for
 *   this result, the d100 is immutable until that later world-state consequence
 *   is explicitly rolled back through its own lifecycle.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	installSuddenDeathRollEditor(message, html);
});

Hooks.once("ready", () => {
	registerSocket();
});

function installSuddenDeathRollEditor(message, html) {
	const context = suddenDeathContext(message);
	if (!context) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-critical-card]");
	if (!(card instanceof HTMLElement)) return;
	if (card.hasAttribute("data-wfrp-detailed-critical-card")) return;

	const host = card.querySelector(".wfrp1e-critical-result__meta");
	if (!(host instanceof HTMLElement)) return;

	host.textContent = "";
	host.classList.add("wfrp1e-critical-result__roll-editor");

	const label = document.createElement("span");
	label.className = "wfrp1e-critical-result__roll-label";
	label.textContent = localize("d100", "K100");

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "100";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(context.resolution?.roll?.total ?? "");
	input.dataset.wfrpSuddenDeathRollInput = "";
	input.className = "wfrp1e-critical-result__roll-input";

	host.append(label, input);

	const lockReason = editLockReason(context);
	if (lockReason || !canEdit(context, game.user)) {
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.add("is-readonly");
		input.title = lockReason || localize(
			"Only the GM or the player who resolved this critical may replace its d100 result.",
			"Tylko MG albo gracz, który rozstrzygnął to trafienie krytyczne, może zmienić jego wynik K100.",
		);
		return;
	}

	input.classList.add("is-editable");
	input.title = localize(
		"Enter the physical d100 result (1-100), then press Enter or leave the field. The Sudden Death table result is recalculated without rerolling.",
		"Wprowadź wynik fizycznego K100 (1-100), a następnie naciśnij Enter lub opuść pole. Wynik tabeli Nagłej Śmierci zostanie przeliczony bez ponownego rzutu.",
	);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
	input.addEventListener("change", () => {
		void setSuddenDeathRoll(message, input);
	});
}

async function setSuddenDeathRoll(message, input) {
	try {
		const context = suddenDeathContext(message);
		if (!context) {
			throw new Error(localize(
				"This ChatMessage has no active Sudden Death result.",
				"Ta wiadomość nie zawiera aktywnego wyniku Nagłej Śmierci.",
			));
		}
		if (!canEdit(context, game.user)) {
			throw new Error(editLockReason(context) || localize(
				"You may not change this Sudden Death d100 result.",
				"Nie możesz zmienić tego wyniku K100 Nagłej Śmierci.",
			));
		}

		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (
			!raw ||
			!Number.isInteger(requested) ||
			requested < 1 ||
			requested > 100
		) {
			throw new Error(localize(
				"Enter a whole d100 result from 1 to 100.",
				"Wprowadź całkowity wynik K100 od 1 do 100.",
			));
		}

		if (Number(context.resolution?.roll?.total) === requested) return;

		input.disabled = true;
		if (game.user?.isGM) {
			await commitSuddenDeathRoll(message, requested, game.user);
			return;
		}
		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit Sudden Death d100.", error);
		const current = suddenDeathContext(message);
		if (input) input.value = String(current?.resolution?.roll?.total ?? "");
		ui.notifications.error(error?.message ?? localize(
			"Unable to change the Sudden Death d100 result.",
			"Nie można zmienić wyniku K100 Nagłej Śmierci.",
		));
	} finally {
		if (input?.isConnected) input.disabled = false;
	}
}

async function commitSuddenDeathRoll(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Sudden Death roll edits require GM authority.");
	}

	const context = suddenDeathContext(message);
	if (!context) {
		throw new Error("This ChatMessage has no Sudden Death result.");
	}
	if (!canEdit(context, requestingUser)) {
		throw new Error(editLockReason(context) ||
			"The requesting user may not change this Sudden Death result.");
	}

	const total = Number(value);
	if (!Number.isInteger(total) || total < 1 || total > 100) {
		throw new Error("Sudden Death d100 must be a whole value from 1 to 100.");
	}

	const resolution = await SuddenDeathResolver.resolve(
		Number(context.transaction.criticalValue),
		{
			/* Fixed adjudicated value: this is not another random roll. */
			roll: {
				formula: "1d100",
				total,
			},
		},
	);

	await DamageApplication.replaceCriticalResolution({
		actor: context.actor,
		packetId: context.packetId,
		criticalResolution: resolution,
		user: game.user,
	});

	const updated = foundry.utils.deepClone(context.result);
	const originalRoll = normalizedOriginalRoll(context.result);
	updated.version = Math.max(2, Number(updated.version) || 0);
	updated.originalRoll = originalRoll;
	updated.rollEdited = total !== originalRoll;
	updated.rollEditedBy = updated.rollEdited
		? String(requestingUser?.id ?? "")
		: "";
	updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
	updated.resolution = foundry.utils.deepClone(resolution);
	updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
	updated.updatedAt = Date.now();

	const content = await foundry.applications.handlebars.renderTemplate(
		RESULT_TEMPLATE_PATH,
		resultTemplateContext(resolution),
	);
	await message.update({
		content,
		[`flags.${FLAG_SCOPE}.${CRITICAL_RESULT_FLAG_KEY}`]: updated,
	});

	return Object.freeze({
		messageId: String(message.id ?? ""),
		roll: total,
		originalRoll,
		rollEdited: updated.rollEdited,
		outcome: String(resolution?.outcome ?? ""),
	});
}

function suddenDeathContext(message) {
	const result = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!isRecord(result) || result.kind === "detailed" || !result.resolution) {
		return null;
	}

	const sourceMessage = game.messages?.get(String(result.sourceMessageId ?? ""));
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const actor = actorFromUuidSync(damage?.packet?.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return null;

	const packetId = String(result.packetId ?? damage?.packet?.id ?? "").trim();
	if (!packetId) return null;

	return {
		message,
		result,
		resolution: result.resolution,
		sourceMessage,
		damage,
		actor,
		packetId,
		transaction: DamageApplication.transactionFor(actor, packetId),
		fatalApplication: applicationMap(actor, FATAL_APPLICATIONS_FLAG_KEY)[packetId] ?? null,
		fateIntervention: applicationMap(actor, FATE_INTERVENTIONS_FLAG_KEY)[packetId] ?? null,
	};
}

function canEdit(context, user) {
	if (!context || !user) return false;
	if (editLockReason(context)) return false;
	if (user.isGM) return true;

	const sourceUser = sourceUserId(context.sourceMessage, context.damage);
	return Boolean(sourceUser && sourceUser === String(user.id ?? ""));
}

function editLockReason(context) {
	if (!context) return "";
	if (
		context.transaction?.state !== "applied" ||
		!context.transaction?.criticalResolution
	) {
		return localize(
			"The source damage transaction no longer has an active Sudden Death resolution.",
			"Źródłowa transakcja obrażeń nie ma już aktywnego rozstrzygnięcia Nagłej Śmierci.",
		);
	}
	if (context.fateIntervention) {
		return localize(
			"A Fate Point has already been spent for this result. Its d100 is now immutable history.",
			"Dla tego wyniku wydano już Punkt Przeznaczenia. Jego K100 jest teraz niezmienną historią.",
		);
	}
	if (context.fatalApplication?.state === "applied") {
		return localize(
			"This fatal result has already been applied. Revert/invalidate that fatal consequence before changing the d100.",
			"Ten śmiertelny wynik został już zastosowany. Cofnij/unieważnij tę śmiertelną konsekwencję przed zmianą K100.",
		);
	}
	return "";
}

function normalizedOriginalRoll(result) {
	const value = Number(result?.originalRoll ?? result?.resolution?.roll?.total);
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new Error(`Invalid original Sudden Death d100 value: ${String(value)}.`);
	}
	return value;
}

function resultTemplateContext(resolution) {
	return {
		title: `${localize("Sudden Death", "Nagła Śmierć")} +${displayVariant(resolution?.variant)}`,
		rollLabel: localize("d100", "K100"),
		rollTotal: resolution?.roll?.total ?? "—",
		outcomeLabel: outcomeLabel(resolution),
		outcomeClass: resolution?.outcome
			? `is-${String(resolution.outcome)}`
			: "",
	};
}

function outcomeLabel(resolution) {
	switch (String(resolution?.outcome ?? "")) {
		case "killed": return localize("Killed", "Śmierć");
		case "no-effect": return localize("No Effect", "Bez efektu");
		default: {
			const text = Array.isArray(resolution?.results)
				? resolution.results.map((entry) => String(entry?.text ?? "").trim()).filter(Boolean)
				: [];
			return text.join(" / ") || "—";
		}
	}
}

function displayVariant(variant) {
	return String(variant ?? "").replace(/\+$/, "") || "—";
}

function sourceUserId(message, state) {
	return String(
		state?.createdBy ??
		message?.user?.id ??
		message?.author?.id ??
		"",
	).trim();
}

async function requestOwnerEdit(message, roll) {
	const context = suddenDeathContext(message);
	if (!canEdit(context, game.user)) {
		throw new Error(editLockReason(context) ||
			"You may not change this Sudden Death result.");
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to save a player's manual Sudden Death d100 result.",
			"MG musi być połączony, aby zapisać ręczny wynik K100 Nagłej Śmierci wprowadzony przez gracza.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Sudden Death roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			roll,
		});
	});
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;

		if (payload.type === RESPONSE_TYPE) {
			handleResponse(payload);
			return;
		}
		if (payload.type !== REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};

		try {
			const message = game.messages?.get(String(payload.messageId ?? ""));
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!message) throw new Error("Requested Sudden Death ChatMessage is unavailable.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await commitSuddenDeathRoll(message, payload.roll, user);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleResponse(payload) {
	if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);
	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}
	pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function applicationMap(actor, key) {
	const existing = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(existing) ? foundry.utils.deepClone(existing) : {};
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

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
