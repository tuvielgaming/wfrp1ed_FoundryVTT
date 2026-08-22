import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	requestCombatDamageDiceTotalUpdate,
} from "./CombatDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-additional-damage-physical-die-request";
const SOCKET_RESPONSE_TYPE = "combat-additional-damage-physical-die-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingRequests = new Map();
const activeEdits = new Set();

/*
 * Physical-dice adjudication for Core Additional Damage.
 *
 * A successful Additional Damage WS Test produces an exploding d6 sequence:
 * every 6 requires another d6 and the sequence ends on the first 1..5. A summed
 * free-form override would permit impossible sequences, so the dedicated Damage
 * card exposes each extra d6 separately instead.
 *
 * CombatDamageIntegration remains the canonical DamagePacket/resolver path. This
 * module changes only the adjudicated extra-die sequence, then asks the existing
 * summed-total authority function to rebuild the same pending damage transaction.
 * The first generated sequence is retained as audit data. If an edited final die
 * becomes 6, a continuation die is generated only because the Core explosion rule
 * now requires one; that generated continuation is immediately editable as well.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorateAdditionalDamageDice(message, html);
		setTimeout(() => decorateAdditionalDamageDice(message, html), 0);
	});
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
});

function decorateAdditionalDamageDice(viewMessage, html) {
	const view = viewMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return;

	const sourceMessage = game.messages?.get(String(view.sourceAttackMessageId));
	if (!sourceMessage) return;
	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const additional = rollState?.additionalDamage;
	if (
		rollState?.status !== "resolved" ||
		additional?.triggered !== true ||
		additional?.testSucceeded !== true ||
		!validExplodingSequence(additional?.extraDice)
	) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!(card instanceof HTMLElement)) return;

	/* Multi-die damage is not an arbitrary total. Keep the displayed total for
	 * audit, but force users to adjudicate the concrete exploding dice below. */
	const totalInput = card.querySelector?.("[data-wfrp-damage-dice-total]");
	if (totalInput instanceof HTMLInputElement) {
		totalInput.disabled = true;
		totalInput.classList.remove("is-editable");
		totalInput.title = localize(
			"Edit the individual Additional Damage d6 results instead of the summed total.",
			"Edytuj poszczególne wyniki K6 Obrażeń dodatkowych zamiast ich łącznej sumy.",
		);
	}

	const row = findRow(card, localize("Additional Damage", "Obrażenia dodatkowe"));
	const valueHost = row?.querySelector?.(":scope > strong");
	if (!(valueHost instanceof HTMLElement)) return;

	const current = additional.extraDice.map(d6Strict);
	const original = validExplodingSequence(additional.extraDiceOriginal)
		? additional.extraDiceOriginal.map(d6Strict)
		: [...current];
	const editable = canEditAdditionalDamageDice(sourceMessage, game.user);

	valueHost.textContent = "";
	const wrapper = document.createElement("span");
	wrapper.className = "wfrp1e-additional-damage-dice-editor";
	wrapper.dataset.wfrpAdditionalDamageDice = "";

	const testLabel = document.createElement("span");
	testLabel.className = "wfrp1e-additional-damage-dice-editor__test";
	testLabel.textContent = localize("WS success ·", "WW sukces ·");
	wrapper.append(testLabel);

	current.forEach((value, index) => {
		if (index > 0) {
			const plus = document.createElement("span");
			plus.className = "wfrp1e-additional-damage-dice-editor__plus";
			plus.textContent = "+";
			wrapper.append(plus);
		}

		const generated = isD6(original[index]) ? Number(original[index]) : value;
		const editor = buildD6Editor({
			value,
			generated,
			editable,
			index,
		});
		const input = editor.querySelector("input");
		input?.addEventListener("change", () => {
			void commitAdditionalDie(sourceMessage, input, index, value);
		});
		wrapper.append(editor);
	});

	valueHost.append(wrapper);
}

function buildD6Editor({ value, generated, editable, index }) {
	const editor = document.createElement("span");
	editor.className = "wfrp1e-combat-damage-die-editor";
	editor.dataset.wfrpAdditionalDamageD6 = String(index);

	const label = document.createElement("span");
	label.className = "wfrp1e-combat-damage-die-editor__label";
	label.textContent = game.i18n.lang === "pl" ? "K6" : "d6";
	editor.append(label);

	if (generated !== value) {
		const audit = document.createElement("span");
		audit.className = "wfrp1e-combat-damage-die-editor__audit";
		audit.textContent = `${generated} →`;
		audit.title = localize(
			`Foundry generated ${generated}; the adjudicated physical-die result is shown in the input.`,
			`Foundry wygenerował ${generated}; w polu znajduje się rozstrzygający wynik fizycznej kości.`,
		);
		editor.append(audit);
	}

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "6";
	input.step = "1";
	input.inputMode = "numeric";
	input.value = String(value);
	input.className = "wfrp1e-combat-damage-die-editor__input";
	input.dataset.wfrpAdditionalDamageD6Input = String(index);
	input.readOnly = !editable;
	input.setAttribute("aria-readonly", editable ? "false" : "true");
	input.title = editable
		? localize(
			"Enter this physical Additional Damage d6. A non-6 ends the explosion chain; a final 6 requires another d6.",
			"Wpisz wynik tej fizycznej K6 Obrażeń dodatkowych. Wynik inny niż 6 kończy ciąg; końcowe 6 wymaga następnej K6.",
		)
		: localize(
			"This Additional Damage die is locked because damage was applied or you do not own the attacker.",
			"Ta K6 Obrażeń dodatkowych jest zablokowana, ponieważ obrażenia zastosowano albo nie jesteś właścicielem atakującego.",
		);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") input.blur();
	});
	editor.append(input);
	return editor;
}

