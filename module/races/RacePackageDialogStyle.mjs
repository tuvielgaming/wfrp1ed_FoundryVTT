const STYLE_ID = "wfrp1ed-race-package-dialog-style";

installRacePackageDialogStyle();

/**
 * Pure presentation for the shared Career/Race package dialogs.
 * No package-selection or form mechanics live here.
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
			color: #f0e6d3;
		}

		.career-package-builder .career-package-builder__settings,
		.career-package-editor .career-package-builder__settings {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			column-gap: 22px;
		}

		.career-package-builder .career-package-builder__settings label,
		.career-package-editor .career-package-builder__settings label {
			grid-template-columns: minmax(0, 1fr) minmax(190px, 52%);
			color: #f0e6d3;
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
			border: 1px solid #8e7b62;
			background: #151318;
			box-shadow: inset 0 0 0 1px rgb(255 255 255 / 4%);
		}

		.career-package-builder .career-package-builder__choice,
		.career-package-add-dialog .career-package-builder__choice {
			border-bottom-color: rgb(222 197 156 / 20%);
			background: #1d1a20;
			color: #f0e6d3;
			transition: background-color 100ms ease, box-shadow 100ms ease, color 100ms ease;
		}

		.career-package-builder .career-package-builder__choice:nth-child(even),
		.career-package-add-dialog .career-package-builder__choice:nth-child(even) {
			background: #211e25;
		}

		.career-package-builder .career-package-builder__choice:hover,
		.career-package-builder .career-package-builder__choice:focus-within,
		.career-package-add-dialog .career-package-builder__choice:hover,
		.career-package-add-dialog .career-package-builder__choice:focus-within {
			background: #302a31;
		}

		.career-package-builder__choice > span {
			color: #f5ead6;
		}

		.career-package-builder__choice > small {
			color: #d8c7aa;
			opacity: 1;
		}

		/* SystemCheckboxIntegration may wrap the native checkbox. Style the
		 * canonical wrapper as a descendant rather than relying on exact DOM
		 * nesting; browsers may normalize nested labels differently. */
		.career-package-builder__choice .wfrp1ed-checkbox {
			align-self: center;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 22px;
			height: 22px;
			min-width: 22px;
			gap: 0;
			opacity: 1 !important;
		}

		.career-package-builder__choice .wfrp1ed-checkbox::before {
			flex: 0 0 20px;
			width: 20px;
			height: 20px;
			border: 2px solid #d7c29c;
			border-radius: 3px;
			background: #08080a;
			box-shadow: 0 0 0 1px #000, inset 0 0 0 1px rgb(255 255 255 / 8%);
			color: #fff;
			font-family: Arial, Helvetica, sans-serif;
			font-size: 16px;
			font-weight: 900;
			line-height: 1;
			opacity: 1 !important;
		}

		.career-package-builder__choice .wfrp1ed-checkbox:has(input[type="checkbox"]:checked)::before {
			content: "✓";
			border-color: #9ce6a7;
			background: #23552d;
			box-shadow: 0 0 0 1px #000, 0 0 8px rgb(121 226 139 / 34%), inset 0 0 0 1px rgb(255 255 255 / 10%);
			color: #ffffff;
			text-shadow: 0 1px 1px #000;
		}

		/* Base selected-row presentation reads the actual native input state. */
		.career-package-builder__choice:has(input[type="checkbox"]:checked),
		.career-package-add-dialog .career-package-builder__choice:has(input[type="checkbox"]:checked) {
			background: #294631 !important;
			box-shadow: inset 4px 0 0 #8edb9d;
			color: #fff8e9;
		}

		.career-package-builder__choice:has(input[type="checkbox"]:checked) > span,
		.career-package-add-dialog .career-package-builder__choice:has(input[type="checkbox"]:checked) > span {
			color: #fff8e9;
		}

		.career-package-builder__choice:has(input[type="checkbox"]:checked):hover,
		.career-package-builder__choice:has(input[type="checkbox"]:checked):focus-within,
		.career-package-add-dialog .career-package-builder__choice:has(input[type="checkbox"]:checked):hover,
		.career-package-add-dialog .career-package-builder__choice:has(input[type="checkbox"]:checked):focus-within {
			background: #31573a !important;
		}

		/* Seed member is selected and locked by package mechanics. Styling only. */
		.career-package-builder__choice--seed {
			background: #294631 !important;
			box-shadow: inset 4px 0 0 #8edb9d;
		}

		.career-package-builder__choice--seed .wfrp1ed-checkbox,
		.career-package-builder__choice--seed .wfrp1ed-checkbox::before {
			opacity: 1 !important;
		}

		.career-package-builder__choice--seed > small {
			padding: 2px 7px;
			border: 1px solid #9b896c;
			border-radius: 999px;
			background: #3a332c;
			color: #f0dfc0;
		}

		.career-package-builder__choice .wfrp1ed-checkbox:has(input:focus-visible)::before {
			outline: 2px solid #f8d88f;
			outline-offset: 2px;
		}

		/* Package editor member list ----------------------------------------- */
		.career-package-editor .career-package-editor__members {
			border-color: #8e7b62;
			background: #151318;
		}

		.career-package-editor .career-package-editor__member {
			border-bottom-color: rgb(222 197 156 / 20%);
			background: #1d1a20;
			color: #f0e6d3;
		}

		.career-package-editor .career-package-editor__member:nth-child(even) {
			background: #211e25;
		}

		.career-package-editor .career-package-editor__member:hover,
		.career-package-editor .career-package-editor__member:focus-within {
			background: #302a31;
		}

		.career-package-editor .career-package-editor__member button,
		.career-package-editor [data-package-add] {
			border-color: #9b896c;
			background: #29242a;
			color: #f1dfbd;
		}

		.career-package-editor .career-package-editor__member button:hover,
		.career-package-editor .career-package-editor__member button:focus-visible,
		.career-package-editor [data-package-add]:hover,
		.career-package-editor [data-package-add]:focus-visible {
			background: #443b40;
			color: #fff2d5;
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
