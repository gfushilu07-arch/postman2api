import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const contextDir = path.join(root, ".docker-context");
const serverSource = path.join(root, "dist");
const dashboardSource = path.join(root, "dashboard", "dist");
const docsSource = path.join(root, "docs");

if (!existsSync(path.join(serverSource, "index.js"))
  || !existsSync(path.join(serverSource, "db", "migrate.js"))
  || !existsSync(path.join(dashboardSource, "index.html"))) {
  throw new Error("Compiled artifacts are missing. Run `bun run build` before preparing Docker.");
}

rmSync(contextDir, { recursive: true, force: true });
mkdirSync(contextDir, { recursive: true });

// dist/dashboard/dist are release symlinks locally. realpathSync + cpSync
// snapshots their current targets so later local builds cannot mutate an image.
cpSync(realpathSync(serverSource), path.join(contextDir, "server"), {
  recursive: true,
  dereference: true,
});
cpSync(realpathSync(dashboardSource), path.join(contextDir, "dashboard"), {
  recursive: true,
  dereference: true,
});
cpSync(docsSource, path.join(contextDir, "docs"), { recursive: true });

console.log(`[docker] Prepared immutable compiled snapshot at ${path.relative(root, contextDir)}`);
