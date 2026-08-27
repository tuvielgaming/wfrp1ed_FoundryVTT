import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { TargetRowInteraction } from "../targets/TargetRowInteraction.mjs";
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
	const automaticDistanceSetting = WfrpRuleSettings.usesAutomaticSpellTokenDistance();
	const draft = {
		fireBalls: "1",
		errors: {},
		conditions: conditionsForTargets({}, targets),
		ignoreCastingRestrictions: false,
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
		<section class="wfrp-fireball-dialog__target-section${draft.errors.targets ? " has-error" : ""}" data-fire-ball-drop-zone>
			<div class="wfrp-fireball-dialog__target-heading">
				<strong>${escapeHtml(localize("Target", "Cel"))}</strong>
				<div class="wfrp-fireball-dialog__target-actions">
					<button type="button" data-fire-ball-refresh-targets>
						<i class="fa-solid fa-bullseye" aria-hidden="true"></i>
						${escapeHtml(localize("Use current targets", "Użyj aktualnie wskazanych celów"))}
					</button>
					${game.user?.isGM ? `<button type="button" data-fire-ball-choose-actor><i class="fa-solid fa-user-plus" aria-hidden="true"></i>${escapeHtml(localize("Add Actor", "Dodaj Aktora"))}</button>` : ""}
				</div>
			</div>
			${game.user?.isGM ? `<div class="wfrp-fireball-dialog__drop-hint">${escapeHtml(localize("You may also drop Actors from the sidebar here.", "Możesz również upuszczać tutaj Aktorów z panelu bocznego."))}</div>` : ""}
			<div class="wfrp-fireball-dialog__target-mode" data-fire-ball-target-mode></div>
			${draft.errors.targets ? `<div class="wfrp-fireball-dialog__validation" role="alert">${escapeHtml(draft.errors.targets)}</div>` : ""}
			${automaticDistanceSetting ? distancePolicyMarkup(draft) : ""}
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
				if (!(dialogRoot instanceof HTMLElement)) return;

				const saveDraft = () => {
					const form = dialogRoot.querySelector("form") ?? dialogRoot.closest("form");
					draft.fireBalls = String(form?.elements?.fireBalls?.value ?? draft.fireBalls);
					draft.conditions = readConditions(form, targets);
					draft.ignoreCastingRestrictions = game.user?.isGM === true &&
						form?.elements?.ignoreCastingRestrictions?.checked === true;
				};

				const refresh = dialogRoot.querySelector("[data-fire-ball-refresh-targets]");
				refresh?.addEventListener("click", (event) => {
					event.preventDefault();
					saveDraft();
					targets = mergeTargets([], selectedTargets(actor));
					draft.conditions = conditionsForTargets(draft.conditions, targets);
					draft.errors.targets = null;
					renderTargetList(dialogRoot, targets, draft.conditions);
				});

				const chooseActor = dialogRoot.querySelector("[data-fire-ball-choose-actor]");
				if (chooseActor && game.user?.isGM) {
					chooseActor.addEventListener("click", (event) => {
						event.preventDefault();
						saveDraft();
						void ActorTargetResolver.chooseActor().then((chosen) => {
							if (!chosen) return;
							targets = mergeTargets(targets, [targetFromActor(chosen)]);
							draft.conditions = conditionsForTargets(draft.conditions, targets);
							draft.errors.targets = null;
							renderTargetList(dialogRoot, targets, draft.conditions);
						});
					});
				}

				const dropZone = dialogRoot.querySelector("[data-fire-ball-drop-zone]");
				if (dropZone && game.user?.isGM) {
					dropZone.addEventListener("dragover", (event) => {
						event.preventDefault();
						dropZone.classList.add("is-dragover");
					});
					dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
					dropZone.addEventListener("drop", (event) => {
						event.preventDefault();
						dropZone.classList.remove("is-dragover");
						saveDraft();
						void ActorTargetResolver.actorFromDropEvent(event).then((dropped) => {
							if (!dropped) return;
							targets = mergeTargets(targets, [targetFromActor(dropped)]);
							draft.conditions = conditionsForTargets(draft.conditions, targets);
							draft.errors.targets = null;
							renderTargetList(dialogRoot, targets, draft.conditions);
						}).catch(reportTargetError);
					});
				}

				dialogRoot.addEventListener("click", (event) => {
					const remove = event.target?.closest?.("[data-fire-ball-remove-target]");
					if (!(remove instanceof HTMLButtonElement)) return;
					event.preventDefault();
					saveDraft();
					const key = String(remove.dataset.fireBallRemoveTarget ?? "");
					targets = Object.freeze(targets.filter((target) => target.key !== key));
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
					callback: (_event, button) => readConfiguration(
						button.form,
						targets,
						automaticDistanceSetting,
					),
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
			automaticDistanceSetting,
		});
		if (validation.valid) {
			return Object.freeze({
				fireBalls: validation.fireBalls,
				conditions: response.conditions,
				group: targets.length > 1,
				targets: Object.freeze([...targets]),
				powerLevel,
				distanceValidation: Object.freeze(validation.distanceValidation),
			});
		}

		draft.fireBalls = String(response.fireBalls ?? "");
		draft.conditions = response.conditions;
		draft.ignoreCastingRestrictions = response.distanceControl?.ignoreRestrictions === true;
		draft.errors = validation.errors;
	}
}

