import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { decorateTestIdentity } from "../chat/TestResultIdentityChat.mjs";
import { ActorTestRequestWorkflow } from "./ActorTestRequestWorkflow.mjs";
import { PendingStandardTest } from "./PendingStandardTest.mjs";
import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { StandardTestSkillResolver } from "./StandardTestSkillResolver.mjs";
import { TEST_OUTCOME_MODE } from "./Test.mjs";
import { TestManager } from "./TestManager.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const REQUEST_FLAG_KEY = "actorTestRequest";
const RESULT_SOURCE_FLAG_KEY = "actorTestRequestSource";
const TEST_RESULT_FLAG_KEY = "testResultState";
const SOURCE_KIND = "standard-target-resistance";
const TARGET_SKILL_MODIFIER_PREFIX = "target-skill:";
const procedurePresentationFinalizers = new Set();

/*
 * WFRP 1e target-resistance Standard Tests (currently Hypnotism and
 * Interrogate) belong to the target Actor, not to the character initiating the
 * procedure. Core instructs the GM to test the victim's Will Power. A
 * successful resistance means the procedure fails; a failed resistance means
 * the procedure succeeds.
 *
 * When a real target Actor exists, route the resistance through the existing
 * ActorTestRequestWorkflow. This gives us the same interaction boundary as
 * combat defence without copying combat-only Parry/Dodge resource logic:
 *
 *   initiator chooses target -> target OWNER/GM rolls its characteristic
 *   -> target TestResult remains fully editable/auditable
 *   -> procedure outcome is derived from the linked resistance result.
 *
 * Target-characteristic Skill effects are resolved from the initiating Actor
 * but applied to the target's actual resistance Test. This is the exact model
 * required by Torture: the torturer owns the Skill, while the victim rolls the
 * reduced Will Power. The modifier is shown in the existing Applicable Skills
 * section before the roll, enabled by default, and remains an ordinary persisted
 * `skill` modifier on the target TestResult afterward. The same verified
 * checkbox/adjudication workflow therefore applies before and after the roll.
 *
 * The request ChatMessage is deliberately spoken by the initiating Actor. It is
 * the authoritative procedure card: Test + target while pending, and the final
 * procedure SUCCESS/FAILURE after the target resistance resolves. Its identity
 * header reuses the exact shared renderer used by verified Test/Attack cards.
 *
 * The initial procedure outcome is presentation-gated by the target Test's Dice
 * So Nice animation. The target TestResult remains authoritative immediately,
 * but the initiator card does not reveal SUCCESS/FAILURE until that physical
 * roll has finished. Later manual adjudication is not delayed because there is
 * no new dice animation to wait for.
 *
 * Post-roll adjudication follows the same reconciliation principle as combat:
 * the target TestResult remains the source of truth, while the primary GM
 * persists the derived procedureSuccess state back onto the linked request
 * message. Updating that authoritative message makes Foundry rerender it for
 * every client; a global chat rerender is not used as state synchronization.
 *
 * ActorTestRequestWorkflow already owns socket authority and the shared
 * Automatic GM Rolls policy for Actors with no non-GM OWNER.
 *
 * A raw target characteristic remains a deliberate fallback when no Actor is
 * available. In that case the existing target-resistance Test executes directly
 * and carries the same selected target-characteristic Skill modifier snapshot.
 */
installTargetCharacteristicSkillDialogBridge();
installInitialDialogDispatch();
installPendingTargetDispatch();
registerResistancePresentation();
registerLinkedResultReconciliation();
registerResolvedProcedurePresentationBarrier();

