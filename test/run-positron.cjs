const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");
const release = require("./positron-release.json");

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
async function main() {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Native Positron tests require a display or Xvfb; no GUI tests are skipped.",
    );
  }
  const root = path.resolve(__dirname, "..");
  const artifacts = path.join(root, ".vscode-test/positron-artifacts");
  const installation = JSON.parse(
    await fs.readFile(path.join(artifacts, "installation.json"), "utf8"),
  );
  assert.equal(installation.sha256, release.sha256);
  const executable =
    process.env.DATARAFT_POSITRON_EXECUTABLE || installation.executable;
  assert.equal(
    executable,
    installation.executable,
    "Use the checksum-verified Positron installation",
  );
  const product = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(executable), "resources/app/product.json"),
      "utf8",
    ),
  );
  assert.equal(
    `${product.positronVersion}-${product.positronBuildNumber}`,
    release.version,
  );
  assert.equal(product.commit, release.source_commit);
  assert.equal((await fs.stat(executable)).size, release.executable_size);
  const runtimeRoot = await fs.mkdtemp(
    path.join(root, ".vscode-test/positron-run-"),
  );
  const userData = path.join(runtimeRoot, "profile");
  const workspace = path.join(runtimeRoot, "workspace");
  const extensions = path.join(runtimeRoot, "extensions");
  for (const directory of [
    path.join(userData, "User"),
    workspace,
    extensions,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }
  const rExecutable =
    process.env.POSITRON_R_PATH ||
    execFileSync("which", ["R"], { encoding: "utf8" }).trim();
  await fs.access(rExecutable, 1);
  await fs.writeFile(
    path.join(userData, "User/settings.json"),
    JSON.stringify(
      {
        "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
        "extensions.ignoreRecommendations": true,
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "workbench.startupEditor": "none",
        "positron.r.customBinaries": [rExecutable],
        "positron.r.interpreters.default": rExecutable,
        "positron.r.interpreters.override": [rExecutable],
      },
      null,
      2,
    ),
  );
  const cliVersion = execFileSync(
    path.join(path.dirname(executable), "bin/positron"),
    ["--version"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.ok(
    cliVersion.includes(product.positronVersion),
    "CLI reports the pinned Positron version",
  );
  const provenance = {
    version: release.version,
    source_commit: product.commit,
    archive_sha256: release.sha256,
    cli_version: cliVersion.trim(),
    node: process.version,
    r_executable: rExecutable,
    r_version: execFileSync(rExecutable, ["--version"], {
      encoding: "utf8",
      timeout: 30000,
    }).split("\n")[0],
    expected_r_version: process.env.DATARAFT_EXPECT_R_VERSION || "4.5.1",
    workspace,
    user_data: userData,
  };
  await fs.writeFile(
    path.join(artifacts, "runtime.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  await fs.copyFile(
    path.join(root, ".vscode-test/r-provenance.json"),
    path.join(artifacts, "r-packages.json"),
  );
  console.log("Native Positron runtime:", JSON.stringify(provenance));
  const port = await debugPort();
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "positron-host.cjs"),
      extensionTestsEnv: {
        DATARAFT_HOST_CDP_PORT: String(port),
        DATARAFT_POSITRON_WORKSPACE: workspace,
        DATARAFT_POSITRON_VERSION: release.version,
        DATARAFT_POSITRON_ARTIFACTS: artifacts,
        DATARAFT_EXPECT_R_VERSION: provenance.expected_r_version,
        POSITRON_R_PATH: rExecutable,
      },
      launchArgs: [
        workspace,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--window-size=1600,1000",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
      ],
    });
  } finally {
    await fs
      .cp(path.join(userData, "logs"), path.join(artifacts, "logs"), {
        recursive: true,
      })
      .catch(() => {});
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
