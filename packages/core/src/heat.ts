export const RAMP = ['#1a9850','#66bd63','#a6d96a','#d9ef8b','#ffffbf','#fee08b','#fdae61','#f46d43','#d73027'] as const;
export type Scale = 'linear' | 'log';
export function heatOf(weight: number, max: number, scale: Scale = 'linear'): number {
  if (max <= 1 || weight <= 1) return 0;
  return Math.max(0, Math.min(8, Math.round((scale === 'log' ? Math.log(weight) / Math.log(max) : (weight - 1) / (max - 1)) * 8)));
}
