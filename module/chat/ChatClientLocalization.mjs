import { DamageApplication } from "../damage/DamageApplication.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { TEST_OUTCOME_MODE } from "../tests/Test.mjs";
import { TestManager } from "../tests/TestManager.mjs";
import { STANDARD_TEST_PROCEDURES } from "../tests/standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";
const PENDING_TEST_FLAG_KEY = "pendingStandardTest";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";

const CHARACTERISTIC_LABEL_ALIASES = Object.freeze({
	m: "sp",
});

/**
 * ChatMessage.content is persisted HTML shared by every connected client.
 * Presentation language therefore cannot be owned by the user who created the
 * message. This integration keeps mechanics in message flags and applies the
 * final labels to the rendered DOM using the current client's language.
 *
 * Polish note: nie zapisujemy ponownie przetłumaczonego HTML do ChatMessage.
 * Każdy klient tłumaczy własny widok podczas renderowania, więc jedna karta
 * może być równocześnie po polsku u gracza i po angielsku u MG.
 */
Hooks.on("preCreateChatMessage", (message) => {
	enrichTestResultIdentity(message);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	MovementStandardTest.applyClientLocalization(message, html);
	localizeTestResult(message, html);
	localizePendingStandardTest(message, html);
	localizeStandaloneDamage(message, html);
	localizeStandaloneCritical(message, html);
});

/**
 * New generic TestResult snapshots historically stored only the already-
 * localized testName. Capture the stable Test id while the creating client can
 * still resolve that name unambiguously. Old characteristic-test messages can
 * still be recovered from characteristic.id at render time.
 */
function enrichTestResultIdentity(message) {
	const state = testResultState(message);
	if (!state || state.testId) return;

	const test = findCreatingClientTest(state);
	if (!test) return;

	message.updateSource({
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}.testId`]: test.id,
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}.testLabelKey`]:
			test.labelKey ?? null,
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}.testFallbackLabel`]:
			test.label ?? state.testName ?? test.id,
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}.rawFormula`]:
			test.formula ?? null,
	});
}

function findCreatingClientTest(state) {
	const name = String(state?.testName ?? "").trim();
	const characteristicId = String(
		state?.characteristic?.id ?? "",
	).trim();

	if (characteristicId) {
		const direct = TestManager.get(characteristicId);
		if (direct) return direct;
	}

	for (const test of TestManager.all()) {
		if (
			String(test?.name ?? "").trim() === name ||
			String(test?.label ?? "").trim() === name
		) {
			return test;
		}
	}

	return null;
}

function localizeTestResult(message, html) {
	const state = testResultState(message);
	if (!state) return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	const test = resolveStoredTest(state);
	const target = resolvedTestTarget(state);
	const roll = finiteNumber(state.roll, 0);
	const success = resolvedTestSuccess(state, test, roll, target);

	card.classList.toggle("is-success", success);
	card.classList.toggle("is-failure", !success);

	const title = card.querySelector(".wfrp1e-test-card__header h2");
	if (title) {
		title.textContent = test
			? test.name
			: String(state.testName ?? "Test");
	}

	const status = card.querySelector(".wfrp1e-test-card__status");
	if (status) {
		status.textContent = success
			? localize("WFRP1ED.TestResult.Success", "Success", "Sukces")
			: localize("WFRP1ED.TestResult.Failure", "Failure", "Porażka");
	}

	const targetLabel = card.querySelector(
		".wfrp1e-test-card__target-label",
	);
	if (targetLabel) {
		targetLabel.textContent = localize(
			"WFRP1ED.TestResult.Target",
			"Target",
			"Próg",
		);
	}

	const details = card.querySelector(".wfrp1e-test-card__target");
	const summary = details?.querySelector(":scope > summary");
	if (summary?.hasAttribute("title")) {
		summary.title = localize(
			"WFRP1ED.TestResult.TargetBreakdownHint",
			"Click to show target calculation",
			"Kliknij, aby pokazać obliczenie progu",
		);
	}

	const characteristic = state.characteristic;
	if (characteristic?.id) {
		const firstSection = card.querySelector(
			".wfrp1e-test-card__breakdown-section",
		);
		const sectionTitle = firstSection?.querySelector(
			".wfrp1e-test-card__section-title",
		);
		if (sectionTitle) {
			sectionTitle.textContent = localize(
				"WFRP1ED.TestResult.BaseTarget",
				"Base target",
				"Próg bazowy",
			);
		}

		const characteristicRow = firstSection?.querySelector(
			".wfrp1e-test-card__breakdown-row",
		);
		const characteristicLabel = characteristicRow?.querySelector("span");
		if (characteristicLabel) {
			characteristicLabel.textContent = characteristicName(
				characteristic.id,
			);
		}
	}

	localizeFormulaSection(card, state, test);
	localizeModifierSection(card);
	localizeBreakdownSummary(card);
	localizeTestMetrics(card);
}

