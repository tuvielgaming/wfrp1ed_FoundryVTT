import { RuleAdjudicationDialog } from "../adjudication/RuleAdjudicationDialog.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { TargetRowInteraction } from "../targets/TargetRowInteraction.mjs";
import { ActorTestRequestWorkflow } from "../tests/ActorTestRequestWorkflow.mjs";
import { FireBallImpactWorkflow } from "./FireBallImpactWorkflow.mjs";
import { SPELL_PROCEDURE_ID } from "./SpellProcedureRegistry.mjs";

const { DialogV2 } = foundry.applications.api;
const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG_KEY = "fireBallCast";
const ROUND_USAGE_FLAG_KEY = "fireBallRoundUsage";
const RANGE = 48;
const GROUP_SPACING = 3;
const CANCEL_DIALOG_RESULT = Object.freeze({ cancelled: true });

export const FireBallProcedure = Object.freeze({
	id: SPELL_PROCEDURE_ID.FIRE_BALL,
	label: () => localize("Fire Ball", "Ognista Kula"),
	execute: (actor, spell) => executeFireBall(actor, spell),
});

/* Presentation is owned by FireBallImpactWorkflow and the shared damage UI. */
export function installFireBallPresentation() {}

async function executeFireBall(actor, spell) {
	const powerLevel = positiveInteger(actor.system?.status?.powerLevel, localize("Power Level", "Poziom Mocy"));
	const magicPoints = nonNegativeInteger(actor.system?.status?.magicPoints, localize("Magic Points", "Punkty Magii"));
	if (magicPoints < 1) throw new Error(localize("The caster has no Magic Points available.", "Osoba rzucająca czar nie ma dostępnych Punktów Magii."));

	const roundUsage = fireBallRoundUsage(actor);
	if (roundUsage.cast) throw new Error(localize(
		"Fire Ball has already been cast by this character in the current combat round.",
		"Ta postać rzuciła już Ognistą Kulę w bieżącej rundzie walki.",
	));

	const configuration = await configureCast({
		actor,
		spell,
		powerLevel,
		maximum: Math.min(powerLevel, magicPoints),
	});
	if (!configuration) return null;

	const volleys = await resolveVolleyTargets(configuration, configuration.targets, powerLevel);
	const magicPointsAfter = magicPoints - configuration.fireBalls;
	const update = { "system.status.magicPoints": magicPointsAfter };
	if (roundUsage.managed) {
		update[`flags.${FLAG_SCOPE}.${ROUND_USAGE_FLAG_KEY}`] = {
			version: 3,
			combatId: roundUsage.combatId,
			round: roundUsage.round,
			cast: true,
			fireBalls: configuration.fireBalls,
		};
	}
	await actor.update(update);
	await publishCastSummary({ actor, spell, configuration, volleys, magicPoints, magicPointsAfter });

	/* Fear of Fire is a target-level reaction to this casting, not a reaction to
	 * every projectile. Deduplicate all creatures hit by one or more balls before
	 * creating Fear requests. */
	const affected = new Map(
		volleys.flatMap((volley) => volley.targets).map((target) => [target.key, target]),
	);
	for (const target of affected.values()) {
		if (configuration.conditions[target.key]?.fearOfFire) {
			await ActorTestRequestWorkflow.create({
				actor: target.actor,
				testId: "fear",
				title: localize("Fear of Fire", "Strach przed ogniem"),
				description: localize(
					`${target.name} is subject to fear of fire from ${spell.name}.`,
					`${target.name} podlega strachowi przed ogniem wywołanemu przez ${spell.name}.`,
				),
				source: { kind: "spell-fire-ball", spellUuid: String(spell.uuid ?? "") },
			});
		}
	}

	const impacts = [];
	for (let ballIndex = 0; ballIndex < volleys.length; ballIndex += 1) {
		for (const target of volleys[ballIndex].targets) {
			impacts.push(await FireBallImpactWorkflow.create({
				caster: actor,
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
		impactMessageIds: Object.freeze(impacts.map((message) => String(message?.id ?? "")).filter(Boolean)),
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
						<button type="button" data-fire-ball-refresh-targets><i class="fa-solid fa-bullseye" aria-hidden="true"></i>${escapeHtml(localize("Use current targets", "Użyj aktualnie wskazanych celów"))}</button>
						${game.user?.isGM ? `<button type="button" data-fire-ball-choose-actor><i class="fa-solid fa-user-plus" aria-hidden="true"></i>${escapeHtml(localize("Add Actor", "Dodaj Aktora"))}</button>` : ""}
					</div>
				</div>
				${game.user?.isGM ? `<div class="wfrp-fireball-dialog__drop-hint">${escapeHtml(localize("You may also drop Actors from the sidebar here.", "Możesz również upuszczać tutaj Aktorów z panelu bocznego."))}</div>` : ""}
				<div class="wfrp-fireball-dialog__target-mode" data-fire-ball-target-mode></div>
				<div class="wfrp-fireball-dialog__target-help" data-fire-ball-target-help></div>
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
					draft.ignoreCastingRestrictions = game.user?.isGM === true && form?.elements?.ignoreCastingRestrictions?.checked === true;
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
					dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("is-dragover"); });
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
					callback: (_event, button) => readConfiguration(button.form, targets, automaticDistanceSetting),
				},
				{ action: "cancel", label: localize("Cancel", "Anuluj"), icon: "fa-solid fa-xmark", callback: () => CANCEL_DIALOG_RESULT },
			],
			rejectClose: false,
		});

		if (isCancelledDialogResult(response)) return null;
		if (!isCastConfiguration(response)) return null;

		const validation = validateConfiguration({ response, maximum, targets, actor, automaticDistanceSetting });
		if (validation.valid) return buildConfiguration(validation, response, targets, powerLevel);

		/* A player cannot locally override automatic geometry. Ask the primary GM
		 * instead of dead-ending on an inline warning which the GM cannot act on. */
		if (
			!game.user?.isGM &&
			validation.geometryNeedsAdjudication &&
			!validation.errors.fireBalls &&
			targets.length > 0
		) {
			const decision = await RuleAdjudicationDialog.request({
				title: localize(`Casting adjudication — ${spell.name}`, `Rozstrzygnięcie czaru — ${spell.name}`),
				prompt: localize(
					`${actor.name} requests a GM override of the automatic casting restrictions.`,
					`${actor.name} prosi MG o rozstrzygnięcie automatycznych ograniczeń rzucania czaru.`,
				),
				diagnostics: validation.distanceValidation.diagnostics,
				targets,
			});
			if (decision.approved) {
				const approved = {
					...validation,
					valid: true,
					errors: {},
					distanceValidation: Object.freeze({
						mode: "gm-override",
						settingEnabled: true,
						result: "accepted",
						ignoreRestrictions: true,
						overridden: true,
						adjudicatedBy: decision.adjudicatedBy,
						adjudicatedAt: decision.adjudicatedAt,
						diagnostics: validation.distanceValidation.diagnostics,
					}),
				};
				return buildConfiguration(approved, response, targets, powerLevel);
			}
			validation.errors.targets = decision.reason || localize("The GM rejected the casting exception.", "MG odrzucił wyjątek od ograniczeń rzucania czaru.");
		}

		draft.fireBalls = String(response.fireBalls ?? "");
		draft.conditions = response.conditions;
		draft.ignoreCastingRestrictions = response.distanceControl?.ignoreRestrictions === true;
		draft.errors = validation.errors;
	}
}

