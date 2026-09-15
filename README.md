# StreetVerse: AI-Powered Hyperlocal Commerce & Service Discovery Platform

**Capstone Project Synopsis - Group P76 | Department of Computer Engineering & Technology, MIT-WPU**

### Team Members:
- **Sanchit Tangri** (PRN: 1032231835) - *Lead Backend & AI Architect*
- **Darshan Mavadhiya** (PRN: 1032230727) - *Lead Frontend & UI/UX Developer*
- **Dishank Gandhi** (PRN: 1032232071) - *Database Administrator & Real-Time Systems*
- **Amar Gupta** (PRN: 1032233653) - *Vendor Operations & External API Integration*

**Project Guide:** Dr. Sumedha Sirsikar  
**Domain:** Artificial Intelligence, Full Stack Web Development, Hyperlocal Commerce & Retail Tech

---

## 1. Project Overview

**StreetVerse** is an AI-powered hyperlocal commerce and service discovery platform designed to digitize offline neighborhood businesses (groceries, salons, restaurants, pharmacies, hardware stores) and bridge them directly with local consumers.

### Core Capabilities:
- **Hyperlocal Discovery & Semantic RAG Search:** Consumers discover neighborhood shops and inventory using conversational AI and PostGIS geospatial proximity.
- **Service Appointment Scheduling:** Real-time calendar slot reservation with 5-minute atomic holding locks to prevent double-booking.
- **Direct Real-Time Chat:** Low-latency customer-to-vendor communication powered by Socket.io and Redis pub/sub.
- **Zero-Friction Dynamic UPI Payments:** Instant QR-code generation and callback verification before store visits.
- **Merchant Intelligence & Demand Forecasting:** AI agents automate routine query handling, restocking predictions, and foot-traffic analytics.

---

## 2. System Architecture & Data Isolation

StreetVerse strictly isolates customer and merchant data across two decoupled PostgreSQL databases:

```
                           ┌──────────────────────────────┐
                           │      Client Applications     │
                           │ ┌──────────────┬───────────┐ │
                           │ │  Buyer Web   │Seller Web │ │
                           │ │  (Next.js)   │ (Next.js) │ │
                           │ └──────┬───────┴─────┬─────┘ │
                           └────────┼─────────────┼───────┘
                                    │             │
                                    ▼             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ API Gateway & Orchestration (Node.js / Express / Socket.io)              │
│  - JWT Authentication & RBAC                                             │
│  - 5-Minute Atomic Slot Booking Locks                                    │
│  - Real-time Chat Dispatcher                                             │
└───────────────────────┬───────────────────────────────┬──────────────────┘
                        │                               │
                        ▼                               ▼
        ┌──────────────────────────────┐   ┌──────────────────────────────┐
        │  AI Multi-Agent Engine       │   │  Redis Pub/Sub & Lock Cache  │
        │  (Python / FastAPI)          │   │  - Socket.io Chat Channel    │
        │  - LangGraph / CrewAI Agents │   │  - 5-Min Booking TTL Keys    │
        │  - Geospatial + Semantic RAG │   └──────────────────────────────┘
        └───────────────┬──────────────┘
                        │
       ┌────────────────┴────────────────┐
       ▼                                 ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│ Database 1: Customer DB      │  │ Database 2: Merchant DB              │
│ (PostgreSQL)                 │  │ (PostgreSQL + PostGIS + pgvector)    │
│ - Customer Profiles          │  │ - Business Profiles & Geofences      │
│ - Order Histories            │  │ - Live Product Inventory + Embeddings│
│ - Booking Receipts           │  │ - Service Slots & Booking Locks      │
│ [Zero Merchant Secrets]      │  │ [Zero Customer PII]                  │
└──────────────────────────────┘  └──────────────────────────────────────┘
```

---

## 3. Monorepo Structure

```
StreetVerse/
├── apps/
│   ├── buyer-web/                 # Next.js customer discovery & booking app
│   └── seller-web/                # Next.js merchant management dashboard
├── services/
│   ├── api-gateway/               # Node.js / Express gateway & Socket.io chat
│   └── ai-agent-engine/           # Python FastAPI with LangGraph & pgvector RAG
├── packages/
│   └── database-schemas/          # SQL DDL, Prisma/Drizzle schemas for DB1 & DB2
│       ├── customer-db/
│       └── merchant-db/
├── docker-compose.yml             # Dual PostgreSQL (PostGIS + pgvector) & Redis
├── start-tunnel.ps1               # Cloudflare tunnel for external previews
└── README.md
```

---

## 4. Quick Start (Local Development)

### 1. Start Isolated Databases & Redis
```bash
docker compose up -d
```
- **Customer DB:** `localhost:5433` (`streetverse_customer_db`)
- **Merchant DB:** `localhost:5434` (`streetverse_merchant_db` with PostGIS + pgvector)
- **Redis Cache:** `localhost:6380`

### 2. Start Services
- **API Gateway:** `npm run dev:gateway` (Port `5000`)
- **AI Agent Engine:** `npm run dev:ai` (Port `8000`)
- **Buyer Web:** `npm run dev:buyer` (Port `3000`)
- **Seller Web:** `npm run dev:seller` (Port `3001`)
