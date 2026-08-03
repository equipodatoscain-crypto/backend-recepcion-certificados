const express = require("express");
const sql = require("mssql");

const app = express();

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function getSqlConfig() {
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT || "1433", 10),
    database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 120000
  };
}

let poolPromise = null;
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(getSqlConfig());
  return poolPromise;
}

function normStr(v) {
  return (v ?? "").toString().trim().toUpperCase();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/test-db", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query("SELECT 1 AS ok");
    res.json({ ok: true, result: r.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/next-id-grupo", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT ISNULL(MAX(id_grupo),0)+1 AS next_id_grupo
      FROM dbo.recepcion_certificados
    `);
    res.json({ ok: true, id_grupo: r.recordset[0].next_id_grupo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   VEHICULOS
========================= */
app.get("/vehiculo-existe/:placa", async (req, res) => {
  const placa = (req.params.placa || "").toUpperCase().trim();
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("placa", sql.NVarChar(20), placa)
      .query(`SELECT 1 FROM dbo.vehiculos WHERE placa = @placa`);
    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   OPERACION ESPERADA
========================= */
app.get("/placa-operacion", async (req, res) => {
  const { fecha, ruta, recorrido } = req.query;
  if (!fecha || !ruta || !recorrido) {
    return res.status(400).json({ ok: false, error: "Missing params" });
  }
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("fecha", sql.Date, fecha)
      .input("ruta", sql.NVarChar(510), ruta)
      .input("recorrido", sql.NVarChar(510), recorrido)
      .query(`SELECT TOP 1 Placa FROM dbo.operacion WHERE CAST(fecha AS DATE) = @fecha AND Ruta = @ruta AND Recorrido = @recorrido`);
    
    if (r.recordset.length > 0) {
      res.json({ ok: true, placa: r.recordset[0].Placa });
    } else {
      res.json({ ok: true, placa: null });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   CONDUCTORES / AAR
========================= */
app.get("/existe-conductor/:cedula", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.VarChar(50), req.params.cedula)
      .query(`SELECT 1 FROM dbo.conductores WHERE cedulaconductor = @cedula`);
    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/existe-aar/:cedula", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("cedula", sql.VarChar(50), req.params.cedula)
      .query(`SELECT 1 FROM dbo.aar WHERE cedulaaar = @cedula`);
    res.json({ ok: true, exists: r.recordset.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   RECEPCION CERTIFICADOS
   ✅ FIX FECHA COLOMBIA
   ✅ NUEVO: UT
========================= */
app.post("/recepcion-certificados", async (req, res) => {
  try {
    const { id_grupo, registros } = req.body;
    if (!Array.isArray(registros) || registros.length === 0) {
      return res.status(400).json({ ok: false, error: "No hay registros" });
    }

    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      for (const row of registros) {
        const r = new sql.Request(tx);

        // ✅ Fecha Colombia (UTC-5) SOLO FECHA
        const now = new Date();
        const colombia = new Date(now.getTime() - (5 * 60 * 60 * 1000));
        r.input("fecha_creacion", sql.Date, colombia);

        r.input("anio", sql.Int, row.año);
        r.input("mes", sql.NVarChar(50), row.mes);

        // ✅ NUEVO: UT (robusto)
        const utVal = normStr(
          row.ut ??
          row.UT ??
          row["ut"] ??
          row["UT"] ??
          row["u_t"] ??
          row["U_T"] ??
          row["Union Temporal"] ??
          row["UNION TEMPORAL"]
        );
        r.input("ut", sql.NVarChar(150), utVal || null);

        r.input("numero_de_contrato_oc", sql.NVarChar(50), row.numero_de_contrato_oc);
        r.input("numero_ruta", sql.NVarChar(50), row.numero_ruta);

        // ✅ AJUSTE ROBUSTO: segmento (acepta varias llaves y normaliza)
        const segmentoVal = normStr(
          row.segmento ??
          row.Segmento ??
          row["SEGMENTO"] ??
          row["segmento"] ??
          row["Segmento"] ??
          row["Segmento Operación"] ??
          row["SEGMENTO OPERACIÓN"] ??
          row["segmento_operacion"] ??
          row["segmentoOperacion"]
        );

        r.input("segmento", sql.NVarChar(50), segmentoVal || null);

        r.input("fecha_servicio", sql.Date, row.fecha_servicio ? new Date(row.fecha_servicio) : null);
        r.input("placa_recorrido_1", sql.NVarChar(20), row.placa_recorrido_1);
        r.input("placa_recorrido_2", sql.NVarChar(20), row.placa_recorrido_2);
        r.input("observacion", sql.NVarChar(sql.MAX), row.observacion);
        r.input("observacion_general", sql.NVarChar(sql.MAX), row.observacion_general);
        r.input("responsable", sql.NVarChar(100), row.responsable);
        r.input("estado", sql.NVarChar(50), row.estado);
        r.input("id_grupo", sql.Int, row.id_grupo ?? id_grupo);
        r.input("maximo_transportado", sql.Int, row.maximo_transportado);
        r.input("ocupacion_0_r1", sql.NVarChar(5), row.ocupacion_0_r1);
        r.input("ocupacion_0_r2", sql.NVarChar(5), row.ocupacion_0_r2);

        r.input("conductor1", sql.Int, row.conductor1 ?? null);
        r.input("conductor2", sql.Int, row.conductor2 ?? null);
        r.input("conductor3", sql.Int, row.conductor3 ?? null);
        r.input("conductor4", sql.Int, row.conductor4 ?? null);
        r.input("conductor5", sql.Int, row.conductor5 ?? null);
        r.input("conductor6", sql.Int, row.conductor6 ?? null);
        r.input("conductor7", sql.Int, row.conductor7 ?? null);
        r.input("conductor8", sql.Int, row.conductor8 ?? null);
        r.input("conductor9", sql.Int, row.conductor9 ?? null);
        r.input("conductor10", sql.Int, row.conductor10 ?? null);
        r.input("conductor11", sql.Int, row.conductor11 ?? null);
        r.input("conductor12", sql.Int, row.conductor12 ?? null);
        r.input("conductor13", sql.Int, row.conductor13 ?? null);
        r.input("conductor14", sql.Int, row.conductor14 ?? null);
        r.input("conductor15", sql.Int, row.conductor15 ?? null);

        r.input("aar1", sql.Int, row.aar1 ?? null);
        r.input("aar2", sql.Int, row.aar2 ?? null);
        r.input("aar3", sql.Int, row.aar3 ?? null);
        r.input("aar4", sql.Int, row.aar4 ?? null);
        r.input("aar5", sql.Int, row.aar5 ?? null);
        r.input("aar6", sql.Int, row.aar6 ?? null);
        r.input("aar7", sql.Int, row.aar7 ?? null);
        r.input("aar8", sql.Int, row.aar8 ?? null);
        r.input("aar9", sql.Int, row.aar9 ?? null);
        r.input("aar10", sql.Int, row.aar10 ?? null);
        r.input("aar11", sql.Int, row.aar11 ?? null);
        r.input("aar12", sql.Int, row.aar12 ?? null);
        r.input("aar13", sql.Int, row.aar13 ?? null);
        r.input("aar14", sql.Int, row.aar14 ?? null);
        r.input("aar15", sql.Int, row.aar15 ?? null);

        r.input("estadoconductor1", sql.NVarChar(50), row.estadoconductor1 ?? null);
        r.input("estadoconductor2", sql.NVarChar(50), row.estadoconductor2 ?? null);
        r.input("estadoconductor3", sql.NVarChar(50), row.estadoconductor3 ?? null);
        r.input("estadoconductor4", sql.NVarChar(50), row.estadoconductor4 ?? null);
        r.input("estadoconductor5", sql.NVarChar(50), row.estadoconductor5 ?? null);
        r.input("estadoconductor6", sql.NVarChar(50), row.estadoconductor6 ?? null);
        r.input("estadoconductor7", sql.NVarChar(50), row.estadoconductor7 ?? null);
        r.input("estadoconductor8", sql.NVarChar(50), row.estadoconductor8 ?? null);
        r.input("estadoconductor9", sql.NVarChar(50), row.estadoconductor9 ?? null);
        r.input("estadoconductor10", sql.NVarChar(50), row.estadoconductor10 ?? null);
        r.input("estadoconductor11", sql.NVarChar(50), row.estadoconductor11 ?? null);
        r.input("estadoconductor12", sql.NVarChar(50), row.estadoconductor12 ?? null);
        r.input("estadoconductor13", sql.NVarChar(50), row.estadoconductor13 ?? null);
        r.input("estadoconductor14", sql.NVarChar(50), row.estadoconductor14 ?? null);
        r.input("estadoconductor15", sql.NVarChar(50), row.estadoconductor15 ?? null);

        r.input("estadoaar1", sql.NVarChar(50), row.estadoaar1 ?? null);
        r.input("estadoaar2", sql.NVarChar(50), row.estadoaar2 ?? null);
        r.input("estadoaar3", sql.NVarChar(50), row.estadoaar3 ?? null);
        r.input("estadoaar4", sql.NVarChar(50), row.estadoaar4 ?? null);
        r.input("estadoaar5", sql.NVarChar(50), row.estadoaar5 ?? null);
        r.input("estadoaar6", sql.NVarChar(50), row.estadoaar6 ?? null);
        r.input("estadoaar7", sql.NVarChar(50), row.estadoaar7 ?? null);
        r.input("estadoaar8", sql.NVarChar(50), row.estadoaar8 ?? null);
        r.input("estadoaar9", sql.NVarChar(50), row.estadoaar9 ?? null);
        r.input("estadoaar10", sql.NVarChar(50), row.estadoaar10 ?? null);
        r.input("estadoaar11", sql.NVarChar(50), row.estadoaar11 ?? null);
        r.input("estadoaar12", sql.NVarChar(50), row.estadoaar12 ?? null);
        r.input("estadoaar13", sql.NVarChar(50), row.estadoaar13 ?? null);
        r.input("estadoaar14", sql.NVarChar(50), row.estadoaar14 ?? null);
        r.input("estadoaar15", sql.NVarChar(50), row.estadoaar15 ?? null);

        await r.query(`
          INSERT INTO dbo.recepcion_certificados (
            fecha_creacion, año, mes, ut, numero_de_contrato_oc, numero_ruta, segmento,
            fecha_servicio, placa_recorrido_1, placa_recorrido_2,
            observacion, observacion_general, responsable, estado,
            id_grupo, maximo_transportado, ocupacion_0_r1, ocupacion_0_r2,

            conductor1, conductor2, conductor3, conductor4, conductor5, conductor6, conductor7, conductor8, conductor9, conductor10, conductor11, conductor12, conductor13, conductor14, conductor15,
            aar1, aar2, aar3, aar4, aar5, aar6, aar7, aar8, aar9, aar10, aar11, aar12, aar13, aar14, aar15,
            estadoconductor1, estadoconductor2, estadoconductor3, estadoconductor4, estadoconductor5, estadoconductor6, estadoconductor7, estadoconductor8, estadoconductor9, estadoconductor10, estadoconductor11, estadoconductor12, estadoconductor13, estadoconductor14, estadoconductor15,
            estadoaar1, estadoaar2, estadoaar3, estadoaar4, estadoaar5, estadoaar6, estadoaar7, estadoaar8, estadoaar9, estadoaar10, estadoaar11, estadoaar12, estadoaar13, estadoaar14, estadoaar15
          ) VALUES (
            @fecha_creacion, @anio, @mes, @ut, @numero_de_contrato_oc, @numero_ruta, @segmento,
            @fecha_servicio, @placa_recorrido_1, @placa_recorrido_2,
            @observacion, @observacion_general, @responsable, @estado,
            @id_grupo, @maximo_transportado, @ocupacion_0_r1, @ocupacion_0_r2,

            @conductor1, @conductor2, @conductor3, @conductor4, @conductor5, @conductor6, @conductor7, @conductor8, @conductor9, @conductor10, @conductor11, @conductor12, @conductor13, @conductor14, @conductor15,
            @aar1, @aar2, @aar3, @aar4, @aar5, @aar6, @aar7, @aar8, @aar9, @aar10, @aar11, @aar12, @aar13, @aar14, @aar15,
            @estadoconductor1, @estadoconductor2, @estadoconductor3, @estadoconductor4, @estadoconductor5, @estadoconductor6, @estadoconductor7, @estadoconductor8, @estadoconductor9, @estadoconductor10, @estadoconductor11, @estadoconductor12, @estadoconductor13, @estadoconductor14, @estadoconductor15,
            @estadoaar1, @estadoaar2, @estadoaar3, @estadoaar4, @estadoaar5, @estadoaar6, @estadoaar7, @estadoaar8, @estadoaar9, @estadoaar10, @estadoaar11, @estadoaar12, @estadoaar13, @estadoaar14, @estadoaar15
          )
        `);
      }

      await tx.commit();
      res.json({ ok: true });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   SABANA
========================= */
app.get("/sabana/list", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT año, mes, COUNT(*) AS registros
      FROM dbo.sabana_rutas
      GROUP BY año, mes
      ORDER BY año DESC, mes ASC
    `);
    res.json({ ok: true, data: r.recordset || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/sabana/by-period", async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = normStr(req.query.mes);

    if (!anio || !mes) return res.status(400).json({ ok: false, error: "Faltan anio/mes" });

    const pool = await getPool();
    const r = await pool.request()
      .input("anio", sql.Int, anio)
      .input("mes", sql.VarChar(50), mes)
      .query(`
        SELECT
          año,
          mes,
          [Número Contrato] AS [Número Contrato],
          [Segmento Operación] AS [Segmento Operación],
          Proveedor,
          [Código Ruta] AS [Código Ruta],
          Estado
        FROM dbo.sabana_rutas
        WHERE año = @anio AND mes = @mes
      `);

    res.json({ ok: true, data: r.recordset || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/sabana/replace", async (req, res) => {
  const anio = parseInt(req.body?.anio, 10);
  const mes = normStr(req.body?.mes);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!anio || !mes) return res.status(400).json({ ok: false, error: "Faltan anio/mes" });
  if (!rows.length) return res.status(400).json({ ok: false, error: "No hay filas para insertar" });

  const clean = rows
    .map(r => ({
      contrato: normStr(r.NumeroContrato ?? r["Número Contrato"] ?? r["Numero Contrato"]),
      seg: normStr(r.SegmentoOperacion),
      prov: normStr(r.Proveedor),
      ruta: normStr(r.CodigoRuta),
      est: normStr(r.Estado),
    }))
    .filter(r => r.contrato || r.seg || r.prov || r.ruta || r.est);

  if (!clean.length) return res.status(400).json({ ok: false, error: "No hay filas válidas" });

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await new sql.Request(tx)
        .input("anio", sql.Int, anio)
        .input("mes", sql.VarChar(50), mes)
        .query(`DELETE FROM dbo.sabana_rutas WHERE año=@anio AND mes=@mes`);

      const BATCH = 500;
      let inserted = 0;

      for (let i = 0; i < clean.length; i += BATCH) {
        const chunk = clean.slice(i, i + BATCH);

        const reqIns = new sql.Request(tx);
        reqIns.input("anio", sql.Int, anio);
        reqIns.input("mes", sql.VarChar(50), mes);

        const valuesSql = chunk.map((r, idx) => {
          reqIns.input(`cont${idx}`, sql.VarChar(50), r.contrato || null);
          reqIns.input(`seg${idx}`, sql.VarChar(50), r.seg);
          reqIns.input(`prov${idx}`, sql.VarChar(50), r.prov);
          reqIns.input(`ruta${idx}`, sql.VarChar(50), r.ruta);
          reqIns.input(`est${idx}`, sql.VarChar(50), r.est);
          return `(@anio, @mes, @cont${idx}, @seg${idx}, @prov${idx}, @ruta${idx}, @est${idx})`;
        }).join(",");

        await reqIns.query(`
          INSERT INTO dbo.sabana_rutas
            (año, mes, [Número Contrato], [Segmento Operación], Proveedor, [Código Ruta], Estado)
          VALUES ${valuesSql};
        `);

        inserted += chunk.length;
      }

      await tx.commit();
      res.json({ ok: true, inserted, anio, mes });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ✅ FIX FECHA: devolvemos YYYY-MM-DD
   ✅ NUEVO: incluir ut
*/
app.get("/certificados/aprobados", async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = normStr(req.query.mes);
    if (!anio || !mes) return res.status(400).json({ ok: false, error: "Faltan anio/mes" });

    const pool = await getPool();
    const r = await pool.request()
      .input("anio", sql.Int, anio)
      .input("mes", sql.VarChar(50), mes)
      .input("estado", sql.NVarChar(50), "APROBADO")
      .query(`
        SELECT
          CONVERT(varchar(10), fecha_creacion, 23) AS fecha_creacion,
          año,
          mes,
          ut,
          numero_de_contrato_oc,
          numero_ruta,
          segmento,
          responsable,
          estado,
          observacion_general
        FROM dbo.recepcion_certificados
        WHERE año = @anio AND mes = @mes AND estado = @estado
      `);

    res.json({ ok: true, data: r.recordset || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ ok: false }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));

