# Software Requirements Specification (SRS)
## StreetVerse: AI-Powered Hyperlocal Commerce & Service Discovery Platform

**Standard:** IEEE 830 / ISO/IEC/IEEE 29148  
**Project Identifier:** STV-ENG-2026-V1.0  
**Development Lifecycle Model:** Agile Scrum (August 2026 – Present / November 2026)  
**Classification:** Confidential – Capstone Project Synopsis (Group P76, MIT-WPU)  
**Primary Authors & System Architects:**
- **Sanchit Tangri** (PRN: 1032231835) – *Lead Backend & AI Multi-Agent Architect*
- **Darshan Mavadhiya** (PRN: 1032230727) – *Lead Frontend & UI/UX Developer*
- **Dishank Gandhi** (PRN: 1032232071) – *Database Administrator & Real-Time Systems*
- **Amar Gupta** (PRN: 1032233653) – *Vendor Operations & External API Integration*  
**Faculty Project Guide:** Dr. Sumedha Sirsikar  
**Domain:** Distributed Hyperlocal Retail Tech, Semantic Vector Search (pgvector), Real-Time Systems

---

## 1. Introduction & Executive Summary

### 1.1 Purpose
This document establishes the comprehensive Software Requirements Specification (SRS) for **StreetVerse**, an enterprise-grade hyperlocal commerce and service discovery platform designed to bridge offline neighborhood vendors (kirana stores, salons, local pharmacies, specialty eateries) with local consumers through conversational AI, PostGIS spatial search, atomic appointment slot reservations, and dynamic UPI payment clearing.

### 1.2 Scope of the System
StreetVerse encompasses:
1. **Dual Decoupled PostgreSQL Databases** providing strict physical data isolation:
   - **Customer DB (Database 1):** Customer profiles, credentials, orders, and booking receipts. Zero vendor internal metrics or wholesale data.
   - **Merchant DB (Database 2):** Merchant profiles, GPS coordinates, live product inventory with 1536-dimensional vector embeddings, service slots, and UPI VPAs. Zero customer PII.
2. **API Gateway & Real-Time Orchestration Hub:** Node.js, Express, TypeScript, and Socket.io cluster managing authentication, rate limiting, and 5-minute atomic slot locks backed by Redis.
3. **AI Multi-Agent RAG Engine:** Python FastAPI microservice utilizing pgvector and PostGIS `earthdistance` for semantic and proximity discovery.
4. **Client Applications:** Decoupled Next.js 14 Web Applications:
   - **Buyer Web (`apps/buyer-web`):** Customer discovery, geolocation detection, appointment scheduling, and dynamic UPI QR generation.
   - **Seller Web (`apps/seller-web`):** Merchant management portal, live inventory status, slot calendar, and order tracking.

---

## 2. Agile Development Trajectory (August 2026 – Present)

StreetVerse was engineered following an iterative Agile Scrum methodology structured into 7 distinct two-week Sprints from August 2026 through November 2026, transitioning from architectural scaffolding to a hardened, enterprise-ready platform.

```
 August 2026                September 2026              October 2026              November 2026
 ┌─────────────┐            ┌─────────────┐             ┌─────────────┐           ┌─────────────┐
 │ Sprint 1-2  │ ─────────► │ Sprint 3-4  │ ──────────► │ Sprint 5-6  │ ────────► │  Sprint 7+  │
 │ Foundations │            │ Core Engine │             │ Frontends   │           │ Hardening & │
 │ & Dual DB   │            │ AI & Locks  │             │ Buyer/Seller│           │ Production  │
 └─────────────┘            └─────────────┘             └─────────────┘           └─────────────┘
```

### Sprint History & Milestone Matrix

