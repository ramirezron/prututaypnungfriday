let currentUser = null;
let farms = [];
let selectedFarmId = null;

(async function init() {
  currentUser = await requireLogin("farmer");
  if (!currentUser) return;
  document.getElementById("userName").textContent = currentUser.name;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await API.post("/api/logout").catch(() => {});
    API.clearToken();
    window.location.href = "/index.html";
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });

  await loadFarms();
  wireForms();
})();

function showPage(name) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  if (name === "editFarm") populateEditSelect();
  if (name === "logs") { populateFarmSelect("log_farmSelect"); loadLogs(); loadHarvestHistory(); }
  if (name === "soil") { populateFarmSelect("soil_farmSelect"); loadSoil(); }
  if (name === "notifications") loadNotifications();
}

async function loadFarms() {
  farms = await API.get("/api/farms");
  const chips = document.getElementById("farmChips");
  chips.innerHTML = "";
  document.getElementById("noFarmsHint").style.display = farms.length ? "none" : "block";
  if (!selectedFarmId && farms.length) selectedFarmId = farms[0].id;
  farms.forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "farm-chip" + (f.id === selectedFarmId ? " active" : "");
    chip.textContent = `${f.name} (${f.cropType})`;
    chip.addEventListener("click", () => { selectedFarmId = f.id; loadFarms(); loadDashboardData(); });
    chips.appendChild(chip);
  });
  if (selectedFarmId) loadDashboardData();
}

async function loadDashboardData() {
  const farm = farms.find((f) => f.id === selectedFarmId);
  if (!farm || farm.latitude == null) return;
  document.getElementById("yieldValue").textContent = "Loading…";
  try {
    const data = await API.get(`/api/climate-risk?lat=${farm.latitude}&lon=${farm.longitude}&cropType=${encodeURIComponent(farm.cropType)}&farmId=${farm.id}`);
    document.getElementById("yieldValue").textContent = `${data.yieldForecast.estimatedTonPerHa} t/ha`;
    document.getElementById("yieldNote").textContent = data.yieldForecast.note;

    const badge = document.getElementById("riskBadge");
    badge.textContent = data.climateRisk.level;
    badge.className = "badge " + data.climateRisk.level.toLowerCase();
    document.getElementById("riskReasons").textContent = data.climateRisk.reasons.join(" ");
  } catch (e) {
    document.getElementById("yieldValue").textContent = "Unavailable";
    document.getElementById("yieldNote").textContent = e.message;
  }
}

function populateFarmSelect(selectId) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = farms.map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
  if (selectedFarmId) sel.value = selectedFarmId;
  sel.onchange = () => {
    selectedFarmId = sel.value;
    if (selectId === "log_farmSelect") { loadLogs(); loadHarvestHistory(); }
    if (selectId === "soil_farmSelect") loadSoil();
  };
}

function populateEditSelect() {
  const sel = document.getElementById("ef_select");
  sel.innerHTML = farms.map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
  if (selectedFarmId) sel.value = selectedFarmId;
  fillEditForm();
  sel.onchange = () => { selectedFarmId = sel.value; fillEditForm(); };
}

function fillEditForm() {
  const f = farms.find((x) => x.id === (document.getElementById("ef_select").value || selectedFarmId));
  if (!f) return;
  document.getElementById("ef_name").value = f.name;
  document.getElementById("ef_cropType").value = f.cropType;
  document.getElementById("ef_area").value = f.areaHectares;
  document.getElementById("ef_address").value = f.address;
  document.getElementById("ef_plantingDate").value = f.plantingDate || "";
}

