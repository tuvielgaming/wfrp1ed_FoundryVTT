console.info("WFRP1ED PROBE | module loaded");

window.addEventListener("error", (event) => {
	console.error("WFRP1ED PROBE | window error", {
		message: event?.message,
		filename: event?.filename,
		lineno: event?.lineno,
		colno: event?.colno,
		error: event?.error,
	});
});

window.addEventListener("unhandledrejection", (event) => {
	console.error("WFRP1ED PROBE | unhandled rejection", event?.reason);
});

Hooks.once("init", () => {
	console.info("WFRP1ED PROBE | init reached");
});

Hooks.once("ready", () => {
	console.info("WFRP1ED PROBE | ready reached", {
		apiPresent: Boolean(game.WFRP1ED),
		actorSheets: CONFIG.Actor.sheetClasses?.character,
		skillSheets: CONFIG.Item.sheetClasses?.skill,
	});
});
