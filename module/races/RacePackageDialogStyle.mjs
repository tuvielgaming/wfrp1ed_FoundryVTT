const STYLE_ID = "wfrp1ed-race-package-dialog-style";

installRacePackageDialogStyle();

/**
 * Race mandatory-Skill packages deliberately reuse Career package-builder
 * markup. Keep those shared dialogs readable as one component.
 *
 * Package dialogs live in Foundry's dark application chrome, while the global
 * WFRP checkbox component is intentionally parchment-safe. The scoped rules
 * below provide a dark-dialog presentation without changing checkboxes on the
 * ordinary Actor/Item sheets.
 */
function installRacePackageDialogStyle() {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		/* Shared Career/Race package builder and editor dialogs ---------------- */
		.career-package-builder,
		.career-package-editor,
		.career-package-add-dialog {
			color: rgb(238 229 211 / 98%);
		}

		.career-package-builder .career-package-builder__settings,
		.career-package-editor .career-package-builder__settings {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			column-gap: 22px;
		}

		.career-package-builder .career-package-builder__settings label,
		.career-package-editor .career-package-builder__settings label {
			grid-template-columns: minmax(0, 1fr) minmax(190px, 52%);
		}

		.career-package-builder .career-package-builder__settings select[name="mode"],
		.career-package-editor .career-package-builder__settings select[name="mode"] {
			width: 100%;
			min-width: 190px;
		}

		.career-package-builder .career-package-builder__settings input[name="minInitialSkills"],
		.career-package-builder .career-package-builder__settings input[name="choose"],
		.career-package-editor .career-package-builder__settings input[name="minInitialSkills"],
		.career-package-editor .career-package-builder__settings input[name="choose"] {
			width: 90px;
			justify-self: end;
		}

		/* Choice list ---------------------------------------------------------- */
		.career-package-builder .career-package-builder__choices,
		.career-package-add-dialog .career-package-builder__choices {
			border-color: rgb(211 187 143 / 48%);
			background: rgb(12 11 14 / 26%);
			box-shadow: inset 0 0 0 1px rgb(255 255 255 / 3%);
		}

		.career-package-builder .career-package-builder__choice,
		.career-package-add-dialog .career-package-builder__choice {
			border-bottom-color: rgb(211 187 143 / 16%);
			color: rgb(238 229 211 / 96%);
			transition:
				background-color 100ms ease,
				box-shadow 100ms ease,
				color 100ms ease;
		}

		.career-package-builder .career-package-builder__choice:hover,
		.career-package-builder .career-package-builder__choice:focus-within,
		.career-package-add-dialog .career-package-builder__choice:hover,
		.career-package-add-dialog .career-package-builder__choice:focus-within {
			background: rgb(255 236 197 / 7%);
		}

		/* SystemCheckboxIntegration wraps raw checkboxes in `.wfrp1ed-checkbox`.
		 * Override only inside package dialogs: the global checkbox colors target
		 * parchment and otherwise disappear against Foundry's dark dialog chrome. */
		.career-package-builder__choice > .wfrp1ed-checkbox {
			align-self: center;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 20px;
			height: 20px;
			min-width: 20px;
			gap: 0;
		}

		.career-package-builder__choice > .wfrp1ed-checkbox::before {
			flex: 0 0 18px;
			width: 18px;
			height: 18px;
			border: 2px solid rgb(235 211 167 / 92%);
			border-radius: 3px;
			background: rgb(14 13 16 / 90%);
			box-shadow:
				0 0 0 1px rgb(0 0 0 / 72%),
				inset 0 0 0 1px rgb(255 255 255 / 6%);
			color: rgb(112 235 126);
			font-family: Arial, Helvetica, sans-serif;
			font-size: 15px;
			font-weight: 900;
			line-height: 1;
			text-shadow: 0 0 4px rgb(75 222 94 / 44%);
		}

		.career-package-builder__choice > .wfrp1ed-checkbox:has(> input:checked)::before {
			content: "✓";
			border-color: rgb(124 235 137 / 100%);
			background: rgb(17 55 26 / 96%);
			box-shadow:
				0 0 0 1px rgb(0 0 0 / 72%),
				0 0 7px rgb(75 222 94 / 24%),
				inset 0 0 0 1px rgb(255 255 255 / 8%);
			color: rgb(119 244 133);
		}

		.career-package-builder__choice:has(.wfrp1ed-checkbox > input:checked) {
			background: rgb(35 91 45 / 30%);
			box-shadow: inset 3px 0 0 rgb(112 235 126 / 88%);
			color: rgb(247 239 220);
		}

		.career-package-builder__choice:has(.wfrp1ed-checkbox > input:checked):hover,
		.career-package-builder__choice:has(.wfrp1ed-checkbox > input:checked):focus-within {
			background: rgb(40 108 52 / 38%);
		}

		/* A locked seed member is selected by definition. Keep it clearly visible
		 * instead of applying the global disabled-checkbox fade. */
		.career-package-builder__choice--seed {
			background: rgb(35 91 45 / 24%);
		}

		.career-package-builder__choice--seed > .wfrp1ed-checkbox,
		.career-package-builder__choice--seed > .wfrp1ed-checkbox::before,
		.career-package-builder__choice--seed > .wfrp1ed-checkbox:has(> input:disabled)::before {
			opacity: 1;
		}

		.career-package-builder__choice--seed > small {
			padding: 2px 6px;
			border: 1px solid rgb(211 187 143 / 30%);
			border-radius: 999px;
			background: rgb(255 236 197 / 7%);
			color: rgb(225 209 180 / 90%);
			opacity: 1;
		}

		.career-package-builder__choice > .wfrp1ed-checkbox:has(> input:focus-visible)::before {
			outline: 2px solid rgb(248 224 176 / 100%);
			outline-offset: 2px;
		}

		/* Package editor member list ----------------------------------------- */
		.career-package-editor .career-package-editor__members {
			border-color: rgb(211 187 143 / 48%);
			background: rgb(12 11 14 / 26%);
		}

		.career-package-editor .career-package-editor__member {
			border-bottom-color: rgb(211 187 143 / 16%);
			color: rgb(238 229 211 / 96%);
		}

		.career-package-editor .career-package-editor__member:hover,
		.career-package-editor .career-package-editor__member:focus-within {
			background: rgb(255 236 197 / 7%);
		}

		.career-package-editor .career-package-editor__member button,
		.career-package-editor [data-package-add] {
			border-color: rgb(211 187 143 / 58%);
			background: rgb(255 236 197 / 5%);
			color: rgb(239 222 190);
		}

		.career-package-editor .career-package-editor__member button:hover,
		.career-package-editor .career-package-editor__member button:focus-visible,
		.career-package-editor [data-package-add]:hover,
		.career-package-editor [data-package-add]:focus-visible {
			background: rgb(255 236 197 / 14%);
			color: rgb(255 242 213);
		}

		@media (max-width: 720px) {
			.career-package-builder .career-package-builder__settings,
			.career-package-editor .career-package-builder__settings {
				grid-template-columns: 1fr;
			}

			.career-package-builder .career-package-builder__settings label,
			.career-package-editor .career-package-builder__settings label {
				grid-template-columns: minmax(0, 1fr) minmax(190px, 55%);
			}
		}
	`;
	document.head.append(style);
}
