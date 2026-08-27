import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { ActorTestRequestWorkflow } from "../tests/ActorTestRequestWorkflow.mjs";
import { TestContext } from "../tests/TestContext.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";
import { TestManager } from "../tests/TestManager.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const DAMAGE_FLAG_KEY = "damageState";
const ACTOR_TEST_FLAG_KEY = "actorTestRequest";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fire-ball-impact-action-request";
const RESPONSE_TYPE = "fire-ball-impact-action-response";
const SOCKET_TIMEOUT_MS = 30000;
const STRENGTH = 3;
const pendingRequests = new Map();
const activeActions = new Set();
const queuedAutomatic = new Set();
let installed = false;

/**
 * One Fire Ball hit, owned from Initiative through the shared Damage pipeline.
 *
 * The Initiative Test is resolved through the canonical Test engine, but its
 * d100 and final target are stored on this impact card instead of publishing a
 * second Test ChatMessage. This keeps the complete saving-throw/damage
 * transaction readable in one place while retaining normal Test hooks/effects.
 */
export class FireBallImpactWorkflow {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.on("renderChatMessageHTML", (message, html) => {
			requestAnimationFrame(() => decorate(message, html));
		});
		Hooks.once("ready", () => {
			game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
		});
	}

	static async create({
		caster,
		spell,
		target,
		ballIndex,
		flammable = false,
		fearOfFire = false,
		castId = "",
	} = {}) {
		if (!(caster instanceof foundry.documents.Actor)) {
			throw new Error("Fire Ball impact requires a caster Actor.");
		}
		if (!(target?.actor instanceof foundry.documents.Actor)) {
			throw new Error("Fire Ball impact requires a target Actor.");
		}

		const state = {
			version: 2,
			status: "awaiting-initiative",
			castId: String(castId ?? ""),
			casterUuid: String(caster.uuid),
			casterName: String(caster.name ?? ""),
			spellUuid: String(spell?.uuid ?? ""),
			spellName: String(spell?.name ?? localize("Fire Ball", "Ognista Kula")),
			ballNumber: Number(ballIndex) + 1,
			targetUuid: String(target.actor.uuid),
			targetTokenUuid: String(target.tokenUuid ?? ""),
			targetName: String(target.name ?? target.actor.name ?? ""),
			flammable: flammable === true,
			fearOfFire: fearOfFire === true,
			fearRequestMessageId: null,
			initiative: null,
			damage: null,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};

		const message = await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor: caster }),
			content: `<section class="wfrp1ed wfrp-fireball-impact-workflow" data-wfrp-fireball-impact-workflow></section>`,
			flags: { [FLAG_SCOPE]: { [IMPACT_FLAG_KEY]: state } },
		});

		if (state.fearOfFire) {
			const fearMessage = await ensureFearRequest(state, target.actor);
			if (fearMessage?.id) {
				state.fearRequestMessageId = String(fearMessage.id);
				await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			}
		}
		return message;
	}
}

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-impact-workflow]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return;
	panel.replaceChildren();

	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!target || !caster) {
		panel.append(statusText(localize(
			"The caster or target is no longer available.",
			"Rzucający czar lub cel nie jest już dostępny.",
		)));
		return;
	}

	panel.classList.add("wfrp1e-damage-card", "wfrp-fireball-damage-card");
	const header = document.createElement("header");
	header.className = "wfrp1e-damage-card__header";
	const title = document.createElement("strong");
	title.textContent = `${state.spellName} ${state.ballNumber}`;
	const amount = document.createElement("span");
	amount.className = "wfrp1e-damage-card__amount";
	amount.textContent = state.damage?.finalDamage === undefined || state.damage?.finalDamage === null
		? "—"
		: String(state.damage.finalDamage);
	header.append(title, amount);
	panel.append(header);

	panel.append(cardRow(localize("Target", "Cel"), state.targetName));
	appendGmVulnerabilityControls(panel, message, state, target);

	if (state.status === "awaiting-initiative") {
		panel.append(statusText(localize(
			`${target.name} must make an Initiative Test. Success halves Fire Ball damage.`,
			`${target.name} musi wykonać Test Inicjatywy. Sukces zmniejsza obrażenia Ognistej Kuli o połowę.`,
		)));
		const button = actionButton(localize("Roll Initiative", "Rzuć Inicjatywę"));
		button.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
		button.title = button.disabled
			? localize(
				"Only the GM or an OWNER of the target may roll this Test.",
				"Tylko MG albo Właściciel celu może wykonać ten Test.",
			)
			: "";
		button.addEventListener("click", () => void requestAction(message, "initiative").catch(reportError));
		panel.append(button);
		maybeQueueAutomatic(message, "initiative", target);
		return;
	}

	if (state.initiative) {
		panel.append(buildInitiativeEditor(message, state, target));
	}

	if (state.status === "awaiting-damage") {
		const button = actionButton(localize("Roll Damage", "Rzuć obrażenia"));
		button.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
		button.title = button.disabled
			? localize(
				"Only the GM or an OWNER of the caster may roll this damage.",
				"Tylko MG albo Właściciel rzucającego czar może rzucić te obrażenia.",
			)
			: localize(
				"Roll Fire Ball 1d10 damage. Fire Ball does not use exploding Additional Damage.",
				"Rzuć 1k10 obrażeń Ognistej Kuli. Ognista Kula nie używa eksplodujących Obrażeń Dodatkowych.",
			);
		button.addEventListener("click", () => void requestAction(message, "damage").catch(reportError));
		panel.append(button);
		maybeQueueAutomatic(message, "damage", caster);
		return;
	}

	if (state.status === "resolved" && state.damage) {
		panel.append(buildResolvedDamage(message, state, target, caster));
	}
}

