import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import test from "node:test";
import type { MatterPowerStripBridge } from "./matter-bridge.js";
import { TcpDeviceServer } from "./tcp-device-server.js";

test("getinfo timeout disconnects an unresponsive device and reconnect restores reachability", { timeout: 5_000 }, async () => {
  const mac = "2CFDB3C1DEAF";
  let registered = false;
  const reachability: boolean[] = [];
  let offline!: () => void;
  const wentOffline = new Promise<void>(resolve => { offline = resolve; });
  const bridge = {
    hasDevice: () => registered,
    addPowerStrip: async () => { registered = true; },
    setFirmwareVersion: async () => {},
    setReachable: async (id: string, reachable: boolean) => {
      assert.equal(id, mac);
      reachability.push(reachable);
      if (!reachable) offline();
    },
  } as unknown as MatterPowerStripBridge;
  const server = new TcpDeviceServer(bridge, {
    port: 0, host: "127.0.0.1", pollIntervalMs: 60_000, responseTimeoutMs: 100,
  });
  await server.start();
  const port = (server["server"].address() as AddressInfo).port;
  const socket = connect(port, "127.0.0.1");
  let reconnected: ReturnType<typeof connect> | undefined;
  const boot = `up:bootinfo:lgutap;${mac};${mac};1.0.110;connect\r\n`;
  try {
    await once(socket, "connect");
    const query = once(socket, "data");
    const closed = once(socket, "close");
    socket.write(boot);
    assert.equal(String((await query)[0]), "up:getinfo:all\r\n");
    // Leave TCP open without replying: application timeout must detect this.
    await wentOffline;
    await closed;
    assert.deepEqual(reachability, [false]);
    assert.deepEqual(server.listConnections(), []);
    await assert.rejects(server.queryDevice(mac), /offline/);

    reconnected = connect(port, "127.0.0.1");
    await once(reconnected, "connect");
    const nextQuery = once(reconnected, "data");
    reconnected.write(boot);
    await nextQuery;
    assert.deepEqual(reachability, [false, true]);
    assert.equal(server.listConnections()[0].mac, mac);
  } finally {
    socket.destroy();
    reconnected?.destroy();
    await server.close();
  }
});

test("ignores frames before bootinfo and handles events after registration", { timeout: 5_000 }, async () => {
  const mac = "2CFDB3C1DEAF";
  const registrations: string[] = [];
  const updates: Array<[string, number, boolean]> = [];
  let updated!: () => void;
  const updateReceived = new Promise<void>(resolve => { updated = resolve; });
  const bridge = {
    hasDevice: () => registrations.length > 0,
    getDevice: () => ({ reachable: true }),
    addPowerStrip: async ({ id }: { id: string }) => { registrations.push(id); },
    setReachable: async () => {},
    syncOutletState: async (id: string, outlet: number, on: boolean) => {
      updates.push([id, outlet, on]);
      updated();
    },
  } as unknown as MatterPowerStripBridge;
  const server = new TcpDeviceServer(bridge, { port: 0, host: "127.0.0.1", pollIntervalMs: 60_000 });
  await server.start();
  const socket = connect((server["server"].address() as AddressInfo).port, "127.0.0.1");
  try {
    await once(socket, "connect");
    const query = once(socket, "data");
    socket.write(
      "up:event:onoff:1:off\r\nup:event:onoff:4:off\r\n" +
      "up:event:onoff:3:on\r\nup:event:onoff:2:on\r\nunknown\r\n" +
      `up:bootinfo:lgutap;${mac};${mac};1.0.110;connect\r\n`,
    );
    assert.equal(String((await query)[0]), "up:getinfo:all\r\n");
    assert.deepEqual(registrations, [mac]);
    assert.deepEqual(updates, []);
    assert.equal(server.listConnections()[0].mac, mac);

    socket.write("up:event:onoff:2:on\r\n");
    await updateReceived;
    assert.deepEqual(updates, [[mac, 2, true]]);
  } finally {
    socket.destroy();
    await server.close();
  }
});


