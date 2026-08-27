import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { SPELL_PROCEDURE_ID } from "./SpellProcedureRegistry.mjs";

const { DialogV2 } = foundry.applications.api;
const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpact";
const CAST_FLAG_KEY = "fireBallCast";
const ROUND_USAGE_FLAG_KEY = "fireBallRoundUsage";
const STRENGTH = 3;
const RANGE = 48;
const CANCEL_DIALOG_RESULT = Object.freeze({ cancelled: true });

/** Audited WFRP 1e Fire Ball casting and damage procedure. */
export const FireBallProcedure = Object.freeze({
	id: SPELL_PROCEDURE_ID.FIRE_BALL,
	label: () => localize("Fire Ball", "Ognista Kula"),
	execute: (actor, spell) => executeFireBall(actor, spell),
});

export function installFireBallPresentation() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		decorateImpact(message, html);
	});
}

async function executeFireBall(actor, spell) {
	const powerLevel = positiveInteger(
		actor.system?.status?.powerLevel,
		localize("Power Level", "Poziom Mocy"),
	);
	const magicPoints = nonNegativeInteger(
		actor.system?.status?.magicPoints,
		localize("Magic Points", "Punkty Magii"),
	);
	const targets = selectedTargets(actor);
	if (targets.length === 0) {
		throw new Error(localize(
			"Target at least one token before casting Fire Ball.",
			"Przed rzuceniem Ognistej Kuli wskaż co najmniej jeden token.",
		));
	}
	if (magicPoints < 1) {
		throw new Error(localize(
			"The caster has no Magic Points available.",
			"Osoba rzucająca czar nie ma dostępnych Punktów Magii.",
		));
	}
	const roundUsage = fireBallRoundUsage(actor);
	const maximum = Math.min(powerLevel - roundUsage.used, magicPoints);
	if (maximum < 1) {
		throw new Error(localize(
			"This caster has already thrown the maximum number of Fire Balls allowed this combat round.",
			"Ta postać rzuciła już maksymalną liczbę Ognistych Kul dozwoloną w tej rundzie walki.",
		));
	}

	const configuration = await configureCast({ actor, spell, targets, maximum });
	if (!configuration) return null;

	const volleys = await resolveVolleyTargets(configuration, targets, powerLevel);
	if (!volleys) return null;

	const magicPointsAfter = magicPoints - configuration.fireBalls;
	const resourceUpdate = { "system.status.magicPoints": magicPointsAfter };
	if (roundUsage.managed) {
		resourceUpdate[`flags.${FLAG_SCOPE}.${ROUND_USAGE_FLAG_KEY}`] = {
			version: 1,
			combatId: roundUsage.combatId,
			round: roundUsage.round,
			used: roundUsage.used + configuration.fireBalls,
		};
	}
	await actor.update(resourceUpdate);
	await publishCastSummary({ actor, spell, configuration, volleys, magicPoints, magicPointsAfter });

	const affected = new Map(
		volleys.flatMap((volley) => volley.targets)
			.map((target) => [target.key, target]),
	);
	for (const target of affected.values()) {
		if (configuration.conditions[target.key]?.fearOfFire) {
			await target.actor.rollTest("fear", { modifier: 0 });
		}
	}

	const impacts = [];
	for (let ballIndex = 0; ballIndex < volleys.length; ballIndex += 1) {
		for (const target of volleys[ballIndex].targets) {
			impacts.push(await resolveImpact({
				actor,
				spell,
				target,
				ballIndex,
				flammable: configuration.conditions[target.key]?.flammable === true,
			}));
		}
	}

	return Object.freeze({
		fireBalls: configuration.fireBalls,
		magicPointsSpent: configuration.fireBalls,
		impacts: Object.freeze(impacts),
	});
}

