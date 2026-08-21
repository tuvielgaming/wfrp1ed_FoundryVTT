import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { StandardTestDialog } from "../tests/StandardTestDialog.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const CLIMBING_PROCEDURE_ID = "climbing";
const SHEER_CLIMB_TYPE = "sheer";
const SCALE_SHEER_SURFACE_RULES_ID = "scaleSheerSurface";
const SHEER_ACCESS_AUDIT_VERSION = 1;

/*
 * Connect the canonical Scale Sheer Surface / Wspinaczka Skill Item to the
 * audited Core climbing procedure without turning skill ownership into an
 * Active Effect.
 *
 * The Skill Item itself is the source of truth. A sheer surface is therefore
 * accessible when either:
 * - the Actor owns the canonical `scaleSheerSurface` Skill; or
 * - suitable climbing equipment is explicitly confirmed in the dialog.
 *
 * Skill ownership is snapshotted into the climbing ChatMessage so later Skill
 * purchases/removals cannot rewrite what justified an already-rolled climb.
 * This module deliberately loads after ClimbingConsequenceIntegration and wraps
 * its final dialog/execution/presentation contracts rather than duplicating the
 * climbing movement, Risk, Fall, or abseiling calculations.
 */
installDialogIntegration();
installMovementIntegration();

function installDialogIntegration() {
	if (StandardTestDialog.__wfrpClimbingSkillInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpClimbingSkillInstalled", {
		value: true,
		configurable: false,
	});

	const originalBuildContent = StandardTestDialog._buildContent;
	const originalRefreshContextFields = StandardTestDialog._refreshContextFields;

	StandardTestDialog._buildContent = function (actor, entries) {
		const content = originalBuildContent.call(this, actor, entries);
		const body = content?.querySelector?.(".standard-test-dialog-body");
		if (body instanceof HTMLElement) {
			configureEquipmentField(body);
		}
		return content;
	};

	StandardTestDialog._refreshContextFields = function (body, entry, actor) {
		originalRefreshContextFields.call(this, body, entry, actor);

		const isClimbing = String(entry?.id ?? "") === CLIMBING_PROCEDURE_ID;
		const climbType = String(
			body?.querySelector?.('select[name="climbType"]')?.value ?? "",
		).trim();
		const ownsSkill = hasOwnedSkill(actor, SCALE_SHEER_SURFACE_RULES_ID);

		/*
		 * Keep the Standard Test clean: when Wspinaczka is already owned, no
		 * confirmation is needed. Without the Skill, the one remaining checkbox
		 * means equipment only; it is never a manual Skill override.
		 */
		setFieldVisible(
			body,
			"climbSheerAccess",
			isClimbing && climbType === SHEER_CLIMB_TYPE && !ownsSkill,
		);
	};
}

function installMovementIntegration() {
	if (MovementStandardTest.__wfrpClimbingSkillInstalled === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpClimbingSkillInstalled", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	const originalPresentation = MovementStandardTest._presentation;

	MovementStandardTest.execute = async function (actor, procedureId, options = {}) {
		const id = String(procedureId ?? "").trim();
		const climbType = String(options?.climbType ?? "").trim();
		if (id !== CLIMBING_PROCEDURE_ID || climbType !== SHEER_CLIMB_TYPE) {
			return originalExecute.call(this, actor, procedureId, options);
		}

		const skillOwned = hasOwnedSkill(actor, SCALE_SHEER_SURFACE_RULES_ID);
		const equipmentConfirmed = options?.sheerAccessConfirmed === true;
		const effectiveOptions = skillOwned
			? { ...options, sheerAccessConfirmed: true }
			: options;

		const message = await originalExecute.call(
			this,
			actor,
			procedureId,
			effectiveOptions,
		);

		if (!(message instanceof foundry.documents.ChatMessage)) {
			return message;
		}

		const current = climbingState(message);
		if (!current || String(current.climbType ?? "") !== SHEER_CLIMB_TYPE) {
			return message;
		}

		const updated = foundry.utils.deepClone(current);
		updated.sheerAccessAudit = {
			version: SHEER_ACCESS_AUDIT_VERSION,
			skillRulesId: SCALE_SHEER_SURFACE_RULES_ID,
			skillOwned,
			equipmentConfirmed,
			source: skillOwned ? "skill" : "equipment",
		};
		updated.updatedAt = Date.now();
		await this._updateMessageState(message, updated);
		return message;
	};

	MovementStandardTest._presentation = function (state) {
		const presentation = originalPresentation.call(this, state);
		if (
			String(state?.kind ?? "") !== CLIMBING_PROCEDURE_ID ||
			String(state?.climbType ?? "") !== SHEER_CLIMB_TYPE
		) {
			return presentation;
		}

		const audit = sheerAccessAudit(state);
		if (!audit) {
			/* Older climbing messages did not record the access source. */
			return presentation;
		}

		const rows = Array.isArray(presentation?.rows)
			? [...presentation.rows]
			: [];
		const accessRow = {
			label: localize("Sheer-surface access", "Dostęp do stromej powierzchni"),
			value: audit.source === "skill"
				? localize(
					"Scale Sheer Surface — purchased",
					"Wspinaczka — wykupiona",
				)
				: localize(
					"Climbing equipment — confirmed",
					"Sprzęt wspinaczkowy — potwierdzony",
				),
		};

		/* Put the access source immediately after the climbing type row. */
		rows.splice(Math.min(1, rows.length), 0, accessRow);
		return {
			...presentation,
			rows,
		};
	};
}

function configureEquipmentField(body) {
	const group = body?.querySelector?.(
		'[data-standard-field="climbSheerAccess"]',
	);
	if (!(group instanceof HTMLElement)) return;

	const visibleLabel = group.firstElementChild;
	if (visibleLabel instanceof HTMLLabelElement) {
		visibleLabel.textContent = localize(
			"Suitable climbing equipment confirmed",
			"Potwierdzono odpowiedni sprzęt wspinaczkowy",
		);
	}

	const input = group.querySelector('input[name="climbSheerAccess"]');
	if (!(input instanceof HTMLInputElement)) return;

	const title = localize(
		"Confirm suitable ropes, grapples, or equivalent climbing equipment. The Scale Sheer Surface skill is detected automatically.",
		"Potwierdź odpowiednie liny, haki lub równoważny sprzęt wspinaczkowy. Umiejętność Wspinaczka jest wykrywana automatycznie.",
	);
	input.title = title;
	input.setAttribute(
		"aria-label",
		localize(
			"Suitable climbing equipment confirmed",
			"Potwierdzono odpowiedni sprzęt wspinaczkowy",
		),
	);

	const wrapper = input.closest(".wfrp1ed-checkbox");
	if (wrapper instanceof HTMLElement) {
		wrapper.title = title;
	}
}

function sheerAccessAudit(state) {
	const audit = state?.sheerAccessAudit;
	if (
		!audit ||
		typeof audit !== "object" ||
		Array.isArray(audit) ||
		Number(audit.version) !== SHEER_ACCESS_AUDIT_VERSION ||
		String(audit.skillRulesId ?? "") !== SCALE_SHEER_SURFACE_RULES_ID
	) {
		return null;
	}

	const source = String(audit.source ?? "");
	if (source !== "skill" && source !== "equipment") return null;
	return audit;
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

function hasOwnedSkill(actor, rulesId) {
	const id = String(rulesId ?? "").trim();
	if (!id) return false;
	return [...(actor?.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === id,
	);
}

function setFieldVisible(body, field, visible) {
	const element = body?.querySelector?.(`[data-standard-field="${field}"]`);
	if (element) element.hidden = !visible;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