function localizeFormulaSection(card, state, test) {
	const formula = card.querySelector(".wfrp1e-test-card__formula");
	if (!formula) return;

	const section = formula.closest(".wfrp1e-test-card__breakdown-section");
	const title = section?.querySelector(".wfrp1e-test-card__section-title");
	if (title) {
		title.textContent = localize(
			"WFRP1ED.TestResult.Formula",
			"Formula",
			"Wzór",
		);
	}

	const rawFormula = String(
		state.rawFormula ?? test?.formula ?? "",
	).trim();
	if (rawFormula) {
		formula.textContent = displayFormula(
			rawFormula,
			state.variables ?? [],
		);
	}

	const subtitles = [
		...section?.querySelectorAll(
			".wfrp1e-test-card__section-subtitle",
		) ?? [],
	];
	if (subtitles[0]) {
		subtitles[0].textContent = localize(
			"WFRP1ED.TestResult.Inputs",
			"Inputs",
			"Dane wejściowe",
		);
	}

	const variableRows = [
		...section?.querySelectorAll(
			".wfrp1e-test-card__breakdown-rows .wfrp1e-test-card__breakdown-row",
		) ?? [],
	];
	const variables = Array.isArray(state.variables) ? state.variables : [];

	variables.forEach((variable, index) => {
		const label = variableRows[index]?.querySelector("span");
		if (label) label.textContent = variableLabel(variable?.key);
	});

	const subtotal = section?.querySelector(".is-subtotal span");
	if (subtotal) {
		subtotal.textContent = localize(
			"WFRP1ED.TestResult.BaseTarget",
			"Base target",
			"Próg bazowy",
		);
	}
}

function localizeModifierSection(card) {
	const generalRow = card.querySelector(
		".wfrp1e-test-card__breakdown-row.is-general-modifier",
	);
	const section = generalRow?.closest(".wfrp1e-test-card__breakdown-section") ??
		[...card.querySelectorAll(".wfrp1e-test-card__breakdown-section")]
			.find((candidate) => candidate.querySelector("[data-wfrp-test-modifier-row]"));
	if (!section) return;

	const title = section.querySelector(".wfrp1e-test-card__section-title");
	if (title) {
		title.textContent = localize(
			"WFRP1ED.TestResult.Modifiers",
			"Modifiers",
			"Modyfikatory",
		);
	}

	const generalLabel = generalRow?.querySelector(":scope > span");
	if (generalLabel) {
		generalLabel.textContent = localize(
			"WFRP1ed.TestModifier.Dialog",
			"Dialog modifier",
			"Modyfikator testu",
		);
	}

	for (const disabled of section.querySelectorAll(
		"[data-wfrp-test-modifier-row].is-disabled em",
	)) {
		disabled.textContent = `(${localize(
			"WFRP1ED.TestResult.DisabledModifier",
			"disabled",
			"wyłączony",
		)})`;
	}
}

function localizeBreakdownSummary(card) {
	const summary = card.querySelector(
		".wfrp1e-test-card__breakdown-summary",
	);
	if (!summary) return;

	const rows = [...summary.querySelectorAll(
		".wfrp1e-test-card__breakdown-row",
	)];
	const totalLabel = rows[0]?.querySelector("span");
	if (totalLabel) {
		totalLabel.textContent = localize(
			"WFRP1ED.TestResult.TotalModifier",
			"Total modifier",
			"Łączny modyfikator",
		);
	}

	const finalLabel = rows.find((row) => row.classList.contains("is-final"))
		?.querySelector("span");
	if (finalLabel) {
		finalLabel.textContent = localize(
			"WFRP1ED.TestResult.FinalTarget",
			"Final target",
			"Próg końcowy",
		);
	}
}