async function configureCast({ actor, spell, targets, maximum }) {
	const draft = {
		fireBalls: "1",
		errors: {},
		conditions: Object.fromEntries(targets.map((target) => [
			target.key,
			{ flammable: false, fearOfFire: false },
		])),
	};

	while (true) {
		const content = document.createElement("div");
		const root = document.createElement("div");
		root.className = "wfrp-fireball-dialog";
		root.innerHTML = `
		<p>${escapeHtml(localize(
			"Fire Balls automatically hit. One Magic Point is spent per ball.",
			"Ogniste Kule trafiają automatycznie. Każda kula kosztuje 1 Punkt Magii.",
		))}</p>
		<div class="form-group${draft.errors.fireBalls ? " has-error" : ""}">
			<label>${escapeHtml(localize("Fire Balls", "Liczba kul"))}</label>
			<div class="form-fields"><input type="number" name="fireBalls" step="1" value="${escapeHtml(draft.fireBalls)}"></div>
			${draft.errors.fireBalls ? `<div class="wfrp-fireball-dialog__validation" role="alert">${escapeHtml(draft.errors.fireBalls)}</div>` : ""}
		</div>
		<p class="notes">${escapeHtml(targets.length === 1
			? localize("One selected token: individual target.", "Jeden wskazany token: cel pojedynczy.")
			: localize("Multiple selected tokens: target group.", "Wiele wskazanych tokenów: grupa celów."))}</p>
		<div class="wfrp-fireball-dialog__targets"></div>
	`;
		content.append(root);
		const list = root.querySelector(".wfrp-fireball-dialog__targets");
		for (const target of targets) {
			const row = document.createElement("fieldset");
			row.dataset.targetUuid = target.key;
			const legend = document.createElement("legend");
			legend.textContent = target.name;
			row.append(
				legend,
				conditionLabel("flammable", localize("Flammable", "Łatwopalny"), draft.conditions[target.key]?.flammable),
				conditionLabel("fearOfFire", localize("Subject to fear of fire", "Podatny na strach przed ogniem"), draft.conditions[target.key]?.fearOfFire),
			);
			list.append(row);
		}

		const response = await DialogV2.wait({
			classes: ["wfrp1ed", "wfrp1ed-parchment-window", "wfrp-fireball-cast-dialog"],
			window: { title: `${spell.name} — ${actor.name}` },
			content,
			buttons: [
				{
					action: "cast",
					label: localize("Cast", "Rzuć czar"),
					icon: "fa-solid fa-wand-sparkles",
					default: true,
					callback: (_event, button) => readConfiguration(button.form, targets),
				},
				{
					action: "cancel",
					label: localize("Cancel", "Anuluj"),
					icon: "fa-solid fa-xmark",
					callback: () => CANCEL_DIALOG_RESULT,
				},
			],
			rejectClose: false,
		});

		if (isCancelledDialogResult(response)) return null;
		if (!isCastConfiguration(response)) return null;

		const validation = validateConfiguration(response, maximum);
		if (validation.valid) {
			return {
				fireBalls: validation.fireBalls,
				conditions: response.conditions,
				group: targets.length > 1,
			};
		}

		draft.fireBalls = String(response.fireBalls ?? "");
		draft.conditions = response.conditions;
		draft.errors = validation.errors;
	}
}

function validateConfiguration(response, maximum) {
	const errors = {};
	const fireBalls = Number(response.fireBalls);
	if (!Number.isInteger(fireBalls) || fireBalls < 1 || fireBalls > maximum) {
		errors.fireBalls = localize(
			`Enter a whole number from 1 to ${maximum}.`,
			`Wprowadź liczbę całkowitą od 1 do ${maximum}.`,
		);
	}
	return {
		valid: Object.keys(errors).length === 0,
		errors,
		fireBalls,
	};
}

function isCancelledDialogResult(response) {
	return response === null || response === "cancel" || response?.cancelled === true;
}

function isCastConfiguration(response) {
	return Boolean(
		response &&
		typeof response === "object" &&
		Object.hasOwn(response, "fireBalls") &&
		response.conditions &&
		typeof response.conditions === "object",
	);
}

