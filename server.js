/**
 * l402-ban-api — Validation d'adresses françaises (BAN) payable en sats via L402.
 *
 * Endpoints gratuits : /, /health, /.well-known/l402.json
 * Endpoints payants  : /api/v1/validate, /api/v1/reverse
 *
 * Config (variables d'environnement, voir .env.example) :
 *   LIGHTNING_ADDRESS  → mode managé (zéro config, 0,3% de frais ShinyDapps)
 *   ALBY_TOKEN         → mode direct Alby (0% de frais kit)
 *   PRICE_SATS         → prix par requête (défaut: 5)
 *   BAN_BASE_URL       → défaut: https://data.geopf.fr/geocodage (Géoplateforme IGN)
 *                        fallback historique: https://api-adresse.data.gouv.fr
 *   PORT               → défaut: 3402
 */

import express from "express";
import { l402, ManagedProvider, AlbyProvider } from "l402-kit";

const PORT = Number(process.env.PORT || 3402);
const PRICE_SATS = Number(process.env.PRICE_SATS || 5);
const BAN_BASE_URL = (process.env.BAN_BASE_URL || "https://data.geopf.fr/geocodage").replace(/\/$/, "");

// --- Provider Lightning -----------------------------------------------------
function buildLightningProvider() {
  if (process.env.ALBY_TOKEN) {
    console.log("[lightning] AlbyProvider (mode direct)");
    return new AlbyProvider(process.env.ALBY_TOKEN);
  }
  if (process.env.LIGHTNING_ADDRESS) {
    console.log(`[lightning] ManagedProvider → ${process.env.LIGHTNING_ADDRESS}`);
    return new ManagedProvider(process.env.LIGHTNING_ADDRESS);
  }
  console.error("ERREUR: définir LIGHTNING_ADDRESS ou ALBY_TOKEN (voir .env.example)");
  process.exit(1);
}

const lightning = buildLightningProvider();
const paywall = l402({ priceSats: PRICE_SATS, lightning });

const app = express();
app.disable("x-powered-by");

// --- Stats en mémoire (observabilité minimale) -------------------------------
const stats = { started: new Date().toISOString(), paid_requests: 0, sats_earned: 0 };

// --- Endpoints gratuits -------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    name: "l402-ban-api",
    description:
      "French address validation & geocoding (Base Adresse Nationale), pay-per-call in sats via L402.",
    pricing: { unit: "request", price_sats: PRICE_SATS, protocol: "L402" },
    endpoints: {
      "GET /api/v1/validate?q=<address>": "Validate & normalize a French address (paid)",
      "GET /api/v1/reverse?lat=<lat>&lon=<lon>": "Reverse geocode coordinates in France (paid)",
      "GET /health": "Liveness (free)",
      "GET /.well-known/l402.json": "Agent discovery manifest (free)",
    },
    docs: "https://github.com/CHANGE_ME/l402-ban-api#readme",
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, uptime_s: process.uptime() }));

// Manifest de découverte pour agents (convention .well-known)
app.get("/.well-known/l402.json", (_req, res) => {
  res.json({
    version: "1.0",
    protocol: "L402",
    payment: { network: "lightning", min_sats: PRICE_SATS },
    services: [
      {
        path: "/api/v1/validate",
        method: "GET",
        price_sats: PRICE_SATS,
        params: { q: "free-text French address" },
        returns: "normalized address, score, INSEE code, coordinates",
      },
      {
        path: "/api/v1/reverse",
        method: "GET",
        price_sats: PRICE_SATS,
        params: { lat: "latitude", lon: "longitude" },
        returns: "nearest French address",
      },
    ],
  });
});

// --- Helpers BAN ---------------------------------------------------------------
async function banFetch(path, params) {
  const url = new URL(BAN_BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "User-Agent": "l402-ban-api/1.0" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`BAN upstream ${r.status}`);
  return r.json();
}

function enrich(feature) {
  if (!feature) return null;
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry?.coordinates || [null, null];
  return {
    valid: (p.score ?? 0) >= 0.5,
    score: p.score ?? null,
    label: p.label ?? null,
    normalized: {
      housenumber: p.housenumber ?? null,
      street: p.street ?? p.name ?? null,
      postcode: p.postcode ?? null,
      city: p.city ?? null,
      citycode_insee: p.citycode ?? null,
      context: p.context ?? null,
      type: p.type ?? null,
    },
    geo: { lat, lon },
  };
}

// --- Endpoints payants (L402) ----------------------------------------------------
app.get("/api/v1/validate", paywall, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (q.length < 3) return res.status(400).json({ error: "query 'q' too short (min 3 chars)" });
  try {
    const data = await banFetch("/search/", { q, limit: "3", autocomplete: "0" });
    stats.paid_requests++;
    stats.sats_earned += PRICE_SATS;
    const results = (data.features || []).map(enrich);
    res.json({ query: q, best: results[0] ?? null, alternatives: results.slice(1), source: "BAN" });
  } catch (e) {
    // Échec amont APRÈS paiement → on répond 502 honnêtement.
    res.status(502).json({ error: "upstream BAN unavailable", detail: String(e.message || e) });
  }
});

app.get("/api/v1/reverse", paywall, async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "params 'lat' and 'lon' required (numbers)" });
  }
  try {
    const data = await banFetch("/reverse/", { lat: String(lat), lon: String(lon) });
    stats.paid_requests++;
    stats.sats_earned += PRICE_SATS;
    res.json({ query: { lat, lon }, result: enrich((data.features || [])[0]), source: "BAN" });
  } catch (e) {
    res.status(502).json({ error: "upstream BAN unavailable", detail: String(e.message || e) });
  }
});

// Stats locales (gratuit — utile pour ton dashboard d'observabilité plus tard)
app.get("/stats", (_req, res) => res.json(stats));

// Error handler global : jamais de stack trace HTML vers un client (souvent une machine)
app.use((err, _req, res, _next) => {
  console.error("[error]", err.message || err);
  res.status(502).json({ error: "lightning provider unavailable", retry: true });
});

app.listen(PORT, () => {
  console.log(`⚡ l402-ban-api on :${PORT} — ${PRICE_SATS} sats/req — BAN: ${BAN_BASE_URL}`);
});
