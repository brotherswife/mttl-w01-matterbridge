import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { deviceNameFromMac } from "./mttl-protocol.js";

export interface RegisteredPowerStrip {
  id: string;
  name?: string;
  serialNumber?: string;
  firmwareVersion?: string;
}

interface RegistryFile {
  version: 1;
  devices: RegisteredPowerStrip[];
}

/** Atomic local registry used to rebuild Matter endpoints before devices reconnect. */
export class DeviceRegistry {
  private readonly devices = new Map<string, RegisteredPowerStrip>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly legacyMatterStoragePath?: string,
  ) {}

  async load(): Promise<RegisteredPowerStrip[]> {
    if (this.loaded) return this.list();

    let records: RegisteredPowerStrip[];
    try {
      const raw = await readFile(this.filePath, "utf8");
      records = parseRegistry(raw, this.filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      records = await discoverLegacyMatterDevices(this.legacyMatterStoragePath);
    }

    const loadedDevices = new Map<string, RegisteredPowerStrip>();
    for (const record of records) {
      const normalized = normalizeRecord(record);
      if (loadedDevices.has(normalized.id)) {
        throw new Error(`Duplicate device '${normalized.id}' in ${this.filePath}.`);
      }
      loadedDevices.set(normalized.id, normalized);
    }
    for (const [id, record] of loadedDevices) this.devices.set(id, record);
    this.loaded = true;

    // Create the registry immediately, including an intentionally empty registry.
    // This ensures legacy endpoint discovery is only ever performed once.
    try {
      await this.persist();
    } catch (error) {
      this.loaded = false;
      this.devices.clear();
      throw error;
    }
    return this.list();
  }

  list() {
    this.requireLoaded();
    return [...this.devices.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(record => ({ ...record }));
  }

  upsert(record: RegisteredPowerStrip) {
    this.requireLoaded();
    const normalized = normalizeRecord(record);
    return this.enqueueWrite(async () => {
      const previous = this.devices.get(normalized.id);
      this.devices.set(normalized.id, normalized);
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.devices.set(normalized.id, previous);
        else this.devices.delete(normalized.id);
        throw error;
      }
    });
  }

  remove(id: string) {
    this.requireLoaded();
    return this.enqueueWrite(async () => {
      const previous = this.devices.get(id);
      if (!previous) return;
      this.devices.delete(id);
      try {
        await this.persist();
      } catch (error) {
        this.devices.set(id, previous);
        throw error;
      }
    });
  }

  private requireLoaded() {
    if (!this.loaded) throw new Error("Device registry must be loaded before use.");
  }

  private enqueueWrite(operation: () => Promise<void>) {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  private async persist() {
    const data: RegistryFile = { version: 1, devices: this.list() };
    const directory = dirname(this.filePath);
    const temporaryPath = join(
      directory,
      `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function parseRegistry(raw: string, filePath: string): RegisteredPowerStrip[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid device registry JSON at ${filePath}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error(`Invalid device registry format at ${filePath}.`);
  }
  return parsed.devices.map(record => normalizeRecord(record));
}

async function discoverLegacyMatterDevices(storagePath?: string) {
  if (!storagePath) return [];

  let fileNames: string[];
  try {
    fileNames = await readdir(storagePath);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const prefix = "root.parts.aggregator.parts.strip-";
  const suffix = ".__number__";
  const records: RegisteredPowerStrip[] = [];
  for (const fileName of fileNames) {
    if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) continue;
    const id = fileName.slice(prefix.length, -suffix.length);
    if (!isValidId(id)) continue;
    const isMac = /^[0-9a-fA-F]{12}$/.test(id);
    records.push({
      id,
      ...(isMac
        ? {
            name: deviceNameFromMac(id),
            serialNumber: id.toUpperCase(),
          }
        : {}),
    });
  }
  return records;
}

function normalizeRecord(value: unknown): RegisteredPowerStrip {
  if (!isObject(value) || typeof value.id !== "string" || !isValidId(value.id)) {
    throw new Error("Device registry contains an invalid device ID.");
  }

  return {
    id: value.id,
    ...optionalString(value, "name", 128),
    ...optionalString(value, "serialNumber", 128),
    ...optionalString(value, "firmwareVersion", 128),
  };
}

function optionalString(
  value: Record<string, unknown>,
  key: "name" | "serialNumber" | "firmwareVersion",
  maxLength: number,
) {
  const field = value[key];
  if (field === undefined) return {};
  if (typeof field !== "string" || field.length === 0 || field.length > maxLength) {
    throw new Error(`Device registry contains an invalid '${key}'.`);
  }
  return { [key]: field };
}

function isValidId(id: string) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