function installTargetCharacteristicSkillDialogBridge() {
	if (StandardTestDialog.__wfrpTargetCharacteristicSkillBridgeInstalled === true) {
		return;
	}

	const originalSkillModifierForEffect = StandardTestDialog._skillModifierForEffect;
	const originalRenderSkillSection = StandardTestDialog._renderSkillSection;

	StandardTestDialog._skillModifierForEffect = function (candidate, effect) {
		const ordinary = originalSkillModifierForEffect.call(this, candidate, effect);
		if (ordinary) return ordinary;
		return targetSkillModifierForEffect(candidate, effect);
	};

	/*
	 * The generic Skill row says only "<Skill> +/-N", which is correct for an
	 * actor-side modifier but misleading for target-characteristic effects.
	 * Keep the underlying modifier source unchanged (so the target's resolved
	 * defence card still simply says "Torture -10") and clarify only the
	 * pre-roll launcher label.
	 */
	StandardTestDialog._renderSkillSection = function (section, actor, entry) {
		originalRenderSkillSection.call(this, section, actor, entry);
		decorateTargetCharacteristicSkillRows(section, actor, entry);
	};

	Object.defineProperty(
		StandardTestDialog,
		"__wfrpTargetCharacteristicSkillBridgeInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function decorateTargetCharacteristicSkillRows(section, actor, entry) {
	if (!(section instanceof HTMLElement) || entry?.kind !== "test") return;

	const candidates = StandardTestSkillResolver.candidates(actor, entry.id);
	const bySkillId = new Map(
		candidates.map((candidate) => [candidate.rulesId, candidate]),
	);

	for (const input of section.querySelectorAll(
		"input[data-standard-skill-modifier]",
	)) {
		const skillId = String(input.dataset.skillId ?? "").trim();
		const effectIndex = Number(input.dataset.effectIndex);
		const candidate = bySkillId.get(skillId);
		const effect = Number.isInteger(effectIndex)
			? candidate?.effects?.[effectIndex]
			: null;

		if (effect?.type !== "target-characteristic-modifier") continue;

		const text = input.closest("label")?.querySelector("span");
		if (!(text instanceof HTMLElement)) continue;

		text.textContent = targetSkillDialogLabel(candidate, effect);
	}
}

function targetSkillDialogLabel(candidate, effect) {
	const name = String(candidate?.name ?? candidate?.rulesId ?? "");
	const characteristic = characteristicName(effect?.characteristic);
	const value = signedNumber(effect?.value);

	return localize(
		`${name}: target ${characteristic} ${value}`,
		`${name}: ${characteristic} celu ${value}`,
	);
}

function installInitialDialogDispatch() {
	if (StandardTestDialog.__wfrpTargetResistanceDispatchInstalled === true) return;

	const originalConfigure = StandardTestDialog.configure;
	StandardTestDialog.configure = async function (actor) {
		const configured = await originalConfigure.call(this, actor);
		if (!configured?.testId) return configured;

		const test = TestManager.get(configured.testId);
		if (!isTargetResistanceTest(test)) return configured;

		const target = asActor(
			configured.options?.target ?? configured.options?.targetActor,
		);
		if (!target) {
			/* Manual/raw target-value fallback remains on the existing direct path.
			 * The Standard Test dialog already persisted the user's target-side Skill
			 * checkbox selection into options.modifiers. */
			return configured;
		}

		await createResistanceRequest({
			initiator: actor,
			target,
			test,
			options: configured.options,
		});
		return null;
	};

	Object.defineProperty(
		StandardTestDialog,
		"__wfrpTargetResistanceDispatchInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function installPendingTargetDispatch() {
	if (PendingStandardTest.__wfrpTargetResistanceDispatchInstalled === true) return;

	const originalExecute = PendingStandardTest._execute;
	PendingStandardTest._execute = async function (message, request, resolution) {
		const test = TestManager.get(String(request?.testId ?? ""));
		const target = asActor(resolution?.target);
		if (!isTargetResistanceTest(test) || !target) {
			return originalExecute.call(this, message, request, resolution);
		}

		const initiator = ActorRollPolicy.actorFromUuidSync(request?.actorUuid);
		if (!initiator) {
			throw new Error(
				"The Actor which initiated this resistance procedure is no longer available.",
			);
		}

		await createResistanceRequest({
			initiator,
			target,
			test,
			options: request?.options ?? {},
		});
		await message.delete();
		return null;
	};

	Object.defineProperty(
		PendingStandardTest,
		"__wfrpTargetResistanceDispatchInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function createResistanceRequest({ initiator, target, test, options }) {
	if (!(initiator instanceof foundry.documents.Actor)) {
		throw new Error("Target-resistance procedure requires an initiating Actor.");
	}
	if (!(target instanceof foundry.documents.Actor)) {
		throw new Error("Target-resistance procedure requires a target Actor.");
	}

	const characteristicId = resistanceCharacteristicId(test);

	return ActorTestRequestWorkflow.create({
		actor: target,
		speakerActor: initiator,
		testId: characteristicId,
		title: String(test.name),
		description: "",
		testOptions: resistanceTestOptions(initiator, test, options),
		source: {
			kind: SOURCE_KIND,
			procedureTestId: String(test.id),
			initiatorActorUuid: String(initiator.uuid ?? ""),
			initiatorName: String(initiator.name ?? ""),
			targetActorUuid: String(target.uuid ?? ""),
			targetName: String(target.name ?? ""),
			resistanceCharacteristicId: characteristicId,
			deferProcedureOutcomeUntilDiceComplete: true,
		},
	});
}

function resistanceTestOptions(initiator, test, options = {}) {
	const result = {
		modifier: finiteNumber(options?.modifier, 0),
	};

	if (options?.resultVisibility !== undefined) {
		result.resultVisibility = options.resultVisibility;
	}

	/* Do not copy ordinary initiator-side Skill modifiers or Active Effects onto
	 * the target Actor. Carry only target-side Skill choices made in the Standard
	 * Test dialog. Programmatic/legacy callers without a modifiers snapshot fall
	 * back to the audited default set. */
	const modifiers = selectedTargetCharacteristicSkillModifiers(
		initiator,
		test,
		options,
	);
	if (modifiers.length > 0) {
		result.modifiers = modifiers;
	}

	return result;
}

function selectedTargetCharacteristicSkillModifiers(initiator, test, options) {
	if (Array.isArray(options?.modifiers)) {
		return options.modifiers
			.filter((modifier) =>
				String(modifier?.id ?? "").startsWith(TARGET_SKILL_MODIFIER_PREFIX),
			)
			.map((modifier) => ({
				id: String(modifier.id),
				value: Number(modifier.value),
				source: String(modifier.source ?? ""),
				type: "skill",
				enabled: modifier.enabled !== false,
			}))
			.filter((modifier) => Number.isFinite(modifier.value));
	}

	return targetCharacteristicSkillModifiers(initiator, test);
}

function targetCharacteristicSkillModifiers(initiator, test) {
	if (!(initiator instanceof foundry.documents.Actor) || !test) return [];

	const characteristicId = resistanceCharacteristicId(test);
	const modifiers = [];

	for (const candidate of StandardTestSkillResolver.candidates(
		initiator,
		String(test.id),
	)) {
		for (const effect of candidate.effects) {
			if (
				effect?.type !== "target-characteristic-modifier" ||
				effect.condition ||
				String(effect.characteristic ?? "").trim().toLowerCase() !== characteristicId
			) {
				continue;
			}

			const modifier = targetSkillModifierForEffect(candidate, effect);
			if (modifier) modifiers.push(modifier);
		}
	}

	return modifiers;
}

function targetSkillModifierForEffect(candidate, effect) {
	if (
		!candidate ||
		!effect ||
		effect.condition ||
		effect.type !== "target-characteristic-modifier"
	) {
		return null;
	}

	const value = Number(effect.value);
	if (!Number.isFinite(value)) {
		throw new Error(
			`Invalid target-characteristic Skill modifier for '${candidate.rulesId}'.`,
		);
	}

	return {
		id: `${TARGET_SKILL_MODIFIER_PREFIX}${candidate.rulesId}:${String(effect.testId ?? "")}:${String(effect.characteristic ?? "").trim().toLowerCase()}`,
		value,
		source: String(candidate.name ?? candidate.rulesId),
		type: "skill",
		enabled: true,
	};
}

function registerResistancePresentation() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		requestAnimationFrame(() => requestAnimationFrame(() => {
			decorateResistanceRequest(message, html);
			decorateResistanceResult(message, html);
			decorateManualFallback(message, html);
		}));
	});
}

