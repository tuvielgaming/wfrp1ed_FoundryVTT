import { GMGameplayNotice } from "../chat/GMGameplayNotice.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const CLIMBING_PROCEDURE_ID = "climbing";

/*
 * GM gameplay notices for movement procedures which deliberately leave a Core
 * rule to table adjudication.
 *
 * This module is intentionally loaded after ClimbingConsequenceIntegration and
 * ClimbingSkillIntegration. It therefore consumes the final persisted climbing
 * snapshot instead of duplicating the climbing rules or hand-counting logic.
 *
 * When automatic climbing-hand validation is enabled, the authoritative
 * climbing procedure blocks an illegal attempt itself and this layer stays
 * silent. When validation is disabled, the Core hand requirement remains useful
 * GM information: the climb proceeds, but an insufficient-hand snapshot becomes
 * a persistence-aware GM gameplay warning.
 */
install();

function install() {
	if (MovementStandardTest.__wfrpGmGameplayNoticeInstalled === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpGmGameplayNoticeInstalled", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	MovementStandardTest.execute = async function executeWithGmGameplayNotices(
		actor,
		procedureId,
		options = {},
	) {
		const result = await originalExecute.call(this, actor, procedureId, options);
		if (String(procedureId ?? "").trim() !== CLIMBING_PROCEDURE_ID) {
			return result;
		}

		await warnAboutUnvalidatedFreeHands(actor, result);
		return result;
	};
}

async function warnAboutUnvalidatedFreeHands(actor, message) {
	if (!(message instanceof foundry.documents.ChatMessage)) return;

	const state = climbingState(message);
	if (!state || state.handValidationEnabled === true) return;

	const required = nonNegativeInteger(state.requiredFreeHands);
	const available = nonNegativeInteger(state.freeHands);
	if (required <= 0 || available >= required) return;

	const messageText = localize(
		`This climb requires ${required} free hand(s), but only ${available} are available. Automatic climbing-hand validation is disabled, so the system did not block the attempt. The GM/table must adjudicate how the occupied hand(s) affect this climb.`,
		`Ta wspinaczka wymaga ${required} wolnych rąk, a dostępnych jest tylko ${available}. Automatyczne sprawdzanie wolnych rąk przy wspinaczce jest wyłączone, więc system nie zablokował próby. MG / stół musi rozstrzygnąć, jak zajęte ręce wpływają na tę wspinaczkę.`,
	);

	await GMGameplayNotice.warn({
		category: "climbing-free-hands",
		title: localize(
			"Climbing — free hands",
			"Wspinaczka — wolne ręce",
		),
		message: messageText,
		summary: localize(
			"Climbing requires more free hands — details saved in private GM chat.",
			"Wspinaczka wymaga większej liczby wolnych rąk — szczegóły zapisano w prywatnym czacie MG.",
		),
		actor,
	});
}

function climbingState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		String(state.kind ?? "") === CLIMBING_PROCEDURE_ID
		? state
		: null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
