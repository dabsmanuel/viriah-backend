/**
 * Colour safety for school brands (WEB-06, Document 3 section 10.1).
 * primary-contrast is black or white, whichever has the higher WCAG contrast ratio against the primary colour.
 * Where the primary on white is below 4.5 to 1, a darkened variant is derived for text and links, and the original
 * is kept for filled areas. Two chosen colours with a ratio below 1.5 to 1 are flagged as hard to tell apart.
 */

export type RGB = [number, number, number];

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Black or white, whichever has the higher contrast against the colour. */
export function contrastColour(bg: RGB): '#000000' | '#ffffff' {
  return contrastRatio(bg, BLACK) >= contrastRatio(bg, WHITE) ? '#000000' : '#ffffff';
}

/** A darkened variant of the colour that reads at 4.5 to 1 on white, for text and links. */
export function textOnWhite(colour: RGB): RGB {
  if (contrastRatio(colour, WHITE) >= 4.5) return colour;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(colour, BLACK, t);
    if (contrastRatio(c, WHITE) >= 4.5) return c;
  }
  return BLACK;
}

export interface BrandTokens {
  primary: string;
  primaryContrast: string;
  primaryText: string;
  primarySoft: string;
  secondary: string;
  secondaryContrast: string;
  secondaryText: string;
  ratioBetween: number;
  warnings: string[];
}

export function brandTokens(primaryHex: string, secondaryHex: string): BrandTokens {
  const p = parseHex(primaryHex) ?? [29, 78, 216];
  const s = parseHex(secondaryHex) ?? [15, 118, 110];
  const ratioBetween = contrastRatio(p, s);
  const warnings: string[] = [];
  if (ratioBetween < 1.5) warnings.push('The two colours are too close to tell apart. Choose colours that look different.');
  const pText = textOnWhite(p);
  if (toHex(pText) !== toHex(p)) warnings.push('The primary colour is light on white. A darker shade will be used for text and links.');
  return {
    primary: toHex(p),
    primaryContrast: contrastColour(p),
    primaryText: toHex(pText),
    primarySoft: toHex(mix(p, WHITE, 0.9)),
    secondary: toHex(s),
    secondaryContrast: contrastColour(s),
    secondaryText: toHex(textOnWhite(s)),
    ratioBetween: Math.round(ratioBetween * 100) / 100,
    warnings
  };
}
