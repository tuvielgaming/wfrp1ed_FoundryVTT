import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { TestResultChat } from "./TestResultChat.mjs";
import { TestResultModifierToggle } from "./TestResultModifierToggle.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_STATE_FLAG_KEY = "testResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const RISK_STATE_FLAG_KEY = "riskConsequenceState";
const RISK_TEST_ID = "risk";
const RISK_STATE_VERSION = 1;
const syncQueues = new Map();

/*
 * WFRP 1e Core, Standard Tests — Risk:
 * - base chance 50%;
 * - every failed Risk Test causes D3 Wounds.
 *
 * A Risk consequence is deliberately attached to the same generic TestResult
 * ChatMessage. Damage calculation/application therefore continues through the
 * shared DamagePacket/DamageChat transaction boundary and inherits the normal
 * Apply Damage / Invalidate Damage actions instead of inventing a second Wounds
 * mutation path.
 */
installStableTestIdentity();
installAppliedDamageEditGuards();

Hooks.on("createChatMessage", (message) => {
	queueRiskSynchronization(message);
});

Hooks.on("updateChatMessage", (message) => {
	queueRiskSynchronization(message);
});

Hooks.on("preUpdateChatMessage", (message, changes) => {
	return guardAppliedRiskOutcomeChange(message, changes);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateRiskConsequence(message, html);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	for (const message of game.messages ?? []) {
		queueRiskSynchronization(message);
	}
});

function installStableTestIdentity() {
	if (TestResultChat.__wfrpStableTestIdentityInstalled === true) return;

	const originalSnapshot = TestResultChat._snapshot;
	TestResultChat._snapshot = function wrappedSnapshot(result) {
		const state = originalSnapshot.call(this, result);
		state.version = Math.max(3, Number(state.version) || 0);
		state.testId = String(result?.test?.id ?? "").trim();
		state.actorUuid = String(result?.actor?.uuid ?? "").trim();
		return state;
	};

	Object.defineProperty(
		TestResultChat,
		"__wfrpStableTestIdentityInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function installAppliedDamageEditGuards() {
	if (TestResultModifierToggle.__wfrpRiskDamageEditGuardInstalled !== true) {
		const originalCommitRollValue = TestResultModifierToggle.commitRollValue;
		TestResultModifierToggle.commitRollValue = async function wrappedCommitRollValue(
			message,
			value,
			requestingUser,
		) {
			const state = riskTestState(message);
			const requested = Number(value);
			if (
				state &&
				Number.isFinite(requested) &&
				Number.isInteger(requested) &&
				riskDamageIsApplied(message)
			) {
				const candidate = foundry.utils.deepClone(state);
				candidate.roll = Math.min(100, Math.max(1, requested));
				if (testSucceeded(candidate)) {
					throw new Error(appliedDamageLockMessage());
				}
			}

			return originalCommitRollValue.call(
				this,
				message,
				value,
				requestingUser,
			);
		};

		Object.defineProperty(
			TestResultModifierToggle,
			"__wfrpRiskDamageEditGuardInstalled",
			{ value: true, configurable: false, enumerable: false },
		);
	}

	if (TestResultChat.__wfrpRiskModifierEditGuardInstalled === true) return;

	const originalUpdateGeneralModifier = TestResultChat._updateGeneralModifier;
	TestResultChat._updateGeneralModifier = async function wrappedGeneralModifier(
		message,
		input,
	) {
		const state = riskTestState(message);
		const requested = Number(String(input?.value ?? "").trim());
		if (state && Number.isFinite(requested) && riskDamageIsApplied(message)) {
			const candidate = foundry.utils.deepClone(state);
			candidate.generalModifier = {
				...(candidate.generalModifier ?? {}),
				value: requested,
			};
			if (testSucceeded(candidate)) {
				if (input) {
					input.value = String(state.generalModifier?.value ?? 0);
				}
				ui.notifications.warn(appliedDamageLockMessage());
				return;
			}
		}

		return originalUpdateGeneralModifier.call(this, message, input);
	};

	Object.defineProperty(
		TestResultChat,
		"__wfrpRiskModifierEditGuardInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function queueRiskSynchronization(message) {
	if (!isPrimaryActiveGm() || !message?.id) return;
	if (!riskTestState(message)) return;

	const id = String(message.id);
	const previous = syncQueues.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => synchronizeRiskMessage(message))
		.catch((error) => {
			console.error("WFRP1ED | Risk consequence synchronization failed.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to synchronize the Risk consequence.",
					"Nie udało się zsynchronizować konsekwencji Testu Ryzyka.",
				),
			);
		})
		.finally(() => {
			if (syncQueues.get(id) === next) syncQueues.delete(id);
		});

	syncQueues.set(id, next);
}

