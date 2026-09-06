import { QrCode } from "@matter/main/types";

/** Convert matter.js' terminal QR representation into a browser-scannable SVG. */
export function matterQrSvg(payload: string) {
  const terminal = QrCode.get(payload).trimEnd().split("\n");
  const body = terminal.slice(1, -1);
  const modules: boolean[][] = Array.from({ length: 21 }, () =>
    Array.from({ length: 21 }, () => false),
  );

  body.forEach((line, pairY) => {
    const cells = [...line].slice(1, 22);
    cells.forEach((cell, x) => {
      const topY = pairY * 2;
      if (topY < 21) modules[topY][x] = cell === "█" || cell === "▀";
      if (topY + 1 < 21) modules[topY + 1][x] = cell === "█" || cell === "▄";
    });
  });

  const quiet = 4;
  const size = modules.length + quiet * 2;
  const path: string[] = [];
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (modules[y][x]) path.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Matter commissioning QR code">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${path.join("")}" fill="#101827"/>`,
    `</svg>`,
  ].join("");
}
