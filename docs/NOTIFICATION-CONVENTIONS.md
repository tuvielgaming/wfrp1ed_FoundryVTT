# WFRP1ED notification conventions

This file records the project rule for Foundry notifications so gameplay information is not lost while technical and routine UI messages do not flood Chat.

## Three notification classes

Every new notification must be classified before implementation.

### 1. Technical / system error

Examples: socket failure, missing document required by an internal transaction, failed persistence, unexpected exception, rendering or synchronization failure.

Use the normal Foundry error lifecycle (`ui.notifications.error`) and log the technical details to the console when appropriate.

Do **not** convert an unknown exception into a GM gameplay notice. Gameplay-notice classification must always be explicit and narrow so programming defects are not disguised as rule messages.

### 2. Local UI feedback

Examples: invalid field value, stack cannot be split because quantity is 1, Equipment stacks cannot merge because their Active Effects differ, successful local split/merge feedback, action or permission feedback whose relevant state is already visible in the current UI.

Keep these as ordinary transient Foundry notifications (`info` or `warn` as appropriate). They are not useful enough to justify permanent GM Chat history.

### 3. GM gameplay / adjudication notice

Use `GMGameplayNotice` for gameplay or rule state which the GM may need to read carefully, remember, or adjudicate after the toast would normally disappear.

Examples currently classified this way:

- no readily accessible ranged ammunition, including reserve-ammunition information;
- parry debt carried into a new combat round;
- insufficient free hands for climbing while automatic hand validation is disabled and the table must adjudicate the attempt.

Use:

```js
await GMGameplayNotice.warn({ ... });
```

for a gameplay warning, or:

```js
await GMGameplayNotice.info({ ... });
```

for informational gameplay state. Preserve the original severity: turning persistence on must not turn an informational notice into a warning.

## World Setting behavior

`Zachowuj komunikaty dla MG w czacie` / `Save GM gameplay notices in chat` is OFF by default.

- OFF: `GMGameplayNotice.info/warn` behaves as the corresponding ordinary transient Foundry notification.
- ON: the full notice is persisted as a private ChatMessage visible to all GM users, and the triggering client receives a short toast of the same severity.
- A player-triggered persistent notice is authored by the active GM through the system socket so the player does not gain visibility through Foundry whisper-author semantics.

Feature modules must use `GMGameplayNotice`; they must not independently create private GM whisper messages for this purpose.

## Avoid duplicate persistence

Do not persist a second GM notice merely because a mechanic is important if the same information already lives clearly in an ordinary persistent gameplay Chat card.

Examples which normally stay out of `GMGameplayNotice`:

- drowning lifecycle and damage state, because the Swimming/Drowning cards already preserve it;
- Fall and held-items consequences, because their result/consequence cards already persist the state;
- combat defence rule reminders already embedded in the attack/defence Chat UI.

Create a GM notice only when there is additional private adjudication information that would otherwise disappear.

## Context and wording

- Attach `actor` and `item` when one clear source exists so the GM card identifies the subject.
- A notice concerning several Combatants may omit Actor context and summarize them in the body.
- State the mechanical fact first, then why GM/table adjudication is needed.
- When persistence is ON, keep the toast short; the complete explanation belongs in the private GM Chat message.
- Avoid routine success spam and repeated confirmations.

## Review checklist

Before migrating or adding a notification:

- classify it as technical, local UI, or GM gameplay/adjudication;
- verify that unknown exceptions remain on the technical path;
- check whether the information is already persisted elsewhere in Chat;
- choose `info` versus `warn` deliberately;
- verify behavior with GM gameplay notice persistence both OFF and ON;
- if player-triggerable, verify the player cannot see the GM-only Chat message;
- preserve existing mechanics: notification persistence must not change whether an action is allowed, blocked, or resolved.
