import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { SPELL_PROCEDURE_ID } from "./SpellProcedureRegistry.mjs";

const { DialogV2 } = foundry.applications.api;
const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpact";
const CAST_FLAG_KEY = "fireBallCast";
const ROUND_USAGE_FLAG_KEY = "fireBallRoundUsage";
const STRENGTH = 3;
const RANGE = 48;

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
	const targets = selectedTargetsInRange(actor);
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

	const configuration = await configureCast({
		actor,
		spell,
		targets,
		maximum,
	});
	if (!configuration) return null;

	const volleys = await resolveVolleyTargets(
		configuration,
		targets,
		powerLevel,
	);
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

async function configureCast({ actor, spell, targets, maximum }) {
	let draft = {
		fireBalls: 1,
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
		<div class="form-group">
			<label>${escapeHtml(localize("Fire Balls", "Liczba kul"))}</label>
			<div class="form-fields"><input type="number" name="fireBalls" min="1" max="${maximum}" step="1" value="${draft.fireBalls}" required></div>
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
				conditionLabel(
					"flammable",
					localize("Flammable", "Łatwopalny"),
					draft.conditions[target.key]?.flammable,
				),
				conditionLabel(
					"fearOfFire",
					localize("Subject to fear of fire", "Podatny na strach przed ogniem"),
					draft.conditions[target.key]?.fearOfFire,
				),
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
					callback: () => null,
				},
			],
			rejectClose: false,
		});
		if (!response) return null;

		draft = response;
		try {
			return {
				...response,
				fireBalls: integerInRange(response.fireBalls, 1, maximum),
				group: targets.length > 1,
			};
		} catch (error) {
			ui.notifications.warn(error.message);
		}
	}
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
	const fireBalls = Number(form?.elements?.fireBalls?.value);
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
				{ action: "cancel", label: localize("Cancel", "Anuluj"), callback: () => null },
			],
			rejectClose: false,
		});
		if (!response) return null;
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
	const rollLines = volleys.map((volley, index) => configuration.group
		? `<li>${escapeHtml(localize("Ball", "Kula"))} ${index + 1}: ${escapeHtml(String(volley.groupRoll.total))} — ${escapeHtml(volley.targets.map((target) => target.name).join(", "))}</li>`
		: `<li>${escapeHtml(localize("Ball", "Kula"))} ${index + 1}: ${escapeHtml(volley.targets[0].name)}</li>`).join("");
	const content = `<article class="wfrp-fireball-cast-card">
		<header><strong>${escapeHtml(spell.name)}</strong><span>${configuration.fireBalls}</span></header>
		<div>${escapeHtml(localize("Caster", "Rzucający"))}: <strong>${escapeHtml(actor.name)}</strong></div>
		<div>${escapeHtml(localize("Magic Points", "Punkty Magii"))}: ${magicPoints} → ${magicPointsAfter}</div>
		<ul>${rollLines}</ul>
	</article>`;
	return ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content,
		rolls: volleys.map((volley) => volley.groupRoll).filter(Boolean),
		flags: { [FLAG_SCOPE]: { [CAST_FLAG_KEY]: { version: 1, actorUuid: actor.uuid, spellUuid: spell.uuid } } },
	});
}

function decorateImpact(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const card = root?.querySelector?.(".wfrp1e-test-card") ?? (root?.matches?.(".wfrp1e-test-card") ? root : null);
	if (!card || card.querySelector("[data-wfrp-fireball-impact]")) return;
	const panel = document.createElement("section");
	panel.className = "wfrp-fireball-impact";
	panel.dataset.wfrpFireballImpact = "";
	panel.innerHTML = `
		<h3>${escapeHtml(state.spellName)} — ${escapeHtml(localize("damage", "obrażenia"))}</h3>
		<div><span>1d10</span><strong>${state.damageRoll}</strong></div>
		<div><span>${escapeHtml(localize("Strength", "Siła"))}</span><strong>+${state.strength}</strong></div>
		${state.flammable ? `<div><span>${escapeHtml(localize("Flammable target", "Cel łatwopalny"))} (1d8)</span><strong>+${state.flammableRoll}</strong></div>` : ""}
		<div><span>${escapeHtml(localize("Before Initiative", "Przed Inicjatywą"))}</span><strong>${state.fullDamage}</strong></div>
		<div><span>${escapeHtml(localize("Initiative", "Inicjatywa"))}</span><strong>${escapeHtml(state.initiativeSuccess ? localize("Success — half", "Sukces — połowa") : localize("Failure — full", "Porażka — całość"))}</strong></div>
		<div><span>${escapeHtml(localize("Before Toughness", "Przed Wytrzymałością"))}</span><strong>${state.afterInitiative}</strong></div>
		<div><span>${escapeHtml(localize("Armour", "Pancerz"))}</span><strong>${escapeHtml(localize("ignored", "pominięty"))}</strong></div>
		<div><span>${escapeHtml(localize("Toughness", "Wytrzymałość"))}</span><strong>−${state.toughness}</strong></div>
		<div class="wfrp-fireball-impact__final"><span>${escapeHtml(localize("Final damage", "Końcowe obrażenia"))}</span><strong>${state.finalDamage}</strong></div>
	`;
	card.append(panel);
}

