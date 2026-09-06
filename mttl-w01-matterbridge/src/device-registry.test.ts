import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceRegistry } from "./device-registry.js";

test("persists registered devices and reloads them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mttl-registry-"));
  try {
    const filePath = join(directory, "data", "devices.json");
    const registry = new DeviceRegistry(filePath);
    assert.deepEqual(await registry.load(), []);

    await Promise.all([
      registry.upsert({
        id: "2CFDB3C1DEAF",
        name: "MTTL 3C1DEAF",
        serialNumber: "2CFDB3C1DEAF",
        firmwareVersion: "1.2.3",
      }),
      registry.upsert({ id: "88D039416534", name: "Living room" }),
    ]);

    const reloaded = new DeviceRegistry(filePath);
    assert.deepEqual(await reloaded.load(), [
      {
        id: "2CFDB3C1DEAF",
        name: "MTTL 3C1DEAF",
        serialNumber: "2CFDB3C1DEAF",
        firmwareVersion: "1.2.3",
      },
      { id: "88D039416534", name: "Living room" },
    ]);

    await reloaded.remove("2CFDB3C1DEAF");
    assert.deepEqual((await new DeviceRegistry(filePath).load()).map(item => item.id), [
      "88D039416534",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports known endpoint IDs from Matter storage only on first load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mttl-legacy-"));
  try {
    const storagePath = join(directory, "matter");
    const filePath = join(directory, "registry", "devices.json");
    await mkdir(storagePath);
    await writeFile(
      join(
        storagePath,
        "root.parts.aggregator.parts.strip-2CFDB3C1DEAF.__number__",
      ),
      "3",
    );
    await writeFile(
      join(storagePath, "root.parts.aggregator.parts.strip-custom-strip.__number__"),
      "12",
    );
    await writeFile(join(storagePath, "unrelated"), "ignored");

    const registry = new DeviceRegistry(filePath, storagePath);
    assert.deepEqual(await registry.load(), [
      {
        id: "2CFDB3C1DEAF",
        name: "MTTL 3C1DEAF",
        serialNumber: "2CFDB3C1DEAF",
      },
      { id: "custom-strip" },
    ]);

    await registry.remove("custom-strip");
    assert.deepEqual(
      (await new DeviceRegistry(filePath, storagePath).load()).map(item => item.id),
      ["2CFDB3C1DEAF"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a corrupt registry without overwriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mttl-corrupt-"));
  try {
    const filePath = join(directory, "devices.json");
    await writeFile(filePath, "{broken", "utf8");
    await assert.rejects(new DeviceRegistry(filePath).load(), /Invalid device registry JSON/);
    assert.equal(await readFile(filePath, "utf8"), "{broken");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
