export class TestModifier {
	constructor({
		value = 0,
		source = "",
		type = "untyped",
		enabled = true,
	} = {}) {
		this.value = value;
		this.source = source;
		this.type = type;
		this.enabled = enabled;
	}

	get signed() {
		return this.value >= 0 ? `+${this.value}` : `${this.value}`;
	}
}
