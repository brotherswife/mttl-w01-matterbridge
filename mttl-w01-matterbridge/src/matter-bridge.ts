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

function validateDeviceId(id: string) {
  if (!id || typeof id !== "string") {
    throw new Error(`Invalid device ID: ${id}`);
  }
}

/**
 * Handle Matter OnOff commands at the command boundary.
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

// 핵심 수정 1: 스위치 디바이스 자체에 전력/에너지 측정 클러스터를 단일 Endpoint로 병합
const CombinedOutletDevice = OnOffPlugInUnitDevice.with(
  PhysicalOutletOnOffServer,
  PowerTopologyServer.with(PowerTopology.Feature.TreeTopology),
  ElectricalPowerMeasurementServer.with(
    ElectricalPowerMeasurement.Feature.AlternatingCurrent,
  ),
  ElectricalEnergyMeasurementServer.with(
    ElectricalEnergyMeasurement.Feature.ImportedEnergy,
    ElectricalEnergyMeasurement.Feature.CumulativeEnergy,
  ),
);

interface ManagedPowerStrip {
  id: string;
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
  reachable: boolean;
  container: Endpoint<any>;
  outlets: Endpoint<any>[];
  telemetry: {
    outlets: Omit<OutletTelemetry, "index" | "on">[];
  };
}

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

// 핵심 수정 2: 단일 Endpoint 내에 스위치 + 전력 + 에너지 초기 상태 세팅
function createCombinedOutlet(id: string) {
  return new Endpoint(CombinedOutletDevice, {
    id,
    onOff: {
      onOff: false,
    },
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
        const outlet = device.outlets[index];
        await outlet.set({
          onOff: { onOff: outletStates[index] },
        });

        const sample = device.telemetry.outlets[index];
        await outlet.set({
          electricalPowerMeasurement: {
            activePower: Math.round(sample.powerW * 1_000),
          },
        });
        await outlet.act(agent =>
          agent.get(ElectricalEnergyMeasurementServer).setMeasurement({
            cumulativeEnergy: {
              imported: { energy: Math.round(sample.energyWh * 1_000) },
            },
          }),
        );
      }
    }
  }

  // 핵심 수정 3: 계층 구조 완성 (BridgedNodeEndpoint 아래에 각 CombinedOutlet 소켓 배치)
  async addPowerStrip(options: PowerStripOptions) {
    validateDeviceId(options.id);
    if (this.devices.has(options.id)) {
      throw new Error(`Device '${options.id}' already exists.`);
    }

    const id = options.id;
    const name = options.name ?? `Power Strip ${id}`;
    const serialNumber = options.serialNumber ?? `PS-${id}`;
    const reachable = options.reachable ?? true;

    // 부모 기기 노드 생성 (HA에서 'MTTL-W01 멀티탭'이라는 하나의 장치로 인식하게 됨)
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
    const initialTelemetryOutlets: Omit<OutletTelemetry, "index" | "on">[] = [];

    // 4구 멀티탭이므로 4번 반복하여 자식 엔드포인트 바인딩
    for (let i = 1; i <= 4; i++) {
      const outletId = `strip-${id}-outlet-${i}`;
      const outlet = createCombinedOutlet(outletId);
      
      await container.add(outlet);
      outlets.push(outlet);

      initialTelemetryOutlets.push({
        powerW: 0,
        energyWh: 0,
      });

      if (this.onOutletCommand) {
        outletCommandBindings.set(outlet, {
          deviceId: id,
          outlet: i,
          handler: this.onOutletCommand,
        });
      }
    }

    this.devices.set(id, {
      id,
      name,
      serialNumber,
      reachable,
      container,
      outlets,
      telemetry: {
        outlets: initialTelemetryOutlets,
      },
    });
  }

  // 핵심 수정 4: 실시간 멀티탭 데이터 수신(Telemetry) 시 데이터 매핑 처리
  async updateTelemetry(id: string, telemetry: PowerStripTelemetry) {
    const device = this.devices.get(id);
    if (!device) return;

    if (telemetry.outlets) {
      for (const outletData of telemetry.outlets) {
        const index = outletData.index - 1; // 기기 index(1~4)를 배열 index(0~3)로 변환
        if (index < 0 || index >= device.outlets.length) continue;

        const outlet = device.outlets[index];

        // 1. 온오프 상태 업데이트
        if (outletData.on !== undefined) {
          await outlet.set({ onOff: { onOff: outletData.on } });
        }

        // 2. 실시간 소비전력 업데이트 (W -> mW 단위 보정)
