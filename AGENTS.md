# Workspace Rules: Security & Git Policy

## 1. Zero-Secrets Policy (Public Repository)
- This repository is **PUBLIC**. Under no circumstances should real credentials, secrets, or sensitive details ever be committed or pushed.
- Never commit:
  - Any `.env`, `.env.local`, or secret config files.
  - API keys, broker API credentials, private tokens, or webhooks with secret tokens.
  - Real database passwords or full connection URIs with embedded passwords.
  - Private cryptographic keys (`.pem`, `.key`, `id_rsa`, etc.) or certificates.
  - Cloud provider credentials (AWS keys, GCP service account JSONs, etc.).
- Only commit safe templates (such as `.env.example`) containing dummy placeholder values (e.g., `YOUR_API_KEY_HERE`, `postgres:postgres@localhost:5432/...`).

## 2. Git Branching Policy
- All active development commits and pushes must occur **strictly on the `sanchit` branch**.
- Never push directly to `main` unless the user explicitly instructs to merge and release to `main`.