function selectedTargetsInRange(actor) {
	if (!canvas?.ready || !canvas.grid) {
		throw new Error(localize(
			"The canvas must be ready to cast a ranged Spell.",
			"Plansza musi być gotowa, aby rzucić Czar dystansowy.",
		));
	}
	const targets = [...(game.user?.targets ?? [])]
		.filter((token) => token?.actor?.documentName === "Actor")
		.map((token) => ({
			key: String(token.document?.uuid ?? token.id ?? token.actor.uuid),
			actor: token.actor,
			token,
			name: String(token.name ?? token.actor.name ?? ""),
		}));
	if (targets.length === 0) return targets;

	const source = casterToken(actor);
	const outside = targets.filter((target) => {
		const measured = canvas.grid.measurePath([source.center, target.token.center]);
		const distance = Number(measured?.distance);
		if (!Number.isFinite(distance)) {
			throw new Error(localize(
				`Unable to measure the distance to ${target.name}.`,
				`Nie można zmierzyć odległości do celu ${target.name}.`,
			));
		}
		return distance > RANGE;
	});
	if (outside.length > 0) {
		throw new Error(localize(
			`Fire Ball has a range of ${RANGE}; outside range: ${outside.map((target) => target.name).join(", ")}.`,
			`Ognista Kula ma zasięg ${RANGE}; poza zasięgiem: ${outside.map((target) => target.name).join(", ")}.`,
		));
	}
	return targets;
}

function casterToken(actor) {
	const controlled = [...(canvas?.tokens?.controlled ?? [])]
		.filter((token) => token?.actor?.uuid === actor.uuid);
	if (controlled.length === 1) return controlled[0];

	const active = [...(actor.getActiveTokens?.() ?? [])]
		.filter((token) => token?.document?.parent?.id === canvas.scene?.id);
	if (active.length === 1) return active[0];

	throw new Error(localize(
		"Place the caster on this Scene. If more than one of its tokens is present, control the casting token first.",
		"Umieść rzucającego czar na tej Scenie. Jeśli znajduje się na niej więcej niż jeden jego token, najpierw zaznacz token rzucający czar.",
	));
}

function fireBallRoundUsage(actor) {
	const combat = game.combat;
	const round = Number(combat?.round);
	const participant = combat?.started === true &&
		Number.isInteger(round) && round > 0 &&
		[...(combat.combatants ?? [])]
			.some((combatant) => combatant.actor?.uuid === actor.uuid);
	if (!participant) {
		return { managed: false, combatId: null, round: null, used: 0 };
	}

	const state = actor.getFlag?.(FLAG_SCOPE, ROUND_USAGE_FLAG_KEY) ?? {};
	const current = String(state.combatId ?? "") === String(combat.id ?? "") &&
		Number(state.round) === round;
	return {
		managed: true,
		combatId: String(combat.id ?? ""),
		round,
		used: current ? nonNegativeInteger(state.used ?? 0, "Fire Ball round usage") : 0,
	};
}

function positiveInteger(value, label) {
	const number = nonNegativeInteger(value, label);
	if (number < 1) throw new Error(`${label}: ${localize("must be at least 1", "musi wynosić co najmniej 1")}.`);
	return number;
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) throw new Error(`${label}: invalid value.`);
	return number;
}

function integerInRange(value, minimum, maximum) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new Error(localize(
			`Choose a whole number from ${minimum} to ${maximum}.`,
			`Wybierz liczbę całkowitą od ${minimum} do ${maximum}.`,
		));
	}
	return number;
}

function asElement(value) {
	if (value?.nodeType === 1) return value;
	if (value?.[0]?.nodeType === 1) return value[0];
	return null;
}

function cssEscape(value) {
	return globalThis.CSS?.escape?.(String(value)) ?? String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
