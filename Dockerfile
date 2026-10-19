# syntax=docker/dockerfile:1
# SYNAPSE : Node seul, aucune dépendance d'exécution (node:sqlite, FTS5,
# Argon2id et le socle commun sont dans le moteur ou dans le dépôt). Image de
# base épinglée par empreinte (index multi-architecture amd64 + arm64) : une
# étiquette peut être déplacée, une empreinte non.
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM ${NODE_IMAGE}
# Même utilisateur qu'en 1.x (10001) : le volume de données existant reste lisible.
RUN apk add --no-cache tini \
 && addgroup -S -g 10001 synapse && adduser -S -G synapse -u 10001 -H -s /sbin/nologin synapse \
 && mkdir -p /data && chown synapse:synapse /data && chmod 700 /data \
 # Aucun programme setuid ou setgid : personne ne redevient root.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
WORKDIR /app
COPY package.json ./
COPY socle ./socle
COPY src ./src
COPY ui ./ui
USER synapse
ENV NODE_ENV=production PORT=8140 UI_DIR=/app/ui DB_FILE=/data/synapse.db \
    OLLAMA_URL=http://ollama:11434 EMBED_MODEL=nomic-embed-text
EXPOSE 8140
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8140/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
