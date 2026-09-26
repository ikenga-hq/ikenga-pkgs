/**
 * BrandProvider — React context provider for the active BrandPalette.
 *
 * Usage:
 *   <BrandProvider palette={myPalette}>
 *     <MyComposition />
 *   </BrandProvider>
 *
 * When `palette.lofi` is true (or the `lofi` prop is set to true) the provider
 * automatically substitutes the wireframe-grayscale lofiPalette so that
 * primitives down the tree can skip glows/gradients and render fast stills for
 * Rung 1 beat-sheet review.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { type BrandPaletteWithMode, defaultPalette, lofiPalette } from './brand.js';

// ── Context ────────────────────────────────────────────────────────────────

const BrandContext = createContext<BrandPaletteWithMode>(defaultPalette);

// ── Provider ───────────────────────────────────────────────────────────────

export interface BrandProviderProps {
  /**
   * The palette to expose to all children. Defaults to `defaultPalette`.
   * If omitted, children inherit from the nearest ancestor BrandProvider.
   */
  palette?: BrandPaletteWithMode;
  /**
   * Convenience shorthand: setting `lofi={true}` is equivalent to wrapping
   * with the lofiPalette regardless of what `palette` says.
   */
  lofi?: boolean;
  children: React.ReactNode;
}

export const BrandProvider: React.FC<BrandProviderProps> = ({
  palette,
  lofi,
  children,
}) => {
  const resolved = useMemo<BrandPaletteWithMode>(() => {
    const isLofi = lofi === true || palette?.lofi === true;
    if (isLofi) return lofiPalette;
    return palette ?? defaultPalette;
  }, [palette, lofi]);

  return (
    <BrandContext.Provider value={resolved}>{children}</BrandContext.Provider>
  );
};

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Returns the BrandPaletteWithMode from the nearest BrandProvider ancestor.
 * Falls back to `defaultPalette` if no provider is present.
 */
export function usePalette(): BrandPaletteWithMode {
  return useContext(BrandContext);
}
