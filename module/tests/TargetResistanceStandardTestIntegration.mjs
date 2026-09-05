import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { decorateTestIdentity } from "../chat/TestResultIdentityChat.mjs";
import { ActorTestRequestWorkflow } from "./ActorTestRequestWorkflow.mjs";
import { PendingStandardTest } from "./PendingStandardTest.mjs";
import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { TEST_OUTCOME_MODE } from "./Test.mjs";
import { TestManager } from "./TestManager.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const REQUEST_FLAG_KEY = "actorTestRequest";
const RESULT_SOURCE_FLAG_KEY = "actorTestRequestSource";
const TEST_RESULT_FLAG_KEY = "testResultState";
const SOURCE_KIND = "standard-target-resistance";

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
 * The request ChatMessage is deliberately spoken by the initiating Actor. It is
 * the authoritative procedure card: Test + target while pending, and the final
 * procedure SUCCESS/FAILURE after the target resistance resolves. Its identity
 * header reuses the exact shared renderer used by verified Test/Attack cards.
 *
 * ActorTestRequestWorkflow already owns socket authority and the shared
 * Automatic GM Rolls policy for Actors with no non-GM OWNER.
 *
 * A raw target characteristic remains a deliberate fallback when no Actor is
 * available. In that case the existing target-resistance Test executes directly
 * and its card is annotated with the inverse success condition.
 */
installInitialDialogDispatch();
installPendingTargetDispatch();
registerResistancePresentation();
registerLinkedResultRefresh();

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
			/* Manual/raw target-value fallback remains on the existing direct path. */
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
		testOptions: resistanceTestOptions(options),
		source: {
			kind: SOURCE_KIND,
			procedureTestId: String(test.id),
			initiatorActorUuid: String(initiator.uuid ?? ""),
			initiatorName: String(initiator.name ?? ""),
			targetActorUuid: String(target.uuid ?? ""),
			targetName: String(target.name ?? ""),
			resistanceCharacteristicId: characteristicId,
		},
	});
}

function resistanceTestOptions(options = {}) {
	const result = {
		modifier: finiteNumber(options?.modifier, 0),
	};

	if (options?.resultVisibility !== undefined) {
		result.resultVisibility = options.resultVisibility;
	}

	/*
	 * Do not copy ordinary initiator-side Skill modifiers or Active Effects onto
	 * the target Actor. Target-side modifiers such as Torture belong to their own
	 * audited executor and will be attached explicitly when that rule is enabled.
	 */
	return result;
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

function registerLinkedResultRefresh() {
	Hooks.on("updateChatMessage", (message, changes) => {
		const provenance = message?.getFlag?.(FLAG_SCOPE, RESULT_SOURCE_FLAG_KEY);
		if (!resistanceSource(provenance?.source)) return;
		if (!testResultChanged(changes)) return;
		void ui.chat?.render?.({ force: true });
	});
}

function procedureOutcomeFromRequest(requestState) {
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
