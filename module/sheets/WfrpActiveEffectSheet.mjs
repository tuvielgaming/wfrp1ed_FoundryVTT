import { RuleEffectDialog } from "../effects/RuleEffectDialog.mjs";
import {
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

	_onChangeForm(formConfig, event) {
		super._onChangeForm(formConfig, event);

		const select = event?.target;
		if (
			!(select instanceof HTMLSelectElement) ||
			!select.name.endsWith(".type") ||
			select.value !== WFRP_RULE_CHANGE_TYPE
		) {
			return;
		}

		const index = nonNegativeInteger(
			select.closest("li[data-index]")?.dataset?.index,
			-1,
		);
		if (index < 0) return;

		const previousType = String(
			sourceChanges(this.document)[index]?.type ?? "",
		);
		void this.#configureNativeWfrpSelection(
			index,
			select,
			previousType,
		);
	}

	_processChangeSubmission(change, index) {
		if (change?.type === WFRP_RULE_CHANGE_TYPE) {
			change.value = serializedChangeValue(change.value);
			return;
		}

		super._processChangeSubmission(change, index);
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
	 * after render so their technical fields keep the WFRP Edit affordance.
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
				`[name="system.changes.${index}.type"], [name="changes.${index}.type"]`,
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

		const changesPanel = changesTabPanel(root);
		if (!(changesPanel instanceof HTMLElement)) return;

		/* The toolbar below is now the one system-wide add control. */
		for (const nativeAdd of changesPanel.querySelectorAll(
			':scope > header [data-action="addChange"]',
		)) {
			nativeAdd.remove();
		}

		if (!changesPanel.querySelector("[data-wfrp-rule-toolbar]")) {
			const toolbar = document.createElement("section");
			toolbar.className = "wfrp1ed-rule-authoring-toolbar";
			toolbar.dataset.wfrpRuleToolbar = "";

			const copy = document.createElement("div");
			copy.className = "wfrp1ed-rule-authoring-toolbar__copy";
			const heading = document.createElement("strong");
			heading.textContent = localize(
				"Mechanical Changes",
				"Zmiany mechaniczne",
			);
			const hint = document.createElement("small");
			hint.textContent = localize(
				"Add a Foundry change, then choose its Type. Selecting WFRP Rule opens the guided editor.",
				"Dodaj zmianę Foundry, a następnie wybierz jej typ. Wybranie Reguły WFRP otworzy pomocniczy edytor.",
			);
			copy.append(heading, hint);

			const add = document.createElement("button");
			add.type = "button";
			add.className = "wfrp1ed-rule-authoring-toolbar__add";
			add.dataset.action = "addChange";
			add.innerHTML = `<i class="fa-solid fa-plus" aria-hidden="true"></i> ${escapeHtml(localize("Add Change", "Dodaj zmianę"))}`;

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
	}

	async #configureNativeWfrpSelection(index, select, previousType) {
		try {
			if (await this.#configureWfrpRule(index)) return;
		}
		catch (error) {
			reportAuthoringError(error);
		}

		if (!select.isConnected) return;
		select.value = previousType;
		syncNativePriorityPlaceholder(select);
	}

	async #configureWfrpRule(index) {
		if (!this.isEditable) return false;
		const changes = sourceChanges(this.document);
		const existing = Number.isInteger(index) && index >= 0
			? changes[index] ?? null
			: null;
		const configured = await RuleEffectDialog.configure(existing);
		if (!configured) return false;

		if (Number.isInteger(index) && index >= 0) changes[index] = configured;
		else changes.push(configured);

		await this.document.update({ "system.changes": changes });
		await this.render({ force: true });
		return true;
	}
}

/**
 * Foundry v14 native renderer for one custom WFRP ActiveEffect change type.
 *
 * WFRP rules keep Foundry's native technical Key / Value / Priority fields.
 * Only the Type cell becomes a guided WFRP Edit badge.
 */