test("ACKs bypass blocked telemetry, queries coalesce, and controls precede queued queries", { timeout: 5_000 }, async () => {
  const mac = "2CFDB3C1DEAF";
  const info = "up:getinfo:" + [1, 2, 3, 4].map(i =>
    `${i}:0;off;3;on;on;0;00000000;00000000;00000000;off;00;25`,
  ).join(":");
  let release!: () => void;
  const locked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const syncing = new Promise<void>(resolve => { started = resolve; });
  const states: string[] = [];
  const bridge = {
    hasDevice: () => true,
    setFirmwareVersion: async () => {},
    setReachable: async () => {},
    getDevice: () => ({ id: mac }),
    updateTelemetry: async () => { started(); await locked; states.push("info"); },
    syncOutletState: async (_id: string, outlet: number, on: boolean) => {
      states.push(`${outlet}:${on}`);
    },
  } as unknown as MatterPowerStripBridge;
  const server = new TcpDeviceServer(bridge, {
    port: 0, host: "127.0.0.1", pollIntervalMs: 60_000,
  });
  await server.start();
  const socket = connect((server["server"].address() as AddressInfo).port, "127.0.0.1");
  const commands: string[] = [];
  let buffer = "";
  let held!: () => void;
  const commandHeld = new Promise<void>(resolve => { held = resolve; });
  socket.on("data", chunk => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const command = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      commands.push(command);
      if (command === "up:onoff:2:on") held();
      else socket.write((command === "up:getinfo:all" ? info : command) + "\r\n");
    }
  });
  try {
    await once(socket, "connect");
    socket.write(`up:bootinfo:lgutap;${mac};${mac};1;connect\r\n`);
    await syncing;
    const firstRefresh = server.queryDevice(mac);
    const duplicate = server.queryDevice(mac);
    // Models a Matter command holding the transaction needed by telemetry.
    await server.setOutlet(mac, 1, true);
    assert.deepEqual(states, []);
    assert.deepEqual(commands, ["up:getinfo:all", "up:onoff:1:on"]);
    release();
    await Promise.all([firstRefresh, duplicate]);
    const state = server["connections"].get(mac)!;
    await state.syncChain;
    assert.deepEqual(states, ["info", "1:true"]);

    const control1 = server.setOutlet(mac, 2, true);
    await commandHeld;
    const refresh = server.queryDevice(mac);
    const refreshAgain = server.queryDevice(mac);
    const control2 = server.setOutlet(mac, 3, true);
    socket.write("up:onoff:2:on\r\n");
    await Promise.all([control1, control2, refresh, refreshAgain]);
    assert.deepEqual(commands.slice(2), ["up:onoff:2:on", "up:onoff:3:on", "up:getinfo:all"]);
  } finally {
    release();
    socket.destroy();
    await server.close();
  }
});


test("a delayed disconnect cannot overwrite a replacement connection and valid events recover reachability", { timeout: 5_000 }, async () => {
  const mac = "2CFDB3C1DEAF";
  let reachable = true;
  let offlineStarted!: () => void;
  const offlineWriting = new Promise<void>(resolve => { offlineStarted = resolve; });
  let releaseOffline!: () => void;
  const offlineGate = new Promise<void>(resolve => { releaseOffline = resolve; });
  let eventSynced!: () => void;
  const synced = new Promise<void>(resolve => { eventSynced = resolve; });
  const changes: boolean[] = [];
  const bridge = {
    hasDevice: () => true,
    getDevice: () => ({ reachable }),
    setFirmwareVersion: async () => {},
    setReachable: async (_id: string, value: boolean) => {
      if (!value) { offlineStarted(); await offlineGate; }
      reachable = value;
      changes.push(value);
    },
    syncOutletState: async () => { eventSynced(); },
  } as unknown as MatterPowerStripBridge;
  const server = new TcpDeviceServer(bridge, { port: 0, host: "127.0.0.1", pollIntervalMs: 60_000 });
  await server.start();
  const port = (server["server"].address() as AddressInfo).port;
  const first = connect(port, "127.0.0.1");
  let second: ReturnType<typeof connect> | undefined;
  const boot = `up:bootinfo:lgutap;${mac};${mac};1;connect\r\n`;
  try {
    await once(first, "connect");
    const query = once(first, "data");
    first.write(boot);
    await query;
    first.destroy();
    await offlineWriting;
    second = connect(port, "127.0.0.1");
    await once(second, "connect");
    const nextQuery = once(second, "data");
    second.write(boot);
    // Wait until the new boot frame has entered the registration queue.
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    releaseOffline();
    await nextQuery;
    await server["registrationChain"];
    assert.deepEqual(changes, [true, false, true]);
    assert.equal(reachable, true);
    assert.equal(server.listConnections().length, 1);

    // A stale offline attribute must heal on a valid physical-device response.
    reachable = false;
    second.write("up:event:onoff:1:on\r\n");
    await synced;
    assert.equal(reachable, true);
  } finally {
    releaseOffline();
    first.destroy();
    second?.destroy();
    await server.close();
  }
});
