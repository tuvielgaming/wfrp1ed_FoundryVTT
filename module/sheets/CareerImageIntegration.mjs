Hooks.on("renderApplicationV2", (application, element) => {
	const root = element instanceof HTMLElement ? element : null;
	if (!root || !isCareerItemSheet(application)) return;

	const image = root.querySelector(".career-item-sheet__image");
	if (!(image instanceof HTMLImageElement)) return;

	image.alt = String(application.document?.name ?? "");
	image.draggable = false;

	if (!application.isEditable) return;

	image.dataset.action = "editImage";
	image.dataset.edit = "img";
	image.dataset.field = "img";
	image.classList.add("wfrp1ed-document-image--editable");
	image.title = localize(
		"Click to choose the full Career illustration.",
		"Kliknij, aby wybrać pełną ilustrację Profesji.",
	);
});

function isCareerItemSheet(application) {
	return (
		application?.document?.documentName === "Item" &&
		application.document.type === "career"
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
