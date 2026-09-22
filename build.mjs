import { build } from "esbuild";
await build({
  entryPoints: [
    "src/extension.ts",
    "src/transport.ts",
    "src/protocol.ts",
    "src/render.ts",
    "src/contract-document.ts",
    "src/contract-editor.ts",
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "dist",
  external: ["vscode"],
  sourcemap: true,
});
