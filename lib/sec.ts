export type Filing = {
  form: string;
  accessionNumber: string;
  filingDate: string; // YYYY-MM-DD
  primaryDocument: string;
};

export type ExhibitDoc = {
  seq: string;
  description: string;
  type: string; // e.g. "EX-10.1"
  filename: string; // e.g. "ex10_1.htm"
  sizeText?: string; // e.g. "2 MB"
};

const SEC_HEADERS: Record<string, string> = {
  "User-Agent":
    process.env.SEC_USER_AGENT || "SEC-Packager (missing SEC_USER_AGENT)",
  "Accept-Encoding": "gzip, deflate",
};

function assertEnv() {
  if (!process.env.SEC_USER_AGENT) {
    throw new Error("Missing SEC_USER_AGENT in .env.local (required by SEC).");
  }
}

export const normForm = (form: string) => (form || "").trim().toUpperCase();

export const isS3 = (form: string) => {
  const f = normForm(form);
  return f === "S-3" || f === "S-3/A" || f === "S-3MEF" || f === "S-3ASR";
};

export const isProxy = (form: string) => {
  const f = normForm(form);
  return (
    f === "DEF 14A" || f === "DEFA14A" || f === "DEF 14C" || f === "PRE 14C"
  );
};

export const isProspectus = (form: string) => {
  const f = normForm(form);
  return (
    f.startsWith("424B") || f === "424B5" || f === "424B3" || f === "424B2"
  );
};

type SubmissionsRecent = {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  primaryDocument: string[];
};

type SubmissionsFileEntry = {
  name: string; // e.g., "CIK0001234567-2022-01-01.json"
  filingCount: number;
  filingFrom: string;
  filingTo: string;
};

type SubmissionsJson = {
  cik?: string;
  filings?: {
    recent?: SubmissionsRecent;
    files?: SubmissionsFileEntry[];
  };
};

/**
 * Polite fetch wrapper with retry logic for 429 and 5xx.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3
): Promise<Response> {
  assertEnv();
  const opts = { ...options, headers: { ...SEC_HEADERS, ...options.headers } };

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : 1000 * Math.pow(2, i);
        console.log(`[SEC] Rate limited (429) on ${url}. Retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        const delay = 1000 * Math.pow(2, i);
        console.log(
          `[SEC] Server error ${res.status} on ${url}. Retry in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = 1000 * Math.pow(2, i);
      console.log(`[SEC] Network error on ${url}. Retry in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

// In-memory cache for tickers mapping
let cachedTickers: Record<
  string,
  { cik_str: number; ticker: string; title: string }
> | null = null;
let lastTickerFetch = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCikForTicker(ticker: string): Promise<string> {
  const now = Date.now();
  if (!cachedTickers || now - lastTickerFetch >= CACHE_TTL_MS) {
    const res = await fetchWithRetry(
      "https://www.sec.gov/files/company_tickers.json",
      {
        cache: "no-store",
      }
    );
    if (!res.ok)
      throw new Error(`Failed to fetch company_tickers.json: ${res.status}`);
    cachedTickers = (await res.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    lastTickerFetch = now;
  }

  const t = ticker.toUpperCase();
  const entry = Object.values(cachedTickers!).find(
    (x) => x.ticker.toUpperCase() === t
  );
  if (!entry) throw new Error(`Ticker not found in SEC mapping: ${ticker}`);
  return String(entry.cik_str).padStart(10, "0");
}

function toFilingsFromRecent(recent?: SubmissionsRecent): Filing[] {
  if (!recent) return [];
  const forms = recent.form || [];
  const accession = recent.accessionNumber || [];
  const dates = recent.filingDate || [];
  const docs = recent.primaryDocument || [];

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
  return out;
}

export async function getRecentFilings(cik10: string): Promise<Filing[]> {
  const url = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const res = await fetchWithRetry(url, { cache: "no-store" });
  if (!res.ok)
    throw new Error(`Failed to fetch submissions JSON: ${res.status}`);

  const json = (await res.json()) as SubmissionsJson;
  const out = toFilingsFromRecent(json?.filings?.recent);
  out.sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1));
  return out;
}

/**
 * OPTION B: Get *ALL* filings by merging:
 * - filings.recent
 * - every filings.files[].name JSON (older ranges)
 *
 * This closes the main gap where older S-3/424B* are not in "recent".
 */