function decorateResistanceRequest(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, REQUEST_FLAG_KEY);
	const source = resistanceSource(state?.source);
	if (!state || !source) return;

	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-actor-test-request]")
		? root
		: root?.querySelector?.("[data-wfrp-actor-test-request]");
	if (!(panel instanceof HTMLElement)) return;

	const test = TestManager.get(source.procedureTestId);
	const procedureName = test?.name ?? source.procedureTestId;
	const targetName = String(source.targetName ?? state.actorName ?? "—");
	const initiator = ActorRollPolicy.actorFromUuidSync(source.initiatorActorUuid);
	const existingButton = panel.querySelector("button");

	panel.replaceChildren();
	panel.classList.add(
		"wfrp1e-test-card",
		"wfrp1e-target-resistance-procedure-card",
	);
	panel.classList.remove("is-success", "is-failure");

	const header = document.createElement("header");
	header.classList.add("wfrp1e-test-card__header");
	const title = document.createElement("h2");
	title.textContent = procedureName;
	header.append(title);
	panel.append(header);

	/* Reuse the canonical portrait + Test/Target identity component instead of
	 * maintaining a second look-alike card implementation for procedures. */
	decorateTestIdentity(message, panel, {
		actor: initiator,
		displayName: procedureName,
		targetName,
	});

	if (state.status === "resolved") {
		const outcome = procedureOutcomeFromRequest(state);
		if (outcome !== null) {
			panel.classList.add(outcome ? "is-success" : "is-failure");
			const status = document.createElement("span");
			status.classList.add("wfrp1e-test-card__status");
			status.textContent = outcomeLabel(outcome);
			header.append(status);
		}
		return;
	}

	if (existingButton instanceof HTMLButtonElement) {
		existingButton.textContent = localize(
			`${targetName} — Roll defence`,
			`${targetName} — Rzuć obronę`,
		);
		if (!existingButton.disabled) {
			existingButton.title = localize(
				`Roll ${characteristicName(source.resistanceCharacteristicId)} resistance for ${targetName}.`,
				`Rzuć test obronny ${characteristicName(source.resistanceCharacteristicId)} dla ${targetName}.`,
			);
		}
		existingButton.classList.add("wfrp1e-target-resistance-procedure-action");
		const controls = document.createElement("div");
		controls.classList.add("wfrp1e-test-card__breakdown");
		controls.append(existingButton);
		panel.append(controls);
	}
}

