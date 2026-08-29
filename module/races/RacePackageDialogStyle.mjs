const STYLE_ID = "wfrp1ed-race-package-dialog-style";

installRacePackageDialogStyle();

/**
 * Race mandatory-Skill packages deliberately reuse Career package-builder
 * markup. Keep those shared dialogs readable as one component: mode labels are
 * relatively long (especially in Polish), so the mode selector receives at
 * least half of its label/control row instead of collapsing to a tiny field.
 *
 * The selector is shared with Career package dialogs as well, which is useful:
 * both authoring workflows now keep the same control proportions.
 */
function installRacePackageDialogStyle() {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		/* Shared Career/Race package builder and editor dialogs ---------------- */
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
