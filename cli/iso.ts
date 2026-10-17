/**
 * 3D cubes drawn with block characters (oblique projection: a front face, a top face and a side face). A sandbox is a
 * cube whose look reflects its state:
 *   boot   the cube materializes from the bottom up      (forking, patching)
 *   scan   a bright sweep runs over the faces            (tests running)
 *   dead   the cube greys out and dissolves              (eliminated)
 *   glow   edges pulse and sparkles drift above          (promoted)
 *   idle   static, steady edges                          (paused base, survivors)
 * Pure text, no dependencies. Every returned line has the same visible width.
 */

export type RGB = [number, number, number];
export type CubeMode = "boot" | "scan" | "dead" | "glow" | "idle";
export type CubeSize = "lg" | "sm";

export interface CubeOpts {
  size: CubeSize;
  color: RGB;
  mode: CubeMode;
  frame: number;
  icon?: string; // drawn in the middle of the front face
  noColor?: boolean;
}

// W = front width in columns, F = front height in rows, D = depth (each step moves 2 columns right and 1 row up)
const DIMS: Record<CubeSize, { W: number; F: number; D: number }> = { lg: { W: 12, F: 5, D: 3 }, sm: { W: 9, F: 3, D: 2 } };

type Face = "front" | "top" | "side" | null;
const fg = (c: RGB, s: string, on: boolean) => (on ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m` : s);
const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const scale = (a: RGB, k: number): RGB => [Math.min(255, Math.round(a[0] * k)), Math.min(255, Math.round(a[1] * k)), Math.min(255, Math.round(a[2] * k))];
const hash = (x: number, y: number, f: number) => { const n = Math.sin(x * 12.9898 + y * 78.233 + f * 0.37) * 43758.5453; return n - Math.floor(n); };

export function cubeSize(size: CubeSize): { w: number; h: number } {
  const { W, F, D } = DIMS[size];
  return { w: W + 2 * D, h: F + D };
}

function faceAt(x: number, y: number, size: CubeSize): Face {
  const { W, F, D } = DIMS[size];
  if (y >= D && y < D + F && x >= 0 && x < W) return "front";
  if (y >= 0 && y < D) { const s = 2 * (D - y); if (x >= s && x < s + W) return "top"; }
  if (x >= W && x < W + 2 * D) {
    const top = D - Math.ceil((x - (W - 1)) / 2);
    if (y >= top && y < top + F) return "side";
  }
  return null;
}

export function cube(o: CubeOpts): string[] {
  const { W, F, D } = DIMS[o.size];
  const { w, h } = cubeSize(o.size);
  const f = o.frame;
  const on = !o.noColor;
  const grid: Face[][] = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => faceAt(x, y, o.size)));
  const dead = o.mode === "dead";
  const base: RGB = dead ? [118, 124, 140] : o.color;
  const tone: Record<Exclude<Face, null>, number> = { top: 1.05, front: 0.78, side: 0.52 };

  const reveal = o.mode === "boot" ? ((f % 26) / 26) * 1.2 : 1; // materialize from the bottom, looping
  const sweep = o.mode === "scan" ? (f % (h + 5)) - 2 : -99; // bright row travelling down the cube
  const pulse = o.mode === "glow" ? 0.8 + 0.2 * Math.sin(f / 2) : 1;

  const cells: { ch: string; col: RGB | null }[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: " ", col: null })));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const face = grid[y][x];
      if (!face) continue;
      const nb = [grid[y - 1]?.[x], grid[y + 1]?.[x], grid[y]?.[x - 1], grid[y]?.[x + 1]];
      const isEdge = nb.some((n) => n !== face);
      if ((h - 1 - y) / (h - 1) > reveal) continue; // not materialized yet
      let ch = isEdge ? "█" : face === "front" ? "▒" : face === "top" ? "░" : "▓";
      let col: RGB = isEdge ? scale(mix(base, [255, 255, 255], 0.38), pulse) : scale(base, tone[face]);
      if (dead && hash(x, y, Math.floor(f / 3)) < 0.25 + Math.min(0.4, (f % 70) / 150)) ch = hash(y, x, 9) < 0.55 ? " " : "·"; // dissolving
      const d = Math.abs(y - sweep);
      if (d <= 1 && !dead) { ch = d === 0 ? "█" : isEdge ? "█" : "▓"; col = mix(col, [255, 255, 255], d === 0 ? 0.8 : 0.4); }
      cells[y][x] = { ch, col };
    }
  }
  if (o.icon) {
    const ix = Math.floor(W / 2), iy = D + Math.floor(F / 2);
    cells[iy][ix] = { ch: o.icon, col: dead ? [255, 98, 98] : [255, 255, 255] };
  }
  if (o.mode === "glow") {
    for (let i = 0; i < 3; i++) { // sparkles drifting over the top face
      const sx = 1 + Math.floor(hash(i, 3, 1) * (w - 3)), sy = (f + i * 4) % (D + 2);
      if (sy < h && !grid[sy][sx]) cells[sy][sx] = { ch: i % 2 ? "·" : "✦", col: mix(o.color, [255, 255, 255], 0.65) };
    }
  }
  return cells.map((row) => row.map((c) => (c.col ? fg(c.col, c.ch, on) : c.ch)).join(""));
}
