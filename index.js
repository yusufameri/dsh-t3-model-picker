/**
 * Host half of the T3 model picker bundle.
 *
 * The whole feature is browser-side: the Client half registers a second
 * occupant of the composer's `conversation.input.model` seat at a lower
 * priority than the shipped ModelSelect, and reads the same per-session
 * model directory that seat uses. Nothing runs in the Node process, so this
 * half exists only to satisfy the bundle's Host entry.
 */

/** No Host-side behavior. */
export function apply() {}