function appendGmVulnerabilityControls(panel, message, state, target) {
	const row = document.createElement("div");
	row.className = "wfrp-fireball-vulnerability-row";

	const flammable = checkboxControl(
		localize("Flammable", "Łatwopalny"),
		state.flammable === true,
		"flammable",
	);
	const fear = checkboxControl(
		localize("Fear of Fire", "Strach przed ogniem"),
		state.fearOfFire === true,
		"fearOfFire",
	);

	const editable = game.user?.isGM === true && !damageTransaction(message, target);
	for (const input of [flammable.input, fear.input]) {
		input.disabled = !editable;
		if (!editable && game.user?.isGM) {
			input.title = localize(
				"Revert applied damage before changing this adjudication.",
				"Cofnij zastosowane obrażenia przed zmianą tego rozstrzygnięcia.",
			);
		}
		input.addEventListener("change", () => {
			void requestAction(message, "vulnerability", {
				kind: input.dataset.fireBallVulnerability,
				value: input.checked === true,
			}).catch(reportError);
		});
	}
	row.append(flammable.label, fear.label);
	panel.append(row);
}

function buildInitiativeEditor(message, state, target) {
	const initiative = state.initiative ?? {};
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp-fireball-initiative-row";
	const label = document.createElement("span");
	label.textContent = localize("Initiative", "Inicjatywa");

	const editor = document.createElement("span");
	editor.className = "wfrp-fireball-inline-roll";
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "100";
	input.step = "1";
	input.value = String(initiative.roll ?? "");
	input.className = "wfrp-fireball-inline-roll__input";
	input.disabled = !ActorRollPolicy.canAdjudicate(target, game.user) || Boolean(damageTransaction(message, target));
	input.title = input.disabled
		? localize(
			"Only the GM or target OWNER may edit this Initiative roll; applied damage must be reverted first.",
			"Tylko MG albo Właściciel celu może zmienić ten rzut Inicjatywy; zastosowane obrażenia trzeba najpierw cofnąć.",
		)
		: localize("Edit the d100 result.", "Zmień wynik k100.");
	input.addEventListener("change", () => void requestAction(message, "initiative-override", {
		roll: input.value,
	}).catch(reportError));

	const outcome = document.createElement("strong");
	outcome.textContent = `${initiative.roll ?? "—"} / ${initiative.target ?? "—"} — ${initiative.success
		? localize("success, half damage", "sukces, połowa obrażeń")
		: localize("failure, full damage", "porażka, pełne obrażenia")}`;
	editor.append(input, outcome);
	row.append(label, editor);
	return row;
}

