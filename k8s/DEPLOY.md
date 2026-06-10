# Desplegar el api-gateway en EKS (Grafana + Infinity → DynamoDB AWS)

Esta guía despliega el `api-gateway` (servidor Express) como un pod en el mismo
cluster EKS donde corre Grafana. Infinity lo consume por DNS interno y el pod lee
DynamoDB usando un IAM Role (IRSA) — sin guardar credenciales en el cluster.

```
Infinity (Grafana, EKS)
  └─► http://k6-api-gateway.<namespace>.svc.cluster.local:4000/runs
        └─► Pod api-gateway (EKS)  ── IRSA ──►  DynamoDB (AWS)
```

## Requisitos previos
- `aws`, `docker`, `kubectl` configurados y apuntando a la cuenta/cluster correctos
- Las tablas `k6_test_runs` y `k6_thresholds` ya creadas en DynamoDB
  (`bash scripts/init-dynamodb.sh` sin `DYNAMODB_ENDPOINT`)
- Saber tu `ACCOUNT_ID`, `REGION` y el `namespace` donde vive Grafana

---

## Paso 1 — Construir la imagen y subirla a ECR

```bash
AWS_ACCOUNT_ID=123456789012 AWS_REGION=us-east-1 ./k8s/build-and-push.sh
```

Al final imprime la URI de la imagen, p.ej.:
`123456789012.dkr.ecr.us-east-1.amazonaws.com/k6-api-gateway:latest`

---

## Paso 2 — Crear el IAM Role con acceso de solo-lectura a DynamoDB (IRSA)

### 2a. Política de permisos (mínimo privilegio)
Edita `k8s/iam-policy-dynamodb.json` y reemplaza `ACCOUNT_ID` y la región. Luego:

```bash
aws iam create-policy \
  --policy-name k6-api-gateway-dynamodb-ro \
  --policy-document file://k8s/iam-policy-dynamodb.json
```

### 2b. Asociar el rol al ServiceAccount (la forma fácil: eksctl)
Si tienes `eksctl`, esto crea el rol, la trust policy OIDC y anota el SA en un solo paso:

```bash
eksctl create iamserviceaccount \
  --cluster <NOMBRE_CLUSTER> \
  --namespace <NAMESPACE_GRAFANA> \
  --name k6-api-gateway \
  --attach-policy-arn arn:aws:iam::ACCOUNT_ID:policy/k6-api-gateway-dynamodb-ro \
  --approve
```

> Si **no** usas eksctl: crea el rol manualmente con `k8s/iam-trust-policy.json`
> (reemplaza `ACCOUNT_ID`, `REGION` y `OIDC_ID` — el OIDC_ID lo obtienes con
> `aws eks describe-cluster --name <CLUSTER> --query "cluster.identity.oidc.issuer"`),
> adjunta la política del paso 2a, y pon el ARN del rol en la anotación del
> ServiceAccount dentro de `k8s/api-gateway.yaml`.

---

## Paso 3 — Ajustar y aplicar el manifest

En `k8s/api-gateway.yaml` reemplaza:
- `namespace: grafana` → tu namespace real (en los 3 recursos)
- `image:` → la URI de ECR del paso 1
- `AWS_REGION` → tu región
- el ARN del rol en la anotación del ServiceAccount (si no usaste eksctl)

> Si usaste **eksctl** en el paso 2b, el ServiceAccount ya existe — borra el
> bloque `ServiceAccount` del final del YAML para no duplicarlo.

```bash
kubectl apply -f k8s/api-gateway.yaml
kubectl -n <NAMESPACE> rollout status deploy/k6-api-gateway
```

Verifica que el pod esté sano:
```bash
kubectl -n <NAMESPACE> get pods -l app=k6-api-gateway
kubectl -n <NAMESPACE> port-forward svc/k6-api-gateway 4000:4000 &
curl http://localhost:4000/health   # {"ok":true}
curl http://localhost:4000/runs     # debe devolver tus corridas
```

---

## Paso 4 — Configurar el datasource Infinity en Grafana

Connections → Data sources → Add data source → **Infinity**

- **Authentication:** None (el pod ya tiene permisos via IRSA)
- **Allowed hosts** (Network → Allowed hosts):
  ```
  http://k6-api-gateway.<NAMESPACE>.svc.cluster.local:4000
  ```
- **Base URL** (opcional, en URL settings):
  ```
  http://k6-api-gateway.<NAMESPACE>.svc.cluster.local:4000
  ```

**Save & test.**

En cada panel del dashboard "Runs Catalog":
- Type: `JSON`, Method: `GET`
- URL: `http://k6-api-gateway.<NAMESPACE>.svc.cluster.local:4000/runs`
- Rows / root selector: `$[*]`

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| Pod en `CrashLoopBackOff` | `readOnlyRootFilesystem` muy estricto | Quita esa línea del securityContext en el manifest |
| `/runs` devuelve `[]` | Tablas vacías o región equivocada | Verifica `AWS_REGION` y que la ingesta haya corrido |
| `AccessDeniedException` en logs | IRSA mal vinculado | Revisa el ARN del rol y la trust policy OIDC |
| Infinity: "host not allowed" | Falta en Allowed hosts | Agrega la URL exacta del Service |
| `ImagePullBackOff` | Nodos sin acceso a ECR | El node role necesita `AmazonEC2ContainerRegistryReadOnly` |
