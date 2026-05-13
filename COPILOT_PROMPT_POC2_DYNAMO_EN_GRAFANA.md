# POC 2 — k6 + Prometheus + Grafana **+ DynamoDB integrado en Grafana**

> **Identificación rápida del POC:**
> - ✅ Grafana visualiza time-series desde **Prometheus**
> - ✅ Grafana visualiza el catálogo de corridas **desde DynamoDB** (vía gateway HTTP + plugin Infinity)
> - ✅ Toda la información se ve en un solo Grafana, sin saltar a `dynamodb-admin`
>
> **Cuándo elegir este POC:** Si tu empresa ya tiene Grafana corporativo y prefiere unificar toda la observabilidad ahí, evitando que QA/Dev tengan que aprender otra UI. Burocráticamente requiere instalar el plugin **Infinity** (`yesoreyeram-infinity-datasource`), que es oficial-community y muy adoptado.

---

## Cómo usar este documento

1. Crea una carpeta vacía en VS Code y guarda este archivo dentro.
2. En Copilot Chat pega: *"Basándote en este archivo .md, crea TODOS los archivos del proyecto desde cero. Respeta exactamente los nombres de archivo, rutas, valores y comportamientos."*
3. Cuando Copilot termine, sigue la sección **8. Pasos para levantar el POC en Docker**.

---

## 1. Contexto y objetivo

POC que **unifica toda la visualización en Grafana**:

| Herramienta | Rol |
|---|---|
| **k6** | Ejecuta load tests y emite métricas en vivo |
| **Prometheus** | Recibe métricas vía remote-write, las guarda como time-series |
| **DynamoDB Local** | Guarda catálogo de corridas (resumen + thresholds) |
| **api-gateway** ⭐ | Servicio Node Express que expone DynamoDB como HTTP/JSON |
| **Grafana** | Visualiza TODO: time-series de Prometheus + tabla histórica de DynamoDB |

**Decisión arquitectónica clave:** En este POC, Grafana **sí consume DynamoDB**, pero no directamente. Usamos el patrón estándar:

```
Grafana ──► Infinity datasource ──► api-gateway (HTTP/JSON) ──► DynamoDB
```

¿Por qué un gateway en vez de un plugin DynamoDB directo? Porque:
- Los plugins comunitarios de DynamoDB tienen compatibilidad inconsistente con DynamoDB Local
- Infinity es un plugin oficial-community muy estable que lee cualquier HTTP/JSON
- Un gateway de ~80 líneas de Node es trivial de mantener y portable a producción
- En prod, el mismo gateway puede apuntar a DynamoDB real de AWS sin cambios

**Restricción:** todo en Docker. Solo Docker Desktop en el host.

---

## 2. Stack tecnológico

| Servicio | Imagen | Puerto | Activación |
|---|---|---|---|
| dynamodb-local | `amazon/dynamodb-local:latest` | 8000 | siempre |
| dynamodb-admin | `aaronshaf/dynamodb-admin:latest` | 8001 | siempre |
| prometheus | `prom/prometheus:latest` | 9090 | siempre |
| **api-gateway** ⭐ | `node:20-alpine` (build local) | 4000 | siempre |
| grafana | `grafana/grafana:latest` | 3000 | siempre **(con plugin Infinity)** |
| init-db | `amazon/aws-cli:latest` | — | profile `init` |
| k6 | `grafana/k6:latest` | — | profile `run` |
| ingest | `node:20-alpine` | — | profile `run` |

---

## 3. Estructura de archivos

```
proyecto/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── prometheus/
│   └── prometheus.yml
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   ├── prometheus.yml
│   │   │   └── dynamodb-gateway.yml          # ⭐ Infinity datasource
│   │   └── dashboards/
│   │       └── default.yml
│   └── dashboards/
│       ├── k6-load-test.json                 # corrida actual (Prometheus)
│       └── k6-runs-catalog.json              # ⭐ catálogo desde DynamoDB
├── api-gateway/                              # ⭐ servicio nuevo
│   ├── Dockerfile
│   ├── package.json
│   └── server.mjs
├── k6/
│   └── load-test.js
├── scripts/
│   ├── init-dynamodb.sh
│   └── k6-to-dynamodb.mjs
└── out/
    └── .gitkeep
```

---

## 4. Diagrama de flujo

