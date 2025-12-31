"use client";

import { useState } from "react";

export default function HomePage() {
  const [ticker, setTicker] = useState("CTM");
  const [daysBack, setDaysBack] = useState(365);
  const [asOf, setAsOf] = useState("");

  const [includeExhibits, setIncludeExhibits] = useState(true);
  const [maxEx, setMaxEx] = useState(25);
  const [maxMb, setMaxMb] = useState(75);

  // Deep pull disables caps (more complete, bigger ZIP)
  const [deepPull, setDeepPull] = useState(false);

  // Option B: fetch ALL filings using SEC submissions "files" index JSONs
  const [allFilings, setAllFilings] = useState(true);

  const buildUrl = () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return null;

    const qs = new URLSearchParams();
    qs.set("ticker", t);
    qs.set("daysBack", String(daysBack));
    if (asOf) qs.set("asOf", asOf);
    qs.set("exhibits", includeExhibits ? "1" : "0");
    qs.set("maxEx", String(maxEx));
    qs.set("maxMb", String(maxMb));
    qs.set("deep", deepPull ? "1" : "0");
    qs.set("all", allFilings ? "1" : "0");

    return `/api/pack?${qs.toString()}`;
  };

  const downloadZip = () => {
    const url = buildUrl();
    if (!url) return;
    window.location.href = url;
  };

  const downloadDeepZip = () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    const qs = new URLSearchParams();
    qs.set("ticker", t);
    qs.set("daysBack", String(daysBack));
    if (asOf) qs.set("asOf", asOf);
    qs.set("exhibits", "1");
    qs.set("deep", "1");
    qs.set("all", allFilings ? "1" : "0");
    window.location.href = `/api/pack?${qs.toString()}`;
  };

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>
        SEC EDGAR Filing Packager
      </h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>
        Bundles key filings into a ZIP. Always includes each filing’s{" "}
        <code style={{ padding: "0 6px" }}>*-index.html</code> + transparent{" "}
        <strong>EXHIBITS_REPORT.txt</strong> +{" "}
        <strong>DOCS_INVENTORY.csv</strong>.
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

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>As-Of Date (Optional)</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
          />
          <small style={{ opacity: 0.75 }}>
            Simulate running this tool in the past (e.g., 2024-12-01). Leave
            blank for TODAY.
          </small>
        </label>

        <div
          style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
        >
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={allFilings}
              onChange={(e) => setAllFilings(e.target.checked)}
            />
            <span style={{ fontWeight: 800 }}>
              Option B: Use ALL filings (merge SEC submissions “files” index
              JSONs)
            </span>
          </label>
          <small style={{ opacity: 0.8, display: "block", marginTop: 6 }}>
            This prevents missing older S-3/S-3A/424B* that may not appear in
            filings.recent.
          </small>
        </div>

        <div
          style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
        >
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={includeExhibits}
              onChange={(e) => setIncludeExhibits(e.target.checked)}
            />
            <span style={{ fontWeight: 700 }}>
              Download high-signal exhibits (EX-10 / EX-4 / EX-99)
            </span>
            <span style={{ fontSize: "0.85em", opacity: 0.75, marginLeft: 4 }}>
              (+ EX-1, 2, 3, 5, 16, 23, 24)
            </span>
          </label>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>Max exhibits per filing</span>
              <input
                type="number"
                value={maxEx}
                onChange={(e) => setMaxEx(Number(e.target.value))}
                min={1}
                max={100}
                disabled={!includeExhibits || deepPull}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #ccc",
                  opacity: !includeExhibits || deepPull ? 0.6 : 1,
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>
                Max total exhibit size (MB)
              </span>
              <input
                type="number"
                value={maxMb}
                onChange={(e) => setMaxMb(Number(e.target.value))}
                min={5}
                max={500}
                disabled={!includeExhibits || deepPull}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #ccc",
                  opacity: !includeExhibits || deepPull ? 0.6 : 1,
                }}
              />
              <small style={{ opacity: 0.75 }}>
                Keeps ZIP AI-friendly. Default 75MB.
              </small>
            </label>

            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={deepPull}
                onChange={(e) => setDeepPull(e.target.checked)}
                disabled={!includeExhibits}
              />
              <span style={{ fontWeight: 700 }}>
                Deep Pull (disable caps; bigger ZIP)
              </span>
            </label>

            <small style={{ opacity: 0.8 }}>
              ZIP always includes indexes + a full inventory of what EDGAR
              offered and what was skipped.
            </small>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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

          <button
            onClick={downloadDeepZip}
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #111",
              background: "#fff",
              color: "#111",
              fontWeight: 700,
              cursor: "pointer",
            }}
            title="For serious deep-dives only"
          >
            Deep Pull ZIP (no caps)
          </button>
        </div>
      </div>
    </main>
  );
}
