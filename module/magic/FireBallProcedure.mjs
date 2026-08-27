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
const GROUP_SPACING = 3;
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
	if (magicPoints < 1) {
		throw new Error(localize(
			"The caster has no Magic Points available.",
			"Osoba rzucająca czar nie ma dostępnych Punktów Magii.",
		));
	}

	const roundUsage = fireBallRoundUsage(actor);
	if (roundUsage.cast) {
		throw new Error(localize(
			"Fire Ball has already been cast by this character in the current combat round.",
			"Ta postać rzuciła już Ognistą Kulę w bieżącej rundzie walki.",
		));
	}

	const maximum = Math.min(powerLevel, magicPoints);
	const configuration = await configureCast({
		actor,
		spell,
		powerLevel,
		maximum,
	});
	if (!configuration) return null;

	const volleys = await resolveVolleyTargets(
		configuration,
		configuration.targets,
		powerLevel,
	);

	const magicPointsAfter = magicPoints - configuration.fireBalls;
	const resourceUpdate = { "system.status.magicPoints": magicPointsAfter };
	if (roundUsage.managed) {
		resourceUpdate[`flags.${FLAG_SCOPE}.${ROUND_USAGE_FLAG_KEY}`] = {
			version: 2,
			combatId: roundUsage.combatId,
			round: roundUsage.round,
			cast: true,
			fireBalls: configuration.fireBalls,
		};
	}
	await actor.update(resourceUpdate);
	await publishCastSummary({
		actor,
		spell,
		configuration,
		volleys,
		magicPoints,
		magicPointsAfter,
	});

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

