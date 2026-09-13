/*
 * Foundry v14 moved TextEditor APIs behind
 * foundry.applications.ux.TextEditor.implementation. A few mature drag/drop
 * integrations still contain the v13/global spelling. They are behaviorally
 * correct, but touching the compatibility getter produces a deprecation warning
 * and will stop working when that getter disappears in Foundry v15.
 *
 * Install the v14 implementation at both legacy access surfaces before any
 * feature module is loaded. This is a narrow compatibility bridge only: it does
 * not alter getDragEventData(), payloads, or drop routing. Individual call sites
 * can then be migrated independently without leaving another warning path open.
 */
const TextEditorNamespace = foundry.applications?.ux?.TextEditor;
const implementation = TextEditorNamespace?.implementation;

if (implementation && typeof implementation.getDragEventData === "function") {
	installNamespacedAlias(TextEditorNamespace, implementation);
	installGlobalAlias(implementation);
} else {
	console.error(
		"WFRP1ED | Foundry v14 TextEditor implementation is unavailable; drag/drop compatibility could not be installed.",
	);
}

function installNamespacedAlias(namespace, target) {
	if (!namespace || namespace === target) return;
	const descriptor = Object.getOwnPropertyDescriptor(namespace, "getDragEventData");
	if (descriptor?.configurable === false) return;
	Object.defineProperty(namespace, "getDragEventData", {
		configurable: true,
		enumerable: false,
		writable: false,
		value: target.getDragEventData.bind(target),
	});
}

function installGlobalAlias(target) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEditor");
	if (descriptor?.configurable === false) return;
	Object.defineProperty(globalThis, "TextEditor", {
		configurable: true,
		enumerable: false,
		writable: false,
		value: target,
	});
}