async function commitAdditionalDie(sourceMessage, input, index, previousValue) {
	const value = Number(input.value);
	if (!isD6(value)) {
		input.value = String(previousValue);
		ui.notifications.warn(localize(
			"Additional Damage d6 must be an integer from 1 to 6.",
			"Wynik K6 Obrażeń dodatkowych musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) return;

	input.readOnly = true;
	try {
		await requestAdditionalDamageDieUpdate(sourceMessage, index, value);
	} catch (error) {
		if (input.isConnected) input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate Additional Damage physical d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the Additional Damage die.",
				"Nie udało się zmienić K6 Obrażeń dodatkowych.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditAdditionalDamageDice(sourceMessage, game.user);
			input.setAttribute("aria-readonly", input.readOnly ? "true" : "false");
		}
	}
}

export async function requestAdditionalDamageDieUpdate(message, index, value) {
	const normalizedIndex = nonNegativeIntegerStrict(index, "Additional Damage die index");
	const normalizedValue = d6Strict(value, "Additional Damage d6");
	if (!canEditAdditionalDamageDice(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to edit these Additional Damage dice.",
			"Nie masz uprawnień do edycji tych K6 Obrażeń dodatkowych.",
		));
	}

	if (game.user?.isGM) {
		return applyAdditionalDamageDieAsAuthority(
			message,
			normalizedIndex,
			normalizedValue,
			game.user,
		);
	}
	return requestGmEdit(message, normalizedIndex, normalizedValue);
}

export function canEditAdditionalDamageDice(message, user = game.user) {
	if (!message?.id || !user) return false;
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		rollState?.additionalDamage?.triggered !== true ||
		rollState?.additionalDamage?.testSucceeded !== true ||
		!validExplodingSequence(rollState?.additionalDamage?.extraDice) ||
		!damageState?.packet?.id ||
		damageTransactionFor(damageState)
	) return false;
	if (user.isGM) return true;
	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	return hasOwnerPermission(attacker, user);
}

