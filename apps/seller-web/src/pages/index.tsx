import React, { useState } from 'react';
import Head from 'next/head';
import { 
  Store, 
  Package, 
  Calendar, 
  TrendingUp, 
  AlertTriangle, 
  Clock, 
  CheckCircle2, 
  Users,
  Bell
} from 'lucide-react';

export default function SellerDashboard() {
  const [activeTab, setActiveTab] = useState<'INVENTORY' | 'SLOTS' | 'INSIGHTS'>('INVENTORY');

  return (
    <div style={{ backgroundColor: '#FAF7F2', minHeight: '100vh', color: '#292524', fontFamily: 'Plus Jakarta Sans, sans-serif' }}>
      <Head>
        <title>StreetVerse Merchant Portal - Dashboard</title>
      </Head>

      {/* Header */}
      <header style={{ borderBottom: '1px solid #E7E5E4', backgroundColor: '#FFFDF9', padding: '1rem 2rem' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF' }}>
              <Store size={22} />
            </div>
            <div>
              <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>Green Valley Daily Needs</h1>
              <p style={{ fontSize: '0.75rem', color: '#78716C', margin: 0 }}>Merchant ID: M-KOTHRUD-04 • StreetVerse Merchant DB</p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span style={{ backgroundColor: '#ECFDF5', color: '#059669', padding: '0.35rem 0.8rem', borderRadius: 9999, fontSize: '0.8rem', fontWeight: 700 }}>
              ● Store Live on Hyperlocal Map
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main style={{ maxWidth: '1200px', margin: '2rem auto', padding: '0 1.5rem' }}>
        
        {/* Metric Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.25rem', marginBottom: '2rem' }}>
          <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 16, padding: '1.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#78716C' }}>Today's Hyperlocal Footfall</span>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '0.25rem' }}>142 Visits</div>
            <span style={{ fontSize: '0.75rem', color: '#059669', fontWeight: 600 }}>↑ 18% vs yesterday</span>
          </div>

          <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 16, padding: '1.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#78716C' }}>UPI Direct Sales (Settled)</span>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '0.25rem' }}>₹12,450</div>
            <span style={{ fontSize: '0.75rem', color: '#78716C' }}>Zero vendor commission</span>
          </div>

          <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 16, padding: '1.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#78716C' }}>Active Service Appointments</span>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '0.25rem' }}>8 Booked</div>
            <span style={{ fontSize: '0.75rem', color: '#D97706', fontWeight: 600 }}>2 slots locked (5-min holding)</span>
          </div>
        </div>

        {/* AI Agent Demand Prediction & Restocking Alert */}
        <div style={{ backgroundColor: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 16, padding: '1.25rem', marginBottom: '2rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <AlertTriangle size={24} color="#D97706" style={{ flexShrink: 0 }} />
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 800, color: '#92400E', margin: 0 }}>AI Restock Predictor Alert</h3>
            <p style={{ fontSize: '0.85rem', color: '#B45309', margin: '0.25rem 0 0' }}>
              Based on neighborhood RAG queries in the last 24h, <strong>Organic Brown Bread</strong> stock will deplete by 06:00 PM today. Recommended restock quantity: 25 units.
            </p>
          </div>
        </div>

        {/* Live Inventory & Slot Management Table */}
        <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 16, padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '1rem' }}>Live Catalog & Embeddings Status</h2>
          
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #E7E5E4', color: '#78716C' }}>
                <th style={{ padding: '0.75rem' }}>Item Name</th>
                <th style={{ padding: '0.75rem' }}>Category</th>
                <th style={{ padding: '0.75rem' }}>Price</th>
                <th style={{ padding: '0.75rem' }}>Stock</th>
                <th style={{ padding: '0.75rem' }}>Vector Embedding</th>
                <th style={{ padding: '0.75rem' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #F3ECE2' }}>
                <td style={{ padding: '0.75rem', fontWeight: 600 }}>Fresh Brown Bread</td>
                <td style={{ padding: '0.75rem' }}>GROCERY</td>
                <td style={{ padding: '0.75rem' }}>₹45</td>
                <td style={{ padding: '0.75rem', color: '#D97706', fontWeight: 700 }}>4 units left</td>
                <td style={{ padding: '0.75rem', color: '#059669', fontSize: '0.8rem' }}>✓ Synced (1536d)</td>
                <td style={{ padding: '0.75rem' }}><button style={{ padding: '0.3rem 0.7rem', borderRadius: 8, border: '1px solid #E7E5E4', cursor: 'pointer', background: '#FFF' }}>Restock</button></td>
              </tr>
              <tr style={{ borderBottom: '1px solid #F3ECE2' }}>
                <td style={{ padding: '0.75rem', fontWeight: 600 }}>Farm Fresh Eggs (Pack of 6)</td>
                <td style={{ padding: '0.75rem' }}>GROCERY</td>
                <td style={{ padding: '0.75rem' }}>₹60</td>
                <td style={{ padding: '0.75rem', color: '#059669', fontWeight: 700 }}>38 units</td>
                <td style={{ padding: '0.75rem', color: '#059669', fontSize: '0.8rem' }}>✓ Synced (1536d)</td>
                <td style={{ padding: '0.75rem' }}><button style={{ padding: '0.3rem 0.7rem', borderRadius: 8, border: '1px solid #E7E5E4', cursor: 'pointer', background: '#FFF' }}>Edit</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
