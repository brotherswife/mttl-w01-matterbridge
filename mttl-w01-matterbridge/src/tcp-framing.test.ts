import assert from "node:assert/strict";
import test from "node:test";
import { parseGetInfo, parseOnOff } from "./mttl-protocol.js";
import {
  appendCrLfFrames,
  MttlFrameAssembler,
  stripNullPadding,
} from "./tcp-framing.js";

const truncatedDeviceFrame =
  "up:getinfo:1:0;on;3;on;on;0;00000000;00000000;00000000;off;00;24" +
  ":2:0;off;3;on;on;0;00000000;00000000;00000000;off;00;23" +
  ":3:0;off;3;on;on;0;00000000;00000000;00000000;off;00;2";

const deviceFrameRemainder =
  "4:4:0;off;3;on;on;0;00000000;00000000;00000000;off;00;25";

test("preserves split and coalesced unsolicited onoff events in wire order", () => {
  const assembler = new MttlFrameAssembler();
  const first = appendCrLfFrames("", "up:event:onoff:1:off\r\nup:event:on");
  const rest = appendCrLfFrames(first.remainder,
    "off:4:off\r\nup:event:onoff:3:on\r\nup:event:onoff:2:on\r\n");
  assert.equal(rest.remainder, "");
  assert.deepEqual(
    [...first.frames, ...rest.frames].flatMap(frame => assembler.push(frame).frames).map(parseOnOff),
    [
      { outlet: 1, on: false },
      { outlet: 4, on: false },
      { outlet: 3, on: true },
      { outlet: 2, on: true },
    ],
  );
});

test("buffers a TCP frame until its CRLF delimiter is complete", () => {
  let result = appendCrLfFrames("", "up:getinfo:1:partial");
  assert.deepEqual(result, { frames: [], remainder: "up:getinfo:1:partial" });

  result = appendCrLfFrames(result.remainder, "-rest\r");
  assert.deepEqual(result, {
    frames: [],
    remainder: "up:getinfo:1:partial-rest\r",
  });

  result = appendCrLfFrames(result.remainder, "\n");
  assert.deepEqual(result, {
    frames: ["up:getinfo:1:partial-rest"],
    remainder: "",
  });
});

test("does not treat a bare LF as a protocol delimiter", () => {
  assert.deepEqual(appendCrLfFrames("", "first\nsecond"), {
    frames: [],
    remainder: "first\nsecond",
  });
});

test("reassembles getinfo when firmware inserts CRLF mid-response", () => {
  const assembler = new MttlFrameAssembler();
  assert.deepEqual(assembler.push(truncatedDeviceFrame), { frames: [] });
  assert.equal(assembler.bufferedLength, truncatedDeviceFrame.length);

  const result = assembler.push(deviceFrameRemainder);
  assert.equal(result.frames.length, 1);
  assert.match(result.frames[0], /;00;24:4:0;off/);
  assert.equal(parseGetInfo(result.frames[0])?.outlets.length, 4);
  assert.equal(assembler.bufferedLength, 0);
});

test("discards a stale partial getinfo when a new protocol frame starts", () => {
  const assembler = new MttlFrameAssembler();
  assembler.push(truncatedDeviceFrame);
  assert.deepEqual(assembler.push("up:onoff:1:on"), {
    frames: ["up:onoff:1:on"],
    discardedIncomplete: truncatedDeviceFrame,
  });
});

test("strips boundary NUL padding from getinfo and onoff frames", () => {
  const assembler = new MttlFrameAssembler();
  const completeGetInfo = truncatedDeviceFrame + deviceFrameRemainder;

  assert.equal(stripNullPadding(`\0\0${completeGetInfo}\0`), completeGetInfo);
  assert.deepEqual(assembler.push(`\0`.repeat(29) + completeGetInfo), {
    frames: [completeGetInfo],
  });
  assert.deepEqual(assembler.push(`\0`.repeat(243) + "up:onoff:2:on\0\0"), {
    frames: ["up:onoff:2:on"],
  });
});

test("does not remove a NUL byte inside protocol data", () => {
  assert.equal(stripNullPadding("up:on\0off:1:on"), "up:on\0off:1:on");
});
