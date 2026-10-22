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
    if (quedan <= 0) return `<span class="chip bad">Sin existencia</span>`;
    if (quedan <= 3) return `<span class="chip warn">Quedan ${quedan}</span>`;
    return `<span class="chip ok">${quedan} en existencia</span>${extra}`;
  }

  function itemHTML(p, nota = "") {
    const ex = p.existencia - (S.carrito.find((l) => l.codigo === p.codigo)?.cantidad || 0);
    const est = p.tipo === "descuento" ? " is-desc" : ex <= 0 ? " agotado" : ex <= 3 ? " poco" : "";
    return `<li><button class="item${est}" data-add="${esc(p.codigo)}" type="button">
      <span class="t">${esc(p.titulo)}</span>
      <span class="meta">${stockChip(p)}${p.sinDescuento ? '<span class="chip">No aplica descuento</span>' : ""}${nota}</span>
      <span class="c">${esc(p.codigo)}</span>${sinPrecio(p) ? '<span class="p sinp">Sin precio</span>' : `<span class="p">${money(p.precio)}</span>`}
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
    const enCarrito = S.carrito.find((x) => x.codigo === p.codigo && !x.libre);
    if (!p.libre && sinPrecio(p) && !enCarrito) return dialogoPrecioVenta(p, cantidad);
    agregarLinea(p, enCarrito ? enCarrito.precio : p.precio, cantidad);
  }

  function agregarLinea(p, precio, cantidad = 1) {
    const l = S.carrito.find((x) => x.codigo === p.codigo && !x.libre);
    if (l) l.cantidad += cantidad;
    else S.carrito.push({ codigo: p.codigo, titulo: p.titulo, precio, cantidad, sinDescuento: !!p.sinDescuento, tipo: p.tipo, libre: !!p.libre });
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
    $("#sheet").classList.remove("wide");
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

  // Borra ventas, movimientos, catálogo y conexión de este equipo y vuelve al catálogo inicial (el del Excel).
  function dialogoCero() {
    hoja(`<h3 id="sheet-title">Empezar de cero</h3>
      <p>Se borran de este equipo todas las ventas, movimientos de inventario, cambios al catálogo y la conexión con Google Sheets. La app vuelve al catálogo del Excel original.</p>
      <p class="muted">Tu hoja de Google no se toca. Si quieres conservar algo, descarga un respaldo antes.</p>
      <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="cero-ok"> Entiendo que esto no se puede deshacer</label>
      <div class="row"><button class="btn" type="button" data-close>Cancelar</button><button class="btn danger" type="button" id="btn-cero-ok" disabled>Borrar todo</button></div>`);
    $("#cero-ok").addEventListener("change", (e) => ($("#btn-cero-ok").disabled = !e.target.checked));
    $("#btn-cero-ok").addEventListener("click", async () => {
      await DB.write([["meta", { clave: "dispositivo", valor: S.meta.dispositivo }]], Object.keys(STORES));
      location.reload();
    });
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




  // ---------- Tablero de ventas (gráficas) ----------
  S.periodo = 7;
  const DIA = 86400000;
  const inicioDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const inicioSemana = (d) => { const x = inicioDia(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }; // lunes
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const compacto = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(".0", "")}M` : n >= 1000 ? `$${(Math.round(n / 100) / 10).toString()}K` : `$${Math.round(n)}`;
  const vigentes = () => S.ventas.filter((v) => v.estado !== "anulada");
  const piezasDe = (v) => v.lineas.reduce((a, l) => a + (l.precio > 0 ? l.cantidad : 0), 0);

  function resumenPeriodo(desde, hasta) {
    const ventas = vigentes().filter((v) => { const t = new Date(v.fecha); return t >= desde && t < hasta; });
    const total = r2(ventas.reduce((s, v) => s + v.total, 0));
    return { ventas, total, n: ventas.length, piezas: ventas.reduce((s, v) => s + piezasDe(v), 0), ticket: ventas.length ? total / ventas.length : 0 };
  }

  function delta(actual, antes) {
    if (!antes) return actual ? `<small class="delta">Sin ventas en el periodo anterior</small>` : `<small class="delta">&nbsp;</small>`;
    const pct = Math.round(((actual - antes) / antes) * 100);
    const cls = pct > 0 ? "sube" : pct < 0 ? "baja" : "";
    return `<small class="delta ${cls}">${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)}% vs periodo anterior</small>`;
  }

  // Columnas verticales: una sola serie, eje en pesos, el periodo en curso se marca como parcial.
  function columnas(el, datos, titulo) {
    const W = Math.max(280, el.clientWidth || 600), H = 220, m = { t: 24, r: 8, b: 30, l: 48 };
    const max = Math.max(...datos.map((d) => d.valor), 0);
    if (!max) { el.innerHTML = `<p class="vacio">Aún no hay ventas en estas fechas.</p>`; return; }
    const paso = Math.pow(10, Math.floor(Math.log10(max)));
    const tope = [1, 2, 2.5, 5, 10].map((k) => k * paso).find((v) => v >= max);
    const ticks = [0, tope / 2, tope];
    const iw = W - m.l - m.r, ih = H - m.t - m.b, banda = iw / datos.length;
    const bw = Math.min(24, banda - 6);
    const y = (v) => m.t + ih - (v / tope) * ih;
    const iMax = datos.reduce((bi, d, i) => (d.valor > datos[bi].valor ? i : bi), 0);
    const ult = datos.length - 1;
    const etiqueta = (i) => (ult - i) % 2 === 0;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(titulo)}">`;
    for (const t of ticks) s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="eje" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${compacto(t)}</text>`;
    datos.forEach((d, i) => {
      const cx = m.l + banda * i + banda / 2, x = cx - bw / 2, h = Math.max(d.valor ? 2 : 0, (d.valor / tope) * ih), top = m.t + ih - h, r = Math.min(4, h);
      const path = h ? `M${x},${m.t + ih}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${m.t + ih}Z` : "";
      s += `<g class="col${d.parcial ? " parcial" : ""}" data-i="${i}" tabindex="0" aria-label="${esc(d.nombre)}: ${money(d.valor)}, ${d.n} ventas">
        <rect class="hit" x="${m.l + banda * i}" y="${m.t}" width="${banda}" height="${ih + m.b}"/>${path ? `<path d="${path}"/>` : ""}</g>`;
      if (etiqueta(i)) s += `<text class="eje" x="${cx}" y="${H - 10}" text-anchor="middle">${esc(d.corto)}</text>`;
      if ((i === iMax || i === ult) && d.valor) s += `<text class="val" x="${cx}" y="${top - 6}" text-anchor="middle">${compacto(d.valor)}</text>`;
    });
    s += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/></svg>`;
    el.innerHTML = s + `<div class="tip" hidden></div>`;
    const tip = el.querySelector(".tip");
    const mostrar = (g) => {
      const d = datos[g.dataset.i];
      tip.innerHTML = `<b>${esc(d.nombre)}</b>${money(d.valor)}<span>${d.n} ${d.n === 1 ? "venta" : "ventas"} · ${d.piezas} libros${d.parcial ? " · en curso" : ""}</span>`;
      tip.hidden = false;
      const box = g.getBoundingClientRect(), cont = el.getBoundingClientRect();
      tip.style.left = Math.min(cont.width - tip.offsetWidth, Math.max(0, box.left - cont.left + box.width / 2 - tip.offsetWidth / 2)) + "px";
      el.querySelectorAll(".col").forEach((c) => c.classList.toggle("on", c === g));
    };
    const ocultar = () => { tip.hidden = true; el.querySelectorAll(".col").forEach((c) => c.classList.remove("on")); };
    el.querySelectorAll(".col").forEach((g) => {
      g.addEventListener("pointerenter", () => mostrar(g));
      g.addEventListener("click", () => mostrar(g));
      g.addEventListener("focus", () => mostrar(g));
      g.addEventListener("blur", ocultar);
    });
    el.querySelector("svg").addEventListener("pointerleave", ocultar);
  }

  function tablaDatos(datos) {
    return `<table class="mini"><thead><tr><th>Periodo</th><th class="n">Ventas</th><th class="n">Libros</th><th class="n">Vendido</th></tr></thead><tbody>${
      [...datos].reverse().map((d) => `<tr><td>${esc(d.nombre)}${d.parcial ? " <span class=\"muted\">(en curso)</span>" : ""}</td><td class="n">${d.n}</td><td class="n">${d.piezas}</td><td class="n">${money(d.valor)}</td></tr>`).join("")}</tbody></table>`;
  }

  function serie(inicios, fin, nombre, corto) {
    return inicios.map((ini, i) => {
      const r = resumenPeriodo(ini, inicios[i + 1] || fin);
      return { nombre: nombre(ini), corto: corto(ini), valor: r.total, n: r.n, piezas: r.piezas, parcial: i === inicios.length - 1 };
    });
  }

  function renderTablero() {
    const hoy = new Date();
    const finHoy = new Date(inicioDia(hoy).getTime() + DIA);
    const dias = S.periodo;
    const desde = new Date(finHoy.getTime() - dias * DIA), antes = new Date(desde.getTime() - dias * DIA);
    const act = resumenPeriodo(desde, finHoy), prev = resumenPeriodo(antes, desde);
    $("#tab-kpis").innerHTML = `
      <div class="kpi"><span>Vendido</span><strong>${money(act.total)}</strong>${delta(act.total, prev.total)}</div>
      <div class="kpi"><span>Número de ventas</span><strong>${act.n.toLocaleString("es-MX")}</strong>${delta(act.n, prev.n)}</div>
      <div class="kpi"><span>Ticket promedio</span><strong>${money(act.ticket)}</strong>${delta(act.ticket, prev.ticket)}</div>
      <div class="kpi"><span>Libros vendidos</span><strong>${act.piezas.toLocaleString("es-MX")}</strong>${delta(act.piezas, prev.piezas)}</div>`;

    // Semanas (12) y meses (12), incluyendo el actual.
    const sem0 = inicioSemana(hoy);
    const semanas = Array.from({ length: 12 }, (_, i) => new Date(sem0.getFullYear(), sem0.getMonth(), sem0.getDate() - 7 * (11 - i)));
    const dSem = serie(semanas, finHoy,
      (d) => `Semana del ${d.getDate()} ${MESES[d.getMonth()]}`, (d) => `${d.getDate()} ${MESES[d.getMonth()]}`);
    const meses = Array.from({ length: 12 }, (_, i) => new Date(hoy.getFullYear(), hoy.getMonth() - (11 - i), 1));
    const dMes = serie(meses, finHoy,
      (d) => `${MESES[d.getMonth()][0].toUpperCase() + MESES[d.getMonth()].slice(1)} ${d.getFullYear()}`, (d) => MESES[d.getMonth()]);
    columnas($("#graf-semana"), dSem, "Ventas por semana, últimas 12 semanas");
    columnas($("#graf-mes"), dMes, "Ventas por mes, últimos 12 meses");
    $("#tabla-semana").innerHTML = tablaDatos(dSem);
    $("#tabla-mes").innerHTML = tablaDatos(dMes);

    // Más vendidos del periodo: piezas, importe y si conviene volver a pedir.
    const cuenta = new Map();
    for (const v of act.ventas) for (const l of v.lineas) {
      if (!(l.precio > 0)) continue;
      const c = cuenta.get(l.codigo) || { codigo: l.codigo, titulo: l.titulo, piezas: 0, importe: 0 };
      c.piezas += l.cantidad; c.importe += l.importe;
      cuenta.set(l.codigo, c);
    }
    const top = [...cuenta.values()].sort((a, b) => b.piezas - a.piezas || b.importe - a.importe).slice(0, 10);
    const maxP = top[0]?.piezas || 1;
    $("#top-titulo").textContent = `Libros más vendidos · ${({ 7: "últimos 7 días", 30: "últimos 30 días", 365: "últimos 12 meses" })[dias]}`;
    $("#top-libros").innerHTML = top.length ? top.map((c, i) => {
      const p = S.porCodigo.get(c.codigo);
      const quedan = p ? p.existencia : null;
      const pedir = quedan !== null && quedan <= c.piezas;
      return `<li>
        <span class="rank">${i + 1}</span>
        <div class="tb"><div class="tt">${esc(p ? p.titulo : c.titulo)}</div>
          <div class="barra" aria-hidden="true"><i style="width:${Math.max(3, (c.piezas / maxP) * 100)}%"></i></div></div>
        <div class="tn"><b>${c.piezas}</b> ${c.piezas === 1 ? "pieza" : "piezas"}<span>${money(c.importe)}</span></div>
        <div class="te">${quedan === null ? "" : pedir ? `<span class="chip warn">Pedir más · quedan ${quedan}</span>` : `<span class="chip">Quedan ${quedan}</span>`}</div>
      </li>`;
    }).join("") : `<li class="vacio">Aún no hay ventas en este periodo.</li>`;
  }

  // ---------- Inventario ----------
  S.invFiltro = "todos";
  S.rec = []; // recepción de mercancía: { codigo, titulo, cantidad }

  // Cambia existencias y deja un movimiento por artículo (se suben a la hoja al sincronizar).
  async function moverExistencia(items, motivo) {
    const fecha = now();
    const writes = [];
    for (const { p, cantidad } of items) {
      if (!cantidad) continue;
      const np = { ...sinFlags(p), existencia: p.existencia + cantidad, actualizado: fecha };
      if (p.pendiente) np.pendiente = true;
      writes.push(["productos", np], ["movimientos", { id: uid(), codigo: p.codigo, cantidad, motivo, ventaId: "", fecha, dispositivo: S.meta.dispositivo, sincronizado: false }]);
    }
    if (!writes.length) return;
    await DB.write(writes);
    for (const { p, cantidad } of items) { p.existencia += cantidad; p.actualizado = fecha; }
    programarSync();
  }

  function renderInventario() {
    const vendibles = S.productos.filter((p) => p.tipo !== "descuento");
    const piezas = vendibles.reduce((a, p) => a + Math.max(0, p.existencia), 0);
    const valor = vendibles.reduce((a, p) => a + Math.max(0, p.existencia) * p.precio, 0);
    const pocos = vendibles.filter((p) => p.existencia > 0 && p.existencia <= 3).length;
    const cero = vendibles.filter((p) => p.existencia <= 0).length;
    $("#inv-kpis").innerHTML = `
      <div class="kpi"><span>Piezas en existencia</span><strong>${piezas.toLocaleString("es-MX")}</strong><small>${vendibles.length - cero} de ${vendibles.length} artículos</small></div>
      <div class="kpi"><span>Valor a precio de venta</span><strong>${money(valor)}</strong><small>Precio × existencia</small></div>
      <div class="kpi"><span>Por agotarse</span><strong>${pocos}</strong><small>3 piezas o menos</small></div>
      <div class="kpi"><span>Sin existencia</span><strong>${cero}</strong><small>Cero o negativa</small></div>`;
    const faltan = vendibles.filter(sinPrecio).length;
    $("#sinprecio-n").textContent = faltan ? `${faltan} ${faltan === 1 ? "libro espera" : "libros esperan"} precio` : "Todos tienen precio";
    $("#btn-sinprecio").classList.toggle("warn", faltan > 0);
    $("#btn-sinprecio").classList.toggle("listo", !faltan);
    $("#aviso-precio").hidden = !faltan;
    $("#aviso-precio").innerHTML = faltan ? `<span><b>${faltan} ${faltan === 1 ? "libro no tiene" : "libros no tienen"} precio.</b> Mientras no lo tengan, la app te lo pedirá al venderlos.</span> <button class="btn" type="button" id="btn-aviso-precio">Ponerles precio</button>` : "";
    if (faltan) $("#btn-aviso-precio").addEventListener("click", abrirPrecios);
    if (!$("#panel-precios").hidden) renderPrecios();
    const q = $("#inv-q").value;
    $("#inv-inicio").hidden = !!q.trim(); // al buscar, solo la búsqueda y sus resultados
    let lista = buscar(q) || [...vendibles].sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
    if (S.invFiltro === "pocos") lista = lista.filter((p) => p.existencia > 0 && p.existencia <= 3);
    if (S.invFiltro === "sinprecio") lista = lista.filter(sinPrecio);
    if (S.invFiltro === "cero") lista = lista.filter((p) => p.existencia <= 0 && p.tipo !== "descuento");
    const vis = lista.slice(0, 150);
    $("#inv-rows").innerHTML = vis.map((p) => `<tr data-edit="${esc(p.codigo)}">
        <td><div class="t">${esc(p.titulo)}</div><div class="c">${esc(p.codigo)}${p.autor ? " · " + esc(p.autor) : ""}${p.sinDescuento ? ' <span class="chip">No aplica descuento</span>' : ""}${p.tipo === "descuento" ? ' <span class="chip ok">Descuento</span>' : ""}</div></td>
        <td class="n">${sinPrecio(p) ? '<span class="chip warn">Sin precio</span>' : money(p.precio)}</td>
        <td class="n ${p.existencia <= 0 ? "ex-cero" : p.existencia <= 3 ? "ex-poco" : "ex-ok"}">${p.existencia}</td>
        <td class="n">${p.existencia > 0 ? money(p.existencia * p.precio) : "—"}</td>
        <td><button class="btn" type="button" data-edit="${esc(p.codigo)}">Editar</button></td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">No hay artículos con ese filtro.</td></tr>`;
    $("#inv-count").textContent = lista.length > vis.length ? `Mostrando ${vis.length} de ${lista.length}. Busca para ver los demás.` : `${lista.length} artículos`;
  }

  const tipoDe = (codigo, precio) => (precio < 0 ? "descuento" : /^97\d{11}$/.test(codigo) ? "libro" : "articulo");
  const sinPrecio = (p) => p.tipo !== "descuento" && !(p.precio > 0);

  // Alta rápida (p = null) o edición de un artículo.
  async function dialogoProducto(p, alGuardar, codigoNuevo = "") {
    const nuevo = !p;
    const movs = nuevo ? [] : (await DB.getAll("movimientos")).filter((m) => m.codigo === p.codigo).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 12);
    hoja(`<h3 id="sheet-title">${nuevo ? "Dar de alta un libro" : "Editar libro"}</h3>
      <form id="f-prod" class="cash big-form">
        <label>Código de barras o ISBN<input type="text" id="p-codigo" value="${esc(nuevo ? codigoNuevo : p.codigo)}" ${nuevo ? "" : "readonly"} autocomplete="off" inputmode="numeric" placeholder="${nuevo ? "Escanéalo o escríbelo" : ""}"></label>
        <p class="aviso" id="p-existe" hidden></p>
        <label>Título<input type="text" id="p-titulo" value="${esc(p?.titulo || "")}" autocomplete="off"></label>
        <div class="grid2">
          <label>Precio<input type="number" id="p-precio" step="any" min="0" inputmode="decimal" value="${p && p.precio ? p.precio : ""}" placeholder="Vacío si no lo sabes"></label>
          <label>${nuevo ? "¿Cuántos llegaron?" : "Hay en el anaquel"}<input type="number" id="p-exist" step="1" inputmode="numeric" value="${p ? p.existencia : ""}" placeholder="0"></label>
        </div>
        <details ${!nuevo && (p.autor || p.sinDescuento) ? "open" : ""}><summary>Más datos (opcional)</summary>
          <div class="cash">
            <label>Autor<input type="text" id="p-autor" value="${esc(p?.autor || "")}" autocomplete="off"></label>
            <label class="check"><input type="checkbox" id="p-sindesc" ${p?.sinDescuento ? "checked" : ""}> No aplica descuento</label>
          </div>
        </details>
        ${nuevo ? "" : `<div><span class="muted" style="font-size:.85rem">Movimientos en este equipo</span>
          <ul class="hist">${movs.map((m) => `<li><span>${new Date(m.fecha).toLocaleDateString("es-MX", { day: "numeric", month: "short" })} ${hora(m.fecha)} · ${esc(m.motivo)}</span><span class="n">${m.cantidad > 0 ? "+" : ""}${m.cantidad}</span></li>`).join("") || '<li><span class="muted">Sin movimientos todavía.</span></li>'}</ul></div>`}
        <p class="change bad" id="p-err" role="alert"></p>
        <div class="row">
          <button class="btn" type="button" data-close>Cancelar</button>
          ${nuevo ? '<button class="btn" type="submit" data-otro="1" id="p-otro">Guardar y dar de alta otro</button>' : ""}
          <button class="btn primary" type="submit" id="p-guardar">Guardar</button>
        </div>
      </form>`);
    $("#sheet").classList.add("wide");
    (nuevo && !codigoNuevo ? $("#p-codigo") : $("#p-titulo")).focus();

    const revisarCodigo = () => {
      const c = $("#p-codigo").value.trim();
      const ya = nuevo && c && S.porCodigo.get(c);
      $("#p-existe").hidden = !ya;
      if (ya) $("#p-existe").innerHTML = `<span>Este código ya está dado de alta: <b>${esc(ya.titulo)}</b>.</span> <button class="btn" type="button" id="p-editar-ya">Editarlo</button>`;
      if (ya) $("#p-editar-ya").addEventListener("click", () => { cerrarHoja(); dialogoProducto(ya); });
      return !ya;
    };
    if (nuevo) {
      $("#p-codigo").addEventListener("input", revisarCodigo);
      // El lector de código de barras manda Enter: pasar al título en lugar de guardar.
      $("#p-codigo").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (revisarCodigo()) $("#p-titulo").focus(); } });
      revisarCodigo();
    }

    $("#f-prod").addEventListener("submit", async (e) => {
      e.preventDefault();
      const otro = e.submitter && e.submitter.dataset.otro;
      const codigo = $("#p-codigo").value.trim().replace(/^([\d-\s]+)$/, (m) => m.replace(/[-\s]/g, "")) || (nuevo ? "A" + Date.now().toString().slice(-8) : p.codigo);
      const titulo = $("#p-titulo").value.trim();
      const precioTxt = $("#p-precio").value.trim();
      const precio = precioTxt === "" ? 0 : r2(Number(precioTxt));
      const exist = Math.round(Number($("#p-exist").value) || 0);
      if (!titulo) { $("#p-err").textContent = "Falta el título."; $("#p-titulo").focus(); return; }
      if (!isFinite(precio)) { $("#p-err").textContent = "El precio debe ser un número."; return; }
      if (nuevo && S.porCodigo.has(codigo)) { revisarCodigo(); $("#p-err").textContent = "Ese código ya existe."; return; }
      const datos = { titulo, autor: $("#p-autor").value.trim(), precio, sinDescuento: $("#p-sindesc").checked, tipo: tipoDe(codigo, precio) };
      let prod = p;
      if (nuevo) {
        prod = { codigo, ...datos, existencia: 0, actualizado: now(), pendiente: true };
        await DB.write([["productos", { ...sinFlags(prod), pendiente: true }]]);
        S.productos.push(prod);
      } else if (["titulo", "autor", "precio", "sinDescuento", "tipo"].some((k) => (p[k] ?? "") !== datos[k])) {
        Object.assign(p, datos, { actualizado: now(), pendiente: true });
        await DB.write([["productos", { ...sinFlags(p), pendiente: true }]]);
      }
      indexar();
      if (exist !== prod.existencia) await moverExistencia([{ p: prod, cantidad: exist - prod.existencia }], nuevo ? "alta" : "conteo");
      else programarSync();
      cerrarHoja();
      toast(nuevo ? `Dado de alta: ${titulo}${precio ? "" : " (sin precio)"}` : `Guardado: ${titulo}`);
      renderInventario(); renderResultados();
      if (alGuardar) alGuardar(prod);
      if (otro) dialogoProducto(null);
    });
  }

  // ---------- Precios faltantes ----------
  async function guardarPrecio(p, precio) {
    Object.assign(p, { precio: r2(precio), tipo: tipoDe(p.codigo, precio), actualizado: now(), pendiente: true });
    await DB.write([["productos", { ...sinFlags(p), pendiente: true }]]);
    programarSync();
  }

  function renderPrecios() {
    const lista = S.productos.filter(sinPrecio).sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
    $("#precios-lista").innerHTML = lista.map((p) => `<li>
        <div class="pt"><b>${esc(p.titulo)}</b><span class="muted">${esc(p.codigo)} · ${p.existencia} en existencia</span></div>
        <div class="pf"><label class="sr" for="pr-${esc(p.codigo)}">Precio de ${esc(p.titulo)}</label>
          <input type="number" min="0" step="any" inputmode="decimal" id="pr-${esc(p.codigo)}" data-precio="${esc(p.codigo)}" placeholder="$ Precio">
          <button class="btn primary" type="button" data-guardar-precio="${esc(p.codigo)}">Guardar</button></div>
      </li>`).join("") || `<li class="muted">Todos los libros tienen precio.</li>`;
  }

  async function guardarDesdePanel(codigo) {
    const input = document.querySelector(`[data-precio="${CSS.escape(codigo)}"]`);
    const precio = Number(input.value);
    if (!(precio > 0)) { input.focus(); toast("Escribe un precio mayor a cero."); return; }
    const p = S.porCodigo.get(codigo);
    await guardarPrecio(p, precio);
    toast(`${p.titulo}: ${money(precio)}`);
    renderPrecios(); renderInventario(); renderResultados();
    document.querySelector("[data-precio]")?.focus();
  }

  // Al vender un libro sin precio, se pregunta en ese momento.
  function dialogoPrecioVenta(p, cantidad) {
    hoja(`<h3 id="sheet-title">Este libro no tiene precio</h3>
      <p><b>${esc(p.titulo)}</b><br><span class="muted">${esc(p.codigo)}</span></p>
      <form id="f-pv" class="cash big-form">
        <label>¿En cuánto lo vendes?<input type="number" id="pv-precio" step="any" min="0" inputmode="decimal" required></label>
        <label class="check"><input type="checkbox" id="pv-guardar" checked> Guardar este precio para la próxima vez</label>
        <div class="row"><button class="btn" type="button" data-close>Cancelar</button><button class="btn primary" type="submit">Agregar a la venta</button></div>
      </form>`);
    $("#pv-precio").focus();
    $("#f-pv").addEventListener("submit", async (e) => {
      e.preventDefault();
      const precio = r2(Number($("#pv-precio").value));
      if (!(precio > 0)) return;
      if ($("#pv-guardar").checked) await guardarPrecio(p, precio);
      cerrarHoja();
      agregarLinea(p, precio, cantidad);
    });
  }

  // ---------- Carga desde Excel ----------
  const COLS_EXCEL = ["CODIGO", "TITULO", "AUTOR", "PRECIO", "CANTIDAD", "SIN DESCUENTO"];
  let xlsxCarga = null;
  function cargarXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxCarga) xlsxCarga = new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "vendor/xlsx.full.min.js";
      s.onload = () => ok(window.XLSX);
      s.onerror = () => { xlsxCarga = null; mal(new Error("No se pudo abrir el lector de Excel. Revisa tu conexión e intenta otra vez.")); };
      document.head.appendChild(s);
    });
    return xlsxCarga;
  }

  async function descargarExcel(nombre, filas) {
    try {
      const X = await cargarXLSX();
      const ws = X.utils.aoa_to_sheet([COLS_EXCEL, ...filas]);
      ws["!cols"] = [{ wch: 16 }, { wch: 46 }, { wch: 24 }, { wch: 10 }, { wch: 11 }, { wch: 15 }];
      const ayuda = X.utils.aoa_to_sheet([
        ["Cómo llenar el formato de Peregrino"],
        ["Una fila por libro. No cambies los nombres de las columnas de la hoja Inventario."],
        ["CODIGO: ISBN o código interno. Si ya existe en la app, el libro se actualiza; si no, se da de alta."],
        ["TITULO: obligatorio para libros nuevos."],
        ["PRECIO: solo el número, sin signo de pesos. Vacío = no cambia (o queda sin precio si es nuevo)."],
        ["CANTIDAD: piezas. Al subirlo eliges si se suman (llegó mercancía) o reemplazan la existencia (conteo)."],
        ["SIN DESCUENTO: escribe SI si al libro no se le aplican descuentos."],
        ["Una celda vacía no cambia nada."],
      ]);
      ayuda["!cols"] = [{ wch: 100 }];
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, "Inventario");
      X.utils.book_append_sheet(wb, ayuda, "Instrucciones");
      X.writeFile(wb, nombre);
      $("#excel-msg").textContent = `Descargado: ${nombre}. Lo encuentras en la carpeta Descargas.`;
    } catch (e) { $("#excel-msg").textContent = e.message; }
  }

  function exportarInventario() {
    const filas = S.productos.filter((p) => p.tipo !== "descuento").sort((a, b) => a.titulo.localeCompare(b.titulo, "es"))
      .map((p) => [p.codigo, p.titulo, p.autor || "", p.precio > 0 ? p.precio : "", p.existencia, p.sinDescuento ? "SI" : ""]);
    descargarExcel(`peregrino-inventario-${dayKey(now())}.xlsx`, filas);
  }

  // Lee la primera hoja. Reconoce los encabezados aunque cambien de orden (también los de los Excel anteriores de la librería).
  async function leerExcel(file) {
    const X = await cargarXLSX();
    const wb = X.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    const clave = (v) => norm(v).replace(/[^a-z]/g, "");
    const alias = {
      codigo: ["codigo", "isbn", "clave", "codigodebarras"],
      titulo: ["titulo", "descripcion", "nombre", "libro"],
      autor: ["autor"],
      precio: ["precio", "preciocasa", "punitario", "preciounitario", "preciodeventa", "precioventa"],
      cantidad: ["cantidad", "existencia", "piezas", "stock"],
      sinDescuento: ["sindescuento", "noaplicadescuento"],
    };
    let hi = aoa.slice(0, 10).findIndex((r) => r.some((v) => alias.codigo.includes(clave(v))));
    let cols = { codigo: 0, titulo: 1, autor: 2, precio: 3, cantidad: 4, sinDescuento: 5 };
    if (hi >= 0) {
      cols = {};
      aoa[hi].forEach((v, i) => { const k = clave(v); for (const [campo, al] of Object.entries(alias)) if (al.includes(k) && cols[campo] === undefined) cols[campo] = i; });
    }
    return aoa.slice(hi + 1).map((r, i) => {
      const o = { fila: hi + 2 + i };
      for (const [campo, idx] of Object.entries(cols)) o[campo] = r[idx];
      return o;
    });
  }

  function planearExcel(filas, modo) {
    const vacio = (v) => v === "" || v === null || v === undefined;
    const porCod = new Map();
    const errores = [];
    for (const f of filas) {
      if ([f.codigo, f.titulo, f.precio, f.cantidad].every(vacio)) continue;
      let codigo = typeof f.codigo === "number" ? String(Math.round(f.codigo)) : String(f.codigo ?? "").trim();
      if (/^[\d\s-]+$/.test(codigo)) codigo = codigo.replace(/[\s-]/g, "");
      const it = {
        fila: f.fila, codigo,
        titulo: String(f.titulo ?? "").replace(/\(?NO APLICA DESCUENTOS?\)?/i, "").replace(/\s+/g, " ").trim(),
        autor: String(f.autor ?? "").replace(/\s+/g, " ").trim(),
        precio: null, cantidad: null, sinDescuento: null, error: "",
      };
      if (!vacio(f.precio)) {
        const n = typeof f.precio === "number" ? f.precio : Number(String(f.precio).replace(/[$,\s]/g, ""));
        if (Number.isFinite(n) && n >= 0) it.precio = r2(n); else it.error = `El precio “${f.precio}” no es válido`;
      }
      if (!vacio(f.cantidad)) {
        const n = typeof f.cantidad === "number" ? f.cantidad : Number(String(f.cantidad).replace(/[,\s]/g, ""));
        if (Number.isFinite(n)) it.cantidad = Math.round(n); else it.error = it.error || `La cantidad “${f.cantidad}” no es un número`;
      }
      if (!vacio(f.sinDescuento)) it.sinDescuento = /^(si|sí|s|x|1|true|verdadero)$/i.test(String(f.sinDescuento).trim());
      if (!codigo) it.error = it.error || "Falta el código";
      if (CODIGOS_PAGO[codigo]) it.error = it.error || "Los códigos 1, 2 y 3 son formas de pago";
      if (it.error) { errores.push(it); continue; }
      const prev = porCod.get(codigo);
      if (prev) { // el mismo código en varias filas se junta en una
        for (const k of ["titulo", "autor"]) if (it[k]) prev[k] = it[k];
        for (const k of ["precio", "sinDescuento"]) if (it[k] !== null) prev[k] = it[k];
        if (it.cantidad !== null) prev.cantidad = modo === "sumar" ? (prev.cantidad || 0) + it.cantidad : it.cantidad;
        prev.filas.push(it.fila);
      } else porCod.set(codigo, { ...it, filas: [it.fila] });
    }
    const cambios = [];
    let iguales = 0;
    for (const it of porCod.values()) {
      const p = S.porCodigo.get(it.codigo);
      if (!p) {
        if (!it.titulo) { errores.push({ ...it, error: "Es un libro nuevo y le falta el título" }); continue; }
        const t = ["Libro nuevo", it.precio ? money(it.precio) : "sin precio"];
        if (it.cantidad) t.push(`${it.cantidad} piezas`);
        cambios.push({ tipo: "nuevo", it, texto: t });
        continue;
      }
      const meta = {}, t = [];
      if (it.titulo && it.titulo !== p.titulo) { meta.titulo = it.titulo; t.push("cambia el título"); }
      if (it.autor && it.autor !== (p.autor || "")) { meta.autor = it.autor; t.push("autor"); }
      if (it.precio !== null && it.precio !== p.precio) { meta.precio = it.precio; t.push(`precio ${p.precio > 0 ? money(p.precio) : "sin precio"} → ${money(it.precio)}`); }
      if (it.sinDescuento !== null && it.sinDescuento !== !!p.sinDescuento) { meta.sinDescuento = it.sinDescuento; t.push(it.sinDescuento ? "ya no aplica descuento" : "sí aplica descuento"); }
      let delta = 0;
      if (it.cantidad !== null) delta = modo === "sumar" ? it.cantidad : it.cantidad - p.existencia;
      if (delta) t.push(modo === "sumar" ? `${delta > 0 ? "+" : ""}${delta} piezas, quedan ${p.existencia + delta}` : `existencia ${p.existencia} → ${p.existencia + delta}`);
      if (t.length) cambios.push({ tipo: "cambio", it, p, meta, delta, texto: t }); else iguales++;
    }
    return { cambios, errores, iguales, modo };
  }

  async function abrirExcel(file) {
    $("#excel-msg").textContent = "Leyendo el archivo…";
    try {
      const filas = await leerExcel(file);
      const modo = document.querySelector('[name="excel-modo"]:checked').value;
      S.excelPlan = { ...planearExcel(filas, modo), archivo: file.name };
    } catch (e) {
      $("#excel-msg").textContent = e.message && e.message.includes("lector") ? e.message : "No pude leer ese archivo. Guárdalo como Excel (.xlsx) e intenta de nuevo.";
      return;
    }
    $("#excel-msg").textContent = "";
    const { cambios, errores, iguales } = S.excelPlan;
    const nuevos = cambios.filter((c) => c.tipo === "nuevo").length;
    const act = cambios.length - nuevos;
    const partes = [];
    if (nuevos) partes.push(`<b>${nuevos}</b> ${nuevos === 1 ? "libro nuevo" : "libros nuevos"} se dan de alta`);
    if (act) partes.push(`<b>${act}</b> ${act === 1 ? "libro se actualiza" : "libros se actualizan"}`);
    if (iguales) partes.push(`${iguales} no cambian`);
    if (errores.length) partes.push(`<span class="malo"><b>${errores.length}</b> ${errores.length === 1 ? "fila tiene" : "filas tienen"} un problema y no se guarda${errores.length === 1 ? "" : "n"}</span>`);
    $("#excel-resumen").innerHTML = `Archivo <b>${esc(file.name)}</b>: ${partes.join(", ") || "no hay nada que cambiar"}.`;
    const filasHTML = [
      ...errores.map((e) => `<tr class="err"><td class="n">${e.fila}</td><td><div class="t">${esc(e.titulo || "(sin título)")}</div><div class="c">${esc(e.codigo)}</div></td><td>${esc(e.error)}</td></tr>`),
      ...cambios.map((c) => `<tr><td class="n">${c.it.filas.join(", ")}</td><td><div class="t">${esc(c.it.titulo || c.p.titulo)}</div><div class="c">${esc(c.it.codigo)}</div></td><td>${c.tipo === "nuevo" ? '<span class="chip ok">Nuevo</span> ' : ""}${esc(c.texto.filter((x) => x !== "Libro nuevo").join(" · "))}</td></tr>`),
    ];
    $("#excel-filas").innerHTML = filasHTML.slice(0, 400).join("") + (filasHTML.length > 400 ? `<tr><td colspan="3" class="muted">Y ${filasHTML.length - 400} filas más.</td></tr>` : "");
    $("#btn-excel-aplicar").disabled = !cambios.length;
    $("#btn-excel-aplicar").textContent = cambios.length ? `Guardar ${cambios.length} ${cambios.length === 1 ? "cambio" : "cambios"}` : "Nada que guardar";
    $("#excel-pasos").hidden = true;
    $("#excel-revision").hidden = false;
  }

  async function aplicarExcel() {
    const plan = S.excelPlan;
    if (!plan || !plan.cambios.length) return;
    const t = now();
    const writes = [], mov = [];
    for (const c of plan.cambios) {
      if (c.tipo === "nuevo") {
        const it = c.it;
        const precio = it.precio ?? 0;
        const p = { codigo: it.codigo, titulo: it.titulo, autor: it.autor || "", precio, sinDescuento: !!it.sinDescuento, tipo: tipoDe(it.codigo, precio), existencia: 0, actualizado: t, pendiente: true };
        S.productos.push(p);
        writes.push(["productos", { ...sinFlags(p), pendiente: true }]);
        if (it.cantidad) mov.push({ p, cantidad: it.cantidad });
      } else {
        if (Object.keys(c.meta).length) {
          Object.assign(c.p, c.meta, { actualizado: t, pendiente: true });
          c.p.tipo = tipoDe(c.p.codigo, c.p.precio);
          writes.push(["productos", { ...sinFlags(c.p), pendiente: true }]);
        }
        if (c.delta) mov.push({ p: c.p, cantidad: c.delta });
      }
    }
    $("#btn-excel-aplicar").disabled = true;
    await DB.write(writes);
    indexar();
    await moverExistencia(mov, (plan.modo === "sumar" ? "entrada" : "conteo") + ": Excel " + plan.archivo);
    programarSync();
    S.excelPlan = null;
    cerrarExcel();
    renderInventario(); renderResultados();
    toast(`Listo: ${plan.cambios.length} ${plan.cambios.length === 1 ? "cambio guardado" : "cambios guardados"}`);
  }

  function cerrarExcel() {
    $("#panel-excel").hidden = true;
    $("#excel-pasos").hidden = false;
    $("#excel-revision").hidden = true;
    $("#excel-msg").textContent = "";
  }

  // ---------- Letra grande ----------
  function aplicarLetra(grande) {
    document.documentElement.classList.toggle("letra-grande", grande);
    $("#btn-letra").setAttribute("aria-pressed", String(grande));
    $("#btn-letra").title = grande ? "Letra normal" : "Letra más grande";
    try { localStorage.setItem("peregrino-letra", grande ? "grande" : "normal"); } catch (e) {}
  }

  function cerrarPaneles() {
    $("#panel-precios").hidden = true;
    cerrarExcel();
    if (!S.rec.length) $("#recepcion").hidden = true;
  }

  function abrirPrecios() {
    cerrarPaneles();
    $("#panel-precios").hidden = false;
    renderPrecios();
    $("#panel-precios").scrollIntoView({ block: "start" });
    document.querySelector("[data-precio]")?.focus();
  }

  // Recepción de mercancía
  function recAgregar(p) {
    const l = S.rec.find((x) => x.codigo === p.codigo);
    if (l) l.cantidad++; else S.rec.unshift({ codigo: p.codigo, titulo: p.titulo, cantidad: 1 });
    $("#rec-q").value = ""; $("#rec-sug").innerHTML = "";
    renderRecepcion();
    $("#rec-q").focus();
  }

  function renderRecepcion() {
    $("#rec-lines").innerHTML = S.rec.map((l, i) => {
      const ex = S.porCodigo.get(l.codigo)?.existencia || 0;
      return `<li class="line"><span class="t">${esc(l.titulo)}</span><button type="button" class="rm" data-rrm="${i}">Quitar</button>
        <span class="sub"><span class="qty"><button type="button" data-rdec="${i}" aria-label="Quitar uno">−</button><input type="number" min="1" step="1" inputmode="numeric" value="${l.cantidad}" data-rqty="${i}" id="rqty-${i}" aria-label="Piezas recibidas"><button type="button" data-rinc="${i}" aria-label="Agregar uno">+</button></span>
        <span class="mono">${esc(l.codigo)}</span><span>Hay ${ex}, quedarán ${ex + l.cantidad}</span></span></li>`;
    }).join("");
    const piezas = S.rec.reduce((a, l) => a + l.cantidad, 0);
    $("#rec-total").textContent = S.rec.length ? `${S.rec.length} títulos · ${piezas} piezas` : "";
    $("#btn-rec-guardar").disabled = !S.rec.length;
  }

  function recBuscar(enter) {
    const q = $("#rec-q").value.trim();
    if (!q) { $("#rec-sug").innerHTML = ""; return; }
    const exacto = S.porCodigo.get(q);
    if (enter && exacto) return recAgregar(exacto);
    const res = (buscar(q) || []).filter((p) => p.tipo !== "descuento");
    if (enter && res.length === 1) return recAgregar(res[0]);
    if (enter && !res.length && /^\d{4,}$/.test(q)) return dialogoProducto(null, (p) => recAgregar(p), q);
    $("#rec-sug").innerHTML = res.slice(0, 8).map((p) => itemHTML(p)).join("") || `<li class="none">No encontré “${esc(q)}”.${/^\d{4,}$/.test(q) ? " Presiona Enter para darlo de alta." : ""}</li>`;
  }

  async function recGuardar() {
    if (!S.rec.length) return;
    const nota = $("#rec-nota").value.trim();
    const items = S.rec.map((l) => ({ p: S.porCodigo.get(l.codigo), cantidad: l.cantidad })).filter((x) => x.p);
    const piezas = items.reduce((a, x) => a + x.cantidad, 0);
    await moverExistencia(items, "entrada" + (nota ? ": " + nota : ""));
    S.rec = []; $("#rec-nota").value = "";
    $("#recepcion").hidden = true;
    renderRecepcion(); renderInventario(); renderResultados();
    toast(`Entrada guardada: ${piezas} piezas`);
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
    // Verde: al día con los demás equipos. Amarillo: falta subir o no está conectado. Rojo: error.
    const n = $("#net");
    const cfg = S.meta.sync;
    const pon = (estado, txt, title) => { n.dataset.estado = estado; n.textContent = txt; n.title = title; };
    if (!cfg || !cfg.url) return pon("local", "Solo este equipo", "No está conectado a Google Sheets: las ventas de otros equipos no llegan aquí. Toca para conectarlo.");
    const pend = S.ventas.filter((v) => !v.sincronizado).length;
    if (texto) return pon("pend", texto, "Sincronizando con los demás equipos");
    if (!navigator.onLine) return pon("pend", pend ? `Sin internet · ${pend} por subir` : "Sin internet", "Se guarda en este equipo y se sube al volver el internet");
    if (syncError) return pon("err", "No se pudo sincronizar", syncError + " Toca para reintentar.");
    if (pend) return pon("pend", `${pend} por subir`, "Toca para subir ahora");
    pon("ok", S.meta.ultimaSync ? `Al día ${hora(S.meta.ultimaSync)}` : "Conectado", "Sincronizado con los demás equipos. Toca para actualizar ahora.");
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
      const deltaEnv = new Map();
      movs.forEach((m) => deltaEnv.set(m.codigo, (deltaEnv.get(m.codigo) || 0) + m.cantidad));
      // La hoja solo toma la existencia de artículos nuevos; se manda sin los movimientos pendientes, que se aplican aparte.
      const base = (p) => ({ ...sinFlags(p), existencia: p.existencia - (deltaEnv.get(p.codigo) || 0) });
      const versionEnviada = new Map(productos.map((p) => [p.codigo, p.actualizado]));
      const req = {
        clave: cfg.clave, dispositivo: S.meta.dispositivo, desde: S.meta.ultimaSync || "", hashProductos: S.meta.hashProductos || "",
        ventas: ventas.map(({ sincronizado, ...v }) => v), movimientos: movs.map(({ sincronizado, ...m }) => m), productos: productos.map(base),
      };
      if (!S.meta.ultimaSync) {
        // Primer equipo en conectarse: la hoja arranca con este catálogo (existencia antes de las ventas pendientes, que se aplican aparte).
        req.catalogo = S.productos.map(base);
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
      // Un artículo editado otra vez mientras se sincronizaba sigue pendiente.
      for (const p of S.productos) if (p.pendiente && versionEnviada.get(p.codigo) === p.actualizado) { p.pendiente = false; writes.push(["productos", sinFlags(p)]); }
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
        const pend = new Map(S.productos.filter((p) => p.pendiente).map((p) => [p.codigo, p]));
        const deHoja = r.productos.map((p) => {
          const loc = pend.get(p.codigo);
          const meta = loc ? { titulo: loc.titulo, autor: loc.autor, precio: loc.precio, tipo: loc.tipo, sinDescuento: loc.sinDescuento, pendiente: true } : {};
          return { ...p, ...meta, existencia: p.existencia + (delta.get(p.codigo) || 0), actualizado: loc ? loc.actualizado : t };
        });
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
      if (!$("#view-ventas").hidden) { renderTablero(); renderVentas(); }
      if (!$("#view-inventario").hidden) renderInventario();
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
    for (const n of ["vender", "ventas", "inventario", "mas"]) {
      $(`#view-${n}`).hidden = n !== v;
      $(`#tab-${n}`).classList.toggle("is-active", n === v);
    }
    if (v === "ventas") { renderTablero(); renderVentas(); }
    if (v === "inventario") renderInventario();
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
      if (!isMobile() && $("#overlay").hidden) { $("#q").select(); $("#q").focus(); }
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
    document.querySelectorAll("[data-periodo]").forEach((b) => b.addEventListener("click", () => {
      S.periodo = Number(b.dataset.periodo);
      document.querySelectorAll("[data-periodo]").forEach((x) => x.classList.toggle("is-on", x === b));
      renderTablero();
    }));
    let rz;
    addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!$("#view-ventas").hidden) renderTablero(); }, 200); });
    $("#sales").addEventListener("click", (e) => {
      const an = e.target.closest("[data-anular]");
      if (an) { anular(S.ventas.find((v) => v.id === an.dataset.anular), an.closest(".acts")); return; }
      if (e.target.closest("[data-noanular]")) { const li = e.target.closest(".sale"); li.querySelector(".sale-detail").remove(); detalleVenta(li, S.ventas.find((v) => v.id === li.querySelector("[data-venta]").dataset.venta)); return; }
      const b = e.target.closest("[data-venta]");
      if (b) detalleVenta(b.closest(".sale"), S.ventas.find((v) => v.id === b.dataset.venta));
    });

    $("#inv-q").addEventListener("input", renderInventario);
    document.querySelectorAll("[data-filtro]").forEach((b) => b.addEventListener("click", () => {
      S.invFiltro = b.dataset.filtro;
      document.querySelectorAll("[data-filtro]").forEach((x) => x.classList.toggle("is-on", x === b));
      renderInventario();
    }));
    $("#inv-rows").addEventListener("click", (e) => { const c = e.target.closest("[data-edit]")?.dataset.edit; if (c) dialogoProducto(S.porCodigo.get(c)); });
    $("#btn-nuevo").addEventListener("click", () => dialogoProducto(null));
    $("#btn-sinprecio").addEventListener("click", abrirPrecios);
    $("#btn-precios-cerrar").addEventListener("click", () => ($("#panel-precios").hidden = true));
    $("#precios-lista").addEventListener("click", (e) => { const c = e.target.closest("[data-guardar-precio]")?.dataset.guardarPrecio; if (c) guardarDesdePanel(c); });
    $("#precios-lista").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.precio) guardarDesdePanel(e.target.dataset.precio); });
    $("#btn-excel").addEventListener("click", () => { cerrarPaneles(); $("#panel-excel").hidden = false; $("#panel-excel").scrollIntoView({ block: "start" }); cargarXLSX().catch(() => {}); });
    $("#btn-excel-cerrar").addEventListener("click", cerrarExcel);
    $("#btn-formato").addEventListener("click", () => descargarExcel("peregrino-formato.xlsx", []));
    $("#btn-export-inv").addEventListener("click", exportarInventario);
    $("#file-excel").addEventListener("change", (e) => { if (e.target.files[0]) abrirExcel(e.target.files[0]); e.target.value = ""; });
    $("#btn-excel-aplicar").addEventListener("click", aplicarExcel);
    $("#btn-excel-otro").addEventListener("click", () => { $("#excel-revision").hidden = true; $("#excel-pasos").hidden = false; });
    $("#btn-letra").addEventListener("click", () => aplicarLetra(!document.documentElement.classList.contains("letra-grande")));
    $("#btn-recibir").addEventListener("click", () => { cerrarPaneles(); $("#recepcion").hidden = false; $("#rec-q").focus(); });
    $("#btn-rec-cancelar").addEventListener("click", () => { S.rec = []; renderRecepcion(); $("#recepcion").hidden = true; });
    $("#rec-q").addEventListener("input", () => recBuscar(false));
    $("#rec-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); recBuscar(true); } });
    $("#rec-sug").addEventListener("click", (e) => { const c = e.target.closest("[data-add]")?.dataset.add; if (c) recAgregar(S.porCodigo.get(c)); });
    $("#rec-lines").addEventListener("click", (e) => {
      const d = e.target.closest("button")?.dataset;
      if (!d) return;
      if (d.rinc) S.rec[d.rinc].cantidad++;
      else if (d.rdec) { if (S.rec[d.rdec].cantidad > 1) S.rec[d.rdec].cantidad--; else S.rec.splice(d.rdec, 1); }
      else if (d.rrm) S.rec.splice(d.rrm, 1);
      else return;
      renderRecepcion();
    });
    $("#rec-lines").addEventListener("change", (e) => {
      const i = e.target.dataset.rqty;
      if (i == null) return;
      const n = Math.floor(Number(e.target.value));
      if (n > 0) S.rec[i].cantidad = n; else S.rec.splice(i, 1);
      renderRecepcion();
    });
    $("#btn-rec-guardar").addEventListener("click", recGuardar);
    $("#btn-respaldo").addEventListener("click", respaldo);
    $("#btn-cero").addEventListener("click", dialogoCero);
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
    // Cada 45 segundos con la app abierta, para ver pronto lo que venden los otros equipos.
    setInterval(() => { if (document.visibilityState === "visible") sincronizar(); }, 45 * 1000);
    addEventListener("focus", () => sincronizar());
    $("#net").addEventListener("click", () => { if (S.meta.sync && S.meta.sync.url) sincronizar(true); else vista("mas"); });
    $("#btn-conectar").addEventListener("click", conectar);
    $("#btn-sync-ahora").addEventListener("click", () => sincronizar(true));
    $("#btn-desconectar").addEventListener("click", desconectar);
  }

  async function iniciar() {
    $("#fecha").value = dayKey(now());
    if (isMobile()) $("#q").placeholder = "Busca título o código";
    try { if (localStorage.getItem("peregrino-letra") === "grande") aplicarLetra(true); } catch (e) {}
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
