export const BOOTINFO_PREFIX = "up:bootinfo:";
export const GETINFO_PREFIX = "up:getinfo:";
export const GETINFO_REQUEST = "up:getinfo:all";

export interface MttlBootInfo {
  model: string;
  mac: string;
  clientId: string;
  firmwareVersion: string;
}

export interface OutletInfo {
  channel: number;
  relay: boolean;
  overloadProtection: boolean;
  overheatProtection: boolean;
  powerRaw: number;
  powerW: number;
  energyMeterHex: string;
  energyWh: number;
  energyKWh: number;
  previousEnergyMeterHex: string;
  temperatureC: number;
  deviceStatus: boolean;
  eventCode: string;
  configurationHex: string;
  testState: number;
  fixedValue: number;
}

export interface GetInfoResponse {
  outlets: OutletInfo[];
}

export interface MttlOnOff {
  outlet: number;
  on: boolean;
}

export function parseBootInfo(frame: string): MttlBootInfo | undefined {
  const match = frame.trim().match(
    /^up:bootinfo:([^;\r\n]{1,32});([0-9a-fA-F]{12});([0-9a-fA-F]{12});([^;\r\n]{1,64});connect$/,
  );
  if (!match) return undefined;

  const mac = match[2].toUpperCase();
  const clientId = match[3].toUpperCase();
  if (mac !== clientId) return undefined;

  return {
    model: match[1],
    mac,
    clientId,
    firmwareVersion: match[4],
  };
}

export function parseGetInfo(frame: string): GetInfoResponse | undefined {
  const trimmed = frame.trim();
  if (!trimmed.startsWith(GETINFO_PREFIX)) return undefined;

  // The payload alternates between channel number and its semicolon-delimited data.
  const parts = trimmed.slice(GETINFO_PREFIX.length).split(":");
  if (parts.length !== 8) return undefined;

  const seen = new Set<number>();
  const outlets: OutletInfo[] = [];

  for (let offset = 0; offset < parts.length; offset += 2) {
    const channel = parseUnsignedDecimal(parts[offset]);
    if (channel === undefined || channel < 1 || channel > 4 || seen.has(channel)) {
      return undefined;
    }

    const fields = parts[offset + 1].split(";");
    if (fields.length !== 12) return undefined;

    const testState = parseUnsignedDecimal(fields[0]);
    const relay = parseOnOffValue(fields[1]);
    const fixedValue = parseUnsignedDecimal(fields[2]);
    const overloadProtection = parseOnOffValue(fields[3]);
    const overheatProtection = parseOnOffValue(fields[4]);
    const powerRaw = parseUnsignedDecimal(fields[5]);
    const energyWh = parseFixedHex(fields[6], 8);
    const previousEnergyWh = parseFixedHex(fields[7], 8);
    const configuration = parseFixedHex(fields[8], 8);
    const deviceStatus = parseOnOffValue(fields[9]);
    const eventCode = parseFixedHex(fields[10], 2);
    const temperatureC = parseSignedDecimal(fields[11]);

    if (
      testState === undefined ||
      relay === undefined ||
      fixedValue === undefined ||
      overloadProtection === undefined ||
      overheatProtection === undefined ||
      powerRaw === undefined ||
      energyWh === undefined ||
      previousEnergyWh === undefined ||
      configuration === undefined ||
      deviceStatus === undefined ||
      eventCode === undefined ||
      temperatureC === undefined
    ) {
      return undefined;
    }

    seen.add(channel);
    outlets.push({
      channel,
      relay,
      overloadProtection,
      overheatProtection,
      powerRaw,
      powerW: powerRaw / 1_000,
      energyMeterHex: fields[6],
      energyWh,
      energyKWh: energyWh / 1_000,
      previousEnergyMeterHex: fields[7],
      temperatureC,
      deviceStatus,
      eventCode: fields[10],
      configurationHex: fields[8],
      testState,
      fixedValue,
    });
  }

  if (seen.size !== 4) return undefined;
  outlets.sort((a, b) => a.channel - b.channel);
  return { outlets };
}

/**
 * Returns true only when a getinfo frame can still become valid by appending data.
 * Some firmware builds insert CRLF in the middle of a long getinfo response.
 */
export function isIncompleteGetInfo(frame: string) {
  const trimmedStart = frame.trimStart();
  if (!trimmedStart.startsWith(GETINFO_PREFIX)) return false;

  const parts = trimmedStart.slice(GETINFO_PREFIX.length).split(":");
  if (parts.length < 8) return true;
  if (parts.length > 8) return false;

  // With all four channel pairs present, only a short final payload can still
  // be completed safely. Other validation failures are malformed, not partial.
  return parts[7].split(";").length < 12;
}

export function formatOnOff(outlet: number, on: boolean) {
  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 4) {
    throw new Error("Outlet index must be 1..4.");
  }
  return `up:onoff:${outlet}:${on ? "on" : "off"}`;
}

/** Parse command acknowledgements and unsolicited firmware state events. */
export function parseOnOff(frame: string): MttlOnOff | undefined {
  const match = frame.trim().match(/^up:(?:event:)?onoff:([1-4]):(on|off)$/);
  if (!match) return undefined;
  return { outlet: Number(match[1]), on: match[2] === "on" };
}

export function deviceNameFromMac(mac: string) {
  return `MTTL ${mac.toUpperCase().slice(-7)}`;
}

function parseOnOffValue(value: string): boolean | undefined {
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function parseUnsignedDecimal(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseSignedDecimal(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseFixedHex(value: string, length: number): number | undefined {
  const expression = new RegExp(`^[0-9a-fA-F]{${length}}$`);
  if (!expression.test(value)) return undefined;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