function distancePolicyMarkup(draft) {
	if (!game.user?.isGM) return "";
	return `
		<div class="wfrp-fireball-dialog__distance-policy">
			<label class="wfrp1ed-checkbox"><input type="checkbox" name="ignoreCastingRestrictions" ${draft.ignoreCastingRestrictions ? "checked" : ""}> ${escapeHtml(localize(
				"Ignore casting restrictions for this spell",
				"Zignoruj ograniczenia rzucania dla tego czaru",
			))}</label>
		</div>
	`;
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
		const name = document.createElement("span");
		name.dataset.wfrpTargetIdentity = "";
		name.textContent = target.name;
		legend.append(name);

		const remove = document.createElement("button");
		remove.type = "button";
		remove.dataset.fireBallRemoveTarget = target.key;
		remove.className = "wfrp-fireball-dialog__remove-target";
		remove.setAttribute("aria-label", localize("Remove target", "Usuń cel"));
		remove.title = localize("Remove target", "Usuń cel");
		remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
		legend.append(remove);

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
		TargetRowInteraction.bind(row, target);
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

function validateConfiguration({
	response,
	maximum,
	targets,
	actor,
	automaticDistanceSetting,
}) {
	const errors = {};
	const fireBalls = Number(response.fireBalls);
	if (!Number.isInteger(fireBalls) || fireBalls < 1 || fireBalls > maximum) {
		errors.fireBalls = localize(
			`Enter a whole number from 1 to ${maximum}.`,
			`Wprowadź liczbę całkowitą od 1 do ${maximum}.`,
		);
	}

	let distanceValidation = manualDistanceSnapshot(automaticDistanceSetting);
	if (targets.length === 0) {
		errors.targets = localize(
			"Select at least one target.",
			"Wskaż co najmniej jeden cel.",
		);
	} else if (automaticDistanceSetting) {
		const ignoreRestrictions = response.distanceControl?.ignoreRestrictions === true && game.user?.isGM === true;

		if (ignoreRestrictions) {
			distanceValidation = Object.freeze({
				mode: "gm-override",
				settingEnabled: true,
				result: "skipped",
				ignoreRestrictions: true,
				overridden: true,
				adjudicatedBy: String(game.user?.id ?? ""),
				adjudicatedAt: Date.now(),
				diagnostics: [],
			});
		} else {
			const assessment = automaticDistanceAssessment(actor, targets);
			distanceValidation = Object.freeze({
				mode: "automatic",
				settingEnabled: true,
				result: assessment.result,
				ignoreRestrictions: false,
				overridden: false,
				adjudicatedBy: null,
				adjudicatedAt: null,
				diagnostics: assessment.diagnostics,
			});

			if (assessment.result !== "valid") {
				errors.targets = distanceValidationError(assessment, game.user?.isGM === true);
			}
		}
	}

	return {
		valid: Object.keys(errors).length === 0,
		errors,
		fireBalls,
		distanceValidation,
	};
}

function automaticDistanceAssessment(actor, targets) {
	const diagnostics = [];
	const casterToken = activeCasterToken(actor);
	if (!casterToken) {
		diagnostics.push(localize(
			"The caster has no measurable token on the active Scene.",
			"Rzucający czar nie ma mierzalnego tokenu na aktywnej Scenie.",
		));
		return { result: "unmeasurable", diagnostics };
	}

	const unmeasurable = [];
	const outside = [];
	for (const target of targets) {
		if (!target.token || !tokenCenter(target.token)) {
			unmeasurable.push(target.name);
			continue;
		}
		const distance = tokenDistance(casterToken, target.token);
		if (!Number.isFinite(distance)) unmeasurable.push(target.name);
		else if (distance > RANGE) outside.push(`${target.name} (${formatDistance(distance)})`);
	}
	if (unmeasurable.length > 0) {
		diagnostics.push(localize(
			`No measurable Scene token: ${unmeasurable.join(", ")}.`,
			`Brak mierzalnego tokenu na Scenie: ${unmeasurable.join(", ")}.`,
		));
	}
	if (outside.length > 0) {
		diagnostics.push(localize(
			`Outside Fire Ball range ${RANGE}: ${outside.join(", ")}.`,
			`Poza zasięgiem Ognistej Kuli ${RANGE}: ${outside.join(", ")}.`,
		));
	}

	if (unmeasurable.length > 0) return { result: "unmeasurable", diagnostics };
	if (outside.length > 0) return { result: "invalid", diagnostics };

	if (targets.length > 1) {
		const connected = groupConnectivity(targets);
		if (connected === null) {
			diagnostics.push(localize(
				"The selected group spacing cannot be measured on the active Scene.",
				"Nie można zmierzyć odstępów w wybranej grupie na aktywnej Scenie.",
			));
			return { result: "unmeasurable", diagnostics };
		}
		if (!connected) {
			diagnostics.push(localize(
				`The selected tokens are not one connected spell group (maximum ${GROUP_SPACING} yards between connected members).`,
				`Wskazane tokeny nie tworzą jednej połączonej grupy czaru (maksymalnie ${GROUP_SPACING} jardy pomiędzy połączonymi członkami).`,
			));
			return { result: "invalid", diagnostics };
		}
	}

	return { result: "valid", diagnostics };
}

function manualDistanceSnapshot(settingEnabled) {
	return Object.freeze({
		mode: "gm-manual",
		settingEnabled: settingEnabled === true,
		result: settingEnabled === true ? "pending" : "not-checked",
		ignoreRestrictions: false,
		overridden: false,
		adjudicatedBy: settingEnabled === true ? null : String(game.user?.id ?? ""),
		adjudicatedAt: settingEnabled === true ? null : Date.now(),
		diagnostics: [],
	});
}

function distanceValidationError(assessment, gmCanOverride) {
	const details = assessment.diagnostics.join(" ");
	const action = gmCanOverride
		? localize(
			" Select ‘Ignore casting restrictions for this spell’ to continue anyway.",
			" Zaznacz „Zignoruj ograniczenia rzucania dla tego czaru”, aby mimo tego kontynuować.",
		)
		: localize(
			" A GM must adjudicate this automatic distance result.",
			" Ten wynik automatycznego pomiaru musi rozstrzygnąć MG.",
		);
	return `${details}${action}`.trim();
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
	label.className = "wfrp1ed-checkbox";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.dataset.fireBallCondition = kind;
	input.checked = checked === true;
	label.append(input, document.createTextNode(text));
	return label;
}

function readConfiguration(form, targets, automaticDistanceSetting) {
	return {
		fireBalls: String(form?.elements?.fireBalls?.value ?? "").trim(),
		conditions: readConditions(form, targets),
		distanceControl: {
			settingEnabled: automaticDistanceSetting === true,
			ignoreRestrictions: game.user?.isGM === true &&
				form?.elements?.ignoreCastingRestrictions?.checked === true,
		},
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
		targetTokenUuid: target.tokenUuid || target.key,
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
			actorUuid: target.actorUuid,
			tokenUuid: target.tokenUuid,
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
		version: 3,
		casterUuid: actor.uuid,
		spellUuid: spell.uuid,
		fireBalls: configuration.fireBalls,
		magicPointsBefore: magicPoints,
		magicPointsAfter,
		group: configuration.group,
		distanceValidation: foundry.utils.deepClone(configuration.distanceValidation),
		targets: configuration.targets.map((target) => ({
			uuid: target.key,
			actorUuid: target.actorUuid,
			tokenUuid: target.tokenUuid,
			name: target.name,
		})),
		volleys: groupDetails,
	});
}