function decorateResistanceResult(message, html) {
	const provenance = message?.getFlag?.(FLAG_SCOPE, RESULT_SOURCE_FLAG_KEY);
	const source = resistanceSource(provenance?.source);
	if (!source) return;

	const state = message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	const test = TestManager.get(source.procedureTestId);
	const procedureName = test?.name ?? source.procedureTestId;
	const characteristic = characteristicName(source.resistanceCharacteristicId);

	const displayName = card.querySelector("[data-wfrp-test-display-name]");
	const title = displayName ?? card.querySelector(".wfrp1e-test-card__header h2");
	if (title) {
		title.textContent = localize(
			`Resistance to ${procedureName} — ${characteristic}`,
			`Obrona przed ${procedureName} — ${characteristic}`,
		);
	}
}

function decorateManualFallback(message, html) {
	if (message?.getFlag?.(FLAG_SCOPE, RESULT_SOURCE_FLAG_KEY)) return;
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	if (String(state?.outcomeMode ?? "") !== TEST_OUTCOME_MODE.TARGET_RESISTANCE) return;

	const test = TestManager.get(String(state?.testId ?? ""));
	if (!test || !isTargetResistanceTest(test)) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;
	if (card.querySelector("[data-wfrp-target-resistance-manual-note]")) return;

	const characteristic = characteristicName(resistanceCharacteristicId(test));
	const note = document.createElement("div");
	note.dataset.wfrpTargetResistanceManualNote = "";
	note.classList.add("wfrp1e-test-card__breakdown");
	note.textContent = localize(
		`${test.name} succeeds if the target fails its ${characteristic} Test.`,
		`${test.name} kończy się sukcesem, jeśli cel nie zda Testu ${characteristic}.`,
	);
	card.querySelector(".wfrp1e-test-card__header")?.insertAdjacentElement(
		"afterend",
		note,
	);
}

