import { consequenceSystemSource } from "./CriticalConsequenceDefinition.mjs";
import { coreCriticalConsequence } from "./CoreCriticalConsequences.mjs";
import { CriticalWoundApplication } from "./CriticalWoundApplication.mjs";
import { applyDetailedCriticalWound } from "./DetailedCriticalIntegration.mjs";
import { RangedCriticalPolicy } from "./RangedCriticalPolicy.mjs";
import { rangedCriticalEffectFor } from "./RangedCriticalEffectTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const RANGED_EFFECT_OVERRIDE_FLAG_KEY = "rangedDetailedCriticalEffect";
const CUSTOM_PROVIDER_ID = "wfrp1ed.ranged.named-effect-table";

/*
 * Optional ranged Detailed Critical presentation.
 *
 * The Core detailed Critical Hit Chart remains authoritative for critical value,
 * d100, hit location, effect number, flee and fatal/mechanical semantics. An
 * exactly named ranged RollTable may replace only the narrative effect text.
 * This is the narrow compatibility layer requested by the Core recommendation:
 * melee-specific wound descriptions can be replaced without inventing a second
 * critical mathematics/consequence engine.
 *
 * The selected description is snapshotted on the detailed-result ChatMessage so
 * later table renames/deletions and Compendium permissions do not rewrite chat
 * history. Persistent Critical Wounds created from such a result also snapshot
 * the custom text while seeding the audited Core declarative consequence for the
 * same location/effect number.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		requestAnimationFrame(() => void decorateRangedDetailedResult(message, html));
	});
});

Hooks.on("createChatMessage", (message) => {
	if (!canPersistOverride(message)) return;
	void persistRangedEffectOverride(message).catch(reportOverrideError);
});

Hooks.on("updateChatMessage", (message, changes) => {
	if (!criticalResultChanged(changes) || !canPersistOverride(message)) return;
	void persistRangedEffectOverride(message).catch(reportOverrideError);
});

async function persistRangedEffectOverride(message) {
	const context = rangedDetailedContext(message);
	if (!context || !RangedCriticalPolicy.usesDetailedCriticals()) return;

	const override = await rangedCriticalEffectFor(
		context.resolution.hitLocation,
		context.resolution.effectNumber,
	);
	const current = message.getFlag?.(
		FLAG_SCOPE,
		RANGED_EFFECT_OVERRIDE_FLAG_KEY,
	);

	if (!override) {
		if (current) await message.unsetFlag(FLAG_SCOPE, RANGED_EFFECT_OVERRIDE_FLAG_KEY);
		return;
	}

	const snapshot = {
		...foundry.utils.deepClone(override),
		hitLocation: String(context.resolution.hitLocation ?? ""),
		resolvedAt: Date.now(),
	};
	if (sameOverride(current, snapshot)) return;
	await message.setFlag(FLAG_SCOPE, RANGED_EFFECT_OVERRIDE_FLAG_KEY, snapshot);
}

async function decorateRangedDetailedResult(message, html) {
	const context = rangedDetailedContext(message);
	if (!context) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	let override = validStoredOverride(message, context.resolution);
	if (!override && RangedCriticalPolicy.usesDetailedCriticals()) {
		override = await rangedCriticalEffectFor(
			context.resolution.hitLocation,
			context.resolution.effectNumber,
		);
	}
	if (!override || !card.isConnected) return;

	const effect = card.querySelector("[data-wfrp-detailed-effect]");
	if (effect) {
		effect.textContent = override.text;
		effect.title = localize(
			`Ranged Critical Effect description: ${override.tableName}. Core effect number and mechanics remain authoritative.`,
			`Opis efektu krytycznego ataku dystansowego: ${override.tableName}. Numer efektu i mechanika zasad podstawowych pozostają rozstrzygające.`,
		);
	}

	decorateCustomWoundApplication(message, card, context, override);
}

function decorateCustomWoundApplication(message, card, context, override) {
	const oldPanel = card.querySelector("[data-wfrp-critical-wound-application]");
	if (context.resolution?.outcome === "killed") {
		oldPanel?.remove();
		return;
	}

	const actor = actorFromDamageState(context.damage);
	if (!(actor instanceof foundry.documents.Actor)) return;

	oldPanel?.remove();
	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpCriticalWoundApplication = "";

	const existing = CriticalWoundApplication.existingForResolution(
		actor,
		{ resultMessageId: message.id },
	);
	if (existing) {
		const status = document.createElement("div");
		status.className = "wfrp1e-fate-intervention__spent";
		status.textContent = localize(
			"✓ Critical Wound applied to the character",
			"✓ Rana krytyczna została przypisana do postaci",
		);
		panel.append(status);

		const open = document.createElement("button");
		open.type = "button";
		open.className = "wfrp1e-fate-intervention__action";
		open.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${localize(
			"Open Critical Wound",
			"Otwórz ranę krytyczną",
		)}`;
		open.addEventListener("click", () => {
			void existing.sheet?.render?.({ force: true });
		});
		panel.append(open);
		card.append(panel);
		return;
	}

	if (CriticalWoundApplication.canApply(actor, game.user)) {
		const action = document.createElement("button");
		action.type = "button";
		action.className = "wfrp1e-fate-intervention__action";
		action.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${localize(
			"Apply Critical Wound",
			"Zastosuj ranę krytyczną",
		)}`;
		action.title = localize(
			`Create the Critical Wound with the ranged description from '${override.tableName}' and the Core mechanical consequence for effect ${context.resolution.effectNumber}.`,
			`Utwórz Ranę krytyczną z opisem dystansowym z tabeli '${override.tableName}' oraz mechanicznym skutkiem zasad podstawowych dla efektu ${context.resolution.effectNumber}.`,
		);
		action.addEventListener("click", () => {
			action.disabled = true;
			void applyRangedCriticalWound(message)
				.catch((error) => {
					console.error("WFRP1ED | Unable to apply ranged Critical Wound.", error);
					ui.notifications.error(error?.message ?? String(error));
				})
				.finally(() => {
					if (action.isConnected) action.disabled = false;
				});
		});
		panel.append(action);
	} else {
		const pending = document.createElement("div");
		pending.className = "wfrp1e-critical-result__pending";
		pending.textContent = localize(
			"Awaiting the GM or target owner to apply the persistent Critical Wound.",
			"Oczekuje na MG lub właściciela celu, który zastosuje trwałą ranę krytyczną.",
		);
		panel.append(pending);
	}

	card.append(panel);
}

async function applyRangedCriticalWound(message) {
	const context = rangedDetailedContext(message);
	if (!context) {
		throw new Error("This ChatMessage is not a ranged detailed critical result.");
	}
	if (context.resolution?.outcome === "killed") {
		throw new Error(
			"Fatal detailed criticals are handled by the Fate/death lifecycle.",
		);
	}

	const actor = actorFromDamageState(context.damage);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The detailed critical target Actor is not available.");
	}
	if (!CriticalWoundApplication.canApply(actor, game.user)) {
		throw new Error(
			"Only a GM or the target Actor OWNER may apply this Critical Wound.",
		);
	}

	const existing = CriticalWoundApplication.existingForResolution(
		actor,
		{ resultMessageId: message.id },
	);
	if (existing) {
		await existing.sheet?.render?.({ force: true });
		return { created: false, wound: existing };
	}

	const override = validStoredOverride(message, context.resolution) ??
		await rangedCriticalEffectFor(
			context.resolution.hitLocation,
			context.resolution.effectNumber,
		);
	if (!override) {
		/* The optional table disappeared before application: use the normal
		 * Detailed Critical wound path rather than creating partial custom state. */
		return applyDetailedCriticalWound(message);
	}

	const location = String(context.resolution.effectLocation ?? "").trim();
	const effectNumber = positiveEffectNumber(context.resolution.effectNumber);
	const coreConsequence = coreCriticalConsequence(location, effectNumber);
	const consequence = consequenceSystemSource(
		coreConsequence ? { enabled: true, ...coreConsequence } : {},
	);
	const woundSource = {
		name: `${localize("Critical Wound", "Rana krytyczna")} — ${hitLocationLabel(
			context.resolution.hitLocation,
		)} ${effectNumber}`,
		type: "criticalWound",
		system: {
			description: String(override.text),
			criticalValue: positiveInteger(
				context.resolution.criticalValue,
				"Critical value",
			),
			hitLocation: String(context.resolution.hitLocation ?? ""),
			consequence,
			resolution: {
				damagePacketId: String(context.damage?.packet?.id ?? ""),
				sourceMessageId: String(context.sourceMessage.id ?? ""),
				resultMessageId: String(message.id ?? ""),
				tableRole: String(context.resolution.effect?.role ?? ""),
				tableVariant: "default",
				providerId: CUSTOM_PROVIDER_ID,
				tableUuid: String(override.tableUuid ?? ""),
				tableResultId: String(override.resultId ?? ""),
				effectNumber,
				roll: nonNegativeInteger(context.resolution.roll?.total),
				resolvedByUserId: String(context.resolution.resolvedBy ?? ""),
				resolvedAt: nonNegativeInteger(context.resolution.resolvedAt),
			},
		},
		effects: [],
	};

	const [wound] = await actor.createEmbeddedDocuments("Item", [woundSource]);
	if (!wound || wound.type !== "criticalWound") {
		throw new Error("Foundry did not return the created ranged Critical Wound Item.");
	}
	void ui.chat?.render?.({ force: true });
	return { created: true, wound };
}

