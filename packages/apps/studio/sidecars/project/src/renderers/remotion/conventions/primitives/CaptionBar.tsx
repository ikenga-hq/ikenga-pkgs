/**
 * CaptionBar — bottom-anchored caption pill, synced to ABSOLUTE video frame.
 *
 * Placed at the root of a composition to sync across scenes.
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { usePalette } from '../theme/BrandProvider.js';

export type CaptionPhrase = {
  text: string;
  /** Seconds, absolute from video start. */
  start: number;
  /** Seconds, absolute from video start. */
  end: number;
};

export type CaptionBarProps = {
  phrases: CaptionPhrase[];
  /** Distance from anchor edge in px. Default 260. */
  inset?: number;
  /** Anchor side. Default "bottom". */
  position?: 'bottom' | 'top';
  /** Max content width (fraction of container). Default 0.84. */
  maxWidth?: number;
  /** Font size override. Default 44. */
  fontSize?: number;
  fontFamily?: string;
};

export const CaptionBar: React.FC<CaptionBarProps> = ({
  phrases,
  inset = 260,
  position = 'bottom',
  maxWidth = 0.84,
  fontSize = 44,
  fontFamily = 'system-ui, -apple-system, sans-serif',
}) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentSec = frame / fps;
  const active = phrases.find((p) => currentSec >= p.start && currentSec < p.end);

  if (!active) return null;

  const accentBg = palette.lofi
    ? palette.surface
    : `${palette.accent}E0`; // 88% alpha hex

  const border = palette.lofi
    ? `1px solid ${palette.border}`
    : `1px solid ${palette.accent}`;

  const shadow = palette.lofi ? 'none' : '0 6px 24px rgba(0,0,0,0.35)';

  const anchorStyle = position === 'bottom'
    ? { justifyContent: 'flex-end', paddingBottom: inset }
    : { justifyContent: 'flex-start', paddingTop: inset };

  return (
    <AbsoluteFill
      style={{
        ...anchorStyle,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          backgroundColor: accentBg,
          border,
          borderRadius: 14,
          padding: '14px 28px',
          maxWidth: `${maxWidth * 100}%`,
          textAlign: 'center',
          boxShadow: shadow,
        }}
      >
        <span
          style={{
            fontFamily,
            fontSize,
            fontWeight: 600,
            color: palette.textPri,
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
          }}
        >
          {active.text}
        </span>
      </div>
    </AbsoluteFill>
  );
};
