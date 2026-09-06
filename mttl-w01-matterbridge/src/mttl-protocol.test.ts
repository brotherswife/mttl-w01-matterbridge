import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceNameFromMac,
  formatOnOff,
  parseBootInfo,
  parseGetInfo,
  parseOnOff,
} from "./mttl-protocol.js";

const sample =
  "up:getinfo:1:0;off;3;on;on;0;00000247;00000000;00000000;off;00;25" +
  ":2:0;off;3;on;on;0;00000003;00000000;00000000;off;00;26" +
  ":3:0;off;3;on;on;0;00000002;00000000;00000000;off;00;24" +
  ":4:0;on;3;on;on;21420;00000006;00000000;00000000;off;00;25";

test("parses and normalizes bootinfo", () => {
  assert.deepEqual(
    parseBootInfo(
      "up:bootinfo:lgutap;2CFDB3C1DEAF;2cfdb3c1deaf;0.1.43-1.0.58;connect",
    ),
    {
      model: "lgutap",
      mac: "2CFDB3C1DEAF",
      clientId: "2CFDB3C1DEAF",
      firmwareVersion: "0.1.43-1.0.58",
    },
  );
  assert.equal(deviceNameFromMac("2cfdb3c1deaf"), "MTTL 3C1DEAF");
});

test("rejects malformed or mismatched bootinfo MAC addresses", () => {
  assert.equal(
    parseBootInfo("up:bootinfo:lgutap;2CFDB3C1DEAF;000000000000;1;connect"),
    undefined,
  );
  assert.equal(
    parseBootInfo("up:bootinfo:lgutap;not-a-mac;not-a-mac;1;connect"),
    undefined,
  );
});

test("parses every documented getinfo field and unit", () => {
  const result = parseGetInfo(sample);
  assert.ok(result);
  assert.equal(result.outlets.length, 4);
  assert.equal(result.outlets[0].energyWh, 0x247);
  assert.equal(result.outlets[0].energyKWh, 0.583);
  assert.deepEqual(result.outlets[3], {
    channel: 4,
    relay: true,
    overloadProtection: true,
    overheatProtection: true,
    powerRaw: 21_420,
    powerW: 21.42,
    energyMeterHex: "00000006",
    energyWh: 6,
    energyKWh: 0.006,
    previousEnergyMeterHex: "00000000",
    temperatureC: 25,
    deviceStatus: false,
    eventCode: "00",
    configurationHex: "00000000",
    testState: 0,
    fixedValue: 3,
  });
});

test("sorts unique channels and validates commands", () => {
  const records = sample.slice("up:getinfo:".length).split(":");
  const reordered = `up:getinfo:${records.slice(4, 6).join(":")}:${records
    .slice(0, 4)
    .join(":")}:${records.slice(6).join(":")}`;
  assert.deepEqual(
    parseGetInfo(reordered)?.outlets.map(outlet => outlet.channel),
    [1, 2, 3, 4],
  );
  assert.equal(formatOnOff(4, false), "up:onoff:4:off");
  assert.deepEqual(parseOnOff("up:onoff:2:on"), { outlet: 2, on: true });
  assert.equal(parseOnOff("up:onoff:8:on"), undefined);
  assert.throws(() => formatOnOff(5, true), /1\.\.4/);
});

test("parses unsolicited onoff events and rejects invalid events", () => {
  for (let outlet = 1; outlet <= 4; outlet++) {
    for (const on of [false, true]) {
      assert.deepEqual(parseOnOff(`up:event:onoff:${outlet}:${on ? "on" : "off"}`), {
        outlet,
        on,
      });
    }
  }
  for (const frame of [
    "up:event:onoff:0:on",
    "up:event:onoff:5:off",
    "up:event:onoff:1:unknown",
    "up:event:onoff:1:on:extra",
    "up:event:event:onoff:1:on",
  ]) {
    assert.equal(parseOnOff(frame), undefined);
  }
});

test("rejects incomplete, duplicate, and malformed getinfo records", () => {
  assert.equal(parseGetInfo("up:getinfo:1:0;on"), undefined);
  assert.equal(parseGetInfo(sample.replace(":2:", ":1:")), undefined);
  assert.equal(parseGetInfo(sample.replace(";21420;", ";21.420;")), undefined);
  assert.equal(parseGetInfo(sample.replace("00000247", "00000Z47")), undefined);
  assert.equal(parseGetInfo(sample.replace(";off;3;", ";unknown;3;")), undefined);
  assert.equal(parseGetInfo(sample.replace(";00;25", ";000;25")), undefined);
  assert.equal(parseGetInfo(sample.replace(";00;25", ";00;25;extra")), undefined);
});
