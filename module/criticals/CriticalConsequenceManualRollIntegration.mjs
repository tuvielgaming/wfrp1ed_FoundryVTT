const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const TIMED_FLAG_KEY = "criticalTimed";
const SUMMARY_FLAG_KEY = "criticalRollSummary";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "critical-duration-roll-edit-request";
const RESPONSE_TYPE = "critical-duration-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();
const activeEdits = new Set();

/*
 * Physical-dice support for random Critical-Wound setup durations.
 *
 * CriticalConsequenceEngine owns the original random Roll and keeps its Roll JSON
 * in `resolved.duration.roll`. This integration changes only the adjudicated
 * duration used by the WFRP Initiative clock. The original Roll is never
 * overwritten.
 *
 * The currently-audited Core case is Leg effect 4: 1d4 rounds of halved Movement
 * and Initiative. The duration may be edited only before that timed consequence
 * has progressed through a round. Afterwards the parent Critical must be
 * invalidated through the normal rollback lifecycle before another result is
 * chosen.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	installDurationEditor(message, html);
});

Hooks.once("ready", () => registerSocket());

for (const hookName of ["updateItem", "deleteItem"]) {
	Hooks.on(hookName, (item) => {
		if (item?.type !== "criticalWound") return;
		requestAnimationFrame(() => refreshSummaryCards(String(item.uuid ?? "")));
	});
}

for (const hookName of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
	Hooks.on(hookName, (effect) => {
		const wound = effect?.parent;
		if (wound?.type !== "criticalWound") return;
		requestAnimationFrame(() => refreshSummaryCards(String(wound.uuid ?? "")));
	});
}

function installDurationEditor(message, html) {
	const context = durationContext(message);
	if (!context) return;
	const root = asElement(html);
	const summaryRoot = root?.matches?.("[data-wfrp-critical-roll-summary]")
		? root
		: root?.querySelector?.("[data-wfrp-critical-roll-summary]");
	if (!(summaryRoot instanceof HTMLElement)) return;
	const row = summaryRowElement(summaryRoot, context.rowIndex);
	if (!(row instanceof HTMLElement)) return;
	renderDurationRow(row, context, message);
}

function renderDurationRow(row, context, message) {
	const duration = context.duration;
	const formula = String(duration.formula ?? "");
	const bounds = simpleDiceBounds(formula);
	const lockReason = editLockReason(context);
	const editable = Boolean(bounds && !lockReason && canEdit(context, game.user));

	row.textContent = "";
	const label = document.createElement("strong");
	label.textContent = `${String(context.summaryRow?.label ?? localize("Characteristic changes", "Zmiany cech"))}:`;
	row.append(label, document.createTextNode(" "));

	const icon = document.createElement("i");
	icon.className = `fa-solid ${diceIconClass(formula)}`;
	icon.setAttribute("aria-hidden", "true");
	row.append(icon, document.createTextNode(` ${formula} → `));

	const input = document.createElement("input");
	input.type = "number";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(duration.value ?? "");
	input.dataset.wfrpCriticalDurationRollInput = "";
	input.className = "wfrp1e-critical-result__roll-input";
	if (bounds) {
		input.min = String(bounds.min);
		input.max = String(bounds.max);
	}
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;
	input.classList.toggle("is-editable", editable);
	input.classList.toggle("is-readonly", !editable);
	input.title = editable
		? localize(
			"Enter the physical duration-roll result. The original Foundry roll remains in the Critical Wound audit state.",
			"Wprowadź wynik fizycznego rzutu na czas trwania. Oryginalny rzut Foundry pozostaje zapisany w stanie audytowym Rany Krytycznej.",
		)
		: lockReason || (!bounds
			? localize(
				"This duration formula is not yet supported by the manual-roll editor.",
				"Ta formuła czasu trwania nie jest jeszcze obsługiwana przez edytor ręcznego rzutu.",
			)
			: localize(
				"Only the GM or an OWNER of the affected Actor may replace this duration roll.",
				"Tylko MG albo WŁAŚCICIEL poszkodowanego Aktora może zmienić ten rzut na czas trwania.",
			));
	row.append(input, document.createTextNode(` ${durationUnitLabel(Number(duration.value), duration.units)}`));

	if (!editable) return;
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
	input.addEventListener("change", () => void setDurationValue(message, input));
}

async function setDurationValue(message, input) {
	try {
		const context = durationContext(message);
		if (!context || !canEdit(context, game.user)) {
			throw new Error(editLockReason(context) || localize(
				"You may not change this Critical duration roll.",
				"Nie możesz zmienić tego rzutu na czas trwania skutku krytycznego.",
			));
		}
		const bounds = simpleDiceBounds(context.duration.formula);
		const requested = Number(String(input?.value ?? "").trim());
		if (!bounds || !Number.isInteger(requested) || requested < bounds.min || requested > bounds.max) {
			throw new Error(bounds
				? localize(
					`Enter a whole result from ${bounds.min} to ${bounds.max}.`,
					`Wprowadź całkowity wynik od ${bounds.min} do ${bounds.max}.`,
				)
				: "Unsupported Critical duration formula for manual adjudication.");
		}
		if (requested === Number(context.duration.value)) return;
		input.disabled = true;
		if (game.user?.isGM) await commitDurationValue(message, requested, game.user);
		else await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit Critical duration roll.", error);
		const current = durationContext(message);
		if (input) input.value = String(current?.duration?.value ?? "");
		ui.notifications.error(error?.message ?? localize(
			"Unable to change the Critical duration roll.",
			"Nie udało się zmienić rzutu na czas trwania skutku krytycznego.",
		));
	} finally {
		if (input?.isConnected) input.disabled = false;
	}
}

async function commitDurationValue(message, value, requestingUser) {
	if (!game.user?.isGM) throw new Error("Critical duration edits require GM authority.");

	const initial = durationContext(message);
	if (!initial || !canEdit(initial, requestingUser)) {
		throw new Error(editLockReason(initial) ||
			"The requesting user may not change this Critical duration roll.");
	}
	const bounds = simpleDiceBounds(initial.duration.formula);
	const requested = Number(value);
	if (!bounds || !Number.isInteger(requested) || requested < bounds.min || requested > bounds.max) {
		throw new Error("The requested Critical duration is outside the formula range.");
	}

	const key = String(initial.wound.uuid ?? "");
	if (!key || activeEdits.has(key)) throw new Error("This Critical duration is already being edited.");
	activeEdits.add(key);

	let snapshot = null;
	let effectChanged = false;
	try {
		/* Re-read at the transaction boundary. A combat-clock update which happened
		 * after the input rendered must win and lock this edit. */
		const fresh = durationContext(message);
		if (!fresh || !canEdit(fresh, requestingUser)) {
			throw new Error(editLockReason(fresh) || "The Critical duration can no longer be changed.");
		}
		snapshot = {
			wound: fresh.wound,
			effect: fresh.effect,
			runtime: foundry.utils.deepClone(fresh.runtime),
			effectMeta: foundry.utils.deepClone(fresh.effectMeta),
			timed: foundry.utils.deepClone(fresh.timed),
		};

		const duration = foundry.utils.deepClone(fresh.duration);
		const originalValue = Number(duration.originalValue ?? duration.value);
		duration.originalValue = originalValue;
		duration.value = requested;
		duration.edited = requested !== originalValue;
		duration.editedBy = duration.edited ? String(requestingUser?.id ?? "") : "";
		duration.editedAt = duration.edited ? Date.now() : null;
		/* duration.roll remains untouched as the original Foundry Roll audit. */

		const effectMeta = foundry.utils.deepClone(fresh.effectMeta);
		effectMeta.resolved = foundry.utils.deepClone(effectMeta.resolved ?? {});
		effectMeta.resolved.duration = foundry.utils.deepClone(duration);
		const timed = foundry.utils.deepClone(fresh.timed);
		timed.durationRounds = requested;

		/* Update the actual timer first. If the parent Item update then fails, the
		 * timer is restored from the same fresh snapshot. */
		await fresh.effect.update({
			[`flags.${FLAG_SCOPE}.${EFFECT_FLAG_KEY}`]: effectMeta,
			[`flags.${FLAG_SCOPE}.${TIMED_FLAG_KEY}`]: timed,
		});
		effectChanged = true;

		const runtime = foundry.utils.deepClone(fresh.runtime);
		runtime.resolved = foundry.utils.deepClone(runtime.resolved ?? {});
		runtime.resolved.duration = foundry.utils.deepClone(duration);
		runtime.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
		runtime.updatedAt = Date.now();
		try {
			await fresh.wound.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, runtime);
		} catch (error) {
			await restoreEffectSnapshot(snapshot);
			effectChanged = false;
			throw error;
		}

		await persistSummaryAdjudication(message, fresh, duration).catch((error) => {
			console.warn("WFRP1ED | Critical duration changed but chat audit refresh failed.", error);
		});
		refreshSummaryCards(String(fresh.wound.uuid ?? ""));
		return Object.freeze({
			woundUuid: String(fresh.wound.uuid ?? ""),
			value: requested,
			originalValue,
			edited: duration.edited,
		});
	} catch (error) {
		if (effectChanged && snapshot) await restoreEffectSnapshot(snapshot);
		throw error;
	} finally {
		activeEdits.delete(key);
	}
}

