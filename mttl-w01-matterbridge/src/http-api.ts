import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dashboardHtml } from "./dashboard.js";
import { matterQrSvg } from "./matter-qr.js";
import type { MatterPowerStripBridge, PowerStripTelemetry } from "./matter-bridge.js";

export interface HttpApiOptions {
  port?: number;
  getConnections?: () => unknown[];
  setOutlet?: (deviceId: string, outlet: number, on: boolean) => Promise<unknown>;
  queryDevice?: (deviceId: string) => Promise<unknown>;
}

export function startHttpApi(
  bridge: MatterPowerStripBridge,
  options: HttpApiOptions = {},
) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/") {
        return send(res, 200, "text/html; charset=utf-8", dashboardHtml);
      }

      if (method === "GET" && path === "/health") {
        return json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/api/status") {
        return json(res, 200, {
          ok: true,
          commissioning: commissioningInfo(bridge),
          devices: bridge.listDevices(),
          connections: options.getConnections?.() ?? [],
        });
      }

      if (method === "GET" && path === "/commissioning") {
        return json(res, 200, commissioningInfo(bridge));
      }

      if (method === "GET" && path === "/commissioning/qr.svg") {
        const { qrPairingCode } = bridge.server.state.commissioning.pairingCodes;
        return send(res, 200, "image/svg+xml; charset=utf-8", matterQrSvg(qrPairingCode), {
          "cache-control": "no-store",
        });
      }

      if (method === "POST" && path === "/matter/reconnect") {
        const body = await readJson(req);
        if (body.confirm !== true) {
          throw new Error("Matter reconnect requires explicit confirmation.");
        }
        await bridge.resetMatterCommissioning();
        return json(res, 200, {
          ok: true,
          commissioning: commissioningInfo(bridge),
        });
      }

      if (method === "GET" && path === "/devices") {
        return json(res, 200, bridge.listDevices());
      }

      // Retained for diagnostics and development; real units are created from
      // validated TCP bootinfo frames automatically.
      if (method === "POST" && path === "/devices") {
        const body = await readJson(req);
        const device = await bridge.addPowerStrip({
          id: String(body.id ?? ""),
          name: body.name === undefined ? undefined : String(body.name),
          serialNumber:
            body.serialNumber === undefined ? undefined : String(body.serialNumber),
          firmwareVersion:
            body.firmwareVersion === undefined
              ? undefined
              : String(body.firmwareVersion),
        });
        return json(res, 201, device);
      }

      let match = path.match(/^\/devices\/([^/]+)$/);
      if (method === "GET" && match) {
        return json(res, 200, bridge.getDevice(decodeURIComponent(match[1])));
      }
      if (method === "DELETE" && match) {
        await bridge.removePowerStrip(decodeURIComponent(match[1]));
        return json(res, 200, { ok: true });
      }

      match = path.match(/^\/devices\/([^/]+)\/refresh$/);
      if (method === "POST" && match) {
        if (!options.queryDevice) throw new Error("TCP device adapter is unavailable.");
        return json(
          res,
          200,
          await options.queryDevice(decodeURIComponent(match[1])),
        );
      }

      match = path.match(/^\/devices\/([^/]+)\/reachable$/);
      if (method === "POST" && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readJson(req);
        const device = await bridge.setReachable(id, Boolean(body.reachable));
        return json(res, 200, device);
      }

      match = path.match(/^\/devices\/([^/]+)\/outlets\/(\d+)\/state$/);
      if (method === "POST" && match) {
        const id = decodeURIComponent(match[1]);
        const outlet = Number(match[2]);
        const body = await readJson(req);
        const on = requireBoolean(body.on, "on");
        const device = options.setOutlet
          ? await options.setOutlet(id, outlet, on)
          : await bridge.setOutlet(id, outlet, on);
        return json(res, 200, device);
      }

      match = path.match(/^\/devices\/([^/]+)\/telemetry$/);
      if (method === "POST" && match) {
        const id = decodeURIComponent(match[1]);
        const body = (await readJson(req)) as PowerStripTelemetry;
        const device = await bridge.updateTelemetry(id, body);
        return json(res, 200, device);
      }

      return json(res, 404, {
        error: "Not found",
        routes: [
          "GET /",
          "GET /health",
          "GET /api/status",
          "GET /commissioning",
          "GET /commissioning/qr.svg",
          "POST /matter/reconnect",
          "GET /devices",
          "GET /devices/:id",
          "DELETE /devices/:id",
          "POST /devices/:id/refresh",
          "POST /devices/:id/outlets/:index/state",
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : 400;
      return json(res, status, { error: message });
    }
  });

  const port = options.port ?? 8086;
  server.listen(port, "0.0.0.0", () => {
    console.log(`[HTTP] dashboard listening on http://0.0.0.0:${port}`);
  });

  return server;
}

function commissioningInfo(bridge: MatterPowerStripBridge) {
  const { manualPairingCode, qrPairingCode } =
    bridge.server.state.commissioning.pairingCodes;
  return {
    commissioned: bridge.server.lifecycle.isCommissioned,
    manualPairingCode,
    qrPairingCode,
  };
}

function json(res: ServerResponse, status: number, data: unknown) {
  return send(res, status, "application/json; charset=utf-8", JSON.stringify(data, null, 2), {
    "cache-control": "no-store",
  });
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  payload: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) throw new Error("Request body too large.");
    chunks.push(buf);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`'${name}' must be a boolean.`);
  return value;
}