function buildResolvedDamage(message, state, target, caster) {
	const fragment = document.createDocumentFragment();
	const damage = state.damage;

	fragment.append(dieRollRow({
		label: localize("Fire Ball damage", "Obrażenia Ognistej Kuli"),
		die: "d10",
		value: damage.damageRoll,
		disabled: !ActorRollPolicy.canAdjudicate(caster, game.user) || Boolean(damageTransaction(message, target)),
		onChange: (value) => requestAction(message, "damage-d10-override", { value }),
	}));

	if (state.flammable) {
		fragment.append(dieRollRow({
			label: localize("Flammable damage", "Obrażenia za łatwopalność"),
			die: "d8",
			value: damage.flammableRoll,
			disabled: !ActorRollPolicy.canAdjudicate(caster, game.user) || Boolean(damageTransaction(message, target)),
			onChange: (value) => requestAction(message, "damage-d8-override", { value }),
		}));
	}

	const details = document.createElement("details");
	details.className = "wfrp1e-damage-card__details combat-damage-context__resolved";
	const summary = document.createElement("summary");
	summary.textContent = localize("Damage details", "Szczegóły obrażeń");
	details.append(summary);
	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details-body combat-damage-context__details-body";
	body.append(
		detailRow(localize("Strength", "Siła"), `+${STRENGTH}`),
		detailRow(
			localize("Initiative", "Inicjatywa"),
			state.initiative?.success
				? localize("success — half damage", "sukces — połowa obrażeń")
				: localize("failure — full damage", "porażka — pełne obrażenia"),
		),
		detailRow(localize("Armour", "Pancerz"), localize("ignored", "pominięty")),
		detailRow(localize("Toughness", "Wytrzymałość"), `−${damage.toughness}`),
		detailRow(localize("Final damage", "Końcowe obrażenia"), String(damage.finalDamage)),
	);
	const transaction = damageTransaction(message, target);
	if (transaction?.state === "applied") {
		body.append(statusText(localize(
			`Applied · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
			`Zastosowano · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
		)));
	} else if (transaction?.state === "reverted") {
		body.append(statusText(localize(
			"Damage application reverted.",
			"Zastosowanie obrażeń cofnięto.",
		)));
	}
	details.append(body);
	fragment.append(details);

	/* Match normal combat: Apply Damage stays discoverable even while details are folded. */
	if (!transaction && Number(damage.finalDamage) > 0) {
		const apply = actionButton(localize("Apply Damage", "Zastosuj obrażenia"));
		apply.classList.add("wfrp1e-damage-card__apply");
		apply.disabled = !DamageChat.canApplyMessage(message, game.user);
		apply.addEventListener("click", () => {
			void DamageChat.applyMessage(message)
				.then(() => ui.chat?.render?.({ force: true }))
				.catch(reportError);
		});
		fragment.append(apply);
	}
	return fragment;
}

function dieRollRow({ label, die, value, disabled, onChange }) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp-fireball-die-row";
	const text = document.createElement("span");
	text.textContent = label;
	const editor = document.createElement("span");
	editor.className = "wfrp-fireball-die-editor";
	const badge = document.createElement("span");
	badge.className = "wfrp-fireball-die-badge";
	badge.textContent = die;
	badge.setAttribute("aria-label", die);
	const equals = document.createElement("span");
	equals.textContent = "=";
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = die === "d10" ? "10" : "8";
	input.step = "1";
	input.value = String(value ?? "");
	input.disabled = disabled === true;
	input.addEventListener("change", () => void Promise.resolve(onChange(input.value)).catch(reportError));
	editor.append(badge, equals, input);
	row.append(text, editor);
	return row;
}

