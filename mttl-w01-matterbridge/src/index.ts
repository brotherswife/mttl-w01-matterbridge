import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DeviceRegistry } from "./device-registry.js";
import { startHttpApi } from "./http-api.js";
import { MatterPowerStripBridge } from "./matter-bridge.js";
import { TcpDeviceServer } from "./tcp-device-server.js";

const matterPort = envNumber("MATTER_PORT", 5540);
const httpPort = envNumber("HTTP_PORT", 8086);
const tcpPort = envNumber("TCP_PORT", 10086);
const registry = new DeviceRegistry(
  resolve(process.env.MTTL_DEVICE_REGISTRY_FILE ?? "data/devices.json"),
  join(homedir(), ".matter", "powerstrip-bridge"),
);
const registeredDevices = await registry.load();

let tcpServer: TcpDeviceServer;
const bridge = await MatterPowerStripBridge.create({
  matterPort,
  passcode: envNumber("MATTER_PASSCODE", 20202021),
  discriminator: envNumber("MATTER_DISCRIMINATOR", 3840),
  registry,
  onOutletCommand: async (deviceId, outlet, on) => {
    await tcpServer.setOutlet(deviceId, outlet, on);
  },
});

for (const device of registeredDevices) {
  await bridge.addPowerStrip({ ...device, reachable: false });
}
if (registeredDevices.length > 0) {
  console.log(
    `[Registry] restored ${registeredDevices.length} known device(s) as offline`,
  );
}

tcpServer = new TcpDeviceServer(bridge, {
  port: tcpPort,
  pollIntervalMs: envNumber("MTTL_POLL_INTERVAL_MS", 10_000),
  responseTimeoutMs: envNumber("MTTL_RESPONSE_TIMEOUT_MS", 3_000),
});

await bridge.start();
await tcpServer.start();

if (!bridge.server.lifecycle.isCommissioned) {
  const { manualPairingCode, qrPairingCode } =
    bridge.server.state.commissioning.pairingCodes;
  console.log(`[Matter] manual pairing code: ${manualPairingCode}`);
  console.log(`[Matter] QR payload: ${qrPairingCode}`);
} else {
  console.log("[Matter] bridge is already commissioned.");
}

const httpServer = startHttpApi(bridge, {
  port: httpPort,
  getConnections: () => tcpServer.listConnections(),
  setOutlet: (deviceId, outlet, on) => tcpServer.setOutlet(deviceId, outlet, on),
  queryDevice: deviceId => tcpServer.queryDevice(deviceId),
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down...`);
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
  await tcpServer.close();
  await bridge.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}
