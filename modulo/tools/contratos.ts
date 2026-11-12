// GENERADO por scripts/build-modulo.ts desde src/tools/contratos.ts y src/core/. No editar a mano.
// Dependencia: zod (peer). Sin servidor HTTP ni proveedor LLM.

// src/tools/contratos.ts
import { z as z2 } from "zod";

// src/core/almacen.ts
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join } from "node:path";

// src/core/csv.ts
function parseCsv(texto) {
  const filas = [];
  let fila = [];
  let celda = "";
  let comillas = false;
  const limpio = texto.replace(/^﻿/, "");
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (comillas) {
      if (c === '"' && limpio[i + 1] === '"') {
        celda += '"';
        i++;
      } else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") {
      fila.push(celda);
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && limpio[i + 1] === "\n") i++;
      fila.push(celda);
      celda = "";
      if (fila.some((x) => x !== "")) filas.push(fila);
      fila = [];
    } else celda += c;
  }
  fila.push(celda);
  if (fila.some((x) => x !== "")) filas.push(fila);
  return filas;
}
function escapar(v) {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function serializarCsv(filas) {
  return filas.map((f) => f.map(escapar).join(",")).join("\n") + "\n";
}

// src/core/tipos.ts
import { z } from "zod";
var PAISES = ["CO", "EC", "PE", "PA", "HN"];
var MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"];
var ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"];
var FUENTES = ["buzon", "manual", "migracion"];
var UMBRAL_CONFIANZA = 0.8;
var fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "fecha inv\xE1lida");
var ContratoSchema = z.object({
  id_contrato: z.string().nullable().describe("N\xFAmero del contrato tal como aparece; null si no existe"),
  cliente: z.string().nullable().describe("Raz\xF3n social de la contraparte (EL CONTRATANTE)"),
  nit_cliente: z.string().nullable().describe("Identificador tributario sin puntos ni d\xEDgito de verificaci\xF3n"),
  pais: z.enum(PAISES).nullable(),
  objeto: z.string().max(200).nullable().describe("Objeto del contrato, m\xE1x. 200 caracteres"),
  valor: z.number().nullable().describe("Valor sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato no tiene valor determinado"),
  moneda: z.enum(MONEDAS).nullable(),
  fecha_inicio: fechaIso.nullable(),
  fecha_fin: fechaIso.nullable(),
  requiere_poliza: z.boolean().nullable(),
  tipo_poliza: z.string().nullable().describe("Lista separada por ';'; vac\xEDo si no requiere"),
  es_otrosi: z.boolean().describe("true si el documento es un otros\xED / modificaci\xF3n"),
  amplia_poliza: z.boolean().describe("true si el documento exige ampliar la vigencia de las p\xF3lizas"),
  observaciones: z.array(z.string()).describe("Advertencias de la extracci\xF3n para el humano"),
  confianza: z.record(z.string(), z.number().min(0).max(1)).describe("Confianza [0,1] por campo; 0 cuando el campo no est\xE1 en el texto")
});