| Sprint | Period | Objectives & User Stories Delivered | Velocity | Key Deliverables & Artifacts |
| :--- | :--- | :--- | :--- | :--- |
| **Sprint 1** | Aug 03 – Aug 14, 2026 | Project charter, monorepo scaffolding (npm workspaces), dual-database Docker Compose setup (`streetverse_customer_db` on 5433, `streetverse_merchant_db` on 5434). | 28 pts | `docker-compose.yml`, SQL DDL schemas, `AGENTS.md` git policy. |
| **Sprint 2** | Aug 17 – Aug 28, 2026 | User and merchant registration/login, Bcrypt password hashing (10 salt rounds), JWT token issuance (HMAC SHA-256), strict parameterized SQL query policy. | 32 pts | `services/api-gateway/src/routes/auth.ts`, Unit test suite v1. |
| **Sprint 3** | Aug 31 – Sep 11, 2026 | Redis integration (port 6380), 5-minute atomic slot lock (`SET NX EX 300`), dynamic NPCI UPI string generator, payment verification callbacks. | 36 pts | `lock-slot` & `confirm-payment` endpoints in API Gateway. |
| **Sprint 4** | Sep 14 – Sep 25, 2026 | Python FastAPI AI Engine, pgvector 1536-dim embeddings, PostGIS `cube` + `earthdistance` integration, fallback Gemini AI generative mock. | 40 pts | `services/ai-agent-engine/main.py`, SQL spatial query engine. |
| **Sprint 5** | Sep 28 – Oct 09, 2026 | Next.js 14 Buyer Portal (`apps/buyer-web`), OpenStreetMap reverse geocoding, interactive shop grid, dynamic slot booking modal with dynamic QR. | 44 pts | `apps/buyer-web/src/pages/index.tsx`, `BuyerAuth.tsx`. |
| **Sprint 6** | Oct 12 – Oct 23, 2026 | Next.js 14 Seller Portal (`apps/seller-web`), merchant authentication, slot status toggle, appointment roster, Socket.io real-time chat dispatcher. | 38 pts | `apps/seller-web/src/pages/index.tsx`, `SellerAuth.tsx`. |
| **Sprint 7** | Oct 26 – Nov 06, 2026 | System resilience layer (zero-downtime memory database fallback when Docker is offline), automated blackbox SQL injection test harness. | 35 pts | `services/api-gateway/src/db/resilientPool.ts`, `tests/run-all.ts`. |
| **Current** | Nov 07 – Present | Production hardening, Docker daemon recovery, 22-test automated QA test run (100% pass), and enterprise SRS documentation sign-off. | 25 pts | Complete SRS Document, live search engine verification. |

---

## 3. Overall System Architecture & Data Isolation

```
                                  ┌──────────────────────────────┐
                                  │      Client Applications     │
                                  │ ┌──────────────┬───────────┐ │
                                  │ │  Buyer Web   │Seller Web │ │
                                  │ │ (Port 3000)  │(Port 3001)│ │
                                  │ └──────┬───────┴─────┬─────┘ │
                                  └────────┼─────────────┼───────┘
                                           │             │
                                           ▼             ▼
      ┌──────────────────────────────────────────────────────────────────────────┐
      │ API Gateway & Orchestrator (Express / TypeScript / Socket.io - Port 5000)│
      │  - Strict Parameterized Query Enforcer (Zero String Interpolation)       │
      │  - JWT & RBAC Verification Middleware                                    │
      │  - 5-Minute Atomic Holding Lock Controller                               │
      │  - Automatic In-Memory Resilience Fallback Engine                        │
      └───────────────────────────────┬───────────────────────────┬──────────────┘
                                      │                           │
                                      ▼                           ▼
                      ┌──────────────────────────────┐   ┌──────────────────────────────┐
                      │  AI Multi-Agent Engine       │   │  Redis Pub/Sub & Lock Cache  │
                      │  (FastAPI - Port 8000)       │   │  (Port 6380)                 │
                      │  - PostGIS Earthdistance     │   │  - Socket.io Chat Channel    │
                      │  - Hybrid Semantic Retrieval │   │  - 5-Min TTL Mutex Keys      │
                      └───────────────┬──────────────┘   └──────────────────────────────┘
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
      ┌──────────────────────────────┐  ┌──────────────────────────────────────┐
      │ Database 1: Customer DB      │  │ Database 2: Merchant DB              │
      │ (PostgreSQL 16 - Port 5433)  │  │ (PostgreSQL 16 + pgvector - Port 5434│
      │ - Users & Auth Profiles      │  │ - Merchants, GPS Coordinates & VPAs  │
      │ - Customer Order Receipts    │  │ - Inventory Items & 1536-dim Vectors │
      │ - Booking Vouchers           │  │ - Service Slots & Real-time Status   │
      │ [Zero Merchant Secrets]      │  │ [Zero Customer PII]                  │
      └──────────────────────────────┘  └──────────────────────────────────────┘
```