function localizeTestMetrics(card) {
	const metrics = [...card.querySelectorAll(".wfrp1e-test-card__metric")];
	const rollLabel = metrics[0]?.querySelector("span");
	if (rollLabel) {
		rollLabel.textContent = localize(
			"WFRP1ED.TestResult.Roll",
			"Roll",
			"Rzut",
		);
	}

	const marginLabel = metrics[1]?.querySelector("span");
	if (marginLabel) {
		marginLabel.textContent = localize(
			"WFRP1ED.TestResult.Margin",
			"Margin",
			"Margines",
		);
	}
}

function localizePendingStandardTest(message, html) {
	const request = message?.getFlag?.(FLAG_SCOPE, PENDING_TEST_FLAG_KEY);
	if (!request || request.status !== "pending") return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-pending-standard-test]")
		? root
		: root?.querySelector?.("[data-wfrp-pending-standard-test]");
	if (!card) return;

	const test = TestManager.get(String(request.testId ?? ""));
	const actor = actorFromUuidSync(request.actorUuid);

	setText(card, ".pending-standard-test-header h3", test?.name ?? request.testId);
	if (actor) setText(card, ".pending-standard-test-actor", actor.name);

	const status = card.querySelector(".pending-standard-test-target-status");
	const statusStrong = status?.querySelector("strong");
	const statusText = status?.querySelector("span");
	if (statusStrong) {
		statusStrong.textContent = `${localize(
			"WFRP1ED.StandardTest.Target",
			"Target",
			"Cel",
		)}:`;
	}
	if (statusText) {
		statusText.textContent = localize(
			"WFRP1ED.StandardTest.PendingTarget",
			"Waiting for target data",
			"Oczekuje na dane celu",
		);
	}

	setText(
		card,
		"[data-pending-target-drop] span",
		localize(
			"WFRP1ED.StandardTest.DropTarget",
			"Drop an Actor or Token here",
			"Upuść tutaj Aktora lub token",
		),
	);
	setButtonText(
		card.querySelector('[data-pending-action="current-target"]'),
		localize(
			"WFRP1ED.StandardTest.UseCurrentTarget",
			"Use current target",
			"Użyj aktualnego celu",
		),
	);
	setButtonText(
		card.querySelector('[data-pending-action="choose-actor"]'),
		localize(
			"WFRP1ED.StandardTest.ChooseActor",
			"Choose Actor",
			"Wybierz Aktora",
		),
	);
	setButtonText(
		card.querySelector('[data-pending-action="manual"]'),
		localize(
			"WFRP1ED.StandardTest.UseValue",
			"Use value",
			"Użyj wartości",
		),
	);

	const manualLabel = card.querySelector(".pending-standard-test-manual > label");
	const requirements = Array.isArray(request.targetRequirements)
		? request.targetRequirements
		: [];
	if (manualLabel && requirements.length === 1) {
		manualLabel.textContent = `${localize(
			"WFRP1ED.StandardTest.ManualValue",
			"Manual value",
			"Wartość ręczna",
		)} — ${characteristicName(requirements[0])}`;
	}

	setText(
		card,
		"[data-pending-player-status]",
		localize(
			"WFRP1ED.StandardTest.WaitingForGM",
			"Waiting for the GM to provide target data.",
			"Oczekiwanie na MG, który uzupełni dane celu.",
		),
	);
}