// src/core/almacen.ts
var COLUMNAS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente"
];
function rutas(directory) {
  const fixtures = join(directory, "fixtures", "reto-02");
  const out = join(directory, "out");
  const sharepoint = join(out, "sharepoint");
  return {
    fixtures,
    buzon: join(fixtures, "buzon"),
    maestroFixture: join(fixtures, "maestro-contratos.csv"),
    comerciales: join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: join(sharepoint, "maestro-contratos.csv"),
    historial: join(sharepoint, "historial.jsonl"),
    procesados: join(out, "procesados.json"),
    log: join(out, "log.jsonl"),
    alertas: join(out, "alertas.md")
  };
}
function asegurarSharepoint(directory) {
  const r = rutas(directory);
  mkdirSync(r.sharepoint, { recursive: true });
  if (!existsSync(r.maestro)) copyFileSync(r.maestroFixture, r.maestro);
}
function aFila(cabecera, celdas) {
  const g = (c) => celdas[cabecera.indexOf(c)] ?? "";
  const pais = g("pais");
  const moneda = g("moneda");
  const estado = g("estado_poliza");
  const fuente = g("fuente");
  if (!PAISES.includes(pais)) throw new Error(`Maestro: pa\xEDs inv\xE1lido "${pais}" en ${g("id_contrato")}`);
  if (!MONEDAS.includes(moneda)) throw new Error(`Maestro: moneda inv\xE1lida "${moneda}" en ${g("id_contrato")}`);
  if (!ESTADOS_POLIZA.includes(estado)) throw new Error(`Maestro: estado_poliza inv\xE1lido "${estado}"`);
  if (!FUENTES.includes(fuente)) throw new Error(`Maestro: fuente inv\xE1lida "${fuente}"`);
  return {
    id_contrato: g("id_contrato"),
    cliente: g("cliente"),
    nit_cliente: g("nit_cliente"),
    pais,
    objeto: g("objeto"),
    valor: Number(g("valor")),
    moneda,
    fecha_inicio: g("fecha_inicio"),
    fecha_fin: g("fecha_fin"),
    requiere_poliza: g("requiere_poliza") === "true",
    tipo_poliza: g("tipo_poliza"),
    estado_poliza: estado,
    comercial: g("comercial"),
    ruta_sharepoint: g("ruta_sharepoint"),
    fecha_registro: g("fecha_registro"),
    fuente
  };
}
function leerMaestro(directory) {
  asegurarSharepoint(directory);
  const [cabecera, ...filas] = parseCsv(readFileSync(rutas(directory).maestro, "utf8"));
  if (!cabecera) throw new Error("El maestro est\xE1 vac\xEDo o no tiene encabezados");
  return filas.map((f) => aFila(cabecera, f));
}
function escribirMaestro(directory, filas) {
  const destino = rutas(directory).maestro;
  const matriz = [[...COLUMNAS], ...filas.map((f) => COLUMNAS.map((c) => String(f[c])))];
  const temporal = `${destino}.tmp`;
  writeFileSync(temporal, serializarCsv(matriz), "utf8");
  renameSync(temporal, destino);
}
function leerProcesados(directory) {
  const ruta = rutas(directory).procesados;
  if (!existsSync(ruta)) return {};
  return JSON.parse(readFileSync(ruta, "utf8"));
}
function marcarProcesado(directory, mensajeId2, dato) {
  const r = rutas(directory);
  mkdirSync(r.out, { recursive: true });
  const actual = leerProcesados(directory);
  actual[mensajeId2] = { ts: (/* @__PURE__ */ new Date()).toISOString(), ...dato };
  writeFileSync(r.procesados, JSON.stringify(actual, null, 2), "utf8");
}
function agregarHistorial(directory, e) {
  asegurarSharepoint(directory);
  appendFileSync(rutas(directory).historial, JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...e }) + "\n", "utf8");
}
function agregarLog(directory, e) {
  const r = rutas(directory);
  mkdirSync(r.out, { recursive: true });
  appendFileSync(r.log, JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...e }) + "\n", "utf8");
}
var ID_MENSAJE = /^[A-Za-z0-9_-]+$/;
function listarIdsBuzon(directory) {
  const { buzon } = rutas(directory);
  if (!existsSync(buzon)) return [];
  return readdirSync(buzon, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}
function leerCorreo(directory, mensajeId2) {
  if (!ID_MENSAJE.test(mensajeId2)) throw new Error(`mensaje_id inv\xE1lido: "${mensajeId2}"`);
  const ruta = join(rutas(directory).buzon, mensajeId2, "correo.json");
  if (!existsSync(ruta)) throw new Error(`No existe el mensaje "${mensajeId2}" en el buz\xF3n`);
  const c = JSON.parse(readFileSync(ruta, "utf8"));
  return {
    id: c.id ?? mensajeId2,
    de: c.de ?? "",
    para: c.para ?? "",
    asunto: c.asunto ?? "",
    fecha: c.fecha ?? "",
    cuerpo: c.cuerpo ?? "",
    adjuntos: Array.isArray(c.adjuntos) ? c.adjuntos : []
  };
}
var NOMBRE_CONTRATO = /contrato|otros[ií]|adenda|prorroga/i;
var TEXTO_CONTRATO = /^\s*(CONTRATO|OTROS[ÍI]|ADENDA|PR[ÓO]RROGA)/i;
function buscarContrato(directory, correo) {
  if (correo.adjuntos.length === 0) return { contrato: null, motivo: "El correo no trae adjuntos" };
  const carpeta = join(rutas(directory).buzon, correo.id);
  let hayCotizacion = false;
  for (const nombre of correo.adjuntos) {
    const ruta = join(carpeta, nombre);
    if (!ID_ADJUNTO.test(nombre) || !existsSync(ruta)) continue;
    const texto = readFileSync(ruta, "utf8");
    if (/cotizaci/i.test(nombre) || /^\s*COTIZACI[ÓO]N/i.test(texto)) hayCotizacion = true;
    else if (NOMBRE_CONTRATO.test(nombre) || TEXTO_CONTRATO.test(texto)) {
      return { contrato: { nombre, rutaAbsoluta: ruta, texto }, motivo: null };
    }
  }
  const motivo = hayCotizacion ? "El adjunto es una cotizaci\xF3n, no un contrato firmado" : `Ning\xFAn adjunto es un contrato u otros\xED (adjuntos: ${correo.adjuntos.join(", ")})`;
  return { contrato: null, motivo };
}
var ID_ADJUNTO = /^\w[\w .-]*$/;
function leerComerciales(directory) {
  return JSON.parse(readFileSync(rutas(directory).comerciales, "utf8"));
}
function archivar(directory, origen, rutaRelativa) {
  const destino = join(rutas(directory).sharepoint, rutaRelativa);
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(origen, destino);
  return rutaRelativa;
}
function extensionDe(nombre) {
  return extname(nombre) || ".txt";
}

// src/core/fechas.ts
var MESES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};
var MES_RE = Object.keys(MESES).join("|");
var pad = (n) => String(n).padStart(2, "0");
function diasEnMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}
function aIso(anio, mes, dia) {
  const valida = mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasEnMes(anio, mes);
  if (!valida) throw new Error(`Fecha inv\xE1lida: ${dia}/${mes}/${anio}`);
  return `${anio}-${pad(mes)}-${pad(dia)}`;
}
function fechasEnTexto(texto) {
  const patrones = [
    new RegExp(`\\((\\d{1,2})\\)\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi"),
    new RegExp(`\\((\\d{1,2})\\)\\s+d[\xEDi]as?\\s+del\\s+mes\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi"),
    new RegExp(`(?<![\\d(])(\\d{1,2})\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "gi")
  ];
  const hallazgos = [];
  for (const re of patrones) {
    for (const m of texto.matchAll(re)) {
      const mes = MESES[(m[2] ?? "").toLowerCase()] ?? 0;
      hallazgos.push({ indice: m.index ?? 0, iso: aIso(Number(m[3]), mes, Number(m[1])) });
    }
  }
  for (const m of texto.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    hallazgos.push({ indice: m.index ?? 0, iso: aIso(Number(m[1]), Number(m[2]), Number(m[3])) });
  }
  return hallazgos.sort((a, b) => a.indice - b.indice).map((h) => h.iso);
}
function mesEnTexto(texto) {
  const m = new RegExp(`mes\\s+de\\s+(${MES_RE})\\s+de\\s+(\\d{4})`, "i").exec(texto);
  if (!m) return null;
  return { anio: Number(m[2]), mes: MESES[(m[1] ?? "").toLowerCase()] ?? 0 };
}
function ultimoDiaDelMes(anio, mes) {
  return aIso(anio, mes, diasEnMes(anio, mes));
}
function sumarMeses(iso, meses) {
  const [a, m, d] = iso.split("-").map(Number);
  const total = a * 12 + (m - 1) + meses;
  const anio = Math.floor(total / 12);
  const mes = total % 12 + 1;
  return aIso(anio, mes, Math.min(d, diasEnMes(anio, mes)));
}
function diasEntre(desde, hasta) {
  const ms = Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`);
  return Math.round(ms / 864e5);
}
function esFechaIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= diasEnMes(a, m);
}
function hoyIso() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}