---

## 4. Specific Functional Requirements (FR)

### 4.1 Module 1: Authentication & Authorization (AUTH)
- **FR-AUTH-01 (Buyer Registration):** The system shall allow consumers to register with unique phone number, full name, email, and password. Passwords must be hashed using Bcrypt with a salt factor of 10.
- **FR-AUTH-02 (Seller Registration):** The system shall allow merchants to register with business name, category, owner phone, email, password, UPI VPA, address, and pincode.
- **FR-AUTH-03 (OTP Verification):** The system shall issue cryptographically secure 6-digit numeric OTPs via SMTP or dev-console with a 5-minute TTL.
- **FR-AUTH-04 (Brute-Force Throttling):** The system shall enforce a strict 3-attempt limit on OTP inputs. Upon 3 consecutive invalid attempts, the OTP key is automatically deleted and the session locked.
- **FR-AUTH-05 (JWT Issuance & RBAC):** Upon successful verification, the gateway shall return a signed JWT token containing `userId` and `role` (`buyer` or `seller`) with an expiration of 24 hours.

### 4.2 Module 2: Hyperlocal Discovery & Search Engine (SRCH)
- **FR-SRCH-01 (Geospatial Querying):** The search engine shall accept user GPS coordinates (`latitude`, `longitude`) and compute great-circle distance to local stores using PostgreSQL `earthdistance` functions (`ll_to_earth`).
- **FR-SRCH-02 (Hybrid Products & Services Discovery):** The search engine shall search across both physical retail inventory items (`inventory_items`) and service appointment slots (`service_slots`).
- **FR-SRCH-03 (Relevance Ranking):** Search results shall be ranked based on relevance:
  - Exact Item Name Match: `0.98`
  - Category Match: `0.92`
  - Merchant Name Match: `0.88`
  - Sorted secondarily by `distance_meters ASC`.
- **FR-SRCH-04 (Multi-Tier Fallback):** If the AI Engine is unreachable or returns 0 items, the API Gateway shall automatically execute direct database discovery, followed by contextual synthesis to ensure zero customer drop-off.

### 4.3 Module 3: Service Scheduling & Atomic Slot Lock (BOOK)
- **FR-BOOK-01 (Atomic Slot Hold):** When a customer clicks "Book Slot", the gateway shall execute an atomic Redis `SET lock:slot:<slotId> <token> EX 300 NX` command.
- **FR-BOOK-02 (Conflict Prevention):** If another customer holds the slot, the system shall return an HTTP `409 Conflict` status with message: *"Slot is currently being held by another customer. Please try again in 5 minutes."*
- **FR-BOOK-03 (Dynamic UPI Intent Generation):** Upon acquiring the 5-minute lock, the system shall generate an NPCI-compliant dynamic UPI URI:
  `upi://pay?pa=<MerchantVPA>&pn=<MerchantName>&am=<Price>&cu=INR&tn=SlotLock_<SlotId>`
- **FR-BOOK-04 (Payment Confirmation & Receipt):** When the payment callback is triggered, the gateway shall release the Redis lock, mark the slot as `BOOKED` in Merchant DB, and persist a booking receipt with a unique QR verification code in Customer DB.