async function applyAdditionalDamageDieAsAuthority(
	message,
	index,
	value,
	requestingUser,
) {
	const editKey = `${String(message?.id ?? "")}:${index}`;
	if (activeEdits.has(editKey)) {
		throw new Error("This Additional Damage die is already being edited.");
	}
	if (!canEditAdditionalDamageDice(message, requestingUser)) {
		throw new Error("The requesting user may not edit these Additional Damage dice.");
	}

	const normalizedIndex = nonNegativeIntegerStrict(index, "Additional Damage die index");
	const normalizedValue = d6Strict(value, "Additional Damage d6");
	const previous = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? {},
	);
	const active = previous.additionalDamage.extraDice.map(d6Strict);
	if (normalizedIndex >= active.length) {
		throw new Error("The requested Additional Damage die no longer exists.");
	}
	if (active[normalizedIndex] === normalizedValue) return previous;

	activeEdits.add(editKey);
	try {
		let original = validExplodingSequence(previous.additionalDamage.extraDiceOriginal)
			? previous.additionalDamage.extraDiceOriginal.map(d6Strict)
			: [...active];

		active[normalizedIndex] = normalizedValue;
		let adjudicated = active;
		const firstStop = adjudicated.findIndex((die) => die !== 6);
		if (firstStop >= 0) {
			adjudicated = adjudicated.slice(0, firstStop + 1);
		} else {
			/* Every currently active die is a 6, therefore Core requires another.
			 * Reuse a previously generated audit die if one exists beyond a formerly
			 * truncated chain; otherwise generate only the newly-required continuation. */
			while (adjudicated.every((die) => die === 6)) {
				const nextIndex = adjudicated.length;
				let next = isD6(original[nextIndex]) ? Number(original[nextIndex]) : null;
				if (!isD6(next)) {
					const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
					await showRollAnimation(roll, requestingUser);
					next = d6Strict(roll.total, "Additional Damage continuation d6");
					original = [...original, next];
				}
				adjudicated = [...adjudicated, next];
			}
		}

		const updated = foundry.utils.deepClone(previous);
		updated.additionalDamage = {
			...(updated.additionalDamage ?? {}),
			extraDice: [...adjudicated],
			extraDiceOriginal: [...original],
			extraDiceOverridden: !sameArray(adjudicated, original),
			extraDiceOverriddenBy: !sameArray(adjudicated, original)
				? String(requestingUser?.id ?? "")
				: null,
			extraDiceOverriddenAt: !sameArray(adjudicated, original)
				? Date.now()
				: null,
		};
		updated.damageDice = [
			d6Strict(updated.initialDie, "Initial damage d6"),
			...adjudicated,
		];
		const total = updated.damageDice.reduce((sum, die) => sum + die, 0);
		updated.diceTotal = total;
		updated.updatedBy = String(requestingUser?.id ?? "");
		updated.updatedAt = Date.now();

		/* Persist the concrete sequence first; the canonical total-update path then
		 * rebuilds generatedDamage, DamagePacket, Toughness/armour/parry mitigation,
		 * final amount and the dedicated Damage view from this exact snapshot. */
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, updated);
		await requestCombatDamageDiceTotalUpdate(message, total);

		const finalized = foundry.utils.deepClone(
			message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? updated,
		);
		finalized.additionalDamage = foundry.utils.deepClone(updated.additionalDamage);
		finalized.damageDice = [...updated.damageDice];
		finalized.diceTotal = total;
		finalized.diceTotalOverridden = total !== Number(finalized.diceTotalOriginal);
		finalized.diceTotalOverriddenBy = finalized.diceTotalOverridden
			? String(requestingUser?.id ?? "")
			: null;
		finalized.diceTotalOverriddenAt = finalized.diceTotalOverridden
			? Date.now()
			: null;
		finalized.updatedBy = String(requestingUser?.id ?? "");
		finalized.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, finalized);
		void ui.chat?.render?.({ force: true });
		return foundry.utils.deepFreeze(foundry.utils.deepClone(finalized));
	} finally {
		activeEdits.delete(editKey);
	}
}

async function requestGmEdit(message, index, value) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to adjudicate Additional Damage dice.",
			"Do rozstrzygnięcia K6 Obrażeń dodatkowych wymagany jest aktywny MG.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not adjudicate the Additional Damage die in time.",
				"MG nie rozstrzygnął K6 Obrażeń dodatkowych w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			index,
			value,
		});
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === SOCKET_RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const pending = pendingRequests.get(String(payload.requestId ?? ""));
		if (!pending) return;
		pendingRequests.delete(String(payload.requestId ?? ""));
		clearTimeout(pending.timeout);
		if (payload.ok) pending.resolve(payload.result ?? null);
		else pending.reject(new Error(String(payload.error ?? "Unable to edit Additional Damage.")));
		return;
	}

	if (payload.type !== SOCKET_REQUEST_TYPE || !isPrimaryActiveGM()) return;
	const response = {
		type: SOCKET_RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		const requester = game.users?.get(String(payload.requestUserId ?? ""));
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!requester?.active) throw new Error("The requesting user is not active.");
		if (!message) throw new Error("The requested attack message is unavailable.");
		response.result = await applyAdditionalDamageDieAsAuthority(
			message,
			payload.index,
			payload.value,
			requester,
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected Additional Damage die edit.", error);
		response.error = error?.message ?? "Unable to edit Additional Damage.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

function damageTransactionFor(damageState) {
	if (!damageState?.packet?.id) return null;
	const actor = actorFromUuidSync(damageState.packet.targetActorUuid);
	return actor
		? DamageApplication.transactionFor(actor, damageState.packet.id)
		: damageState.application ?? null;
}

function validExplodingSequence(value) {
	if (!Array.isArray(value) || value.length < 1) return false;
	const dice = value.map(Number);
	if (!dice.every(isD6)) return false;
	return dice.slice(0, -1).every((die) => die === 6) && dice.at(-1) !== 6;
}

function sameArray(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => Number(value) === Number(right[index]));
}

function findRow(card, expectedLabel) {
	return [...(card.querySelectorAll?.(".wfrp1e-damage-card__row") ?? [])]
		.find((row) => String(row.querySelector?.(":scope > span")?.textContent ?? "").trim() === expectedLabel) ?? null;
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

function hasOwnerPermission(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

async function showRollAnimation(roll, requestingUser) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, requestingUser ?? game.user, true);
	} catch (error) {
		console.warn("WFRP1ED | Dice So Nice could not animate Additional Damage continuation.", error);
	}
}

function d6Strict(value, label = "d6") {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 6) {
		throw new Error(`${label} must be an integer from 1 to 6.`);
	}
	return number;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function nonNegativeIntegerStrict(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return number;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
