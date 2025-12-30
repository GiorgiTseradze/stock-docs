"use client";

import { useState } from "react";

export default function HomePage() {
  const [ticker, setTicker] = useState("CTM");
  const [daysBack, setDaysBack] = useState(365);

  const downloadZip = () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    const url = `/api/pack?ticker=${encodeURIComponent(
      t
    )}&daysBack=${daysBack}`;
    window.location.href = url; // triggers file download
  };

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>
        SEC EDGAR Filing Packager
      </h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>
        Downloads key filings for a ticker and bundles them into a ZIP.
      </p>

      <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Ticker</span>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="CTM"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Days back for 8-K + Form 4</span>
          <input
            type="number"
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value))}
            min={30}
            max={730}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
          />
          <small style={{ opacity: 0.75 }}>
            Default 365 (roughly last 12 months).
          </small>
        </label>

        <button
          onClick={downloadZip}
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Download ZIP
        </button>

        <div style={{ marginTop: 16, opacity: 0.85 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Included automatically:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Latest 10-K</li>
            <li>Latest two 10-Q</li>
            <li>8-K filings within days-back window</li>
            <li>Latest S-3 / S-3/A</li>
            <li>Latest DEF 14A</li>
            <li>Form 4 filings within days-back window</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
