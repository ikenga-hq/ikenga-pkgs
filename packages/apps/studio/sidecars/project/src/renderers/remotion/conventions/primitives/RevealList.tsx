/**
 * RevealList — vertical/horizontal list whose items reveal one-by-one.
 * Staggered cards / bullet lists with spring entrance.
 */

import React from 'react';
import { useCurrentFrame, useVideoConfig, spring } from 'remotion';
import { usePalette } from '../theme/BrandProvider.js';

export type RevealItem = {
  content: string | React.ReactNode;
  revealAtFrame?: number;
  icon?: React.ReactNode;
};

export type RevealListProps = {
  items: RevealItem[];
  stagger?: number;
  startAt?: number;
  gap?: number;
  direction?: 'vertical' | 'horizontal';
  fontFamily?: string;
};

export const RevealList: React.FC<RevealListProps> = ({
  items,
  stagger = 24,
  startAt = 0,
  gap = 28,
  direction = 'vertical',
  fontFamily = 'system-ui, -apple-system, sans-serif',
}) => {
  const palette = usePalette();
  const isLofi = palette.lofi === true;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const resolveFrame = (item: RevealItem, index: number): number => {
    if (item.revealAtFrame !== undefined) return startAt + item.revealAtFrame;
    return startAt + index * stagger;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction === 'horizontal' ? 'row' : 'column',
        gap,
        fontFamily,
      }}
    >
      {items.map((item, i) => {
        const revealFrame = resolveFrame(item, i);
        const p = spring({
          frame: frame - revealFrame,
          fps,
          config: { damping: 16, stiffness: 95, mass: 0.8 },
          from: 0,
          to: 1,
        });
        const tx = direction === 'horizontal' ? `translateX(${(1 - p) * -60}px)` : '';
        const ty = direction === 'vertical' ? `translateY(${(1 - p) * 24}px)` : '';

        return (
          <div
            key={i}
            style={{
              opacity: p,
              transform: `${tx}${ty}`,
              backgroundColor: palette.surface,
              border: `1px solid ${palette.border}`,
              borderRadius: isLofi ? 4 : 16,
              padding: '16px 20px',
              color: palette.textPri,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              boxShadow: isLofi ? 'none' : undefined,
            }}
          >
            {item.icon && <span style={{ fontSize: 28 }}>{item.icon}</span>}
            <span>{item.content}</span>
          </div>
        );
      })}
    </div>
  );
};
