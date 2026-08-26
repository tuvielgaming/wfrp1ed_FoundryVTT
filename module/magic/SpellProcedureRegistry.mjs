/** Stable, language-neutral identifiers for audited Spell procedures. */
export const SPELL_PROCEDURE_ID = Object.freeze({
	FIRE_BALL: "fireBall",
});

/** Registry shared by Spell authoring and runtime casting. */
export class SpellProcedureRegistry {
	static #procedures = new Map();

	static register(procedure) {
		const id = String(procedure?.id ?? "").trim();
		if (!id) throw new Error("A Spell procedure requires an id.");
		if (typeof procedure?.execute !== "function") {
			throw new Error(`Spell procedure '${id}' requires an execute function.`);
		}
		if (this.#procedures.has(id)) {
			throw new Error(`Spell procedure '${id}' is already registered.`);
		}
		this.#procedures.set(id, Object.freeze(procedure));
		return id;
	}

	static get(id) {
		return this.#procedures.get(String(id ?? "").trim()) ?? null;
	}

	static all() {
		return Object.freeze([...this.#procedures.values()]);
	}
}
