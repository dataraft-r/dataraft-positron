const { runTests } = require("@vscode/test-electron");
const path = require("node:path");
const net = require("node:net");
async function debugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
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
  debugPort()
    .then((port) =>
      runTests({
        version: "1.96.4",
        extensionDevelopmentPath: path.resolve(__dirname, ".."),
        extensionTestsPath: path.resolve(__dirname, "host-smoke.cjs"),
        extensionTestsEnv: { DATARAFT_HOST_CDP_PORT: String(port) },
        launchArgs: [
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${port}`,
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
        ],
      }),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
