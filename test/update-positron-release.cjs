// Explicit maintenance command. Never called automatically by CI.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

async function main() {
  const version = process.argv[2];
  assert.match(
    version || "",
    /^\d{4}\.\d{2}\.\d+-\d+$/,
    "Supply an explicit stable release, e.g. 2026.09.1-2",
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "dataraft-positron-pin-"),
  );
  const download = (url, output) =>
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
        output,
        url,
      ],
      { stdio: "inherit" },
    );
  try {
    const checksums_url = `https://cdn.posit.co/positron/releases/checksums/positron-${version}-checksums.json`;
    const checksums = path.join(directory, "checksums.json");
    download(checksums_url, checksums);
    const filename = `Positron-${version}-x64.deb`;
    const sha256 = JSON.parse(await fs.readFile(checksums, "utf8"))[filename];
    assert.match(
      sha256 || "",
      /^[a-f0-9]{64}$/,
      "Official manifest must contain the desktop Debian artifact",
    );
    const url = `https://cdn.posit.co/positron/releases/deb/x86_64/${filename}`;
    const archive = path.join(directory, filename);
    download(url, archive);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    assert.equal(
      hash.digest("hex"),
      sha256,
      "Official SHA256 must match before extraction",
    );
    const field = (name) =>
      execFileSync("dpkg-deb", ["--field", archive, name], {
        encoding: "utf8",
      }).trim();
    assert.equal(field("Package"), "positron");
    assert.equal(field("Architecture"), "amd64");
    const extracted = path.join(directory, "extracted");
    execFileSync("dpkg-deb", ["--extract", archive, extracted]);
    const app = path.join(extracted, "usr/share/positron");
    const product = JSON.parse(
      await fs.readFile(path.join(app, "resources/app/product.json"), "utf8"),
    );
    assert.equal(
      `${product.positronVersion}-${product.positronBuildNumber}`,
      version,
    );
    assert.match(product.commit, /^[a-f0-9]{40}$/);
    const release = {
      version,
      source_commit: product.commit,
      release_url: `https://github.com/posit-dev/positron/releases/tag/${version}`,
      checksums_url,
      url,
      sha256,
      deb_version: field("Version"),
      architecture: field("Architecture"),
      executable_size: (await fs.stat(path.join(app, "positron"))).size,
    };
    await fs.writeFile(
      path.join(__dirname, "positron-release.json"),
      JSON.stringify(release, null, 2) + "\n",
    );
    console.log(
      `Updated explicit Positron pin to ${version}; review the diff and run all CI jobs.`,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
