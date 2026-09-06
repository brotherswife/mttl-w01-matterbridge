import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import {
  ElectricalEnergyMeasurementServer,
  ElectricalPowerMeasurementServer,
  PowerTopologyServer,
} from "@matter/main/behaviors";
import {
  ElectricalEnergyMeasurement,
  ElectricalPowerMeasurement,
  PowerTopology,
} from "@matter/main/clusters";
import {
  OnOffPlugInUnitDevice,
  OnOffPlugInUnitRequirements,
} from "@matter/main/devices";
import {
  AggregatorEndpoint,
  BridgedNodeEndpoint,
  ElectricalSensorEndpoint,
} from "@matter/main/endpoints";
import { MeasurementType } from "@matter/main/types";
import type { DeviceRegistry } from "./device-registry.js";

export type OutletCommandHandler = (
  deviceId: string,
  outlet: number,
  on: boolean,
) => void | Promise<void>;

export interface PowerStripOptions {
  id: string;
  name?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  reachable?: boolean;
}

export interface OutletTelemetry {
  index: number;
  on?: boolean;
  powerW: number;
  energyWh: number;
  temperatureC?: number;
  powerRaw?: number;
  energyMeterHex?: string;
  energyKWh?: number;
  previousEnergyMeterHex?: string;
  overloadProtection?: boolean;
  overheatProtection?: boolean;
  deviceStatus?: boolean;
  eventCode?: string;
  configurationHex?: string;
  testState?: number;
  fixedValue?: number;
}

export interface PowerStripTelemetry {
  outlets?: OutletTelemetry[];
}

interface OutletCommandBinding {
  deviceId: string;
  outlet: number;
  handler: OutletCommandHandler;
}

const outletCommandBindings = new WeakMap<object, OutletCommandBinding>();

/**
 * Handle Matter OnOff commands at the command boundary. Attribute-change
 * observers also run for telemetry synchronization, so using one to drive the
 * physical device can lose or duplicate commands.
 */
class PhysicalOutletOnOffServer extends OnOffPlugInUnitRequirements.OnOffServer {
  override async on() {
    await this.setPhysicalState(true);
  }

  override async off() {
    await this.setPhysicalState(false);
  }

  private async setPhysicalState(on: boolean) {
    const previous = this.state.onOff;
    if (on) {
      super.on();
    } else {
      super.off();
    }

    const binding = outletCommandBindings.get(this.endpoint);
    if (!binding) return;

    try {
      await binding.handler(binding.deviceId, binding.outlet, on);
    } catch (error) {
      // Do not leave Matter (and therefore the dashboard) in an optimistic
      // state when no command reached the physical device.
      if (this.state.onOff === on) {
        if (previous) {
          super.on();
        } else {
          super.off();
        }
      }
      console.error(`[Device] outlet command failed:`, error);
      throw error;
    }
  }
}

const PhysicalOutletDevice = OnOffPlugInUnitDevice.with(
  PhysicalOutletOnOffServer,
);

interface ManagedPowerStrip {
  id: string;
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
  reachable: boolean;
  container: Endpoint<any>;
  outlets: Endpoint<any>[];
  electricalSensors: Endpoint<any>[];
  telemetry: {
    outlets: Omit<OutletTelemetry, "index" | "on">[];
  };
}

// SmartThings' stock Matter switch driver uses Electrical Sensor (0x0510)
// + PowerTopology to associate EPM/EEM measurements with the application
// endpoint.  TREE topology means the ElectricalSensor endpoint's PartsList
// identifies the outlet endpoint it measures.
const SmartThingsElectricalSensor = ElectricalSensorEndpoint.with(
  PowerTopologyServer.with(PowerTopology.Feature.TreeTopology),
  ElectricalPowerMeasurementServer.with(
    ElectricalPowerMeasurement.Feature.AlternatingCurrent,
  ),
  ElectricalEnergyMeasurementServer.with(
    ElectricalEnergyMeasurement.Feature.ImportedEnergy,
    ElectricalEnergyMeasurement.Feature.CumulativeEnergy,
  ),
);

const genericAccuracy = {
  measured: true,
  minMeasuredValue: Number.MIN_SAFE_INTEGER,
  maxMeasuredValue: Number.MAX_SAFE_INTEGER,
  accuracyRanges: [
    {
      rangeMin: Number.MIN_SAFE_INTEGER,
      rangeMax: Number.MAX_SAFE_INTEGER,
      fixedMax: 1,
    },
  ],
};

function createOutlet(id: string) {
  return new Endpoint(PhysicalOutletDevice, {
    id,
    onOff: {
      onOff: false,
    },
  });
}