export async function getAllFilingsOptionB(cik10: string): Promise<Filing[]> {
  const baseUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const res = await fetchWithRetry(baseUrl, { cache: "no-store" });
  if (!res.ok)
    throw new Error(`Failed to fetch submissions JSON: ${res.status}`);
  const root = (await res.json()) as SubmissionsJson;

  const merged: Filing[] = [];

  // 1) recent
  merged.push(...toFilingsFromRecent(root?.filings?.recent));

  // 2) older index JSONs
  const files = root?.filings?.files || [];
  for (const f of files) {
    if (!f?.name) continue;
    const url = `https://data.sec.gov/submissions/${f.name}`;
    const r = await fetchWithRetry(url, { cache: "no-store" });
    if (!r.ok) {
      console.log(`[SEC] Failed older filings index ${f.name}: ${r.status}`);
      continue;
    }
    const j = (await r.json()) as SubmissionsJson;
    merged.push(...toFilingsFromRecent(j?.filings?.recent));
  }

  // Dedup by accession number
  const seen = new Set<string>();
  const uniq = merged.filter((x) => {
    if (seen.has(x.accessionNumber)) return false;
    seen.add(x.accessionNumber);
    return true;
  });

  uniq.sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1));
  return uniq;
}

export function pickFilingsPack(
  filings: Filing[],
  daysBack: number,
  asOf?: string
) {
  return pickFilingsPackWithReasons(filings, daysBack, asOf).map(
    (x) => x.filing
  );
}

export type SelectedFiling = { filing: Filing; reason: string };