function buildConfiguration(validation, response, targets, powerLevel) {
	return Object.freeze({
		fireBalls: validation.fireBalls,
		conditions: response.conditions,
		group: targets.length > 1,
		targets: Object.freeze([...targets]),
		powerLevel,
		distanceValidation: Object.freeze(validation.distanceValidation),
	});
}

function distancePolicyMarkup(draft) {
	if (!game.user?.isGM) return "";
	return `<div class="wfrp-fireball-dialog__distance-policy"><label class="wfrp1ed-checkbox"><input type="checkbox" name="ignoreCastingRestrictions" ${draft.ignoreCastingRestrictions ? "checked" : ""}> ${escapeHtml(localize("Ignore casting restrictions for this spell", "Zignoruj ograniczenia rzucania dla tego czaru"))}</label></div>`;
}

function renderTargetList(root, targets, conditions) {
	const list = root?.querySelector?.("[data-fire-ball-target-list]");
	const mode = root?.querySelector?.("[data-fire-ball-target-mode]");
	if (!list || !mode) return;
	list.replaceChildren();
	const noTargets = targets.length === 0;
	mode.textContent = noTargets
		? localize("No targets selected", "Nie wskazano celów")
		: targets.length === 1
			? localize("Individual target", "Cel pojedynczy")
			: localize(`Target group — ${targets.length} creatures`, `Grupa celów — ${targets.length} istot`);

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
		remove.title = localize("Remove target", "Usuń cel");
		remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
		legend.append(remove);
		row.append(
			legend,
			conditionLabel("flammable", localize("Flammable", "Łatwopalny"), conditions[target.key]?.flammable),
			conditionLabel("fearOfFire", localize("Subject to fear of fire", "Podatny na strach przed ogniem"), conditions[target.key]?.fearOfFire),
		);
		TargetRowInteraction.bind(row, target);
		list.append(row);
	}
}

