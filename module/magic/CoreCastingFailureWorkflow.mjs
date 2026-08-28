const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "coreCastingFailure";
const activeEdits = new Set();
const castingAttempts = new WeakMap();
let installed = false;
let actorUpdatePatched = false;

class CastingFailureAbort extends Error {
	constructor(result) {
		super("WFRP 1e Core casting failure");
		this.name = "CastingFailureAbort";
		this.result = result;
	}
}

/** Generic WFRP 1e Core casting-failure workflow. */
export class CoreCastingFailureWorkflow {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.once("init", () => patchActorUpdate());
		Hooks.on("renderChatMessageHTML", (message, html) => {
			requestAnimationFrame(() => decorate(message, html));
		});
	}

	static async withCastingAttempt(actor, spell, callback) {
		if (!(actor instanceof foundry.documents.Actor)) throw new Error("Core casting attempt requires a caster Actor.");
		if (typeof callback !== "function") throw new Error("Core casting attempt requires a procedure callback.");
		if (castingAttempts.has(actor)) return callback();

		const attempt = { spell, castId: foundry.utils.randomID(), checked: false, result: null };
		castingAttempts.set(actor, attempt);
		try {
			return await callback();
		} catch (error) {
			if (error instanceof CastingFailureAbort) {
				return Object.freeze({ castingFailed: true, castingFailure: error.result, castId: attempt.castId });
			}
			throw error;
		} finally {
			castingAttempts.delete(actor);
		}
	}

	static async resolve({ actor, spell, currentMagicPoints, spellCost, castId = "" } = {}) {
		if (!(actor instanceof foundry.documents.Actor)) throw new Error("Core casting failure requires a caster Actor.");
		const current = integerAtLeast(currentMagicPoints, 0, "Current Magic Points");
		const cost = integerAtLeast(spellCost, 0, "Spell cost");

		if (current >= 12) {
			return Object.freeze({ required: false, success: true, total: null, dice: Object.freeze([]), messageId: null, castId: String(castId ?? "") });
		}

		const roll = await new Roll("2d6").evaluate({ allowInteractive: false });
		await showRollAnimation(roll);
		const dice = dieResults(roll);
		const total = dice.reduce((sum, value) => sum + value, 0);
		const state = {
			version: 2,
			castId: String(castId ?? ""),
			actorUuid: String(actor.uuid),
			actorName: String(actor.name ?? ""),
			spellUuid: String(spell?.uuid ?? ""),
			spellName: String(spell?.name ?? localize("Spell", "Czar")),
			currentMagicPoints: current,
			spellCost: cost,
			/* Physical d6 faces are retained for audit/animation only. */
			dice,
			originalDice: [...dice],
			total,
			originalTotal: total,
			success: total <= current,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};

		const message = await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: '<section class="wfrp1ed wfrp-core-casting-failure" data-wfrp-core-casting-failure></section>',
			flags: { [FLAG_SCOPE]: { [FLAG_KEY]: state } },
		});

		return Object.freeze({
			required: true,
			success: state.success,
			total: state.total,
			dice: Object.freeze([...state.dice]),
			messageId: String(message?.id ?? ""),
			castId: String(castId ?? ""),
		});
	}
}

function patchActorUpdate() {
	if (actorUpdatePatched) return;
	const ActorClass = foundry.documents.Actor;
	const original = ActorClass?.prototype?.update;
	if (typeof original !== "function") {
		console.error("WFRP1ED | Unable to install Core casting failure Actor update guard.");
		return;
	}
	actorUpdatePatched = true;

	ActorClass.prototype.update = async function wfrp1eCoreCastingGuard(changes = {}, options = {}) {
		const attempt = castingAttempts.get(this);
		if (!attempt || attempt.checked) return original.call(this, changes, options);

		const current = Number(this.system?.status?.magicPoints);
		const next = changedMagicPoints(changes);
		if (!Number.isInteger(current) || !Number.isInteger(next) || next >= current) return original.call(this, changes, options);

		attempt.checked = true;
		const result = await CoreCastingFailureWorkflow.resolve({
			actor: this,
			spell: attempt.spell,
			currentMagicPoints: current,
			spellCost: current - next,
			castId: attempt.castId,
		});
		attempt.result = result;

		const updated = await original.call(this, changes, options);
		if (result.required && !result.success) throw new CastingFailureAbort(result);
		return updated;
	};
}