async function requestAction(message, action, extra = {}) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) throw new Error("This Fire Ball impact is no longer available.");

	if (action === "vulnerability") {
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only the GM may adjudicate Fire Ball vulnerabilities.",
				"Tylko MG może rozstrzygać podatności Ognistej Kuli.",
			));
		}
		return resolveAsAuthority(message, action, game.user, extra);
	}

	const actor = action === "initiative" || action === "initiative-override"
		? ActorRollPolicy.actorFromUuidSync(state.targetUuid)
		: ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!ActorRollPolicy.canAdjudicate(actor, game.user)) {
		throw new Error(localize(
			"You may not resolve this roll.",
			"Nie masz uprawnień do rozstrzygnięcia tego rzutu.",
		));
	}
	if (game.user?.isGM) return resolveAsAuthority(message, action, game.user, extra);
	return requestGmAction(message, action, extra);
}

async function requestGmAction(message, action, extra) {
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) {
		throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	}
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the action in time.",
				"MG nie rozstrzygnął akcji w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			action: String(action),
			extra,
		});
	});
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pendingRequests.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pendingRequests.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(String(payload.error ?? "Unable to resolve Fire Ball impact.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !ActorRollPolicy.isPrimaryActiveGM()) return;

	const requester = game.users?.get(String(payload.requestUserId ?? ""));
	const message = game.messages?.get(String(payload.messageId ?? ""));
	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		if (!requester || !message) {
			throw new Error("The requesting user or impact message is unavailable.");
		}
		response.result = await resolveAsAuthority(
			message,
			String(payload.action ?? ""),
			requester,
			payload.extra ?? {},
		);
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to resolve Fire Ball impact.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function resolveAsAuthority(message, action, requestingUser, extra = {}) {
	const key = `${message.id}:${action}`;
	if (activeActions.has(key)) return null;
	const state = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {},
	);
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!target || !caster) throw new Error("The caster or target is unavailable.");

	if (action !== "vulnerability") {
		const ownedActor = action === "initiative" || action === "initiative-override"
			? target
			: caster;
		if (!ActorRollPolicy.canAdjudicate(ownedActor, requestingUser)) {
			throw new Error("The requesting user does not own this roll.");
		}
	} else if (!requestingUser?.isGM) {
		throw new Error("Only a GM may adjudicate Fire Ball vulnerabilities.");
	}

	activeActions.add(key);
	try {
		if (action === "initiative") {
			if (state.status !== "awaiting-initiative") return state;
			const result = await rollInitiativeWithoutChat(target);
			await showRollAnimation(result.rollObject, requestingUser);
			state.initiative = initiativeSnapshot(result);
			state.status = "awaiting-damage";
			state.updatedBy = String(requestingUser?.id ?? "");
			state.updatedAt = Date.now();
			await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			void ui.chat?.render?.({ force: true });
			return state;
		}

		if (action === "initiative-override") {
			assertNoAppliedDamage(message, target, localize(
				"Revert applied Fire Ball damage before changing Initiative.",
				"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą Inicjatywy.",
			));
			if (!state.initiative) throw new Error("Initiative has not been rolled yet.");
			const roll = boundedInteger(extra.roll, 1, 100, "Initiative d100");
			state.initiative.roll = roll;
			state.initiative.overridden = roll !== Number(state.initiative.originalRoll);
			state.initiative.overriddenBy = state.initiative.overridden ? String(requestingUser?.id ?? "") : null;
			state.initiative.overriddenAt = state.initiative.overridden ? Date.now() : null;
			state.initiative.success = roll <= Number(state.initiative.target);
			if (state.damage) {
				return finalizeDamage(message, state, target, caster, {
					damageRoll: Number(state.damage.damageRoll),
					flammableRoll: Number(state.damage.flammableRoll ?? 0),
					requestingUser,
				});
			}
			state.updatedAt = Date.now();
			await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			void ui.chat?.render?.({ force: true });
			return state;
		}

		if (action === "damage") {
			if (state.status !== "awaiting-damage") return state;
			const d10 = await new Roll("1d10").evaluate({ allowInteractive: false });
			await showRollAnimation(d10, requestingUser);
			let d8 = null;
			if (state.flammable) {
				d8 = await new Roll("1d8").evaluate({ allowInteractive: false });
				await showRollAnimation(d8, requestingUser);
			}
			return finalizeDamage(message, state, target, caster, {
				damageRoll: boundedInteger(d10.total, 1, 10, "Fire Ball d10"),
				flammableRoll: d8 ? boundedInteger(d8.total, 1, 8, "Flammable d8") : 0,
				requestingUser,
			});
		}

		if (action === "damage-d10-override" || action === "damage-d8-override") {
			assertNoAppliedDamage(message, target, localize(
				"Revert applied Fire Ball damage before editing its dice.",
				"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą jej kości.",
			));
			if (!state.damage) throw new Error("Fire Ball damage has not been rolled yet.");
			const d10 = action === "damage-d10-override"
				? boundedInteger(extra.value, 1, 10, "Fire Ball d10")
				: Number(state.damage.damageRoll);
			const d8 = state.flammable
				? (action === "damage-d8-override"
					? boundedInteger(extra.value, 1, 8, "Flammable d8")
					: Number(state.damage.flammableRoll))
				: 0;
			return finalizeDamage(message, state, target, caster, {
				damageRoll: d10,
				flammableRoll: d8,
				requestingUser,
			});
		}

		if (action === "vulnerability") {
			assertNoAppliedDamage(message, target, localize(
				"Revert applied Fire Ball damage before changing vulnerabilities.",
				"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą podatności.",
			));
			const kind = String(extra.kind ?? "");
			if (!new Set(["flammable", "fearOfFire"]).has(kind)) {
				throw new Error("Unknown Fire Ball vulnerability adjudication.");
			}
			const value = extra.value === true;
			if (kind === "fearOfFire") {
				await reconcileFearVulnerability(state, target, value);
				state.fearOfFire = value;
			} else {
				state.flammable = value;
				if (state.damage) {
					await clearUnappliedDamage(message);
					state.damage = null;
					state.status = "awaiting-damage";
				}
			}
			state.updatedBy = String(requestingUser?.id ?? "");
			state.updatedAt = Date.now();
			await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			void ui.chat?.render?.({ force: true });
			return state;
		}

		throw new Error(`Unknown Fire Ball impact action '${action}'.`);
	} finally {
		activeActions.delete(key);
	}
}