async function synchronizeRiskMessage(message) {
	const testState = riskTestState(message);
	if (!testState) return;

	const actor = await actorForTestState(testState);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(
			`Risk consequence Actor '${String(testState.actorUuid ?? "")}' is unavailable.`,
		);
	}

	const failure = !testSucceeded(testState);
	let consequence = mutableRiskState(message);

	if (!failure) {
		if (!consequence) return;
		await suppressRiskConsequence(message, actor, consequence);
		return;
	}

	if (!consequence) {
		consequence = await createRiskConsequenceState(message, actor);
		await message.setFlag(
			FLAG_SCOPE,
			RISK_STATE_FLAG_KEY,
			foundry.utils.deepClone(consequence),
		);
	}

	if (consequence.active !== true) {
		const previousTransaction = DamageApplication.transactionFor(
			actor,
			consequence.packetId,
		);

		/*
		 * A deliberately reverted packet remains immutable history. If later
		 * adjudication makes the same Risk Test a failure again, preserve the
		 * original D3 result but issue a new packet id so the shared damage layer
		 * can represent the newly-active consequence independently.
		 */
		if (previousTransaction?.state === "reverted") {
			consequence.packetId = foundry.utils.randomID();
			consequence.generation = Math.max(1, Number(consequence.generation) || 1) + 1;
		}

		consequence.active = true;
		consequence.activatedAt = Date.now();
		consequence.suppressedAt = null;
		await message.setFlag(
			FLAG_SCOPE,
			RISK_STATE_FLAG_KEY,
			foundry.utils.deepClone(consequence),
		);
	}

	const existingDamage = message.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_STATE_FLAG_KEY,
	);

	if (existingDamage?.packet) {
		if (String(existingDamage.packet.id ?? "") === String(consequence.packetId)) {
			return;
		}

		throw new Error(
			"The Risk Test message already contains unrelated damage data; refusing to overwrite it.",
		);
	}

	await attachRiskDamage(message, actor, testState, consequence);
}

async function createRiskConsequenceState(message, actor) {
	const roll = await new Roll("1d3").evaluate({ allowInteractive: false });
	const die = Number(roll.total);
	if (!Number.isInteger(die) || die < 1 || die > 3) {
		throw new Error(`Risk consequence D3 must be 1-3: ${String(roll.total)}.`);
	}

	return {
		version: RISK_STATE_VERSION,
		actorUuid: actor.uuid,
		testMessageId: String(message.id ?? ""),
		die,
		packetId: foundry.utils.randomID(),
		generation: 1,
		active: true,
		rolledAt: Date.now(),
		activatedAt: Date.now(),
		suppressedAt: null,
	};
}