### 4.4 Module 4: Real-Time Mesh Communication (CHAT)
- **FR-CHAT-01 (Isolated Conversation Rooms):** The gateway Socket.io server shall support isolated conversation rooms (`join_conversation`) between verified buyers and merchants.
- **FR-CHAT-02 (Message Broadcasting):** Chat messages shall be broadcast to room participants with server-stamped UTC timestamps and UUID message identifiers.

---

## 5. Non-Functional Requirements (NFR)

### 5.1 Performance & Latency Requirements
- **NFR-PERF-01 (Search Response Time):** Hyperlocal search queries within a 5.0 km radius must return in **< 120 milliseconds** at the 95th percentile under 50 concurrent requests.
- **NFR-PERF-02 (Slot Lock Latency):** Atomic slot reservation via Redis NX must complete in **< 20 milliseconds**.
- **NFR-PERF-03 (Frontend Page Load):** Next.js initial server-side hydration must achieve a First Contentful Paint (FCP) of **< 1.2 seconds**.

### 5.2 Security & Compliance
- **NFR-SEC-01 (Zero-Secrets Repository Policy):** No private keys, database passwords, or API credentials shall ever be committed to git. All configurations must be injected via ignored `.env` files.
- **NFR-SEC-02 (SQL Injection Proofing):** 100% of SQL database operations must execute via parameterized queries (`$1, $2, ...`). Zero string concatenation is permitted in query strings.
- **NFR-SEC-03 (Strict Data Isolation):** Customer PII (passwords, addresses, personal phone numbers) must never cross into Merchant DB.

### 5.3 Reliability, Availability & Fault Tolerance
- **NFR-REL-01 (System Availability):** The system shall achieve **99.9% uptime** during operational hours.
- **NFR-REL-02 (Graceful Degradation):** If Docker, PostgreSQL, or Redis fail or crash locally, the API Gateway's in-memory resilience engine must transparently activate without throwing unhandled exceptions or crashing the server.

---

## 6. Verification & Quality Assurance Matrix

The platform is validated through an automated test harness (`tests/run-all.ts`). 

### Summary of Executed Quality Assurance Tests (22 / 22 Passed):

```
================================================================
   StreetVerse Enterprise Automated Test Suite Execution
   Scope: Unit, Geospatial RAG, Security, and Live DB Contracts
================================================================

● Suite: Search Engine
  ✓ [PASS] Unit: Geospatial Haversine Great-Circle Proximity Calculation (0ms)
  ✓ [PASS] Unit: Multi-Tiered Relevance Scoring Engine (Item, Category, Vendor) (0ms)
  ✓ [PASS] Unit: Dynamic Radius Geofence Boundary Enforcement (3km & 100m tests) (1ms)
  ✓ [PASS] Unit: Cross-Domain Multi-Category Discovery (Retail Products & Salon Services) (0ms)
  ✓ [PASS] Unit: Search Input Sanitization, SQL Boundary & Edge-Case Resilience (0ms)

● Suite: Authentication & Security
  ✓ [PASS] Unit: Cryptographic Salt Entropy & Bcrypt Verification (331ms)
  ✓ [PASS] Unit: Strict Input Format & Validation Rules (Email, Phone, Password) (1ms)
  ✓ [PASS] Unit: Cryptographically Secure 6-Digit OTP Entropy Test (200 Invocations) (1ms)
  ✓ [PASS] Unit: JWT Signature Verification & Cryptographic Tamper Resistance (6ms)
  ✓ [PASS] Unit: Brute-Force Defense: 3-Attempt Maximum Lockout Policy (0ms)

● Suite: Booking & Slot Locking
  ✓ [PASS] Unit: Redis NX Atomic Slot Reservation & Double-Booking Prevention (0ms)
  ✓ [PASS] Unit: Tokenized Lock Release Contract on Payment Confirmation (0ms)
  ✓ [PASS] Unit: 5-Minute TTL Automated Eviction (Abandoned Cart Recovery) (77ms)
  ✓ [PASS] Unit: Dynamic NPCI-Compliant UPI QR Intent Generation (0ms)

● Suite: System Resilience & Isolation
  ✓ [PASS] Unit: Strict Customer DB vs Merchant DB Data Isolation Contract (0ms)
  ✓ [PASS] Unit: Graceful Service Degradation & Circuit Breaker State Machine (0ms)

● Suite: Live Integration & Security
  ✓ [PASS] Integration: Live Customer DB (Port 5433) Connectivity & User State (43ms)
  ✓ [PASS] Integration: Live Merchant DB (Port 5434) PostGIS Earthdistance Calculation (17ms)
  ✓ [PASS] Security Blackbox: SQL Injection Resistance - Tautology Vector (' OR '1'='1) (3ms)
  ✓ [PASS] Security Blackbox: SQL Injection Resistance - Comment Vector (admin'--) (1ms)
  ✓ [PASS] Security Blackbox: SQL Injection Resistance - Stacked Query Vector ('; DROP TABLE...) (1ms)
  ✓ [PASS] Integration: Seeded Customer Bcrypt Password Verification Contract (77ms)

================================================================
Results: 22 passed, 0 failed (0.56s) - 100% Pass Rate
================================================================
```

