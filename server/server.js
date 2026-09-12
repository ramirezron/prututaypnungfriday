/**
 * SmartAgri Prototype Server
 * Express + JSON-file storage + NASA POWER climate-risk integration
 * + a real scikit-learn model trained on logged harvest outcomes.
 *
 * NOTE: This is a functional PROTOTYPE built to match the SmartAgri capstone
 * sitemap (login, farmer dashboard, farm profile CRUD, crop logs, soil params,
 * notifications, admin dashboard, data management, system governance).
 * Passwords are stored in plaintext and auth is a simple session token kept
 * in memory — fine for a local demo, NOT production-ready security.
 * Replace with Firebase Auth per the thesis scope when moving past the
 * prototype stage.
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ML_DIR = path.join(__dirname, "..", "ml");
const ML_METRICS_PATH = path.join(ML_DIR, "metrics.json");

const DB_PATH = path.join(__dirname, "db.json");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- tiny JSON "database" helpers ----------
function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(5).toString("hex");
}

// in-memory session store: token -> user
const sessions = {};
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = sessions[token];
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// ---------- AUTH ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find((u) => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = { id: user.id, username: user.username, role: user.role, name: user.name };
  res.json({ token, user: sessions[token] });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  delete sessions[token];
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- GEOCODING (OpenStreetMap Nominatim — free, no key) ----------
// Open-Meteo's geocoder is gone; this resolves a typed address to lat/lon instead.
app.get("/api/geocode", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`;
    const r = await fetch(url, { headers: { "User-Agent": "SmartAgri-Capstone-Prototype/1.0" } });
    const data = await r.json();
    res.json(
      (data || []).map((d) => ({
        name: d.display_name,
        latitude: parseFloat(d.lat),
        longitude: parseFloat(d.lon),
      }))
    );
  } catch (e) {
    res.status(502).json({ error: "Geocoding lookup failed", detail: String(e) });
  }
});

// ---------- NASA POWER: CLIMATE RISK ONLY (no forecast/weather display) ----------
// NASA POWER's Daily Point API returns recent, real, ground-truthed
// meteorological data (not a forecast — phones already have AccuWeather
// for that). We pull the trailing ~14-day window (POWER has a few days
// of processing latency) and use it purely to classify climate risk.
app.get("/api/climate-risk", requireAuth, async (req, res) => {
  try {
    const { lat, lon, cropType } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

    const end = new Date();
    end.setDate(end.getDate() - 3); // POWER near-real-time data lags a few days
    const start = new Date(end);
    start.setDate(start.getDate() - 13);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

    const url =
      `https://power.larc.nasa.gov/api/temporal/daily/point` +
      `?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,WS2M&community=AG` +
      `&longitude=${lon}&latitude=${lat}&start=${fmt(start)}&end=${fmt(end)}&format=JSON`;

    const r = await fetch(url);
    const data = await r.json();
    const p = data?.properties?.parameter;
    if (!p || !p.T2M_MAX) return res.status(502).json({ error: "NASA POWER returned no data", raw: data });

    // NASA POWER uses -999 as a "no data" sentinel — filter those out.
    const clean = (obj) => Object.values(obj).filter((v) => v != null && v > -900);
    const maxTemps = clean(p.T2M_MAX);
    const minTemps = clean(p.T2M_MIN);
    const rain = clean(p.PRECTOTCORR);
    const wind = clean(p.WS2M);

    const avgTemp = (avg(maxTemps) + avg(minTemps)) / 2;
    const days = Object.keys(p.T2M_MAX).length;
    const weeklyRainMm = sum(rain) / (days / 7);
    const maxWindMs = wind.length ? Math.max(...wind) : 0;

    const risk = classifyClimateRisk({ avgTemp, weeklyRainMm, maxWindMs });

    res.json({
      location: { lat: Number(lat), lon: Number(lon) },
      window: { start: fmt(start), end: fmt(end), source: "NASA POWER (community=AG)" },
      summary: { avgTemp: round1(avgTemp), weeklyRainMm: round1(weeklyRainMm), maxWindMs: round1(maxWindMs) },
      climateRisk: risk,
      yieldForecast: estimateYield({ cropType, farmId: req.query.farmId, avgTemp, weeklyRainMm }),
    });
  } catch (e) {
    res.status(502).json({ error: "NASA POWER lookup failed", detail: String(e) });
  }
});

function avg(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function sum(arr) {
  return arr.filter((x) => x != null).reduce((a, b) => a + b, 0);
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

function classifyClimateRisk({ avgTemp, weeklyRainMm, maxWindMs }) {
  let score = 0;
  const reasons = [];
  if (weeklyRainMm > 80) { score += 2; reasons.push("Heavy recent rainfall increases flood/waterlogging risk."); }
  else if (weeklyRainMm < 10) { score += 2; reasons.push("Low recent rainfall increases drought stress risk."); }
  if (avgTemp > 34) { score += 2; reasons.push("High recent average temperature may stress crops and reduce grain fill."); }
  else if (avgTemp < 18) { score += 1; reasons.push("Cooler recent temperatures may slow crop development."); }
  if (maxWindMs > 12) { score += 2; reasons.push("Strong recent wind speeds — risk of lodging/physical crop damage."); }

  let level = "Low";
  if (score >= 5) level = "High";
  else if (score >= 2) level = "Moderate";

  return { level, score, reasons: reasons.length ? reasons : ["Recent conditions are within normal ranges."] };
}

// ---------- YIELD ESTIMATE: real ML model if trained, heuristic fallback otherwise ----------
function estimateYield({ cropType, farmId, avgTemp, weeklyRainMm }) {
  const db = readDB();
  const crop = cropType || "Rice (Palay)";
  const soil = farmId ? latestSoilProfile(db, farmId) : null;

  // Try the trained scikit-learn model first (see /ml/train.py + /ml/predict.py).
  const modelPrediction = runPythonPredict({
    cropType: crop,
    nitrogen: soil?.nitrogen ?? 0,
    phosphorus: soil?.phosphorus ?? 0,
    potassium: soil?.potassium ?? 0,
    ph: soil?.ph ?? 6.5,
    moisturePercent: soil?.moisturePercent ?? 50,
    avgTemp,
    weeklyRainMm,
  });
  if (modelPrediction && modelPrediction.estimatedTonPerHa != null) {
    return {
      cropType: crop,
      estimatedTonPerHa: round1(modelPrediction.estimatedTonPerHa),
      source: "ml_model",
      note: `Random Forest Regressor prediction, trained on ${modelPrediction.trainingSamples} logged harvest record(s).`,
    };
  }

  // Fallback: rule-based heuristic against crop baselines (used until enough
  // real harvest outcomes have been logged to train the model).
  const baseline = db.cropBaselines[crop] || db.cropBaselines["Rice (Palay)"];
  let factor = 1.0;
  const [tLow, tHigh] = baseline.idealTempC;
  if (avgTemp < tLow) factor -= 0.15 * (tLow - avgTemp) / 5;
  else if (avgTemp > tHigh) factor -= 0.15 * (avgTemp - tHigh) / 5;
  const [rLow, rHigh] = baseline.idealRainMmWeek;
  if (weeklyRainMm < rLow) factor -= 0.2 * (rLow - weeklyRainMm) / rLow;
  else if (weeklyRainMm > rHigh) factor -= 0.2 * (weeklyRainMm - rHigh) / rHigh;
  factor = Math.max(0.3, Math.min(1.15, factor));

  return {
    cropType: crop,
    estimatedTonPerHa: round1(baseline.baseYieldTonPerHa * factor),
    source: "heuristic",
    note: "Heuristic baseline estimate — the ML model hasn't been trained yet. Log actual harvest results (Crop Growth Logs → Harvest) and have an admin train the model in Data Management.",
  };
}

function latestSoilProfile(db, farmId) {
  const profiles = db.soilProfiles.filter((s) => s.farmId === farmId);
  return profiles.length ? profiles[profiles.length - 1] : null;
}

// Calls ml/predict.py with a JSON feature payload. Returns null (triggering
// the heuristic fallback above) if Python/scikit-learn isn't installed yet
// or the model hasn't been trained. Tries `python3` then `python` for
// cross-platform compatibility (Windows usually only has `python`).
function runPythonPredict(features) {
  const scriptPath = path.join(ML_DIR, "predict.py");
  if (!fs.existsSync(scriptPath)) return null;
  for (const cmd of ["python3", "python"]) {
    const result = spawnSync(cmd, [scriptPath, JSON.stringify(features)], { encoding: "utf-8", timeout: 5000 });
    if (result.error) continue; // command not found — try the next one
    try {
      const parsed = JSON.parse((result.stdout || "").trim());
      if (parsed.error) return null; // model_not_trained, etc. — fall back silently
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------- FARM PROFILES ----------
app.get("/api/farms", requireAuth, (req, res) => {
  const db = readDB();
  const farms = req.user.role === "admin" ? db.farms : db.farms.filter((f) => f.userId === req.user.id);
  res.json(farms);
});

app.post("/api/farms", requireAuth, (req, res) => {
  const db = readDB();
  const farm = {
    id: newId("f"),
    userId: req.user.id,
    name: req.body.name,
    cropType: req.body.cropType,
    areaHectares: req.body.areaHectares,
    address: req.body.address,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    plantingDate: req.body.plantingDate,
    createdAt: new Date().toISOString(),
  };
  db.farms.push(farm);
  db.notifications.push({
    id: newId("n"),
    userId: req.user.id,
    title: "Farm profile added",
    message: `"${farm.name}" was added to your account.`,
    read: false,
    createdAt: new Date().toISOString(),
  });
  writeDB(db);
  res.status(201).json(farm);
});

app.put("/api/farms/:id", requireAuth, (req, res) => {
  const db = readDB();
  const farm = db.farms.find((f) => f.id === req.params.id);
  if (!farm) return res.status(404).json({ error: "Farm not found" });
  if (farm.userId !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  Object.assign(farm, req.body);
  writeDB(db);
  res.json(farm);
});

app.delete("/api/farms/:id", requireAuth, (req, res) => {
  const db = readDB();
  const farm = db.farms.find((f) => f.id === req.params.id);
  if (!farm) return res.status(404).json({ error: "Farm not found" });
  if (farm.userId !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  db.farms = db.farms.filter((f) => f.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ---------- SOIL PARAMETERS ----------
app.get("/api/farms/:id/soil", requireAuth, (req, res) => {
  const db = readDB();
  const profiles = db.soilProfiles.filter((s) => s.farmId === req.params.id);
  res.json(profiles);
});

app.post("/api/farms/:id/soil", requireAuth, (req, res) => {
  const db = readDB();
  const profile = {
    id: newId("s"),
    farmId: req.params.id,
    mode: req.body.mode || "manual", // "baseline" or "manual"
    nitrogen: req.body.nitrogen,
    phosphorus: req.body.phosphorus,
    potassium: req.body.potassium,
    ph: req.body.ph,
    moisturePercent: req.body.moisturePercent,
    source: req.body.source || "Manual farmer input",
    updatedAt: new Date().toISOString(),
  };
  db.soilProfiles.push(profile);
  writeDB(db);
  res.status(201).json(profile);
});

// ---------- CROP GROWTH LOGS ----------
app.get("/api/farms/:id/logs", requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.cropLogs.filter((l) => l.farmId === req.params.id).sort((a, b) => b.date.localeCompare(a.date)));
});

app.post("/api/farms/:id/logs", requireAuth, (req, res) => {
  const db = readDB();
  const log = {
    id: newId("l"),
    farmId: req.params.id,
    date: req.body.date,
    growthStage: req.body.growthStage,
    notes: req.body.notes,
    createdAt: new Date().toISOString(),
  };
  db.cropLogs.push(log);
  writeDB(db);
  res.status(201).json(log);
});

// ---------- HARVEST OUTCOMES (this is what feeds the ML model) ----------
// Every time a farmer logs an actual harvested yield, we snapshot the soil
// profile + recent climate conditions alongside it. ml/train.py reads this
// array from db.json to train a real scikit-learn RandomForestRegressor.
app.get("/api/farms/:id/harvest", requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.harvestRecords.filter((h) => h.farmId === req.params.id).sort((a, b) => b.date.localeCompare(a.date)));
});

app.post("/api/farms/:id/harvest", requireAuth, async (req, res) => {
  const db = readDB();
  const farm = db.farms.find((f) => f.id === req.params.id);
  if (!farm) return res.status(404).json({ error: "Farm not found" });
  if (farm.userId !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const soil = latestSoilProfile(db, farm.id);

  let avgTemp = null, weeklyRainMm = null;
  try {
    const end = new Date(); end.setDate(end.getDate() - 3);
    const start = new Date(end); start.setDate(start.getDate() - 13);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR&community=AG&longitude=${farm.longitude}&latitude=${farm.latitude}&start=${fmt(start)}&end=${fmt(end)}&format=JSON`;
    const r = await fetch(url);
    const data = await r.json();
    const p = data?.properties?.parameter;
    if (p?.T2M_MAX) {
      const clean = (obj) => Object.values(obj).filter((v) => v != null && v > -900);
      avgTemp = round1((avg(clean(p.T2M_MAX)) + avg(clean(p.T2M_MIN))) / 2);
      const days = Object.keys(p.T2M_MAX).length;
      weeklyRainMm = round1(sum(clean(p.PRECTOTCORR)) / (days / 7));
    }
  } catch {
    // climate snapshot is best-effort; the record is still saved without it
  }

  const record = {
    id: newId("h"),
    farmId: farm.id,
    cropType: farm.cropType,
    areaHectares: farm.areaHectares,
    date: req.body.date || new Date().toISOString().slice(0, 10),
    actualYieldTonPerHa: parseFloat(req.body.actualYieldTonPerHa),
    notes: req.body.notes || "",
    nitrogen: soil?.nitrogen ?? null,
    phosphorus: soil?.phosphorus ?? null,
    potassium: soil?.potassium ?? null,
    ph: soil?.ph ?? null,
    moisturePercent: soil?.moisturePercent ?? null,
    avgTemp,
    weeklyRainMm,
    createdAt: new Date().toISOString(),
  };
  db.harvestRecords.push(record);
  writeDB(db);
  res.status(201).json(record);
});

// ---------- NOTIFICATIONS ----------
app.get("/api/notifications", requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.notifications.filter((n) => n.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  const db = readDB();
  const note = db.notifications.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  note.read = true;
  writeDB(db);
  res.json(note);
});

// ---------- ADMIN: DASHBOARD / MAP ----------
app.get("/api/admin/farms", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.farms);
});

// ---------- ADMIN: DATA MANAGEMENT ----------
// Real metrics from the last training run (written by ml/train.py), not mock numbers.
app.get("/api/admin/ml-metrics", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  if (fs.existsSync(ML_METRICS_PATH)) {
    const metrics = JSON.parse(fs.readFileSync(ML_METRICS_PATH, "utf-8"));
    return res.json({ trained: true, ...metrics, harvestRecordsAvailable: db.harvestRecords.length });
  }
  res.json({
    trained: false,
    harvestRecordsAvailable: db.harvestRecords.length,
    minRequired: 5,
    message: "Model not trained yet. Log harvest outcomes (farmer side) until there are at least 5 records, then click \"Train Model\" below.",
  });
});

// Kicks off ml/train.py, which reads db.json's harvestRecords, trains a
// RandomForestRegressor with scikit-learn, and writes ml/metrics.json +
// ml/model.joblib. Requires Python 3 + `pip install -r ml/requirements.txt`.
app.post("/api/admin/train-model", requireAuth, requireAdmin, (req, res) => {
  const scriptPath = path.join(ML_DIR, "train.py");
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ error: "ml/train.py not found" });

  for (const cmd of ["python3", "python"]) {
    const result = spawnSync(cmd, [scriptPath], { encoding: "utf-8", timeout: 30000 });
    if (result.error) continue; // this command isn't installed — try the next
    try {
      const parsed = JSON.parse((result.stdout || "").trim().split("\n").pop());
      if (parsed.error) return res.status(400).json(parsed);
      return res.json(parsed);
    } catch {
      return res.status(500).json({ error: "Training script did not return valid JSON", stdout: result.stdout, stderr: result.stderr });
    }
  }
  res.status(500).json({ error: "Python not found. Install Python 3 and run: pip install -r ml/requirements.txt" });
});

app.get("/api/admin/harvest-records", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.harvestRecords);
});

app.get("/api/admin/export", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  const rows = [["id", "userId", "name", "cropType", "areaHectares", "address", "latitude", "longitude", "plantingDate"]];
  db.farms.forEach((f) => rows.push([f.id, f.userId, f.name, f.cropType, f.areaHectares, f.address, f.latitude, f.longitude, f.plantingDate]));
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=smartagri_farms_export.csv");
  res.send(csv);
});

// ---------- ADMIN: SYSTEM GOVERNANCE ----------
app.get("/api/announcements", requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.announcements.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/announcements", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  const ann = { id: newId("a"), title: req.body.title, message: req.body.message, createdAt: new Date().toISOString() };
  db.announcements.push(ann);
  // fan out as notifications to all farmer users
  db.users.filter((u) => u.role === "farmer").forEach((u) => {
    db.notifications.push({
      id: newId("n"),
      userId: u.id,
      title: `Announcement: ${ann.title}`,
      message: ann.message,
      read: false,
      createdAt: new Date().toISOString(),
    });
  });
  writeDB(db);
  res.status(201).json(ann);
});

app.delete("/api/announcements/:id", requireAuth, requireAdmin, (req, res) => {
  const db = readDB();
  db.announcements = db.announcements.filter((a) => a.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartAgri prototype server running at http://localhost:${PORT}`);
});