export async function renderWfrpRuleChange(context = {}) {
	return ruleChangeMarkup(
		nonNegativeInteger(context.index, 0),
		context.change ?? {},
		context.defaultPriority ?? 50,
	);
}

function ruleChangeMarkup(index, change, defaultPriority = 50) {
	const priority = change.priority ?? defaultPriority ?? 50;
	const storedValue = serializedChangeValue(change.value);
	const path = (field) => escapeHtml(String(
		change[`${field}Path`] ?? `system.changes.${index}.${field}`,
	));

	return `
		<li class="wfrp1ed-rule-change" data-index="${index}" data-wfrp-rule-change-index="${index}">
			<input type="hidden" name="${path("type")}" value="${escapeHtml(WFRP_RULE_CHANGE_TYPE)}">
			<input type="hidden" name="${path("phase")}" value="${escapeHtml(String(change.phase ?? "final"))}">
			<div class="key wfrp1ed-rule-change__key">
				<input type="text" name="${path("key")}" value="${escapeHtml(String(change.key ?? ""))}" autocomplete="off" spellcheck="false">
			</div>
			<div class="type wfrp1ed-rule-change__type">
				<button type="button" class="wfrp1ed-rule-change__edit" data-wfrp-rule-configure="${index}" title="${escapeHtml(localize("Edit WFRP Rule", "Edytuj regułę WFRP"))}">
					<i class="fa-solid fa-pen" aria-hidden="true"></i>
					<span>${escapeHtml(localize("WFRP · Edit", "WFRP · Edytuj"))}</span>
				</button>
			</div>
			<div class="value wfrp1ed-rule-change__value">
				<input type="text" name="${path("value")}" value="${escapeHtml(storedValue)}" autocomplete="off" spellcheck="false">
			</div>
			<div class="priority wfrp1ed-rule-change__priority">
				<input type="number" name="${path("priority")}" value="${escapeHtml(String(priority))}" placeholder="${escapeHtml(String(defaultPriority ?? 50))}">
			</div>
			<div class="controls wfrp1ed-rule-change__controls">
				<button type="button" class="inline-control icon fa-solid fa-trash" data-action="deleteChange" title="${escapeHtml(localize("Delete WFRP Rule", "Usuń regułę WFRP"))}" aria-label="${escapeHtml(localize("Delete WFRP Rule", "Usuń regułę WFRP"))}"></button>
			</div>
		</li>
	`;
}

function htmlElement(markup) {
	const template = document.createElement("template");
	template.innerHTML = String(markup ?? "").trim();
	return template.content.firstElementChild ?? null;
}

function changesTabPanel(root) {
	return root?.querySelector?.('.tab[data-tab="changes"]') ??
		root?.querySelector?.('.tab[data-tab="effects"]') ??
		null;
}

function syncNativeTabAria(nav) {
	for (const control of nav?.querySelectorAll?.("[data-tab]") ?? []) {
		control.setAttribute(
			"aria-selected",
			control.classList.contains("active") ? "true" : "false",
		);
	}
}

function syncNativePriorityPlaceholder(select) {
	const priority = select?.closest?.("li")?.querySelector?.(
		`input[name="${select.name.replace(/\.type$/, ".priority")}"]`,
	);
	if (!(priority instanceof HTMLInputElement)) return;
	priority.placeholder =
		foundry.documents.ActiveEffect.CHANGE_TYPES[select.value]
			?.defaultPriority ?? "";
}

function sourceChanges(effect) {
	const source = effect?.toObject?.() ?? {};
	const changes = Array.isArray(source.changes)
		? source.changes
		: Array.isArray(source.system?.changes)
			? source.system.changes
			: Array.isArray(effect?.changes)
				? effect.changes
				: [];
	return foundry.utils.deepClone(changes);
}

function serializedChangeValue(value) {
	if (typeof value === "string") return value;

	try {
		return JSON.stringify(value) ?? "";
	}
	catch (_error) {
		return String(value ?? "");
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
