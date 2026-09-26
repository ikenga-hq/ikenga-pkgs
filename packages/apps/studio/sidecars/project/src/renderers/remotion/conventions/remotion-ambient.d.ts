// Ambient type definitions for Remotion inside Studio project sidecar
// Allows authoring conventions to compile cleanly under shared tsc.

declare module 'remotion' {
  import type React from 'react';

  export interface SpringConfig {
    damping?: number;
    stiffness?: number;
    mass?: number;
    overshootClamping?: boolean;
  }

  export interface SpringOptions {
    frame: number;
    fps: number;
    config?: SpringConfig;
    from?: number;
    to?: number;
    durationInFrames?: number;
  }

  export function spring(options: SpringOptions): number;

  export interface InterpolateOptions {
    extrapolateLeft?: 'clamp' | 'extend' | 'identity';
    extrapolateRight?: 'clamp' | 'extend' | 'identity';
    easing?: (t: number) => number;
  }

  export function interpolate(
    input: number,
    inputRange: readonly number[],
    outputRange: readonly number[],
    options?: InterpolateOptions,
  ): number;

  export function useCurrentFrame(): number;

  export function useVideoConfig(): {
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
    id: string;
  };

  export const AbsoluteFill: React.FC<React.HTMLAttributes<HTMLDivElement>>;

  export interface CompositionProps<T = any> {
    id: string;
    component: React.ComponentType<T>;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    defaultProps?: T;
  }

  export const Composition: React.FC<CompositionProps<any>>;

  export function registerRoot(component: React.ComponentType<any>): void;
}