function registerLinkedResultReconciliation() {
	Hooks.on("updateChatMessage", (message, changes) => {
		const provenance = message?.getFlag?.(FLAG_SCOPE, RESULT_SOURCE_FLAG_KEY);
		if (!resistanceSource(provenance?.source)) return;
		if (!testResultChanged(changes)) return;
		if (!ActorRollPolicy.isPrimaryActiveGM()) return;

		void reconcileLinkedProcedureOutcome(message, provenance).catch((error) => {
			console.error(
				"WFRP1ED | Unable to reconcile target-resistance procedure outcome.",
				error,
			);
		});
	});
}

function registerResolvedProcedurePresentationBarrier() {
	Hooks.on("updateChatMessage", (message) => {
		queueResolvedProcedurePresentation(message);
	});

	Hooks.once("ready", () => {
		if (!ActorRollPolicy.isPrimaryActiveGM()) return;
		for (const message of game.messages ?? []) {
			queueResolvedProcedurePresentation(message);
		}
	});
}

function queueResolvedProcedurePresentation(message) {
	if (!ActorRollPolicy.isPrimaryActiveGM()) return;

	const state = message?.getFlag?.(FLAG_SCOPE, REQUEST_FLAG_KEY);
	const source = resistanceSource(state?.source);
	if (
		!state ||
		source?.deferProcedureOutcomeUntilDiceComplete !== true ||
		state.status !== "resolved" ||
		state.presentationReady === true
	) {
		return;
	}

	void finalizeProcedurePresentationAfterDice(message).catch((error) => {
		console.error(
			"WFRP1ED | Unable to finalize target-resistance procedure presentation.",
			error,
		);
	});
}

async function finalizeProcedurePresentationAfterDice(requestMessage) {
	const key = String(requestMessage?.id ?? "").trim();
	if (!key || procedurePresentationFinalizers.has(key)) return;
	procedurePresentationFinalizers.add(key);

	try {
		const initialState = requestMessage.getFlag?.(
			FLAG_SCOPE,
			REQUEST_FLAG_KEY,
		);
		const resultMessageId = String(initialState?.resultMessageId ?? "").trim();
		if (!resultMessageId) return;

		const resultMessage = game.messages?.get(resultMessageId);
		if (!resultMessage) return;

		await waitForMessageDiceAnimation(resultMessage);

		const currentRequestMessage = game.messages?.get(key);
		if (!currentRequestMessage) return;

		const currentRequestState = foundry.utils.deepClone(
			currentRequestMessage.getFlag?.(FLAG_SCOPE, REQUEST_FLAG_KEY) ?? {},
		);
		const currentSource = resistanceSource(currentRequestState?.source);
		if (
			currentSource?.deferProcedureOutcomeUntilDiceComplete !== true ||
			currentRequestState.status !== "resolved" ||
			currentRequestState.presentationReady === true
		) {
			return;
		}

		const currentResultMessage = game.messages?.get(
			String(currentRequestState.resultMessageId ?? ""),
		);
		const currentResultState = currentResultMessage?.getFlag?.(
			FLAG_SCOPE,
			TEST_RESULT_FLAG_KEY,
		);
		if (!currentResultState) return;

		currentRequestState.procedureSuccess = !currentTestSuccess(currentResultState);
		currentRequestState.presentationReady = true;
		currentRequestState.presentationReadyBy = String(game.user?.id ?? "");
		currentRequestState.presentationReadyAt = Date.now();

		await currentRequestMessage.setFlag(
			FLAG_SCOPE,
			REQUEST_FLAG_KEY,
			currentRequestState,
		);
	} finally {
		procedurePresentationFinalizers.delete(key);
	}
}

async function waitForMessageDiceAnimation(message) {
	const dice3d = game.dice3d;
	if (!dice3d) return;

	const messageId = String(message?.id ?? "").trim();
	if (!messageId) return;

	/*
	 * Same verified Dice So Nice barrier used by RiskConsequenceDiceAnimation.
	 * The v6 API resolves correctly even if the animation has already completed.
	 */
	if (typeof dice3d.waitFor3DAnimationByMessageID === "function") {
		await dice3d.waitFor3DAnimationByMessageID(messageId);
		return;
	}

	await new Promise((resolve) => {
		let hookId = null;
		let timeoutId = null;
		const finish = () => {
			if (hookId !== null) Hooks.off("diceSoNiceRollComplete", hookId);
			if (timeoutId !== null) clearTimeout(timeoutId);
			resolve();
		};

		hookId = Hooks.on("diceSoNiceRollComplete", (...ids) => {
			if (containsMessageId(ids, messageId)) finish();
		});

		/* Safety only: optional 3D presentation must never block the procedure. */
		timeoutId = setTimeout(finish, 10000);
	});
}

