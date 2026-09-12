// Shared fetch helper. Token is kept in sessionStorage (cleared when the tab closes).
const API = {
  base: "",
  getToken() { return sessionStorage.getItem("smartagri_token"); },
  setToken(t) { sessionStorage.setItem("smartagri_token", t); },
  clearToken() { sessionStorage.removeItem("smartagri_token"); },

  async request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    const token = this.getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.clearToken();
      window.location.href = "/index.html";
      throw new Error("Not authenticated");
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return res; // e.g. CSV download
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  },
  get(path) { return this.request("GET", path); },
  post(path, body) { return this.request("POST", path, body); },
  put(path, body) { return this.request("PUT", path, body); },
  del(path) { return this.request("DELETE", path); },
};

function requireLogin(expectedRole) {
  if (!API.getToken()) { window.location.href = "/index.html"; return null; }
  return API.get("/api/me").then((r) => {
    if (expectedRole && r.user.role !== expectedRole) {
      window.location.href = r.user.role === "admin" ? "/admin.html" : "/app.html";
      return null;
    }
    return r.user;
  }).catch(() => { window.location.href = "/index.html"; });
}
