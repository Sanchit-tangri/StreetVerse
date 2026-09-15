# StreetVerse

Welcome to the **StreetVerse** project repository.

## Branch Workflow
- `main` - Production / Release branch (Protected).
- `sanchit` - Active development branch for Sanchit.
- `darshan` - Active development branch for Darshan.
- `dishank` - Active development branch for Dishank.
- `amar` - Active development branch for Amar.

## Getting Started

### 1. Local Database (PostgreSQL)
Start the local PostgreSQL container using Docker:
```bash
docker compose up -d
```

### 2. Local Backend HTTPS & WSS Tunnel
Forward your local backend port (default 5000) for Vercel:
```powershell
powershell -ExecutionPolicy Bypass -File .\start-tunnel.ps1 -Port 5000
```