async function rollInitiativeWithoutChat(actor) {
	const test = TestManager.get("i");
	if (!test) throw new Error("Initiative Test is not registered.");
	const context = new TestContext(actor, test, { modifier: 0, ruleEffects: [] });
	TestDialog.applyModifier(context, 0);
	RuleEffectRollSelection.applyToTestContext(context);
	return test.roll(context);
}

function initiativeSnapshot(result) {
	return {
		roll: Number(result.roll),
		originalRoll: Number(result.roll),
		target: Number(result.target),
		success: result.success === true,
		margin: Number(result.margin),
		overridden: false,
		overriddenBy: null,
		overriddenAt: null,
	};
}

async function finalizeDamage(message, state, target, caster, {
	damageRoll,
	flammableRoll,
	requestingUser,
}) {
	if (!state.initiative) throw new Error("Initiative must be resolved before damage.");
	await clearUnappliedDamage(message);
	const fullDamage = STRENGTH + Number(damageRoll) + (state.flammable ? Number(flammableRoll) : 0);
	const afterInitiative = state.initiative.success ? Math.floor(fullDamage / 2) : fullDamage;
	const toughness = nonNegativeInteger(target.getCharacteristicValue("t"), "Toughness");
	const packet = new DamagePacket({
		rawAmount: afterInitiative,
		targetActorUuid: target.uuid,
		source: {
			kind: "spell-fire-ball",
			id: `${state.castId || state.spellUuid}-ball-${state.ballNumber}-${target.id}-${foundry.utils.randomID(6)}`,
			uuid: state.spellUuid,
			label: state.spellName,
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const resolution = DamageResolver.resolve(packet, { toughness: { value: toughness } });
	await DamageChat.attach(message, { packet, resolution });
	state.status = "resolved";
	state.damage = {
		packetId: packet.id,
		damageRoll: Number(damageRoll),
		flammableRoll: state.flammable ? Number(flammableRoll) : 0,
		fullDamage,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
		rolledBy: String(requestingUser?.id ?? ""),
		rolledAt: state.damage?.rolledAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	state.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
	void ui.chat?.render?.({ force: true });
	return foundry.utils.deepFreeze(foundry.utils.deepClone(state));
}

async function clearUnappliedDamage(message) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damageState) return;
	const target = ActorRollPolicy.actorFromUuidSync(damageState.packet?.targetActorUuid);
	if (target && DamageApplication.transactionFor(target, damageState.packet?.id)?.state === "applied") {
		throw new Error(localize(
			"Revert applied damage before recalculating this Fire Ball hit.",
			"Cofnij zastosowane obrażenia przed ponownym obliczeniem tego trafienia Ognistej Kuli.",
		));
	}
	await message.unsetFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY);
}

function assertNoAppliedDamage(message, target, errorMessage) {
	if (damageTransaction(message, target)?.state === "applied") {
		throw new Error(errorMessage);
	}
}

async function reconcileFearVulnerability(state, target, nextValue) {
	const existing = fearRequestForState(state);
	if (nextValue) {
		const message = existing ?? await ensureFearRequest(state, target);
		state.fearRequestMessageId = String(message?.id ?? "");
		return;
	}
	if (!existing) {
		state.fearRequestMessageId = null;
		return;
	}
	const request = existing.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	if (request?.status === "resolved") {
		throw new Error(localize(
			"Fear of Fire has already been resolved; its vulnerability cannot be removed from this cast.",
			"Strach przed ogniem został już rozstrzygnięty; nie można usunąć tej podatności dla tego czaru.",
		));
	}
	await existing.delete();
	state.fearRequestMessageId = null;
}

async function ensureFearRequest(state, target) {
	const existing = fearRequestForState(state);
	if (existing) return existing;
	for (const message of game.messages ?? []) {
		const request = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
		if (
			request?.source?.kind === "spell-fire-ball" &&
			String(request.source?.castId ?? "") === String(state.castId ?? "") &&
			String(request.actorUuid ?? "") === String(target.uuid ?? "")
		) return message;
	}
	return ActorTestRequestWorkflow.create({
		actor: target,
		testId: "fear",
		title: localize("Fear of Fire", "Strach przed ogniem"),
		description: localize(
			`${target.name} is subject to fear of fire from ${state.spellName}.`,
			`${target.name} podlega strachowi przed ogniem wywołanemu przez ${state.spellName}.`,
		),
		source: {
			kind: "spell-fire-ball",
			spellUuid: String(state.spellUuid ?? ""),
			castId: String(state.castId ?? ""),
			targetUuid: String(target.uuid ?? ""),
		},
	});
}

function fearRequestForState(state) {
	const id = String(state?.fearRequestMessageId ?? "").trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function maybeQueueAutomatic(message, action, actor) {
	if (!ActorRollPolicy.shouldAutomaticallyRoll(actor, game.user)) return;
	const key = `${message.id}:auto:${action}`;
	if (queuedAutomatic.has(key)) return;
	queuedAutomatic.add(key);
	queueMicrotask(() => {
		void resolveAsAuthority(message, action, game.user)
			.catch(reportError)
			.finally(() => setTimeout(() => queuedAutomatic.delete(key), 250));
	});
}

function damageTransaction(message, target) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damageState?.packet?.id || !(target instanceof foundry.documents.Actor)) return null;
	return DamageApplication.transactionFor(target, damageState.packet.id);
}

function checkboxControl(text, checked, kind) {
	const label = document.createElement("label");
	label.className = "wfrp1ed-checkbox";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked === true;
	input.dataset.fireBallVulnerability = kind;
	label.append(input, document.createTextNode(text));
	return { label, input };
}

function actionButton(text) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button";
	button.textContent = text;
	return button;
}

function cardRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
}

function detailRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "combat-damage-context__row wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
}

function statusText(text) {
	const element = document.createElement("div");
	element.className = "combat-damage-context__status";
	element.textContent = text;
	return element;
}

async function showRollAnimation(roll, requestingUser) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, requestingUser ?? game.user, true);
	} catch (_error) {
		/* Dice animation is presentation-only. */
	}
}

function boundedInteger(value, minimum, maximum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return number;
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return number;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Fire Ball impact resolution failed.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to resolve Fire Ball impact.",
		"Nie udało się rozstrzygnąć trafienia Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

FireBallImpactWorkflow.install();