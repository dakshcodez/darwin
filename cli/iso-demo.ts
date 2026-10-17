// Gallery of the 3D cubes in every state: `npx tsx cli/iso-demo.ts [frame]`
import { cube, cubeSize, type CubeMode, type CubeSize, type RGB } from "./iso.js";
const f = Number(process.argv[2] ?? 6);
const states: { name: string; mode: CubeMode; color: RGB; icon?: string }[] = [
  { name: "CLONING", mode: "boot", color: [176, 128, 255], icon: "◐" },
  { name: "TESTING", mode: "scan", color: [255, 184, 64], icon: "◉" },
  { name: "ELIMINATED", mode: "dead", color: [255, 98, 98], icon: "×" },
  { name: "PROMOTED", mode: "glow", color: [70, 220, 130], icon: "★" },
  { name: "BASE", mode: "idle", color: [96, 145, 255], icon: "◈" },
];
for (const size of ["lg", "sm"] as CubeSize[]) {
  const { w } = cubeSize(size);
  const cols = states.map((s) => cube({ size, color: s.color, mode: s.mode, frame: f, icon: s.icon }));
  const h = Math.max(...cols.map((c) => c.length));
  for (let r = 0; r < h; r++) console.log("  " + cols.map((c) => c[r] ?? " ".repeat(w)).join("   "));
  console.log("  " + states.map((s) => s.name.padEnd(w)).join("   ") + "\n");
}
