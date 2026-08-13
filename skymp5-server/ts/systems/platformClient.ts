import { System, Log, SystemContext } from "./system";
import Axios from "axios";
import { ScampServer } from "../scampNative";
import * as fs from "fs";
import * as path from "path";

export interface PlatformSettings {
  // Backend base url, e.g. https://api.hardgaming.tech
  url?: string;
  // Stable id this server is listed under
  serverId?: string;
  // Bearer secret for POST /api/servers/register
  registrationKey?: string;
  // Address players connect to. The server cannot infer this: it sees a bind
  // address, not whatever NAT or DNS sits in front of it.
  publicHost?: string;
  // Port players connect to, when it differs from the bind port
  publicPort?: number;
  description?: string;
  heartbeatIntervalMs?: number;
}

/**
 * Registers this server with the platform backend and caches its modpack.
 *
 * Separate from MasterClient on purpose: that one speaks upstream's gateway
 * protocol, which puts the key in the url and is also what login.ts uses for
 * session validation. This talks to our own backend with bearer auth.
 *
 * The cached copy is written into dataDir, which the http port already serves,
 * so a launcher can fetch a server's modpack straight from the server. That
 * keeps direct connect working for unlisted servers and gives the launcher a
 * fallback when the backend is unreachable.
 */
export class PlatformClient implements System {
  systemName = "PlatformClient";

  constructor(
    private log: Log,
    private settings: PlatformSettings,
    private dataDir: string,
    private serverName: string,
    private maxPlayers: number,
    private gamePort: number
  ) {}

  async initAsync(): Promise<void> {
    const { url, serverId, registrationKey, publicHost } = this.settings;

    if (!url || !serverId) {
      this.log("PlatformClient: no platform url or serverId, not registering");
      return;
    }
    if (!registrationKey) {
      this.log("PlatformClient: platform.registrationKey missing, not registering");
      return;
    }
    if (!publicHost) {
      this.log("PlatformClient: platform.publicHost missing, not registering. " +
        "The server cannot infer the address players reach it on.");
      return;
    }

    this.enabled = true;
    this.registerUrl = `${url.replace(/\/+$/, "")}/api/servers/register`;
    this.modlistUrl = `${url.replace(/\/+$/, "")}/api/servers/${serverId}/modlist`;
    this.log(`PlatformClient: registering with ${this.registerUrl} as '${serverId}'`);

    await this.refreshModpack();
  }

  update(): void {
    return;
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, this.settings.heartbeatIntervalMs ?? 30000));
    if (!this.enabled) {
      return;
    }

    await this.heartbeat(ctx.svr);

    // Cheap relative to the heartbeat, and it keeps the served copy current
    // when an admin publishes a new pack.
    if (++this.ticksSinceModpack >= this.modpackEveryNTicks) {
      this.ticksSinceModpack = 0;
      await this.refreshModpack();
    }
  }

  customPacket(): void {
    return;
  }

  private async heartbeat(svr: ScampServer): Promise<void> {
    const { serverId, registrationKey, publicHost, publicPort, description } = this.settings;
    try {
      await Axios.post(
        this.registerUrl,
        {
          id: serverId,
          name: this.serverName,
          description: description ?? "",
          host: publicHost,
          port: publicPort ?? this.gamePort,
          maxPlayers: this.maxPlayers,
          players: this.getCurrentOnline(svr),
        },
        { headers: { Authorization: `Bearer ${registrationKey}` }, timeout: 10000 }
      );
      this.registerFailures = 0;
    } catch (e) {
      // A backend outage must never be fatal, and must not spam the log every
      // heartbeat: players can still connect to a server nobody listed.
      if (this.registerFailures === 0) {
        console.error(`PlatformClient: registration failed, will keep retrying: ${e}`);
      }
      this.registerFailures++;
    }
  }

  /** Cache the published modpack into dataDir so the http port serves it. */
  private async refreshModpack(): Promise<void> {
    try {
      const res = await Axios.get(this.modlistUrl, { timeout: 10000 });
      const target = path.join(this.dataDir, "modpack.json");
      const body = JSON.stringify(res.data, null, 2) + "\n";

      // Skip an identical write so the file's mtime stays meaningful
      try {
        if (fs.readFileSync(target, "utf8") === body) return;
      } catch {
        // not written yet
      }

      // Rename so a launcher polling this never reads a half-written file
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
      this.log(`PlatformClient: cached modpack version ${(res.data as any)?.version}`);
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 404) {
        // Normal for a server whose admin has not published a pack yet
        return;
      }
      if (this.modpackFailures === 0) {
        console.error(`PlatformClient: could not fetch the modpack: ${e}`);
      }
      this.modpackFailures++;
    }
  }

  private getCurrentOnline(svr: ScampServer): number {
    try {
      return (svr as any).get(0, "onlinePlayers").length;
    } catch {
      return 0;
    }
  }

  private enabled = false;
  private registerUrl = "";
  private modlistUrl = "";
  private registerFailures = 0;
  private modpackFailures = 0;
  private ticksSinceModpack = 0;
  // At the default 30s heartbeat this re-checks the pack about every 5 minutes
  private readonly modpackEveryNTicks = 10;
}
