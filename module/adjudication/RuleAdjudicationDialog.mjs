import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { TargetRowInteraction } from "../targets/TargetRowInteraction.mjs";

const { DialogV2 } = foundry.applications.api;
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "rule-adjudication-request";
const RESPONSE_TYPE = "rule-adjudication-response";
const TIMEOUT_MS = 60000;
const pending = new Map();
let installed = false;

/** Reusable yes/no GM adjudication for situational rule decisions. */
export class RuleAdjudicationDialog {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.once("ready", () => {
			game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
		});
	}

	static async request({ title, prompt, diagnostics = [], targets = [] } = {}) {
		if (game.user?.isGM) {
			return showDecision({ title, prompt, diagnostics, targets });
		}
		if (!game.socket) {
			return { approved: false, reason: localize("The system socket is unavailable.", "Gniazdo systemu jest niedostępne.") };
		}
		const gm = ActorRollPolicy.primaryActiveGM();
		if (!gm) {
			return { approved: false, reason: localize("An active GM is required to adjudicate this rule.", "Do rozstrzygnięcia tej zasady wymagany jest aktywny MG.") };
		}

		const requestId = foundry.utils.randomID();
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				pending.delete(requestId);
				resolve({ approved: false, reason: localize("The GM did not answer in time.", "MG nie odpowiedział w wymaganym czasie.") });
			}, TIMEOUT_MS);
			pending.set(requestId, { resolve, timeout });
			game.socket.emit(SOCKET_CHANNEL, {
				type: REQUEST_TYPE,
				requestId,
				requestUserId: String(game.user?.id ?? ""),
				gmUserId: String(gm.id ?? ""),
				title: String(title ?? localize("Rule adjudication", "Rozstrzygnięcie zasady")),
				prompt: String(prompt ?? ""),
				diagnostics: (diagnostics ?? []).map(String),
				targets: (targets ?? []).map((target) => ({
					actorUuid: String(target.actorUuid ?? target.actor?.uuid ?? ""),
					tokenUuid: String(target.tokenUuid ?? target.token?.document?.uuid ?? ""),
					name: String(target.name ?? target.actor?.name ?? "—"),
				})),
			});
		});
	}
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pending.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pending.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		entry.resolve({
			approved: payload.approved === true,
			reason: String(payload.reason ?? ""),
			adjudicatedBy: String(payload.adjudicatedBy ?? ""),
			adjudicatedAt: Number(payload.adjudicatedAt ?? Date.now()),
		});
		return;
	}
	if (payload.type !== REQUEST_TYPE || !game.user?.isGM) return;
	if (String(payload.gmUserId ?? "") !== String(game.user.id ?? "")) return;

	const decision = await showDecision(payload);
	game.socket.emit(SOCKET_CHANNEL, {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		approved: decision.approved === true,
		reason: String(decision.reason ?? ""),
		adjudicatedBy: String(game.user.id ?? ""),
		adjudicatedAt: Date.now(),
	});
}

async function showDecision({ title, prompt, diagnostics = [], targets = [] } = {}) {
	const content = document.createElement("div");
	content.className = "wfrp-rule-adjudication";
	if (prompt) {
		const paragraph = document.createElement("p");
		paragraph.textContent = String(prompt);
		content.append(paragraph);
	}
	if (diagnostics.length) {
		const list = document.createElement("ul");
		for (const diagnostic of diagnostics) {
			const item = document.createElement("li");
			item.textContent = String(diagnostic);
			list.append(item);
		}
		content.append(list);
	}
	if (targets.length) {
		const targetList = document.createElement("div");
		targetList.className = "wfrp-rule-adjudication__targets";
		for (const target of targets) {
			const row = document.createElement("div");
			row.className = "wfrp-rule-adjudication__target";
			const name = document.createElement("strong");
			name.dataset.wfrpTargetIdentity = "";
			name.textContent = String(target.name ?? "—");
			row.append(name);
			TargetRowInteraction.bind(row, target);
			targetList.append(row);
		}
		content.append(targetList);
	}

	const response = await DialogV2.wait({
		classes: ["wfrp1ed", "wfrp1ed-parchment-window", "wfrp-rule-adjudication-dialog"],
		window: { title: String(title ?? localize("Rule adjudication", "Rozstrzygnięcie zasady")) },
		content,
		buttons: [
			{
				action: "approve",
				label: localize("Allow", "Zezwól"),
				icon: "fa-solid fa-check",
				default: true,
				callback: () => ({ approved: true }),
			},
			{
				action: "reject",
				label: localize("Reject", "Odrzuć"),
				icon: "fa-solid fa-xmark",
				callback: () => ({ approved: false }),
			},
		],
		rejectClose: false,
	});
	return response?.approved === true
		? { approved: true, adjudicatedBy: String(game.user?.id ?? ""), adjudicatedAt: Date.now() }
		: { approved: false, reason: localize("The GM rejected this rule exception.", "MG odrzucił wyjątek od tej zasady.") };
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

RuleAdjudicationDialog.install();
