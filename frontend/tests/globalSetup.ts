import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const PORT = 3200;
const backendDir = fileURLToPath(new URL("../../backend/", import.meta.url));
let server: ChildProcess | undefined;
const databaseUrl = process.env.FRONTEND_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Set FRONTEND_TEST_DATABASE_URL to a dedicated PostgreSQL database ending in _test.");
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(?:^|[_-])test$/i.test(databaseName)) {
  throw new Error("Frontend tests require a dedicated database name ending in _test.");
}
if (process.env.DATABASE_URL) {
  const runtime = new URL(process.env.DATABASE_URL);
  const test = new URL(databaseUrl);
  const target = (url: URL) =>
    `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
  if (target(runtime) === target(test)) {
    throw new Error("FRONTEND_TEST_DATABASE_URL must be different from DATABASE_URL.");
  }
}

const env = {
  ...process.env,
  APP_ENV: "development",
  COOKIE_SECURE: "false",
  CORS_ORIGINS: "http://localhost:5173",
  DATABASE_URL: databaseUrl,
  PORT: String(PORT),
  SESSION_SECRET: "frontend-test-only-secret-do-not-use-in-production",
};

function runPython(args: string[]): void {
  const result = spawnSync(process.env.PYTHON ?? "python", args, {
    cwd: backendDir,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function ensurePortAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => {
      reject(new Error(`Frontend test API port ${PORT} is already in use; stop that process and retry.`));
    });
    probe.listen(PORT, "127.0.0.1", () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

async function stopServer(): Promise<void> {
  const child = server;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
    child.kill();
  });
}

export async function setup() {
  await ensurePortAvailable();
  runPython(["-m", "alembic", "upgrade", "head"]);
  runPython(["-m", "app.seed"]);
  server = spawn(
    process.env.PYTHON ?? "python",
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: backendDir, env, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await stopServer();
  throw new Error("FastAPI test server did not become healthy.");
}

export async function teardown() {
  await stopServer();
}
