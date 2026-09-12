let map;

(async function init() {
  const user = await requireLogin("admin");
  if (!user) return;
  document.getElementById("userName").textContent = user.name;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await API.post("/api/logout").catch(() => {});
    API.clearToken();
    window.location.href = "/index.html";
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });

  await loadDashboard();
  wireForms();
})();

function showPage(name) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  if (name === "dataManagement") loadMlMetrics();
  if (name === "governance") loadAnnouncements();
  if (name === "dashboard" && map) setTimeout(() => map.invalidateSize(), 50);
}

async function loadDashboard() {
  const farms = await API.get("/api/admin/farms");
  document.getElementById("statFarms").textContent = farms.length;
  document.getElementById("statHectares").textContent = farms.reduce((a, f) => a + (Number(f.areaHectares) || 0), 0).toFixed(1);
  document.getElementById("statCrops").textContent = new Set(farms.map((f) => f.cropType)).size;

  initMap(farms);

  const tbody = document.querySelector("#farmsTable tbody");
  tbody.innerHTML = "<tr><td colspan='6' class='small'>Loading climate data…</td></tr>";
  const rows = await Promise.all(farms.map(async (f) => {
    try {
      const w = await API.get(`/api/climate-risk?lat=${f.latitude}&lon=${f.longitude}&cropType=${encodeURIComponent(f.cropType)}&farmId=${f.id}`);
      return `<tr><td>${f.name}</td><td>${f.cropType}</td><td>${f.areaHectares}</td><td>${f.address}</td>
        <td><span class="badge ${w.climateRisk.level.toLowerCase()}">${w.climateRisk.level}</span></td>
        <td>${w.yieldForecast.estimatedTonPerHa} t/ha</td></tr>`;
    } catch {
      return `<tr><td>${f.name}</td><td>${f.cropType}</td><td>${f.areaHectares}</td><td>${f.address}</td><td>—</td><td>—</td></tr>`;
    }
  }));
  tbody.innerHTML = rows.join("") || "<tr><td colspan='6' class='small'>No farm profiles registered yet.</td></tr>";
}

function initMap(farms) {
  if (!map) {
    map = L.map("regionMap").setView([14.4986, 121.3672], 11); // Tanay, Rizal
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
  farms.forEach((f) => {
    if (f.latitude != null) {
      L.marker([f.latitude, f.longitude]).addTo(map).bindPopup(`<b>${f.name}</b><br>${f.cropType} — ${f.areaHectares} ha`);
    }
  });
}

async function loadMlMetrics() {
  const m = await API.get("/api/admin/ml-metrics");
  if (!m.trained) {
    document.getElementById("mlMetrics").innerHTML = `
      <div class="card stat"><div class="label">Yield Model</div>
        <div class="value">Not trained</div>
        <div class="small">${m.message} (${m.harvestRecordsAvailable}/${m.minRequired} harvest records logged)</div></div>
    `;
    return;
  }
  document.getElementById("mlMetrics").innerHTML = `
    <div class="card stat"><div class="label">Yield Model (${m.yieldModel.type})</div>
      <div class="value">R² ${m.yieldModel.r2 ?? "—"}</div>
      <div class="small">RMSE ${m.yieldModel.rmse ?? "—"} · MAE ${m.yieldModel.mae ?? "—"} · Trained ${m.yieldModel.lastTrained}
        ${m.yieldModel.crossValidationFolds ? ` · ${m.yieldModel.crossValidationFolds}-fold CV` : ""}</div></div>
    <div class="card stat"><div class="label">Training Samples</div>
      <div class="value">${m.trainingSamples}</div>
      <div class="small">${m.harvestRecordsAvailable} harvest record(s) available</div></div>
  `;
}

function wireForms() {
  document.getElementById("trainBtn").addEventListener("click", async () => {
    const statusEl = document.getElementById("trainStatus");
    statusEl.textContent = "Training… (this runs ml/train.py, may take a few seconds)";
    try {
      await API.post("/api/admin/train-model");
      statusEl.textContent = "Training complete.";
      loadMlMetrics();
    } catch (e) {
      statusEl.textContent = "Training failed: " + e.message;
    }
  });

  document.getElementById("exportBtn").addEventListener("click", async () => {
    const token = API.getToken();
    const res = await fetch("/api/admin/export", { headers: { Authorization: "Bearer " + token } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "smartagri_farms_export.csv"; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("annForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await API.post("/api/announcements", {
      title: document.getElementById("ann_title").value,
      message: document.getElementById("ann_message").value,
    });
    document.getElementById("annForm").reset();
    loadAnnouncements();
  });
}

async function loadAnnouncements() {
  const anns = await API.get("/api/announcements");
  document.getElementById("annList").innerHTML = anns.map((a) => `
    <div class="notif-item">
      <div>${a.title}</div>
      <div class="meta">${new Date(a.createdAt).toLocaleString()}</div>
      <div>${a.message}</div>
      <button class="ghost mt8" onclick="deleteAnn('${a.id}')">Delete</button>
    </div>`).join("") || "<p class='small'>No announcements yet.</p>";
}

async function deleteAnn(id) {
  await API.del(`/api/announcements/${id}`);
  loadAnnouncements();
}