```
            k6 (Docker)
              │
       ┌──────┴───────┐
       │              │
   remote-write    handleSummary
       │              │
       ▼              ▼
  ┌──────────┐   /out/summary.json
  │Prometheus│         │
  │ :9090    │         ▼
  │          │   ┌──────────┐
  └────┬─────┘   │ ingest   │
       │         └─────┬────┘
       │               │
       │               ▼
       │       ┌──────────────┐
       │       │ DynamoDB     │
       │       │ :8000        │
       │       └──┬───────┬───┘
       │          │       │
       │     dynamodb     │ AWS SDK
       │     -admin       ▼
       │     :8001  ┌───────────────┐
       │            │ api-gateway   │
       │            │ :4000         │ ⭐
       │            │ Node Express  │
       │            └───────┬───────┘
       │                    │ HTTP/JSON
       ▼                    ▼
    ┌───────────────────────────┐
    │      Grafana :3000        │
    │  ┌──────────┐ ┌─────────┐ │
    │  │Prometheus│ │Infinity │ │
    │  │datasource│ │datasource│ │
    │  └──────────┘ └─────────┘ │
    │  Dashboards:               │
    │  ① Corrida actual          │
    │  ② Catálogo de corridas    │
    └───────────────────────────┘
```

---

## 5. Especificación archivo por archivo

### 5.1 `docker-compose.yml`

Compose sin clave `version:`. Variables `${VAR:-default}`. Red `${COMPOSE_PROJECT_NAME:-k6poc}-net` (alias `poc`).

#### Servicio `dynamodb-local` (igual que POC 1)
- Imagen: `amazon/dynamodb-local:${DYNAMODB_IMAGE_TAG:-latest}`
- Puerto: `${DYNAMODB_PORT:-8000}:8000`
- Volumen `dynamodb-data:/home/dynamodblocal/data`
- Healthcheck con `bash -c '</dev/tcp/127.0.0.1/8000'`

#### Servicio `dynamodb-admin` (igual que POC 1)
- Imagen: `aaronshaf/dynamodb-admin:${DYNAMODB_ADMIN_IMAGE_TAG:-latest}`
- Puerto: `${DYNAMODB_ADMIN_PORT:-8001}:8001`

#### Servicio `prometheus` (igual que POC 1)
- Flags: `--config.file=...`, `--storage.tsdb.path=/prometheus`, `--storage.tsdb.retention.time=${PROMETHEUS_RETENTION:-15d}`, `--web.enable-remote-write-receiver`, `--enable-feature=native-histograms`, `--web.enable-lifecycle`
- Healthcheck `wget --spider .../-/ready`

#### Servicio `api-gateway` ⭐ (NUEVO en este POC)
- Build: `./api-gateway` (Dockerfile local)
- Contenedor: `${COMPOSE_PROJECT_NAME:-k6poc}-api-gateway`
- Puerto: `${API_GATEWAY_PORT:-4000}:4000`
- Env:
  - `PORT=4000`
  - `DYNAMODB_ENDPOINT=http://dynamodb-local:8000`
  - `AWS_REGION=${AWS_REGION:-us-east-1}`
  - `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-local}`
  - `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-local}`
- `depends_on.dynamodb-local: { condition: service_healthy }`
- Healthcheck: `["CMD", "wget", "-q", "--spider", "http://localhost:4000/health"]`, interval 10s, timeout 3s, retries 10
- `restart: unless-stopped`. Red: `poc`.

#### Servicio `grafana` ⭐ (con plugin Infinity)
- Imagen: `grafana/grafana:${GRAFANA_IMAGE_TAG:-latest}`
- Puerto: `${GRAFANA_PORT:-3000}:3000`
- Env:
  - `GF_SECURITY_ADMIN_USER`, `GF_SECURITY_ADMIN_PASSWORD`
  - `GF_USERS_ALLOW_SIGN_UP=false`
  - `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`
  - **`GF_INSTALL_PLUGINS=yesoreyeram-infinity-datasource`** ← clave de este POC
- Volúmenes:
  - `./grafana/provisioning:/etc/grafana/provisioning:ro`
  - `./grafana/dashboards:/var/lib/grafana/dashboards:ro`
  - `grafana-data:/var/lib/grafana`
