const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const release = require("./positron-release.json");

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const root = path.resolve(__dirname, "..", ".vscode-test");
  const artifactRoot = path.join(root, "positron-artifacts");
  await fs.mkdir(artifactRoot, { recursive: true });
  const archive =
    process.env.DATARAFT_POSITRON_DEB || path.join(root, "positron.deb");
  if (!process.env.DATARAFT_POSITRON_DEB) {
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--max-time",
        "600",
        "--output",
        archive,
        release.url,
      ],
      { stdio: "inherit" },
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(
    hash.digest("hex"),
    release.sha256,
    "Official Positron SHA256 must match before extraction",
  );
  const field = (name) =>
    execFileSync("dpkg-deb", ["--field", archive, name], {
      encoding: "utf8",
    }).trim();
  assert.equal(field("Package"), "positron");
  assert.equal(field("Version"), release.deb_version);
  assert.equal(field("Architecture"), release.architecture);
  const directory = path.join(root, "positron-install");
  await fs.mkdir(directory, { recursive: true });
  execFileSync("dpkg-deb", ["--extract", archive, directory], {
    stdio: "inherit",
  });
  const app = path.join(directory, "usr/share/positron");
  const executable = path.join(app, "positron");
  await fs.access(executable, 1);
  assert.equal(
    (await fs.stat(executable)).size,
    release.executable_size,
    "Extracted Electron executable must be complete",
  );
  const product = JSON.parse(
    await fs.readFile(path.join(app, "resources/app/product.json"), "utf8"),
  );
  assert.equal(
    `${product.positronVersion}-${product.positronBuildNumber}`,
    release.version,
  );
  assert.equal(
    product.commit,
    release.source_commit,
    "Packaged product commit must match release tag",
  );
  const identity = {
    ...release,
    executable,
    product: {
      name: product.nameShort,
      version: product.positronVersion,
      build: product.positronBuildNumber,
      commit: product.commit,
      vscode_version: product.version,
    },
  };
  await fs.writeFile(
    path.join(artifactRoot, "installation.json"),
    JSON.stringify(identity, null, 2) + "\n",
  );
  if (process.env.GITHUB_ENV) {
    await fs.appendFile(
      process.env.GITHUB_ENV,
      `DATARAFT_POSITRON_EXECUTABLE=${executable}\n`,
    );
  }
  console.log(
    JSON.stringify({
      version: release.version,
      sha256: release.sha256,
      executable,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
