import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = path.join("node_modules", ".cache", "lavande-midnight");
const outfile = path.join(dir, "new-event-sheet.mjs");

await mkdir(dir, { recursive: true });
await build({
  entryPoints: ["src/screens/new-event-sheet.tsx"],
  outfile,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  alias: { "@": "./src" },
  external: ["react", "react-dom", "motion/react", "lucide-react"],
  logLevel: "silent",
});

const sheet = await import(pathToFileURL(path.resolve(outfile)).href);
await rm(dir, { recursive: true, force: true });

const cases = [
  { label: "22:30 + 2 h → fin", got: sheet.addMinutes("22:30", 120), want: "00:30" },
  { label: "22:30 + 2 h → minuit", got: sheet.totalMinutes("22:30", 120) >= 24 * 60, want: true },
  { label: "22:00 + 2 h → fin", got: sheet.addMinutes("22:00", 120), want: "00:00" },
  { label: "22:00 + 2 h → minuit pile", got: sheet.totalMinutes("22:00", 120) >= 24 * 60, want: true },
  { label: "23:00 + 1 h → minuit pile", got: sheet.totalMinutes("23:00", 60) >= 24 * 60, want: true },
  { label: "10:00 + 1 h → même jour", got: sheet.totalMinutes("10:00", 60) >= 24 * 60, want: false },
  { label: "23:00 + 30 min → fin", got: sheet.addMinutes("23:00", 30), want: "23:30" },
];

const failed = cases.filter((entry) => entry.got !== entry.want);

for (const entry of cases) {
  console.log(`${entry.got === entry.want ? "ok  " : "FAIL"} ${entry.label} : ${entry.got}`);
}

if (failed.length > 0) {
  console.error(`${failed.length} cas en échec`);
  process.exit(1);
}