async function restoreEffectSnapshot(snapshot) {
	if (!snapshot?.effect?.update) return;
	await snapshot.effect.update({
		[`flags.${FLAG_SCOPE}.${EFFECT_FLAG_KEY}`]: snapshot.effectMeta,
		[`flags.${FLAG_SCOPE}.${TIMED_FLAG_KEY}`]: snapshot.timed,
	}).catch(() => {});
}

async function persistSummaryAdjudication(message, context, duration) {
	if (!message?.canUserModify?.(game.user, "update")) return false;
	const summary = foundry.utils.deepClone(context.summary);
	const rows = Array.isArray(summary.rows) ? foundry.utils.deepClone(summary.rows) : [];
	const row = rows[context.rowIndex];
	if (!row) return false;
	row.value = formatDuration(Number(duration.value), duration.units);
	row.originalValue = Number(duration.originalValue ?? duration.value);
	row.adjudicatedValue = Number(duration.value);
	row.edited = duration.edited === true;
	row.editedBy = String(duration.editedBy ?? "");
	row.editedAt = duration.editedAt ?? null;
	summary.version = Math.max(4, Number(summary.version) || 0);
	summary.rows = rows;
	summary.updatedBy = String(duration.editedBy ?? game.user?.id ?? "");
	summary.updatedAt = Date.now();
	await message.update({
		content: replaceSummaryRowContent(message.content, context.rowIndex, row),
		[`flags.${FLAG_SCOPE}.${SUMMARY_FLAG_KEY}`]: summary,
	});
	return true;
}

