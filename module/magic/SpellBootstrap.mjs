import {
	SPELL_COST_INTERVAL,
	SPELL_TRADITION,
	SpellData,
} from "../data-models/item/SpellData.mjs";
import { SpellItemSheet } from "../sheets/SpellItemSheet.mjs";
import "../chat/DiceFirstChatReveal.mjs";
import "../tests/TestResultOwnerAdjudicationIntegration.mjs";
import "./CoreCastingFailureWorkflow.mjs";
import "./SpellCastLinkage.mjs";
import "./FireBallExplicitCastContext.mjs";
import "./FireBallBallGroupPresentation.mjs";
import "./FireBallBallGroupAutoCreate.mjs";
import "./FireBallBallGroupDisclosureIndicator.mjs";
import "./FireBallBallGroupInitiativeAction.mjs";
import "./FireBallBallGroupActionRecovery.mjs";
import "./FireBallBallGroupDiceRevealGuard.mjs";
import "./FireBallCastPsychologyPresentation.mjs";
import "./FireBallCriticalFallback.mjs";
import "./FireBallDamageLabels.mjs";
import "./FireBallDamageCardConsistency.mjs";
import { installFireBallDamageInvalidationLifecycle } from "./FireBallDamageInvalidationLifecycle.mjs";
import { installFireBallGroupHitDiceAnimation } from "./FireBallGroupHitDiceAnimation.mjs";
import { installFireBallPresentationConsistency } from "./FireBallPresentationConsistency.mjs";
import "./FireBallPsychologyResultPresentation.mjs";
import "./FireBallVulnerabilitySync.mjs";
import { installFireBallDamageResultView } from "./FireBallDamageResultView.mjs";
import {
	FireBallProcedure,
	installFireBallPresentation,
} from "./FireBallProcedureV2.mjs";
import { installFireBallTargetingDialogIntegration } from "./FireBallTargetingDialogIntegration.mjs";
import { SpellProcedureRegistry } from "./SpellProcedureRegistry.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/** Register the rulebook-backed Spell document and its authoring sheet. */
Hooks.once("init", () => {
	CONFIG.Item.dataModels.spell = SpellData;
	SpellProcedureRegistry.register(FireBallProcedure);
	installFireBallPresentation();
	installFireBallTargetingDialogIntegration();
	installFireBallDamageResultView();
	installFireBallDamageInvalidationLifecycle();
	installFireBallGroupHitDiceAnimation();
	installFireBallPresentationConsistency();

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		SpellItemSheet,
		{
			types: ["spell"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		magic: Object.freeze({
			...(game.WFRP1ED?.magic ?? {}),
			spellTradition: SPELL_TRADITION,
			spellCostInterval: SPELL_COST_INTERVAL,
			spellProcedures: SpellProcedureRegistry,
		}),
	});
});