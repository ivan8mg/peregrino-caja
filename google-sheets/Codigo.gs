/**
 * Librería Peregrino · Sincronización con Google Sheets
 *
 * Pega este código en Extensiones > Apps Script de tu hoja, cambia CLAVE,
 * y publícalo como "Aplicación web" (Ejecutar como: Yo · Quién tiene acceso: Cualquier persona).
 * La app manda sus ventas aquí y recibe precios y existencias de la hoja.
 */

// Cambia esto por una palabra secreta. Es la misma que escribirás en la app.
const CLAVE = "cambia-esta-clave";

const COLUMNAS = {
  Productos: ["codigo", "titulo", "autor", "precio", "existencia", "tipo", "sinDescuento", "actualizado"],
  Ventas: ["id", "folio", "fecha", "dispositivo", "cliente", "subtotal", "descuento", "total", "pago", "recibido", "cambio", "estado", "anuladaEn", "actualizadoEn", "lineas"],
  Lineas: ["ventaId", "folio", "fecha", "dispositivo", "codigo", "titulo", "cantidad", "precio", "importe", "estado"],
  Movimientos: ["id", "fecha", "codigo", "cantidad", "motivo", "ventaId", "dispositivo", "recibidoEn"],
};

const COMO_TEXTO = ["codigo", "id", "ventaId", "fecha", "anuladaEn", "actualizadoEn", "actualizado", "recibidoEn", "lineas"];

function doGet() {
  return salida({ ok: true, app: "peregrino", mensaje: "La sincronización está lista." });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return salida({ ok: false, error: "formato" }); }
  if (String(req.clave || "") !== CLAVE || CLAVE === "cambia-esta-clave") return salida({ ok: false, error: "clave" });
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tablas = {};
    for (const nombre of Object.keys(COLUMNAS)) tablas[nombre] = leer(ss, nombre);
    const res = procesar(tablas, req, new Date().toISOString(), hash);
    for (const nombre of Object.keys(COLUMNAS)) if (tablas[nombre].cambio) escribir(ss, nombre, tablas[nombre].filas);
    return salida(res);
  } finally {
    lock.releaseLock();
  }
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function hash(texto) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, texto, Utilities.Charset.UTF_8));
}

function hoja(ss, nombre) {
  let h = ss.getSheetByName(nombre);
  if (!h) {
    h = ss.insertSheet(nombre);
    h.getRange(1, 1, 1, COLUMNAS[nombre].length).setValues([COLUMNAS[nombre]]).setFontWeight("bold");
    h.setFrozenRows(1);
    // Códigos, ids y fechas como texto, para que Sheets no los convierta.
    COLUMNAS[nombre].forEach((k, i) => {
      if (COMO_TEXTO.indexOf(k) >= 0) { const col = String.fromCharCode(65 + i); h.getRange(col + ":" + col).setNumberFormat("@"); }
    });
  }
  return h;
}

