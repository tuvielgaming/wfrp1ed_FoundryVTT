/*
 * Foundry VTT v14 DialogV2 accepts HTMLElement content only when the supplied
 * top-level element has no attributes. The actual styled/form content may have
 * classes, data attributes, etc. as normal below that root.
 *
 * Keep this rule in one compatibility boundary so every current and future
 * WFRP dialog using HTMLElement content receives the same safe contract. String
 * content and already-valid attribute-free element roots are left untouched.
 */
installDialogV2ElementContentCompatibility();

function installDialogV2ElementContentCompatibility() {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2 || DialogV2.__wfrpElementContentCompatibilityInstalled === true) {
		return;
	}

	for (const methodName of ["wait", "confirm", "prompt"]) {
		const original = DialogV2[methodName];
		if (typeof original !== "function") continue;

		DialogV2[methodName] = function wfrpDialogV2ElementContentGuard(
			config = {},
			...args
		) {
			return original.call(
				this,
				normalizeDialogConfig(config),
				...args,
			);
		};
	}

	Object.defineProperty(
		DialogV2,
		"__wfrpElementContentCompatibilityInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function normalizeDialogConfig(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return config;
	}

	const content = config.content;
	if (!isElement(content) || content.attributes?.length === 0) {
		return config;
	}

	const ownerDocument = content.ownerDocument ?? document;
	const root = ownerDocument.createElement("div");
	root.append(content);

	return {
		...config,
		content: root,
	};
}

function isElement(value) {
	return Boolean(
		value &&
		value.nodeType === 1 &&
		typeof value.append === "function" &&
		value.attributes,
	);
}