function changedMagicPoints(changes) {
	const flat = changes?.["system.status.magicPoints"];
	if (flat !== undefined) return Number(flat);
	const nested = changes?.system?.status?.magicPoints;
	return nested === undefined ? null : Number(nested);
}

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-core-casting-failure]") ? root : root?.querySelector?.("[data-wfrp-core-casting-failure]");
	if (!(panel instanceof HTMLElement)) return;
	panel.replaceChildren();
	panel.classList.add("wfrp1e-damage-card");

	const header = document.createElement("header");
	header.className = "wfrp1e-damage-card__header";
	const title = document.createElement("strong");
	title.textContent = localize(`Casting — ${state.spellName}`, `Rzucanie czaru — ${state.spellName}`);
	const outcome = document.createElement("strong");
	outcome.className = `wfrp1e-test-card__status wfrp-core-casting-failure__status ${state.success ? "is-success" : "is-failure"}`;
	outcome.textContent = state.success ? localize("Success", "Sukces") : localize("Failure", "Porażka");
	header.append(title, outcome);
	panel.append(header);

	panel.append(row(localize("Current Magic Points", "Aktualne Punkty Magii"), String(state.currentMagicPoints)));
	panel.append(row(localize("Spell cost", "Koszt czaru"), String(state.spellCost)));

	const rollRow = document.createElement("div");
	rollRow.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = localize("Casting roll", "Rzut czaru");
	const editor = document.createElement("span");
	editor.className = "wfrp1e-damage-roll";
	const editable = canEdit(message);
	const faces = Array.isArray(state.dice) && state.dice.length === 2 ? state.dice : [1, 1];

	editor.append(d6Badge(faces[0]), d6Badge(faces[1]));
	const equals = document.createElement("span");
	equals.className = "wfrp1e-damage-roll__operator";
	equals.textContent = "=";
	editor.append(equals);

	const input = document.createElement("input");
	input.type = "number";
	input.min = "2";
	input.max = "12";
	input.step = "1";
	input.value = String(state.total);
	input.className = "wfrp1e-damage-roll__total";
	input.dataset.wfrpCastingTotal = "";
	input.readOnly = !editable;
	input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
	input.addEventListener("change", () => void adjudicateTotal(message, input.value).catch(reportError));
	editor.append(input);

	const versus = document.createElement("span");
	versus.className = "wfrp1e-damage-roll__operator";
	versus.textContent = "vs";
	const target = document.createElement("strong");
	target.textContent = String(state.currentMagicPoints);
	editor.append(versus, target);

	rollRow.append(label, editor);
	panel.append(rollRow);

	const note = document.createElement("div");
	note.className = "combat-damage-context__status";
	note.textContent = state.success
		? localize("2D6 is not greater than Current Magic Points — the spell may take effect.", "2K6 nie przekracza Aktualnych Punktów Magii — czar może zadziałać.")
		: localize("2D6 exceeds Current Magic Points — the spell fails, but its Magic Point cost is still spent.", "2K6 przekracza Aktualne Punkty Magii — czar nie działa, ale jego koszt w Punktach Magii nadal zostaje wydany.");
	panel.append(note);
}

async function adjudicateTotal(message, rawValue) {
	if (!canEdit(message)) throw new Error(localize("You may not edit this casting roll.", "Nie możesz zmienić tego rzutu czaru."));
	const key = String(message?.id ?? "");
	if (!key || activeEdits.has(key)) return;
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value < 2 || value > 12) {
		ui.notifications.warn(localize("The 2D6 casting total must be an integer from 2 to 12.", "Suma rzutu 2K6 musi być liczbą całkowitą od 2 do 12."));
		void ui.chat?.render?.({ force: true });
		return;
	}

	activeEdits.add(key);
	try {
		const current = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, FLAG_KEY) ?? {});
		const originalTotal = Number.isInteger(Number(current.originalTotal))
			? Number(current.originalTotal)
			: Array.isArray(current.originalDice)
				? current.originalDice.reduce((sum, die) => sum + Number(die), 0)
				: Number(current.total);
		current.total = value;
		current.success = value <= Number(current.currentMagicPoints);
		current.originalTotal = originalTotal;
		current.adjudicated = value !== originalTotal;
		current.adjudicatedBy = current.adjudicated ? String(game.user?.id ?? "") : null;
		current.adjudicatedAt = current.adjudicated ? Date.now() : null;
		current.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, FLAG_KEY, current);
	} finally {
		activeEdits.delete(key);
	}
}

function row(labelText, valueText) {
	const element = document.createElement("div");
	element.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = valueText;
	element.append(label, value);
	return element;
}

function d6Badge(value) {
	const number = Math.min(6, Math.max(1, Number(value) || 1));
	const names = ["one", "two", "three", "four", "five", "six"];
	const badge = document.createElement("i");
	badge.className = `fa-solid fa-dice-${names[number - 1]} wfrp1e-damage-die`;
	badge.title = `d6: ${number}`;
	badge.setAttribute("aria-label", `d6: ${number}`);
	return badge;
}

function dieResults(roll) {
	const term = roll?.dice?.find?.((candidate) => Number(candidate?.faces) === 6) ?? roll?.dice?.[0];
	const values = (term?.results ?? []).map((result) => Number(result?.result)).filter(isD6);
	if (values.length !== 2) throw new Error("Casting failure roll did not produce two d6 results.");
	return values;
}

async function showRollAnimation(roll) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try { await game.dice3d.showForRoll(roll, game.user, true); } catch (_error) { /* presentation only */ }
}

function canEdit(message) { return game.user?.isGM === true || message?.isAuthor === true; }
function isD6(value) { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 6; }
function integerAtLeast(value, minimum, label) { const number = Number(value); if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} must be an integer greater than or equal to ${minimum}.`); return number; }
function asElement(value) { if (value instanceof HTMLElement) return value; if (value?.[0] instanceof HTMLElement) return value[0]; return null; }
function reportError(error) { console.error("WFRP1ED | Unable to adjudicate Core casting failure roll.", error); ui.notifications.error(error?.message ?? localize("Unable to change the casting roll.", "Nie udało się zmienić rzutu czaru.")); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }

CoreCastingFailureWorkflow.install();
