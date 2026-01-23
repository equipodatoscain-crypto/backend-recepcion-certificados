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
    options: {
      encrypt: false,
      trustServerCertificate: true
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    },
    requestTimeout: 120000
  };
}

let poolPromise = null;
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(getSqlConfig());
  return poolPromise;
}

// Helpers
function normStr(v) {
  return (v ?? "").toString().trim().toUpperCase();
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

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

/* =====================================================
   ✅ VEHICULOS (SOLO EXISTENCIA)
===================================================== */
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

/* =====================================================
   CONDUCTORES
===================================================== */
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

/* =====================================================
   AAR
===================================================== */
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

/* =====================================================
   RECEPCION CERTIFICADOS (✅ AHORA GUARDA CONDUCTORES/AAR Y ESTADOS)
===================================================== */
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

        // === Campos base ===
        r.input("fecha_creacion", sql.Date, new Date());
        r.input("anio", sql.Int, row.año);
        r.input("mes", sql.NVarChar(50), row.mes);
        r.input("numero_de_contrato_oc", sql.NVarChar(50), row.numero_de_contrato_oc);
        r.input("numero_ruta", sql.NVarChar(50), row.numero_ruta);
        r.input("fecha_servicio", sql.Date, row.fecha_servicio ? new Date(row.fecha_servicio) : null);
        r.input("placa_recorrido_1", sql.NVarChar(20), row.placa_recorrido_1);
        r.input("placa_recorrido_2", sql.NVarChar(20), row.placa_recorrido_2);
        r.input("observacion", sql.NVarChar(255), row.observacion);
        r.input("observacion_general", sql.NVarChar(255), row.observacion_general);
        r.input("responsable", sql.NVarChar(100), row.responsable);
        r.input("estado", sql.NVarChar(50), row.estado);
        r.input("id_grupo", sql.Int, row.id_grupo ?? id_grupo);
        r.input("maximo_transportado", sql.Int, row.maximo_transportado);
        r.input("ocupacion_0_r1", sql.NVarChar(5), row.ocupacion_0_r1);
        r.input("ocupacion_0_r2", sql.NVarChar(5), row.ocupacion_0_r2);

        // === ✅ NUEVO: conductores / aar (INT) ===
        r.input("conductor1", sql.Int, row.conductor1 ?? null);
        r.input("conductor2", sql.Int, row.conductor2 ?? null);
        r.input("conductor3", sql.Int, row.conductor3 ?? null);
        r.input("conductor4", sql.Int, row.conductor4 ?? null);
        r.input("conductor5", sql.Int, row.conductor5 ?? null);

        r.input("aar1", sql.Int, row.aar1 ?? null);
        r.input("aar2", sql.Int, row.aar2 ?? null);
        r.input("aar3", sql.Int, row.aar3 ?? null);
        r.input("aar4", sql.Int, row.aar4 ?? null);
        r.input("aar5", sql.Int, row.aar5 ?? null);

        // === ✅ NUEVO: estados (NVARCHAR) ===
        r.input("estadoconductor1", sql.NVarChar(50), row.estadoconductor1 ?? null);
        r.input("estadoconductor2", sql.NVarChar(50), row.estadoconductor2 ?? null);
        r.input("estadoconductor3", sql.NVarChar(50), row.estadoconductor3 ?? null);
        r.input("estadoconductor4", sql.NVarChar(50), row.estadoconductor4 ?? null);
        r.input("estadoconductor5", sql.NVarChar(50), row.estadoconductor5 ?? null);

        r.input("estadoaar1", sql.NVarChar(50), row.estadoaar1 ?? null);
        r.input("estadoaar2", sql.NVarChar(50), row.estadoaar2 ?? null);
        r.input("estadoaar3", sql.NVarChar(50), row.estadoaar3 ?? null);
        r.input("estadoaar4", sql.NVarChar(50), row.estadoaar4 ?? null);
        r.input("estadoaar5", sql.NVarChar(50), row.estadoaar5 ?? null);

        // === ✅ INSERT con nuevas columnas ===
        await r.query(`
          INSERT INTO dbo.recepcion_certificados (
            fecha_creacion, año, mes, numero_de_contrato_oc, numero_ruta,
            fecha_servicio, placa_recorrido_1, placa_recorrido_2,
            observacion, observacion_general, responsable, estado,
            id_grupo, maximo_transportado, ocupacion_0_r1, ocupacion_0_r2,

            conductor1, conductor2, conductor3, conductor4, conductor5,
            aar1, aar2, aar3, aar4, aar5,
            estadoconductor1, estadoconductor2, estadoconductor3, estadoconductor4, estadoconductor5,
            estadoaar1, estadoaar2, estadoaar3, estadoaar4, estadoaar5
          ) VALUES (
            @fecha_creacion, @anio, @mes, @numero_de_contrato_oc, @numero_ruta,
            @fecha_servicio, @placa_recorrido_1, @placa_recorrido_2,
            @observacion, @observacion_general, @responsable, @estado,
            @id_grupo, @maximo_transportado, @ocupacion_0_r1, @ocupacion_0_r2,

            @conductor1, @conductor2, @conductor3, @conductor4, @conductor5,
            @aar1, @aar2, @aar3, @aar4, @aar5,
            @estadoconductor1, @estadoconductor2, @estadoconductor3, @estadoconductor4, @estadoconductor5,
            @estadoaar1, @estadoaar2, @estadoaar3, @estadoaar4, @estadoaar5
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

/* =====================================================
   ✅ SABANA_RUTAS (NUEVO)
   Rutas usadas por tu HTML:
   - GET  /sabana/list
   - POST /sabana/replace
   - GET  /sabana/by-period?anio=&mes=
   - GET  /certificados/aprobados?anio=&mes=
===================================================== */

// LISTAR: año/mes + conteo
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

// TRAER SABANA por periodo (para reporte)
app.get("/sabana/by-period", async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = normStr(req.query.mes);

    if (!anio || !mes) {
      return res.status(400).json({ ok: false, error: "Faltan anio/mes" });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input("anio", sql.Int, anio)
      .input("mes", sql.VarChar(50), mes)
      .query(`
        SELECT
          año,
          mes,
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

// REEMPLAZAR SABANA: DELETE + INSERT por lotes en transacción
app.post("/sabana/replace", async (req, res) => {
  const anio = parseInt(req.body?.anio, 10);
  const mes = normStr(req.body?.mes);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!anio || !mes) return res.status(400).json({ ok: false, error: "Faltan anio/mes" });
  if (!rows.length) return res.status(400).json({ ok: false, error: "No hay filas para insertar" });

  // Normalizamos filas
  const clean = rows
    .map(r => ({
      seg: normStr(r.SegmentoOperacion),
      prov: normStr(r.Proveedor),
      ruta: normStr(r.CodigoRuta),
      est: normStr(r.Estado),
    }))
    .filter(r => r.seg || r.prov || r.ruta || r.est);

  if (!clean.length) return res.status(400).json({ ok: false, error: "No hay filas válidas" });

  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      // 1) DELETE del periodo
      await new sql.Request(tx)
        .input("anio", sql.Int, anio)
        .input("mes", sql.VarChar(50), mes)
        .query(`DELETE FROM dbo.sabana_rutas WHERE año=@anio AND mes=@mes`);

      // 2) INSERT por lotes parametrizados
      const BATCH = 500;
      let inserted = 0;

      for (let i = 0; i < clean.length; i += BATCH) {
        const chunk = clean.slice(i, i + BATCH);

        const reqIns = new sql.Request(tx);
        reqIns.input("anio", sql.Int, anio);
        reqIns.input("mes", sql.VarChar(50), mes);

        const valuesSql = chunk.map((r, idx) => {
          reqIns.input(`seg${idx}`, sql.VarChar(50), r.seg);
          reqIns.input(`prov${idx}`, sql.VarChar(50), r.prov);
          reqIns.input(`ruta${idx}`, sql.VarChar(50), r.ruta);
          reqIns.input(`est${idx}`, sql.VarChar(50), r.est);
          return `(@anio, @mes, @seg${idx}, @prov${idx}, @ruta${idx}, @est${idx})`;
        }).join(",");

        const q = `
          INSERT INTO dbo.sabana_rutas (año, mes, [Segmento Operación], Proveedor, [Código Ruta], Estado)
          VALUES ${valuesSql};
        `;

        await reqIns.query(q);
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

// CERTIFICADOS APROBADOS por periodo (para reporte)
app.get("/certificados/aprobados", async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = normStr(req.query.mes);

    if (!anio || !mes) {
      return res.status(400).json({ ok: false, error: "Faltan anio/mes" });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input("anio", sql.Int, anio)
      .input("mes", sql.VarChar(50), mes)
      .input("estado", sql.NVarChar(50), "APROBADO")
      .query(`
        SELECT
          fecha_creacion,
          año,
          mes,
          numero_de_contrato_oc,
          numero_ruta,
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

/* ===================================================== */

app.use((req, res) => {
  res.status(404).json({ ok: false });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