function durationContext(message) {
	const summary = message?.getFlag?.(FLAG_SCOPE, SUMMARY_FLAG_KEY);
	if (!isRecord(summary)) return null;
	const wound = documentFromUuidSync(summary.woundUuid);
	if (!(wound instanceof foundry.documents.Item) || wound.type !== "criticalWound") return null;
	const actor = wound.parent;
	if (!(actor instanceof foundry.documents.Actor)) return null;
	const runtime = wound.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY);
	if (!isRecord(runtime) || !isRecord(runtime.resolved?.duration)) return null;
	if (!Array.isArray(runtime.definition?.characteristics) || !runtime.definition.characteristics.length) return null;

	const duration = foundry.utils.deepClone(runtime.resolved.duration);
	const rows = Array.isArray(summary.rows) ? summary.rows : [];
	const rowIndex = durationRowIndex(rows, duration);
	if (rowIndex < 0) return null;
	const effect = managedCharacteristicsEffect(wound);
	const effectMeta = effect?.getFlag?.(FLAG_SCOPE, EFFECT_FLAG_KEY);
	const timed = effect?.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
	return {
		message,
		summary,
		summaryRow: rows[rowIndex] ?? null,
		rowIndex,
		wound,
		actor,
		runtime: foundry.utils.deepClone(runtime),
		duration,
		effect,
		effectMeta: isRecord(effectMeta) ? foundry.utils.deepClone(effectMeta) : null,
		timed: isRecord(timed) ? foundry.utils.deepClone(timed) : null,
	};
}