function conditionsForTargets(previous, targets) {
	return Object.fromEntries(targets.map((target) => [target.key, {
		flammable: previous?.[target.key]?.flammable === true,
		fearOfFire: previous?.[target.key]?.fearOfFire === true,
	}]));
}

function validateConfiguration({ response, maximum, targets, actor, automaticDistanceSetting }) {
	const errors = {};
	const fireBalls = Number(response.fireBalls);
	if (!Number.isInteger(fireBalls) || fireBalls < 1 || fireBalls > maximum) {
		errors.fireBalls = localize(`Enter a whole number from 1 to ${maximum}.`, `Wprowadź liczbę całkowitą od 1 do ${maximum}.`);
	}

	let distanceValidation = manualDistanceSnapshot(automaticDistanceSetting);
	let geometryNeedsAdjudication = false;
	if (targets.length === 0) {
		errors.targets = localize("Select at least one target.", "Wskaż co najmniej jeden cel.");
	} else if (automaticDistanceSetting) {
		const ignore = response.distanceControl?.ignoreRestrictions === true && game.user?.isGM === true;
		if (ignore) {
			distanceValidation = Object.freeze({
				mode: "gm-override", settingEnabled: true, result: "skipped", ignoreRestrictions: true,
				overridden: true, adjudicatedBy: String(game.user?.id ?? ""), adjudicatedAt: Date.now(), diagnostics: [],
			});
		} else {
			const assessment = automaticDistanceAssessment(actor, targets);
			distanceValidation = Object.freeze({
				mode: "automatic", settingEnabled: true, result: assessment.result, ignoreRestrictions: false,
				overridden: false, adjudicatedBy: null, adjudicatedAt: null, diagnostics: assessment.diagnostics,
			});
			if (assessment.result !== "valid") {
				geometryNeedsAdjudication = true;
				errors.targets = distanceValidationError(assessment, game.user?.isGM === true);
			}
		}
	}
	return { valid: Object.keys(errors).length === 0, errors, fireBalls, distanceValidation, geometryNeedsAdjudication };
}