// src/core/alertas.ts
var FECHA_CORTE = "2026-05-30";
var VENTANA_DIAS = 60;
function calcularAlertas(maestro, hoy) {
  const vencen = maestro.map((f) => ({ f, dias: diasEntre(hoy, f.fecha_fin) })).filter(({ dias }) => dias <= VENTANA_DIAS).sort((a, b) => a.dias - b.dias).map(({ f, dias }) => ({
    id_contrato: f.id_contrato,
    cliente: f.cliente,
    fecha_fin: f.fecha_fin,
    dias_restantes: dias,
    estado: dias < 0 ? "vencido" : "por_vencer",
    comercial: f.comercial
  }));
  const polizas_pendientes = maestro.filter((f) => f.requiere_poliza && f.estado_poliza !== "vigente").map((f) => ({
    id_contrato: f.id_contrato,
    cliente: f.cliente,
    tipo_poliza: f.tipo_poliza,
    estado_poliza: f.estado_poliza,
    fecha_fin: f.fecha_fin,
    comercial: f.comercial
  }));
  const registrados_desde_corte = maestro.filter((f) => f.fecha_registro >= FECHA_CORTE).map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, fuente: f.fuente }));
  return { vencen, polizas_pendientes, registrados_desde_corte };
}
function tabla(cabeceras, filas) {
  if (filas.length === 0) return "_Sin elementos._\n";
  const sep = cabeceras.map(() => "---").join(" | ");
  const cuerpo = filas.map((f) => `| ${f.join(" | ")} |`).join("\n");
  return `| ${cabeceras.join(" | ")} |
| ${sep} |
${cuerpo}
`;
}
function renderizarAlertas(r, hoy) {
  const vencidos = r.vencen.filter((v) => v.estado === "vencido").length;
  return [
    "# Reporte de alertas de contratos",
    "",
    `Fecha de referencia: **${hoy}** \xB7 Ventana de vencimiento: ${VENTANA_DIAS} d\xEDas \xB7 Corte del maestro congelado: ${FECHA_CORTE}`,
    "",
    `## 1. Contratos que vencen en \u2264 ${VENTANA_DIAS} d\xEDas (${r.vencen.length}; ${vencidos} ya vencidos)`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha fin", "D\xEDas", "Estado", "Comercial"],
      r.vencen.map((v) => [v.id_contrato, v.cliente, v.fecha_fin, String(v.dias_restantes), v.estado, v.comercial])
    ),
    `## 2. P\xF3lizas pendientes o vencidas (${r.polizas_pendientes.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de p\xF3liza", "Estado p\xF3liza", "Fecha fin", "Comercial"],
      r.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza || "\u2014", p.estado_poliza, p.fecha_fin, p.comercial])
    ),
    `## 3. Registrados desde el corte ${FECHA_CORTE} \u2014 gap cubierto (${r.registrados_desde_corte.length})`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha de registro", "Fuente"],
      r.registrados_desde_corte.map((c) => [c.id_contrato, c.cliente, c.fecha_registro, c.fuente])
    )
  ].join("\n");
}

