const SELECTOR = ".wfrp1ed-classic-sheet";

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!(element instanceof HTMLElement) ||
		!element.querySelector?.(SELECTOR)
	) return;

	wireExperienceField(actor, element, "current");
	wireExperienceField(actor, element, "total");
});

function wireExperienceField(actor, root, kind) {
	const input = root.querySelector(`[data-wfrp-experience-${kind}]`);
	if (!(input instanceof HTMLInputElement)) return;

	/* Experience corrections are deliberately GM-only. Players can still see
	 * both values, while all normal purchases continue through the Actor's
	 * advancement API. */
	input.disabled = game.user?.isGM !== true;
	if (input.disabled) return;

	input.addEventListener("change", () => {
		void persistExperience(actor, kind, input);
	});

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
}

async function persistExperience(actor, kind, input) {
	const next = nonNegativeInteger(input.value);
	const ledger = readLedger(actor);

	try {
		if (kind === "current") {
			if (next > ledger.totalAwarded) {
				throw new Error(localize(
					"Current Experience cannot exceed Total Experience.",
					"Aktualne Punkty Doświadczenia nie mogą przekraczać Całkowitych Punktów Doświadczenia.",
				));
			}

			await actor.update({
				"system.experience.spent": ledger.totalAwarded - next,
			});
			return;
		}

		if (kind === "total") {
			if (next < ledger.spent) {
				throw new Error(localize(
					`Total Experience cannot be lower than already spent Experience (${ledger.spent}).`,
					`Całkowite Punkty Doświadczenia nie mogą być niższe od już wydanych (${ledger.spent}).`,
				));
			}

			await actor.update({
				"system.experience.totalAwarded": next,
			});
		}
	} catch (error) {
		input.value = kind === "current"
			? String(ledger.available)
			: String(ledger.totalAwarded);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update Experience Points.",
			"Nie udało się zaktualizować Punktów Doświadczenia.",
		));
	}
}

function readLedger(actor) {
	const experience = actor.system?.experience ?? {};
	const totalAwarded = nonNegativeInteger(experience.totalAwarded);
	const spent = nonNegativeInteger(experience.spent);
	return {
		totalAwarded,
		spent,
		available: Math.max(0, totalAwarded - spent),
	};
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