function localizeStandaloneDamage(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	if (!state || state.presentation !== "standalone") return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!card) return;

	setText(
		card,
		".wfrp1e-damage-card__header strong",
		localize("WFRP1ED.Damage.Title", "Damage", "Obrażenia"),
	);

	const rows = [...card.querySelectorAll(".wfrp1e-damage-card__row")];
	let index = 0;
	patchDamageRow(rows[index++], localize("WFRP1ED.Damage.Target", "Target", "Cel"));
	patchDamageRow(rows[index++], localize("WFRP1ED.Damage.Source", "Source", "Źródło"), knownSourceLabel(state.packet?.source));

	if (Number(state.packet?.rawAmount) !== Number(state.resolution?.finalAmount)) {
		patchDamageRow(rows[index++], localize("WFRP1ED.Damage.Raw", "Raw damage", "Obrażenia bazowe"));
	}
	patchDamageRow(rows[index++], localize("WFRP1ED.Damage.Final", "Damage", "Obrażenia"));

	if (state.packet?.hitLocation && rows[index]) {
		patchDamageRow(
			rows[index],
			localize("WFRP1ED.Damage.HitLocation", "Hit location", "Lokacja trafienia"),
		);
	}

	const mitigation = [...card.querySelectorAll(".wfrp1e-damage-card__mitigation span")];
	if (mitigation[0]) {
		mitigation[0].textContent = `${localize(
			"WFRP1ED.Damage.Armour",
			"Armour",
			"Pancerz",
		)}: ${mitigationLabel(state.packet?.mitigation?.armour)}`;
	}
	if (mitigation[1]) {
		mitigation[1].textContent = `${localize(
			"WFRP1ED.Damage.Toughness",
			"Toughness",
			"Wytrzymałość",
		)}: ${mitigationLabel(state.packet?.mitigation?.toughness)}`;
	}

	const actor = actorFromUuidSync(state.packet?.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, state.packet?.id)
		: state.application ?? null;
	const status = card.querySelector("[data-wfrp-damage-status]");
	if (status) {
		status.textContent = damageStatus(state, actor, transaction);
	}

	const hint = card.querySelector(".wfrp1e-damage-card__hint");
	if (hint) {
		hint.textContent = localize(
			"WFRP1ED.Damage.ContextHint",
			"Right-click this message to apply damage.",
			"Kliknij wiadomość prawym przyciskiem, aby zastosować obrażenia.",
		);
	}
}

function localizeStandaloneCritical(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!state?.resolution) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-critical-card]");
	if (!card) return;

	const resolution = state.resolution;
	setText(
		card,
		".wfrp1e-critical-result__header strong",
		`${localize(
			"WFRP1ED.Critical.SuddenDeath",
			"Sudden Death",
			"Nagła Śmierć",
		)} +${String(resolution?.variant ?? "").replace(/\+$/, "") || "—"}`,
	);

	const meta = card.querySelector(".wfrp1e-critical-result__meta");
	if (meta) {
		meta.textContent = `${localize(
			"WFRP1ED.Critical.Roll",
			"d100",
			"K100",
		)}: ${resolution?.roll?.total ?? "—"}`;
	}

	const outcome = card.querySelector(".wfrp1e-critical-result__outcome");
	if (outcome) {
		outcome.textContent = criticalOutcomeLabel(resolution) || outcome.textContent;
	}
}

function resolveStoredTest(state) {
	const id = String(
		state?.testId ?? state?.characteristic?.id ?? "",
	).trim();
	return id ? TestManager.get(id) ?? null : null;
}

function resolvedTestTarget(state) {
	const otherModifiers = Array.isArray(state?.otherModifiers)
		? state.otherModifiers
		: [];
	const total = otherModifiers
		.filter((modifier) => modifier?.enabled !== false)
		.reduce((sum, modifier) => sum + finiteNumber(modifier?.value, 0), 0);
	const general = state?.generalModifier?.enabled === false
		? 0
		: finiteNumber(state?.generalModifier?.value, 0);
	return finiteNumber(state?.baseTarget, 0) + total + general;
}

function resolvedTestSuccess(state, test, roll, target) {
	const outcomeMode = String(
		state?.outcomeMode ?? test?.outcomeMode ?? TEST_OUTCOME_MODE.ROLL_UNDER,
	).trim();

	return outcomeMode === TEST_OUTCOME_MODE.TARGET_RESISTANCE
		? roll > target
		: roll <= target;
}

function testResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function displayFormula(formula, variables) {
	let display = String(formula ?? "");
	const keys = [...new Set(
		(Array.isArray(variables) ? variables : [])
			.map((entry) => String(entry?.key ?? "").trim()),
	)]
		.filter(Boolean)
		.sort((first, second) => second.length - first.length);

	for (const key of keys) {
		display = replaceFormulaVariable(
			display,
			key,
			formulaVariableToken(key),
		);
	}
	return display;
}

function replaceFormulaVariable(formula, key, replacement) {
	const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`(^|[^A-Za-z0-9_.])${escaped}(?=$|[^A-Za-z0-9_.])`,
		"g",
	);
	return String(formula).replace(
		pattern,
		(_match, prefix) => `${prefix}${replacement}`,
	);
}

function formulaVariableToken(key) {
	const normalized = String(key ?? "").trim();
	if (normalized.startsWith("target.")) {
		return `${localize(
			"WFRP1ED.StandardTest.Target",
			"Target",
			"Cel",
		)}.${characteristicAbbreviation(normalized.slice(7))}`;
	}
	if (normalized === "noise") {
		return localize(
			"WFRP1ED.StandardTest.NoiseChance",
			"Base Listen chance",
			"Bazowa szansa Słuchania",
		);
	}
	if (normalized === "lockDifficulty") {
		return localize(
			"WFRP1ED.StandardTest.LockDifficulty",
			"Lock rating",
			"Stopień trudności zamka",
		);
	}
	if (normalized === "movement") return characteristicAbbreviation("m");
	return characteristicAbbreviation(normalized);
}

function variableLabel(key) {
	const normalized = String(key ?? "").trim();
	if (normalized.startsWith("target.")) {
		return `${localize(
			"WFRP1ED.StandardTest.Target",
			"Target",
			"Cel",
		)} — ${characteristicName(normalized.slice(7))}`;
	}
	if (normalized === "noise") {
		return localize(
			"WFRP1ED.StandardTest.NoiseChance",
			"Base Listen chance",
			"Bazowa szansa Słuchania",
		);
	}
	if (normalized === "lockDifficulty") {
		return localize(
			"WFRP1ED.StandardTest.LockDifficulty",
			"Lock rating",
			"Stopień trudności zamka",
		);
	}
	if (normalized === "movement") return characteristicName("m");
	return characteristicName(normalized);
}

function characteristicName(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	const localizationId = CHARACTERISTIC_LABEL_ALIASES[normalized] ?? normalized;
	const key = `WFRP1ed.CHAR.${localizationId}`;
	const localized = game.i18n.localize(key);
	return localized !== key ? localized : normalized.toUpperCase();
}

function characteristicAbbreviation(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	const localizationId = CHARACTERISTIC_LABEL_ALIASES[normalized] ?? normalized;
	const key = `WFRP1ed.CHARAbbrev.${localizationId}`;
	const localized = game.i18n.localize(key);
	return localized !== key ? localized : normalized.toUpperCase();
}

function knownSourceLabel(source) {
	if (String(source?.kind ?? "") === "movement-procedure") {
		const procedure = STANDARD_TEST_PROCEDURES[String(source?.id ?? "")];
		if (procedure) {
			const localized = game.i18n.localize(procedure.labelKey);
			if (localized !== procedure.labelKey) return localized;
			return game.i18n.lang === "pl"
				? procedure.polishFallback
				: procedure.label;
		}
	}
	return null;
}

function patchDamageRow(row, labelText, valueOverride = null) {
	if (!row) return;
	const label = row.querySelector("span:first-child");
	if (label) label.textContent = String(labelText);
	if (valueOverride !== null) {
		const value = row.querySelector("span:last-child, strong:last-child");
		if (value) value.textContent = String(valueOverride);
	}
}

function mitigationLabel(policy) {
	return policy === "ignore"
		? localize("WFRP1ED.Damage.Ignore", "ignored", "pomijany")
		: localize("WFRP1ED.Damage.ApplyMitigation", "applies", "uwzględniany");
}

function damageStatus(state, actor, transaction) {
	if (transaction?.state === "applied") {
		return localize(
			"WFRP1ED.Damage.AppliedStatus",
			`Applied ${transaction.amountApplied} · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
			`Zastosowano ${transaction.amountApplied} · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
		);
	}
	if (actor && DamageApplication.canApply(actor, game.user)) {
		return localize(
			"WFRP1ED.Damage.ReadyStatus",
			"Ready to apply",
			"Gotowe do zastosowania",
		);
	}
	return localize(
		"WFRP1ED.Damage.PendingStatus",
		"Awaiting application",
		"Oczekuje na zastosowanie",
	);
}

function criticalOutcomeLabel(resolution) {
	switch (resolution?.outcome) {
		case "killed":
			return localize("WFRP1ED.Critical.Killed", "Killed", "Śmierć");
		case "no-effect":
			return localize("WFRP1ED.Critical.NoEffect", "No Effect", "Bez efektu");
		default:
			return "";
	}
}

function actorFromUuidSync(uuid) {
	try {
		const actor = foundry.utils.fromUuidSync(String(uuid ?? ""));
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function setText(root, selector, value) {
	const element = root?.querySelector?.(selector);
	if (element) element.textContent = String(value ?? "");
}

function setButtonText(button, label) {
	if (!(button instanceof HTMLButtonElement)) return;
	for (const node of [...button.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) node.remove();
	}
	button.append(document.createTextNode(` ${String(label)}`));
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function finiteNumber(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}