---

## 7. Deployment & Operations (DevOps & SRE)

### 7.1 Local Container Topology
- **Customer DB:** `postgres:16-alpine` on port `5433`
- **Merchant DB:** `pgvector/pgvector:pg16` on port `5434`
- **In-Memory Cache:** `redis:7-alpine` on port `6380`

### 7.2 Production Cloud Architecture
- **API Gateway & Microservices:** Containerized Node.js & Python workloads running on AWS ECS / EKS with horizontal pod autoscaling (CPU > 70%).
- **Edge Routing & Tunneling:** Cloudflare Tunnel or AWS Route 53 with SSL termination.
- **Observability:** Health check probes at `/api/health` and `/health`, integrated with Prometheus metrics and structured JSON logging.

---

## 8. Requirements Traceability Matrix (RTM)

| Requirement ID | Sprint | Component | Implementation File | Verification Test Case |
| :--- | :--- | :--- | :--- | :--- |
| **FR-AUTH-01** | Sprint 2 | API Gateway | `services/api-gateway/src/routes/auth.ts` | `Unit: Strict Input Format & Validation Rules` |
| **FR-AUTH-04** | Sprint 2 | API Gateway | `services/api-gateway/src/services/email.ts`| `Unit: Brute-Force Defense: 3-Attempt Maximum Lockout` |
| **FR-SRCH-01** | Sprint 4 | AI Engine | `services/ai-agent-engine/main.py` | `Unit: Geospatial Haversine Proximity Calculation` |
| **FR-SRCH-02** | Sprint 4 | AI Engine | `services/ai-agent-engine/main.py` | `Unit: Cross-Domain Multi-Category Discovery` |
| **FR-BOOK-01** | Sprint 3 | API Gateway | `services/api-gateway/src/index.ts` | `Unit: Redis NX Atomic Slot Reservation` |
| **FR-BOOK-03** | Sprint 3 | API Gateway | `services/api-gateway/src/index.ts` | `Unit: Dynamic NPCI-Compliant UPI QR Intent Generation` |
| **NFR-SEC-02** | Sprint 7 | Database | `packages/database-schemas/` | `Security Blackbox: SQL Injection Resistance` |
| **NFR-REL-02** | Sprint 7 | Gateway DB | `services/api-gateway/src/db/resilientPool.ts`| `Unit: Strict Customer DB vs Merchant DB Isolation` |

---

## 9. Conclusion & Project Sign-Off

StreetVerse represents a modern, production-grade implementation of hyperlocal retail discovery and service booking. The decoupling of customer and vendor datasets, combined with sub-second geospatial search and resilient fallback architectures, fulfills all academic and enterprise criteria set forth for the Capstone Project (Group P76, MIT-WPU).

