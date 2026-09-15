// Logica compartida del dashboard de gastos. Cada instalacion (una carpeta
// con nombre aleatorio por persona) define `window.GASTOS_CONFIG = { sheetId,
// clientId, titulo }` ANTES de
// cargar este archivo. No hay backend propio: esto corre 100% en el
// navegador y llama directo a la API de Google Sheets con un access token
// de Google Identity Services.

(function () {
  "use strict";

  const CONFIG = window.GASTOS_CONFIG;
  if (!CONFIG || !CONFIG.sheetId || !CONFIG.clientId) {
    throw new Error("Falta window.GASTOS_CONFIG (sheetId/clientId) antes de cargar app.js");
  }

  // Scope de lectura Y escritura (antes era solo lectura): hace falta para
  // poder editar la cuota 1 de un gasto. La cuenta de Google logueada tiene
  // que tener permiso de Editor (no solo Lector) en la Sheet para que la
  // escritura funcione de verdad.
  // Ademas se pide el de email para poder chequear que la cuenta logueada
  // sea la esperada para esta pagina (se compara un hash SHA-256 contra
  // CONFIG.allowedEmailHash, nunca el email en texto plano). Esto es un
  // resguardo de UX, no un limite de seguridad real: el control de acceso
  // de verdad lo da a quien se compartio cada Google Sheet.
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";
  const NOMBRE_HOJA = "Gastos";
  const RANGO = NOMBRE_HOJA + "!A:I";
  const STORAGE_KEY = "gastos-token-" + CONFIG.sheetId;

  // Pestaña "Ingresos": vive en una hoja separada de la misma Sheet. Si no
  // existe todavia, se crea sola (con este encabezado) la primera vez que
  // se abre esa pestaña.
  const NOMBRE_HOJA_INGRESOS = "Ingresos";
  const HEADER_INGRESOS = ["Fecha", "Descripcion", "Monto", "Porcentaje ahorro", "Monto ahorrado", "Monto disponible"];
  const RANGO_INGRESOS = NOMBRE_HOJA_INGRESOS + "!A:F";

  // Orden fijo de categorias para que cada una tenga siempre el mismo color.
  // Una categoria fuera de esta lista (cargada a mano en la Sheet) cae en gris.
  // Cada instalacion puede definir las suyas via CONFIG.categorias (las
  // categorias son personales de cada persona, no compartidas); si no las
  // define, se usa esta lista por default.
  // Nombre del grupo "todo lo que no es credito" (efectivo/debito/y demas),
  // customizable por instalacion via CONFIG.nombreNoCredito - por ejemplo
  // si alguien unifica transferencia dentro de debito y ya no la usa como
  // medio de pago aparte, puede sacar la mencion de este texto.
  const NOMBRE_GRUPO_NO_CREDITO = CONFIG.nombreNoCredito || "efectivo/débito/transferencia";

  // Categorias que se ignoran en el grafico "Por dia" (gastos fijos grandes
  // que, al entrar en el mismo eje que el resto, tapan los gastos chicos).
  // Customizable por instalacion via CONFIG.categoriasExcluidasPorDia; por
  // default no se excluye ninguna.
  const CATEGORIAS_EXCLUIDAS_POR_DIA = CONFIG.categoriasExcluidasPorDia || [];

  function capitalizar(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  }

  // Se sobreescribe con lo que haya en la pestaña "Config" de la Sheet (ver
  // cargarCategoriasDesdeSheet) apenas carga - esa pestaña es la fuente real
  // (editable desde acá mismo, con "Agregar categoría"); esto de acá es solo
  // el fallback para cuando esa pestaña todavia no existe (instalación
  // recién hecha, el bot nunca arrancó todavía).
  let CATEGORIAS_ORDEN = CONFIG.categorias || [
    "Supermercado",
    "Delivery/Restaurantes",
    "Transporte",
    "Vivienda y servicios",
    "Salud",
    "Ocio/Entretenimiento",
    "Ropa",
    "Suscripciones",
    "Otros",
  ];
  // Idem para medios de pago - se sobreescribe con la columna MedioPago de
  // "Config" apenas carga. Vacio hasta entonces: el filtro/datalist de
  // medios de pago ya sabe derivarlos de los datos reales como fallback
  // (ver poblarFiltros).
  let MEDIOS_PAGO_ORDEN = [];

  const MESES_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];

  let tokenClient = null;
  let accessToken = null;
  let movimientos = [];
  let graficosActivos = [];
  let mesesDisponibles = []; // [{anio, mes, etiqueta}], para el selector de mes
  // Mes compartido por Actividad mensual, Ingreso vs Gastos, Gastos detalle
  // y Calendario: moverlo desde cualquiera de las cuatro mueve a las otras
  // tambien. {anio, mes} o null = "usar el mes actual real".
  let mesGlobal = null;
  let anioSeleccionado = null; // numero o null = "usar el año actual", para la pestaña Anual
  let gastosInicializado = false; // ya se fijo el mes actual por default en Gastos (solo la 1ra carga)
  let indiceColumnas = {}; // nombre de columna -> indice 0-based, para editar
  let filaEnEdicion = null;
  let filaIngresoEnEdicion = null; // fila (1-based) del ingreso en edicion, o null = agregando uno nuevo
  let ingresos = [];
  let hojaIngresosVerificada = false; // ya se chequeo/creo la hoja "Ingresos" esta sesion
  let categoriasCargadasDesdeSheet = false; // ya se intento leer la pestaña "Config" esta sesion
  let graficoIngresoAhorroInstancia = null;

  // ------------------------------------------------------------------------
  // Tema claro/oscuro (guardado por pagina: cada instalacion tiene su
  // propio sheetId, asi que no comparten preferencia aunque vivan en el
  // mismo dominio de GitHub Pages)
  // ------------------------------------------------------------------------

  const TEMA_KEY = "gastos-tema-" + CONFIG.sheetId;

  function aplicarTemaGuardado() {
    const guardado = localStorage.getItem(TEMA_KEY);
    if (guardado === "dark" || guardado === "light") {
      document.documentElement.setAttribute("data-theme", guardado);
    }
  }

  function esOscuroAhora() {
    const actual = document.documentElement.getAttribute("data-theme");
    if (actual) return actual === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function actualizarIconoTema() {
    const boton = document.getElementById("btn-tema");
    if (boton) boton.textContent = esOscuroAhora() ? "☀️" : "🌙";
  }

  function alternarTema() {
    const nuevo = esOscuroAhora() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nuevo);
    localStorage.setItem(TEMA_KEY, nuevo);
    actualizarIconoTema();
    if (movimientos.length) renderizarTodo(); // los graficos leen colores de CSS al crearse
    if (ingresos.length) renderizarIngresos();
  }

  // ------------------------------------------------------------------------
  // Modo privado (como el "ojito" de bancos/billeteras): oculta los montos
  // en pantalla, para poder mirar el celular en publico sin mostrar cifras.
  // Se guarda por pagina, igual que el tema. NO afecta la exportacion a CSV
  // ni el modal de edicion (esos usan el numero real, no formatoMoneda), a
  // proposito: son acciones deliberadas del dueño de los datos, no algo que
  // vea quien mira de costado.
  // ------------------------------------------------------------------------

  const PRIVADO_KEY = "gastos-privado-" + CONFIG.sheetId;
  let modoPrivado = false;

  function cargarModoPrivadoGuardado() {
    modoPrivado = localStorage.getItem(PRIVADO_KEY) === "1";
  }

  function actualizarIconoPrivado() {
    const boton = document.getElementById("btn-privado");
    if (boton) boton.textContent = modoPrivado ? "🙈" : "👁️";
  }

  function alternarModoPrivado() {
    modoPrivado = !modoPrivado;
    localStorage.setItem(PRIVADO_KEY, modoPrivado ? "1" : "0");
    actualizarIconoPrivado();
    if (movimientos.length) renderizarTodo();
    if (ingresos.length) renderizarIngresos();
  }

  // ------------------------------------------------------------------------
  // Helpers de color / formato
  // ------------------------------------------------------------------------

  // Paleta ampliada a pedido (14 colores en vez de 8): los primeros 8 son
  // los validados para daltonismo, el resto son colores extra sin esa
  // garantia. Si CATEGORIAS_ORDEN tiene mas de 14 entradas, las que quedan
  // despues de la 14va caen en el mismo gris que Otros.
  const MAX_CATEGORIAS_CON_COLOR = 14;

  // categoria -> 1..14 (que --series-N le toca). Lo llena cargarCategoriasDesdeSheet()
  // desde la columna ColorSlot de la pestaña "Config" - a diferencia de antes, el
  // color ya no se deriva de la posicion en una lista, se guarda explicito por
  // categoria (para que se pueda elegir a mano desde "Agregar categoría").
  let COLOR_SLOT_POR_CATEGORIA = {};

  function colorDeCategoria(categoria) {
    const estilo = getComputedStyle(document.documentElement);
    if (categoria === "Otros") return estilo.getPropertyValue("--series-otros").trim();

    let slot = COLOR_SLOT_POR_CATEGORIA[categoria];
    if (slot === undefined) {
      // Fallback para una Sheet vieja sin ColorSlot todavia, o una categoria
      // que no esta en ningun lado: mismo criterio que antes (posicion).
      const indice = CATEGORIAS_ORDEN.indexOf(categoria);
      slot = indice === -1 ? null : indice + 1;
    }
    if (!slot || slot > MAX_CATEGORIAS_CON_COLOR) {
      return estilo.getPropertyValue("--series-otros").trim();
    }
    return estilo.getPropertyValue(`--series-${slot}`).trim();
  }

  function colorSecuencial() {
    return getComputedStyle(document.documentElement).getPropertyValue("--series-seq").trim();
  }

  function colorBueno() {
    return getComputedStyle(document.documentElement).getPropertyValue("--good").trim();
  }

  function colorTexto(rol) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--text-${rol}`).trim();
  }

  function colorGrid() {
    return getComputedStyle(document.documentElement).getPropertyValue("--gridline").trim();
  }

  function formatoMoneda(valor) {
    if (modoPrivado) return "$ ••••••";
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(valor);
  }

  function ordenarPorValor(objeto) {
    return Object.entries(objeto).sort((a, b) => b[1] - a[1]);
  }

  // Fecha serial de Google Sheets (dias desde el 30-dic-1899, mismo bug
  // historico que Excel) -> Date. Se usan getters UTC en todos lados para
  // leer/mostrar esta fecha, porque la planilla no guarda zona horaria: no
  // hay que dejar que la zona horaria del navegador la corra un dia.
  function serialAFecha(serial) {
    const epoca = Date.UTC(1899, 11, 30);
    return new Date(epoca + serial * 86400000);
  }

  function formatoFecha(fecha) {
    const dd = String(fecha.getUTCDate()).padStart(2, "0");
    const mm = String(fecha.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = fecha.getUTCFullYear();
    const hh = String(fecha.getUTCHours()).padStart(2, "0");
    const min = String(fecha.getUTCMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  function sumarMeses(anio, mes, delta) {
    const indice = mes - 1 + delta;
    const nuevoAnio = anio + Math.floor(indice / 12);
    const nuevoMes = ((indice % 12) + 12) % 12;
    return { anio: nuevoAnio, mes: nuevoMes + 1 };
  }

  // ------------------------------------------------------------------------
  // Login con Google Identity Services
  // ------------------------------------------------------------------------

  function elementos() {
    return {
      botonLogin: document.getElementById("btn-login"),
      botonLogout: document.getElementById("btn-logout"),
      botonTema: document.getElementById("btn-tema"),
      botonPrivado: document.getElementById("btn-privado"),
      panelLogin: document.getElementById("panel-login"),
      panelApp: document.getElementById("panel-app"),
      error: document.getElementById("mensaje-error"),
      filtroDesde: document.getElementById("filtro-desde"),
      filtroHasta: document.getElementById("filtro-hasta"),
      filtroCategoria: document.getElementById("filtro-categoria"),
      filtroMedioPago: document.getElementById("filtro-medio-pago"),
      filtroBuscar: document.getElementById("filtro-buscar"),
      btnAplicarFiltros: document.getElementById("btn-aplicar-filtros"),
      btnLimpiarFiltros: document.getElementById("btn-limpiar-filtros"),
      btnExportarCsv: document.getElementById("btn-exportar-csv"),
      selectorMes: document.getElementById("selector-mes"),
      listaMeses: document.getElementById("lista-meses"),
      btnVolverMesActual: document.getElementById("btn-volver-mes-actual"),
      btnResumenMesAnterior: document.getElementById("btn-resumen-mes-anterior"),
      btnResumenMesSiguiente: document.getElementById("btn-resumen-mes-siguiente"),
      selectorMesIngresos: document.getElementById("selector-mes-ingresos"),
      listaMesesIngresos: document.getElementById("lista-meses-ingresos"),
      btnVolverMesActualIngresos: document.getElementById("btn-volver-mes-actual-ingresos"),
      tabResumen: document.getElementById("tab-resumen"),
      tabGastos: document.getElementById("tab-gastos"),
      tabCalendario: document.getElementById("tab-calendario"),
      tabAnual: document.getElementById("tab-anual"),
      vistaResumen: document.getElementById("vista-resumen"),
      vistaGastos: document.getElementById("vista-gastos"),
      vistaCalendario: document.getElementById("vista-calendario"),
      vistaAnual: document.getElementById("vista-anual"),
      btnAnualAnioAnterior: document.getElementById("btn-anual-anio-anterior"),
      btnAnualAnioSiguiente: document.getElementById("btn-anual-anio-siguiente"),
      btnVolverAnioActual: document.getElementById("btn-volver-anio-actual"),
      btnMesAnterior: document.getElementById("btn-mes-anterior"),
      btnMesSiguiente: document.getElementById("btn-mes-siguiente"),
      btnGastosMesAnterior: document.getElementById("btn-gastos-mes-anterior"),
      btnGastosMesSiguiente: document.getElementById("btn-gastos-mes-siguiente"),
      gastosMesLabel: document.getElementById("gastos-mes-label"),
      calendarioTitulo: document.getElementById("calendario-titulo"),
      calendarioGrid: document.getElementById("calendario-grid"),
      popupDiaFondo: document.getElementById("popup-dia-fondo"),
      popupDiaCerrar: document.getElementById("popup-dia-cerrar"),
      listaCategoriasEdicion: document.getElementById("lista-categorias-edicion"),
      listaMediosPagoEdicion: document.getElementById("lista-medios-pago-edicion"),
      modalEdicionFondo: document.getElementById("modal-edicion-fondo"),
      modalEdicionError: document.getElementById("modal-edicion-error"),
      modalFecha: document.getElementById("modal-fecha"),
      modalHora: document.getElementById("modal-hora"),
      modalCategoria: document.getElementById("modal-categoria"),
      modalMedioPago: document.getElementById("modal-medio-pago"),
      modalDescripcion: document.getElementById("modal-descripcion"),
      modalMontoTotal: document.getElementById("modal-monto-total"),
      campoModalMesPago: document.getElementById("campo-modal-mes-pago"),
      modalMesPago: document.getElementById("modal-mes-pago"),
      modalGuardar: document.getElementById("modal-guardar"),
      modalCancelar: document.getElementById("modal-cancelar"),
      modalMesPagoSoloFondo: document.getElementById("modal-mes-pago-solo-fondo"),
      modalMesPagoSoloError: document.getElementById("modal-mes-pago-solo-error"),
      modalMesPagoSolo: document.getElementById("modal-mes-pago-solo"),
      modalMesPagoSoloGuardar: document.getElementById("modal-mes-pago-solo-guardar"),
      modalMesPagoSoloCancelar: document.getElementById("modal-mes-pago-solo-cancelar"),
      btnAgregarCategoria: document.getElementById("btn-agregar-categoria"),
      modalCategoriaFondo: document.getElementById("modal-categoria-fondo"),
      modalCategoriaError: document.getElementById("modal-categoria-error"),
      categoriaNombre: document.getElementById("categoria-nombre"),
      paletaColores: document.getElementById("paleta-colores"),
      notaCategoriaColores: document.getElementById("nota-categoria-colores"),
      modalCategoriaCancelar: document.getElementById("modal-categoria-cancelar"),
      modalCategoriaGuardar: document.getElementById("modal-categoria-guardar"),
      btnAgregarMedioPago: document.getElementById("btn-agregar-medio-pago"),
      modalMedioPagoNuevoFondo: document.getElementById("modal-medio-pago-nuevo-fondo"),
      modalMedioPagoNuevoError: document.getElementById("modal-medio-pago-nuevo-error"),
      medioPagoNuevoNombre: document.getElementById("medio-pago-nuevo-nombre"),
      modalMedioPagoNuevoCancelar: document.getElementById("modal-medio-pago-nuevo-cancelar"),
      modalMedioPagoNuevoGuardar: document.getElementById("modal-medio-pago-nuevo-guardar"),
      tabIngresos: document.getElementById("tab-ingresos"),
      vistaIngresos: document.getElementById("vista-ingresos"),
      totalIngresosMes: document.getElementById("total-ingresos-mes"),
      totalAhorradoMes: document.getElementById("total-ahorrado-mes"),
      totalGastoReal: document.getElementById("total-gasto-real"),
      etiquetaIngresosMes: document.getElementById("etiqueta-ingresos-mes"),
      etiquetaAhorradoMes: document.getElementById("etiqueta-ahorrado-mes"),
      etiquetaGastoReal: document.getElementById("etiqueta-gasto-real"),
      btnIngresosMesAnterior: document.getElementById("btn-ingresos-mes-anterior"),
      btnIngresosMesSiguiente: document.getElementById("btn-ingresos-mes-siguiente"),
      ingresosMesLabel: document.getElementById("ingresos-mes-label"),
      btnAgregarIngreso: document.getElementById("btn-agregar-ingreso"),
      tablaIngresosCuerpo: document.getElementById("tabla-ingresos-cuerpo"),
      ingresosSinResultados: document.getElementById("ingresos-sin-resultados"),
      modalIngresoFondo: document.getElementById("modal-ingreso-fondo"),
      modalIngresoError: document.getElementById("modal-ingreso-error"),
      ingresoFecha: document.getElementById("ingreso-fecha"),
      ingresoDescripcion: document.getElementById("ingreso-descripcion"),
      ingresoMonto: document.getElementById("ingreso-monto"),
      ingresoPorcentaje: document.getElementById("ingreso-porcentaje"),
      ingresoMontoAhorro: document.getElementById("ingreso-monto-ahorro"),
      modalIngresoGuardar: document.getElementById("modal-ingreso-guardar"),
      modalIngresoCancelar: document.getElementById("modal-ingreso-cancelar"),
    };
  }

  function mostrarError(texto) {
    const { error } = elementos();
    error.textContent = texto;
    error.hidden = !texto;
  }

  function guardarToken(token, expiraEnSegundos) {
    const vencimiento = Date.now() + expiraEnSegundos * 1000 - 60000; // 1 min de margen
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, vencimiento }));
  }

  function tokenGuardadoValido() {
    try {
      const guardado = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (guardado && guardado.token && guardado.vencimiento > Date.now()) {
        return guardado.token;
      }
    } catch (e) {
      /* ignorar, se pide login de nuevo */
    }
    return null;
  }

  function iniciarSesion() {
    mostrarError("");
    if (!tokenClient) {
      mostrarError("Google Identity Services todavia no cargo. Recargá la página e intentá de nuevo.");
      return;
    }
    tokenClient.requestAccessToken({ prompt: "" });
  }

  // Trae el email de la cuenta que se logueo. Requiere el scope
  // userinfo.email (ver SCOPE arriba).
  async function obtenerEmailCuenta(token) {
    try {
      const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) return null;
      const datos = await resp.json();
      return (datos.email || "").toLowerCase();
    } catch (e) {
      return null;
    }
  }

  // SHA-256 en hex. Se usa para no tener ningun email en texto plano en el
  // codigo (que es publico): se compara el hash de la cuenta logueada
  // contra CONFIG.allowedEmailHash, nunca el email en si.
  async function sha256Hex(texto) {
    const bytes = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function revocarToken(token) {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(token, () => {});
    }
  }

  // Resguardo de UX (no es el limite de seguridad real: ese lo pone a quien
  // se comparte cada Google Sheet): si esta pagina tiene un hash de email
  // esperado configurado (CONFIG.allowedEmailHash) y la cuenta logueada es
  // otra, se rechaza EN SILENCIO (sin mostrar ningun email, ni el propio ni
  // el ajeno) y se vuelve a la pantalla de login.
  async function verificarCuentaPermitida(token) {
    if (!CONFIG.allowedEmailHash) return true;
    const email = await obtenerEmailCuenta(token);
    const hash = email ? await sha256Hex(email) : null;
    if (hash === CONFIG.allowedEmailHash) return true;

    revocarToken(token);
    sessionStorage.removeItem(STORAGE_KEY);
    accessToken = null;
    mostrarError("");
    mostrarPantallaLogin();
    return false;
  }

  async function alRecibirToken(respuesta) {
    if (respuesta.error) {
      mostrarError(
        "No se pudo iniciar sesión con Google (" +
          respuesta.error +
          "). Probá de nuevo, o revisá que la cuenta tenga acceso a esta planilla."
      );
      return;
    }
    const token = respuesta.access_token;
    const permitido = await verificarCuentaPermitida(token);
    if (!permitido) return;

    accessToken = token;
    guardarToken(accessToken, respuesta.expires_in || 3300);
    mostrarSesionActiva();
    cargarDatos();
  }

  function cerrarSesion() {
    revocarToken(accessToken);
    sessionStorage.removeItem(STORAGE_KEY);
    accessToken = null;
    mostrarError("");
    mostrarPantallaLogin();
  }

  function mostrarSesionActiva() {
    const { panelLogin, panelApp, botonLogout } = elementos();
    panelLogin.hidden = true;
    panelApp.hidden = false;
    if (botonLogout) botonLogout.hidden = false;
  }

  function mostrarPantallaLogin() {
    const { panelLogin, panelApp, botonLogout } = elementos();
    panelLogin.hidden = false;
    panelApp.hidden = true;
    if (botonLogout) botonLogout.hidden = true;
  }

  function inicializarLogin() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId,
      scope: SCOPE,
      callback: alRecibirToken,
    });

    const { botonLogin, botonLogout } = elementos();
    botonLogin.addEventListener("click", iniciarSesion);
    if (botonLogout) botonLogout.addEventListener("click", cerrarSesion);

    const guardado = tokenGuardadoValido();
    if (guardado) {
      verificarCuentaPermitida(guardado).then((permitido) => {
        if (!permitido) return; // ya mostro el error y la pantalla de login
        accessToken = guardado;
        mostrarSesionActiva();
        cargarDatos();
      });
    } else {
      mostrarPantallaLogin();
    }
  }

  // ------------------------------------------------------------------------
  // Datos: fetch a Sheets + parseo + agregaciones
  // ------------------------------------------------------------------------

  // Lee la pestaña "Config" - categorias (con su color) y medios de pago.
  // El bot solo la crea/semilla la primera vez; de ahi en mas es la fuente
  // real, editable desde aca mismo ("Agregar categoría"/"Agregar medio de
  // pago" mas abajo). Si la pestaña no existe todavia (instalacion recien
  // hecha, el bot nunca arranco), no es un error - se sigue usando el
  // fallback de CONFIG.categorias / la lista por default.
  async function cargarCategoriasDesdeSheet() {
    if (categoriasCargadasDesdeSheet) return;
    categoriasCargadasDesdeSheet = true; // se marca antes de la request: no reintentar en cada recarga aunque falle
    try {
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
          `${encodeURIComponent("Config!A2:C")}?valueRenderOption=UNFORMATTED_VALUE`,
        { headers: { Authorization: "Bearer " + accessToken } }
      );
      if (!resp.ok) return;
      const datos = await resp.json();
      const filas = datos.values || [];

      const categorias = filas.map((fila) => (fila[0] || "").trim()).filter(Boolean);
      if (categorias.length) CATEGORIAS_ORDEN = categorias;

      const slots = {};
      for (const fila of filas) {
        const categoria = (fila[0] || "").trim();
        const slot = Number(fila[1]);
        if (categoria && slot >= 1 && slot <= MAX_CATEGORIAS_CON_COLOR) slots[categoria] = slot;
      }
      COLOR_SLOT_POR_CATEGORIA = slots;

      const mediosPago = filas.map((fila) => (fila[2] || "").trim()).filter(Boolean);
      if (mediosPago.length) MEDIOS_PAGO_ORDEN = mediosPago;
    } catch (e) {
      // sin conexion, etc. - se sigue con el fallback, no hace falta mostrar error por esto
    }
  }

  // --------------------------------------------------------------------------
  // Agregar categoria (con color) o medio de pago nuevo - escriben directo en
  // la pestaña "Config" de la Sheet. Categoria y MedioPago son dos series
  // independientes que comparten filas (columnas A/B y C respectivamente),
  // asi que cada una busca su propia "proxima fila libre" en su propia
  // columna, sin pisar lo que la otra serie ya tenga en esa fila.
  // --------------------------------------------------------------------------

  let slotSeleccionadoNuevaCategoria = null;

  function abrirModalCategoria() {
    const el = elementos();
    el.modalCategoriaError.textContent = "";
    el.categoriaNombre.value = "";
    slotSeleccionadoNuevaCategoria = null;

    const slotsUsados = new Set(Object.values(COLOR_SLOT_POR_CATEGORIA));
    el.paletaColores.textContent = "";
    for (let slot = 1; slot <= MAX_CATEGORIAS_CON_COLOR; slot++) {
      const usado = slotsUsados.has(slot);
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch" + (usado ? " usado" : "");
      swatch.title = usado ? "Ya en uso" : "Slot " + slot;
      swatch.style.background = getComputedStyle(document.documentElement).getPropertyValue(`--series-${slot}`).trim();
      swatch.disabled = usado;
      swatch.addEventListener("click", () => {
        slotSeleccionadoNuevaCategoria = slot;
        Array.from(el.paletaColores.children).forEach((n) => n.classList.remove("seleccionado"));
        swatch.classList.add("seleccionado");
      });
      el.paletaColores.appendChild(swatch);
    }

    if (el.notaCategoriaColores) {
      const sinColoresLibres = slotsUsados.size >= MAX_CATEGORIAS_CON_COLOR;
      el.notaCategoriaColores.hidden = !sinColoresLibres;
      if (sinColoresLibres) {
        el.notaCategoriaColores.textContent =
          "Ya se usaron los 14 colores disponibles - esta categoría se va a ver en gris (como \"Otros\").";
      }
    }

    el.modalCategoriaFondo.hidden = false;
  }

  function cerrarModalCategoria() {
    elementos().modalCategoriaFondo.hidden = true;
  }

  // Busca la primera fila (1-based, ya contando el header) que esta libre en
  // una columna de la pestaña "Config" - lee solo esa columna para no pisar
  // lo que haya en las demas en esa misma fila.
  async function _proximaFilaLibreEnConfig(columna) {
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
        `${encodeURIComponent(`Config!${columna}2:${columna}`)}?valueRenderOption=UNFORMATTED_VALUE`,
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const datos = await resp.json();
    return (datos.values || []).length + 2;
  }

  async function guardarCategoriaNueva() {
    const el = elementos();
    el.modalCategoriaError.textContent = "";
    const nombre = el.categoriaNombre.value.trim();

    if (!nombre) {
      el.modalCategoriaError.textContent = "Escribí un nombre.";
      return;
    }
    if (CATEGORIAS_ORDEN.some((c) => c.toLowerCase() === nombre.toLowerCase())) {
      el.modalCategoriaError.textContent = "Ya existe una categoría con ese nombre.";
      return;
    }

    el.modalCategoriaGuardar.disabled = true;
    el.modalCategoriaGuardar.textContent = "Guardando...";
    try {
      const fila = await _proximaFilaLibreEnConfig("A");
      const datosAEscribir = [{ range: `Config!A${fila}`, values: [[nombre]] }];
      if (slotSeleccionadoNuevaCategoria) {
        datosAEscribir.push({ range: `Config!B${fila}`, values: [[slotSeleccionadoNuevaCategoria]] });
      }
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: datosAEscribir }),
        }
      );
      if (resp.status === 401) {
        cerrarModalCategoria();
        sessionStorage.removeItem(STORAGE_KEY);
        accessToken = null;
        mostrarPantallaLogin();
        mostrarError("La sesión venció. Iniciá sesión de nuevo.");
        return;
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
    } catch (e) {
      el.modalCategoriaError.textContent = "No se pudo guardar. Probá de nuevo.";
      el.modalCategoriaGuardar.disabled = false;
      el.modalCategoriaGuardar.textContent = "Guardar";
      return;
    }

    el.modalCategoriaGuardar.disabled = false;
    el.modalCategoriaGuardar.textContent = "Guardar";
    cerrarModalCategoria();
    categoriasCargadasDesdeSheet = false; // forzar releer "Config" la proxima vez
    await cargarDatos();
  }

  function abrirModalMedioPagoNuevo() {
    const el = elementos();
    el.modalMedioPagoNuevoError.textContent = "";
    el.medioPagoNuevoNombre.value = "";
    el.modalMedioPagoNuevoFondo.hidden = false;
  }

  function cerrarModalMedioPagoNuevo() {
    elementos().modalMedioPagoNuevoFondo.hidden = true;
  }

  async function guardarMedioPagoNuevo() {
    const el = elementos();
    el.modalMedioPagoNuevoError.textContent = "";
    const nombre = el.medioPagoNuevoNombre.value.trim();

    if (!nombre) {
      el.modalMedioPagoNuevoError.textContent = "Escribí un nombre.";
      return;
    }
    if (MEDIOS_PAGO_ORDEN.some((m) => m.toLowerCase() === nombre.toLowerCase())) {
      el.modalMedioPagoNuevoError.textContent = "Ya existe un medio de pago con ese nombre.";
      return;
    }

    el.modalMedioPagoNuevoGuardar.disabled = true;
    el.modalMedioPagoNuevoGuardar.textContent = "Guardando...";
    try {
      const fila = await _proximaFilaLibreEnConfig("C");
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
          `${encodeURIComponent(`Config!C${fila}`)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[nombre]] }),
        }
      );
      if (resp.status === 401) {
        cerrarModalMedioPagoNuevo();
        sessionStorage.removeItem(STORAGE_KEY);
        accessToken = null;
        mostrarPantallaLogin();
        mostrarError("La sesión venció. Iniciá sesión de nuevo.");
        return;
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
    } catch (e) {
      el.modalMedioPagoNuevoError.textContent = "No se pudo guardar. Probá de nuevo.";
      el.modalMedioPagoNuevoGuardar.disabled = false;
      el.modalMedioPagoNuevoGuardar.textContent = "Guardar";
      return;
    }

    el.modalMedioPagoNuevoGuardar.disabled = false;
    el.modalMedioPagoNuevoGuardar.textContent = "Guardar";
    cerrarModalMedioPagoNuevo();
    categoriasCargadasDesdeSheet = false; // forzar releer "Config" la proxima vez
    await cargarDatos();
  }

  async function cargarDatos() {
    mostrarError("");
    await cargarCategoriasDesdeSheet();
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
      `${encodeURIComponent(RANGO)}?valueRenderOption=UNFORMATTED_VALUE`;

    let resp;
    try {
      resp = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
    } catch (e) {
      mostrarError("No se pudo conectar con Google Sheets. Revisá tu conexión a internet.");
      return;
    }

    if (resp.status === 401) {
      // Token vencido/invalido: se limpia y se pide iniciar sesion de nuevo.
      sessionStorage.removeItem(STORAGE_KEY);
      accessToken = null;
      mostrarPantallaLogin();
      mostrarError("La sesión venció. Iniciá sesión de nuevo.");
      return;
    }
    if (resp.status === 403) {
      mostrarError(
        "Tu cuenta de Google no tiene acceso a esta planilla. Pedile a quien la administra que te " +
          "comparta acceso de lectura."
      );
      return;
    }
    if (!resp.ok) {
      mostrarError("Google Sheets devolvió un error (" + resp.status + "). Probá de nuevo en un momento.");
      return;
    }

    const datos = await resp.json();
    movimientos = parsearMovimientos(datos.values || []);
    renderizarTodo();
    cargarIngresos(); // Ingreso vs Gastos es la pestaña principal, se carga sola de entrada
  }

  // Solo la cuota 1 de cada compra se puede editar (fecha, categoria, medio
  // de pago, descripcion y monto total viven ahi; las cuotas siguientes son
  // formulas que dependen de esa fila y se recalculan solas en la Sheet).
  function esEditable(cuota) {
    return String(cuota).split("/")[0].trim() === "1";
  }

  function columnaLetra(indiceCeroBased) {
    let n = indiceCeroBased + 1;
    let letras = "";
    while (n > 0) {
      const resto = (n - 1) % 26;
      letras = String.fromCharCode(65 + resto) + letras;
      n = Math.floor((n - 1) / 26);
    }
    return letras;
  }

  function parsearMovimientos(filas) {
    if (!filas.length) return [];
    const encabezado = filas[0];
    const indice = {};
    encabezado.forEach((nombre, i) => {
      indice[nombre] = i;
    });
    indiceColumnas = indice; // se reusa al editar, para saber en que columna escribir

    function valor(fila, nombre, def) {
      const i = indice[nombre];
      if (i === undefined || fila[i] === undefined || fila[i] === "") return def;
      return fila[i];
    }

    const resultado = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      const fechaRaw = valor(fila, "Fecha y hora", null);
      if (fechaRaw === null) continue;
      let fecha;
      try {
        fecha = serialAFecha(Number(fechaRaw));
        if (isNaN(fecha.getTime())) continue;
      } catch (e) {
        continue;
      }

      const monto = Number(valor(fila, "Monto", 0)) || 0;
      const montoTotal = Number(valor(fila, "Monto total", monto)) || monto;
      const cuota = valor(fila, "Cuota", "");

      // "Mes de pago": en que mes se factura este gasto en credito (distinto
      // de "fecha", que es la fecha de compra). Solo esta poblado para filas
      // de credito cargadas despues de agregar esta columna; si esta vacio
      // (fila vieja, o no es credito) queda null y quien lo use debe caer
      // de nuevo en el default (mes de compra + 1).
      let mesPago = null;
      const mesPagoRaw = valor(fila, "Mes de pago", null);
      if (mesPagoRaw !== null) {
        try {
          const fechaMesPago = serialAFecha(Number(mesPagoRaw));
          if (!isNaN(fechaMesPago.getTime())) {
            mesPago = { anio: fechaMesPago.getUTCFullYear(), mes: fechaMesPago.getUTCMonth() + 1 };
          }
        } catch (e) {
          // se ignora, queda null
        }
      }

      resultado.push({
        fila: i + 1, // numero de fila real en la Sheet (fila[0] del array = fila 1 = encabezado)
        fecha,
        monto,
        categoria: valor(fila, "Categoria", "Otros") || "Otros",
        medioPago: valor(fila, "Medio de pago", ""),
        descripcion: valor(fila, "Descripcion", ""),
        cuota,
        montoTotal,
        mesPago,
        editable: esEditable(cuota),
      });
    }

    resultado.sort((a, b) => b.fecha - a.fecha);
    return resultado;
  }

  // ------------------------------------------------------------------------
  // Agregaciones (siempre sobre "monto", nunca "montoTotal")
  // ------------------------------------------------------------------------

  // mesReferencia: {anio, mes} del mes que se quiere ver arriba (tarjeta +
  // graficos de categoria/medio de pago). Si es null, se usa el mes actual
  // real.
  function calcularResumen(mesReferencia) {
    const ahora = new Date();
    const anioActualReal = ahora.getUTCFullYear();
    const mesActualReal = ahora.getUTCMonth() + 1;
    const ref = mesReferencia || { anio: anioActualReal, mes: mesActualReal };
    const { anio: anioAnterior, mes: mesAnterior } = sumarMeses(ref.anio, ref.mes, -1);

    let totalMes = 0;
    let totalMesAnterior = 0;
    const porCategoriaMes = {};
    const porMedioPagoMes = {};
    const porCategoriaCreditoMes = {};
    const porCategoriaDebitoEfectivoMes = {};

    for (const m of movimientos) {
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;

      if (anio === ref.anio && mes === ref.mes) {
        totalMes += m.monto;
        porCategoriaMes[m.categoria] = (porCategoriaMes[m.categoria] || 0) + m.monto;
        porMedioPagoMes[m.medioPago] = (porMedioPagoMes[m.medioPago] || 0) + m.monto;
        if ((m.medioPago || "").toLowerCase() === "credito") {
          porCategoriaCreditoMes[m.categoria] = (porCategoriaCreditoMes[m.categoria] || 0) + m.monto;
        } else {
          porCategoriaDebitoEfectivoMes[m.categoria] = (porCategoriaDebitoEfectivoMes[m.categoria] || 0) + m.monto;
        }
      } else if (anio === anioAnterior && mes === mesAnterior) {
        totalMesAnterior += m.monto;
      }
    }

    let variacionPct = null;
    if (totalMesAnterior > 0) {
      variacionPct = Math.round(((totalMes - totalMesAnterior) / totalMesAnterior) * 1000) / 10;
    } else if (totalMes === 0) {
      variacionPct = 0;
    }

    return {
      nombreMes: `${MESES_ES[ref.mes - 1]} ${ref.anio}`,
      esMesActualReal: ref.anio === anioActualReal && ref.mes === mesActualReal,
      totalMes,
      totalMesAnterior,
      variacionPct,
      nombreMesAnterior: `${MESES_ES[mesAnterior - 1]} ${anioAnterior}`,
      porCategoriaMes,
      porMedioPagoMes,
      porCategoriaCreditoMes,
      porCategoriaDebitoEfectivoMes,
    };
  }

  // Evolucion de los ultimos 12 meses reales + total historico: ninguno de
  // los dos depende del mes/año seleccionado en ninguna pestaña, viven en
  // la pestaña Anual.
  function calcularEvolucionMensual() {
    const ahora = new Date();
    const anioActualReal = ahora.getUTCFullYear();
    const mesActualReal = ahora.getUTCMonth() + 1;
    const porMesTotal = {};
    let totalHistorico = 0;

    for (const m of movimientos) {
      totalHistorico += m.monto;
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      const clave = `${anio}-${mes}`;
      porMesTotal[clave] = (porMesTotal[clave] || 0) + m.monto;
    }

    const evolucion = [];
    for (let i = 11; i >= 0; i--) {
      const { anio, mes } = sumarMeses(anioActualReal, mesActualReal, -i);
      const clave = `${anio}-${mes}`;
      evolucion.push({
        mes: `${MESES_ES[mes - 1]} ${anio}`,
        total: Math.round((porMesTotal[clave] || 0) * 100) / 100,
      });
    }

    return { evolucion, totalHistorico };
  }

  // Gasto de cada dia del mes de referencia (por fecha de compra, todos los
  // medios de pago - mismo criterio que "Total demandado" de esta pestaña).
  // Un dataset por categoria (para apilar en el grafico), no un color por
  // dia - un dia puede tener varias categorias mezcladas.
  function calcularGastoPorDia(mesReferencia) {
    const ahora = new Date();
    const ref = mesReferencia || { anio: ahora.getUTCFullYear(), mes: ahora.getUTCMonth() + 1 };
    const diasEnMes = new Date(Date.UTC(ref.anio, ref.mes, 0)).getUTCDate();
    const porDiaCategoria = Array.from({ length: diasEnMes }, () => ({}));
    const totalPorCategoria = {};

    for (const m of movimientos) {
      if (CATEGORIAS_EXCLUIDAS_POR_DIA.includes(m.categoria)) continue;
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      if (anio === ref.anio && mes === ref.mes) {
        const i = m.fecha.getUTCDate() - 1;
        porDiaCategoria[i][m.categoria] = (porDiaCategoria[i][m.categoria] || 0) + m.monto;
        totalPorCategoria[m.categoria] = (totalPorCategoria[m.categoria] || 0) + m.monto;
      }
    }

    // Categorias ordenadas de mayor a menor gasto en el mes, asi la mas
    // grande queda de base en la pila (mismo orden que el resto de la app).
    const categorias = ordenarPorValor(totalPorCategoria).map((e) => e[0]);
    const porCategoriaPorDia = {};
    for (const categoria of categorias) {
      porCategoriaPorDia[categoria] = porDiaCategoria.map((dia) => Math.round((dia[categoria] || 0) * 100) / 100);
    }

    return {
      dias: porDiaCategoria.map((_, i) => i + 1),
      categorias,
      porCategoriaPorDia,
    };
  }

  // Resumen de la pestaña Anual. Mismo criterio "por fecha de compra" que
  // Actividad mensual (no el de "facturado" de Ingreso vs Gastos), para no
  // mezclar dos convenciones distintas en la misma pestaña.
  function calcularAnual(anioReferencia) {
    const ahora = new Date();
    const anioActualReal = ahora.getUTCFullYear();
    const anio = anioReferencia || anioActualReal;
    const anioAnterior = anio - 1;

    let totalAnio = 0;
    let totalAnioAnterior = 0;
    const porCategoriaAnio = {};
    const porMesAhorro = new Array(12).fill(0);
    const porMesDebitoEfectivo = new Array(12).fill(0);
    const porMesCredito = new Array(12).fill(0);

    for (const m of movimientos) {
      const a = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      if (a === anio) {
        totalAnio += m.monto;
        porCategoriaAnio[m.categoria] = (porCategoriaAnio[m.categoria] || 0) + m.monto;
        if ((m.medioPago || "").toLowerCase() === "credito") {
          porMesCredito[mes - 1] += m.monto;
        } else {
          porMesDebitoEfectivo[mes - 1] += m.monto;
        }
      } else if (a === anioAnterior) {
        totalAnioAnterior += m.monto;
      }
    }
    for (const ing of ingresos) {
      if (ing.fecha.getUTCFullYear() === anio) {
        porMesAhorro[ing.fecha.getUTCMonth()] += ing.montoAhorrado;
      }
    }

    let variacionPct = null;
    if (totalAnioAnterior > 0) {
      variacionPct = Math.round(((totalAnio - totalAnioAnterior) / totalAnioAnterior) * 1000) / 10;
    } else if (totalAnio === 0) {
      variacionPct = 0;
    }

    const redondear = (arr) => arr.map((v) => Math.round(v * 100) / 100);

    return {
      anio,
      anioAnterior,
      esAnioActualReal: anio === anioActualReal,
      totalAnio,
      totalAnioAnterior,
      variacionPct,
      porCategoriaAnio,
      porMesAhorro: redondear(porMesAhorro),
      porMesDebitoEfectivo: redondear(porMesDebitoEfectivo),
      porMesCredito: redondear(porMesCredito),
    };
  }

  // ------------------------------------------------------------------------
  // Filtros de la tabla de detalle (solo afectan la tabla, no las tarjetas
  // ni los graficos de arriba, que siempre son "este mes"/historico)
  // ------------------------------------------------------------------------

  function leerFiltros() {
    const { filtroDesde, filtroHasta, filtroCategoria, filtroMedioPago, filtroBuscar } = elementos();
    return {
      desde: filtroDesde.value || "",
      hasta: filtroHasta.value || "",
      // multi-seleccion: array vacio = "todas" (sin filtrar)
      categoria: Array.from(filtroCategoria.selectedOptions).map((o) => o.value),
      medioPago: Array.from(filtroMedioPago.selectedOptions).map((o) => o.value),
      texto: (filtroBuscar.value || "").trim().toLowerCase(),
    };
  }

  function aplicarFiltros(lista) {
    const f = leerFiltros();
    let resultado = lista;

    if (f.desde) {
      const desde = new Date(f.desde + "T00:00:00Z");
      resultado = resultado.filter((m) => m.fecha >= desde);
    }
    if (f.hasta) {
      const hasta = new Date(f.hasta + "T00:00:00Z");
      hasta.setUTCDate(hasta.getUTCDate() + 1);
      resultado = resultado.filter((m) => m.fecha < hasta);
    }
    if (f.categoria.length) resultado = resultado.filter((m) => f.categoria.includes(m.categoria));
    if (f.medioPago.length) resultado = resultado.filter((m) => f.medioPago.includes(m.medioPago));
    if (f.texto) resultado = resultado.filter((m) => m.descripcion.toLowerCase().includes(f.texto));

    return resultado;
  }

  // Las opciones de categoria/medio de pago salen de lo que realmente hay
  // cargado en la Sheet (no de una lista fija en el codigo): asi, si se
  // agrega o edita una categoria a mano en la planilla, el filtro la ve.
  function poblarFiltros() {
    const { filtroCategoria, filtroMedioPago } = elementos();
    const categorias = [...new Set(movimientos.map((m) => m.categoria))].sort();
    const mediosPago = [...new Set(movimientos.map((m) => m.medioPago).filter(Boolean))].sort();

    const valoresPreviosCategoria = new Set(Array.from(filtroCategoria.selectedOptions).map((o) => o.value));
    const valoresPreviosMedioPago = new Set(Array.from(filtroMedioPago.selectedOptions).map((o) => o.value));

    // Multi-seleccion: sin opcion "Todas" (ninguna seleccionada = sin filtrar).
    filtroCategoria.innerHTML = "";
    for (const cat of categorias) {
      const opcion = document.createElement("option");
      opcion.value = cat;
      opcion.textContent = cat;
      opcion.selected = valoresPreviosCategoria.has(cat);
      filtroCategoria.appendChild(opcion);
    }

    // Multi-seleccion: sin opcion "Todos" (ninguna seleccionada = sin filtrar).
    filtroMedioPago.innerHTML = "";
    for (const medio of mediosPago) {
      const opcion = document.createElement("option");
      opcion.value = medio;
      opcion.textContent = medio;
      opcion.selected = valoresPreviosMedioPago.has(medio);
      filtroMedioPago.appendChild(opcion);
    }

    // Para sugerir al editar, se usa la lista COMPLETA conocida (de "Config",
    // via CATEGORIAS_ORDEN/MEDIOS_PAGO_ORDEN) y no solo lo que ya aparece en
    // los gastos - si no, una categoria recien agregada (todavia sin ningun
    // gasto) no se podria elegir hasta usarla una vez "a mano" en la Sheet.
    const { listaCategoriasEdicion, listaMediosPagoEdicion } = elementos();
    if (listaCategoriasEdicion) {
      listaCategoriasEdicion.textContent = "";
      for (const cat of CATEGORIAS_ORDEN.length ? CATEGORIAS_ORDEN : categorias) {
        const opcion = document.createElement("option");
        opcion.value = cat;
        listaCategoriasEdicion.appendChild(opcion);
      }
    }
    if (listaMediosPagoEdicion) {
      listaMediosPagoEdicion.textContent = "";
      for (const medio of MEDIOS_PAGO_ORDEN.length ? MEDIOS_PAGO_ORDEN : mediosPago) {
        const opcion = document.createElement("option");
        opcion.value = medio;
        listaMediosPagoEdicion.appendChild(opcion);
      }
    }
  }

  // ------------------------------------------------------------------------
  // Selector de "ver un mes especifico" (tarjeta + graficos de categoria y
  // medio de pago de arriba). Usa un <input> con <datalist>: escribis
  // "junio" y el navegador ya te sugiere los meses que coinciden, sin
  // codigo de dropdown propio.
  // ------------------------------------------------------------------------

  function llenarDatalistMeses(datalist, opciones) {
    if (!datalist) return;
    datalist.textContent = "";
    for (const o of opciones) {
      const opcion = document.createElement("option");
      opcion.value = o.etiqueta;
      datalist.appendChild(opcion);
    }
  }

  function poblarSelectorMes() {
    const { listaMeses, listaMesesIngresos } = elementos();

    const claves = new Set();
    const opciones = [];
    for (const m of movimientos) {
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      const clave = `${anio}-${mes}`;
      if (!claves.has(clave)) {
        claves.add(clave);
        opciones.push({ anio, mes, etiqueta: `${MESES_ES[mes - 1]} ${anio}` });
      }
    }
    opciones.sort((a, b) => b.anio - a.anio || b.mes - a.mes);
    mesesDisponibles = opciones;

    llenarDatalistMeses(listaMeses, opciones);
    llenarDatalistMeses(listaMesesIngresos, opciones);
  }

  // Mes global compartido por Actividad mensual, Ingreso vs Gastos y Gastos
  // detalle: cualquiera de las tres flechas/buscadores mueve a las otras
  // dos tambien.
  function irAMesGlobal(anio, mes) {
    mesGlobal = { anio, mes };
    sincronizarMesGlobal();
  }

  function moverMesGlobal(delta) {
    const ahora = new Date();
    const base = mesGlobal || { anio: ahora.getUTCFullYear(), mes: ahora.getUTCMonth() + 1 };
    const { anio, mes } = sumarMeses(base.anio, base.mes, delta);
    irAMesGlobal(anio, mes);
  }

  function volverAMesActualGlobal() {
    mesGlobal = null;
    sincronizarMesGlobal();
  }

  // Gastos detalle fija su rango Desde/Hasta al mes global exacto (si tenia
  // un rango personalizado a mano, se pierde - es lo esperable al usar la
  // navegacion global en cualquiera de las tres pestañas).
  function sincronizarMesGlobal() {
    renderizarResumenSuperior();
    renderizarIngresos();
    renderizarCalendario();
    const ahora = new Date();
    const ref = mesGlobal || { anio: ahora.getUTCFullYear(), mes: ahora.getUTCMonth() + 1 };
    fijarRangoMesGastos(ref.anio, ref.mes);
    renderizarTabla();
  }

  function seleccionarMesDesdeInput() {
    const { selectorMes } = elementos();
    const texto = selectorMes.value.trim().toLowerCase();
    const encontrado = mesesDisponibles.find((o) => o.etiqueta.toLowerCase() === texto);
    if (!encontrado) return;
    irAMesGlobal(encontrado.anio, encontrado.mes);
  }

  function seleccionarMesIngresosDesdeInput() {
    const { selectorMesIngresos } = elementos();
    const texto = selectorMesIngresos.value.trim().toLowerCase();
    const encontrado = mesesDisponibles.find((o) => o.etiqueta.toLowerCase() === texto);
    if (!encontrado) return;
    irAMesGlobal(encontrado.anio, encontrado.mes);
  }

  function limpiarFiltros() {
    const { filtroDesde, filtroHasta, filtroCategoria, filtroMedioPago, filtroBuscar } = elementos();
    filtroDesde.value = "";
    filtroHasta.value = "";
    Array.from(filtroCategoria.options).forEach((o) => (o.selected = false));
    Array.from(filtroMedioPago.options).forEach((o) => (o.selected = false));
    filtroBuscar.value = "";
    renderizarTabla();
  }

  // Navegacion por mes en la pestaña Gastos (ademas de poder tipear un
  // rango Desde/Hasta a mano, que sigue funcionando igual). Los botones
  // ‹ › mueven el mes global compartido (arriba); un rango a mano que no
  // sea un mes limpio queda local a esta pestaña, sin mover a las otras dos.
  function primerYUltimoDiaMes(anio, mes) {
    const primero = `${anio}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    const ultimo = `${anio}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
    return { primero, ultimo };
  }

  function fijarRangoMesGastos(anio, mes) {
    const { filtroDesde, filtroHasta } = elementos();
    const { primero, ultimo } = primerYUltimoDiaMes(anio, mes);
    filtroDesde.value = primero;
    filtroHasta.value = ultimo;
  }

  // Deriva la etiqueta ("Septiembre 2026" / "Rango personalizado" / "Todo el
  // historial") a partir de lo que haya en Desde/Hasta ahora mismo. Si es un
  // mes limpio, tambien sincroniza mesGlobal (sin re-renderizar en cascada -
  // renderizarTabla ya se esta ejecutando en este momento).
  function actualizarEtiquetaMesGastos() {
    const { filtroDesde, filtroHasta, gastosMesLabel } = elementos();
    if (!gastosMesLabel) return;
    const desde = filtroDesde.value;
    const hasta = filtroHasta.value;

    if (!desde && !hasta) {
      gastosMesLabel.textContent = "Todo el historial";
      return;
    }
    if (desde && hasta) {
      const d = new Date(desde + "T00:00:00Z");
      const anio = d.getUTCFullYear();
      const mes = d.getUTCMonth() + 1;
      const { primero, ultimo } = primerYUltimoDiaMes(anio, mes);
      if (desde === primero && hasta === ultimo) {
        mesGlobal = { anio, mes };
        gastosMesLabel.textContent = `${MESES_ES[mes - 1]} ${anio}`;
        return;
      }
    }
    gastosMesLabel.textContent = "Rango personalizado";
  }

  function exportarCsv() {
    const filas = aplicarFiltros(movimientos);
    const encabezado = ["Fecha", "Monto", "Categoria", "Medio de pago", "Descripcion", "Cuota", "Monto total"];
    const lineas = [encabezado.join(",")];
    for (const m of filas) {
      const celda = (texto) => '"' + String(texto).replaceAll('"', '""') + '"';
      lineas.push(
        [
          formatoFecha(m.fecha),
          m.monto,
          celda(m.categoria),
          celda(m.medioPago),
          celda(m.descripcion),
          celda(m.cuota),
          m.montoTotal,
        ].join(",")
      );
    }
    const blob = new Blob(["﻿" + lineas.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = "gastos.csv";
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------------------
  // Pestañas (Resumen / Calendario)
  // ------------------------------------------------------------------------

  function mostrarVista(nombre) {
    const {
      vistaResumen,
      vistaGastos,
      vistaIngresos,
      vistaCalendario,
      vistaAnual,
      tabResumen,
      tabGastos,
      tabIngresos,
      tabCalendario,
      tabAnual,
    } = elementos();
    vistaResumen.hidden = nombre !== "resumen";
    vistaGastos.hidden = nombre !== "gastos";
    vistaIngresos.hidden = nombre !== "ingresos";
    vistaCalendario.hidden = nombre !== "calendario";
    if (vistaAnual) vistaAnual.hidden = nombre !== "anual";
    tabResumen.classList.toggle("activa", nombre === "resumen");
    tabGastos.classList.toggle("activa", nombre === "gastos");
    tabIngresos.classList.toggle("activa", nombre === "ingresos");
    tabCalendario.classList.toggle("activa", nombre === "calendario");
    if (tabAnual) tabAnual.classList.toggle("activa", nombre === "anual");
    // Resumen y Gastos se re-renderizan al entrar por si el mes global
    // cambio desde otra pestaña mientras esta no estaba visible.
    if (nombre === "resumen" && movimientos.length) renderizarResumenSuperior();
    if (nombre === "gastos" && movimientos.length) renderizarTabla();
    if (nombre === "calendario") renderizarCalendario();
    if (nombre === "ingresos") cargarIngresos();
    if (nombre === "anual") renderizarAnual();
  }

  // ------------------------------------------------------------------------
  // Calendario: navegar entre meses, ver que dias tuvieron gastos, y un
  // popup con el detalle de ese dia (como las apps de entrenamiento que
  // marcan en que dias hiciste ejercicio).
  // ------------------------------------------------------------------------

  const DIAS_SEMANA = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

  function claveDia(fecha) {
    const yyyy = fecha.getUTCFullYear();
    const mm = String(fecha.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(fecha.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function indicePorDia() {
    const mapa = {};
    for (const m of movimientos) {
      const clave = claveDia(m.fecha);
      (mapa[clave] = mapa[clave] || []).push(m);
    }
    return mapa;
  }

  function renderizarCalendario() {
    const ahora = new Date();
    const calRef = mesGlobal || { anio: ahora.getUTCFullYear(), mes: ahora.getUTCMonth() + 1 };

    const { calendarioTitulo, calendarioGrid } = elementos();
    calendarioTitulo.textContent = `${MESES_ES[calRef.mes - 1]} ${calRef.anio}`;

    const mapa = indicePorDia();
    calendarioGrid.textContent = "";

    for (const nombre of DIAS_SEMANA) {
      const cabecera = document.createElement("div");
      cabecera.className = "calendario-dow";
      cabecera.textContent = nombre;
      calendarioGrid.appendChild(cabecera);
    }

    const primerDia = new Date(Date.UTC(calRef.anio, calRef.mes - 1, 1));
    const offset = (primerDia.getUTCDay() + 6) % 7; // lunes=0
    const diasEnMes = new Date(Date.UTC(calRef.anio, calRef.mes, 0)).getUTCDate();
    const hoy = claveDia(new Date());

    for (let i = 0; i < offset; i++) {
      const vacio = document.createElement("div");
      vacio.className = "calendario-celda vacia";
      calendarioGrid.appendChild(vacio);
    }

    for (let dia = 1; dia <= diasEnMes; dia++) {
      const clave = `${calRef.anio}-${String(calRef.mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      const gastosDelDia = mapa[clave];

      const celda = document.createElement("button");
      celda.type = "button";
      celda.className = "calendario-celda";
      if (clave === hoy) celda.classList.add("hoy");

      const numero = document.createElement("span");
      numero.className = "numero";
      numero.textContent = String(dia);
      celda.appendChild(numero);

      if (gastosDelDia && gastosDelDia.length) {
        celda.classList.add("con-gasto");
        const punto = document.createElement("span");
        punto.className = "punto";
        celda.appendChild(punto);
        celda.addEventListener("click", () => abrirPopupDia(clave, gastosDelDia));
      } else {
        celda.disabled = true;
      }

      calendarioGrid.appendChild(celda);
    }
  }

  function moverCalendario(delta) {
    moverMesGlobal(delta);
  }

  function abrirPopupDia(clave, gastosDelDia) {
    const total = gastosDelDia.reduce((acc, g) => acc + g.monto, 0);
    document.getElementById("popup-dia-titulo").textContent = clave;
    document.getElementById("popup-dia-total").textContent = formatoMoneda(total);

    const lista = document.getElementById("popup-dia-lista");
    lista.textContent = "";
    for (const g of gastosDelDia) {
      const item = document.createElement("li");

      const cat = document.createElement("span");
      cat.className = "cat";
      cat.textContent = g.categoria;

      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = g.descripcion;

      const monto = document.createElement("span");
      monto.className = "monto";
      monto.textContent = formatoMoneda(g.monto);

      item.appendChild(cat);
      item.appendChild(desc);
      item.appendChild(monto);
      lista.appendChild(item);
    }

    elementos().popupDiaFondo.hidden = false;
  }

  function cerrarPopupDia() {
    elementos().popupDiaFondo.hidden = true;
  }

  // ------------------------------------------------------------------------
  // Editar un gasto (solo cuota 1). Escribe directo en la Sheet con el
  // mismo access token de lectura (ahora con scope de escritura tambien).
  // No hace falta recalcular nada a mano: las cuotas 2, 3... ya son formulas
  // que viven en esas celdas desde que el bot las creo, y Google Sheets las
  // recalcula solo en cuanto esta escritura cambia la cuota 1.
  // ------------------------------------------------------------------------

  function abrirModalEdicion(gasto) {
    filaEnEdicion = gasto.fila;
    const el = elementos();
    el.modalEdicionError.textContent = "";
    el.modalFecha.value = `${gasto.fecha.getUTCFullYear()}-${String(gasto.fecha.getUTCMonth() + 1).padStart(2, "0")}-${String(gasto.fecha.getUTCDate()).padStart(2, "0")}`;
    el.modalHora.value = `${String(gasto.fecha.getUTCHours()).padStart(2, "0")}:${String(gasto.fecha.getUTCMinutes()).padStart(2, "0")}`;
    el.modalCategoria.value = gasto.categoria;
    el.modalMedioPago.value = gasto.medioPago;
    el.modalDescripcion.value = gasto.descripcion;
    el.modalMontoTotal.value = gasto.montoTotal;
    const esCredito = (gasto.medioPago || "").toLowerCase() === "credito";
    if (el.campoModalMesPago) el.campoModalMesPago.hidden = !esCredito;
    if (el.modalMesPago) {
      el.modalMesPago.value = gasto.mesPago
        ? `${gasto.mesPago.anio}-${String(gasto.mesPago.mes).padStart(2, "0")}`
        : "";
    }
    el.modalEdicionFondo.hidden = false;
  }

  function cerrarModalEdicion() {
    elementos().modalEdicionFondo.hidden = true;
    filaEnEdicion = null;
  }

  // Edicion minima para cuotas 2+ (no editables en el modal completo, porque
  // fecha/monto/categoria/etc. son formulas que dependen de la cuota 1): el
  // "Mes de pago" de cada cuota SI es un valor propio, independiente, asi que
  // se puede corregir una cuota puntual sin afectar a las demas.
  let filaEnEdicionMesPagoSolo = null;

  function abrirModalMesPagoSolo(gasto) {
    filaEnEdicionMesPagoSolo = gasto.fila;
    const el = elementos();
    el.modalMesPagoSoloError.textContent = "";
    el.modalMesPagoSolo.value = gasto.mesPago
      ? `${gasto.mesPago.anio}-${String(gasto.mesPago.mes).padStart(2, "0")}`
      : "";
    el.modalMesPagoSoloFondo.hidden = false;
  }

  function cerrarModalMesPagoSolo() {
    elementos().modalMesPagoSoloFondo.hidden = true;
    filaEnEdicionMesPagoSolo = null;
  }

  async function guardarMesPagoSolo() {
    const el = elementos();
    el.modalMesPagoSoloError.textContent = "";

    const valorMes = el.modalMesPagoSolo.value; // "YYYY-MM" o vacio
    if (!valorMes) {
      el.modalMesPagoSoloError.textContent = "Elegí un mes.";
      return;
    }
    if (indiceColumnas["Mes de pago"] === undefined) {
      el.modalMesPagoSoloError.textContent = 'Falta la columna "Mes de pago" en la planilla.';
      return;
    }

    const fila = filaEnEdicionMesPagoSolo;
    const rango = `${NOMBRE_HOJA}!${columnaLetra(indiceColumnas["Mes de pago"])}${fila}`;

    el.modalMesPagoSoloGuardar.disabled = true;
    el.modalMesPagoSoloGuardar.textContent = "Guardando...";
    try {
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/${encodeURIComponent(rango)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[`${valorMes}-01`]] }),
        }
      );
      if (resp.status === 401) {
        cerrarModalMesPagoSolo();
        sessionStorage.removeItem(STORAGE_KEY);
        accessToken = null;
        mostrarPantallaLogin();
        mostrarError("La sesión venció. Iniciá sesión de nuevo.");
        return;
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
    } catch (e) {
      el.modalMesPagoSoloError.textContent = "No se pudo guardar. Probá de nuevo.";
      el.modalMesPagoSoloGuardar.disabled = false;
      el.modalMesPagoSoloGuardar.textContent = "Guardar";
      return;
    }

    el.modalMesPagoSoloGuardar.disabled = false;
    el.modalMesPagoSoloGuardar.textContent = "Guardar";
    cerrarModalMesPagoSolo();
    await cargarDatos();
  }

  async function guardarEdicion() {
    const el = elementos();
    el.modalEdicionError.textContent = "";

    const fecha = el.modalFecha.value;
    const hora = el.modalHora.value || "00:00";
    const categoria = el.modalCategoria.value.trim();
    const medioPago = el.modalMedioPago.value.trim();
    const descripcion = el.modalDescripcion.value.trim();
    const montoTotal = Number(el.modalMontoTotal.value);

    const errores = [];
    if (!fecha) errores.push("Falta la fecha.");
    if (!categoria) errores.push("Falta la categoría.");
    if (!medioPago) errores.push("Falta el medio de pago.");
    if (!descripcion) errores.push("Falta la descripción.");
    if (!montoTotal || montoTotal <= 0) errores.push("El monto total tiene que ser mayor a 0.");
    if (errores.length) {
      el.modalEdicionError.textContent = errores.join(" ");
      return;
    }

    const columnasNecesarias = ["Fecha y hora", "Categoria", "Medio de pago", "Descripcion", "Monto total"];
    const faltantes = columnasNecesarias.filter((c) => indiceColumnas[c] === undefined);
    if (faltantes.length) {
      el.modalEdicionError.textContent = "Faltan columnas en la planilla: " + faltantes.join(", ");
      return;
    }

    const fechaHora = `${fecha} ${hora}`;
    const fila = filaEnEdicion;
    const rango = (nombreColumna) => `${NOMBRE_HOJA}!${columnaLetra(indiceColumnas[nombreColumna])}${fila}`;

    const datosAEscribir = [
      { range: rango("Fecha y hora"), values: [[fechaHora]] },
      { range: rango("Categoria"), values: [[categoria]] },
      { range: rango("Medio de pago"), values: [[medioPago]] },
      { range: rango("Descripcion"), values: [[descripcion]] },
      { range: rango("Monto total"), values: [[montoTotal]] },
    ];

    // "Mes de pago" es independiente por fila (no una formula encadenada como
    // el resto), asi que se puede escribir junto con lo demas sin afectar
    // otras cuotas. Solo se manda si el campo esta visible (credito) y tiene
    // un valor cargado - si esta vacio, se deja el valor que ya hubiera.
    if (!el.campoModalMesPago.hidden && el.modalMesPago.value && indiceColumnas["Mes de pago"] !== undefined) {
      datosAEscribir.push({ range: rango("Mes de pago"), values: [[`${el.modalMesPago.value}-01`]] });
    }

    const body = { valueInputOption: "USER_ENTERED", data: datosAEscribir };

    el.modalGuardar.disabled = true;
    el.modalGuardar.textContent = "Guardando...";
    try {
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (resp.status === 401) {
        cerrarModalEdicion();
        sessionStorage.removeItem(STORAGE_KEY);
        accessToken = null;
        mostrarPantallaLogin();
        mostrarError("La sesión venció. Iniciá sesión de nuevo.");
        return;
      }
      if (!resp.ok) {
        const detalle = await resp.json().catch(() => null);
        throw new Error((detalle && detalle.error && detalle.error.message) || "Error " + resp.status);
      }
    } catch (e) {
      el.modalEdicionError.textContent = "No se pudo guardar (" + e.message + "). Probá de nuevo.";
      el.modalGuardar.disabled = false;
      el.modalGuardar.textContent = "Guardar";
      return;
    }

    el.modalGuardar.disabled = false;
    el.modalGuardar.textContent = "Guardar";
    cerrarModalEdicion();
    await cargarDatos(); // vuelve a leer: ya trae las cuotas siguientes recalculadas
  }

  // ------------------------------------------------------------------------
  // Ingresos (sueldo, etc). Vive en su propia hoja de la misma Sheet
  // ("Ingresos"), separada de "Gastos". Se crea sola la primera vez.
  // ------------------------------------------------------------------------

  // Busca la hoja "Ingresos" en la Sheet; si no existe, la crea con el
  // encabezado. Se hace como mucho una vez por sesion (hojaIngresosVerificada).
  async function escribirHeaderIngresos() {
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
        `${encodeURIComponent(NOMBRE_HOJA_INGRESOS + "!A1:F1")}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [HEADER_INGRESOS] }),
      }
    );
    return resp.ok;
  }

  // Se fija que la hoja "Ingresos" exista y que su fila 1 sea realmente el
  // encabezado esperado - y si no, lo corrige. Se chequea siempre (no solo
  // al crear la hoja), asi es autocorregible si un intento anterior fallo a
  // mitad de camino (ej: se creo la hoja pero no se llego a escribir el
  // encabezado, y una carga de ingreso termino en la fila 1).
  async function asegurarHojaIngresos() {
    if (hojaIngresosVerificada) return true;

    const respMeta = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}?fields=sheets.properties.title,sheets.properties.sheetId`,
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!respMeta.ok) return false;
    const meta = await respMeta.json();
    const hojaExistente = (meta.sheets || []).find((s) => s.properties.title === NOMBRE_HOJA_INGRESOS);

    if (!hojaExistente) {
      const respCrear = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{ addSheet: { properties: { title: NOMBRE_HOJA_INGRESOS } } }],
          }),
        }
      );
      if (!respCrear.ok) return false;

      if (!(await escribirHeaderIngresos())) return false;
      hojaIngresosVerificada = true;
      return true;
    }

    // La hoja ya existia (de antes, o de un intento previo): se revisa que
    // la fila 1 sea de verdad el encabezado.
    const respFila1 = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
        `${encodeURIComponent(NOMBRE_HOJA_INGRESOS + "!A1:F1")}?valueRenderOption=UNFORMATTED_VALUE`,
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    if (!respFila1.ok) return false;
    const datosFila1 = await respFila1.json();
    const primeraFila = (datosFila1.values || [])[0];
    const headerOk = !!primeraFila && HEADER_INGRESOS.every((col, i) => primeraFila[i] === col);

    if (!headerOk) {
      const filaVacia = !primeraFila || primeraFila.every((v) => v === undefined || v === "");
      if (!filaVacia) {
        // La fila 1 tiene datos que no son el encabezado (paso algo raro
        // antes): se inserta una fila arriba para no pisarlos.
        const respInsertar = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}:batchUpdate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [
                {
                  insertDimension: {
                    range: { sheetId: hojaExistente.properties.sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
                    inheritFromBefore: false,
                  },
                },
              ],
            }),
          }
        );
        if (!respInsertar.ok) return false;
      }
      if (!(await escribirHeaderIngresos())) return false;
    }

    hojaIngresosVerificada = true;
    return true;
  }

  function parsearIngresos(filas) {
    if (!filas.length) return [];
    const encabezado = filas[0];
    const indice = {};
    encabezado.forEach((nombre, i) => {
      indice[nombre] = i;
    });

    function valor(fila, nombre, def) {
      const i = indice[nombre];
      if (i === undefined || fila[i] === undefined || fila[i] === "") return def;
      return fila[i];
    }

    const resultado = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      const fechaRaw = valor(fila, "Fecha", null);
      if (fechaRaw === null) continue;
      let fecha;
      try {
        fecha = serialAFecha(Number(fechaRaw));
        if (isNaN(fecha.getTime())) continue;
      } catch (e) {
        continue;
      }

      const monto = Number(valor(fila, "Monto", 0)) || 0;
      const montoAhorrado = Number(valor(fila, "Monto ahorrado", 0)) || 0;

      resultado.push({
        fila: i + 1,
        fecha,
        descripcion: valor(fila, "Descripcion", ""),
        monto,
        porcentajeAhorro: Number(valor(fila, "Porcentaje ahorro", 0)) || 0,
        montoAhorrado,
        montoDisponible: Number(valor(fila, "Monto disponible", monto - montoAhorrado)),
      });
    }

    resultado.sort((a, b) => b.fecha - a.fecha);
    return resultado;
  }

  async function cargarIngresos() {
    const ok = await asegurarHojaIngresos();
    if (!ok) return;

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
      `${encodeURIComponent(RANGO_INGRESOS)}?valueRenderOption=UNFORMATTED_VALUE`;

    let resp;
    try {
      resp = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
    } catch (e) {
      return;
    }
    if (resp.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      accessToken = null;
      mostrarPantallaLogin();
      mostrarError("La sesión venció. Iniciá sesión de nuevo.");
      return;
    }
    if (!resp.ok) return;

    const datos = await resp.json();
    ingresos = parsearIngresos(datos.values || []);
    renderizarIngresos();
  }

  // mesReferencia: {anio, mes} del mes que se quiere ver (tarjetas de arriba).
  // Si es null, se usa el mes actual real. La evolucion de 12 meses es
  // siempre global, no depende de esto (igual que en calcularResumen).
  function calcularResumenIngresos(mesReferencia) {
    const ahora = new Date();
    const anioActual = ahora.getUTCFullYear();
    const mesActual = ahora.getUTCMonth() + 1;
    const ref = mesReferencia || { anio: anioActual, mes: mesActual };

    let totalMes = 0;
    let ahorradoMes = 0;
    const porMesIngreso = {};
    const porMesAhorro = {};

    for (const ing of ingresos) {
      const anio = ing.fecha.getUTCFullYear();
      const mes = ing.fecha.getUTCMonth() + 1;
      const clave = `${anio}-${mes}`;
      porMesIngreso[clave] = (porMesIngreso[clave] || 0) + ing.monto;
      porMesAhorro[clave] = (porMesAhorro[clave] || 0) + ing.montoAhorrado;

      if (anio === ref.anio && mes === ref.mes) {
        totalMes += ing.monto;
        ahorradoMes += ing.montoAhorrado;
      }
    }

    const evolucionAhorro = [];
    const evolucionDisponible = [];
    const etiquetasMeses = [];
    for (let i = 11; i >= 0; i--) {
      const { anio, mes } = sumarMeses(anioActual, mesActual, -i);
      const clave = `${anio}-${mes}`;
      const ahorro = Math.round((porMesAhorro[clave] || 0) * 100) / 100;
      const ingresoTotal = Math.round((porMesIngreso[clave] || 0) * 100) / 100;
      etiquetasMeses.push(`${MESES_ES[mes - 1].slice(0, 3)} ${anio}`);
      evolucionAhorro.push(ahorro);
      evolucionDisponible.push(Math.max(0, ingresoTotal - ahorro));
    }

    return {
      nombreMes: `${MESES_ES[ref.mes - 1]} ${ref.anio}`,
      esMesActualReal: ref.anio === anioActual && ref.mes === mesActual,
      totalMes,
      ahorradoMes,
      etiquetasMeses,
      evolucionAhorro,
      evolucionDisponible,
    };
  }

  // En que mes se factura/paga un movimiento de credito: si la fila tiene
  // "Mes de pago" cargado (bot nuevo, con la logica de cierre ambiguo), se
  // usa ese valor tal cual. Si no (filas viejas, cargadas antes de esa
  // columna), se cae en el default historico: mes de compra + 1.
  function mesPagoEfectivo(m) {
    if (m.mesPago) return m.mesPago;
    const anio = m.fecha.getUTCFullYear();
    const mes = m.fecha.getUTCMonth() + 1;
    return sumarMeses(anio, mes, 1);
  }

  // Aproxima "cuanto salio realmente de mi bolsillo" en el mes de referencia:
  // lo que se pago en efectivo/debito/transferencia ESE mes, mas lo que se
  // compro con tarjeta de credito y se factura ESE mes segun "Mes de pago"
  // (o, a falta de ese dato, el mes ANTERIOR por default). Sirve para
  // comparar contra los ingresos del mes sin mezclar compras en cuotas que
  // todavia no se pagaron.
  function calcularGastoRealMes(mesReferencia) {
    const ahora = new Date();
    const anioActualReal = ahora.getUTCFullYear();
    const mesActualReal = ahora.getUTCMonth() + 1;
    const ref = mesReferencia || { anio: anioActualReal, mes: mesActualReal };
    const anterior = sumarMeses(ref.anio, ref.mes, -1);

    let totalNoCredito = 0;
    let totalCreditoAnterior = 0;
    const porCategoriaNoCredito = {};
    const porCategoriaCreditoAnterior = {};

    for (const m of movimientos) {
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      const esCredito = (m.medioPago || "").toLowerCase() === "credito";

      if (!esCredito && anio === ref.anio && mes === ref.mes) {
        totalNoCredito += m.monto;
        porCategoriaNoCredito[m.categoria] = (porCategoriaNoCredito[m.categoria] || 0) + m.monto;
      } else if (esCredito) {
        const pago = mesPagoEfectivo(m);
        if (pago.anio !== ref.anio || pago.mes !== ref.mes) continue;
        totalCreditoAnterior += m.monto;
        porCategoriaCreditoAnterior[m.categoria] = (porCategoriaCreditoAnterior[m.categoria] || 0) + m.monto;
      }
    }

    // El ahorro del mes se suma como si fuera una categoria mas del grupo
    // no-credito: separar plata para ahorrar tambien es plata que deja de
    // estar disponible este mes, igual que un gasto real.
    let ahorradoMes = 0;
    for (const ing of ingresos) {
      const anio = ing.fecha.getUTCFullYear();
      const mes = ing.fecha.getUTCMonth() + 1;
      if (anio === ref.anio && mes === ref.mes) ahorradoMes += ing.montoAhorrado;
    }
    if (ahorradoMes > 0) {
      totalNoCredito += ahorradoMes;
      porCategoriaNoCredito["Ahorro"] = (porCategoriaNoCredito["Ahorro"] || 0) + ahorradoMes;
    }

    return {
      nombreMes: `${MESES_ES[ref.mes - 1]} ${ref.anio}`,
      nombreMesAnterior: `${MESES_ES[anterior.mes - 1]} ${anterior.anio}`,
      esMesActualReal: ref.anio === anioActualReal && ref.mes === mesActualReal,
      totalNoCredito,
      totalCreditoAnterior,
      totalGastoReal: totalNoCredito + totalCreditoAnterior,
      porCategoriaNoCredito,
      porCategoriaCreditoAnterior,
    };
  }

  function graficoIngresoAhorro(canvasId, resumen) {
    if (graficoIngresoAhorroInstancia) {
      graficoIngresoAhorroInstancia.destroy();
      graficoIngresoAhorroInstancia = null;
    }
    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: resumen.etiquetasMeses,
        datasets: [
          {
            label: "Ahorrado",
            data: resumen.evolucionAhorro,
            backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--good").trim(),
            borderRadius: 4,
          },
          {
            label: "Disponible",
            data: resumen.evolucionDisponible,
            backgroundColor: colorDeCategoria("Otros"),
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { color: colorTexto("secondary") } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatoMoneda(ctx.parsed.y)}` } },
        },
        scales: {
          x: { stacked: true, ticks: { color: colorTexto("muted") }, grid: { display: false } },
          y: { stacked: true, ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
        },
      },
    });
    graficoIngresoAhorroInstancia = grafico;
  }

  function renderizarTablaIngresos() {
    const { tablaIngresosCuerpo, ingresosSinResultados } = elementos();
    tablaIngresosCuerpo.textContent = "";
    ingresosSinResultados.hidden = ingresos.length > 0;

    for (const ing of ingresos) {
      const fila = document.createElement("tr");
      const celdas = [
        formatoFecha(ing.fecha).slice(0, 10),
        ing.descripcion,
        formatoMoneda(ing.monto),
        ing.porcentajeAhorro ? `${ing.porcentajeAhorro}%` : "-",
        formatoMoneda(ing.montoAhorrado),
        formatoMoneda(ing.montoDisponible),
      ];
      for (const texto of celdas) {
        const td = document.createElement("td");
        td.textContent = texto;
        fila.appendChild(td);
      }

      const tdAccion = document.createElement("td");
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "btn secundario chico";
      boton.textContent = "Editar";
      boton.addEventListener("click", () => abrirModalIngreso(ing));
      tdAccion.appendChild(boton);
      fila.appendChild(tdAccion);

      tablaIngresosCuerpo.appendChild(fila);
    }
  }

  function renderizarIngresos() {
    const resumen = calcularResumenIngresos(mesGlobal);
    const gastoReal = calcularGastoRealMes(mesGlobal);
    const diferenciaMes = resumen.totalMes - gastoReal.totalGastoReal;
    const {
      totalIngresosMes,
      totalAhorradoMes,
      totalGastoReal,
      etiquetaIngresosMes,
      etiquetaAhorradoMes,
      etiquetaGastoReal,
      ingresosMesLabel,
      selectorMesIngresos,
    } = elementos();

    if (selectorMesIngresos) selectorMesIngresos.value = resumen.esMesActualReal ? "" : resumen.nombreMes;

    totalIngresosMes.textContent = formatoMoneda(resumen.totalMes);
    totalAhorradoMes.textContent = formatoMoneda(resumen.ahorradoMes);
    totalGastoReal.textContent = formatoMoneda(gastoReal.totalGastoReal);

    if (ingresosMesLabel) ingresosMesLabel.textContent = resumen.nombreMes;
    if (etiquetaIngresosMes) {
      etiquetaIngresosMes.textContent = resumen.esMesActualReal ? "Ingresos este mes" : `Ingresos en ${resumen.nombreMes}`;
    }
    if (etiquetaAhorradoMes) {
      etiquetaAhorradoMes.textContent = resumen.esMesActualReal ? "Ahorrado este mes" : `Ahorrado en ${resumen.nombreMes}`;
    }
    if (etiquetaGastoReal) {
      etiquetaGastoReal.textContent = gastoReal.esMesActualReal ? "Gasto real este mes" : `Gasto real en ${gastoReal.nombreMes}`;
    }

    const etiquetaDiferenciaMes = document.getElementById("etiqueta-diferencia-mes");
    if (etiquetaDiferenciaMes) {
      etiquetaDiferenciaMes.textContent = resumen.esMesActualReal ? "Plata restante (este mes)" : `Plata restante (${resumen.nombreMes})`;
    }
    const valorDiferenciaMes = document.getElementById("valor-diferencia-mes");
    if (valorDiferenciaMes) {
      valorDiferenciaMes.textContent = formatoMoneda(diferenciaMes);
      valorDiferenciaMes.classList.remove("buena", "mala");
      valorDiferenciaMes.classList.add(diferenciaMes >= 0 ? "buena" : "mala");
    }
    const notaDiferenciaMes = document.getElementById("nota-diferencia-mes");
    if (notaDiferenciaMes) {
      notaDiferenciaMes.textContent = '"Plata restante" = Ingreso del mes menos Gasto real (arriba).';
    }

    const notaGastoReal = document.getElementById("nota-gasto-real");
    if (notaGastoReal) {
      notaGastoReal.textContent =
        `${capitalizar(NOMBRE_GRUPO_NO_CREDITO)} de ${gastoReal.nombreMes} + tarjeta de crédito de ${gastoReal.nombreMesAnterior} ` +
        "(lo que normalmente ya se factura este mes).";
    }
    const tituloComparacionGastoReal = document.getElementById("titulo-gasto-real-comparacion");
    if (tituloComparacionGastoReal) {
      tituloComparacionGastoReal.textContent = `${capitalizar(NOMBRE_GRUPO_NO_CREDITO)} vs crédito facturado`;
    }
    const tituloCategoriaDebito = document.getElementById("titulo-categoria-debito");
    if (tituloCategoriaDebito) {
      tituloCategoriaDebito.textContent = `Por categoría · ${NOMBRE_GRUPO_NO_CREDITO} (${gastoReal.nombreMes})`;
    }
    const notaCategoriaDebito = document.getElementById("nota-categoria-debito");
    if (notaCategoriaDebito) {
      notaCategoriaDebito.textContent = (gastoReal.porCategoriaNoCredito["Ahorro"] || 0) > 0
        ? "Incluye el ahorro del mes como si fuera una categoría más: separarlo también es plata que dejó de estar disponible."
        : "";
    }
    const tituloCategoriaCreditoFacturado = document.getElementById("titulo-categoria-credito-facturado");
    if (tituloCategoriaCreditoFacturado) {
      tituloCategoriaCreditoFacturado.textContent = `Por categoría · crédito (${gastoReal.nombreMesAnterior})`;
    }

    graficoIngresoAhorro("grafico-ingreso-ahorro", resumen);
    graficoBarrasHorizontal(
      "grafico-gasto-real",
      [
        [capitalizar(NOMBRE_GRUPO_NO_CREDITO), gastoReal.totalNoCredito],
        [`Crédito (${gastoReal.nombreMesAnterior})`, gastoReal.totalCreditoAnterior],
      ],
      (etiqueta) => (etiqueta.startsWith("Crédito") ? conAlpha(colorSecuencial(), 0.5) : colorSecuencial())
    );
    graficoBarrasHorizontal(
      "grafico-categoria-debito",
      ordenarPorValor(gastoReal.porCategoriaNoCredito),
      (categoria) => (categoria === "Ahorro" ? colorBueno() : colorDeCategoria(categoria))
    );
    graficoBarrasHorizontal(
      "grafico-categoria-credito-facturado",
      ordenarPorValor(gastoReal.porCategoriaCreditoAnterior),
      colorDeCategoria
    );

    renderizarTablaIngresos();
  }

  // ------------------------------------------------------------------------
  // Modal "Agregar ingreso": los campos de % y monto a ahorrar estan
  // enlazados (editar uno recalcula el otro en base al Monto de arriba).
  // ------------------------------------------------------------------------

  function abrirModalIngreso(ingreso) {
    const el = elementos();
    el.modalIngresoError.textContent = "";
    const titulo = document.getElementById("modal-ingreso-titulo");

    if (ingreso) {
      filaIngresoEnEdicion = ingreso.fila;
      if (titulo) titulo.textContent = "Editar ingreso";
      el.ingresoFecha.value = `${ingreso.fecha.getUTCFullYear()}-${String(ingreso.fecha.getUTCMonth() + 1).padStart(2, "0")}-${String(ingreso.fecha.getUTCDate()).padStart(2, "0")}`;
      el.ingresoDescripcion.value = ingreso.descripcion;
      el.ingresoMonto.value = ingreso.monto;
      el.ingresoPorcentaje.value = ingreso.porcentajeAhorro || "";
      el.ingresoMontoAhorro.value = ingreso.montoAhorrado;
    } else {
      filaIngresoEnEdicion = null;
      if (titulo) titulo.textContent = "Agregar ingreso";
      const hoy = new Date();
      el.ingresoFecha.value = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, "0")}-${String(hoy.getUTCDate()).padStart(2, "0")}`;
      el.ingresoDescripcion.value = "Sueldo";
      el.ingresoMonto.value = "";
      el.ingresoPorcentaje.value = "";
      el.ingresoMontoAhorro.value = "";
    }
    el.modalIngresoFondo.hidden = false;
  }

  function cerrarModalIngreso() {
    elementos().modalIngresoFondo.hidden = true;
    filaIngresoEnEdicion = null;
  }

  function actualizarAhorroDesdePorcentaje() {
    const el = elementos();
    const monto = Number(el.ingresoMonto.value) || 0;
    const pct = Number(el.ingresoPorcentaje.value) || 0;
    if (monto > 0) el.ingresoMontoAhorro.value = Math.round(monto * (pct / 100) * 100) / 100;
  }

  function actualizarPorcentajeDesdeAhorro() {
    const el = elementos();
    const monto = Number(el.ingresoMonto.value) || 0;
    const ahorro = Number(el.ingresoMontoAhorro.value) || 0;
    if (monto > 0) el.ingresoPorcentaje.value = Math.round((ahorro / monto) * 1000) / 10;
  }

  async function guardarIngreso() {
    const el = elementos();
    el.modalIngresoError.textContent = "";

    const fecha = el.ingresoFecha.value;
    const descripcion = el.ingresoDescripcion.value.trim();
    const monto = Number(el.ingresoMonto.value);
    const montoAhorrado = Number(el.ingresoMontoAhorro.value) || 0;
    const porcentaje = Number(el.ingresoPorcentaje.value) || 0;

    const errores = [];
    if (!fecha) errores.push("Falta la fecha.");
    if (!descripcion) errores.push("Falta la descripción.");
    if (!monto || monto <= 0) errores.push("El monto tiene que ser mayor a 0.");
    if (montoAhorrado < 0) errores.push("El ahorro no puede ser negativo.");
    if (montoAhorrado > monto) errores.push("El ahorro no puede ser mayor al monto.");
    if (errores.length) {
      el.modalIngresoError.textContent = errores.join(" ");
      return;
    }

    const montoDisponible = Math.round((monto - montoAhorrado) * 100) / 100;
    const fila = [fecha, descripcion, monto, porcentaje, montoAhorrado, montoDisponible];
    const editando = filaIngresoEnEdicion !== null;

    el.modalIngresoGuardar.disabled = true;
    el.modalIngresoGuardar.textContent = "Guardando...";
    try {
      const ok = await asegurarHojaIngresos();
      if (!ok) throw new Error("no se pudo preparar la hoja de Ingresos");

      const resp = editando
        ? await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
              `${encodeURIComponent(`${NOMBRE_HOJA_INGRESOS}!A${filaIngresoEnEdicion}:F${filaIngresoEnEdicion}`)}` +
              `?valueInputOption=USER_ENTERED`,
            {
              method: "PUT",
              headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ values: [fila] }),
            }
          )
        : await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/` +
              `${encodeURIComponent(RANGO_INGRESOS)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            {
              method: "POST",
              headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ values: [fila] }),
            }
          );
      if (resp.status === 401) {
        cerrarModalIngreso();
        sessionStorage.removeItem(STORAGE_KEY);
        accessToken = null;
        mostrarPantallaLogin();
        mostrarError("La sesión venció. Iniciá sesión de nuevo.");
        return;
      }
      if (!resp.ok) {
        const detalle = await resp.json().catch(() => null);
        throw new Error((detalle && detalle.error && detalle.error.message) || "Error " + resp.status);
      }
    } catch (e) {
      el.modalIngresoError.textContent = "No se pudo guardar (" + e.message + "). Probá de nuevo.";
      el.modalIngresoGuardar.disabled = false;
      el.modalIngresoGuardar.textContent = "Guardar";
      return;
    }

    el.modalIngresoGuardar.disabled = false;
    el.modalIngresoGuardar.textContent = "Guardar";
    cerrarModalIngreso();
    await cargarIngresos();
  }

  // ------------------------------------------------------------------------
  // Graficos (Chart.js)
  // ------------------------------------------------------------------------

  function destruirGraficos() {
    graficosActivos.forEach((g) => g.destroy());
    graficosActivos = [];
  }

  // OJO con esto: en Chart.js, para una barra VERTICAL el valor real esta en
  // ctx.parsed.y, pero ctx.parsed.x tambien existe (es el indice de la
  // categoria, un numero valido, NO null/undefined). Por eso el tooltip no
  // puede usar "parsed.x ?? parsed.y" como si fuera generico para los dos
  // casos - hay que decirle explicitamente a cada grafico cual es su eje de
  // valor (x para las horizontales con indexAxis:"y", y para las verticales).
  const OPCIONES_BASE = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
    },
  };

  function graficoBarrasHorizontal(canvasId, entradas, colorPorEtiqueta) {
    const existente = Chart.getChart(canvasId);
    if (existente) existente.destroy();

    const etiquetas = entradas.map((e) => e[0]);
    const valores = entradas.map((e) => e[1]);
    const colores = etiquetas.map((e) => colorPorEtiqueta(e));

    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: { labels: etiquetas, datasets: [{ data: valores, backgroundColor: colores, borderRadius: 4, barThickness: 18 }] },
      options: {
        ...OPCIONES_BASE,
        indexAxis: "y",
        plugins: {
          ...OPCIONES_BASE.plugins,
          tooltip: { callbacks: { label: (ctx) => formatoMoneda(ctx.parsed.x) } },
        },
        scales: {
          x: { ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
          y: { ticks: { color: colorTexto("secondary") }, grid: { display: false } },
        },
      },
    });
    graficosActivos.push(grafico);
  }

  function graficoEvolucion(canvasId, evolucion) {
    const existente = Chart.getChart(canvasId);
    if (existente) existente.destroy();

    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: evolucion.map((e) => e.mes),
        datasets: [{ data: evolucion.map((e) => e.total), backgroundColor: colorSecuencial(), borderRadius: 4 }],
      },
      options: {
        ...OPCIONES_BASE,
        plugins: {
          ...OPCIONES_BASE.plugins,
          tooltip: { callbacks: { label: (ctx) => formatoMoneda(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { color: colorTexto("muted") }, grid: { display: false } },
          y: { ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
        },
      },
    });
    graficosActivos.push(grafico);
  }

  function graficoPorDia(canvasId, datos) {
    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: datos.dias.map((d) => String(d)),
        datasets: datos.categorias.map((categoria) => ({
          label: categoria,
          data: datos.porCategoriaPorDia[categoria],
          backgroundColor: colorDeCategoria(categoria),
          borderRadius: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: datos.categorias.length > 1,
            position: "bottom",
            labels: { color: colorTexto("secondary") },
          },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatoMoneda(ctx.parsed.y)}` } },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: colorTexto("muted"), autoSkip: true, maxTicksLimit: 16 },
            grid: { display: false },
          },
          y: { stacked: true, ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
        },
      },
    });
    graficosActivos.push(grafico);
  }

  function conAlpha(hex, alpha) {
    const limpio = hex.replace("#", "").trim();
    const r = parseInt(limpio.substring(0, 2), 16);
    const g = parseInt(limpio.substring(2, 4), 16);
    const b = parseInt(limpio.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function graficoAnualPorMes(canvasId, datos) {
    const existente = Chart.getChart(canvasId);
    if (existente) existente.destroy();

    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: MESES_ES.map((m) => m.slice(0, 3)),
        datasets: [
          { label: "Ahorro", data: datos.porMesAhorro, backgroundColor: colorBueno(), borderRadius: 3 },
          { label: "Débito/efectivo", data: datos.porMesDebitoEfectivo, backgroundColor: colorSecuencial(), borderRadius: 3 },
          { label: "Crédito", data: datos.porMesCredito, backgroundColor: conAlpha(colorSecuencial(), 0.5), borderRadius: 3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom", labels: { color: colorTexto("secondary") } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatoMoneda(ctx.parsed.y)}` } },
        },
        scales: {
          x: { stacked: true, ticks: { color: colorTexto("muted") }, grid: { display: false } },
          y: { stacked: true, ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
        },
      },
    });
    return grafico;
  }

  // Ultimos 6 meses (para tendencia) + los meses futuros que ya tengan
  // cuotas de credito cargadas (sin un limite de "12 meses" fijo como la
  // evolucion general, hasta un tope de 12 meses para adelante para que el
  // grafico no se estire de mas). Esto responde "cuanto voy a deber", no
  // solo "cuanto gaste": las cuotas futuras ya estan en la Sheet como filas
  // con fecha futura.
  function calcularEvolucionCredito() {
    const ahora = new Date();
    const anioActual = ahora.getUTCFullYear();
    const mesActual = ahora.getUTCMonth() + 1;

    const porMesCredito = {};
    let maxAnio = anioActual;
    let maxMes = mesActual;

    for (const m of movimientos) {
      if ((m.medioPago || "").toLowerCase() !== "credito") continue;
      const anio = m.fecha.getUTCFullYear();
      const mes = m.fecha.getUTCMonth() + 1;
      porMesCredito[`${anio}-${mes}`] = (porMesCredito[`${anio}-${mes}`] || 0) + m.monto;
      if (anio > maxAnio || (anio === maxAnio && mes > maxMes)) {
        maxAnio = anio;
        maxMes = mes;
      }
    }

    const limite = sumarMeses(anioActual, mesActual, 12);
    if (maxAnio > limite.anio || (maxAnio === limite.anio && maxMes > limite.mes)) {
      maxAnio = limite.anio;
      maxMes = limite.mes;
    }

    const inicio = sumarMeses(anioActual, mesActual, -5);
    const meses = [];
    let cursor = { anio: inicio.anio, mes: inicio.mes };
    while (cursor.anio < maxAnio || (cursor.anio === maxAnio && cursor.mes <= maxMes)) {
      const clave = `${cursor.anio}-${cursor.mes}`;
      meses.push({
        mes: `${MESES_ES[cursor.mes - 1].slice(0, 3)} ${cursor.anio}`,
        total: Math.round((porMesCredito[clave] || 0) * 100) / 100,
        esFuturo: cursor.anio > anioActual || (cursor.anio === anioActual && cursor.mes > mesActual),
      });
      cursor = sumarMeses(cursor.anio, cursor.mes, 1);
    }
    return meses;
  }

  function graficoTarjetaCredito(canvasId, meses) {
    const existente = Chart.getChart(canvasId);
    if (existente) existente.destroy();

    const colorBase = colorSecuencial();
    const colores = meses.map((m) => (m.esFuturo ? conAlpha(colorBase, 0.4) : colorBase));

    const grafico = new Chart(document.getElementById(canvasId), {
      type: "bar",
      data: {
        labels: meses.map((m) => m.mes),
        datasets: [{ data: meses.map((m) => m.total), backgroundColor: colores, borderRadius: 4 }],
      },
      options: {
        ...OPCIONES_BASE,
        plugins: {
          ...OPCIONES_BASE.plugins,
          tooltip: { callbacks: { label: (ctx) => formatoMoneda(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { color: colorTexto("muted") }, grid: { display: false } },
          y: { ticks: { color: colorTexto("muted"), callback: (v) => formatoMoneda(v) }, grid: { color: colorGrid() } },
        },
      },
    });
    graficosActivos.push(grafico);
  }

  // ------------------------------------------------------------------------
  // Tabla de detalle (texto siempre por textContent, nunca innerHTML, para
  // no correr riesgo de HTML/script inyectado desde una celda de la Sheet)
  // ------------------------------------------------------------------------

  function renderizarTabla() {
    actualizarEtiquetaMesGastos();
    const cuerpo = document.getElementById("tabla-cuerpo");
    const sinResultados = document.getElementById("tabla-sin-resultados");
    cuerpo.textContent = "";

    const filas = aplicarFiltros(movimientos);
    sinResultados.hidden = filas.length > 0;

    for (const m of filas) {
      const fila = document.createElement("tr");
      const celdas = [
        formatoFecha(m.fecha),
        formatoMoneda(m.monto),
        m.categoria,
        m.medioPago,
        m.descripcion,
        m.cuota,
        formatoMoneda(m.montoTotal),
        m.mesPago ? `${MESES_ES[m.mesPago.mes - 1]} ${m.mesPago.anio}` : "",
      ];
      for (const texto of celdas) {
        const td = document.createElement("td");
        td.textContent = texto;
        fila.appendChild(td);
      }

      const tdAccion = document.createElement("td");
      if (m.editable) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "btn secundario chico";
        boton.textContent = "Editar";
        boton.addEventListener("click", () => abrirModalEdicion(m));
        tdAccion.appendChild(boton);
      } else if ((m.medioPago || "").toLowerCase() === "credito") {
        // El resto de esta cuota se recalcula sola desde la cuota 1, pero el
        // mes de pago es independiente por fila y se puede corregir solo.
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "btn secundario chico";
        boton.textContent = "Mes de pago";
        boton.title = "El resto de esta cuota se recalcula sola desde la primera; el mes de pago se puede corregir solo";
        boton.addEventListener("click", () => abrirModalMesPagoSolo(m));
        tdAccion.appendChild(boton);
      } else {
        const pill = document.createElement("span");
        pill.className = "pill-no-editable";
        pill.title = "Se recalcula sola desde la cuota 1 de esta compra";
        pill.textContent = "—";
        tdAccion.appendChild(pill);
      }
      fila.appendChild(tdAccion);

      cuerpo.appendChild(fila);
    }
  }

  function renderizarBadgeVariacion(resumen) {
    const badge = document.getElementById("badge-variacion");
    if (!badge) return;
    if (resumen.variacionPct === null) {
      badge.textContent = "";
      badge.className = "badge-variacion";
      return;
    }
    const esBuena = resumen.variacionPct <= 0;
    badge.className = "badge-variacion " + (esBuena ? "buena" : "mala");
    const signo = resumen.variacionPct > 0 ? "+" : "";
    badge.textContent = `${esBuena ? "▼" : "▲"} ${signo}${resumen.variacionPct}% vs ${resumen.nombreMesAnterior}`;
  }

  function renderizarBadgeVariacionAnual(datos) {
    const badge = document.getElementById("badge-variacion-anual");
    if (!badge) return;
    if (datos.variacionPct === null) {
      badge.textContent = "";
      badge.className = "badge-variacion";
      return;
    }
    const esBuena = datos.variacionPct <= 0;
    badge.className = "badge-variacion " + (esBuena ? "buena" : "mala");
    const signo = datos.variacionPct > 0 ? "+" : "";
    badge.textContent = `${esBuena ? "▼" : "▲"} ${signo}${datos.variacionPct}% vs ${datos.anioAnterior}`;
  }

  // Tarjeta de total + los dos graficos de arriba (categoria, medio de pago)
  // + evolucion. Se separa de renderizarTodo() porque esto solo es lo que
  // cambia cuando se elige un mes especifico con el selector.
  function renderizarResumenSuperior() {
    const resumen = calcularResumen(mesGlobal);

    const { selectorMes } = elementos();
    if (selectorMes) selectorMes.value = resumen.esMesActualReal ? "" : resumen.nombreMes;
    const resumenMesLabel = document.getElementById("resumen-mes-label");
    if (resumenMesLabel) resumenMesLabel.textContent = resumen.nombreMes;

    const etiquetaTotalMes = document.getElementById("etiqueta-total-mes");
    if (etiquetaTotalMes) {
      etiquetaTotalMes.textContent = resumen.esMesActualReal
        ? "Total demandado este mes"
        : "Total demandado en " + resumen.nombreMes;
    }
    document.getElementById("total-mes").textContent = formatoMoneda(resumen.totalMes);
    renderizarBadgeVariacion(resumen);

    const etiquetaTransporteMes = document.getElementById("etiqueta-transporte-mes");
    if (etiquetaTransporteMes) {
      etiquetaTransporteMes.textContent = resumen.esMesActualReal
        ? "Transporte este mes"
        : "Transporte en " + resumen.nombreMes;
    }
    const totalTransporteMes = document.getElementById("total-transporte-mes");
    if (totalTransporteMes) {
      totalTransporteMes.textContent = formatoMoneda(resumen.porCategoriaMes["Transporte"] || 0);
    }

    const tituloMedioPago = document.getElementById("titulo-medio-pago");
    if (tituloMedioPago) {
      tituloMedioPago.textContent = resumen.esMesActualReal
        ? "Por medio de pago (este mes)"
        : `Por medio de pago (${resumen.nombreMes})`;
    }
    const tituloCategoriaCredito = document.getElementById("titulo-categoria-credito");
    if (tituloCategoriaCredito) {
      tituloCategoriaCredito.textContent = resumen.esMesActualReal
        ? "Por categoría con tarjeta de crédito (este mes)"
        : `Por categoría con tarjeta de crédito (${resumen.nombreMes})`;
    }
    const tituloCategoriaDebitoEfectivo = document.getElementById("titulo-categoria-debito-efectivo");
    if (tituloCategoriaDebitoEfectivo) {
      tituloCategoriaDebitoEfectivo.textContent = resumen.esMesActualReal
        ? `Por categoría en ${NOMBRE_GRUPO_NO_CREDITO} (este mes)`
        : `Por categoría en ${NOMBRE_GRUPO_NO_CREDITO} (${resumen.nombreMes})`;
    }
    const tituloPorDia = document.getElementById("titulo-por-dia");
    if (tituloPorDia) {
      tituloPorDia.textContent = resumen.esMesActualReal ? "Por día (este mes)" : `Por día (${resumen.nombreMes})`;
    }
    const notaPorDia = document.getElementById("nota-por-dia");
    if (notaPorDia) {
      notaPorDia.textContent = CATEGORIAS_EXCLUIDAS_POR_DIA.length
        ? `No incluye ${CATEGORIAS_EXCLUIDAS_POR_DIA.join(" ni ")} (gastos fijos grandes que tapaban el resto).`
        : "";
    }

    destruirGraficos();
    graficoBarrasHorizontal("grafico-medio-pago", ordenarPorValor(resumen.porMedioPagoMes), () => colorSecuencial());
    graficoPorDia("grafico-por-dia", calcularGastoPorDia(mesGlobal));
    graficoBarrasHorizontal("grafico-categoria-credito", ordenarPorValor(resumen.porCategoriaCreditoMes), colorDeCategoria);
    graficoBarrasHorizontal(
      "grafico-categoria-debito-efectivo",
      ordenarPorValor(resumen.porCategoriaDebitoEfectivoMes),
      colorDeCategoria
    );
  }

  function renderizarAnual() {
    const datos = calcularAnual(anioSeleccionado);

    const anioLabel = document.getElementById("anual-anio-label");
    if (anioLabel) anioLabel.textContent = String(datos.anio);

    const etiquetaTotalAnio = document.getElementById("etiqueta-total-anio");
    if (etiquetaTotalAnio) {
      etiquetaTotalAnio.textContent = datos.esAnioActualReal ? "Total demandado este año" : `Total demandado en ${datos.anio}`;
    }
    const totalAnio = document.getElementById("total-anio");
    if (totalAnio) totalAnio.textContent = formatoMoneda(datos.totalAnio);
    renderizarBadgeVariacionAnual(datos);

    const etiquetaTransporteAnio = document.getElementById("etiqueta-transporte-anio");
    if (etiquetaTransporteAnio) {
      etiquetaTransporteAnio.textContent = datos.esAnioActualReal ? "Transporte este año" : `Transporte en ${datos.anio}`;
    }
    const totalTransporteAnio = document.getElementById("total-transporte-anio");
    if (totalTransporteAnio) totalTransporteAnio.textContent = formatoMoneda(datos.porCategoriaAnio["Transporte"] || 0);

    const tituloCategoriaAnual = document.getElementById("titulo-categoria-anual");
    if (tituloCategoriaAnual) tituloCategoriaAnual.textContent = `Por categoría (${datos.anio})`;

    graficoBarrasHorizontal("grafico-categoria-anual", ordenarPorValor(datos.porCategoriaAnio), colorDeCategoria);
    graficoAnualPorMes("grafico-anual-por-mes", datos);

    const evolucionDatos = calcularEvolucionMensual();
    const totalHistorico = document.getElementById("total-historico");
    if (totalHistorico) totalHistorico.textContent = formatoMoneda(evolucionDatos.totalHistorico);
    graficoEvolucion("grafico-evolucion", evolucionDatos.evolucion);
    graficoTarjetaCredito("grafico-tarjeta-credito", calcularEvolucionCredito());
  }

  function moverAnio(delta) {
    const ahora = new Date();
    const base = anioSeleccionado || ahora.getUTCFullYear();
    anioSeleccionado = base + delta;
    renderizarAnual();
  }

  function volverAAnioActual() {
    anioSeleccionado = null;
    renderizarAnual();
  }

  function renderizarTodo() {
    renderizarResumenSuperior();
    poblarSelectorMes();
    poblarFiltros();
    if (!gastosInicializado) {
      gastosInicializado = true;
      const ahora = new Date();
      fijarRangoMesGastos(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1);
    }
    renderizarTabla();
  }

  // ------------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------------

  function esperarGoogleIdentity() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      inicializarLogin();
    } else {
      setTimeout(esperarGoogleIdentity, 100);
    }
  }

  function inicializarUI() {
    const {
      botonTema,
      botonPrivado,
      btnAplicarFiltros,
      btnLimpiarFiltros,
      btnExportarCsv,
      filtroBuscar,
      selectorMes,
      btnVolverMesActual,
      btnResumenMesAnterior,
      btnResumenMesSiguiente,
      selectorMesIngresos,
      btnVolverMesActualIngresos,
      tabResumen,
      tabGastos,
      tabIngresos,
      tabCalendario,
      tabAnual,
      btnAnualAnioAnterior,
      btnAnualAnioSiguiente,
      btnVolverAnioActual,
      btnMesAnterior,
      btnMesSiguiente,
      btnGastosMesAnterior,
      btnGastosMesSiguiente,
      btnIngresosMesAnterior,
      btnIngresosMesSiguiente,
      popupDiaFondo,
      popupDiaCerrar,
      modalEdicionFondo,
      modalGuardar,
      modalCancelar,
      modalMesPagoSoloFondo,
      modalMesPagoSoloGuardar,
      modalMesPagoSoloCancelar,
      btnAgregarCategoria,
      modalCategoriaFondo,
      modalCategoriaCancelar,
      modalCategoriaGuardar,
      btnAgregarMedioPago,
      modalMedioPagoNuevoFondo,
      modalMedioPagoNuevoCancelar,
      modalMedioPagoNuevoGuardar,
      btnAgregarIngreso,
      modalIngresoFondo,
      modalIngresoGuardar,
      modalIngresoCancelar,
      ingresoPorcentaje,
      ingresoMontoAhorro,
    } = elementos();

    if (botonTema) {
      botonTema.addEventListener("click", alternarTema);
      actualizarIconoTema();
    }
    if (botonPrivado) {
      botonPrivado.addEventListener("click", alternarModoPrivado);
      actualizarIconoPrivado();
    }
    if (btnAplicarFiltros) btnAplicarFiltros.addEventListener("click", renderizarTabla);
    if (btnLimpiarFiltros) btnLimpiarFiltros.addEventListener("click", limpiarFiltros);
    if (btnExportarCsv) btnExportarCsv.addEventListener("click", exportarCsv);
    if (filtroBuscar) {
      filtroBuscar.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") renderizarTabla();
      });
    }

    if (selectorMes) {
      selectorMes.addEventListener("change", seleccionarMesDesdeInput);
      selectorMes.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") seleccionarMesDesdeInput();
      });
    }
    if (btnVolverMesActual) btnVolverMesActual.addEventListener("click", volverAMesActualGlobal);
    if (btnResumenMesAnterior) btnResumenMesAnterior.addEventListener("click", () => moverMesGlobal(-1));
    if (btnResumenMesSiguiente) btnResumenMesSiguiente.addEventListener("click", () => moverMesGlobal(1));

    if (selectorMesIngresos) {
      selectorMesIngresos.addEventListener("change", seleccionarMesIngresosDesdeInput);
      selectorMesIngresos.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") seleccionarMesIngresosDesdeInput();
      });
    }
    if (btnVolverMesActualIngresos) btnVolverMesActualIngresos.addEventListener("click", volverAMesActualGlobal);

    if (tabResumen) tabResumen.addEventListener("click", () => mostrarVista("resumen"));
    if (tabGastos) tabGastos.addEventListener("click", () => mostrarVista("gastos"));
    if (tabIngresos) tabIngresos.addEventListener("click", () => mostrarVista("ingresos"));
    if (tabCalendario) tabCalendario.addEventListener("click", () => mostrarVista("calendario"));
    if (tabAnual) tabAnual.addEventListener("click", () => mostrarVista("anual"));
    if (btnAnualAnioAnterior) btnAnualAnioAnterior.addEventListener("click", () => moverAnio(-1));
    if (btnAnualAnioSiguiente) btnAnualAnioSiguiente.addEventListener("click", () => moverAnio(1));
    if (btnVolverAnioActual) btnVolverAnioActual.addEventListener("click", volverAAnioActual);
    if (btnMesAnterior) btnMesAnterior.addEventListener("click", () => moverCalendario(-1));
    if (btnMesSiguiente) btnMesSiguiente.addEventListener("click", () => moverCalendario(1));
    if (btnGastosMesAnterior) btnGastosMesAnterior.addEventListener("click", () => moverMesGlobal(-1));
    if (btnGastosMesSiguiente) btnGastosMesSiguiente.addEventListener("click", () => moverMesGlobal(1));
    if (btnIngresosMesAnterior) btnIngresosMesAnterior.addEventListener("click", () => moverMesGlobal(-1));
    if (btnIngresosMesSiguiente) btnIngresosMesSiguiente.addEventListener("click", () => moverMesGlobal(1));

    if (popupDiaCerrar) popupDiaCerrar.addEventListener("click", cerrarPopupDia);
    if (popupDiaFondo) {
      popupDiaFondo.addEventListener("click", (ev) => {
        if (ev.target === popupDiaFondo) cerrarPopupDia();
      });
    }

    if (modalGuardar) modalGuardar.addEventListener("click", guardarEdicion);
    if (modalCancelar) modalCancelar.addEventListener("click", cerrarModalEdicion);
    if (modalEdicionFondo) {
      modalEdicionFondo.addEventListener("click", (ev) => {
        if (ev.target === modalEdicionFondo) cerrarModalEdicion();
      });
    }

    if (modalMesPagoSoloGuardar) modalMesPagoSoloGuardar.addEventListener("click", guardarMesPagoSolo);
    if (modalMesPagoSoloCancelar) modalMesPagoSoloCancelar.addEventListener("click", cerrarModalMesPagoSolo);
    if (modalMesPagoSoloFondo) {
      modalMesPagoSoloFondo.addEventListener("click", (ev) => {
        if (ev.target === modalMesPagoSoloFondo) cerrarModalMesPagoSolo();
      });
    }

    if (btnAgregarCategoria) btnAgregarCategoria.addEventListener("click", abrirModalCategoria);
    if (modalCategoriaGuardar) modalCategoriaGuardar.addEventListener("click", guardarCategoriaNueva);
    if (modalCategoriaCancelar) modalCategoriaCancelar.addEventListener("click", cerrarModalCategoria);
    if (modalCategoriaFondo) {
      modalCategoriaFondo.addEventListener("click", (ev) => {
        if (ev.target === modalCategoriaFondo) cerrarModalCategoria();
      });
    }

    if (btnAgregarMedioPago) btnAgregarMedioPago.addEventListener("click", abrirModalMedioPagoNuevo);
    if (modalMedioPagoNuevoGuardar) modalMedioPagoNuevoGuardar.addEventListener("click", guardarMedioPagoNuevo);
    if (modalMedioPagoNuevoCancelar) modalMedioPagoNuevoCancelar.addEventListener("click", cerrarModalMedioPagoNuevo);
    if (modalMedioPagoNuevoFondo) {
      modalMedioPagoNuevoFondo.addEventListener("click", (ev) => {
        if (ev.target === modalMedioPagoNuevoFondo) cerrarModalMedioPagoNuevo();
      });
    }

    if (btnAgregarIngreso) btnAgregarIngreso.addEventListener("click", () => abrirModalIngreso());
    if (modalIngresoGuardar) modalIngresoGuardar.addEventListener("click", guardarIngreso);
    if (modalIngresoCancelar) modalIngresoCancelar.addEventListener("click", cerrarModalIngreso);
    if (modalIngresoFondo) {
      modalIngresoFondo.addEventListener("click", (ev) => {
        if (ev.target === modalIngresoFondo) cerrarModalIngreso();
      });
    }
    if (ingresoPorcentaje) ingresoPorcentaje.addEventListener("input", actualizarAhorroDesdePorcentaje);
    if (ingresoMontoAhorro) ingresoMontoAhorro.addEventListener("input", actualizarPorcentajeDesdeAhorro);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.title = CONFIG.titulo || "Gastos";
    aplicarTemaGuardado();
    cargarModoPrivadoGuardado();
    inicializarUI();
    esperarGoogleIdentity();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
