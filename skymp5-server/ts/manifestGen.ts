import { Settings } from "./settings";
import * as crc32 from "crc-32";
import * as path from "path";
import * as fs from "fs";

interface ManifestModEntry {
  filename: string;
  crc32: number;
  size: number;
}

interface Manifest {
  versionMajor: number;
  // Plugins only, in load order. The client builds its comparison list from
  // Game.getModCount/getModName, which enumerates plugins and nothing else,
  // and loadOrderVerificationService compares the two index by index. Anything
  // in here that the client cannot enumerate shifts every later index and
  // blocks every player with an error that points nowhere near the cause.
  mods: Array<ManifestModEntry>;
  // Archives found beside those plugins, kept separate for the same reason.
  archives: Array<ManifestModEntry>;
  loadOrder: Array<string>;
}

const getBsaNameByEspmName = (espmName: string) => {
  if (espmName.endsWith(".esp") || espmName.endsWith(".esm")) {
    const nameNoExt = espmName.split(".").slice(0, -1).join(".");
    return nameNoExt + ".bsa";
  }
  throw new Error(`'${espmName}' is not a valid esp or esm name`);
};

export const generateManifest = (settings: Settings): void => {
  const manifest: Manifest = {
    mods: [],
    archives: [],
    versionMajor: 1,
    loadOrder: settings.loadOrder.map(x => path.basename(x)),
  };

  settings.loadOrder.forEach((loadOrderElement) => {
    const espmName = path.isAbsolute(loadOrderElement)
      ? path.basename(loadOrderElement)
      : loadOrderElement;

    const espmPath = path.isAbsolute(loadOrderElement)
      ? loadOrderElement
      : path.join(settings.dataDir, espmName);

    const buf: Uint8Array = fs.readFileSync(espmPath);
    manifest.mods.push({
      crc32: crc32.buf(buf),
      filename: espmName,
      size: buf.length,
    });

    const bsaName = getBsaNameByEspmName(espmName);
    const bsaPath = path.join(settings.dataDir, bsaName);
    if (fs.existsSync(bsaPath)) {
      const buf: Uint8Array = fs.readFileSync(bsaPath);
      manifest.archives.push({
        crc32: crc32.buf(buf),
        filename: bsaName,
        size: buf.length,
      });
    }
  });

  const manifestPath = path.join(settings.dataDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
};
