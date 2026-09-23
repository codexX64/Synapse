# Node 22 : node:sqlite et FTS5 sont dans le runtime, aucune dépendance à installer.
FROM node:22-alpine

RUN addgroup -g 10001 synapse && adduser -D -u 10001 -G synapse synapse

WORKDIR /app
COPY src ./src
COPY ui ./ui
COPY eval.json ./eval.json

RUN mkdir -p /data && chown -R synapse:synapse /data /app
USER synapse

ENV PORT=8140 \
    UI_DIR=/app/ui \
    DB_FILE=/data/synapse.db \
    OLLAMA_URL=http://ollama:11434 \
    EMBED_MODEL=nomic-embed-text \
    NODE_OPTIONS=--no-warnings

EXPOSE 8140
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8140)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
