export class TestModifier {
	constructor({
		id = null,
		value = 0,
		source = "",
		type = "untyped",
		enabled = true,
	} = {}) {
		this.id = id === null || id === undefined
			? null
			: String(id);
		this.value = value;
		this.source = source;
		this.type = type;
		this.enabled = enabled;
	}

	get signed() {
		return this.value >= 0 ? `+${this.value}` : `${this.value}`;
	}
}
