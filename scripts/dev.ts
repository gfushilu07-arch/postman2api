const rootDir = `${import.meta.dir}/..`;
const dashboardDir = `${rootDir}/dashboard`;
const devApiPort = Bun.env.DEV_API_PORT || "1932";

const apiEnv = Object.fromEntries(
  Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
apiEnv.PORT = devApiPort;

const api = Bun.spawn(["bun", "--watch", "src/index.ts"], {
  cwd: rootDir,
  env: apiEnv,
  stdout: "inherit",
  stderr: "inherit",
});

const dashboard = Bun.spawn(["bun", "run", "dev"], {
  cwd: dashboardDir,
  stdout: "inherit",
  stderr: "inherit",
});

let shuttingDown = false;
function stopChildren(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  api.kill("SIGTERM");
  dashboard.kill("SIGTERM");
}

process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

const firstExit = await Promise.race([
  api.exited.then((code) => ({ name: "api", code })),
  dashboard.exited.then((code) => ({ name: "dashboard", code })),
]);

stopChildren();
await Promise.all([api.exited, dashboard.exited]);

if (firstExit.code !== 0) {
  console.error(`[postman2api] Development ${firstExit.name} process exited with code ${firstExit.code}`);
}
process.exit(firstExit.code);
