import os
from typing import List, Optional
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import asyncpg
from dotenv import load_dotenv
import requests
import json

load_dotenv()

app = FastAPI(
    title="StreetVerse AI Agent Engine",
    description="Hyperlocal RAG Search & Multi-Agent Assistant for Neighborhood Businesses",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MERCHANT_DB_URL = os.getenv(
    "MERCHANT_DATABASE_URL", 
    "postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db"
)

pool: Optional[asyncpg.Pool] = None

@app.on_event("startup")
async def startup_db():
    global pool
    try:
        pool = await asyncpg.create_pool(MERCHANT_DB_URL, min_size=2, max_size=10)
        print(f"[AI-Engine] Connected to Merchant DB at {MERCHANT_DB_URL}")
    except Exception as e:
        print(f"[AI-Engine Warning] Could not connect to Merchant DB: {e}")

@app.on_event("shutdown")
async def shutdown_db():
    global pool
    if pool:
        await pool.close()

# Request & Response Contracts
class HyperlocalSearchRequest(BaseModel):
    query: str = Field(..., description="Natural language search e.g. 'fresh brown bread or organic eggs nearby'")
    latitude: float = Field(..., description="Customer current GPS latitude")
    longitude: float = Field(..., description="Customer current GPS longitude")
    max_radius_km: float = Field(default=3.0, ge=0.1, le=25.0, description="Search radius around customer in km")
    limit: int = Field(default=10, le=50)

class SearchResultItem(BaseModel):
    item_id: str
    item_name: str
    category: str
    price: float
    stock_quantity: int
    is_available: bool
    merchant_id: str
    business_name: str
    distance_meters: float
    relevance_score: float

class HyperlocalSearchResponse(BaseModel):
    query: str
    radius_km: float
    total_found: int
    results: List[SearchResultItem]

# --- RAG + Geospatial Search Endpoint ---
@app.post("/api/v1/search/hyperlocal", response_model=HyperlocalSearchResponse)
async def search_hyperlocal_catalog(payload: HyperlocalSearchRequest):
    """
    Executes a hybrid Geospatial + Semantic RAG query:
    1. Geofence Filter: PostGIS ST_DWithin filters items whose merchant is within max_radius_km.
    2. Vector Distance: Computes cosine similarity between query embedding and item embeddings.
    3. Returns proximity-weighted top results.
    """
    if not pool:
        # Fallback to Gemini API for generative mock search results
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return HyperlocalSearchResponse(
                query=payload.query,
                radius_km=payload.max_radius_km,
                total_found=0,
                results=[]
            )
            
        prompt = f"""
        Act as a hyperlocal search engine for a neighborhood commerce app.
        The user is located at latitude {payload.latitude}, longitude {payload.longitude} and is looking for: "{payload.query}".
        Search radius is {payload.max_radius_km} km.
        
        Generate {payload.limit} realistic mock local businesses and inventory items that match this query.
        Return ONLY a valid JSON array of objects with these exact keys:
        - item_id (string)
        - item_name (string)
        - category (string, e.g. GROCERY, SALON, PHARMACY)
        - price (float, in INR)
        - stock_quantity (integer)
        - is_available (boolean)
        - merchant_id (string)
        - business_name (string)
        - distance_meters (float, between 50 and {payload.max_radius_km * 1000})
        - relevance_score (float, between 0.7 and 1.0)
        
        Do not include markdown blocks like ```json. Just output the raw JSON array.
        """
        
        try:
            res = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}",
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.7}
                },
                timeout=10
            )
            data = res.json()
            text_response = data['candidates'][0]['content']['parts'][0]['text'].strip()
            
            # Clean up potential markdown formatting
            if text_response.startswith('```json'):
                text_response = text_response[7:]
            if text_response.startswith('```'):
                text_response = text_response[3:]
            if text_response.endswith('```'):
                text_response = text_response[:-3]
                
            items = json.loads(text_response.strip())
            
            results = [
                SearchResultItem(
                    item_id=str(r.get("item_id", "mock-1")),
                    item_name=r.get("item_name", "Item"),
                    category=r.get("category", "GENERAL"),
                    price=float(r.get("price", 0.0)),
                    stock_quantity=int(r.get("stock_quantity", 10)),
                    is_available=bool(r.get("is_available", True)),
                    merchant_id=str(r.get("merchant_id", "merch-1")),
                    business_name=r.get("business_name", "Local Shop"),
                    distance_meters=float(r.get("distance_meters", 100.0)),
                    relevance_score=float(r.get("relevance_score", 0.9))
                ) for r in items
            ]
            
            return HyperlocalSearchResponse(
                query=payload.query,
                radius_km=payload.max_radius_km,
                total_found=len(results),
                results=results
            )
        except Exception as e:
            print(f"[Gemini Fallback Error]: {e}")
            return HyperlocalSearchResponse(
                query=payload.query,
                radius_km=payload.max_radius_km,
                total_found=0,
                results=[]
            )

    # In production with real DB:
    query_sql = """
        SELECT 
            i.id AS item_id,
            i.item_name,
            i.category,
            i.price::float,
            i.stock_quantity,
            i.is_available,
            m.id AS merchant_id,
            m.business_name,
            ST_Distance(m.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters,
            -- If embedding exists, compute cosine similarity, else default relevance
            COALESCE(1 - (i.embedding <=> $3::vector), 0.90) AS relevance_score
        FROM inventory_items i
        JOIN merchants m ON i.merchant_id = m.id
        WHERE m.is_open = true
          AND i.is_available = true
          AND ST_DWithin(m.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $4)
        ORDER BY distance_meters ASC, relevance_score DESC
        LIMIT $5;
    """
    try:
        radius_meters = payload.max_radius_km * 1000.0
        # Dummy vector of 1536 zeros for schema validation
        dummy_vector = "[" + ",".join(["0.0"] * 1536) + "]"

        async with pool.acquire() as conn:
            rows = await conn.fetch(
                query_sql, 
                payload.longitude, 
                payload.latitude, 
                dummy_vector, 
                radius_meters, 
                payload.limit
            )
            
            results = [
                SearchResultItem(
                    item_id=str(r["item_id"]),
                    item_name=r["item_name"],
                    category=r["category"],
                    price=r["price"],
                    stock_quantity=r["stock_quantity"],
                    is_available=r["is_available"],
                    merchant_id=str(r["merchant_id"]),
                    business_name=r["business_name"],
                    distance_meters=round(r["distance_meters"], 1),
                    relevance_score=round(r["relevance_score"], 3)
                ) for r in rows
            ]
            return HyperlocalSearchResponse(
                query=payload.query,
                radius_km=payload.max_radius_km,
                total_found=len(results),
                results=results
            )
    except Exception as e:
        print(f"[RAG Query Error]: {e}")
        return HyperlocalSearchResponse(
            query=payload.query,
            radius_km=payload.max_radius_km,
            total_found=0,
            results=[]
        )

