export class CharacteristicDisplay {
	static build(actor) {
		return Object.entries(actor.system.characteristics).map(([key, c]) => ({
			key,

			label: game.i18n.localize(c.label),

			initial: c.display.initial,

			advances: c.display.purchased,

			current: c.display.current,

			rollable: true,

			css: this.css(c),
		}));
	}

	static css(characteristic) {
		let classes = [];

		if (characteristic.display.current > characteristic.display.initial)
			classes.push("improved");

		if (characteristic.display.current < characteristic.display.initial)
			classes.push("reduced");

		return classes.join(" ");
	}
}