function wireForms() {
  // Add Farm
  document.getElementById("af_geocode").addEventListener("click", async () => {
    const q = document.getElementById("af_address").value.trim();
    const resEl = document.getElementById("af_geocodeResult");
    if (!q) return;
    resEl.textContent = "Searching…";
    try {
      const results = await API.get(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!results.length) { resEl.textContent = "No match found — enter coordinates manually if needed."; return; }
      const top = results[0];
      document.getElementById("af_lat").value = top.latitude;
      document.getElementById("af_lon").value = top.longitude;
      resEl.textContent = `Found: ${top.name}, ${top.admin1 || ""} (${top.latitude.toFixed(3)}, ${top.longitude.toFixed(3)})`;
    } catch (e) { resEl.textContent = "Lookup failed: " + e.message; }
  });

  document.getElementById("addFarmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("af_error");
    errEl.textContent = "";
    const lat = document.getElementById("af_lat").value;
    const lon = document.getElementById("af_lon").value;
    if (!lat || !lon) { errEl.textContent = "Click \"Find coordinates\" before saving."; return; }
    try {
      const farm = await API.post("/api/farms", {
        name: document.getElementById("af_name").value,
        cropType: document.getElementById("af_cropType").value,
        areaHectares: parseFloat(document.getElementById("af_area").value),
        address: document.getElementById("af_address").value,
        latitude: parseFloat(lat),
        longitude: parseFloat(lon),
        plantingDate: document.getElementById("af_plantingDate").value,
      });
      selectedFarmId = farm.id;
      document.getElementById("addFarmForm").reset();
      document.getElementById("af_geocodeResult").textContent = "";
      await loadFarms();
      showPage("dashboard");
    } catch (e) { errEl.textContent = e.message; }
  });

  // Edit Farm
  document.getElementById("editFarmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("ef_select").value;
    await API.put(`/api/farms/${id}`, {
      name: document.getElementById("ef_name").value,
      cropType: document.getElementById("ef_cropType").value,
      areaHectares: parseFloat(document.getElementById("ef_area").value),
      address: document.getElementById("ef_address").value,
      plantingDate: document.getElementById("ef_plantingDate").value,
    });
    await loadFarms();
    showPage("dashboard");
  });
  document.getElementById("ef_delete").addEventListener("click", async () => {
    const id = document.getElementById("ef_select").value;
    if (!confirm("Delete this farm profile? This cannot be undone.")) return;
    await API.del(`/api/farms/${id}`);
    selectedFarmId = null;
    await loadFarms();
    showPage("dashboard");
  });

  // Crop Growth Log
  document.getElementById("logForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const farmId = document.getElementById("log_farmSelect").value;
    await API.post(`/api/farms/${farmId}/logs`, {
      date: document.getElementById("log_date").value,
      growthStage: document.getElementById("log_stage").value,
      notes: document.getElementById("log_notes").value,
    });
    document.getElementById("logForm").reset();
    loadLogs();
  });

  // Soil Parameters
  document.getElementById("soilForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const farmId = document.getElementById("soil_farmSelect").value;
    const mode = document.querySelector('input[name="soilMode"]:checked').value;
    await API.post(`/api/farms/${farmId}/soil`, {
      mode,
      nitrogen: parseFloat(document.getElementById("soil_n").value) || null,
      phosphorus: parseFloat(document.getElementById("soil_p").value) || null,
      potassium: parseFloat(document.getElementById("soil_k").value) || null,
      ph: parseFloat(document.getElementById("soil_ph").value) || null,
      moisturePercent: parseFloat(document.getElementById("soil_moisture").value) || null,
      source: mode === "baseline" ? "BSWM/MAO baseline lookup" : "Manual farmer input",
    });
    document.getElementById("soilForm").reset();
    loadSoil();
  });

  // Harvest Outcome (feeds the ML model)
  document.getElementById("harvestForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const farmId = document.getElementById("log_farmSelect").value;
    await API.post(`/api/farms/${farmId}/harvest`, {
      date: document.getElementById("hv_date").value,
      actualYieldTonPerHa: parseFloat(document.getElementById("hv_yield").value),
      notes: document.getElementById("hv_notes").value,
    });
    document.getElementById("harvestForm").reset();
    loadHarvestHistory();
  });
}

async function loadHarvestHistory() {
  const farmId = document.getElementById("log_farmSelect").value;
  if (!farmId) return;
  const records = await API.get(`/api/farms/${farmId}/harvest`);
  const tbody = document.querySelector("#harvestTable tbody");
  tbody.innerHTML = records.map((h) => `<tr><td>${h.date}</td><td>${h.actualYieldTonPerHa}</td><td>${h.notes || ""}</td></tr>`).join("")
    || "<tr><td colspan='3' class='small'>No harvest records yet.</td></tr>";
}

async function loadLogs() {
  const farmId = document.getElementById("log_farmSelect").value;
  if (!farmId) return;
  const logs = await API.get(`/api/farms/${farmId}/logs`);
  const tbody = document.querySelector("#logsTable tbody");
  tbody.innerHTML = logs.map((l) => `<tr><td>${l.date}</td><td>${l.growthStage}</td><td>${l.notes || ""}</td></tr>`).join("");
}

async function loadSoil() {
  const farmId = document.getElementById("soil_farmSelect").value;
  if (!farmId) return;
  const profiles = await API.get(`/api/farms/${farmId}/soil`);
  const tbody = document.querySelector("#soilTable tbody");
  tbody.innerHTML = profiles
    .slice().reverse()
    .map((s) => `<tr><td>${new Date(s.updatedAt).toLocaleDateString()}</td><td>${s.mode}</td><td>${s.nitrogen ?? "-"}</td><td>${s.phosphorus ?? "-"}</td><td>${s.potassium ?? "-"}</td><td>${s.ph ?? "-"}</td><td>${s.moisturePercent ?? "-"}</td><td>${s.source}</td></tr>`)
    .join("");
}

async function loadNotifications() {
  const notes = await API.get("/api/notifications");
  const list = document.getElementById("notifList");
  if (!notes.length) { list.innerHTML = "<p class='small'>No notifications yet.</p>"; return; }
  list.innerHTML = notes.map((n) => `
    <div class="notif-item ${n.read ? "" : "unread"}" data-id="${n.id}">
      <div>${n.title}</div>
      <div class="meta">${new Date(n.createdAt).toLocaleString()}</div>
      <div>${n.message}</div>
      ${n.read ? "" : `<button class="ghost mt8" onclick="markRead('${n.id}')">Mark as read</button>`}
    </div>`).join("");
}

async function markRead(id) {
  await API.post(`/api/notifications/${id}/read`);
  loadNotifications();
}
