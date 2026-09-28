/**
 * The chrome only `/broadcast` mounts over the room — the overlay card and the work stack. One
 * lazy chunk rather than two (ADR 464): `/live` no longer renders either (its work lives in the
 * team column), so they leave its eager graph together, and a single split pays one chunk's
 * overhead against the total budget instead of two (ADR 183's un-splitting lever).
 */
export { OfficeOverlay } from './OfficeOverlay';
export { WorkStack } from './WorkStack';
