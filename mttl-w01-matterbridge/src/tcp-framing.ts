import {
  GETINFO_PREFIX,
  isIncompleteGetInfo,
  parseGetInfo,
} from "./mttl-protocol.js";

export interface CrLfFrames {
  frames: string[];
  remainder: string;
}

export function appendCrLfFrames(buffer: string, chunk: string): CrLfFrames {
  const input = buffer + chunk;
  const frames: string[] = [];
  let start = 0;
  let delimiter: number;

  while ((delimiter = input.indexOf("\r\n", start)) !== -1) {
    frames.push(input.slice(start, delimiter));
    start = delimiter + 2;
  }

  return { frames, remainder: input.slice(start) };
}

export interface AssembledMttlFrames {
  frames: string[];
  discardedIncomplete?: string;
}

/** Remove fixed-buffer NUL padding without hiding corruption inside a frame. */
export function stripNullPadding(frame: string) {
  return frame.replace(/^\0+|\0+$/g, "");
}

/** Reassembles firmware getinfo responses that contain a premature CRLF. */
export class MttlFrameAssembler {
  private partialGetInfo?: string;

  get bufferedLength() {
    return this.partialGetInfo?.length ?? 0;
  }

  push(line: string): AssembledMttlFrames {
    const sanitizedLine = stripNullPadding(line);
    if (!sanitizedLine) return { frames: [] };

    let candidate = sanitizedLine;
    let discardedIncomplete: string | undefined;
    if (this.partialGetInfo) {
      if (sanitizedLine.startsWith("up:")) {
        discardedIncomplete = this.partialGetInfo;
      } else {
        candidate = this.partialGetInfo + sanitizedLine;
      }
      this.partialGetInfo = undefined;
    }

    if (
      candidate.trimStart().startsWith(GETINFO_PREFIX) &&
      !parseGetInfo(candidate) &&
      isIncompleteGetInfo(candidate)
    ) {
      this.partialGetInfo = candidate;
      return discardedIncomplete
        ? { frames: [], discardedIncomplete }
        : { frames: [] };
    }

    return discardedIncomplete
      ? { frames: [candidate], discardedIncomplete }
      : { frames: [candidate] };
  }
}
