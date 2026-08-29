const STYLE_ID = "wfrp1ed-race-package-dialog-style";

installRacePackageDialogStyle();

/**
 * Race mandatory-Skill package dialogs reuse the Career package builder markup.
 * The generic Career layout intentionally keeps compact controls, but Race mode
 * labels (especially in Polish) are longer and were being truncated. Keep the
 * shared component semantics while giving the Race package settings enough room
 * to read the selected resolution mode comfortably.
 */
function installRacePackageDialogStyle() {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		/* Race package builder/editor dialogs ---------------------------------- */
		.wfrp1ed-race-package-dialog .career-package-builder__settings {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			column-gap: 22px;
		}

		.wfrp1ed-race-package-dialog .career-package-builder__settings label {
			grid-template-columns: minmax(0, 1fr) minmax(180px, 52%);
		}

		.wfrp1ed-race-package-dialog .career-package-builder__settings select[name="mode"] {
			width: 100%;
			min-width: 180px;
		}

		.wfrp1ed-race-package-dialog .career-package-builder__settings input[name="minInitialSkills"],
		.wfrp1ed-race-package-dialog .career-package-builder__settings input[name="choose"] {
			width: 90px;
			justify-self: end;
		}

		@media (max-width: 720px) {
			.wfrp1ed-race-package-dialog .career-package-builder__settings {
				grid-template-columns: 1fr;
			}

			.wfrp1ed-race-package-dialog .career-package-builder__settings label {
				grid-template-columns: minmax(0, 1fr) minmax(180px, 55%);
			}
		}
	`;
	document.head.append(style);
}
