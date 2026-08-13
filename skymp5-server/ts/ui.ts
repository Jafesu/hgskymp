const Koa = require("koa");
const serve = require("koa-static");
const proxy = require("koa-proxy");
const Router = require("koa-router");
const auth = require("koa-basic-auth");
import * as koaBody from "koa-body";
import * as http from "http";
import { Settings } from "./settings";
import Axios from "axios";
import { AddressInfo } from "net";
import { register, getAggregatedMetrics, rpcCallsCounter, rpcDurationHistogram } from "./systems/metricsSystem";

let gScampServer: any = null;

let metricsAuth: { user: string; password: string } | null = null;

// Advertised on the unauthenticated /api/status so a launcher can poll a
// server directly, without a registry in between. Nothing here is sensitive:
// it is the same information a server publishes to be listed at all.
let publicInfo: { name: string; maxPlayers: number } = { name: "", maxPlayers: 0 };

const countOnlinePlayers = (): number => {
  try {
    return gScampServer.get(0, "onlinePlayers").length;
  } catch {
    // Before the world is ready, or if the binding is unavailable
    return 0;
  }
};

const metricsAuthParse = (settings: Settings): void => {
  const authConfig = settings.allSettings?.metricsAuth as { user?: string; password?: string } | undefined;
  if (!authConfig) {
    console.log('Metrics auth is not configured, so it will be inaccessible. Set metricsAuth setting to activate');
    return;
  }
  if (!authConfig.user || !authConfig.password) {
    console.error('metricsAuth setting must contain user and password fields');
    return;
  }
  metricsAuth = { user: authConfig.user, password: authConfig.password };
}

const createApp = (getOriginPort: () => number) => {
  const app = new Koa();
  app.use(koaBody.default({ multipart: true }));

  app.use(async (ctx: any, next: any) => {
    try {
      await next();
    } catch (err: any) {
      if (401 === err.status) {
        ctx.status = 401;
        ctx.set("WWW-Authenticate", "Basic realm=\"metrics\"");
      } else {
        throw err;
      }
    }
  });

  const router = new Router();
  router.get(new RegExp("/scripts/.*"), (ctx: any) => ctx.throw(403));
  router.get(new RegExp("\.es[mpl]"), (ctx: any) => ctx.throw(403));
  router.get(new RegExp("\.bsa"), (ctx: any) => ctx.throw(403));

  // Unauthenticated on purpose: a launcher polls this to show a server's live
  // state, and to decide whether it is up at all. Metrics stay behind auth.
  router.get("/api/status", (ctx: any) => {
    ctx.body = {
      name: publicInfo.name,
      players: countOnlinePlayers(),
      maxPlayers: publicInfo.maxPlayers,
    };
  });

  router.post("/rpc/:rpcClassName", (ctx: any) => {
    const { rpcClassName } = ctx.params;
    const { payload } = ctx.request.body;

    rpcCallsCounter.inc({ rpcClassName });
    const endTimer = rpcDurationHistogram.startTimer({ rpcClassName });

    try {
      if (gScampServer.onHttpRpcRunAttempt) {
        ctx.body = gScampServer.onHttpRpcRunAttempt(rpcClassName, payload);
      }
    } finally {
      endTimer();
    }
  });

  router.use('/metrics', (ctx: any, next: any) => {
    console.log(`Metrics requested by ${ctx.request.ip}`);
    return next();
  });

  if (metricsAuth) {
    if (metricsAuth.password !== "I know what I'm doing, disable metrics auth") {
      router.use("/metrics", auth({ name: metricsAuth.user, pass: metricsAuth.password }));
    }
    router.get("/metrics", async (ctx: any) => {
      ctx.set("Content-Type", register.contentType);
      ctx.body = await getAggregatedMetrics(gScampServer);
    });
  } else {
    router.get("/metrics", async (ctx: any) => {
      ctx.throw(401);
      console.error("Metrics endpoint is protected by authentication, but no credentials are configured");
    });
  }

  app.use(router.routes()).use(router.allowedMethods());
  app.use(serve("data"));
  return app;
};

export const setServer = (scampServer: any) => {
  gScampServer = scampServer;
};

// Explicit uiPort wins; otherwise keep the legacy 7777 -> 3000, else port + 1 mapping.
// Orchestrators hand out arbitrary allocations and cannot guarantee port + 1 is free.
export const resolveUiPort = (settings: Settings): number => {
  const derived = settings.port === 7777 ? 3000 : settings.port + 1;
  const raw = settings.allSettings?.uiPort;

  if (raw === undefined || raw === null || raw === "") {
    return derived;
  }

  const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Ignoring invalid uiPort ${JSON.stringify(raw)}, using ${derived}`);
    return derived;
  }

  if (parsed === settings.port) {
    console.error(`uiPort ${parsed} collides with the game port, using ${derived}`);
    return derived;
  }

  return parsed;
};

export const main = (settings: Settings): void => {
  metricsAuthParse(settings);
  publicInfo = { name: settings.name, maxPlayers: settings.maxPlayers };
  const devServerPort = 1234;

  const uiListenHost = settings.allSettings.uiListenHost as (string | undefined);
  const uiPort = resolveUiPort(settings);

  Axios({
    method: "get",
    url: `http://localhost:${devServerPort}`,
  })
    .then(() => {
      console.log(`UI dev server has been detected on port ${devServerPort}`);

      const state = { port: 0 };

      const appStatic = createApp(() => state.port);
      const srv = http.createServer(appStatic.callback());
      srv.listen(0, () => {
        const { port } = srv.address() as AddressInfo;
        state.port = port;
        const appProxy = new Koa();
        appProxy.use(
          proxy({
            host: `http://localhost:${devServerPort}`,
            map: (path: string) => {
              const resultPath = path.match(/^\/ui\/.*/)
                ? `http://localhost:${devServerPort}` + path.substr(3)
                : `http://localhost:${port}` + path;
              console.log(`proxy ${path} => ${resultPath}`);
              return resultPath;
            },
          })
        );
        console.log(`Server resources folder is listening on ${uiPort}`);
        http.createServer(appProxy.callback()).listen(uiPort, uiListenHost);
      });
    })
    .catch(() => {
      const app = createApp(() => uiPort);
      console.log(`Server resources folder is listening on ${uiPort}`);
      const server = http.createServer(app.callback());
      server.listen(uiPort, uiListenHost);
    });
};