async function configureCast({ actor, spell, powerLevel, maximum }) {
	let targets = selectedTargets(actor);
	const draft = {
		fireBalls: "1",
		errors: {},
		conditions: conditionsForTargets({}, targets),
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
		<section class="wfrp-fireball-dialog__target-section${draft.errors.targets ? " has-error" : ""}">
			<div class="wfrp-fireball-dialog__target-heading">
				<strong>${escapeHtml(localize("Target", "Cel"))}</strong>
				<button type="button" data-fire-ball-refresh-targets>
					<i class="fa-solid fa-bullseye" aria-hidden="true"></i>
					${escapeHtml(localize("Use current targets", "Użyj aktualnie wskazanych celów"))}
				</button>
			</div>
			<div class="wfrp-fireball-dialog__target-mode" data-fire-ball-target-mode></div>
			${draft.errors.targets ? `<div class="wfrp-fireball-dialog__validation" role="alert">${escapeHtml(draft.errors.targets)}</div>` : ""}
			<div class="wfrp-fireball-dialog__targets" data-fire-ball-target-list></div>
		</section>
	`;
		content.append(root);
		renderTargetList(root, targets, draft.conditions);

		const response = await DialogV2.wait({
			classes: ["wfrp1ed", "wfrp1ed-parchment-window", "wfrp-fireball-cast-dialog"],
			window: { title: `${spell.name} — ${actor.name}` },
			content,
			render: (_event, dialog) => {
				const dialogRoot = dialog?.element;
				const refresh = dialogRoot?.querySelector?.("[data-fire-ball-refresh-targets]");
				if (!refresh) return;
				refresh.addEventListener("click", (event) => {
					event.preventDefault();
					const form = refresh.closest("form");
					draft.fireBalls = String(form?.elements?.fireBalls?.value ?? draft.fireBalls);
					draft.conditions = readConditions(form, targets);
					targets = selectedTargets(actor);
					draft.conditions = conditionsForTargets(draft.conditions, targets);
					draft.errors.targets = null;
					renderTargetList(dialogRoot, targets, draft.conditions);
				});
			},
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

		const validation = validateConfiguration({
			response,
			maximum,
			targets,
			actor,
		});
		if (validation.valid) {
			return Object.freeze({
				fireBalls: validation.fireBalls,
				conditions: response.conditions,
				group: targets.length > 1,
				targets: Object.freeze([...targets]),
				powerLevel,
			});
		}

		draft.fireBalls = String(response.fireBalls ?? "");
		draft.conditions = response.conditions;
		draft.errors = validation.errors;
	}
}

function renderTargetList(root, targets, conditions) {
	const list = root?.querySelector?.("[data-fire-ball-target-list]");
	const mode = root?.querySelector?.("[data-fire-ball-target-mode]");
	if (!list || !mode) return;

	list.replaceChildren();
	mode.textContent = targets.length === 0
		? localize("No targets selected.", "Nie wskazano celów.")
		: targets.length === 1
			? localize("Individual target", "Cel pojedynczy")
			: localize(
				`Target group — ${targets.length} creatures`,
				`Grupa celów — ${targets.length} istot`,
			);

	for (const target of targets) {
		const row = document.createElement("fieldset");
		row.dataset.targetUuid = target.key;
		const legend = document.createElement("legend");
		legend.textContent = target.name;
		row.append(
			legend,
			conditionLabel(
				"flammable",
				localize("Flammable", "Łatwopalny"),
				conditions[target.key]?.flammable,
			),
			conditionLabel(
				"fearOfFire",
				localize("Subject to fear of fire", "Podatny na strach przed ogniem"),
				conditions[target.key]?.fearOfFire,
			),
		);
		list.append(row);
	}
}

function conditionsForTargets(previous, targets) {
	return Object.fromEntries(targets.map((target) => [
		target.key,
		{
			flammable: previous?.[target.key]?.flammable === true,
			fearOfFire: previous?.[target.key]?.fearOfFire === true,
		},
	]));
}

function validateConfiguration({ response, maximum, targets, actor }) {
	const errors = {};
	const fireBalls = Number(response.fireBalls);
	if (!Number.isInteger(fireBalls) || fireBalls < 1 || fireBalls > maximum) {
		errors.fireBalls = localize(
			`Enter a whole number from 1 to ${maximum}.`,
			`Wprowadź liczbę całkowitą od 1 do ${maximum}.`,
		);
	}

	if (targets.length === 0) {
		errors.targets = localize(
			"Select at least one target.",
			"Wskaż co najmniej jeden cel.",
		);
	} else if (WfrpRuleSettings.usesAutomaticSpellTokenDistance()) {
		const rangeFailures = targets
			.filter((target) => Number.isFinite(target.distance) && target.distance > RANGE)
			.map((target) => target.name);
		if (rangeFailures.length > 0) {
			errors.targets = localize(
				`Outside Fire Ball range (${RANGE}): ${rangeFailures.join(", ")}.`,
				`Poza zasięgiem Ognistej Kuli (${RANGE}): ${rangeFailures.join(", ")}.`,
			);
		}

		if (!errors.targets && targets.length > 1) {
			const connected = groupConnectivity(targets);
			if (connected === false) {
				errors.targets = localize(
					`The selected tokens do not form one spell group: every member must be connected to the group through creatures no more than ${GROUP_SPACING} yards apart.`,
					`Wskazane tokeny nie tworzą jednej grupy: każdy członek musi być połączony z grupą przez istoty oddalone od siebie o nie więcej niż ${GROUP_SPACING} jardy.`,
				);
			}
		}
	}

	return {
		valid: Object.keys(errors).length === 0,
		errors,
		fireBalls,
	};
}

function groupConnectivity(targets) {
	if (targets.length < 2) return true;
	if (targets.some((target) => !target.token || !tokenCenter(target.token))) {
		return null;
	}

	const visited = new Set([0]);
	const queue = [0];
	while (queue.length > 0) {
		const current = queue.shift();
		for (let index = 0; index < targets.length; index += 1) {
			if (visited.has(index)) continue;
			const distance = tokenDistance(targets[current].token, targets[index].token);
			if (!Number.isFinite(distance)) return null;
			if (distance <= GROUP_SPACING) {
				visited.add(index);
				queue.push(index);
			}
		}
	}
	return visited.size === targets.length;
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
	return {
		fireBalls: String(form?.elements?.fireBalls?.value ?? "").trim(),
		conditions: readConditions(form, targets),
	};
}

function readConditions(form, targets) {
	const conditions = {};
	for (const target of targets) {
		const row = form?.querySelector?.(`[data-target-uuid="${cssEscape(target.key)}"]`);
		conditions[target.key] = {
			flammable: row?.querySelector?.('[data-fire-ball-condition="flammable"]')?.checked === true,
			fearOfFire: row?.querySelector?.('[data-fire-ball-condition="fearOfFire"]')?.checked === true,
		};
	}
	return conditions;
}

async function resolveVolleyTargets(configuration, targets, powerLevel) {
	const volleys = [];
	for (let index = 0; index < configuration.fireBalls; index += 1) {
		if (!configuration.group) {
			volleys.push({ targets: [targets[0]], groupRoll: null });
			continue;
		}

		const groupRoll = await new Roll(`${powerLevel}d3`).evaluate();
		const count = Math.min(
			nonNegativeInteger(groupRoll.total, "Group hits"),
			targets.length,
		);
		const selected = await randomTargets(targets, count);
		volleys.push({ targets: selected, groupRoll });
	}
	return Object.freeze(volleys);
}

async function randomTargets(targets, count) {
	const pool = [...targets];
	const selected = [];
	while (selected.length < count && pool.length > 0) {
		const roll = await new Roll(`1d${pool.length}`).evaluate();
		const index = Math.max(0, Math.min(pool.length - 1, Number(roll.total) - 1));
		selected.push(pool.splice(index, 1)[0]);
	}
	return Object.freeze(selected);
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
	return Object.freeze({
		packetId: packet.id,
		targetUuid: targetActor.uuid,
		finalDamage: resolution.finalAmount,
	});
}

async function publishCastSummary({
	actor,
	spell,
	configuration,
	volleys,
	magicPoints,
	magicPointsAfter,
}) {
	const groupDetails = volleys.map((volley, index) => ({
		ballNumber: index + 1,
		groupRoll: volley.groupRoll
			? nonNegativeInteger(volley.groupRoll.total, "Group hits")
			: null,
		targets: volley.targets.map((target) => ({
			uuid: target.key,
			name: target.name,
		})),
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
		version: 2,
		casterUuid: actor.uuid,
		spellUuid: spell.uuid,
		fireBalls: configuration.fireBalls,
		magicPointsBefore: magicPoints,
		magicPointsAfter,
		group: configuration.group,
		targets: configuration.targets.map((target) => ({
			uuid: target.key,
			name: target.name,
		})),
		volleys: groupDetails,
	});
}

function selectedTargets(actor) {
	const automaticDistance = WfrpRuleSettings.usesAutomaticSpellTokenDistance();
	const casterToken = automaticDistance ? activeCasterToken(actor) : null;
	return Object.freeze([...(game.user?.targets ?? [])].map((token) =>
		Object.freeze({
			key: token.document?.uuid ?? token.uuid,
			name: token.name,
			actor: token.actor,
			token,
			distance: casterToken ? tokenDistance(casterToken, token) : null,
		}),
	));
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
		return {
			managed: false,
			combatId: null,
			round: null,
			cast: false,
		};
	}

	const stored = actor.getFlag?.(FLAG_SCOPE, ROUND_USAGE_FLAG_KEY);
	const sameRound = stored?.combatId === combat.id &&
		Number(stored?.round) === Number(combat.round);
	return {
		managed: true,
		combatId: combat.id,
		round: Number(combat.round),
		cast: sameRound && (
			stored?.cast === true ||
			nonNegativeInteger(stored?.used ?? 0, "Fire Ball round usage") > 0
		),
	};
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
	if (!messageContent || messageContent.querySelector(".wfrp-fire-ball-impact")) {
		return;
	}
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
