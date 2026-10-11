/* Librería Peregrino · Punto de venta
 * Funciona sin internet: los datos viven en IndexedDB de este navegador.
 * Modelo pensado para crecer (inventario, KPIs, sincronizar PC y celular):
 *   productos   { codigo, titulo, autor, precio, existencia, tipo, sinDescuento, actualizado }
 *   ventas      { id, folio, fecha, cliente, lineas[], subtotal, descuento{}, total, pago{}, estado, dispositivo, sincronizado }
 *   movimientos { id, codigo, cantidad, motivo, ventaId, fecha, dispositivo }  (cada cambio de existencia)
 *   meta        { clave, valor }  (folio, dispositivo, versión del catálogo)
 */
(() => {
  "use strict";

  // ---------- Almacenamiento ----------
  const STORES = { productos: "codigo", ventas: "id", movimientos: "id", meta: "clave" };

  const DB = (() => {
    let db = null;
    const mem = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));

    function open() {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open("peregrino", 1);
          req.onupgradeneeded = () => {
            const d = req.result;
            for (const [name, key] of Object.entries(STORES)) {
              if (!d.objectStoreNames.contains(name)) {
                const os = d.createObjectStore(name, { keyPath: key });
                if (name === "ventas") os.createIndex("fecha", "fecha");
                if (name === "movimientos") os.createIndex("codigo", "codigo");
              }
            }
          };
          req.onsuccess = () => { db = req.result; resolve(true); };
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        } catch (e) { resolve(false); }
      });
    }

    function getAll(store) {
      if (!db) return Promise.resolve([...mem[store].values()]);
      return new Promise((resolve, reject) => {
        const r = db.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }

    // writes: [[store, objeto]] o [[store, null, clave]] para borrar; todo en una sola transacción.
    function write(writes, clearFirst = []) {
      if (!db) {
        clearFirst.forEach((s) => mem[s].clear());
        for (const [s, obj, key] of writes) obj ? mem[s].set(obj[STORES[s]], obj) : mem[s].delete(key);
        return Promise.resolve();
      }
      const names = [...new Set([...writes.map((w) => w[0]), ...clearFirst])];
      if (!names.length) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, "readwrite");
        clearFirst.forEach((s) => tx.objectStore(s).clear());
        for (const [s, obj, key] of writes) obj ? tx.objectStore(s).put(obj) : tx.objectStore(s).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    return { open, getAll, write, get persistent() { return !!db; } };
  })();

  // ---------- Utilidades ----------
  const $ = (s) => document.querySelector(s);
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const fmt = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  const money = (n) => fmt.format(r2(n));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => new Date().toISOString();
  const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const PAGOS = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta" };
  const CODIGOS_PAGO = { "1": "efectivo", "2": "transferencia", "3": "tarjeta" }; // como en el Excel anterior
  const isMobile = () => matchMedia("(max-width: 820px)").matches;

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- Estado ----------
  const S = {
    productos: [], porCodigo: new Map(), ventas: [],
    meta: { folio: 0, dispositivo: "" },
    carrito: [], // { codigo, titulo, precio, cantidad, sinDescuento, tipo, libre }
    desc: { tipo: "pct", valor: 0 }, pago: "efectivo", recibido: null, cliente: "",
  };

  function indexar() {
    S.porCodigo = new Map(S.productos.map((p) => [p.codigo, p]));
    S.productos.forEach((p) => (p._n = norm(p.titulo + " " + (p.autor || "") + " " + p.codigo)));
  }

  async function cargar() {
    const ok = await DB.open();
    if (ok && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const [productos, ventas, meta] = await Promise.all([DB.getAll("productos"), DB.getAll("ventas"), DB.getAll("meta")]);
    meta.forEach((m) => (S.meta[m.clave] = m.valor));
    if (!S.meta.dispositivo) {
      S.meta.dispositivo = (isMobile() ? "CEL-" : "PC-") + uid().slice(0, 4).toUpperCase();
      await DB.write([["meta", { clave: "dispositivo", valor: S.meta.dispositivo }]]);
    }
    if (!productos.length && Array.isArray(window.CATALOGO_INICIAL)) {
      const t = now();
      const seed = window.CATALOGO_INICIAL.map((p) => ({ ...p, actualizado: t }));
      await DB.write([...seed.map((p) => ["productos", p]), ["meta", { clave: "catalogo", valor: "Excel 20-07-26" }]]);
      S.productos = seed;
    } else S.productos = productos;
    S.ventas = ventas.sort((a, b) => b.fecha.localeCompare(a.fecha));
    indexar();
  }

  // ---------- Cálculos ----------
  function calcular() {
    let subtotal = 0, base = 0, piezas = 0;
    for (const l of S.carrito) {
      const imp = r2(l.precio * l.cantidad);
      subtotal += imp;
      if (l.precio > 0) piezas += l.cantidad;
      if (l.precio > 0 && !l.sinDescuento) base += imp;
    }
    const v = Math.max(0, Number(S.desc.valor) || 0);
    let monto = S.desc.tipo === "pct" ? base * Math.min(v, 100) / 100 : Math.min(v, base);
    monto = r2(monto);
    const total = r2(Math.max(0, subtotal - monto));
    return { subtotal: r2(subtotal), base: r2(base), monto, total, piezas };
  }

  // ---------- Catálogo / búsqueda ----------
  function masVendidos(n) {
    const cuenta = new Map();
    for (const v of S.ventas) if (v.estado !== "anulada") for (const l of v.lineas) if (l.precio > 0 && S.porCodigo.has(l.codigo)) cuenta.set(l.codigo, (cuenta.get(l.codigo) || 0) + l.cantidad);
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([c, q]) => ({ p: S.porCodigo.get(c), q }));
  }

  function buscar(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const out = [];
    for (const p of S.productos) {
      if (words.every((w) => p._n.includes(w))) out.push(p);
    }
    const nq = norm(q).trim();
    out.sort((a, b) => (b.codigo === nq) - (a.codigo === nq) || (b.existencia > 0) - (a.existencia > 0) || a.titulo.localeCompare(b.titulo, "es"));
    return out;
  }

  function stockChip(p, extra = "") {
    if (p.tipo === "descuento") return `<span class="chip ok">Descuento</span>`;
    const enCarrito = S.carrito.find((l) => l.codigo === p.codigo)?.cantidad || 0;
    const quedan = p.existencia - enCarrito;
    if (quedan <= 0) return `<span class="chip warn">Sin existencia registrada</span>`;
    if (quedan <= 3) return `<span class="chip warn">Quedan ${quedan}</span>`;
    return `<span class="chip">${quedan} en existencia</span>${extra}`;
  }

  function itemHTML(p, nota = "") {
    return `<li><button class="item${p.tipo === "descuento" ? " is-desc" : ""}" data-add="${esc(p.codigo)}" type="button">
      <span class="t">${esc(p.titulo)}</span>
      <span class="meta">${stockChip(p)}${p.sinDescuento ? '<span class="chip">No aplica descuento</span>' : ""}${nota}</span>
      <span class="c">${esc(p.codigo)}</span><span class="p">${money(p.precio)}</span>
    </button></li>`;
  }

  function renderResultados() {
    const q = $("#q").value;
    const res = buscar(q);
    let titulo, lista, nota = () => "";
    if (res) {
      titulo = res.length ? "Resultados" : "Sin resultados";
      lista = res.slice(0, 60);
      $("#results-count").textContent = res.length > 60 ? `${res.length} encontrados, mostrando 60` : `${res.length} encontrados`;
    } else {
      const top = masVendidos(12);
      if (top.length >= 4) {
        titulo = "Más vendidos"; lista = top.map((t) => t.p);
        const q2 = new Map(top.map((t) => [t.p.codigo, t.q]));
        nota = (p) => `<span class="chip ok">${q2.get(p.codigo)} vendidos</span>`;
      } else {
        titulo = "Con existencia";
        lista = S.productos.filter((p) => p.existencia > 0).sort((a, b) => b.existencia - a.existencia).slice(0, 24);
      }
      $("#results-count").textContent = `${S.productos.length} artículos en catálogo`;
    }
    $("#results-title").textContent = titulo;
    $("#results").innerHTML = lista.length
      ? lista.map((p) => itemHTML(p, nota(p))).join("")
      : `<li class="none">No encontré “${esc(q)}”. Revisa la ortografía o agrégalo como artículo libre.</li>`;
  }

  // ---------- Carrito ----------
  function agregar(p, cantidad = 1) {
    const l = S.carrito.find((x) => x.codigo === p.codigo && !x.libre);
    if (l) l.cantidad += cantidad;
    else S.carrito.push({ codigo: p.codigo, titulo: p.titulo, precio: p.precio, cantidad, sinDescuento: !!p.sinDescuento, tipo: p.tipo, libre: !!p.libre });
    render();
    if (isMobile() && !$("#ticket").classList.contains("open")) toast(`Agregado: ${p.titulo}`);
  }

  function enterBusqueda() {
    const q = $("#q").value.trim();
    if (!q) return;
    if (CODIGOS_PAGO[q]) { setPago(CODIGOS_PAGO[q]); $("#q").value = ""; renderResultados(); return; }
    const exacto = S.porCodigo.get(q);
    if (exacto) { agregar(exacto); $("#q").value = ""; renderResultados(); return; }
    const res = buscar(q);
    if (res && res.length === 1) { agregar(res[0]); $("#q").value = ""; renderResultados(); return; }
    if (res && res.length > 1) { $("#results .item")?.focus(); return; }
    if (/^\d{4,}$/.test(q)) dialogoLibre(q);
    else toast(`No encontré “${q}”.`);
  }

  function renderCarrito() {
    const ul = $("#lines");
    $("#empty").hidden = S.carrito.length > 0;
    ul.innerHTML = S.carrito.map((l, i) => `<li class="line">
      <span class="t">${esc(l.titulo)}</span>
      <span class="amt">${money(l.precio * l.cantidad)}</span>
      <span class="sub">
        ${l.tipo === "descuento" ? "" : `<span class="qty">
          <button type="button" data-dec="${i}" aria-label="Quitar uno">−</button>
          <input type="number" min="1" step="1" inputmode="numeric" value="${l.cantidad}" data-qty="${i}" id="qty-${i}" aria-label="Cantidad">
          <button type="button" data-inc="${i}" aria-label="Agregar uno">+</button>
        </span>`}
        <span class="mono">${money(l.precio)}${l.tipo === "descuento" ? "" : " c/u"}</span>
        ${l.sinDescuento ? '<span class="chip">Sin descuento</span>' : ""}
        ${l.libre ? '<span class="chip">Libre</span>' : ""}
      </span>
      <button type="button" class="rm" data-rm="${i}">Quitar</button>
    </li>`).join("");
  }

  function renderTotales() {
    const c = calcular();
    $("#t-sub").textContent = money(c.subtotal);
    $("#row-desc").hidden = !c.monto;
    $("#t-desc").textContent = "−" + money(c.monto);
    $("#t-total").textContent = money(c.total);
    $("#mb-total").textContent = money(c.total);
    $("#mb-items").textContent = `${c.piezas} ${c.piezas === 1 ? "artículo" : "artículos"}`;

    const efectivo = S.pago === "efectivo";
    $("#cash").hidden = !efectivo;
    const rec = S.recibido;
    const ch = $("#change");
    ch.classList.remove("bad");
    if (!efectivo || !S.carrito.length) ch.innerHTML = "";
    else if (rec == null || rec === "") ch.innerHTML = `<span class="muted">Si te pagan exacto, deja Recibido vacío.</span>`;
    else if (rec < c.total) { ch.classList.add("bad"); ch.textContent = `Faltan ${money(c.total - rec)}`; }
    else ch.innerHTML = `Cambio <strong>${money(rec - c.total)}</strong>`;

    const sug = [...new Set([50, 100, 200, 500, 1000].map((b) => Math.ceil(c.total / b) * b).filter((v) => v > c.total))].slice(0, 4);
    $("#quick").innerHTML = c.total > 0 ? sug.map((v) => `<button type="button" data-rec="${v}">${money(v).replace(".00", "")}</button>`).join("") : "";

    const falta = efectivo && rec != null && rec !== "" && rec < c.total;
    $("#btn-cobrar").disabled = !S.carrito.length || falta;
    $("#btn-cobrar").textContent = S.carrito.length ? `Cobrar ${money(c.total)}` : "Cobrar";
  }

  function render() { renderCarrito(); renderTotales(); renderResultados(); }

  function setPago(m) {
    S.pago = m;
    document.querySelectorAll("[data-pago]").forEach((b) => b.classList.toggle("is-on", b.dataset.pago === m));
    if (m !== "efectivo") { S.recibido = null; $("#recibido").value = ""; }
    renderTotales();
  }

  // ---------- Cobrar ----------
  async function cobrar() {
    if (!S.carrito.length) return;
    const c = calcular();
    if (S.pago === "efectivo" && S.recibido != null && S.recibido !== "" && S.recibido < c.total) return;
    const fecha = now();
    const folio = (Number(S.meta.folio) || 0) + 1;
    const recibido = S.pago === "efectivo" ? (S.recibido == null || S.recibido === "" ? c.total : r2(S.recibido)) : c.total;
    const venta = {
      id: uid(), folio, fecha, cliente: S.cliente.trim(),
      lineas: S.carrito.map((l) => ({ codigo: l.codigo, titulo: l.titulo, cantidad: l.cantidad, precio: l.precio, importe: r2(l.precio * l.cantidad), sinDescuento: l.sinDescuento, libre: l.libre })),
      subtotal: c.subtotal, descuento: { tipo: S.desc.tipo, valor: Number(S.desc.valor) || 0, monto: c.monto }, total: c.total,
      pago: { metodo: S.pago, recibido, cambio: r2(recibido - c.total) },
      estado: "pagada", dispositivo: S.meta.dispositivo, sincronizado: false,
    };
    const writes = [["ventas", venta], ["meta", { clave: "folio", valor: folio }]];
    const cambios = [];
    for (const l of venta.lineas) {
      const p = S.porCodigo.get(l.codigo);
      if (!p || p.tipo === "descuento" || l.libre) continue;
      const nuevo = { ...p, existencia: p.existencia - l.cantidad, actualizado: fecha };
      delete nuevo._n;
      cambios.push([p, nuevo.existencia]);
      writes.push(["productos", nuevo]);
      writes.push(["movimientos", { id: uid(), codigo: l.codigo, cantidad: -l.cantidad, motivo: "venta", ventaId: venta.id, fecha, dispositivo: S.meta.dispositivo, sincronizado: false }]);
    }
    try {
      await DB.write(writes);
    } catch (e) {
      toast("No se pudo guardar la venta. Intenta de nuevo.");
      return;
    }
    cambios.forEach(([p, ex]) => (p.existencia = ex));
    S.meta.folio = folio;
    S.ventas.unshift(venta);
    limpiarVenta();
    programarSync();
    $("#ticket").classList.remove("open");
    hoja(`<div class="done-mark" aria-hidden="true">✓</div>
      <h3 id="sheet-title">Venta ${folioTxt(venta)} registrada</h3>
      <p class="muted">${PAGOS[venta.pago.metodo]} · ${money(venta.total)}${venta.cliente ? " · " + esc(venta.cliente) : ""}</p>
      ${venta.pago.metodo === "efectivo" && venta.pago.cambio > 0 ? `<div>Cambio<div class="big-num">${money(venta.pago.cambio)}</div></div>` : ""}
      <div class="row"><button class="btn primary" data-close type="button" id="btn-nueva">Nueva venta</button></div>`);
    $("#btn-nueva").focus();
  }

  const folioTxt = (v) => (v.dispositivo || "").split("-")[0] + "-" + String(v.folio).padStart(4, "0");

  function limpiarVenta() {
    S.carrito = []; S.desc.valor = 0; S.recibido = null; S.cliente = "";
    $("#desc-valor").value = ""; $("#recibido").value = ""; $("#cliente").value = "";
    setPago("efectivo");
    render();
  }

  // ---------- Diálogos ----------
  let alCerrar = null;
  function hoja(html, onClose) {
    $("#sheet").innerHTML = html;
    $("#overlay").hidden = false;
    alCerrar = onClose || null;
  }
  function cerrarHoja() {
    $("#overlay").hidden = true;
    $("#sheet").innerHTML = "";
    const f = alCerrar; alCerrar = null;
    if (f) f();
    if (!$("#view-vender").hidden && !isMobile()) $("#q").focus();
  }

  function dialogoLibre(codigo = "") {
    hoja(`<h3 id="sheet-title">Artículo libre</h3>
      <p class="muted">${codigo ? `El código ${esc(codigo)} no está en el catálogo. ` : ""}Escribe qué es y su precio.</p>
      <form id="f-libre" class="cash">
        <label>Descripción<input type="text" id="l-titulo" required autocomplete="off"></label>
        <label>Precio<input type="number" id="l-precio" step="any" inputmode="decimal" required></label>
        <label>Código<input type="text" id="l-codigo" value="${esc(codigo)}" autocomplete="off" placeholder="Opcional"></label>
        <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="l-guardar" ${codigo ? "checked" : ""}> Guardar en el catálogo</label>
        <div class="row"><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">Agregar</button></div>
      </form>`);
    $("#l-titulo").focus();
    $("#f-libre").addEventListener("submit", async (e) => {
      e.preventDefault();
      const titulo = $("#l-titulo").value.trim();
      const precio = r2(Number($("#l-precio").value));
      if (!titulo || !isFinite(precio)) return;
      let cod = $("#l-codigo").value.trim();
      const guardar = $("#l-guardar").checked;
      if (guardar) {
        if (!cod) cod = "L" + Date.now().toString().slice(-8);
        if (S.porCodigo.has(cod)) { toast(`El código ${cod} ya existe.`); return; }
        const p = { codigo: cod, titulo, autor: "", precio, existencia: 0, tipo: precio < 0 ? "descuento" : (/^97\d{11}$/.test(cod) ? "libro" : "articulo"), sinDescuento: false, actualizado: now(), pendiente: true };
        await DB.write([["productos", p]]);
        programarSync();
        S.productos.push(p); indexar();
        cerrarHoja(); agregar(p);
        toast(`Guardado en el catálogo: ${titulo}`);
      } else {
        cerrarHoja();
        agregar({ codigo: cod || "LIBRE-" + uid().slice(0, 6), titulo, precio, tipo: precio < 0 ? "descuento" : "articulo", libre: true });
      }
      $("#q").value = ""; renderResultados();
    });
  }

  // ---------- Ventas del día ----------
  function renderVentas() {
    const dia = $("#fecha").value || dayKey(now());
    const lista = S.ventas.filter((v) => dayKey(v.fecha) === dia);
    const ok = lista.filter((v) => v.estado !== "anulada");
    const total = r2(ok.reduce((s, v) => s + v.total, 0));
    const piezas = ok.reduce((s, v) => s + v.lineas.reduce((a, l) => a + (l.precio > 0 ? l.cantidad : 0), 0), 0);
    const por = (m) => r2(ok.filter((v) => v.pago.metodo === m).reduce((s, v) => s + v.total, 0));
    $("#kpis").innerHTML = `
      <div class="kpi"><span>Vendido</span><strong>${money(total)}</strong><small>${ok.length} ${ok.length === 1 ? "venta" : "ventas"}${lista.length > ok.length ? ` · ${lista.length - ok.length} anulada(s)` : ""}</small></div>
      <div class="kpi"><span>Ticket promedio</span><strong>${money(ok.length ? total / ok.length : 0)}</strong><small>${piezas} artículos vendidos</small></div>
      <div class="kpi"><span>Efectivo</span><strong>${money(por("efectivo"))}</strong><small>Debe haber en caja</small></div>
      <div class="kpi"><span>Transferencia y tarjeta</span><strong>${money(por("transferencia") + por("tarjeta"))}</strong><small>${money(por("transferencia"))} transf. · ${money(por("tarjeta"))} tarjeta</small></div>`;
    $("#sales").innerHTML = lista.length ? lista.map((v) => `<li class="sale${v.estado === "anulada" ? " anulada" : ""}">
        <button type="button" data-venta="${v.id}" aria-expanded="false">
          <span class="hr">${hora(v.fecha)}</span>
          <span class="who">${folioTxt(v)} · ${esc(v.cliente || PAGOS[v.pago.metodo])} <span class="muted">· ${v.lineas.length} ${v.lineas.length === 1 ? "línea" : "líneas"}${v.estado === "anulada" ? " · anulada" : ""}</span></span>
          <span class="tot">${money(v.total)}</span>
        </button>
      </li>`).join("") : `<li class="none">No hay ventas registradas este día.</li>`;
  }

  function detalleVenta(li, v) {
    const abierta = li.querySelector(".sale-detail");
    li.querySelector("button").setAttribute("aria-expanded", String(!abierta));
    if (abierta) { abierta.remove(); return; }
    const d = document.createElement("div");
    d.className = "sale-detail";
    d.innerHTML = `<table><tbody>${v.lineas.map((l) => `<tr><td>${l.cantidad} × ${esc(l.titulo)}</td><td class="n">${money(l.importe)}</td></tr>`).join("")}
      ${v.descuento.monto ? `<tr><td>Descuento${v.descuento.tipo === "pct" ? ` ${v.descuento.valor}%` : ""}</td><td class="n">−${money(v.descuento.monto)}</td></tr>` : ""}
      <tr><td><b>Total · ${PAGOS[v.pago.metodo]}</b>${v.pago.metodo === "efectivo" ? ` <span class="muted">(recibido ${money(v.pago.recibido)}, cambio ${money(v.pago.cambio)})</span>` : ""}</td><td class="n"><b>${money(v.total)}</b></td></tr>
      </tbody></table>
      <div class="acts">${v.estado === "anulada" ? `<span class="muted">Anulada ${v.anuladaEn ? hora(v.anuladaEn) : ""}. Los artículos regresaron al inventario.</span>` : `<button class="btn danger" type="button" data-anular="${v.id}">Anular venta</button>`}</div>`;
    li.appendChild(d);
  }

  async function anular(v, acts) {
    if (!acts.dataset.confirm) {
      acts.dataset.confirm = "1";
      acts.innerHTML = `<span>¿Anular ${folioTxt(v)}? Los artículos regresan al inventario.</span>
        <button class="btn" type="button" data-noanular>No</button><button class="btn danger" type="button" data-anular="${v.id}">Sí, anular</button>`;
      return;
    }
    const fecha = now();
    const nv = { ...v, estado: "anulada", anuladaEn: fecha, sincronizado: false };
    const writes = [["ventas", nv]];
    const cambios = [];
    for (const l of v.lineas) {
      const p = S.porCodigo.get(l.codigo);
      if (!p || p.tipo === "descuento" || l.libre) continue;
      const np = { ...p, existencia: p.existencia + l.cantidad, actualizado: fecha };
      delete np._n;
      cambios.push([p, np.existencia]);
      writes.push(["productos", np], ["movimientos", { id: uid(), codigo: l.codigo, cantidad: l.cantidad, motivo: "anulación", ventaId: v.id, fecha, dispositivo: S.meta.dispositivo, sincronizado: false }]);
    }
    await DB.write(writes);
    cambios.forEach(([p, ex]) => (p.existencia = ex));
    Object.assign(v, nv);
    renderVentas();
    programarSync();
    toast(`Venta ${folioTxt(v)} anulada`);
  }

  // ---------- Respaldo ----------
  function descargar(nombre, contenido, tipo) {
    const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    const a = document.createElement("a");
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function renderMas() {
    const mov = await DB.getAll("movimientos");
    $("#stats").innerHTML = `<span><b>${S.productos.length}</b> artículos</span><span><b>${S.ventas.length}</b> ventas</span><span><b>${mov.length}</b> movimientos</span><span>Equipo <b>${esc(S.meta.dispositivo)}</b></span>${DB.persistent ? "" : "<span>Modo de prueba: este navegador no permite guardar</span>"}`;
  }

  async function respaldo() {
    const data = { app: "peregrino", version: 1, exportado: now(), dispositivo: S.meta.dispositivo };
    for (const s of Object.keys(STORES)) data[s] = await DB.getAll(s);
    descargar(`peregrino-respaldo-${dayKey(now())}.json`, JSON.stringify(data), "application/json");
    $("#mas-msg").textContent = "Respaldo descargado. Guárdalo en una memoria USB o en tu nube.";
  }

  function csv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const filas = [["Folio", "Fecha", "Hora", "Cliente", "Pago", "Estado", "Código", "Título", "Cantidad", "Precio", "Importe", "Descuento venta", "Total venta", "Equipo"]];
    for (const v of [...S.ventas].reverse()) for (const l of v.lineas)
      filas.push([v.folio, dayKey(v.fecha), hora(v.fecha), v.cliente, PAGOS[v.pago.metodo], v.estado, l.codigo, l.titulo, l.cantidad, l.precio, l.importe, v.descuento.monto, v.total, v.dispositivo]);
    descargar(`peregrino-ventas-${dayKey(now())}.csv`, "﻿" + filas.map((f) => f.map(q).join(",")).join("\r\n"), "text/csv");
    $("#mas-msg").textContent = "Archivo de ventas descargado. Ábrelo con Excel.";
  }

  function restaurar(file) {
    const fr = new FileReader();
    fr.onload = () => {
      let data;
      try { data = JSON.parse(fr.result); } catch (e) { data = null; }
      if (!data || data.app !== "peregrino" || !Array.isArray(data.productos)) {
        $("#mas-msg").textContent = "Ese archivo no es un respaldo de Peregrino.";
        return;
      }
      hoja(`<h3 id="sheet-title">Restaurar respaldo</h3>
        <p>Del ${new Date(data.exportado).toLocaleString("es-MX")}: ${data.productos.length} artículos y ${data.ventas.length} ventas.</p>
        <p class="muted">Esto reemplaza todo lo que hay ahora en este equipo.</p>
        <div class="row"><button class="btn" type="button" data-close>Cancelar</button><button class="btn danger" type="button" id="btn-restaurar-ok">Reemplazar datos</button></div>`);
      $("#btn-restaurar-ok").addEventListener("click", async () => {
        const writes = [];
        for (const s of Object.keys(STORES)) (data[s] || []).forEach((o) => writes.push([s, o]));
        await DB.write(writes, Object.keys(STORES));
        cerrarHoja();
        await cargar(); render(); renderMas(); renderSyncPanel(); estadoSync();
        $("#mas-msg").textContent = "Respaldo restaurado.";
      });
    };
    fr.readAsText(file);
  }


  // ---------- Sincronización con Google Sheets ----------
  // La app manda ventas y movimientos pendientes; la hoja devuelve precios y existencias de todos los equipos.
  let syncEnCurso = false, syncOtraVez = false, syncTimer, syncError = "";
  const sinFlags = ({ _n, pendiente, ...p }) => p;

  function programarSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sincronizar(), 1500); estadoSync(); }

  async function pendientes() {
    const movs = (await DB.getAll("movimientos")).filter((m) => !m.sincronizado);
    const ventas = S.ventas.filter((v) => !v.sincronizado);
    return { movs, ventas, productos: S.productos.filter((p) => p.pendiente) };
  }

  async function estadoSync(texto) {
    const n = $("#net");
    const cfg = S.meta.sync;
    n.classList.remove("off");
    if (!cfg || !cfg.url) {
      n.classList.toggle("off", !navigator.onLine);
      n.textContent = navigator.onLine ? "Guardado en este equipo" : "Sin internet · se guarda igual";
      n.title = "Todo se guarda en este equipo";
      return;
    }
    const pend = S.ventas.filter((v) => !v.sincronizado).length;
    if (texto) { n.textContent = texto; return; }
    if (!navigator.onLine) { n.classList.add("off"); n.textContent = pend ? `Sin internet · ${pend} por subir` : "Sin internet · se guarda igual"; return; }
    if (syncError) { n.classList.add("off"); n.textContent = "No se pudo sincronizar"; n.title = syncError; return; }
    n.title = "Sincronizado con Google Sheets";
    n.textContent = pend ? `${pend} por subir` : S.meta.ultimaSync ? `Sincronizado ${hora(S.meta.ultimaSync)}` : "Conectado";
  }

  async function sincronizar(manual = false) {
    const cfg = S.meta.sync;
    if (!cfg || !cfg.url) return false;
    if (!navigator.onLine) { estadoSync(); return false; }
    if (syncEnCurso) { syncOtraVez = true; return false; }
    syncEnCurso = true;
    estadoSync("Sincronizando…");
    let ok = false;
    try {
      const { movs, ventas, productos } = await pendientes();
      const enviadas = new Map(ventas.map((v) => [v.id, v.estado]));
      const req = {
        clave: cfg.clave, dispositivo: S.meta.dispositivo, desde: S.meta.ultimaSync || "", hashProductos: S.meta.hashProductos || "",
        ventas: ventas.map(({ sincronizado, ...v }) => v), movimientos: movs.map(({ sincronizado, ...m }) => m), productos: productos.map(sinFlags),
      };
      if (!S.meta.ultimaSync) {
        // Primer equipo en conectarse: la hoja arranca con este catálogo (existencia antes de las ventas pendientes, que se aplican aparte).
        const delta = new Map();
        movs.forEach((m) => delta.set(m.codigo, (delta.get(m.codigo) || 0) + m.cantidad));
        req.catalogo = S.productos.map((p) => ({ ...sinFlags(p), existencia: p.existencia - (delta.get(p.codigo) || 0) }));
      }
      const resp = await fetch(cfg.url, { method: "POST", body: JSON.stringify(req), headers: { "Content-Type": "text/plain;charset=utf-8" } });
      let r;
      try { r = await resp.json(); } catch (e) { throw new Error("La dirección no es la de tu hoja de Peregrino. Revisa que copiaste la URL de la aplicación web."); }
      if (!r.ok) throw new Error(r.error === "clave" ? "La clave no coincide con la que pusiste en el script de la hoja." : "La hoja respondió con un error.");

      const writes = [];
      const ackV = new Set(r.ventasAceptadas || []);
      for (const v of S.ventas) if (ackV.has(v.id) && enviadas.get(v.id) === v.estado && !v.sincronizado) { v.sincronizado = true; writes.push(["ventas", v]); }
      const ackM = new Set(r.movimientos || []);
      for (const m of movs) if (ackM.has(m.id)) writes.push(["movimientos", { ...m, sincronizado: true }]);
      const enviados = new Set(productos.map((p) => p.codigo));
      for (const p of S.productos) if (p.pendiente && enviados.has(p.codigo)) { p.pendiente = false; writes.push(["productos", sinFlags(p)]); }
      for (const sv of r.ventas || []) {
        const local = S.ventas.find((v) => v.id === sv.id);
        if (!local) { const nv = { ...sv, sincronizado: true }; S.ventas.push(nv); writes.push(["ventas", nv]); }
        else if (local.sincronizado && local.estado !== sv.estado) { Object.assign(local, { estado: sv.estado, anuladaEn: sv.anuladaEn }); writes.push(["ventas", local]); }
      }
      S.meta.ultimaSync = r.ahora; S.meta.hashProductos = r.hashProductos;
      writes.push(["meta", { clave: "ultimaSync", valor: r.ahora }], ["meta", { clave: "hashProductos", valor: r.hashProductos }]);
      await DB.write(writes);

      if (Array.isArray(r.productos)) {
        // Existencia de la hoja + lo que este equipo vendió y aún no sube (p. ej. una venta hecha mientras se sincronizaba).
        const delta = new Map();
        (await DB.getAll("movimientos")).filter((m) => !m.sincronizado).forEach((m) => delta.set(m.codigo, (delta.get(m.codigo) || 0) + m.cantidad));
        const t = now();
        const deHoja = r.productos.map((p) => ({ ...p, existencia: p.existencia + (delta.get(p.codigo) || 0), actualizado: t }));
        const codigos = new Set(deHoja.map((p) => p.codigo));
        const locales = S.productos.filter((p) => p.pendiente && !codigos.has(p.codigo)).map((p) => ({ ...sinFlags(p), pendiente: true }));
        const todos = [...deHoja, ...locales];
        await DB.write(todos.map((p) => ["productos", p]), ["productos"]);
        S.productos = todos;
        indexar();
      }
      S.ventas.sort((a, b) => b.fecha.localeCompare(a.fecha));
      syncError = "";
      ok = true;
      render();
      if (!$("#view-ventas").hidden) renderVentas();
      if (manual) toast("Sincronizado con Google Sheets");
    } catch (e) {
      syncError = e && e.message && !/fetch|network|load/i.test(e.message) ? e.message : "No hubo respuesta de Google. Se reintentará solo.";
      if (manual) toast(syncError);
    } finally {
      syncEnCurso = false;
      estadoSync();
      if (!$("#view-mas").hidden) renderSyncPanel();
      if (syncOtraVez) { syncOtraVez = false; programarSync(); }
    }
    return ok;
  }

  function renderSyncPanel() {
    const cfg = S.meta.sync;
    const conectado = !!(cfg && cfg.url);
    $("#sync-form").hidden = conectado;
    $("#sync-on").hidden = !conectado;
    const pend = S.ventas.filter((v) => !v.sincronizado).length;
    if (conectado) {
      $("#sync-estado").textContent = syncError ? syncError
        : `${S.meta.ultimaSync ? "Última sincronización: " + new Date(S.meta.ultimaSync).toLocaleString("es-MX") : "Aún no se sincroniza."}${pend ? ` · ${pend} venta(s) por subir.` : ""}`;
    } else {
      $("#sync-subir").hidden = !S.ventas.length;
      $("#sync-subir-txt").textContent = `Borrar las ${S.ventas.length} venta(s) de prueba de este equipo antes de conectar`;
    }
  }

  async function conectar() {
    const url = $("#sync-url").value.trim();
    const clave = $("#sync-clave").value.trim();
    const msg = $("#sync-msg");
    msg.textContent = "Conectando…";
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { msg.textContent = "Pega la URL de la aplicación web; empieza con https://script.google.com/"; return; }
    if (!clave) { msg.textContent = "Escribe la clave que pusiste en el script."; return; }
    if ($("#sync-borrar").checked && S.ventas.length) {
      // Quita las ventas de prueba y regresa sus artículos a la existencia.
      const movs = await DB.getAll("movimientos");
      const delta = new Map();
      movs.forEach((m) => delta.set(m.codigo, (delta.get(m.codigo) || 0) + m.cantidad));
      const prods = S.productos.filter((p) => delta.has(p.codigo)).map((p) => { p.existencia -= delta.get(p.codigo); return ["productos", sinFlags(p)]; });
      await DB.write([...prods, ["meta", { clave: "folio", valor: 0 }]], ["ventas", "movimientos"]);
      S.ventas = []; S.meta.folio = 0;
    }
    S.meta.sync = { url, clave };
    S.meta.ultimaSync = ""; S.meta.hashProductos = "";
    await DB.write([["meta", { clave: "sync", valor: S.meta.sync }], ["meta", { clave: "ultimaSync", valor: "" }], ["meta", { clave: "hashProductos", valor: "" }]]);
    const ok = await sincronizar(true);
    msg.textContent = "";
    if (!ok) {
      S.meta.sync = null;
      await DB.write([["meta", { clave: "sync", valor: null }]]);
      msg.textContent = syncError;
      syncError = "";
      estadoSync();
    }
    renderSyncPanel(); renderMas();
  }

  async function desconectar() {
    S.meta.sync = null;
    await DB.write([["meta", { clave: "sync", valor: null }]]);
    syncError = "";
    renderSyncPanel(); estadoSync();
    toast("Este equipo ya no se sincroniza");
  }

  // ---------- Navegación ----------
  function vista(v) {
    for (const n of ["vender", "ventas", "mas"]) {
      $(`#view-${n}`).hidden = n !== v;
      $(`#tab-${n}`).classList.toggle("is-active", n === v);
    }
    if (v === "ventas") renderVentas();
    if (v === "mas") { renderMas(); renderSyncPanel(); }
    if (v === "vender" && !isMobile()) $("#q").focus();
  }


  // ---------- Eventos ----------
  function eventos() {
    $("#q").addEventListener("input", renderResultados);
    $("#q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); enterBusqueda(); }
      if (e.key === "ArrowDown") { e.preventDefault(); $("#results .item")?.focus(); }
      if (e.key === "Escape") { $("#q").value = ""; renderResultados(); }
    });
    $("#results").addEventListener("click", (e) => {
      const b = e.target.closest("[data-add]");
      if (!b) return;
      agregar(S.porCodigo.get(b.dataset.add));
      if (!isMobile()) { $("#q").select(); $("#q").focus(); }
    });
    $("#results").addEventListener("keydown", (e) => {
      const items = [...document.querySelectorAll("#results .item")];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, Math.round($("#results").clientWidth / items[0].offsetWidth));
      const go = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (go) { e.preventDefault(); (items[i + go] || (go < 0 ? $("#q") : null))?.focus(); }
    });
    $("#btn-libre").addEventListener("click", () => dialogoLibre(/^\d{4,}$/.test($("#q").value.trim()) ? $("#q").value.trim() : ""));

    $("#lines").addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const d = t.dataset;
      if (d.inc) S.carrito[d.inc].cantidad++;
      else if (d.dec) { const l = S.carrito[d.dec]; if (l.cantidad > 1) l.cantidad--; else S.carrito.splice(d.dec, 1); }
      else if (d.rm) S.carrito.splice(d.rm, 1);
      else return;
      render();
    });
    $("#lines").addEventListener("change", (e) => {
      const i = e.target.dataset.qty;
      if (i == null) return;
      const n = Math.floor(Number(e.target.value));
      if (n > 0) S.carrito[i].cantidad = n; else S.carrito.splice(i, 1);
      render();
    });
    $("#btn-vaciar").addEventListener("click", () => { if (S.carrito.length) { limpiarVenta(); toast("Venta vaciada"); } });
    $("#cliente").addEventListener("input", (e) => (S.cliente = e.target.value));
    $("#desc-valor").addEventListener("input", (e) => { S.desc.valor = e.target.value; renderTotales(); });
    document.querySelectorAll("[data-desc]").forEach((b) => b.addEventListener("click", () => {
      S.desc.tipo = b.dataset.desc;
      document.querySelectorAll("[data-desc]").forEach((x) => x.classList.toggle("is-on", x === b));
      renderTotales();
    }));
    document.querySelectorAll("[data-pago]").forEach((b) => b.addEventListener("click", () => setPago(b.dataset.pago)));
    $("#recibido").addEventListener("input", (e) => { S.recibido = e.target.value === "" ? null : Number(e.target.value); renderTotales(); });
    $("#recibido").addEventListener("keydown", (e) => { if (e.key === "Enter") cobrar(); });
    $("#quick").addEventListener("click", (e) => {
      const v = e.target.closest("[data-rec]")?.dataset.rec;
      if (v) { S.recibido = Number(v); $("#recibido").value = v; renderTotales(); }
    });
    $("#btn-cobrar").addEventListener("click", cobrar);
    $("#mobile-bar").addEventListener("click", () => $("#ticket").classList.toggle("open"));
    $("#btn-cerrar-ticket").addEventListener("click", () => $("#ticket").classList.remove("open"));

    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => vista(t.dataset.view)));
    $("#fecha").addEventListener("change", renderVentas);
    $("#sales").addEventListener("click", (e) => {
      const an = e.target.closest("[data-anular]");
      if (an) { anular(S.ventas.find((v) => v.id === an.dataset.anular), an.closest(".acts")); return; }
      if (e.target.closest("[data-noanular]")) { const li = e.target.closest(".sale"); li.querySelector(".sale-detail").remove(); detalleVenta(li, S.ventas.find((v) => v.id === li.querySelector("[data-venta]").dataset.venta)); return; }
      const b = e.target.closest("[data-venta]");
      if (b) detalleVenta(b.closest(".sale"), S.ventas.find((v) => v.id === b.dataset.venta));
    });

    $("#btn-respaldo").addEventListener("click", respaldo);
    $("#btn-csv").addEventListener("click", csv);
    $("#file-restaurar").addEventListener("change", (e) => { if (e.target.files[0]) restaurar(e.target.files[0]); e.target.value = ""; });

    $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay" || e.target.closest("[data-close]")) cerrarHoja(); });
    document.addEventListener("keydown", (e) => {
      if (!$("#overlay").hidden) { if (e.key === "Escape") cerrarHoja(); return; }
      if (e.key === "F2") { e.preventDefault(); vista("vender"); $("#q").focus(); $("#q").select(); }
      if (e.key === "F9") { e.preventDefault(); cobrar(); }
    });
    addEventListener("online", () => sincronizar());
    addEventListener("offline", () => estadoSync());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sincronizar(); });
    setInterval(() => { if (document.visibilityState === "visible") sincronizar(); }, 3 * 60 * 1000);
    $("#btn-conectar").addEventListener("click", conectar);
    $("#btn-sync-ahora").addEventListener("click", () => sincronizar(true));
    $("#btn-desconectar").addEventListener("click", desconectar);
  }

  async function iniciar() {
    $("#fecha").value = dayKey(now());
    if (isMobile()) $("#q").placeholder = "Busca título o código";
    eventos();
    await cargar();
    render();
    estadoSync();
    sincronizar();
    if (!isMobile()) $("#q").focus();
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  iniciar();
})();