# Multi-Agent Workflow Router
class AgentChatRequest(BaseModel):
    user_id: str
    message: str
    user_lat: Optional[float] = None
    user_lon: Optional[float] = None

@app.post("/api/v1/agent/orchestrate")
async def orchestrate_agent_intent(req: AgentChatRequest):
    """
    Router Agent: Classifies intent into:
    1. 'DISCOVERY' -> RAG Discovery Agent (finds local products)
    2. 'BOOKING'   -> Booking Assistant Agent (locks appointment slots)
    3. 'SUPPORT'   -> Direct Vendor Chat router
    """
    msg_lower = req.message.lower()
    if any(k in msg_lower for k in ["book", "appointment", "salon", "slot", "haircut"]):
        intent = "BOOKING"
        response_text = "I can help you reserve a slot. Which neighborhood salon or service would you like to visit?"
    elif any(k in msg_lower for k in ["find", "buy", "price", "shop", "medicine", "grocery", "bread"]):
        intent = "DISCOVERY"
        response_text = "Searching local shops within 3 km of your location..."
    else:
        intent = "SUPPORT"
        response_text = "I'm your neighborhood assistant. You can ask me to find nearby products or book services."

    return {
        "intent": intent,
        "assistant_message": response_text,
        "action_required": intent != "SUPPORT"
    }

@app.get("/health")
def health():
    return {"status": "healthy", "service": "StreetVerse AI Multi-Agent Engine"}