export function pickFilingsPackWithReasons(
  filings: Filing[],
  daysBack: number,
  asOf?: string
): SelectedFiling[] {
  // If asOf is provided, we simulate being at that date (inclusive).
  // If not, we use now.
  const asOfDate = asOf ? new Date(asOf) : new Date();
  const cutoff = new Date(asOfDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

  // Helper: Filing is on or before asOfDate
  const onOrBefore = (f: Filing) => {
    const d = new Date(f.filingDate);
    // If we just use <= comparison on Dates, ensure asOf covers the full day if it's just a date string.
    // If asOf is "2024-12-01", new Date is 2024-12-01T00:00:00Z.
    // A filing on "2024-12-01" is also 2024-12-01T00:00:00Z. So <= works.
    return d <= asOfDate;
  };

  // Helper: Filing is within [cutoff, asOf]
  const withinWindow = (f: Filing) => {
    const d = new Date(f.filingDate);
    return d >= cutoff && d <= asOfDate;
  };

  // 1. Filter filings to only those visible "as of" the date
  const eligible = filings.filter(onOrBefore);

  const sel: SelectedFiling[] = [];

  // Core pack
  const latest10k = eligible.find((f) => normForm(f.form) === "10-K");
  if (latest10k) sel.push({ filing: latest10k, reason: "latest 10-K" });

  eligible
    .filter((f) => normForm(f.form) === "10-Q")
    .slice(0, 2)
    .forEach((f, i) =>
      sel.push({ filing: f, reason: `10-Q (top 2) #${i + 1}` })
    );

  // Time-windowed (8-K)
  eligible
    .filter((f) => normForm(f.form) === "8-K" && withinWindow(f))
    .forEach((f) => sel.push({ filing: f, reason: `8-K within ${daysBack}d` }));

  // Dilution / registration
  const latestS3 = eligible.find((f) => isS3(f.form));
  if (latestS3) sel.push({ filing: latestS3, reason: "latest S-3/S-3A" });

  const latestProspectus = eligible.find((f) => isProspectus(f.form));
  if (latestProspectus)
    sel.push({ filing: latestProspectus, reason: "latest 424B*" });

  const latestEffect = eligible.find((f) => normForm(f.form) === "EFFECT");
  if (latestEffect) sel.push({ filing: latestEffect, reason: "latest EFFECT" });

  // Governance / comp
  const latestProxy = eligible.find((f) => isProxy(f.form));
  if (latestProxy) sel.push({ filing: latestProxy, reason: "latest Proxy" });

  const latestS8 = eligible.find((f) => normForm(f.form) === "S-8");
  if (latestS8) sel.push({ filing: latestS8, reason: "latest S-8" });

  // Time-windowed (Form 4)
  eligible
    .filter((f) => normForm(f.form) === "4" && withinWindow(f))
    .forEach((f) =>
      sel.push({ filing: f, reason: `Form 4 within ${daysBack}d` })
    );

  // Dedup by accession number
  const seen = new Set<string>();
  return sel.filter(({ filing }) => {
    if (seen.has(filing.accessionNumber)) return false;
    seen.add(filing.accessionNumber);
    return true;
  });
}

export function filingBasePath(cik10: string, filing: Filing) {
  const cikNoLeading = String(parseInt(cik10, 10));
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionNoDashes}`;
}

export function filingArchiveUrl(cik10: string, filing: Filing) {
  return `${filingBasePath(cik10, filing)}/${filing.primaryDocument}`;
}

export function filingIndexUrl(cik10: string, filing: Filing) {
  return `${filingBasePath(cik10, filing)}/${
    filing.accessionNumber
  }-index.html`;
}

export async function downloadAsBuffer(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to download: ${res.status} ${url}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * More robust index parsing:
 * - Tries summary="Document Format Files"
 * - Fallback: any table containing "Document Format Files"
 * - Extracts all rows with href + columns
 */
export async function getDocsFromIndexHtml(
  indexHtml: string
): Promise<ExhibitDoc[]> {
  const docs: ExhibitDoc[] = [];

  const summaryMatch = indexHtml.match(
    /<table[^>]*summary="Document Format Files"[\s\S]*?<\/table>/i
  );
  let contentToParse = summaryMatch?.[0] || "";

  if (!contentToParse) {
    const tableMatches = [
      ...indexHtml.matchAll(/<table[\s\S]*?<\/table>/gi),
    ].map((m) => m[0]);
    const candidate = tableMatches.find((t) =>
      /Document Format Files/i.test(t)
    );
    if (candidate) contentToParse = candidate;
  }

  if (!contentToParse) contentToParse = indexHtml;

  const rows = [...contentToParse.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(
    (m) => m[0]
  );

  for (const row of rows) {
    const hrefMatch = row.match(/href="([^"]+)"/i);
    const href = hrefMatch?.[1] || "";
    const filename = href.split("/").pop() || "";

    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
    );

    // Usually columns: Seq | Description | Document | Type | Size
    if (!filename || tds.length < 4) continue;

    const seq = tds[0] || "";
    const description = tds[1] || "";
    const type = tds[3] || "";
    const sizeText = tds[4] || "";

    if (!type || type === "Type") continue;

    docs.push({ seq, description, type, filename, sizeText });
  }

  return docs;
}

/**
 * Expanded "high signal" for financing/dilution detection:
 * - EX-10: material contracts
 * - EX-4: instruments defining rights (warrants, notes)
 * - EX-99: PRs / decks
 * - EX-1 / EX-2 / EX-3 / EX-16: classic
 * - EX-5: legal opinion (often tied to registration)
 * - EX-23 / EX-24: consent / POA in offerings
 */
export function isHighSignalExhibitType(type: string) {
  const t = type.trim().toUpperCase();
  return /^EX-(10|4|99|2|16|3|1|5|23|24)\b/i.test(t);
}

export function isJunkType(type: string) {
  return /^EX-(101|104)\b/i.test(type.trim());
}

export function parseSize(sizeText: string): number {
  if (!sizeText) return 0;
  const s = sizeText.trim().toUpperCase().replace(/,/g, "");
  const num = parseFloat(s);
  if (Number.isNaN(num)) return 0;

  if (s.includes("MB")) return num * 1024 * 1024;
  if (s.includes("KB")) return num * 1024;
  return num;
}

/**
 * CSV helper (safe quoting).
 */
export function toCsvLine(cells: Array<string | number>) {
  return cells
    .map((c) => {
      const v = String(c ?? "");
      const needsQuote = /[",\n]/.test(v);
      const escaped = v.replace(/"/g, '""');
      return needsQuote ? `"${escaped}"` : escaped;
    })
    .join(",");
}
