FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY mttl-w01-matterbridge/package*.json ./
RUN npm ci
COPY mttl-w01-matterbridge/tsconfig.json ./
COPY mttl-w01-matterbridge/src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && find dist -name '*.test.*' -delete \
    # The application uses ESM; omit Matter's alternative build and TS sources.
    && rm -rf node_modules/@matter/*/src node_modules/@matter/*/dist/cjs \
    && find dist node_modules -type f \( -name '*.map' -o -name '*.d.ts' \) -delete

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    MTTL_DEVICE_REGISTRY_FILE=/app/data/devices.json
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8086/tcp 10086/tcp 5540/udp 5353/udp
CMD ["node", "dist/index.js"]