async function attachRiskDamage(message, actor, testState, consequence) {
	const packet = new DamagePacket({
		id: consequence.packetId,
		rawAmount: consequence.die,
		targetActorUuid: actor.uuid,
		source: {
			kind: "standard-test",
			id: RISK_TEST_ID,
			uuid: message.uuid,
			label: String(testState.testName ?? localize("Risk", "Ryzyko")),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		createdAt: Number(consequence.rolledAt) || Date.now(),
	});
	const resolution = DamageResolver.resolve(packet);
	await DamageChat.attach(message, { packet, resolution });
}

async function suppressRiskConsequence(message, actor, consequence) {
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const packetId = String(consequence.packetId ?? "");
	const transaction = packetId
		? DamageApplication.transactionFor(actor, packetId)
		: null;

	if (transaction?.state === "applied") {
		/*
		 * preUpdate guards should make this unreachable. Do not attempt a blind
		 * automatic Wounds rollback here: later damage or Critical transactions
		 * may depend on the applied packet.
		 */
		throw new Error(appliedDamageLockMessage());
	}

	if (
		damageState?.packet &&
		String(damageState.packet.id ?? "") === packetId
	) {
		await message.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	}

	if (consequence.active === true) {
		consequence.active = false;
		consequence.suppressedAt = Date.now();
		await message.setFlag(
			FLAG_SCOPE,
			RISK_STATE_FLAG_KEY,
			foundry.utils.deepClone(consequence),
		);
	}
}

function guardAppliedRiskOutcomeChange(message, changes) {
	const current = riskTestState(message);
	if (!current || !riskDamageIsApplied(message)) return true;

	const candidate = changedTestState(changes);
	if (!candidate || String(candidate.testId ?? "") !== RISK_TEST_ID) return true;
	if (!testSucceeded(candidate)) return true;

	ui.notifications.warn(appliedDamageLockMessage());
	setTimeout(() => {
		void ui.chat?.render?.({ force: true });
	}, 0);
	return false;
}

function decorateRiskConsequence(message, html) {
	const testState = riskTestState(message);
	const consequence = mutableRiskState(message);
	if (!testState || !consequence?.active) return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-risk-consequence]")?.remove();

	const actor = actorFromUuidSync(consequence.actorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, consequence.packetId)
		: null;
	const applied = transaction?.state === "applied";
	const reverted = transaction?.state === "reverted";

	const block = document.createElement("section");
	block.classList.add("wfrp1e-risk-consequence");
	block.dataset.wfrpRiskConsequence = "";
	if (applied) block.classList.add("is-applied");
	if (reverted) block.classList.add("is-reverted");

	const heading = document.createElement("strong");
	heading.classList.add("wfrp1e-risk-consequence__heading");
	heading.textContent = localize(
		"Risk consequence",
		"Konsekwencja Testu Ryzyka",
	);

	const value = document.createElement("span");
	value.classList.add("wfrp1e-risk-consequence__value");
	value.textContent = localize(
		`D3 = ${consequence.die} Wound${Number(consequence.die) === 1 ? "" : "s"}`,
		`K3 = ${consequence.die} obrażenia`,
	);

	const status = document.createElement("span");
	status.classList.add("wfrp1e-risk-consequence__status");
	status.textContent = applied
		? localize("Applied", "Zastosowano")
		: reverted
			? localize("Reverted", "Cofnięto")
			: localize(
				"Pending — right-click the message to apply damage",
				"Oczekuje — kliknij PPM na wiadomości, aby zastosować obrażenia",
			);

	block.append(heading, value, status);

	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(block);
	else card.append(block);

	if (applied) lockRiskMechanicalControls(card);
}

function lockRiskMechanicalControls(card) {
	const title = appliedDamageLockMessage();
	for (const input of card.querySelectorAll([
		"[data-wfrp-test-roll-value]",
		"[data-wfrp-test-general-modifier]",
		"[data-wfrp-test-modifier-toggle]",
	].join(", "))) {
		if (!(input instanceof HTMLInputElement)) continue;
		if (input.type === "checkbox") input.disabled = true;
		else input.readOnly = true;
		input.title = title;
	}
}

function riskTestState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_STATE_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		String(state.testId ?? "") === RISK_TEST_ID
			? state
			: null;
}

function mutableRiskState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, RISK_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? foundry.utils.deepClone(state)
		: null;
}

function changedTestState(changes) {
	const direct = changes?.flags?.[FLAG_SCOPE]?.[TEST_STATE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) {
		return direct;
	}

	const flat = changes?.[`flags.${FLAG_SCOPE}.${TEST_STATE_FLAG_KEY}`];
	return flat && typeof flat === "object" && !Array.isArray(flat)
		? flat
		: null;
}

function testSucceeded(state) {
	return TestResultChat._templateContext(state)?.result?.success === true;
}

function riskDamageIsApplied(message) {
	const consequence = mutableRiskState(message);
	if (!consequence?.packetId) return false;
	const actor = actorFromUuidSync(consequence.actorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return DamageApplication.transactionFor(
		actor,
		consequence.packetId,
	)?.state === "applied";
}

async function actorForTestState(state) {
	const uuid = String(state?.actorUuid ?? "").trim();
	if (!uuid) return null;
	try {
		const actor = await foundry.utils.fromUuid(uuid);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function actorFromUuidSync(uuid) {
	try {
		const actor = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function isPrimaryActiveGm() {
	return primaryActiveGm()?.id === game.user?.id;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function appliedDamageLockMessage() {
	return localize(
		"This failed Risk Test already has applied damage. Invalidate that damage first before changing the result into a success.",
		"Obrażenia z tego nieudanego Testu Ryzyka zostały już zastosowane. Najpierw użyj „Unieważnij obrażenia”, zanim zmienisz wynik testu na sukces.",
	);
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") {
		return value;
	}
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") {
		return value[0];
	}
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