function conditionLabel(kind, text, checked = false) {
	const label = document.createElement("label");
	const input = document.createElement("input");
	input.type = "checkbox";
	input.dataset.fireBallCondition = kind;
	input.checked = checked === true;
	label.append(input, document.createTextNode(text));
	return label;
}

function readConfiguration(form, targets) {
	const fireBalls = String(form?.elements?.fireBalls?.value ?? "").trim();
	const conditions = {};
	for (const target of targets) {
		const row = form?.querySelector?.(`[data-target-uuid="${cssEscape(target.key)}"]`);
		conditions[target.key] = {
			flammable: row?.querySelector?.('[data-fire-ball-condition="flammable"]')?.checked === true,
			fearOfFire: row?.querySelector?.('[data-fire-ball-condition="fearOfFire"]')?.checked === true,
		};
	}
	return { fireBalls, conditions };
}

async function resolveVolleyTargets(configuration, targets, powerLevel) {
	const volleys = [];
	for (let index = 0; index < configuration.fireBalls; index += 1) {
		if (!configuration.group) {
			volleys.push({ targets: [targets[0]], groupRoll: null });
			continue;
		}
		const groupRoll = await new Roll(`${powerLevel}d3`).evaluate();
		const count = Math.min(nonNegativeInteger(groupRoll.total, "Group hits"), targets.length);
		const selected = count >= targets.length
			? targets
			: await chooseGroupTargets(targets, count, index + 1);
		if (!selected) return null;
		volleys.push({ targets: selected, groupRoll });
	}
	return volleys;
}

async function chooseGroupTargets(targets, count, ballNumber) {
	while (true) {
		const content = document.createElement("div");
		const root = document.createElement("div");
		root.className = "wfrp-fireball-target-dialog";
		const instruction = document.createElement("p");
		instruction.textContent = localize(
			`Fire Ball ${ballNumber} hits ${count} creatures. Choose exactly ${count}.`,
			`Ognista Kula ${ballNumber} trafia ${count} istot. Wybierz dokładnie ${count}.`,
		);
		root.append(instruction);
		for (let index = 0; index < targets.length; index += 1) {
			const label = document.createElement("label");
			const input = document.createElement("input");
			input.type = "checkbox";
			input.value = targets[index].key;
			input.dataset.fireBallTarget = "";
			input.checked = index < count;
			label.append(input, document.createTextNode(targets[index].name));
			root.append(label);
		}
		content.append(root);
		const response = await DialogV2.wait({
			classes: ["wfrp1ed", "wfrp1ed-parchment-window", "wfrp-fireball-target-dialog-window"],
			window: { title: localize("Fire Ball targets", "Cele Kuli Ognia") },
			content,
			buttons: [
				{
					action: "choose",
					label: localize("Choose", "Wybierz"),
					default: true,
					callback: (_event, button) => [...button.form.querySelectorAll("[data-fire-ball-target]:checked")].map((input) => input.value),
				},
				{ action: "cancel", label: localize("Cancel", "Anuluj"), callback: () => CANCEL_DIALOG_RESULT },
			],
			rejectClose: false,
		});
		if (isCancelledDialogResult(response)) return null;
		if (!Array.isArray(response)) return null;
		if (response.length === count) {
			const selected = new Set(response);
			return targets.filter((target) => selected.has(target.key));
		}
		ui.notifications.warn(localize(
			`Choose exactly ${count} targets.`,
			`Wybierz dokładnie ${count} celów.`,
		));
	}
}

