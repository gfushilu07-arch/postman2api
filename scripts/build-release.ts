import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const releaseId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
const releasesDir = path.join(root, ".releases");
const releaseDir = path.join(releasesDir, releaseId);
const dashboardOut = path.join(releaseDir, "dashboard");
const serverOut = path.join(releaseDir, "server");

mkdirSync(dashboardOut, { recursive: true });
mkdirSync(serverOut, { recursive: true });

async function run(command: string[], cwd = root): Promise<void> {
  console.log(`[build] ${command.join(" ")}`);
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}

function activateLink(linkPath: string, target: string): void {
  const parent = path.dirname(linkPath);
  const temporary = path.join(parent, `.${path.basename(linkPath)}.next-${process.pid}`);
  rmSync(temporary, { force: true, recursive: true });
  symlinkSync(target, temporary, "dir");

  try {
    const current = lstatSync(linkPath);
    if (current.isSymbolicLink()) {
      renameSync(temporary, linkPath);
      return;
    }

    const backup = `${linkPath}.pre-release-${Date.now()}`;
    renameSync(linkPath, backup);
    renameSync(temporary, linkPath);
    rmSync(backup, { force: true, recursive: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    renameSync(temporary, linkPath);
  }
}

function pruneReleases(): void {
  const currentServerTarget = (() => {
    try {
      return path.resolve(root, readlinkSync(path.join(root, "dist")));
    } catch {
      return "";
    }
  })();
  const entries = readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const stale of entries.slice(5)) {
    const staleDir = path.join(releasesDir, stale);
    if (currentServerTarget.startsWith(staleDir + path.sep)) continue;
    rmSync(staleDir, { recursive: true, force: true });
  }
}

try {
  await run(["bunx", "vite", "build", "--outDir", dashboardOut, "--emptyOutDir"], path.join(root, "dashboard"));
  await run([
    "bun", "build", "src/index.ts", "src/db/migrate.ts",
    "--outdir", serverOut, "--target", "bun", "--packages", "external",
  ]);

  activateLink(path.join(root, "dashboard", "dist"), path.relative(path.join(root, "dashboard"), dashboardOut));
  activateLink(path.join(root, "dist"), path.relative(root, serverOut));
  pruneReleases();
  console.log(`[build] Activated immutable release ${releaseId}`);
} catch (error) {
  rmSync(releaseDir, { recursive: true, force: true });
  throw error;
}
