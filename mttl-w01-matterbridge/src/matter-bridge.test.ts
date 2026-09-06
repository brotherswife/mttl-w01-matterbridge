import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Environment } from "@matter/main";
import { MockStorageService } from "@matter/general";
import { DeviceRegistry } from "./device-registry.js";
import { MatterPowerStripBridge } from "./matter-bridge.js";

test("only deletes offline devices and persists removal across registry reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mttl-delete-"));
  const registry = new DeviceRegistry(join(directory, "devices.json"));
  await registry.load();
  const environment = new Environment("matter-delete-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({ environment, matterPort: 0, registry });
  try {
    await bridge.addPowerStrip({ id: "DELETE_TEST" });
    await assert.rejects(bridge.removePowerStrip("DELETE_TEST"), /온라인 기기는 삭제할 수 없습니다/);
    assert.equal(bridge.listDevices().length, 1);
    assert.equal(registry.list().length, 1);

    await bridge.setReachable("DELETE_TEST", false);
    await bridge.removePowerStrip("DELETE_TEST");
    assert.deepEqual(bridge.listDevices(), []);
    assert.deepEqual(await new DeviceRegistry(registry.filePath).load(), []);
    await assert.rejects(bridge.removePowerStrip("DELETE_TEST"), /not found/);

    await bridge.addPowerStrip({ id: "DELETE_TEST" });
    assert.equal(bridge.getDevice("DELETE_TEST").reachable, true);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes Matter outlet commands to the physical-device handler", async () => {
  const environment = new Environment("matter-command-test", Environment.default);
  new MockStorageService(environment);
  const commands: Array<[string, number, boolean]> = [];
  const bridge = await MatterPowerStripBridge.create({
    environment,
    matterPort: 0,
    onOutletCommand: async (id, outlet, on) => {
      commands.push([id, outlet, on]);
    },
  });

  try {
    await bridge.addPowerStrip({ id: "TEST" });
    await bridge.setOutlet("TEST", 2, true);

    assert.deepEqual(commands, [["TEST", 2, true]]);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, true);

    await bridge.setOutlet("TEST", 2, false);
    assert.deepEqual(commands, [
      ["TEST", 2, true],
      ["TEST", 2, false],
    ]);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, false);

    await bridge.syncOutletState("TEST", 2, true);
    assert.equal(commands.length, 2);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, true);
  } finally {
    await bridge.close();
  }
});

test("rolls Matter state back when the physical command fails", async () => {
  const environment = new Environment("matter-command-failure-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({
    environment,
    matterPort: 0,
    onOutletCommand: async () => {
      throw new Error("device offline");
    },
  });

  try {
    await bridge.addPowerStrip({ id: "TESTFAIL" });
    await assert.rejects(
      bridge.setOutlet("TESTFAIL", 1, true),
      /device offline/,
    );
    assert.equal(bridge.getDevice("TESTFAIL").outlets[0].on, false);
  } finally {
    await bridge.close();
  }
});


test("restored offline devices publish Matter reachability changes on reconnect", async () => {
  const environment = new Environment("matter-reachability-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({ environment, matterPort: 0 });
  try {
    await bridge.addPowerStrip({ id: "REACHABLE_TEST", reachable: false });
    const container = bridge["devices"].get("REACHABLE_TEST")!.container;
    const reports: boolean[] = [];
    container.events.bridgedDeviceBasicInformation.reachableChanged.on(
      (event: { reachableNewValue: boolean }) => { reports.push(event.reachableNewValue); },
    );
    assert.equal(container.state.bridgedDeviceBasicInformation.reachable, false);
    await bridge.setReachable("REACHABLE_TEST", true);
    await bridge.setReachable("REACHABLE_TEST", false);
    await bridge.setReachable("REACHABLE_TEST", true);
    assert.equal(container.state.bridgedDeviceBasicInformation.reachable, true);
    assert.equal(bridge.getDevice("REACHABLE_TEST").reachable, true);
    assert.deepEqual(reports, [true, false, true]);
  } finally {
    await bridge.close();
  }
});