async function resolveImpact({ actor, spell, target, ballIndex, flammable }) {
	const targetActor = target.actor;
	const damageRoll = await new Roll("1d10").evaluate();
	const flammableRoll = flammable ? await new Roll("1d8").evaluate() : null;
	const fullDamage = STRENGTH + nonNegativeInteger(damageRoll.total, "Fire Ball damage") +
		(flammableRoll ? nonNegativeInteger(flammableRoll.total, "Flammable damage") : 0);
	const initiative = await targetActor.rollCharacteristic("i", { modifier: 0 });
	if (!initiative?.chatMessage) {
		throw new Error(localize(
			`Initiative Test for ${target.name} was not completed.`,
			`Test Inicjatywy dla ${target.name} nie został ukończony.`,
		));
	}
	const afterInitiative = initiative.success ? Math.floor(fullDamage / 2) : fullDamage;
	const packet = new DamagePacket({
		rawAmount: afterInitiative,
		targetActorUuid: targetActor.uuid,
		source: {
			kind: "spell-fire-ball",
			id: `${spell.id}-ball-${ballIndex + 1}-${targetActor.id}-${foundry.utils.randomID(6)}`,
			uuid: spell.uuid,
			label: spell.name,
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const toughness = nonNegativeInteger(targetActor.getCharacteristicValue("t"), "Toughness");
	const resolution = DamageResolver.resolve(packet, { toughness: { value: toughness } });
	await DamageChat.attach(initiative.chatMessage, { packet, resolution });
	await initiative.chatMessage.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, {
		version: 1,
		casterUuid: actor.uuid,
		casterName: actor.name,
		spellUuid: spell.uuid,
		spellName: spell.name,
		ballNumber: ballIndex + 1,
		targetUuid: targetActor.uuid,
		targetTokenUuid: target.key,
		targetName: target.name,
		strength: STRENGTH,
		damageRoll: nonNegativeInteger(damageRoll.total, "Fire Ball damage"),
		flammable,
		flammableRoll: flammableRoll ? nonNegativeInteger(flammableRoll.total, "Flammable damage") : 0,
		fullDamage,
		initiativeSuccess: initiative.success,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
	});
	return Object.freeze({ packetId: packet.id, targetUuid: targetActor.uuid, finalDamage: resolution.finalAmount });
}

async function publishCastSummary({ actor, spell, configuration, volleys, magicPoints, magicPointsAfter }) {
	const groupDetails = volleys.map((volley, index) => ({
		ballNumber: index + 1,
		groupRoll: volley.groupRoll ? nonNegativeInteger(volley.groupRoll.total, "Group hits") : null,
		targets: volley.targets.map((target) => ({ uuid: target.key, name: target.name })),
	}));
	const content = `
		<section class="wfrp1ed fire-ball-cast-summary">
			<h3>${escapeHtml(spell.name)}</h3>
			<div><strong>${escapeHtml(localize("Fire Balls", "Ogniste Kule"))}:</strong> ${configuration.fireBalls}</div>
			<div><strong>${escapeHtml(localize("Magic Points", "Punkty Magii"))}:</strong> ${magicPoints} → ${magicPointsAfter}</div>
			${configuration.group ? `<div><strong>${escapeHtml(localize("Group hits", "Trafienia grupowe"))}:</strong> ${escapeHtml(groupDetails.map((entry) => `${entry.ballNumber}: ${entry.groupRoll} → ${entry.targets.map((target) => target.name).join(", ")}`).join("; "))}</div>` : ""}
		</section>
	`;
	const message = await ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content,
	});
	await message.setFlag(FLAG_SCOPE, CAST_FLAG_KEY, {
		version: 1,
		casterUuid: actor.uuid,
		spellUuid: spell.uuid,
		fireBalls: configuration.fireBalls,
		magicPointsBefore: magicPoints,
		magicPointsAfter,
		group: configuration.group,
		volleys: groupDetails,
	});
}

function selectedTargets(actor) {
	const automaticDistance = WfrpRuleSettings.usesAutomaticSpellTokenDistance();
	const casterToken = automaticDistance ? activeCasterToken(actor) : null;
	const targets = [...(game.user?.targets ?? [])].map((token) => {
		const distance = casterToken ? tokenDistance(casterToken, token) : null;
		if (automaticDistance && Number.isFinite(distance) && distance > RANGE) {
			throw new Error(localize(
				`${token.name} is beyond Fire Ball range (${RANGE}).`,
				`${token.name} znajduje się poza zasięgiem Ognistej Kuli (${RANGE}).`,
			));
		}
		return Object.freeze({
			key: token.document?.uuid ?? token.uuid,
			name: token.name,
			actor: token.actor,
			distance,
		});
	});
	return Object.freeze(targets);
}

