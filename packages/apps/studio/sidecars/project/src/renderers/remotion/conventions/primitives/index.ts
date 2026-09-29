/**
 * Video primitives barrel for Studio Remotion cells (WP-14).
 *
 * 8 lifted primitives:
 * - Stat: numeric callouts ("$1.2M", "20 min")
 * - RevealList: staggered lists and cards
 * - HighlightWords: accent-highlighted keywords with preserved whitespace
 * - KenBurns: slow cinematic camera zoom/pan
 * - Annotation: callout label connected by animated arrow to target
 * - ChatBubble: chat-bubble UI metaphor
 * - AvatarBadge: circular persona reveal badge
 * - CaptionBar: bottom/top anchored caption pill
 */

export { Stat, type StatProps } from './Stat.js';
export { RevealList, type RevealListProps, type RevealItem } from './RevealList.js';
export { HighlightWords, type HighlightWordsProps, splitSegments } from './HighlightWords.js';
export { KenBurns, type KenBurnsProps } from './KenBurns.js';
export { Annotation, type AnnotationProps } from './Annotation.js';
export { ChatBubble, type ChatBubbleProps } from './ChatBubble.js';
export { AvatarBadge, type AvatarBadgeProps } from './AvatarBadge.js';
export { CaptionBar, type CaptionBarProps, type CaptionPhrase } from './CaptionBar.js';
