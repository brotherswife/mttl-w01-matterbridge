import { createServer, type Server, type Socket } from "node:net";
import type { MatterPowerStripBridge } from "./matter-bridge.js";
import {
  BOOTINFO_PREFIX,
  deviceNameFromMac,
  formatOnOff,
  GETINFO_REQUEST,
  parseBootInfo,
  parseGetInfo,
  parseOnOff,
} from "./mttl-protocol.js";
import { appendCrLfFrames, MttlFrameAssembler } from "./tcp-framing.js";

interface PendingResponse {
  predicate: (frame: string) => boolean;
  resolve: (frame: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ConnectionState {
  socket: Socket;
  buffer: string;
  frameAssembler: MttlFrameAssembler;
  bootTimer: NodeJS.Timeout;
  mac?: string;
  version?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastInfoAt?: string;
  pending: Set<PendingResponse>;
  frameChain: Promise<void>;
  commandChain: Promise<unknown>;
  syncChain: Promise<void>;
  queryInFlight?: Promise<unknown>;
}

export interface TcpDeviceServerOptions {
  port?: number;
  host?: string;
  pollIntervalMs?: number;
  responseTimeoutMs?: number;
  bootTimeoutMs?: number;
}

export class TcpDeviceServer {
  private readonly server: Server;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly sockets = new Set<ConnectionState>();
  private readonly options: Required<TcpDeviceServerOptions>;
  private pollTimer?: NodeJS.Timeout;
  private registrationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly bridge: MatterPowerStripBridge,
    options: TcpDeviceServerOptions = {},
  ) {
    this.options = {
      port: options.port ?? 10086,
      host: options.host ?? "0.0.0.0",
      pollIntervalMs: options.pollIntervalMs ?? 10_000,
      responseTimeoutMs: options.responseTimeoutMs ?? 3_000,
      bootTimeoutMs: options.bootTimeoutMs ?? 10_000,
    };
    this.server = createServer(socket => this.accept(socket));
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    this.pollTimer = setInterval(() => this.pollAll(), this.options.pollIntervalMs);
    this.pollTimer.unref();
    console.log(
      `[TCP] MTTL device server listening on ${this.options.host}:${this.options.port}`,
    );
  }

  async close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const state of this.sockets) state.socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close(error => (error ? reject(error) : resolve())),
    );
  }

  listConnections() {
    return [...this.connections.entries()].map(([mac, state]) => ({
      mac,
      firmwareVersion: state.version,
      remoteAddress: formatRemoteAddress(state.socket),
      connectedAt: state.connectedAt,
      lastSeenAt: state.lastSeenAt,
      lastInfoAt: state.lastInfoAt,
    }));
  }

  async setOutlet(mac: string, outlet: number, on: boolean) {
    const normalizedMac = mac.toUpperCase();
    const state = this.connections.get(normalizedMac);
    if (!state || state.socket.destroyed) {
      throw new Error(`Device '${normalizedMac}' is offline.`);
    }

    const command = formatOnOff(outlet, on);
    await this.enqueue(state, async () => {
      await this.request(state, command, frame => frame.trim() === command);
    });
    return this.bridge.getDevice(normalizedMac);
  }

  async queryDevice(mac: string) {
    const state = this.connections.get(mac.toUpperCase());
    if (!state || state.socket.destroyed) {
      throw new Error(`Device '${mac}' is offline.`);
    }
    return this.queryState(state);
  }

  private accept(socket: Socket) {
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");

    const now = new Date().toISOString();
    const state: ConnectionState = {
      socket,
      buffer: "",
      frameAssembler: new MttlFrameAssembler(),
      connectedAt: now,
      lastSeenAt: now,
      pending: new Set(),
      frameChain: Promise.resolve(),
      commandChain: Promise.resolve(),
      syncChain: Promise.resolve(),
      bootTimer: setTimeout(() => {
        if (!state.mac) socket.destroy(new Error("bootinfo timeout"));
      }, this.options.bootTimeoutMs),
    };
    this.sockets.add(state);

    socket.on("data", chunk => this.receive(state, String(chunk)));
    socket.on("error", error => {
      console.warn(`[TCP] ${state.mac ?? formatRemoteAddress(socket)}: ${error.message}`);
    });
    socket.on("close", () => void this.disconnected(state));
  }

  private receive(state: ConnectionState, chunk: string) {
    state.lastSeenAt = new Date().toISOString();
    if (state.buffer.length + chunk.length > 64 * 1024) {
      state.socket.destroy(new Error("receive buffer exceeded 64 KiB"));
      return;
    }

    const { frames, remainder } = appendCrLfFrames(state.buffer, chunk);
    state.buffer = remainder;

    for (const wireFrame of frames) {
      const assembled = state.frameAssembler.push(wireFrame);
      if (state.frameAssembler.bufferedLength > 64 * 1024) {
        state.socket.destroy(new Error("getinfo frame exceeded 64 KiB"));
        return;
      }
      if (assembled.discardedIncomplete) {
        console.warn(
          `[TCP] discarded incomplete getinfo from ${
            state.mac ?? formatRemoteAddress(state.socket)
          } (${assembled.discardedIncomplete.length} chars)`,
        );
      }
      for (const frame of assembled.frames) this.enqueueFrame(state, frame);
    }
  }

  private enqueueFrame(state: ConnectionState, frame: string) {
    state.frameChain = state.frameChain
      .then(() => this.handleFrame(state, frame))
      .catch(error => {
        console.warn(`[TCP] invalid frame: ${error instanceof Error ? error.message : error}`);
      });
  }

  private async handleFrame(state: ConnectionState, frame: string) {
    if (!state.mac) {
      // Some firmware sends state events before identifying the device.
      if (!frame.startsWith(BOOTINFO_PREFIX)) return;
      const boot = parseBootInfo(frame);
      if (!boot || boot.model.toLowerCase() !== "lgutap") {
        state.socket.destroy(new Error("invalid bootinfo"));
        return;
      }

      await this.register(state, boot.mac, boot.firmwareVersion);
      void this.queryState(state).catch(error =>
        console.warn(`[TCP] initial getinfo for ${boot.mac} failed: ${error.message}`),
      );
      return;
    }

    let matchedResponse: PendingResponse | undefined;
    for (const pending of state.pending) {
      if (!pending.predicate(frame)) continue;
      clearTimeout(pending.timer);
      state.pending.delete(pending);
      matchedResponse = pending;
      break;
    }

    try {
      const info = parseGetInfo(frame);
      if (info) {
        state.lastInfoAt = new Date().toISOString();
        this.enqueueSync(state, () => this.bridge.updateTelemetry(state.mac!, {
          outlets: info.outlets.map(outlet => ({
            index: outlet.channel,
            on: outlet.relay,
            powerW: outlet.powerW,
            energyWh: outlet.energyWh,
            temperatureC: outlet.temperatureC,
            powerRaw: outlet.powerRaw,
            energyMeterHex: outlet.energyMeterHex,
            energyKWh: outlet.energyKWh,
            previousEnergyMeterHex: outlet.previousEnergyMeterHex,
            overloadProtection: outlet.overloadProtection,
            overheatProtection: outlet.overheatProtection,
            deviceStatus: outlet.deviceStatus,
            eventCode: outlet.eventCode,
            configurationHex: outlet.configurationHex,
            testState: outlet.testState,
            fixedValue: outlet.fixedValue,
          })),
        }));
        matchedResponse?.resolve(frame);
        return;
      }

      const onOff = parseOnOff(frame);
      if (onOff) {
        // Complete the outbound request before synchronizing Matter state. A
        // Matter OnOff command waits for this TCP response while holding its
        // endpoint transaction; synchronizing first would wait on that same
        // transaction and deadlock until the command timeout.
        matchedResponse?.resolve(frame);
        this.enqueueSync(state, () =>
          this.bridge.syncOutletState(state.mac!, onOff.outlet, onOff.on),
        );
        return;
      }

      matchedResponse?.resolve(frame);
      console.warn(
        `[TCP] unrecognized frame from ${state.mac} (${frame.length} chars): ${JSON.stringify(
          frame.slice(0, 512),
        )}`,
      );
    } catch (error) {
      matchedResponse?.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private register(state: ConnectionState, mac: string, version: string) {
    const operation = this.registrationChain.then(async () => {
      clearTimeout(state.bootTimer);
      state.mac = mac;
      state.version = version;

      const previous = this.connections.get(mac);
      try {
        if (!this.bridge.hasDevice(mac)) {
          await this.bridge.addPowerStrip({
            id: mac,
            name: deviceNameFromMac(mac),
            serialNumber: mac,
            firmwareVersion: version,
          });
        } else {
          await this.bridge.setFirmwareVersion(mac, version);
          await this.bridge.setReachable(mac, true);
        }

        if (state.socket.destroyed) {
          if (!previous || previous.socket.destroyed) {
            await this.bridge.setReachable(mac, false);
          }
          throw new Error(`Device '${mac}' disconnected during registration.`);
        }
        this.connections.set(mac, state);
        if (previous && previous !== state) previous.socket.destroy();
      } catch (error) {
        state.socket.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      console.log(`[TCP] registered ${mac} (${version}) as ${deviceNameFromMac(mac)}`);
    });
    this.registrationChain = operation.catch(() => undefined);
    return operation;
  }

  private async disconnected(state: ConnectionState) {
    clearTimeout(state.bootTimer);
    this.sockets.delete(state);
    for (const pending of state.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Device connection closed."));
    }
    state.pending.clear();

    // Serialize with registration: a delayed offline write must not overwrite
    // the online state of a replacement connection.
    const operation = this.registrationChain.then(async () => {
      if (!state.mac || this.connections.get(state.mac) !== state) return;
      this.connections.delete(state.mac);
      if (this.bridge.hasDevice(state.mac)) {
        await this.bridge.setReachable(state.mac, false);
      }
      console.log(`[TCP] ${state.mac} disconnected`);
    });
    this.registrationChain = operation.catch(error => {
      console.warn(`[Matter] failed to mark ${state.mac} offline: ${error.message}`);
    });
    await this.registrationChain;
  }

  private pollAll() {
    for (const state of this.connections.values()) {
      if (state.queryInFlight) continue;
      void this.queryState(state).catch(error =>
        console.warn(`[TCP] getinfo for ${state.mac} failed: ${error.message}`),
      );
    }
  }

  private queryState(state: ConnectionState) {
    if (state.queryInFlight) return state.queryInFlight;
    state.queryInFlight = (async () => {
      // Let queued controls drain before starting a background/manual query.
      // Recheck because another control may have arrived while we waited.
      let controls: Promise<unknown>;
      do {
        controls = state.commandChain;
        await controls;
      } while (controls !== state.commandChain);
      await this.enqueue(state, () =>
        this.request(state, GETINFO_REQUEST, frame => parseGetInfo(frame) !== undefined),
      );
      // The wire queue is already free. Manual refresh still returns updated data.
      await state.syncChain;
      return state.mac ? this.bridge.getDevice(state.mac) : undefined;
    })().finally(() => { state.queryInFlight = undefined; });
    return state.queryInFlight;
  }

  private enqueueSync(state: ConnectionState, operation: () => Promise<unknown>) {
    // Preserve wire order, but never block receipt of ACKs on a Matter transaction.
    state.syncChain = state.syncChain.then(async () => {
      if (state.socket.destroyed || !state.mac || this.connections.get(state.mac) !== state) return;
      if (this.bridge.getDevice(state.mac).reachable === false) {
        const recovery = this.registrationChain.then(async () => {
          if (!state.socket.destroyed && this.connections.get(state.mac!) === state) {
            await this.bridge.setReachable(state.mac!, true);
          }
        });
        this.registrationChain = recovery.catch(() => undefined);
        await recovery;
      }
      if (state.socket.destroyed || this.connections.get(state.mac) !== state) return;
      await operation();
    }).catch(error => {
      console.warn(`[TCP] state synchronization failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  private enqueue<T>(state: ConnectionState, operation: () => Promise<T>): Promise<T> {
    const result = state.commandChain.then(operation, operation);
    state.commandChain = result.catch(() => undefined);
    return result;
  }

  private request(
    state: ConnectionState,
    command: string,
    predicate: (frame: string) => boolean,
  ) {
    if (state.socket.destroyed) return Promise.reject(new Error("Device is offline."));

    return new Promise<string>((resolve, reject) => {
      const pending: PendingResponse = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          state.pending.delete(pending);
          if (command === GETINFO_REQUEST) state.socket.destroy();
          reject(new Error(`Timeout waiting for '${command}' response.`));
        }, this.options.responseTimeoutMs),
      };
      state.pending.add(pending);
      state.socket.write(`${command}\r\n`, error => {
        if (!error) return;
        clearTimeout(pending.timer);
        state.pending.delete(pending);
        reject(error);
      });
    });
  }
}

function formatRemoteAddress(socket: Socket) {
  return `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
}