function automaticDistanceAssessment(actor, targets) {
	const diagnostics = [];
	const casterToken = activeCasterToken(actor);
	if (!casterToken) {
		diagnostics.push(localize("The caster has no measurable token on the active Scene.", "Rzucający czar nie ma mierzalnego tokenu na aktywnej Scenie."));
		return { result: "unmeasurable", diagnostics };
	}
	const unmeasurable = [];
	const outside = [];
	for (const target of targets) {
		if (!target.token || !tokenCenter(target.token)) { unmeasurable.push(target.name); continue; }
		const distance = tokenDistance(casterToken, target.token);
		if (!Number.isFinite(distance)) unmeasurable.push(target.name);
		else if (distance > RANGE) outside.push(`${target.name} (${formatDistance(distance)})`);
	}
	if (unmeasurable.length) diagnostics.push(localize(`No measurable Scene token: ${unmeasurable.join(", ")}.`, `Brak mierzalnego tokenu na Scenie: ${unmeasurable.join(", ")}.`));
	if (outside.length) diagnostics.push(localize(`Outside Fire Ball range ${RANGE}: ${outside.join(", ")}.`, `Poza zasięgiem Ognistej Kuli ${RANGE}: ${outside.join(", ")}.`));
	if (unmeasurable.length) return { result: "unmeasurable", diagnostics };
	if (outside.length) return { result: "invalid", diagnostics };
	if (targets.length > 1) {
		const connected = groupConnectivity(targets);
		if (connected === null) {
			diagnostics.push(localize("The selected group spacing cannot be measured on the active Scene.", "Nie można zmierzyć odstępów w wybranej grupie na aktywnej Scenie."));
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
		mode: "gm-manual", settingEnabled: settingEnabled === true,
		result: settingEnabled ? "pending" : "not-checked", ignoreRestrictions: false,
		overridden: false, adjudicatedBy: settingEnabled ? null : String(game.user?.id ?? ""),
		adjudicatedAt: settingEnabled ? null : Date.now(), diagnostics: [],
	});
}

function distanceValidationError(assessment, gmCanOverride) {
	const details = assessment.diagnostics.join(" ");
	return `${details}${gmCanOverride
		? localize(" Select ‘Ignore casting restrictions for this spell’ to continue anyway.", " Zaznacz „Zignoruj ograniczenia rzucania dla tego czaru”, aby mimo tego kontynuować.")
		: localize(" The GM will be asked to adjudicate this result when you cast.", " MG zostanie poproszony o rozstrzygnięcie tego wyniku po próbie rzucenia czaru.")}`.trim();
}

function groupConnectivity(targets) {
	if (targets.length < 2) return true;
	if (targets.some((target) => !target.token || !tokenCenter(target.token))) return null;
	const visited = new Set([0]);
	const queue = [0];
	while (queue.length) {
		const current = queue.shift();
		for (let index = 0; index < targets.length; index += 1) {
			if (visited.has(index)) continue;
			const distance = tokenDistance(targets[current].token, targets[index].token);
			if (!Number.isFinite(distance)) return null;
			if (distance <= GROUP_SPACING) { visited.add(index); queue.push(index); }
		}
	}
	return visited.size === targets.length;
}

