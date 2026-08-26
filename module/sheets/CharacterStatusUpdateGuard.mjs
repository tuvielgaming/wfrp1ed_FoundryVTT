/**
 * Character.status is a native SchemaField. Foundry can clean a partial object
 * update to that SchemaField by filling omitted siblings with their initial
 * values. Preserve the complete current status record before validation, then
 * overlay only the incoming status changes.
 *
 * This is the status equivalent of CharacterDetailsUpdateGuard: it prevents a
 * Magic Points / Power Level edit (or any other partial status edit) from
 * resetting sibling status resources to their schema defaults.
 */
Hooks.on("preUpdateActor", (actor, changes) => {
	if (
		actor?.type !== "character" ||
		!changes ||
		typeof changes !== "object"
	) {
		return;
	}

	const nestedStatus = changes.system?.status;
	const hasNestedStatus = Boolean(
		nestedStatus &&
		typeof nestedStatus === "object" &&
		!Array.isArray(nestedStatus)
	);

	const directStatusEntries = Object.entries(changes).filter(
		([key]) => key.startsWith("system.status."),
	);

	if (!hasNestedStatus && directStatusEntries.length === 0) {
		return;
	}

	const current = foundry.utils.deepClone(actor.system?.status ?? {});
	const incoming = hasNestedStatus
		? foundry.utils.deepClone(nestedStatus)
		: {};

	for (const [key, value] of directStatusEntries) {
		const relativePath = key.slice("system.status.".length);
		foundry.utils.setProperty(
			incoming,
			relativePath,
			foundry.utils.deepClone(value),
		);
		delete changes[key];
	}

	changes.system ??= {};
	changes.system.status = foundry.utils.mergeObject(
		current,
		incoming,
		{
			inplace: false,
			overwrite: true,
			insertKeys: true,
			insertValues: true,
		},
	);
});