function editLockReason(context) {
	if (!context) return localize("The Critical duration state is unavailable.", "Stan czasu trwania skutku krytycznego jest niedostępny.");
	if (context.runtime?.state !== "applied") return localize("The Critical Wound consequence is still being prepared or is no longer active.", "Skutek Rany Krytycznej jest jeszcze przygotowywany albo nie jest już aktywny.");
	if (String(context.duration?.units ?? "") !== "rounds") return localize("Only round-based random Critical durations are currently safe to edit.", "Obecnie bezpiecznie edytować można tylko losowe czasy trwania liczone w rundach.");
	if (!context.effect || !isRecord(context.effectMeta) || !isRecord(context.timed)) return localize("The timed Critical effect is not fully materialized yet.", "Czasowy efekt Rany Krytycznej nie został jeszcze w pełni utworzony.");
	if (context.effect.disabled === true || Number(context.timed.expiredAtRound ?? 0) > 0) return localize("This timed Critical consequence has already expired.", "Ten czasowy skutek Rany Krytycznej już wygasł.");
	if (Number(context.timed.completedRounds ?? 0) > 0) return localize("This timed Critical consequence has already started progressing. Invalidate the Critical result before changing its duration roll.", "Ten czasowy skutek Rany Krytycznej zaczął już odliczanie. Unieważnij trafienie krytyczne przed zmianą rzutu na czas trwania.");
	if (String(context.runtime?.lootPileUuid ?? "").trim()) return localize("This Critical Wound already created an external Item-drop consequence. Invalidate it before changing the setup roll.", "Ta Rana Krytyczna utworzyła już zewnętrzny skutek upuszczenia przedmiotów. Unieważnij ją przed zmianą rzutu przygotowawczego.");
	return "";
}

function canEdit(context, user) {
	if (!context || !user || editLockReason(context)) return false;
	if (user.isGM) return true;
	return context.actor.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true;
}

function managedCharacteristicsEffect(wound) {
	return [...(wound?.effects ?? [])].find((effect) => {
		const metadata = effect.getFlag?.(FLAG_SCOPE, EFFECT_FLAG_KEY);
		return metadata?.kind === "characteristics" && String(metadata?.woundUuid ?? "") === String(wound.uuid ?? "");
	}) ?? null;
}

function durationRowIndex(rows, duration) {
	const formula = String(duration?.formula ?? "").trim();
	const preferred = rows.findIndex((row) =>
		String(row?.formula ?? "").trim() === formula &&
		/^(Characteristic changes|Zmiany cech)$/i.test(String(row?.label ?? "").trim()),
	);
	if (preferred >= 0) return preferred;
	const matches = rows.map((row, index) => ({ row, index }))
		.filter(({ row }) => String(row?.formula ?? "").trim() === formula);
	return matches.length === 1 ? matches[0].index : -1;
}

function summaryRowElement(root, rowIndex) {
	return [...root.querySelectorAll(":scope > div")][rowIndex + 1] ?? null;
}

function simpleDiceBounds(formula) {
	const match = String(formula ?? "").replace(/\s+/g, "").toLowerCase()
		.match(/^(\d*)d(\d+)([+-]\d+)?$/);
	if (!match) return null;
	const count = Number(match[1] || 1);
	const faces = Number(match[2]);
	const modifier = Number(match[3] || 0);
	if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(faces) || faces <= 0) return null;
	return { min: Math.max(1, count + modifier), max: Math.max(1, count * faces + modifier) };
}

function replaceSummaryRowContent(content, rowIndex, row) {
	const wrapper = document.createElement("div");
	wrapper.innerHTML = String(content ?? "");
	const root = wrapper.querySelector("[data-wfrp-critical-roll-summary]");
	const element = root instanceof HTMLElement ? summaryRowElement(root, rowIndex) : null;
	if (!(element instanceof HTMLElement)) return String(content ?? "");
	const prefix = row.formula
		? `<i class="fa-solid ${diceIconClass(row.formula)}" aria-hidden="true"></i> ${escapeHtml(row.formula)} → `
		: "";
	element.innerHTML = `<strong>${escapeHtml(row.label)}:</strong> ${prefix}${escapeHtml(row.value)}`;
	return wrapper.innerHTML;
}

