export type Filing = {
  form: string;
  accessionNumber: string;
  filingDate: string; // YYYY-MM-DD
  primaryDocument: string;
};

const SEC_HEADERS = {
  "User-Agent":
    process.env.SEC_USER_AGENT || "SEC-Packager (missing SEC_USER_AGENT)",
  "Accept-Encoding": "gzip, deflate",
  Host: "www.sec.gov",
};

function assertEnv() {
  if (!process.env.SEC_USER_AGENT) {
    throw new Error("Missing SEC_USER_AGENT in .env.local (required by SEC).");
  }
}

export async function getCikForTicker(ticker: string): Promise<string> {
  assertEnv();
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: SEC_HEADERS,
    cache: "no-store",
  });
  if (!res.ok)
    throw new Error(`Failed to fetch company_tickers.json: ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;

  const t = ticker.toUpperCase();
  const entry = Object.values(data).find((x) => x.ticker.toUpperCase() === t);
  if (!entry) throw new Error(`Ticker not found in SEC mapping: ${ticker}`);

  // Pad to 10 digits for submissions API
  return String(entry.cik_str).padStart(10, "0");
}

export async function getRecentFilings(cik10: string): Promise<Filing[]> {
  assertEnv();
  const url = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const res = await fetch(url, { headers: SEC_HEADERS, cache: "no-store" });
  if (!res.ok)
    throw new Error(`Failed to fetch submissions JSON: ${res.status}`);

  const json = await res.json();
  const recent = json?.filings?.recent;
  if (!recent) return [];

  const forms: string[] = recent.form || [];
  const accession: string[] = recent.accessionNumber || [];
  const dates: string[] = recent.filingDate || [];
  const docs: string[] = recent.primaryDocument || [];

  const out: Filing[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (!forms[i] || !accession[i] || !dates[i] || !docs[i]) continue;
    out.push({
      form: forms[i],
      accessionNumber: accession[i],
      filingDate: dates[i],
      primaryDocument: docs[i],
    });
  }

  // newest first
  out.sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1));
  return out;
}

export function pickFilingsPack(filings: Filing[], daysBack: number) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const withinDays = (f: Filing) => new Date(f.filingDate) >= cutoff;

  const latest10k = filings.find((f) => f.form === "10-K");
  const latestTwo10q = filings.filter((f) => f.form === "10-Q").slice(0, 2);

  const last8k = filings.filter((f) => f.form === "8-K" && withinDays(f));

  // S-3 can be S-3, S-3/A, sometimes other variants; we take most recent match
  const latestS3 = filings.find((f) => f.form === "S-3" || f.form === "S-3/A");

  const latestDef14a = filings.find((f) => f.form === "DEF 14A");

  const lastForm4 = filings.filter((f) => f.form === "4" && withinDays(f));

  const selected: Filing[] = [
    ...(latest10k ? [latest10k] : []),
    ...latestTwo10q,
    ...last8k,
    ...(latestS3 ? [latestS3] : []),
    ...(latestDef14a ? [latestDef14a] : []),
    ...lastForm4,
  ];

  // De-dupe by accession
  const seen = new Set<string>();
  return selected.filter((f) => {
    if (seen.has(f.accessionNumber)) return false;
    seen.add(f.accessionNumber);
    return true;
  });
}

export function filingArchiveUrl(cik10: string, filing: Filing) {
  // Archives path uses CIK without leading zeros
  const cikNoLeading = String(parseInt(cik10, 10));
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionNoDashes}/${filing.primaryDocument}`;
}

export async function downloadFilingHtml(url: string): Promise<Buffer> {
  assertEnv();
  const res = await fetch(url, { headers: SEC_HEADERS, cache: "no-store" });
  if (!res.ok)
    throw new Error(`Failed to download filing doc: ${res.status} ${url}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}