// src/core/numeros.ts
function parseMonto(crudo) {
  const s = crudo.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const punto = s.lastIndexOf(".");
  const coma = s.lastIndexOf(",");
  let decimal = null;
  if (punto >= 0 && coma >= 0) {
    decimal = punto > coma ? "." : ",";
  } else {
    const sep = punto >= 0 ? "." : coma >= 0 ? "," : null;
    if (sep) {
      const partes = s.split(sep);
      if (partes.length === 2 && (partes[1] ?? "").length !== 3) decimal = sep;
    }
  }
  const normalizado = decimal ? s.split(decimal === "." ? "," : ".").join("").replace(decimal, ".") : s.replace(/[.,]/g, "");
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}
function normalizar(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function similitud(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const bigramas = (s) => {
    const m = /* @__PURE__ */ new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = bigramas(na);
  const gb = bigramas(nb);
  let comunes = 0;
  for (const [g, n] of ga) comunes += Math.min(n, gb.get(g) ?? 0);
  return 2 * comunes / (na.length - 1 + (nb.length - 1));
}
var SUFIJOS_LEGALES = /\b(s a s|s a c|s a|s de r l|ltda|sas|sac)\b/g;
function slugCliente(cliente) {
  return normalizar(cliente).replace(SUFIJOS_LEGALES, "").trim().replace(/\s+/g, "-");
}

// src/core/extraccion.ts
var NOMBRE_CONTRAPARTE = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .&]+?),\s*(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+)/g;
var PALABRAS_MINUSCULA = /* @__PURE__ */ new Set(["de", "del", "la", "y", "e", "el"]);
var PAIS_POR_PALABRA = [
  { pais: "CO", re: /Colombia|Bogot[áa]|Medell[íi]n|Barranquilla|Cali\b|Cartagena/i },
  { pais: "EC", re: /Ecuador|Quito|Guayaquil/i },
  { pais: "PE", re: /Per[úu]|Lima\b/i },
  { pais: "PA", re: /Panam[áa]/i },
  { pais: "HN", re: /Honduras|Tegucigalpa|San Pedro Sula/i }
];
var MONEDA_POR_PALABRA = [
  { moneda: "COP", re: /\bpesos\b/i },
  { moneda: "USD", re: /d[óo]lares/i },
  { moneda: "PEN", re: /\bsoles\b/i },
  { moneda: "PAB", re: /balboas/i },
  { moneda: "HNL", re: /lempiras/i }
];
var TIPOS_POLIZA = [
  { tipo: "cumplimiento", re: /cumplimiento/i },
  { tipo: "calidad", re: /calidad/i },
  { tipo: "responsabilidad_civil", re: /responsabilidad civil/i },
  { tipo: "salarios_prestaciones", re: /salarios|prestaciones sociales/i },
  { tipo: "anticipo", re: /anticipo/i }
];
function extraerContrato(texto) {
  if (!texto || !texto.trim()) throw new Error("El texto del contrato est\xE1 vac\xEDo");
  const parrafos = texto.split(/\n\s*\n/).map((p) => p.trim());
  const conf = {};
  const observaciones = [];
  const es_otrosi = /^\s*OTROS[ÍI]/i.test(texto.slice(0, 200));
  const id = texto.match(/\b([A-Z]{1,4}-\d{4}-\d{1,4})\b/)?.[1] ?? null;
  conf.id_contrato = id ? 0.98 : 0;
  const contraparte = extraerContraparte(texto);
  conf.cliente = contraparte ? contraparte.confianza : 0;
  conf.nit_cliente = contraparte ? 0.95 : 0;
  const pais = contraparte ? paisDeDomicilio(texto, contraparte.finIndice) : null;
  conf.pais = pais ? 0.9 : 0;
  const objeto = extraerObjeto(parrafos);
  conf.objeto = objeto.texto ? objeto.confianza : 0;
  const valor = extraerValor(parrafos, texto, observaciones);
  conf.valor = valor.confValor;
  conf.moneda = valor.moneda ? valor.confMoneda : 0;
  const plazo = extraerPlazo(parrafos, texto, observaciones);
  conf.fecha_inicio = plazo.inicio ? plazo.confInicio : 0;
  conf.fecha_fin = plazo.fin ? plazo.confFin : 0;
  const poliza = extraerPoliza(parrafos, texto, es_otrosi, observaciones);
  conf.requiere_poliza = poliza.requiere === null ? 0 : poliza.confianza;
  conf.tipo_poliza = poliza.requiere === null ? 0 : poliza.confianza;
  return {
    id_contrato: id,
    cliente: contraparte?.nombre ?? null,
    nit_cliente: contraparte?.nit ?? null,
    pais: pais ?? paisPorMoneda(valor.moneda, conf),
    objeto: objeto.texto,
    valor: valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.requiere === null ? null : poliza.tipos,
    es_otrosi,
    amplia_poliza: /deber[áa]n ampliarse|ampliar(?:se)?[^.]*vigencia/i.test(texto) && es_otrosi,
    observaciones,
    confianza: conf
  };
}
function extraerContraparte(texto) {
  for (const m of texto.matchAll(NOMBRE_CONTRAPARTE)) {
    const bruto = (m[1] ?? "").trim();
    if (/PERIFERIA/i.test(bruto)) continue;
    const fin = (m.index ?? 0) + m[0].length;
    const esContratante = /CONTRATANTE/.test(texto.slice(fin, fin + 400));
    return {
      nombre: tituloEmpresa(bruto),
      nit: limpiarIdentificador(m[3] ?? ""),
      confianza: esContratante ? 0.95 : 0.75,
      finIndice: fin
    };
  }
  return null;
}
function tituloEmpresa(mayusculas) {
  return mayusculas.split(/\s+/).filter(Boolean).map((w, i) => {
    if (w.includes(".")) return w.toUpperCase();
    const bajo = w.toLocaleLowerCase("es");
    if (i > 0 && PALABRAS_MINUSCULA.has(bajo)) return bajo;
    return bajo.charAt(0).toLocaleUpperCase("es") + bajo.slice(1);
  }).join(" ");
}
function limpiarIdentificador(crudo) {
  return (crudo.replace(/\./g, "").split("-")[0] ?? "").trim();
}
function paisDeDomicilio(texto, desde) {
  const resto = texto.slice(desde);
  const corte = resto.search(/PERIFERIA/);
  const segmento = resto.slice(0, corte >= 0 ? corte : 300);
  let mejor = null;
  for (const { pais, re } of PAIS_POR_PALABRA) {
    const idx = segmento.search(re);
    if (idx >= 0 && (!mejor || idx < mejor.indice)) mejor = { pais, indice: idx };
  }
  return mejor?.pais ?? null;
}
function paisPorMoneda(moneda, conf) {
  const mapa = { COP: "CO", PEN: "PE", PAB: "PA", HNL: "HN" };
  const pais = moneda ? mapa[moneda] : void 0;
  if (pais) conf.pais = 0.6;
  return pais ?? null;
}
function extraerObjeto(parrafos) {
  const p = parrafos.find((x) => /\bOBJETO\b/.test(x));
  const crudo = p?.match(/OBJETO\.\s*(.+)/s)?.[1];
  if (!crudo) return { texto: null, confianza: 0 };
  let limpio = crudo.replace(/\s+/g, " ").replace(/^EL CONTRATISTA\s+(?:se obliga a ejecutar|se obliga a prestar|prestará(?:\s+el servicio de|\s+servicios de)?)\s+/i, "").replace(/\.$/, "").trim();
  limpio = limpio.charAt(0).toLocaleUpperCase("es") + limpio.slice(1);
  if (limpio.length <= 200) return { texto: limpio, confianza: 0.9 };
  const corte = limpio.slice(0, 200);
  return { texto: corte.slice(0, corte.lastIndexOf(" ")).trimEnd(), confianza: 0.85 };
}
function esMoneda(c) {
  return MONEDAS.includes(c);
}
function extraerValor(parrafos, texto, obs) {
  const pValor = parrafos.find((x) => /\bVALOR\b/.test(x)) ?? "";
  if (/no tiene (?:un )?valor determinado|valor indeterminado|por demanda|cuant[íi]a indeterminada/i.test(pValor || texto)) {
    obs.push("Contrato por demanda: el valor se define en cada orden de servicio; se registra 0.");
    const m2 = monedaAproximada(texto);
    return { valor: 0, indeterminado: true, moneda: m2, confValor: 0.5, confMoneda: m2 ? 0.85 : 0 };
  }
  const enParentesis = /\(\s*([A-Z]{3})\s*\$?\s*(\d[\d.,]*)\s*\)/g;
  const enLinea = /\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*(\d[\d.,]*)/g;
  for (const [origen, re] of [[pValor, enParentesis], [texto, enParentesis], [texto, enLinea]]) {
    for (const m2 of origen.matchAll(re)) {
      const codigo = m2[1] ?? "";
      if (["NIT", "RUC", "RTN", "IVA"].includes(codigo)) continue;
      if (!esMoneda(codigo)) throw new Error(`Moneda desconocida: "${codigo}". Monedas v\xE1lidas: ${MONEDAS.join(", ")}`);
      const valor = parseMonto(m2[2] ?? "");
      if (valor === null) continue;
      return { valor, indeterminado: false, moneda: codigo, confValor: 0.97, confMoneda: 0.97 };
    }
  }
  const m = monedaAproximada(texto);
  return { valor: null, indeterminado: false, moneda: m, confValor: 0, confMoneda: m ? 0.6 : 0 };
}
function monedaAproximada(texto) {
  const codigo = texto.match(/\b(COP|USD|PEN|PAB|HNL)\b/)?.[1];
  if (codigo && esMoneda(codigo)) return codigo;
  return MONEDA_POR_PALABRA.find(({ re }) => re.test(texto))?.moneda ?? null;
}
function extraerPlazo(parrafos, texto, obs) {
  const vacio = { inicio: null, fin: null, confInicio: 0, confFin: 0 };
  const p = parrafos.find((x) => /\bPLAZO\b/.test(x));
  if (!p) return vacio;
  const fechas = fechasEnTexto(p);
  const meses = Number(p.match(/\((\d{1,3})\)\s+mes/i)?.[1] ?? 0);
  if (/desde/i.test(p) && fechas.length >= 2) {
    return { inicio: fechas[0] ?? null, fin: fechas[1] ?? null, confInicio: 0.95, confFin: 0.95 };
  }
  if (fechas.length === 1 && !/desde/i.test(p)) {
    return { ...vacio, fin: fechas[0] ?? null, confFin: 0.95 };
  }
  if (meses > 0) return plazoPorMeses(parrafos, texto, meses, obs);
  return vacio;
}
function plazoPorMeses(parrafos, texto, meses, obs) {
  const pFirma = parrafos.find((x) => /se firma|para constancia/i.test(x)) ?? texto;
  const completa = fechasEnTexto(pFirma)[0];
  if (completa) {
    obs.push(`Plazo de ${meses} meses desde la firma (${completa}); fecha_fin derivada.`);
    return { inicio: completa, fin: sumarMeses(completa, meses), confInicio: 0.9, confFin: 0.6 };
  }
  const mes = mesEnTexto(pFirma);
  if (!mes) return { inicio: null, fin: null, confInicio: 0, confFin: 0 };
  const inicio = ultimoDiaDelMes(mes.anio, mes.mes);
  obs.push(
    `Solo se indica el mes de firma (${mes.anio}-${String(mes.mes).padStart(2, "0")}): fecha_inicio asumida = ${inicio}; fecha_fin = inicio + ${meses} meses. Confirmar con el comercial.`
  );
  return { inicio, fin: sumarMeses(inicio, meses), confInicio: 0.8, confFin: 0.5 };
}
function extraerPoliza(parrafos, texto, esOtrosi, obs) {
  const tiposDe = (s) => TIPOS_POLIZA.filter(({ re }) => re.test(s)).map((t) => t.tipo).join(";");
  if (esOtrosi) {
    const p = parrafos.find((x) => /garant[íi]as|p[óo]liza/i.test(x));
    if (!p) return { requiere: null, tipos: "", confianza: 0 };
    obs.push("El otros\xED indica que las garant\xEDas existentes deben ampliarse en vigencia.");
    return { requiere: true, tipos: tiposDe(p), confianza: 0.85 };
  }
  const pGarantia = parrafos.find((x) => /\bGARANT[ÍI]AS\b/.test(x)) ?? "";
  const menciona = /p[óo]liza/i.test(pGarantia);
  if (!menciona) {
    return { requiere: false, tipos: "", confianza: /p[óo]liza/i.test(texto) ? 0.5 : 0.85 };
  }
  if (/cuyo valor supere|para cada orden/i.test(pGarantia)) {
    obs.push("La p\xF3liza es condicional (solo para \xF3rdenes de servicio sobre cierto monto); no aplica al contrato marco.");
    return { requiere: false, tipos: "", confianza: 0.8 };
  }
  return { requiere: true, tipos: tiposDe(pGarantia), confianza: 0.95 };
}

