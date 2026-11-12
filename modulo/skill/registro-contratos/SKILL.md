---
name: registro-contratos
description: Proceso de registro de contratos vigentes - clasificación (nuevo, actualización, duplicado, rechazado), umbral de confianza 0.8, pólizas, remitentes y alertas de vencimiento.
---

# Conocimiento del proceso: registro de contratos vigentes

Este documento es la fuente del conocimiento de negocio que usa el agente. Un cambio de reglas se hace aquí (y en `src/core/`), nunca en el servidor.

## Contexto

- El maestro de contratos vigentes está congelado desde el **2026-05-30**. Antes solo llegaban a administración los contratos que requerían póliza.
- El agente es el **punto único de recepción**: todo contrato firmado debe llegar al buzón, tenga o no póliza.
- No existe área legal interna: el agente no revisa cláusulas, solo extrae y registra datos.

## Clasificación de cada mensaje (RN1–RN4)

| Clasificación | Cuándo | Qué se hace |
|---|---|---|
| `nuevo` | No hay contrato con el mismo `id_contrato` ni mismo `nit_cliente` + objeto parecido (≥ 0.9). | Inserta fila, archiva el documento, `estado_poliza = pendiente` si exige póliza, `no_aplica` si no. |
| `actualizacion` | Mismo `id_contrato` (o mismo NIT + objeto ≥ 0.9) y cambia valor, moneda, fechas o póliza; típico de un **otrosí**. | Modifica la fila existente, guarda el otrosí junto al contrato y registra el cambio en `historial.jsonl`. |
| `duplicado` | Mismo `id_contrato` y mismos valor, fecha_inicio y fecha_fin. | No escribe nada; solo reporta. |
| `rechazado` | Sin adjunto de contrato (cotización, pregunta) o texto sin partes ni objeto identificables. | No escribe; reporta el motivo. |

## Confianza y revisión humana (RN5)

- Cada campo extraído trae confianza en [0, 1]. **Menos de 0.8 → revisión humana**: el registro se detiene hasta que el usuario confirme.
- Campo ausente en el texto: `null` con confianza 0. Nunca se inventa.
- Casos típicos de baja confianza:
  - **Contrato por demanda / marco** sin valor determinado → valor 0 (`valor_indeterminado`), confianza 0.5.
  - **Plazo en meses** sin fecha exacta → la `fecha_fin` se deriva y queda con confianza baja.
  - Solo se indica el mes de firma → `fecha_inicio` aproximada.
- Un confirmado con `confirmado = true` legitima la baja confianza, pero **no** puede suplir campos obligatorios ausentes (cliente, NIT, país, objeto, valor, moneda, fechas, póliza).

## Pólizas

- Nuevo contrato que exige póliza → `estado_poliza = pendiente` hasta que llegue la póliza.
- Un otrosí que amplía plazo o valor obliga a ampliar la vigencia de las garantías: la póliza vuelve a `pendiente`.
- Una póliza condicional a órdenes de servicio de cierto monto (contrato marco) no cuenta como póliza del contrato; se deja como observación.
- Tipos reconocidos: cumplimiento, calidad, responsabilidad_civil, salarios_prestaciones, anticipo.

## Remitente

- Se resuelve contra `comerciales.json` por correo. Un remitente desconocido (por ejemplo un practicante) **se reporta pero no bloquea**; el comercial queda "Sin asignar".

## Alertas (HU-5)

El reporte `out/alertas.md` se calcula con la fecha `hoy` indicada y tiene tres secciones:

1. Contratos que vencen en **≤ 60 días** (incluye los ya vencidos, marcados como tal).
2. Contratos con `requiere_poliza = true` y `estado_poliza` distinto de `vigente`.
3. Contratos registrados desde el corte 2026-05-30 (el hueco que se va cubriendo).

## Esquema del maestro

`id_contrato, cliente, nit_cliente, pais (CO|EC|PE|PA|HN), objeto (≤ 200), valor, moneda (COP|USD|PEN|PAB|HNL), fecha_inicio, fecha_fin, requiere_poliza, tipo_poliza (lista con ;), estado_poliza (vigente|pendiente|vencida|no_aplica), comercial, ruta_sharepoint, fecha_registro, fuente (buzon|manual|migracion)`.

Archivo del documento: `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`.