function containsMessageId(values, messageId) {
	for (const value of values ?? []) {
		if (Array.isArray(value)) {
			if (containsMessageId(value, messageId)) return true;
			continue;
		}
		if (String(value ?? "") === messageId) return true;
	}
	return false;
}

async function reconcileLinkedProcedureOutcome(resultMessage, provenance) {
	const resultState = resultMessage?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	if (!resultState) return;

	const requestMessageId = String(provenance?.requestMessageId ?? "").trim();
	if (!requestMessageId) return;
	const requestMessage = game.messages?.get(requestMessageId);
	if (!requestMessage) return;

	const requestState = foundry.utils.deepClone(
		requestMessage.getFlag?.(FLAG_SCOPE, REQUEST_FLAG_KEY) ?? {},
	);
	if (!resistanceSource(requestState?.source)) return;
	if (
		String(requestState.resultMessageId ?? "") &&
		String(requestState.resultMessageId) !== String(resultMessage.id ?? "")
	) {
		return;
	}

	const procedureSuccess = !currentTestSuccess(resultState);
	if (requestState.procedureSuccess === procedureSuccess) return;

	requestState.procedureSuccess = procedureSuccess;
	requestState.reconciledBy = String(game.user?.id ?? "");
	requestState.reconciledAt = Date.now();
	await requestMessage.setFlag(FLAG_SCOPE, REQUEST_FLAG_KEY, requestState);
}

function procedureOutcomeFromRequest(requestState) {
	const source = resistanceSource(requestState?.source);
	if (
		source?.deferProcedureOutcomeUntilDiceComplete === true &&
		requestState?.presentationReady !== true
	) {
		return null;
	}

	if (typeof requestState?.procedureSuccess === "boolean") {
		return requestState.procedureSuccess;
	}

	/* Backwards compatibility for already-created requests from before persisted
	 * reconciliation existed. Their first render can still derive the outcome
	 * from the linked result; any later adjudication persists procedureSuccess. */
	const messageId = String(requestState?.resultMessageId ?? "").trim();
	if (!messageId) return null;
	const resultMessage = game.messages?.get(messageId);
	const resultState = resultMessage?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	if (!resultState) return null;
	return !currentTestSuccess(resultState);
}

function currentTestSuccess(state) {
	try {
		return TestResultChat._templateContext(state).result.success === true;
	} catch (_error) {
		return false;
	}
}

function isTargetResistanceTest(test) {
	return Boolean(
		test &&
		String(test.outcomeMode ?? "") === TEST_OUTCOME_MODE.TARGET_RESISTANCE,
	);
}

function resistanceCharacteristicId(test) {
	const formula = String(test?.formula ?? "").trim();
	const match = formula.match(/^target\.([A-Za-z][A-Za-z0-9]*)$/);
	if (!match) {
		throw new Error(
			`Target-resistance Test '${String(test?.id ?? "unknown")}' must use one direct target characteristic formula.`,
		);
	}
	return String(match[1]).toLowerCase();
}

function resistanceSource(source) {
	return source?.kind === SOURCE_KIND ? source : null;
}

function asActor(value) {
	if (value instanceof foundry.documents.Actor) return value;
	if (value?.actor instanceof foundry.documents.Actor) return value.actor;
	if (typeof value === "string" && value.trim()) {
		return ActorRollPolicy.actorFromUuidSync(value);
	}
	return null;
}

function characteristicName(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	const key = `WFRP1ed.CHAR.${normalized === "m" ? "sp" : normalized}`;
	const localized = game.i18n.localize(key);
	return localized !== key ? localized : normalized.toUpperCase();
}

function signedNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return String(value ?? "");
	return number >= 0 ? `+${number}` : String(number);
}

function outcomeLabel(success) {
	return success
		? localize("SUCCESS", "SUKCES")
		: localize("FAILURE", "PORAŻKA");
}

function testResultChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function finiteNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