// Lee una hoja como lista de objetos según los encabezados de la fila 1.
function leer(ss, nombre) {
  const h = hoja(ss, nombre);
  const valores = h.getDataRange().getValues();
  const enc = valores.shift().map(String);
  const filas = valores
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => {
      const o = {};
      enc.forEach((k, i) => { if (k) o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
      return o;
    });
  return { filas, cambio: false };
}

function escribir(ss, nombre, filas) {
  const h = hoja(ss, nombre);
  const enc = COLUMNAS[nombre];
  const ultima = h.getLastRow();
  if (ultima > 1) h.getRange(2, 1, ultima - 1, Math.max(h.getLastColumn(), enc.length)).clearContent();
  if (!filas.length) return;
  h.getRange(2, 1, filas.length, enc.length).setValues(filas.map((o) => enc.map((k) => (o[k] === undefined || o[k] === null ? "" : o[k]))));
}

/* ---------- Lógica (sin Google, se puede probar aparte) ----------
 * req = { dispositivo, desde, hashProductos, catalogo?, productos[], ventas[], movimientos[] }
 * - catalogo: solo si la hoja Productos está vacía (primer equipo en conectarse).
 * - productos: artículos nuevos o editados en la app (la existencia solo se toma si el artículo es nuevo).
 * - movimientos: cada cambio de existencia; se aplica a Productos una sola vez por id.
 * - ventas: nuevas o actualizadas (anuladas).
 * Respuesta: ids aceptados, productos (solo si cambiaron), ventas actualizadas desde `desde`, y la hora del servidor.
 */
function procesar(tablas, req, ahora, hashFn) {
  const P = tablas.Productos, V = tablas.Ventas, L = tablas.Lineas, M = tablas.Movimientos;
  const txt = (v) => String(v === undefined || v === null ? "" : v).trim();

  if (!P.filas.length && Array.isArray(req.catalogo) && req.catalogo.length) {
    P.filas = req.catalogo.map((p) => limpiarProducto(p, ahora));
    P.cambio = true;
  }
  const porCodigo = new Map(P.filas.map((p, i) => [txt(p.codigo), i]));

  for (const p of req.productos || []) {
    const c = txt(p.codigo);
    if (!c) continue;
    if (porCodigo.has(c)) {
      const actual = P.filas[porCodigo.get(c)];
      Object.assign(actual, { titulo: p.titulo, autor: p.autor || "", precio: Number(p.precio) || 0, tipo: p.tipo, sinDescuento: !!p.sinDescuento, actualizado: ahora });
    } else {
      porCodigo.set(c, P.filas.length);
      P.filas.push(limpiarProducto(p, ahora));
    }
    P.cambio = true;
  }

  const movAceptados = [];
  const movIds = new Set(M.filas.map((m) => txt(m.id)));
  for (const m of req.movimientos || []) {
    const id = txt(m.id);
    if (!id) continue;
    movAceptados.push(id);
    if (movIds.has(id)) continue; // ya se había recibido: no se vuelve a aplicar
    movIds.add(id);
    M.filas.push({ id, fecha: m.fecha, codigo: txt(m.codigo), cantidad: Number(m.cantidad) || 0, motivo: m.motivo, ventaId: m.ventaId || "", dispositivo: m.dispositivo || req.dispositivo || "", recibidoEn: ahora });
    M.cambio = true;
    const i = porCodigo.get(txt(m.codigo));
    if (i !== undefined) {
      P.filas[i].existencia = (Number(P.filas[i].existencia) || 0) + (Number(m.cantidad) || 0);
      P.filas[i].actualizado = ahora;
      P.cambio = true;
    }
  }

  const ventasAceptadas = [];
  const ventaFila = new Map(V.filas.map((v, i) => [txt(v.id), i]));
  for (const v of req.ventas || []) {
    const id = txt(v.id);
    if (!id) continue;
    ventasAceptadas.push(id);
    const fila = {
      id, folio: v.folio, fecha: v.fecha, dispositivo: v.dispositivo || req.dispositivo || "", cliente: v.cliente || "",
      subtotal: v.subtotal, descuento: (v.descuento && v.descuento.monto) || 0, total: v.total,
      pago: (v.pago && v.pago.metodo) || "", recibido: (v.pago && v.pago.recibido) || 0, cambio: (v.pago && v.pago.cambio) || 0,
      estado: v.estado || "pagada", anuladaEn: v.anuladaEn || "", actualizadoEn: ahora,
      lineas: JSON.stringify({ lineas: v.lineas || [], descuento: v.descuento || {} }),
    };
    if (ventaFila.has(id)) {
      const actual = V.filas[ventaFila.get(id)];
      if (actual.estado !== fila.estado) {
        Object.assign(actual, { estado: fila.estado, anuladaEn: fila.anuladaEn, actualizadoEn: ahora });
        L.filas.forEach((l) => { if (txt(l.ventaId) === id) l.estado = fila.estado; });
        V.cambio = L.cambio = true;
      }
    } else {
      ventaFila.set(id, V.filas.length);
      V.filas.push(fila);
      for (const l of v.lineas || []) {
        L.filas.push({ ventaId: id, folio: v.folio, fecha: v.fecha, dispositivo: fila.dispositivo, codigo: txt(l.codigo), titulo: l.titulo, cantidad: l.cantidad, precio: l.precio, importe: l.importe, estado: fila.estado });
      }
      V.cambio = L.cambio = true;
    }
  }

  const productos = P.filas.map((p) => ({
    codigo: txt(p.codigo), titulo: txt(p.titulo), autor: txt(p.autor), precio: Number(p.precio) || 0,
    existencia: Number(p.existencia) || 0, tipo: txt(p.tipo) || "articulo",
    sinDescuento: p.sinDescuento === true || String(p.sinDescuento).toUpperCase() === "TRUE" || String(p.sinDescuento).toUpperCase() === "VERDADERO",
  })).filter((p) => p.codigo);
  const hashProductos = hashFn(JSON.stringify(productos));

  const desde = txt(req.desde);
  const ventas = V.filas
    .filter((v) => !desde || txt(v.actualizadoEn) > desde)
    .map((v) => {
      let extra = {};
      try { extra = JSON.parse(v.lineas || "{}"); } catch (err) {}
      return {
        id: txt(v.id), folio: Number(v.folio) || 0, fecha: txt(v.fecha), dispositivo: txt(v.dispositivo), cliente: txt(v.cliente),
        lineas: extra.lineas || [], subtotal: Number(v.subtotal) || 0, descuento: extra.descuento || { monto: Number(v.descuento) || 0 },
        total: Number(v.total) || 0, pago: { metodo: txt(v.pago), recibido: Number(v.recibido) || 0, cambio: Number(v.cambio) || 0 },
        estado: txt(v.estado) || "pagada", anuladaEn: txt(v.anuladaEn) || undefined,
      };
    });

  return {
    ok: true, ahora, movimientos: movAceptados, ventasAceptadas, ventas,
    hashProductos, productos: hashProductos === req.hashProductos ? null : productos,
  };
}

function limpiarProducto(p, ahora) {
  return {
    codigo: String(p.codigo).trim(), titulo: p.titulo || "", autor: p.autor || "", precio: Number(p.precio) || 0,
    existencia: Number(p.existencia) || 0, tipo: p.tipo || "articulo", sinDescuento: !!p.sinDescuento, actualizado: ahora,
  };
}

if (typeof module !== "undefined") module.exports = { procesar, COLUMNAS };
