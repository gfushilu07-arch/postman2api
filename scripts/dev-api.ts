const rootDir = `${import.meta.dir}/..`;
const devApiPort = Bun.env.DEV_API_PORT || "1932";

const apiEnv = Object.fromEntries(
  Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
apiEnv.PORT = devApiPort;
apiEnv.NODE_ENV = "development";

const api = Bun.spawn(["bun", "--watch", "src/index.ts"], {
  cwd: rootDir,
  env: apiEnv,
  stdout: "inherit",
  stderr: "inherit",
});

const stop = () => api.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

process.exit(await api.exited);
