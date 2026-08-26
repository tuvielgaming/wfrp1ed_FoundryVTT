export const WFRP1ED = {};

WFRP1ED.races = {
	none: "",
	elf: "WFRP1ed.Races.Elf",
	dwarf: "WFRP1ed.Races.Dwarf",
	halfling: "WFRP1ed.Races.Halfling",
	human: "WFRP1ed.Races.Human",
};

WFRP1ED.characteristicsAbbrev = {
	sp: "CHARAbbrev.sp",
	ws: "CHARAbbrev.ws",
	bs: "CHARAbbrev.bs",
	s: "CHARAbbrev.s",
	t: "CHARAbbrev.t",
	w: "CHARAbbrev.w",
	i: "CHARAbbrev.i",
	a: "CHARAbbrev.a",
	dex: "CHARAbbrev.dex",
	ld: "CHARAbbrev.ld",
	int: "CHARAbbrev.int",
	cl: "CHARAbbrev.cl",
	wp: "CHARAbbrev.wp",
	fel: "CHARAbbrev.fel",
};

WFRP1ED.partialTemplates = [
	"systems/wfrp1ed/templates/actors/classic/parts/header.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/characteristics.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/melee.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/ranged.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/armour.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/armour-points.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/skills-primary.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/skills-secondary.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/spells.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/movement.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/equipment.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/wealth.hbs",
	"systems/wfrp1ed/templates/actors/classic/parts/fate.hbs",

	// Future Classic-sheet sections are added here only after their
	// corresponding partial exists and its data contract has been audited.
	// "systems/wfrp1ed/templates/actors/classic/parts/notes.hbs",
	// "systems/wfrp1ed/templates/actors/classic/parts/footer.hbs",
];