- `depends_on`:
  - `prometheus: { condition: service_healthy }`
  - `api-gateway: { condition: service_healthy }`
- Healthcheck: `wget -q --spider http://localhost:3000/api/health`

#### Servicios `init-db`, `k6`, `ingest`
Idénticos a POC 1 (ver especificaciones de POC 1 si necesitas detalle). Profiles `init` y `run` respectivamente.

**Volúmenes:** `dynamodb-data`, `prometheus-data`, `grafana-data`, `npm-cache`.

---

### 5.2 `.env.example`

```
COMPOSE_PROJECT_NAME=k6poc

# Puertos host
DYNAMODB_PORT=8000
DYNAMODB_ADMIN_PORT=8001
PROMETHEUS_PORT=9090
GRAFANA_PORT=3000
API_GATEWAY_PORT=4000

# Credenciales Grafana
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=admin

# Credenciales DynamoDB Local
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local

# Retención Prometheus
PROMETHEUS_RETENTION=15d

# Versiones
DYNAMODB_IMAGE_TAG=latest
DYNAMODB_ADMIN_IMAGE_TAG=latest
PROMETHEUS_IMAGE_TAG=latest
GRAFANA_IMAGE_TAG=latest
K6_IMAGE_TAG=latest
NODE_IMAGE_TAG=20-alpine
AWS_CLI_IMAGE_TAG=latest

# Run metadata
RUN_ID=run-local
```

---

### 5.3 `.gitignore`

```
node_modules/
.env
out/*
!out/.gitkeep
results.json
summary.json
*.log
.DS_Store
api-gateway/node_modules/
```

---

### 5.4 `prometheus/prometheus.yml`

```yaml
global:
  scrape_interval: 5s
  evaluation_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']
```

---

### 5.5 `api-gateway/Dockerfile` ⭐ (NUEVO)

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache wget
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://localhost:4000/health || exit 1
CMD ["node", "server.mjs"]
```

---

### 5.6 `api-gateway/package.json` ⭐ (NUEVO)

```json
{
  "name": "api-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "server.mjs",
  "scripts": {
    "start": "node server.mjs"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.620.0",
    "@aws-sdk/lib-dynamodb": "^3.620.0",
    "express": "^4.19.2"
  }
}
```

---

### 5.7 `api-gateway/server.mjs` ⭐ (NUEVO)

Servicio Express que expone DynamoDB Local como HTTP/JSON. Endpoints requeridos:

```js
import express from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const app = express();
const port = process.env.PORT || 4000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}));

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /runs — lista todas las corridas, ordenadas por started_at desc
app.get('/runs', async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 100);
    const out = await ddb.send(new ScanCommand({
      TableName: 'k6_test_runs',
      Limit: limit,
    }));
    const items = (out.Items ?? [])
      .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /runs/:run_id — detalle de una corrida