function rangedDetailedContext(message) {
	const result = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		result.kind !== "detailed" ||
		!result.resolution
	) return null;

	const sourceMessage = game.messages?.get(String(result.sourceMessageId ?? ""));
	if (!sourceMessage) return null;
	const attack = sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damage = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (attack?.family !== "ranged" || damage?.packet?.critical?.mode !== "detailed") {
		return null;
	}

	return {
		result,
		resolution: result.resolution,
		sourceMessage,
		attack,
		damage,
	};
}

function validStoredOverride(message, resolution) {
	const stored = message?.getFlag?.(
		FLAG_SCOPE,
		RANGED_EFFECT_OVERRIDE_FLAG_KEY,
	);
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
	if (Number(stored.effectNumber) !== Number(resolution?.effectNumber)) return null;
	if (String(stored.hitLocation ?? "") !== String(resolution?.hitLocation ?? "")) {
		return null;
	}
	return stored;
}

function sameOverride(left, right) {
	if (!left || !right) return false;
	return [
		"effectNumber",
		"hitLocation",
		"source",
		"packId",
		"tableUuid",
		"tableName",
		"resultId",
		"text",
	].every((key) => String(left[key] ?? "") === String(right[key] ?? ""));
}

function canPersistOverride(message) {
	if (!message) return false;
	const primary = primaryActiveGm();
	if (primary) return Boolean(game.user?.isGM && primary.id === game.user.id);
	return message.canUserModify?.(game.user, "update") === true;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function criticalResultChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	if (Object.hasOwn(changes, `flags.${FLAG_SCOPE}.${CRITICAL_RESULT_FLAG_KEY}`)) {
		return true;
	}
	return foundry.utils.hasProperty?.(
		changes,
		`flags.${FLAG_SCOPE}.${CRITICAL_RESULT_FLAG_KEY}`,
	) === true;
}

function actorFromDamageState(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.packet?.targetActorUuid ?? ""),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function hitLocationLabel(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right Arm", "Prawa ręka");
		case "leftArm": return localize("Left Arm", "Lewa ręka");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right Leg", "Prawa noga");
		case "leftLeg": return localize("Left Leg", "Lewa noga");
		default: return localize("Unknown location", "Nieznana lokacja");
	}
}

function positiveEffectNumber(value) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 16) {
		throw new Error("Detailed critical effect number must be between 1 and 16.");
	}
	return number;
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function reportOverrideError(error) {
	console.error("WFRP1ED | Unable to persist ranged Critical Effect override.", error);
	if (game.user?.isGM) {
		ui.notifications.error(error?.message ?? String(error));
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
