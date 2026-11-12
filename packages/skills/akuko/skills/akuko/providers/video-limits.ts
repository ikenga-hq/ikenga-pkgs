/**
 * Which clip lengths each paid video provider makes, by provider id. The
 * motion stage (`motion/plan.ts`) fits a shot to one of them before it prices
 * anything, and the whole-film estimate (`setup/estimate.ts`) fits the same
 * way, so the two can never disagree. Holds no model ids.
 */

import { FAL_VIDEO_PROVIDER_ID, falVideoLimits } from './fal-video/index.ts';
import { GEMINI_VIDEO_PROVIDER_ID, geminiVideoLimits } from './gemini-video/index.ts';
import { KLING_VIDEO_PROVIDER_ID, klingVideoLimits } from './kling-video/index.ts';
import { BYTEPLUS_VIDEO_PROVIDER_ID, byteplusVideoLimits } from './byteplus-video/index.ts';

export interface VideoLengths { allowedSeconds: number[] }

const BY_PROVIDER: Readonly<Record<string, (model: string) => VideoLengths | undefined>> = {
  [FAL_VIDEO_PROVIDER_ID]: falVideoLimits,
  [GEMINI_VIDEO_PROVIDER_ID]: geminiVideoLimits,
  [KLING_VIDEO_PROVIDER_ID]: klingVideoLimits,
  [BYTEPLUS_VIDEO_PROVIDER_ID]: byteplusVideoLimits,
};

/** The paid video providers the motion stage can run (besides the manual one). */
export const VIDEO_PROVIDER_IDS: readonly string[] = Object.keys(BY_PROVIDER);

/** Lengths a provider's model makes; undefined when akuko has no rules for it (or the provider is not a video provider). */
export function videoLimitsFor(provider: string, model: string): VideoLengths | undefined {
  return BY_PROVIDER[provider]?.(model);
}