app.get('/runs/:run_id', async (req, res) => {
  try {
    const out = await ddb.send(new QueryCommand({
      TableName: 'k6_test_runs',
      KeyConditionExpression: 'run_id = :rid',
      ExpressionAttributeValues: { ':rid': req.params.run_id },
    }));
    res.json(out.Items?.[0] ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /thresholds?run_id=... — thresholds de una corrida
app.get('/thresholds', async (req, res) => {
  try {
    const runId = req.query.run_id;
    if (!runId) return res.status(400).json({ error: 'run_id query param required' });
    const out = await ddb.send(new QueryCommand({
      TableName: 'k6_thresholds',
      KeyConditionExpression: 'run_id = :rid',
      ExpressionAttributeValues: { ':rid': String(runId) },
    }));
    res.json(out.Items ?? []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /thresholds/all — todos los thresholds (todas las corridas)
app.get('/thresholds/all', async (_req, res) => {
  try {
    const out = await ddb.send(new ScanCommand({ TableName: 'k6_thresholds' }));
    res.json(out.Items ?? []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`api-gateway listening on :${port}`));
```

---

### 5.8 `grafana/provisioning/datasources/prometheus.yml`

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
    jsonData:
      timeInterval: 5s
      httpMethod: POST
      manageAlerts: false
      prometheusType: Prometheus
```

---

### 5.9 `grafana/provisioning/datasources/dynamodb-gateway.yml` ⭐ (NUEVO)

Configura el plugin Infinity apuntando al api-gateway:

```yaml
apiVersion: 1

datasources:
  - name: DynamoDB-Gateway
    uid: dynamodb-gateway       # UID FIJO — el dashboard lo referencia
    type: yesoreyeram-infinity-datasource
    access: proxy
    isDefault: false
    editable: true
    jsonData:
      auth_method: none
      global_queries: []
      allowedHosts:
        - http://api-gateway:4000
```

---

### 5.10 `grafana/provisioning/dashboards/default.yml`

```yaml
apiVersion: 1

providers:
  - name: k6-dashboards
    orgId: 1
    folder: k6
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

---

### 5.11 `grafana/dashboards/k6-load-test.json`

Mismo dashboard "corrida actual" que POC 1: 11 paneles desde Prometheus, variable `run_id`, refresh 5s. Ver tabla de paneles en POC 1 sección 5.7. Idéntico aquí.

---

### 5.12 `grafana/dashboards/k6-runs-catalog.json` ⭐ (NUEVO, específico de POC 2)

Dashboard "Catálogo de Corridas" leyendo DynamoDB vía gateway. `schemaVersion: 39`, `uid: "k6-runs-catalog"`, refresh 30s, ventana `now-30d` a `now`.

**Datasource:** todos los paneles usan `datasource: { type: "yesoreyeram-infinity-datasource", uid: "dynamodb-gateway" }`.

**Panel 1 — Table "Historial de corridas"** (8,24,0,0):
- Tipo query: URL
- URL: `http://api-gateway:4000/runs?limit=100`
- Method: GET, Type: JSON, Format: Table
- Root selector: vacío (array raíz)
- Columnas a mostrar (`columns`):
  - `run_id` (string)
  - `started_at` (time, formato ISO)
  - `test_name` (string)
  - `environment` (string)
  - `vus_max` (number)
  - `http_reqs` (number)
  - `http_req_failed_rate` (number, unit percentunit)
  - `http_req_duration_p95` (number, unit ms)
  - `http_req_duration_p99` (number, unit ms)
  - `errors_rate` (number, unit percentunit)
- Field overrides: aplicar thresholds verde/amarillo/rojo a `http_req_duration_p95` (500/800) y `errors_rate` (0.01/0.05)
- Transformations: `organize` para ordenar y renombrar columnas amigables

**Panel 2 — Stat "Total de corridas registradas"** (4,6,0,8):
- URL: `http://api-gateway:4000/runs?limit=1000`
- Type: JSON, Format: Table
- Reduce: `count` sobre cualquier campo

**Panel 3 — Stat "p95 mediana del historial"** (4,6,6,8):
- URL: `http://api-gateway:4000/runs?limit=1000`
- Extraer `http_req_duration_p95`, reduce: `mean`, unit `ms`

**Panel 4 — Bar chart "Corridas por test_name"** (4,6,12,8):
- URL: `http://api-gateway:4000/runs?limit=1000`
- Transformation: `groupBy` por `test_name`, calc: count

**Panel 5 — Stat "Última corrida — Status thresholds"** (4,6,18,8):
- URL: `http://api-gateway:4000/thresholds/all`
- Filtra al run_id más reciente con transformations
- Calc: `count` de `passed=false`

**Panel 6 — Table "Thresholds del run_id seleccionado"** (8,24,0,14):
- URL: `http://api-gateway:4000/thresholds?run_id=$run_id`
- Variable `run_id` definida en templating (query type custom, options pobladas desde otro endpoint)
- Columnas: `metric`, `expression`, `passed`
- Field override: colorear `passed=false` en rojo, `passed=true` en verde

**Variable de templating:**
- `name: run_id`, `type: query`
- `datasource: { uid: dynamodb-gateway }`
- Query type URL: `http://api-gateway:4000/runs?limit=100`
- Variable from: `run_id` field
- `multi: false`, `includeAll: false`

---

### 5.13 `k6/load-test.js`

Idéntico al POC 1. Ver especificación en POC 1 sección 5.9 (3 fases ramp-up/steady/ramp-down, thresholds, métricas custom, `handleSummary` con ruta absoluta `/out/summary.json`).

---

### 5.14 `scripts/init-dynamodb.sh`

Idéntico al POC 1. Wait loop + `create_table` con `--no-cli-pager` y pipe a python. Crea `k6_test_runs` y `k6_thresholds`.

---

### 5.15 `scripts/k6-to-dynamodb.mjs`

Idéntico al POC 1. Lee `summary.json`, hace `PutItem` en `k6_test_runs` y `BatchWriteItem` en `k6_thresholds`. Endpoint desde env vars.

---

### 5.16 `package.json` (raíz del proyecto)

```json
{
  "name": "k6-poc2-dynamo-en-grafana",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "up": "docker compose up -d",
    "down": "docker compose down",
    "logs": "docker compose logs -f",
    "init-db": "docker compose --profile init run --rm init-db",
    "test": "docker compose --profile run run --rm -e RUN_ID=$RUN_ID k6",
    "ingest": "docker compose --profile run run --rm -e RUN_ID=$RUN_ID ingest"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.620.0",
    "@aws-sdk/util-dynamodb": "^3.620.0"
  }
}
```

---

### 5.17 `out/.gitkeep` y `README.md`

`.gitkeep` vacío. README con los pasos de la sección 8 de este documento.

---

## 6. Reglas críticas (gotchas)

1. **Healthcheck de DynamoDB sin curl/wget** — `bash -c '</dev/tcp/127.0.0.1/8000'`.
2. **`handleSummary` con ruta absoluta** `/out/summary.json`.
3. **Bridge Node lee endpoint de env var** `DYNAMODB_ENDPOINT`.
4. **AWS CLI con `--no-cli-pager`** y pipe a python.
5. **Profiles `init` y `run`** — no arrancan con `up`.
6. **`RUN_ID` con `-e RUN_ID=$RUN_ID` explícito**.
7. **Datasource Prometheus con `uid: prometheus`**, datasource Infinity con **`uid: dynamodb-gateway`**. Ambos fijos.
8. **JSON de dashboards en `/var/lib/grafana/dashboards`**.
9. **`--web.enable-remote-write-receiver`** obligatorio.
10. **Plugin Infinity:** la primera vez que arranca, Grafana descarga el plugin. Tarda ~30-60s. Si el contenedor reinicia mucho antes de terminar, agregar `start_period: 60s` al healthcheck de grafana.
11. **`allowedHosts` en el datasource Infinity es CRÍTICO** — debe incluir `http://api-gateway:4000`. Sin esto Infinity bloquea las requests por seguridad.
12. **El api-gateway usa el nombre DNS interno `api-gateway` (no localhost)**. Grafana lo resuelve dentro de la red Docker.

---

## 7. Costos y consideraciones

| Aspecto | Comentario |
|---|---|
| **Complejidad añadida** | 1 servicio (api-gateway) + 1 plugin (Infinity) + 1 dashboard adicional |
| **Líneas de código del gateway** | ~80 líneas |
| **Tamaño del plugin Infinity** | ~30 MB, instalación automática al arranque |
| **Latencia** | Las queries al catálogo agregan ~50-100ms vs queries directas a Prometheus (despreciable para dashboards) |
| **Producción** | El mismo gateway corre contra DynamoDB de AWS real cambiando solo las env vars |

---

## 8. Pasos para levantar el POC en Docker

### Paso 1 — Verificar Docker
```bash
docker --version
docker compose version
docker ps
```

### Paso 2 — Crear `.env`
```bash
cp .env.example .env
```
Si los puertos 3000, 4000, 8000, 8001, 9090 están ocupados, edita `.env`.

### Paso 3 — Crear carpeta de salida
```bash
mkdir -p out
```

### Paso 4 — Levantar la infraestructura
```bash
docker compose up -d
```
La primera vez Docker:
- Descarga imágenes base (~3-5 min)
- Builda la imagen del `api-gateway` (~1 min)
- Grafana descarga el plugin Infinity al arrancar (~30-60s)

**Espera más tiempo que el POC 1 por el plugin.**

### Paso 5 — Validar
```bash
docker compose ps
```
Espera a ver `healthy` en `dynamodb-local`, `prometheus`, `api-gateway` y `grafana`.

**Validar el plugin Infinity en Grafana:**
- http://localhost:3000 → Connections → Data sources
- Debe aparecer `DynamoDB-Gateway` (provisionado, sin necesidad de configurar)
- Click → "Save & test" → debe decir "OK"

**Validar el gateway responde:**
```bash
curl http://localhost:4000/health
# {"ok":true}
curl http://localhost:4000/runs
# []  (vacío hasta que corras un test)
```

### Paso 6 — Inicializar tablas
```bash
docker compose --profile init run --rm init-db
```

### Paso 7 — Definir `RUN_ID`
```bash
export RUN_ID=run-$(date -u +%Y%m%dT%H%M%SZ)
echo $RUN_ID
```

### Paso 8 — Ejecutar el test
```bash
docker compose --profile run run --rm -e RUN_ID=$RUN_ID k6
```

### Paso 9 — Ingestar a DynamoDB
```bash
docker compose --profile run run --rm -e RUN_ID=$RUN_ID ingest
```

### Paso 10 — Validar end-to-end

**Gateway:**
```bash
curl http://localhost:4000/runs | head -50
curl http://localhost:4000/thresholds?run_id=$RUN_ID
```

**Grafana — los DOS dashboards:**
- http://localhost:3000 → folder "k6"
- Dashboard **"Load Test Overview"** — desde Prometheus, gráficas time-series
- Dashboard **"Runs Catalog"** ⭐ — desde DynamoDB vía gateway, tabla con todas las corridas, latest run thresholds, stats agregados

### Paso 11 — Correr múltiples pruebas

Para ver el valor real del POC 2, corre varias veces:

```bash
for i in 1 2 3; do
  export RUN_ID=run-$(date -u +%Y%m%dT%H%M%SZ)-iter$i
  docker compose --profile run run --rm -e RUN_ID=$RUN_ID k6
  docker compose --profile run run --rm -e RUN_ID=$RUN_ID ingest
  sleep 5
done
```

Luego ve a Grafana → dashboard "Runs Catalog" → vas a tener 3+ filas con sus respectivos thresholds.

### Paso 12 — Mantenimiento

```bash
docker compose down                          # apaga conservando datos
docker compose down -v                       # reset total
docker compose logs -f api-gateway           # logs del gateway
docker compose logs -f grafana | grep -i plugin  # verificar carga del plugin
docker compose restart api-gateway           # reiniciar gateway tras cambios en server.mjs
docker compose build api-gateway             # rebuild si cambiaste Dockerfile o deps
```

---

## 9. Troubleshooting

| Síntoma | Fix |
|---|---|
| `port is already allocated` | Cambia puerto en `.env` |
| Grafana arranca pero no carga el plugin | Ver `docker compose logs grafana | grep plugin`. Si dice "failed to download", verifica conexión a internet. El plugin se baja de `grafana.com` |
| Dashboard "Runs Catalog" muestra "datasource not found" | Validar `uid: dynamodb-gateway` en `grafana/provisioning/datasources/dynamodb-gateway.yml` |
| Panel "Runs Catalog" muestra error "host not allowed" | Verificar que `allowedHosts: ["http://api-gateway:4000"]` esté en el datasource |
| Tabla vacía aunque DynamoDB tiene datos | `curl http://localhost:4000/runs` → si vacío, problema en el gateway; si tiene datos, problema en transformations del panel |
| `api-gateway` crashea | `docker compose logs api-gateway` para ver el error. Usualmente: tabla no existe (correr `init-db`) o endpoint mal |
| Después de editar `server.mjs` no se reflejan cambios | `docker compose build api-gateway && docker compose up -d api-gateway` |
| Reset total | `docker compose down -v && mkdir -p out && docker compose up -d` y volver al paso 6 |

---

## 10. Checklist de validación

- [ ] `docker compose ps` muestra 5 servicios siempre-activos en `healthy` (incluyendo `api-gateway`)
- [ ] `curl http://localhost:4000/health` retorna `{"ok":true}`
- [ ] En Grafana → Connections → Data sources aparecen `Prometheus` Y `DynamoDB-Gateway`
- [ ] Tras correr e ingestar 1 test, `curl http://localhost:4000/runs` devuelve la fila
- [ ] Dashboard "Load Test Overview" muestra gráficas time-series
- [ ] Dashboard "Runs Catalog" muestra la tabla con la corrida y sus thresholds
- [ ] El dashboard "Runs Catalog" se actualiza automáticamente al hacer otra corrida (refresh 30s)
- [ ] `docker compose down && docker compose up -d` no rompe nada (datos persisten)