// src/core/registro.ts
import { dirname as dirname2 } from "node:path";

// src/core/validacion.ts
var CAMPOS_OBLIGATORIOS = [
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza"
];
var CAMPOS_COMPARABLES = ["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"];
var UMBRAL_OBJETO = 0.9;
function resolverRemitente(email, comerciales) {
  const c = comerciales.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  return { email, comercial: c?.nombre ?? null, conocido: Boolean(c) };
}
function validarContrato(contrato, motivoSinContrato, maestro, remitente) {
  const base = { requiere_revision: [], remitente, observaciones: [] };
  const avisos = remitente.conocido ? [] : [`Remitente no registrado en comerciales.json: ${remitente.email}`];
  if (!contrato) {
    return { ...base, clasificacion: "rechazado", motivo: motivoSinContrato ?? "Sin adjunto de contrato", observaciones: avisos };
  }
  if (!contrato.cliente && !contrato.objeto) {
    return {
      ...base,
      clasificacion: "rechazado",
      motivo: "El texto no contiene partes ni objeto identificables",
      observaciones: avisos
    };
  }
  const observaciones = [...avisos, ...contrato.observaciones];
  const existente = buscarExistente(contrato, maestro);
  if (!existente) {
    return { ...base, clasificacion: "nuevo", requiere_revision: revisarNuevo(contrato), observaciones };
  }
  const diferencias = compararConFila(contrato, existente);
  const hayCambios = Object.keys(diferencias).length > 0;
  const conflictos = conflictosConMaestro(contrato, existente);
  const identificacion = { id_contrato_existente: existente.id_contrato, observaciones };
  if (!hayCambios) {
    return { ...base, ...identificacion, clasificacion: "duplicado", requiere_revision: [], motivo: "Ya existe con los mismos valor y fechas" };
  }
  return {
    ...base,
    ...identificacion,
    clasificacion: "actualizacion",
    diferencias,
    requiere_revision: [...revisarCamposPresentes(contrato), ...conflictos]
  };
}
function buscarExistente(c, maestro) {
  if (c.id_contrato) {
    const porId = maestro.find((f) => f.id_contrato === c.id_contrato);
    if (porId) return porId;
  }
  if (!c.nit_cliente || !c.objeto) return void 0;
  const objeto = c.objeto;
  return maestro.find((f) => f.nit_cliente === c.nit_cliente && similitud(f.objeto, objeto) >= UMBRAL_OBJETO);
}
function etiqueta(campo, conf) {
  return `${campo} (confianza ${conf.toFixed(2)})`;
}
function revisarNuevo(c) {
  const dudosos = CAMPOS_OBLIGATORIOS.filter((campo) => (c.confianza[campo] ?? 0) < UMBRAL_CONFIANZA);
  const revision = dudosos.map((campo) => etiqueta(campo, c.confianza[campo] ?? 0));
  if (c.fecha_inicio && c.fecha_fin && c.fecha_fin < c.fecha_inicio) {
    revision.push("fecha_fin: es anterior a fecha_inicio");
  }
  return revision;
}
function revisarCamposPresentes(c) {
  return CAMPOS_COMPARABLES.filter((campo) => c[campo] !== null && (c.confianza[campo] ?? 0) < UMBRAL_CONFIANZA).map(
    (campo) => etiqueta(campo, c.confianza[campo] ?? 0)
  );
}
function conflictosConMaestro(c, f) {
  const conflictos = [];
  if (c.nit_cliente && c.nit_cliente !== f.nit_cliente) {
    conflictos.push(`conflicto: nit_cliente ${c.nit_cliente} difiere del maestro (${f.nit_cliente})`);
  }
  const fin = c.fecha_fin ?? f.fecha_fin;
  const inicio = c.fecha_inicio ?? f.fecha_inicio;
  if (fin < inicio) conflictos.push("conflicto: fecha_fin resultante es anterior a fecha_inicio");
  return conflictos;
}
var conjunto = (s) => s.split(";").map((x) => x.trim()).filter(Boolean).sort().join(";");
function compararConFila(c, f) {
  const cambios = {};
  for (const campo of CAMPOS_COMPARABLES) {
    const nuevo = c[campo];
    if (nuevo === null || nuevo === void 0) continue;
    if (campo === "tipo_poliza" && conjunto(String(nuevo)) === "") continue;
    const actual = f[campo];
    const igual = campo === "tipo_poliza" ? conjunto(String(nuevo)) === conjunto(String(actual)) : nuevo === actual;
    if (!igual) cambios[campo] = { antes: actual, despues: nuevo };
  }
  return cambios;
}

