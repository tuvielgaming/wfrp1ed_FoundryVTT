const STYLE_ID = "wfrp1ed-race-initial-career-style";

if (!document.getElementById(STYLE_ID)) {
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.wfrp1ed-character-creation-mode .wfrp1ed-race-initial-career-roll {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 18px;
			height: 18px;
			margin: 0;
			padding: 0;
			border: 1px solid rgb(255 255 255 / 88%);
			border-radius: 50%;
			background: rgb(255 255 255 / 82%);
			box-shadow: 0 0 0 1px rgb(0 0 0 / 34%);
			color: #6f0018;
			font-family: Arial, Helvetica, sans-serif;
			font-size: 11px;
			font-weight: 700;
			line-height: 1;
			cursor: pointer;
			pointer-events: auto;
			z-index: 6;
			opacity: 0.72;
			transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
		}

		.wfrp1ed-character-creation-mode .wfrp1ed-race-initial-career-roll > i::before {
			content: "\\f6cf";
		}

		.wfrp1ed-character-creation-mode .wfrp1ed-race-initial-career-roll:hover,
		.wfrp1ed-character-creation-mode .wfrp1ed-race-initial-career-roll:focus-visible {
			background: rgb(255 255 255 / 98%);
			color: #7a0019;
			opacity: 1;
		}

		.wfrp1ed-character-creation-mode .wfrp1ed-race-initial-career-roll:focus-visible {
			outline: 1px solid var(--focus-color);
			outline-offset: 1px;
		}

		.wfrp1ed-character-creation-mode .header-field--current-career .wfrp1ed-race-initial-career-roll {
			position: absolute;
			right: 4px;
			top: 50%;
			transform: translateY(-50%);
		}
	`;
	document.head.append(style);
}
