# POC 2 — k6 + Prometheus + Grafana + DynamoDB integrado en Grafana

Grafana visualiza métricas de Prometheus **y** el catálogo histórico de corridas desde DynamoDB, todo en un solo lugar mediante el plugin Infinity.

## Pasos para levantar el POC

### 1. Verificar Docker
```bash
docker --version
docker compose version
docker ps
```

### 2. Crear `.env`
```bash
cp .env.example .env
```
Si los puertos 3000, 4000, 8000, 8001 o 9090 están ocupados, edítalos en `.env`.

### 3. Levantar la infraestructura
```bash
docker compose up -d
```
La primera vez Docker descarga imágenes, construye el api-gateway y Grafana instala el plugin Infinity (~30-60 s extra).

### 4. Validar servicios
```bash
docker compose ps   # todos deben estar "healthy"
curl http://localhost:4000/health   # {"ok":true}
```

### 5. Inicializar tablas DynamoDB
```bash
docker compose --profile init run --rm init-db
```

### 6. Ejecutar un test
```bash
export RUN_ID=run-$(date -u +%Y%m%dT%H%M%SZ)
docker compose --profile run run --rm -e RUN_ID=$RUN_ID k6
```

### 7. Ingestar resultados a DynamoDB
```bash
docker compose --profile run run --rm -e RUN_ID=$RUN_ID ingest
```

### 8. Ver en Grafana
- http://localhost:3000 → folder **k6**
  - **Load Test Overview** — time-series desde Prometheus
  - **Runs Catalog** — tabla histórica desde DynamoDB

### 9. Múltiples corridas
```bash
for i in 1 2 3; do
  export RUN_ID=run-$(date -u +%Y%m%dT%H%M%SZ)-iter$i
  docker compose --profile run run --rm -e RUN_ID=$RUN_ID k6
  docker compose --profile run run --rm -e RUN_ID=$RUN_ID ingest
  sleep 5
done
```

## Comandos útiles
```bash
docker compose down                        # apaga (datos persisten)
docker compose down -v                     # reset total
docker compose logs -f api-gateway         # logs del gateway
docker compose logs -f grafana | grep -i plugin   # verificar plugin Infinity
docker compose restart api-gateway         # reiniciar tras cambios en server.mjs
docker compose build api-gateway           # rebuild si cambias Dockerfile o deps
```

## Troubleshooting
| Síntoma | Fix |
|---|---|
| `port is already allocated` | Cambia puerto en `.env` |
| Plugin Infinity no carga | `docker compose logs grafana \| grep plugin` |
| "datasource not found" | Verificar `uid: dynamodb-gateway` en el datasource yml |
| "host not allowed" | Verificar `allowedHosts: ["http://api-gateway:4000"]` |
| Tabla vacía | `curl http://localhost:4000/runs` — si vacío, revisar gateway o correr init-db |
| Reset total | `docker compose down -v && docker compose up -d` y volver al paso 5 |
