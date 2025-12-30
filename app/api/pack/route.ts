import archiver from "archiver";
import { PassThrough } from "stream";
import {
  downloadFilingHtml,
  filingArchiveUrl,
  getCikForTicker,
  getRecentFilings,
  pickFilingsPack,
} from "@/lib/sec";

export const runtime = "nodejs";

function safeName(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
    const daysBack = Number(searchParams.get("daysBack") || "365");

    console.log("SEC_USER_AGENT env var:", process.env.SEC_USER_AGENT);

    if (!ticker) {
      return new Response("Missing ticker", { status: 400 });
    }
    if (!process.env.SEC_USER_AGENT) {
      return new Response("Missing SEC_USER_AGENT in .env.local", {
        status: 500,
      });
    }

    const cik10 = await getCikForTicker(ticker);
    const filings = await getRecentFilings(cik10);
    const selected = pickFilingsPack(filings, daysBack);

    if (selected.length === 0) {
      return new Response("No filings found for pack selection.", {
        status: 404,
      });
    }

    // Create a streaming ZIP
    const pass = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      pass.destroy(err);
    });

    archive.pipe(pass);

    // Add a manifest for clarity
    const manifestLines = [
      `Ticker: ${ticker}`,
      `CIK: ${cik10}`,
      `DaysBack(8-K & Form4): ${daysBack}`,
      "",
      "Included filings:",
      ...selected.map(
        (f) =>
          `${f.filingDate} | ${f.form} | ${f.accessionNumber} | ${f.primaryDocument}`
      ),
      "",
    ];
    archive.append(manifestLines.join("\n"), { name: "MANIFEST.txt" });

    // Download and append each filing
    // Keep concurrency low to respect SEC load.
    for (const f of selected) {
      const url = filingArchiveUrl(cik10, f);
      const html = await downloadFilingHtml(url);

      const fname = safeName(
        `${f.filingDate}__${f.form}__${f.accessionNumber}__${f.primaryDocument}`
      );
      archive.append(html, { name: `filings/${fname}` });
    }

    await archive.finalize();

    return new Response(pass as any, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ticker}_sec_pack.zip"`,
      },
    });
  } catch (err: any) {
    const msg = err?.message || "Unknown error";
    return new Response(`Error: ${msg}`, { status: 500 });
  }
}