function selectedTargets(actor) {
	const casterToken = WfrpRuleSettings.usesAutomaticSpellTokenDistance()
		? activeCasterToken(actor)
		: null;
	return Object.freeze([...(game.user?.targets ?? [])]
		.map((token) => targetFromToken(token, casterToken))
		.filter(Boolean));
}

function targetFromToken(token, casterToken = null) {
	if (!token?.actor) return null;
	const tokenUuid = String(token.document?.uuid ?? token.uuid ?? "").trim();
	const actorUuid = String(token.actor?.uuid ?? "").trim();
	if (!tokenUuid || !actorUuid) return null;
	return Object.freeze({
		key: tokenUuid,
		actorUuid,
		tokenUuid,
		name: String(token.name ?? token.actor.name ?? "—"),
		actor: token.actor,
		token,
		distance: casterToken ? tokenDistance(casterToken, token) : null,
	});
}

function targetFromActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return null;
	return Object.freeze({
		key: String(actor.uuid),
		actorUuid: String(actor.uuid),
		tokenUuid: "",
		name: String(actor.name ?? "—"),
		actor,
		token: null,
		distance: null,
	});
}

function mergeTargets(existing, incoming) {
	const merged = [...(existing ?? [])].filter(Boolean);
	for (const candidate of incoming ?? []) {
		if (!candidate) continue;
		if (candidate.tokenUuid) {
			if (merged.some((target) => target.tokenUuid === candidate.tokenUuid)) continue;
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				if (!merged[index].tokenUuid && merged[index].actorUuid === candidate.actorUuid) {
					merged.splice(index, 1);
				}
			}
			merged.push(candidate);
			continue;
		}
		if (merged.some((target) => target.actorUuid === candidate.actorUuid)) continue;
		merged.push(candidate);
	}
	return Object.freeze(merged);
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

function formatDistance(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return "?";
	return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
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

function reportTargetError(error) {
	console.error("WFRP1ED | Unable to add Fire Ball target.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to add the selected target.",
		"Nie udało się dodać wybranego celu.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}