function readConfiguration(form, targets, automaticDistanceSetting) {
	return {
		fireBalls: String(form?.elements?.fireBalls?.value ?? "").trim(),
		conditions: readConditions(form, targets),
		distanceControl: {
			settingEnabled: automaticDistanceSetting === true,
			ignoreRestrictions: game.user?.isGM === true && form?.elements?.ignoreCastingRestrictions?.checked === true,
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

/**
 * WFRP 1e Core Fire Ball group rule: EACH Fire Ball fired into a group hits
 * 1D3 creatures PER LEVEL of the caster. At Power Level 3 one projectile
 * therefore rolls 3D3 target-count dice, not one D3. The sum is capped by the
 * number of creatures actually present in the selected group.
 *
 * Store the individual D3 faces as well as the sum. Besides documenting the RAW
 * calculation this lets Dice So Nice show the physical D3-as-D6 bridge for every
 * die while the authoritative target count remains the summed D3 result.
 */
async function resolveVolleyTargets(configuration, targets, powerLevel) {
	const volleys = [];
	for (let index = 0; index < configuration.fireBalls; index += 1) {
		if (!configuration.group) {
			volleys.push({ targets: [targets[0]], groupRolls: [], groupRollTotal: null });
			continue;
		}

		const groupRoll = await new Roll(`${powerLevel}d3`).evaluate({ allowInteractive: false });
		const term = groupRoll.dice?.find?.((die) => Number(die?.faces) === 3) ?? groupRoll.dice?.[0];
		const groupRolls = (term?.results ?? []).map((result) => Number(result?.result));
		if (groupRolls.length !== powerLevel || groupRolls.some((value) => !isD3(value))) {
			throw new Error(localize(
				"Unable to read all Fire Ball group-hit D3 results.",
				"Nie udało się odczytać wszystkich wyników K3 trafień grupowych Ognistej Kuli.",
			));
		}
		const groupRollTotal = groupRolls.reduce((sum, value) => sum + value, 0);
		const count = Math.min(groupRollTotal, targets.length);
		volleys.push({
			targets: await randomTargets(targets, count),
			groupRolls: Object.freeze(groupRolls),
			groupRollTotal,
		});
	}
	return Object.freeze(volleys);
}

async function randomTargets(targets, count) {
	const pool = [...targets];
	const selected = [];
	while (selected.length < count && pool.length) {
		const roll = await new Roll(`1d${pool.length}`).evaluate({ allowInteractive: false });
		const index = Math.max(0, Math.min(pool.length - 1, Number(roll.total) - 1));
		selected.push(pool.splice(index, 1)[0]);
	}
	return Object.freeze(selected);
}

async function publishCastSummary({ actor, spell, configuration, volleys, magicPoints, magicPointsAfter }) {
	const groupDetails = volleys.map((volley, index) => ({
		ballNumber: index + 1,
		groupRolls: Object.freeze([...(volley.groupRolls ?? [])]),
		groupRollTotal: volley.groupRollTotal === null || volley.groupRollTotal === undefined
			? null
			: nonNegativeInteger(volley.groupRollTotal, "Group hits"),
		targets: volley.targets.map((target) => ({ uuid: target.key, actorUuid: target.actorUuid, tokenUuid: target.tokenUuid, name: target.name })),
	}));
	const content = `<section class="wfrp1ed fire-ball-cast-summary">
		<h3>${escapeHtml(spell.name)}</h3>
		<div><strong>${escapeHtml(localize("Fire Balls", "Ogniste Kule"))}:</strong> ${configuration.fireBalls}</div>
		<div><strong>${escapeHtml(localize("Magic Points", "Punkty Magii"))}:</strong> ${magicPoints} → ${magicPointsAfter}</div>
		${configuration.group ? `<div><strong>${escapeHtml(localize("Group hits", "Trafienia grupowe"))}:</strong> ${escapeHtml(groupDetails.map((entry) => `${entry.ballNumber}: ${entry.groupRolls.join("+")} = ${entry.groupRollTotal} → ${entry.targets.map((target) => target.name).join(", ")}`).join("; "))}</div>` : ""}
	</section>`;
	const message = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
	await message.setFlag(FLAG_SCOPE, CAST_FLAG_KEY, {
		version: 5, casterUuid: actor.uuid, spellUuid: spell.uuid,
		fireBalls: configuration.fireBalls, magicPointsBefore: magicPoints, magicPointsAfter,
		group: configuration.group, powerLevel: configuration.powerLevel,
		distanceValidation: foundry.utils.deepClone(configuration.distanceValidation),
		targets: configuration.targets.map((target) => ({ uuid: target.key, actorUuid: target.actorUuid, tokenUuid: target.tokenUuid, name: target.name })),
		volleys: groupDetails,
	});
}

function selectedTargets(actor) {
	const casterToken = WfrpRuleSettings.usesAutomaticSpellTokenDistance() ? activeCasterToken(actor) : null;
	return Object.freeze([...(game.user?.targets ?? [])].map((token) => targetFromToken(token, casterToken)).filter(Boolean));
}

function targetFromToken(token, casterToken = null) {
	if (!token?.actor) return null;
	const tokenUuid = String(token.document?.uuid ?? token.uuid ?? "").trim();
	const actorUuid = String(token.actor?.uuid ?? "").trim();
	if (!tokenUuid || !actorUuid) return null;
	return Object.freeze({ key: tokenUuid, actorUuid, tokenUuid, name: String(token.name ?? token.actor.name ?? "—"), actor: token.actor, token, distance: casterToken ? tokenDistance(casterToken, token) : null });
}

function targetFromActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return null;
	return Object.freeze({ key: String(actor.uuid), actorUuid: String(actor.uuid), tokenUuid: "", name: String(actor.name ?? "—"), actor, token: null, distance: null });
}

function mergeTargets(existing, incoming) {
	const merged = [...(existing ?? [])].filter(Boolean);
	for (const candidate of incoming ?? []) {
		if (!candidate) continue;
		if (candidate.tokenUuid) {
			if (merged.some((target) => target.tokenUuid === candidate.tokenUuid)) continue;
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				if (!merged[index].tokenUuid && merged[index].actorUuid === candidate.actorUuid) merged.splice(index, 1);
			}
			merged.push(candidate);
			continue;
		}
		if (!merged.some((target) => target.actorUuid === candidate.actorUuid)) merged.push(candidate);
	}
	return Object.freeze(merged);
}

function activeCasterToken(actor) {
	return (actor.getActiveTokens?.() ?? []).find((token) => tokenCenter(token)) ?? null;
}

function tokenDistance(origin, target) {
	const a = tokenCenter(origin);
	const b = tokenCenter(target);
	if (!a || !b) return null;
	const dx = Number(b.x) - Number(a.x);
	const dy = Number(b.y) - Number(a.y);
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
	const pixels = Math.hypot(dx, dy);
	const gridSize = Number(canvas.grid?.size) || 1;
	const gridDistance = Number(canvas.scene?.grid?.distance) || 1;
	return (pixels / gridSize) * gridDistance;
}

function tokenCenter(token) { return token?.center ?? token?.object?.center ?? null; }
function formatDistance(value) { const number = Number(value); return !Number.isFinite(number) ? "?" : Number.isInteger(number) ? String(number) : number.toFixed(1); }

function fireBallRoundUsage(actor) {
	const combat = game.combat;
	if (!combat?.id || !Number.isInteger(Number(combat.round))) return { managed: false, combatId: null, round: null, cast: false };
	const stored = actor.getFlag?.(FLAG_SCOPE, ROUND_USAGE_FLAG_KEY);
	const sameRound = stored?.combatId === combat.id && Number(stored?.round) === Number(combat.round);
	return {
		managed: true, combatId: combat.id, round: Number(combat.round),
		cast: sameRound && (stored?.cast === true || nonNegativeInteger(stored?.used ?? 0, "Fire Ball round usage") > 0),
	};
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

function isCancelledDialogResult(response) { return response === null || response === "cancel" || response?.cancelled === true; }
function isCastConfiguration(response) { return Boolean(response && typeof response === "object" && Object.hasOwn(response, "fireBalls") && response.conditions && typeof response.conditions === "object"); }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer.`); return number; }
function nonNegativeInteger(value, label = "Value") { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`); return number; }
function isD3(value) { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 3; }
function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&"); }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }
function reportTargetError(error) { console.error("WFRP1ED | Unable to add Fire Ball target.", error); ui.notifications.error(error?.message ?? localize("Unable to add the selected target.", "Nie udało się dodać wybranego celu.")); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }