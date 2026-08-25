import { RuleEffectDialog } from "../effects/RuleEffectDialog.mjs";
import {
	decodeRuleEffectChange,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RULE_EFFECT_APPLICABILITY,
	RuleEffectRegistry,
	WFRP_RULE_CHANGE_TYPE,
} from "../effects/RuleEffectRegistry.mjs";

const { ActiveEffectConfig } = foundry.applications.sheets;

/**
 * Native Foundry v14 ActiveEffectConfig with WFRP authoring affordances.
 *
 * We keep Core's Details/Duration/Changes implementation, but make the window
 * wide/resizable and provide a guided WFRP Rule workflow so authors never need
 * to understand the internal Attribute Key + JSON Value representation used by
 * the custom change type.
 */
export class WfrpActiveEffectSheet extends ActiveEffectConfig {
	static DEFAULT_OPTIONS = foundry.utils.mergeObject(
		ActiveEffectConfig.DEFAULT_OPTIONS,
		{
			classes: [
				...(ActiveEffectConfig.DEFAULT_OPTIONS.classes ?? []),
				"wfrp1ed",
				"wfrp1ed-active-effect-sheet",
				"wfrp1ed-parchment-window",
			],
			position: {
				width: 780,
				height: 560,
			},
			window: {
				resizable: true,
			},
		},
		{ inplace: false },
	);

	_onRender(context, options) {
		super._onRender(context, options);
		this.#decorateNativeTabs();
		this.#replaceNativeWfrpRuleRows();
		this.#activateWfrpRuleControls();
	}

	/**
	 * Foundry owns the ActiveEffect Details / Duration / Changes markup. Apply
	 * the shared WFRP tab contract to that native navigation instead of creating
	 * another one-off tab style for this sheet.
	 */
	#decorateNativeTabs() {
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;

		for (const nav of root.querySelectorAll("nav.tabs, nav.sheet-tabs")) {
			const controls = [...nav.querySelectorAll("[data-tab]")];
			if (controls.length < 2) continue;
			nav.classList.add("wfrp1ed-tabs");
			nav.setAttribute("role", "tablist");

			for (const control of controls) {
				control.classList.add("wfrp1ed-tab");
				control.setAttribute("role", "tab");
				control.setAttribute(
					"aria-selected",
					control.classList.contains("active") ? "true" : "false",
				);
				control.addEventListener("click", () => {
					requestAnimationFrame(() => syncNativeTabAria(nav));
				});
			}
		}
	}

	/**
	 * Defensive v14 compatibility path.
	 *
	 * Foundry materializes its runtime ActiveEffect change-type registry during
	 * initialization. If a custom renderer is registered too late, Core falls
	 * back to its raw Attribute Key / Value row. Replace only our own custom rows
	 * after render so authors always receive the WFRP summary + Edit action.
	 * The hidden canonical inputs keep Core form submission lossless.
	 */
	#replaceNativeWfrpRuleRows() {
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;

		const changes = sourceChanges(this.document);
		for (let index = 0; index < changes.length; index += 1) {
			const change = changes[index];
			if (change?.type !== WFRP_RULE_CHANGE_TYPE) continue;
			if (root.querySelector(`[data-wfrp-rule-change-index="${index}"]`)) continue;

			const typeControl = root.querySelector(
				`[name="changes.${index}.type"]`,
			);
			if (!(typeControl instanceof HTMLElement)) continue;

			const nativeRow =
				typeControl.closest("li") ??
				typeControl.closest(".form-group") ??
				typeControl.parentElement;
			if (!(nativeRow instanceof HTMLElement)) continue;

			const replacement = htmlElement(
				ruleChangeMarkup(index, change, 50),
			);
			if (replacement) nativeRow.replaceWith(replacement);
		}
	}

	#activateWfrpRuleControls() {
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;

		const changesPanel =
			root.querySelector('[data-tab="changes"]') ??
			root.querySelector('[data-tab="effects"]');
		if (!(changesPanel instanceof HTMLElement)) return;

		if (!changesPanel.querySelector("[data-wfrp-rule-toolbar]")) {
			const toolbar = document.createElement("section");
			toolbar.className = "wfrp1ed-rule-authoring-toolbar";
			toolbar.dataset.wfrpRuleToolbar = "";

			const copy = document.createElement("div");
			copy.className = "wfrp1ed-rule-authoring-toolbar__copy";
			const heading = document.createElement("strong");
			heading.textContent = localize("WFRP Rules", "Reguły WFRP");
			const hint = document.createElement("small");
			hint.textContent = localize(
				"Use the guided editor. Attribute Key and Value are internal storage and do not need to be entered manually.",
				"Użyj pomocniczego edytora. Attribute Key i Value są wewnętrznym zapisem systemu i nie trzeba wpisywać ich ręcznie.",
			);
			copy.append(heading, hint);

			const add = document.createElement("button");
			add.type = "button";
			add.className = "wfrp1ed-rule-authoring-toolbar__add";
			add.dataset.wfrpRuleAdd = "";
			add.innerHTML = `<i class="fa-solid fa-plus" aria-hidden="true"></i> ${escapeHtml(localize("Add WFRP Rule", "Dodaj regułę WFRP"))}`;
			add.addEventListener("click", (event) => {
				event.preventDefault();
				void this.#configureWfrpRule(null).catch(reportAuthoringError);
			});

			toolbar.append(copy, add);
			changesPanel.prepend(toolbar);
		}

		for (const button of root.querySelectorAll("[data-wfrp-rule-configure]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const index = nonNegativeInteger(button.dataset.wfrpRuleConfigure, -1);
				if (index < 0) return;
				void this.#configureWfrpRule(index).catch(reportAuthoringError);
			});
		}

		for (const button of root.querySelectorAll("[data-wfrp-rule-delete]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const index = nonNegativeInteger(button.dataset.wfrpRuleDelete, -1);
				if (index < 0) return;
				void this.#deleteWfrpRule(index).catch(reportAuthoringError);
			});
		}
	}

	async #configureWfrpRule(index) {
		if (!this.isEditable) return;
		const changes = sourceChanges(this.document);
		const existing = Number.isInteger(index) && index >= 0
			? changes[index] ?? null
			: null;
		const configured = await RuleEffectDialog.configure(existing);
		if (!configured) return;

		if (Number.isInteger(index) && index >= 0) changes[index] = configured;
		else changes.push(configured);

		await this.document.update({ changes });
		await this.render({ force: true });
	}

	async #deleteWfrpRule(index) {
		if (!this.isEditable) return;
		const changes = sourceChanges(this.document);
		if (changes[index]?.type !== WFRP_RULE_CHANGE_TYPE) return;
		changes.splice(index, 1);
		await this.document.update({ changes });
		await this.render({ force: true });
	}
}

/**
 * Foundry v14 native renderer for one custom WFRP ActiveEffect change type.
 *
 * The canonical change fields remain hidden form controls so normal
 * ActiveEffectConfig submission is lossless. The visible row is an authored
 * WFRP rule summary with explicit Edit and Delete actions.
 */
export async function renderWfrpRuleChange(context = {}) {
	return ruleChangeMarkup(
		nonNegativeInteger(context.index, 0),
		context.change ?? {},
		context.defaultPriority ?? 50,
	);
}

function ruleChangeMarkup(index, change, defaultPriority = 50) {
	const rule = decodeRuleEffectChange(change);
	const title = rule
		? RuleEffectRegistry.label(rule.target)
		: localize("Unconfigured WFRP Rule", "Nieskonfigurowana reguła WFRP");
	const summary = rule ? ruleSummary(rule) : localize(
		"Open Edit to choose the rule target and value.",
		"Otwórz Edytuj, aby wybrać cel reguły i wartość.",
	);

	return `
		<li class="wfrp1ed-rule-change" data-wfrp-rule-change-index="${index}">
			<input type="hidden" name="changes.${index}.key" value="${escapeHtml(String(change.key ?? ""))}">
			<input type="hidden" name="changes.${index}.type" value="${escapeHtml(WFRP_RULE_CHANGE_TYPE)}">
			<input type="hidden" name="changes.${index}.value" value="${escapeHtml(String(change.value ?? ""))}">
			<input type="hidden" name="changes.${index}.phase" value="${escapeHtml(String(change.phase ?? "final"))}">
			<input type="hidden" name="changes.${index}.priority" value="${escapeHtml(String(change.priority ?? defaultPriority ?? 50))}">
			<div class="wfrp1ed-rule-change__body">
				<strong>${escapeHtml(title)}</strong>
				<small>${escapeHtml(summary)}</small>
			</div>
			<div class="wfrp1ed-rule-change__actions">
				<button type="button" data-wfrp-rule-configure="${index}" title="${escapeHtml(localize("Edit WFRP Rule", "Edytuj regułę WFRP"))}">
					<i class="fa-solid fa-pen" aria-hidden="true"></i>
					<span>${escapeHtml(localize("Edit", "Edytuj"))}</span>
				</button>
				<button type="button" data-wfrp-rule-delete="${index}" class="icon" title="${escapeHtml(localize("Delete WFRP Rule", "Usuń regułę WFRP"))}">
					<i class="fa-solid fa-trash" aria-hidden="true"></i>
				</button>
			</div>
		</li>
	`;
}

function htmlElement(markup) {
	const template = document.createElement("template");
	template.innerHTML = String(markup ?? "").trim();
	return template.content.firstElementChild ?? null;
}

function syncNativeTabAria(nav) {
	for (const control of nav?.querySelectorAll?.("[data-tab]") ?? []) {
		control.setAttribute(
			"aria-selected",
			control.classList.contains("active") ? "true" : "false",
		);
	}
}

function sourceChanges(effect) {
	const source = effect?.toObject?.() ?? {};
	return Array.isArray(source.changes)
		? foundry.utils.deepClone(source.changes)
		: [];
}

function ruleSummary(rule) {
	return [
		operationLabel(rule.operation),
		String(rule.formula ?? "").trim(),
		sideLabel(rule.side),
		applicabilityLabel(rule.applicability),
		stackingLabel(rule.stacking),
	].filter(Boolean).join(" · ");
}

function operationLabel(value) {
	switch (value) {
		case RULE_EFFECT_OPERATIONS.ADD: return localize("Add", "Dodaj");
		case RULE_EFFECT_OPERATIONS.SUBTRACT: return localize("Subtract", "Odejmij");
		case RULE_EFFECT_OPERATIONS.MULTIPLY: return localize("Multiply", "Pomnóż");
		case RULE_EFFECT_OPERATIONS.OVERRIDE: return localize("Override", "Zastąp");
		case RULE_EFFECT_OPERATIONS.GRANT: return localize("Grant", "Przyznaj");
		default: return String(value ?? "");
	}
}

function sideLabel(value) {
	switch (value) {
		case RULE_EFFECT_SIDES.SELF: return localize("Self", "Właściciel");
		case RULE_EFFECT_SIDES.TARGET: return localize("Target", "Cel");
		case RULE_EFFECT_SIDES.OPPONENT: return localize("Opponent", "Przeciwnik");
		default: return String(value ?? "");
	}
}

function applicabilityLabel(value) {
	switch (value) {
		case RULE_EFFECT_APPLICABILITY.AUTOMATIC: return localize("Automatic", "Automatyczny");
		case RULE_EFFECT_APPLICABILITY.CONTEXTUAL: return localize("Contextual", "Sytuacyjny");
		case RULE_EFFECT_APPLICABILITY.MANUAL: return localize("Manual", "Ręczny");
		default: return String(value ?? "");
	}
}

function stackingLabel(value) {
	switch (String(value ?? "")) {
		case "once": return localize("once", "jednorazowo");
		case "stack": return localize("stack", "kumuluj");
		case "per-acquisition": return localize("per acquisition", "za każde nabycie");
		default: return String(value ?? "");
	}
}

function nonNegativeInteger(value, fallback = 0) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function reportAuthoringError(error) {
	console.error("WFRP1ED | Unable to configure WFRP Active Effect rule.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to configure the WFRP Rule.",
			"Nie udało się skonfigurować Reguły WFRP.",
		),
	);
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