function activeCasterToken(actor) {
	const tokens = actor.getActiveTokens?.() ?? [];
	return tokens.find((token) => tokenCenter(token)) ?? null;
}

function tokenDistance(origin, target) {
	const originCenter = tokenCenter(origin);
	const targetCenter = tokenCenter(target);
	if (!originCenter || !targetCenter) return null;

	const dx = Number(targetCenter.x) - Number(originCenter.x);
	const dy = Number(targetCenter.y) - Number(originCenter.y);
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

	const pixels = Math.hypot(dx, dy);
	const gridSize = Number(canvas.grid?.size) || 1;
	const gridDistance = Number(canvas.scene?.grid?.distance) || 1;
	return (pixels / gridSize) * gridDistance;
}

function tokenCenter(token) {
	return token?.center ?? token?.object?.center ?? null;
}

function fireBallRoundUsage(actor) {
	const combat = game.combat;
	if (!combat?.id || !Number.isInteger(Number(combat.round))) {
		return { managed: false, combatId: null, round: null, used: 0 };
	}
	const stored = actor.getFlag?.(FLAG_SCOPE, ROUND_USAGE_FLAG_KEY);
	if (stored?.combatId === combat.id && Number(stored?.round) === Number(combat.round)) {
		return {
			managed: true,
			combatId: combat.id,
			round: Number(combat.round),
			used: nonNegativeInteger(stored.used, "Fire Ball round usage"),
		};
	}
	return { managed: true, combatId: combat.id, round: Number(combat.round), used: 0 };
}

function positiveInteger(value, label) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1) {
		throw new Error(localize(
			`${label} must be a positive integer.`,
			`${label} musi być dodatnią liczbą całkowitą.`,
		));
	}
	return numeric;
}

function nonNegativeInteger(value, label = "Value") {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
		throw new Error(localize(
			`${label} must be a non-negative integer.`,
			`${label} musi być nieujemną liczbą całkowitą.`,
		));
	}
	return numeric;
}

function cssEscape(value) {
	if (globalThis.CSS?.escape) return CSS.escape(String(value));
	return String(value).replace(/["\\]/g, "\\$&");
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = String(value ?? "");
	return div.innerHTML;
}

function decorateImpact(message, html) {
	const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact || !(html instanceof HTMLElement)) return;
	const messageContent = html.querySelector(".message-content");
	if (!messageContent || messageContent.querySelector(".wfrp-fire-ball-impact")) return;
	const section = document.createElement("section");
	section.className = "wfrp1ed wfrp-fire-ball-impact";
	section.innerHTML = `
		<hr>
		<div><strong>${escapeHtml(localize("Fire Ball", "Ognista Kula"))} ${impact.ballNumber}</strong> — ${escapeHtml(impact.targetName)}</div>
		<div>${escapeHtml(localize("Damage", "Obrażenia"))}: ${impact.strength} + ${impact.damageRoll}${impact.flammable ? ` + ${impact.flammableRoll}` : ""} = ${impact.fullDamage}</div>
		<div>${escapeHtml(localize("Initiative", "Inicjatywa"))}: ${impact.initiativeSuccess ? localize("success — damage halved", "sukces — obrażenia o połowę") : localize("failure — full damage", "porażka — pełne obrażenia")}</div>
		<div>${escapeHtml(localize("Armour", "Pancerz"))}: ${escapeHtml(localize("ignored", "ignorowany"))}; ${escapeHtml(localize("Toughness", "Wytrzymałość"))}: ${impact.toughness}</div>
		<div><strong>${escapeHtml(localize("Final damage", "Końcowe obrażenia"))}: ${impact.finalDamage}</strong></div>
	`;
	messageContent.append(section);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
