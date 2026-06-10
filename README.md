# ⚡ l402-ban-api

**Validation et géocodage d'adresses françaises (Base Adresse Nationale), payable à la requête en satoshis via le protocole [L402](https://github.com/lightning/blips/blob/master/blip-0026.md).**

Conçu pour les agents IA : pas de compte, pas de clé API — le paiement Lightning EST l'authentification.

## Endpoints

| Route | Prix | Description |
|---|---|---|
| `GET /api/v1/validate?q=<adresse>` | 5 sats | Valide et normalise une adresse FR (score, code INSEE, géo) |
| `GET /api/v1/reverse?lat=&lon=` | 5 sats | Géocodage inverse |
| `GET /` | gratuit | Manifeste du service |
| `GET /.well-known/l402.json` | gratuit | Découverte pour agents |
| `GET /health`, `GET /stats` | gratuit | Liveness et compteurs locaux |

## Démarrage (5 minutes)

```bash
git clone https://github.com/CHANGE_ME/l402-ban-api && cd l402-ban-api
npm install
cp .env.example .env       # → renseigner LIGHTNING_ADDRESS
npm start
```

```bash
# 1) Appel sans paiement → 402 + facture BOLT11 + macaroon
curl "http://localhost:3402/api/v1/validate?q=10+rue+de+la+paix+paris"

# 2) Payer la facture avec n'importe quel wallet Lightning, puis :
curl "http://localhost:3402/api/v1/validate?q=10+rue+de+la+paix+paris" \
  -H "Authorization: L402 <macaroon>:<preimage>"
```

## Déploiement production (Debian, systemd)

```ini
# /etc/systemd/system/l402-ban-api.service
[Unit]
Description=l402-ban-api
After=network.target

[Service]
WorkingDirectory=/opt/l402-ban-api
EnvironmentFile=/opt/l402-ban-api/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

Exposer derrière un reverse proxy HTTPS (Caddy/nginx). HTTPS obligatoire pour le listing dans les annuaires.

## Être découvert (étape indispensable)

Sans listing, aucun agent ne trouvera le service :

1. **satring.com** → soumettre l'URL (sondage automatique quotidien)
2. **402index.io** → soumettre l'URL
3. **awesome-L402** (GitHub) → pull request

## Architecture de paiement

- `LIGHTNING_ADDRESS` (mode managé) : zéro infra, 99,7% des sats arrivent instantanément sur ton wallet, 0,3% de frais.
- `ALBY_TOKEN` (mode direct) : 0% de frais kit, nécessite un compte Alby.
- Conversion BTC possible à tout moment depuis le wallet récepteur.

## Licence

MIT