// src/core/registro.ts
function analizarMensaje(directory, mensajeId2, contratoDado) {
  const correo = leerCorreo(directory, mensajeId2);
  const { contrato: adjunto, motivo } = buscarContrato(directory, correo);
  const remitente = resolverRemitente(correo.de, leerComerciales(directory));
  const contrato = adjunto ? contratoDado ?? extraerContrato(adjunto.texto) : null;
  const validacion = validarContrato(contrato, motivo, leerMaestro(directory), remitente);
  return { contrato, validacion, adjunto: adjunto ? { nombre: adjunto.nombre, rutaAbsoluta: adjunto.rutaAbsoluta } : null };
}
function extraerDeMensaje(directory, mensajeId2) {
  const { contrato } = buscarContrato(directory, leerCorreo(directory, mensajeId2));
  return contrato ? extraerContrato(contrato.texto) : null;
}
var RevisionPendiente = class extends Error {
  constructor(campos) {
    super(`requiere revisi\xF3n: ${campos.join("; ")}`);
    this.campos = campos;
  }
  campos;
};
function registrarMensaje(directory, mensajeId2, op) {
  asegurarSharepoint(directory);
  if (leerProcesados(directory)[mensajeId2]) throw new Error(`El mensaje ${mensajeId2} ya fue procesado`);
  const { contrato, validacion, adjunto } = analizarMensaje(directory, mensajeId2, op.contrato);
  const { clasificacion } = validacion;
  if (clasificacion === "rechazado") {
    marcarProcesado(directory, mensajeId2, { accion: "rechazado", id_contrato: null, motivo: validacion.motivo });
    return { id_contrato: null, accion: "rechazado", ruta_archivo: null, motivo: validacion.motivo };
  }
  if (!contrato || !adjunto) throw new Error("Estado inconsistente: clasificado sin contrato");
  const maestro = leerMaestro(directory);
  if (clasificacion === "duplicado") {
    const existente = maestro.find((f) => f.id_contrato === validacion.id_contrato_existente);
    marcarProcesado(directory, mensajeId2, { accion: "duplicado", id_contrato: existente?.id_contrato ?? null });
    return { id_contrato: existente?.id_contrato ?? null, accion: "duplicado", ruta_archivo: existente?.ruta_sharepoint ?? null, motivo: validacion.motivo };
  }
  if (validacion.requiere_revision.length > 0 && !op.confirmado) throw new RevisionPendiente(validacion.requiere_revision);
  const fechaRegistro = op.fechaRegistro ?? hoyIso();
  const comercial = validacion.remitente.comercial ?? "Sin asignar";
  const resultado = clasificacion === "nuevo" ? insertar(directory, maestro, contrato, adjunto, comercial, fechaRegistro) : actualizar(directory, maestro, contrato, validacion, adjunto);
  agregarHistorial(directory, {
    id_contrato: resultado.id_contrato ?? "",
    accion: resultado.accion,
    cambios: resultado.cambios ?? {},
    mensaje_id: mensajeId2
  });
  marcarProcesado(directory, mensajeId2, { accion: resultado.accion, id_contrato: resultado.id_contrato });
  return resultado;
}
function insertar(directory, maestro, c, adjunto, comercial, fechaRegistro) {
  const faltantes = camposFaltantes(c);
  if (faltantes.length > 0) {
    throw new Error(`Faltan campos obligatorios que ni siquiera una confirmaci\xF3n puede suplir: ${faltantes.join(", ")}`);
  }
  const inicio = c.fecha_inicio;
  const id = c.id_contrato ?? siguienteIdAuto(maestro, inicio.slice(0, 4));
  const ruta = `Contratos/${inicio.slice(0, 4)}/${slugCliente(c.cliente)}/${id}${extensionDe(adjunto.nombre)}`;
  const requierePoliza = c.requiere_poliza;
  const fila = {
    id_contrato: id,
    cliente: c.cliente,
    nit_cliente: c.nit_cliente,
    pais: c.pais,
    objeto: c.objeto,
    valor: c.valor,
    moneda: c.moneda,
    fecha_inicio: inicio,
    fecha_fin: c.fecha_fin,
    requiere_poliza: requierePoliza,
    tipo_poliza: requierePoliza ? c.tipo_poliza ?? "" : "",
    estado_poliza: requierePoliza ? "pendiente" : "no_aplica",
    comercial,
    ruta_sharepoint: ruta,
    fecha_registro: fechaRegistro,
    fuente: "buzon"
  };
  archivar(directory, adjunto.rutaAbsoluta, ruta);
  escribirMaestro(directory, [...maestro, fila]);
  return { id_contrato: id, accion: "insertado", ruta_archivo: ruta };
}
function camposFaltantes(c) {
  const obligatorios = [
    "cliente",
    "nit_cliente",
    "pais",
    "objeto",
    "valor",
    "moneda",
    "fecha_inicio",
    "fecha_fin",
    "requiere_poliza"
  ];
  return obligatorios.filter((k) => c[k] === null || c[k] === void 0);
}
function siguienteIdAuto(maestro, anio) {
  const usados = maestro.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}-`)).length;
  return `AUTO-${anio}-${String(usados + 1).padStart(3, "0")}`;
}
function actualizar(directory, maestro, c, v, adjunto) {
  const indice = maestro.findIndex((f) => f.id_contrato === v.id_contrato_existente);
  const actual = maestro[indice];
  if (!actual) throw new Error(`No se encontr\xF3 en el maestro el contrato ${v.id_contrato_existente}`);
  const cambios = { ...v.diferencias ?? {} };
  const nueva = { ...actual };
  for (const [campo, cambio] of Object.entries(cambios)) {
    Object.assign(nueva, { [campo]: cambio.despues });
  }
  if (c.amplia_poliza && actual.requiere_poliza && actual.estado_poliza !== "pendiente") {
    cambios.estado_poliza = { antes: actual.estado_poliza, despues: "pendiente" };
    nueva.estado_poliza = "pendiente";
  }
  const carpeta = dirname2(actual.ruta_sharepoint);
  const destino = `${carpeta}/${actual.id_contrato}-otrosi-${numeroOtrosi(directory, actual.id_contrato)}${extensionDe(adjunto.nombre)}`;
  archivar(directory, adjunto.rutaAbsoluta, destino);
  cambios.documento_archivado = { antes: null, despues: destino };
  const copia = [...maestro];
  copia[indice] = nueva;
  escribirMaestro(directory, copia);
  return { id_contrato: actual.id_contrato, accion: "actualizado", ruta_archivo: destino, cambios };
}
function numeroOtrosi(directory, idContrato) {
  const previos = Object.values(leerProcesados(directory)).filter((p) => p.id_contrato === idContrato && p.accion === "actualizado");
  return previos.length + 1;
}

// src/tools/contratos.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
var FalloControlado = class extends Error {
  constructor(mensaje, extra = {}) {
    super(mensaje);
    this.extra = extra;
  }
  extra;
};
async function ejecutar(herramienta, ctx, mensajeId2, logica) {
  let ok = true;
  let resumen = "";
  let salida;
  try {
    const r = logica();
    resumen = r.resumen;
    salida = { ok: true, data: r.data };
  } catch (e) {
    ok = false;
    resumen = e instanceof Error ? e.message : String(e);
    salida = { ok: false, error: resumen, ...e instanceof FalloControlado ? e.extra : {} };
  }
  try {
    agregarLog(ctx.directory, { herramienta, mensaje_id: mensajeId2, ok, resumen });
  } catch {
  }
  return JSON.stringify(salida);
}
var mensajeId = z2.string().min(1).describe('Identificador del mensaje del buz\xF3n, por ejemplo "msg-001"');
var contratoOpcional = z2.record(z2.string(), z2.unknown()).optional().describe(
  'OPCIONAL. Solo los campos del contrato que el usuario corrigi\xF3 (por ejemplo {"valor":0,"fecha_fin":"2027-08-31"}); se combinan con la extracci\xF3n del mensaje. Normalmente se omite.'
);
function leerContrato(directory, mensajeId2, crudo) {
  if (crudo === void 0) return void 0;
  const base = extraerDeMensaje(directory, mensajeId2);
  const confianza = typeof crudo.confianza === "object" && crudo.confianza !== null ? crudo.confianza : {};
  const candidato = base ? { ...base, ...crudo, confianza: { ...base.confianza, ...confianza } } : crudo;
  const r = ContratoSchema.safeParse(candidato);
  if (r.success) return r.data;
  const detalle = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(ra\xEDz)"}: ${i.message}`).join("; ");
  throw new FalloControlado(`El argumento contrato no es v\xE1lido (${detalle}). Env\xEDa solo campos corregidos con su tipo correcto, o om\xEDtelo.`);
}
var leer_buzon = {
  description: "Lista los mensajes del buz\xF3n que a\xFAn no se han procesado, indicando si traen un contrato adjunto.",
  args: {},
  async execute(_args, ctx) {
    return ejecutar("contratos_leer_buzon", ctx, null, () => {
      const procesados = leerProcesados(ctx.directory);
      const pendientes = listarIdsBuzon(ctx.directory).filter((id) => !procesados[id]);
      const comerciales = leerComerciales(ctx.directory);
      const mensajes = pendientes.map((id) => {
        const correo = leerCorreo(ctx.directory, id);
        const { contrato, motivo } = buscarContrato(ctx.directory, correo);
        const remitente = resolverRemitente(correo.de, comerciales);
        return {
          id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos: correo.adjuntos,
          tiene_contrato: contrato !== null,
          ...contrato ? { adjunto_contrato: contrato.nombre } : { clasificacion: "rechazado", motivo },
          remitente_conocido: remitente.conocido
        };
      });
      return {
        data: { total: mensajes.length, ids: mensajes.map((m) => m.id), ya_procesados: Object.keys(procesados).length, mensajes },
        resumen: `${mensajes.length} mensajes pendientes`
      };
    });
  }
};
var extraer = {
  description: "Extrae del adjunto del mensaje los datos estructurados del contrato (partes, valor, plazo, p\xF3liza) con confianza por campo.",
  args: { mensaje_id: mensajeId },
  async execute(args, ctx) {
    return ejecutar("contratos_extraer", ctx, args.mensaje_id, () => {
      const correo = leerCorreo(ctx.directory, args.mensaje_id);
      const { contrato: adjunto, motivo } = buscarContrato(ctx.directory, correo);
      if (!adjunto) throw new FalloControlado(`El mensaje no trae contrato: ${motivo}`, { clasificacion: "rechazado" });
      const contrato = extraerContrato(adjunto.texto);
      const dudosos = Object.entries(contrato.confianza).filter(([, c]) => c > 0 && c < 0.8).map(([k]) => k);
      return {
        data: { ...contrato, adjunto: adjunto.nombre },
        resumen: `${contrato.id_contrato ?? "sin id"} \xB7 ${contrato.cliente ?? "?"} \xB7 dudosos: ${dudosos.join(",") || "ninguno"}`
      };
    });
  }
};
var validar = {
  description: "Clasifica el mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisi\xF3n humana.",
  args: { mensaje_id: mensajeId, contrato: contratoOpcional },
  async execute(args, ctx) {
    return ejecutar("contratos_validar", ctx, args.mensaje_id, () => {
      const { validacion } = analizarMensaje(ctx.directory, args.mensaje_id, leerContrato(ctx.directory, args.mensaje_id, args.contrato));
      return {
        data: validacion,
        resumen: `${validacion.clasificacion}${validacion.id_contrato_existente ? ` (${validacion.id_contrato_existente})` : ""} \xB7 revisi\xF3n: ${validacion.requiere_revision.length}`
      };
    });
  }
};
var registrar = {
  description: "Registra el contrato en el maestro y lo archiva; si hay campos en revisi\xF3n solo escribe con confirmado=true tras la confirmaci\xF3n expl\xEDcita del usuario.",
  args: {
    mensaje_id: mensajeId,
    contrato: contratoOpcional,
    confirmado: z2.boolean().optional().describe("true SOLO si el usuario confirm\xF3 expl\xEDcitamente los campos en revisi\xF3n"),
    fecha_registro: z2.string().optional().describe("YYYY-MM-DD; por defecto la fecha del sistema. Usar la fecha 'hoy' que dio el usuario.")
  },
  async execute(args, ctx) {
    return ejecutar("contratos_registrar", ctx, args.mensaje_id, () => {
      if (args.fecha_registro !== void 0 && !esFechaIso(args.fecha_registro)) {
        throw new FalloControlado(`fecha_registro inv\xE1lida: "${args.fecha_registro}" (use YYYY-MM-DD)`);
      }
      try {
        const r = registrarMensaje(ctx.directory, args.mensaje_id, {
          confirmado: args.confirmado === true,
          fechaRegistro: args.fecha_registro,
          contrato: leerContrato(ctx.directory, args.mensaje_id, args.contrato)
        });
        return { data: r, resumen: `${r.accion} ${r.id_contrato ?? ""}${args.confirmado ? " (confirmado)" : ""}`.trim() };
      } catch (e) {
        if (e instanceof RevisionPendiente) throw new FalloControlado(e.message, { requiere_revision: e.campos });
        throw e;
      }
    });
  }
};
var alertas = {
  description: "Genera out/alertas.md con contratos que vencen en 60 d\xEDas o menos, p\xF3lizas pendientes y contratos registrados desde el corte del 2026-05-30.",
  args: { hoy: z2.string().describe("Fecha de referencia YYYY-MM-DD (ej. 2026-09-03)") },
  async execute(args, ctx) {
    return ejecutar("contratos_alertas", ctx, null, () => {
      if (!esFechaIso(args.hoy)) throw new FalloControlado(`Fecha inv\xE1lida: "${args.hoy}". Use YYYY-MM-DD`);
      asegurarSharepoint(ctx.directory);
      const resultado = calcularAlertas(leerMaestro(ctx.directory), args.hoy);
      const r = rutas(ctx.directory);
      mkdirSync2(r.out, { recursive: true });
      writeFileSync2(r.alertas, renderizarAlertas(resultado, args.hoy), "utf8");
      return {
        data: { ruta: "out/alertas.md", ...resultado },
        resumen: `vencen ${resultado.vencen.length} \xB7 p\xF3lizas ${resultado.polizas_pendientes.length} \xB7 desde corte ${resultado.registrados_desde_corte.length}`
      };
    });
  }
};
export {
  alertas,
  extraer,
  leer_buzon,
  registrar,
  validar
};
