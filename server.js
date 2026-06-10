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
    docs: "https://github.com/fredericsuretat/l402-ban-api#readme",
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

// --- Dashboard wallet (privé, token requis) ----------------------------------
// Config : NWC_URL (connexion Nostr Wallet Connect *lecture seule* créée dans Alby)
//          DASHBOARD_TOKEN (secret long, ex: openssl rand -hex 24)
app.get("/dashboard", async (req, res) => {
  if (!process.env.DASHBOARD_TOKEN || req.query.token !== process.env.DASHBOARD_TOKEN) {
    return res.status(404).json({ error: "not found" }); // 404 volontaire : ne pas révéler l'existence
  }
  if (!process.env.NWC_URL) {
    return res.status(503).json({ error: "NWC_URL not configured" });
  }
  try {
    const { NWCClient } = await import("@getalby/sdk");
    const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URL });
    const balance = await nwc.getBalance(); // msats
    const txs = await nwc.listTransactions({ limit: 15, type: "incoming" });
    nwc.close();

    const sats = Math.floor(balance.balance / 1000);
    const rows = (txs.transactions || [])
      .map((t) => {
        const d = new Date((t.settled_at || t.created_at) * 1000).toLocaleString("fr-FR");
        const amt = Math.floor(t.amount / 1000);
        return `<tr><td>${d}</td><td style="text-align:right">+${amt} sats</td><td>${(t.description || "").slice(0, 60)}</td></tr>`;
      })
      .join("");

    res.send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>⚡ l402-ban-api — wallet</title>
<style>
 body{font-family:system-ui;background:#0d1117;color:#e6edf3;max-width:680px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.2rem} .bal{font-size:2.4rem;color:#f7931a;font-weight:700}
 table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.9rem}
 td{padding:.45rem .3rem;border-bottom:1px solid #21262d}
 .meta{color:#8b949e;font-size:.85rem}
</style>
<h1>⚡ Wallet l402-ban-api</h1>
<div class="bal">${sats.toLocaleString("fr-FR")} sats</div>
<div class="meta">Session serveur : ${stats.paid_requests} req payées · ${stats.sats_earned} sats (volatil)</div>
<h2 style="font-size:1rem;margin-top:1.5rem">Derniers paiements reçus</h2>
<table>${rows || "<tr><td>Aucun paiement pour l'instant</td></tr>"}</table>
</html>`);
  } catch (e) {
    console.error("[dashboard]", e.message || e);
    res.status(502).json({ error: "wallet connection failed" });
  }
});

// Error handler global : jamais de stack trace HTML vers un client (souvent une machine)
app.use((err, _req, res, _next) => {
  console.error("[error]", err.message || err);
  res.status(502).json({ error: "lightning provider unavailable", retry: true });
});

app.listen(PORT, () => {
  console.log(`⚡ l402-ban-api on :${PORT} — ${PRICE_SATS} sats/req — BAN: ${BAN_BASE_URL}`);
});
