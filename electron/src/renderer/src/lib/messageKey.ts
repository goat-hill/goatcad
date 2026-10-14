declare const messageKey: unique symbol

/**
 * A locale key handed on to be translated later — an undo label a session
 * translates when it records the step, a caption a map holds until render.
 * Only `tk()` makes one, so a function that takes a key rather than text says
 * so in its signature and a bare string does not type-check.
 */
export type MessageKey = string & { readonly [messageKey]: true }

/**
 * Marks a locale key without translating it. Every key literal in the renderer
 * sits inside `t('…')` (translate now) or `tk('…')` (translate later), so the
 * locale test can find each one and check it resolves (RULES.md §3).
 */
export const tk = (key: string): MessageKey => key as MessageKey