function formatDuration(value, units) {
	return `${Number(value)} ${durationUnitLabel(Number(value), units)}`.trim();
}

function durationUnitLabel(value, units) {
	if (String(units ?? "") !== "rounds") return String(units ?? "");
	const amount = Math.abs(Number(value));
	if (game.i18n.lang !== "pl") return amount === 1 ? "round" : "rounds";
	if (amount === 1) return "runda";
	const lastTwo = amount % 100;
	const last = amount % 10;
	return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "rundy" : "rund";
}

function diceIconClass(formula) {
	const value = String(formula ?? "").toLowerCase();
	for (const faces of [20, 12, 10, 8, 6, 4]) {
		if (new RegExp(`d${faces}\\b`).test(value)) return `fa-dice-d${faces}`;
	}
	return "fa-dice";
}

async function requestOwnerEdit(message, value) {
	const context = durationContext(message);
	if (!canEdit(context, game.user)) throw new Error(editLockReason(context) || "You may not change this Critical duration roll.");
	if (!primaryActiveGm()) throw new Error(localize("A GM must be connected to save a player's physical Critical duration roll.", "MG musi być połączony, aby zapisać fizyczny rzut gracza na czas trwania skutku krytycznego."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Critical duration edit request timed out."));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requesterUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			value: Number(value),
		});
	});
}

function registerSocket() {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
}

async function handleSocketPayload(payload) {
	if (!isRecord(payload)) return;
	if (payload.type === RESPONSE_TYPE) {
		handleSocketResponse(payload);
		return;
	}
	if (payload.type !== REQUEST_TYPE || !isPrimaryActiveGm()) return;
	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requesterUserId: String(payload.requesterUserId ?? ""),
		ok: false,
		error: null,
	};
	try {
		const requester = game.users?.get(response.requesterUserId);
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!requester?.active) throw new Error("The requesting user is not active.");
		if (!message) throw new Error("The Critical duration summary is unavailable.");
		const context = durationContext(message);
		if (!canEdit(context, requester)) throw new Error(editLockReason(context) || "The requesting user may not change this Critical duration roll.");
		await commitDurationValue(message, Number(payload.value), requester);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected Critical duration edit request.", error);
		response.error = String(error?.message ?? "Unable to change Critical duration roll.");
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleSocketResponse(payload) {
	if (String(payload.requesterUserId ?? "") !== String(game.user?.id ?? "")) return;
	const pending = pendingRequests.get(String(payload.requestId ?? ""));
	if (!pending) return;
	pendingRequests.delete(String(payload.requestId ?? ""));
	clearTimeout(pending.timeout);
	if (payload.ok) pending.resolve(true);
	else pending.reject(new Error(String(payload.error ?? "Unable to change Critical duration roll.")));
}

function refreshSummaryCards(woundUuid) {
	const key = String(woundUuid ?? "");
	if (!key) return;
	for (const message of game.messages ?? []) {
		if (String(message.getFlag?.(FLAG_SCOPE, SUMMARY_FLAG_KEY)?.woundUuid ?? "") !== key) continue;
		for (const hostDocument of renderedHostDocuments()) {
			const entry = hostDocument.querySelector?.(`[data-message-id="${cssEscape(String(message.id ?? ""))}"]`);
			if (entry) installDurationEditor(message, entry);
		}
	}
}

function renderedHostDocuments() {
	const documents = new Set([document]);
	const instances = foundry.applications?.instances;
	if (instances?.values) {
		for (const application of instances.values()) {
			const hostDocument = application?.element?.ownerDocument;
			if (hostDocument?.querySelector) documents.add(hostDocument);
		}
	}
	return documents;
}

function documentFromUuidSync(uuid) {
	try {
		return foundry.utils.fromUuidSync(String(uuid ?? "").trim());
	} catch (_error) {
		return null;
	}
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	const gm = primaryActiveGm();
	return Boolean(game.user?.isGM && gm && String(gm.id) === String(game.user.id));
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span.innerHTML;
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
