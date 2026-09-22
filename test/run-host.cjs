const { runTests } = require("@vscode/test-electron");
const path = require("node:path");
if (
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY
) {
  console.error(
    "Extension-host smoke requires a graphical display or Xvfb. No GUI host is available.",
  );
  process.exitCode = 1;
} else
  runTests({
    version: "1.96.4",
    extensionDevelopmentPath: path.resolve(__dirname, ".."),
    extensionTestsPath: path.resolve(__dirname, "host-smoke.cjs"),
    launchArgs: [
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