function createElectricalSensor(id: string) {
  return new Endpoint(SmartThingsElectricalSensor, {
    id,
    powerTopology: {},
    electricalPowerMeasurement: {
      activePower: 0,
      powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
      accuracy: [
        {
          measurementType: MeasurementType.ActivePower,
          ...genericAccuracy,
        },
      ],
      numberOfMeasurementTypes: 1,
    },
    electricalEnergyMeasurement: {
      accuracy: {
        measurementType: MeasurementType.ElectricalEnergy,
        ...genericAccuracy,
      },
    },
  });
}

export class MatterPowerStripBridge {
  readonly server: ServerNode;
  readonly aggregator: Endpoint<any>;

  private readonly devices = new Map<string, ManagedPowerStrip>();
  private readonly onOutletCommand?: OutletCommandHandler;
  private resetPromise?: Promise<void>;

  private constructor(
    server: ServerNode,
    aggregator: Endpoint<any>,
    onOutletCommand?: OutletCommandHandler,
    private readonly registry?: DeviceRegistry,
  ) {
    this.server = server;
    this.aggregator = aggregator;
    this.onOutletCommand = onOutletCommand;
  }

  static async create(options?: {
    matterPort?: number;
    passcode?: number;
    discriminator?: number;
    onOutletCommand?: OutletCommandHandler;
    registry?: DeviceRegistry;
    environment?: Environment;
  }) {
    const server = await ServerNode.create({
      id: "powerstrip-bridge",
      environment: options?.environment,
      network: {
        port: options?.matterPort ?? 5540,
      },
      commissioning: {
        passcode: options?.passcode ?? 20202021,
        discriminator: options?.discriminator ?? 3840,
      },
      productDescription: {
        name: "MTTL-W01 Matter Bridge",
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: "Local MTTL-W01 Bridge",
        vendorId: VendorId(0xfff1),
        nodeLabel: "MTTL-W01 Bridge",
        productName: "MTTL-W01 Bridge",
        productLabel: "MTTL-W01 Bridge",
        productId: 0x8001,
        serialNumber: "matterjs-powerstrip-bridge-001",
        uniqueId: "powerstrip-bridge-001",
      },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, {
      id: "aggregator",
    });
    await server.add(aggregator);

    return new MatterPowerStripBridge(
      server,
      aggregator,
      options?.onOutletCommand,
      options?.registry,
    );
  }

  async start() {
    await this.server.start();
  }

  async close() {
    await this.server.close();
  }

  /** Remove all Matter fabrics while preserving TCP devices and their state. */
  resetMatterCommissioning() {
    if (this.resetPromise) return this.resetPromise;
    const operation = this.performMatterReset();
    this.resetPromise = operation.finally(() => {
      this.resetPromise = undefined;
    });
    return this.resetPromise;
  }

  private async performMatterReset() {
    const snapshots = [...this.devices.values()].map(device => ({
      device,
      outletStates: device.outlets.map(outlet => outlet.state.onOff.onOff),
    }));

    await this.server.erase();

    for (const { device, outletStates } of snapshots) {
      await device.container.set({
        bridgedDeviceBasicInformation: { reachable: device.reachable },
      });
      for (let index = 0; index < device.outlets.length; index++) {
        await device.outlets[index].set({
          onOff: { onOff: outletStates[index] },
        });

        const sample = device.telemetry.outlets[index];
        const electricalSensor = device.electricalSensors[index];
        await electricalSensor.set({
          electricalPowerMeasurement: {
            activePower: Math.round(sample.powerW * 1_000),
          },
        });
        await electricalSensor.act(agent =>
          agent.get(ElectricalEnergyMeasurementServer).setMeasurement({
            cumulativeEnergy: {
              imported: { energy: Math.round(sample.energyWh * 1_000) },
            },
          }),
        );
      }
    }
  }

  async addPowerStrip(options: PowerStripOptions) {
    validateDeviceId(options.id);
    if (this.devices.has(options.id)) {
      throw new Error(`Device '${options.id}' already exists.`);
    }

    const id = options.id;
    const name = options.name ?? `Power Strip ${id}`;
    const serialNumber = options.serialNumber ?? `PS-${id}`;
    const reachable = options.reachable ?? true;

    const container = new Endpoint(BridgedNodeEndpoint, {
      id: `strip-${id}`,
      bridgedDeviceBasicInformation: {
        nodeLabel: name,
        productName: "MTTL-W01",
        productLabel: name,
        serialNumber,
        reachable,
      },
    });

    await this.aggregator.add(container);

    const outlets: Endpoint<any>[] = [];
    const electricalSensors: Endpoint<any>[] = [];
    for (let i = 1; i <= 4; i++) {
      const electricalSensor = createElectricalSensor(`${id}-electrical-${i}`);
      await container.add(electricalSensor);

      const outlet = createOutlet(`${id}-outlet-${i}`);
      await electricalSensor.add(outlet);
      if (this.onOutletCommand) {
        outletCommandBindings.set(outlet, {
          deviceId: id,
          outlet: i,
          handler: this.onOutletCommand,
        });
      }

      outlets.push(outlet);
      electricalSensors.push(electricalSensor);
    }

    const managed: ManagedPowerStrip = {
      id,
      name,
      serialNumber,
      firmwareVersion: options.firmwareVersion,
      reachable,
      container,
      outlets,
      electricalSensors,
      telemetry: {
        outlets: Array.from({ length: 4 }, () => ({
          powerW: 0,
          energyWh: 0,
        })),
      },
    };

    this.devices.set(id, managed);
    try {
      await this.registry?.upsert({
        id,
        name,
        serialNumber,
        firmwareVersion: options.firmwareVersion,
      });
    } catch (error) {
      this.devices.delete(id);
      await container.close().catch(() => undefined);
      throw error;
    }
    return this.getDevice(id);
  }

  async removePowerStrip(id: string) {
    const device = this.requireDevice(id);
    if (device.reachable) {
      throw new Error("온라인 기기는 삭제할 수 없습니다. 기기가 오프라인 상태인지 확인하세요.");
    }
    await device.container.close();
    this.devices.delete(id);
    await this.registry?.remove(id);
  }

  async setReachable(id: string, reachable: boolean) {
    const device = this.requireDevice(id);
    await device.container.set({
      bridgedDeviceBasicInformation: {
        reachable,
      },
    });
    device.reachable = reachable;
    return this.getDevice(id);
  }

  async setOutlet(id: string, outletIndex: number, on: boolean) {
    const device = this.requireDevice(id);
    const outlet = requireOutlet(device, outletIndex);
    await outlet.act(agent => {
      const onOffServer = agent.get(OnOffPlugInUnitRequirements.OnOffServer);
      return on ? onOffServer.on() : onOffServer.off();
    });
    return this.getDevice(id);
  }

  /** Apply physical-device state without sending the same command back to it. */
  async syncOutletState(id: string, outletIndex: number, on: boolean) {
    const device = this.requireDevice(id);
    const outlet = requireOutlet(device, outletIndex);
    if (outlet.state.onOff.onOff === on) return this.getDevice(id);
    await outlet.set({ onOff: { onOff: on } });
    return this.getDevice(id);
  }

  async updateTelemetry(id: string, telemetry: PowerStripTelemetry) {
    const device = this.requireDevice(id);

    for (const sample of telemetry.outlets ?? []) {
      requireOutlet(device, sample.index);
      const electricalSensor = device.electricalSensors[sample.index - 1];

      if (sample.on !== undefined) {
        await this.syncOutletState(id, sample.index, sample.on);
      }

      await electricalSensor.set({
        electricalPowerMeasurement: {
          activePower: Math.round(sample.powerW * 1_000), // mW
        },
      });

      // Use the helper so required ElectricalEnergyMeasurement events are emitted too.
      await electricalSensor.act(agent =>
        agent.get(ElectricalEnergyMeasurementServer).setMeasurement({
          cumulativeEnergy: {
            imported: {
              energy: Math.round(sample.energyWh * 1_000), // mWh
            },
          },
        }),
      );

      const previousSample = device.telemetry.outlets[sample.index - 1];
      const { index: _index, on: _on, ...measurements } = sample;
      device.telemetry.outlets[sample.index - 1] = {
        ...previousSample,
        ...measurements,
        powerW: sample.powerW,
        energyWh: sample.energyWh,
        temperatureC: sample.temperatureC ?? previousSample.temperatureC,
      };
    }

    return this.getDevice(id);
  }

  listDevices() {
    return [...this.devices.keys()].map(id => this.getDevice(id));
  }

  getDevice(id: string) {
    const device = this.requireDevice(id);
    return {
      id: device.id,
      name: device.name,
      firmwareVersion: device.firmwareVersion,
      reachable: device.reachable,
      outlets: device.outlets.map((outlet, index) => ({
        index: index + 1,
        on: outlet.state.onOff.onOff,
        ...device.telemetry.outlets[index],
      })),
    };
  }

  private requireDevice(id: string) {
    const device = this.devices.get(id);
    if (!device) {
      throw new Error(`Device '${id}' not found.`);
    }
    return device;
  }

  hasDevice(id: string) {
    return this.devices.has(id);
  }

  async setFirmwareVersion(id: string, version: string) {
    const device = this.requireDevice(id);
    await this.registry?.upsert({
      id: device.id,
      name: device.name,
      serialNumber: device.serialNumber,
      firmwareVersion: version,
    });
    device.firmwareVersion = version;
  }
}

function validateDeviceId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    throw new Error(
      "Device id must be 1-40 characters: letters, digits, '-' or '_'.",
    );
  }
}

function requireOutlet(device: ManagedPowerStrip, outletIndex: number) {
  if (!Number.isInteger(outletIndex) || outletIndex < 1 || outletIndex > 4) {
    throw new Error("Outlet index must be 1..4.");
  }
  return device.outlets[outletIndex - 1];
}
