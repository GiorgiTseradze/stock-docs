import archiver from "archiver";
import { PassThrough } from "stream";
import {
  downloadAsBuffer,
  filingArchiveUrl,
  filingBasePath,
  filingIndexUrl,
  getCikForTicker,
  getDocsFromIndexHtml,
  getAllFilingsOptionB,
  getRecentFilings,
  isHighSignalExhibitType,
  isJunkType,
  parseSize,
  pickFilingsPackWithReasons,
  toCsvLine,
  type Filing,
  isS3,
  isProspectus,
  normForm,
} from "@/lib/sec";
import { getAiPrompt } from "@/lib/ai-prompt";

export const runtime = "nodejs";

function safeName(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseBool(v: string | null, fallback = false) {
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
    if (!ticker) return new Response("Missing ticker", { status: 400 });

    // Strict input validation (no silent clamps)
    const pDays = searchParams.get("daysBack");
    const pMaxEx = searchParams.get("maxEx");
    const pMaxMb = searchParams.get("maxMb");

    const daysBack = pDays ? Number(pDays) : 365;
    if (Number.isNaN(daysBack)) {
      return new Response("Invalid daysBack parameter (must be a number)", {
        status: 400,
      });
    }
    if (daysBack < 30 || daysBack > 730) {
      return new Response("daysBack out of range (30-730)", { status: 400 });
    }

    const maxEx = pMaxEx ? Number(pMaxEx) : 25;
    if (Number.isNaN(maxEx)) {
      return new Response("Invalid maxEx parameter (must be a number)", {
        status: 400,
      });
    }
    if (maxEx < 1 || maxEx > 100) {
      return new Response("maxEx out of range (1-100)", { status: 400 });
    }

    const maxMb = pMaxMb ? Number(pMaxMb) : 75;
    if (Number.isNaN(maxMb)) {
      return new Response("Invalid maxMb parameter (must be a number)", {
        status: 400,
      });
    }
    if (maxMb < 5 || maxMb > 500) {
      return new Response("maxMb out of range (5-500)", { status: 400 });
    }

    const includeExhibits = parseBool(searchParams.get("exhibits"), true);
    const deep = parseBool(searchParams.get("deep"), false);
    const asOf = searchParams.get("asOf");

    // Option B: ALL filings via submissions "files" index JSONs
    const all = parseBool(searchParams.get("all"), true);

    const maxTotalBytes = deep ? Number.POSITIVE_INFINITY : maxMb * 1024 * 1024;
    const maxPerFiling = deep ? Number.POSITIVE_INFINITY : maxEx;

    if (!process.env.SEC_USER_AGENT) {
      return new Response("Missing SEC_USER_AGENT in .env.local", {
        status: 500,
      });
    }

    const cik10 = await getCikForTicker(ticker);

    const filings = all
      ? await getAllFilingsOptionB(cik10)
      : await getRecentFilings(cik10);

    const selectedWithReasons = pickFilingsPackWithReasons(
      filings,
      daysBack,
      asOf || undefined
    );
    const selected = selectedWithReasons.map((x) => x.filing);
    const selectedReasons = new Map(
      selectedWithReasons.map((x) => [x.filing.accessionNumber, x.reason])
    );

    if (selected.length === 0) {
      return new Response("No filings found for pack selection.", {
        status: 404,
      });
    }

    const pass = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: Error) => pass.destroy(err));
    archive.pipe(pass);

    // --- REPORT GENERATION START ---

    // 1. FILINGS_REPORT.csv
    const filingsHeader = [
      "filingDate",
      "form",
      "accessionNumber",
      "primaryDocument",
      "status",
      "reason",
      "indexUrl",
    ].join(",");

    const filingsLines: string[] = [filingsHeader];

    for (const f of filings) {
      const isSel = selectedReasons.has(f.accessionNumber);
      filingsLines.push(
        toCsvLine([
          f.filingDate,
          f.form,
          f.accessionNumber,
          f.primaryDocument,
          isSel ? "SELECTED" : "NOT_SELECTED",
          isSel ? selectedReasons.get(f.accessionNumber)! : "",
          filingIndexUrl(cik10, f),
        ])
      );
    }
    archive.append(filingsLines.join("\n"), { name: "FILINGS_REPORT.csv" });

    // 2. FILINGS_MISSING.txt
    const has = (pred: (f: Filing) => boolean) => filings.some(pred);
    const missing: string[] = [];

    if (!has((f) => isS3(f.form))) missing.push("S-3 / S-3A: NOT FOUND");
    if (!has((f) => isProspectus(f.form))) missing.push("424B*: NOT FOUND");
    if (!has((f) => normForm(f.form) === "EFFECT"))
      missing.push("EFFECT: NOT FOUND");

    const form4Count = filings.filter((f) => normForm(f.form) === "4").length;
    missing.push(`Form 4 total found in merged filings: ${form4Count}`);

    // Add explicit confirmations if found
    if (has((f) => isS3(f.form))) missing.push("S-3 / S-3A: FOUND");
    if (has((f) => isProspectus(f.form))) missing.push("424B*: FOUND");
    if (has((f) => normForm(f.form) === "EFFECT"))
      missing.push("EFFECT: FOUND");

    archive.append(missing.join("\n") + "\n", { name: "FILINGS_MISSING.txt" });

    // --- REPORT GENERATION END ---

    // Reports to prevent “silent skipping”
    const skippedByCap: string[] = [];
    const skippedByFilter: string[] = [];
    const indexNotFound: string[] = [];
    const downloadedExhibits: string[] = [];
    let exhibitsBytesUsed = 0;

    // Docs inventory (complete “everything EDGAR offered for selected filings”)
    const inventoryHeader = [
      "filingDate",
      "form",
      "accessionNumber",
      "docType",
      "filename",
      "sizeText",
      "description",
      "status",
      "reason",
      "url",
    ].join(",");
    const inventoryLines: string[] = [inventoryHeader];

    // Count forms for manifest
    const counts = selected.reduce((acc, f) => {
      const ft = f.form.toUpperCase();
      acc[ft] = (acc[ft] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const manifestLines: string[] = [
      `Ticker: ${ticker}`,
      `CIK: ${cik10}`,
      `AsOf: ${asOf || "NOW"}`,
      `Mode: ${
        all
          ? "OPTION B (ALL filings via submissions files index)"
          : "RECENT only"
      }`,
      `DaysBack(8-K & Form4): ${daysBack}`,
      `Include Exhibits: ${includeExhibits ? "YES" : "NO"}`,
      deep
        ? `Deep Pull: YES (caps disabled)`
        : `Caps: maxExPerFiling=${maxPerFiling}, maxTotalExhibits=${maxMb}MB`,
      "",
      "Selected Form Counts:",
      ...Object.entries(counts).map(([form, count]) => `- ${form}: ${count}`),
      "",
      "Included filings:",
      ...selected.map(
        (f) =>
          `${f.filingDate} | ${f.form} | ${f.accessionNumber} | ${f.primaryDocument}`
      ),
      "",
      "Notes:",
      "- ALWAYS includes each filing’s *-index.html (exhibit list).",
      "- DOCS_INVENTORY.csv lists EVERY document row for each selected filing index, with DOWNLOADED/SKIPPED reasons.",
      "- FILINGS_REPORT.csv lists EVERY filing found in the scan range (SELECTED vs NOT_SELECTED).",
      "- FILINGS_MISSING.txt confirms existence/non-existence of critical forms (S-3, 424B*, EFFECT).",
      "- Deep Pull downloads ALL non-junk docs from each selected filing index (still skips EX-101/EX-104).",
      "",
    ];
    archive.append(manifestLines.join("\n"), { name: "MANIFEST.txt" });

    // Add dynamic AI prompt
    const promptText = getAiPrompt(asOf || "");
    archive.append(promptText, { name: "AI_EVALUATION_CHECKLIST.md" });

    for (const f of selected) {
      // 1) Main filing doc
      const mainUrl = filingArchiveUrl(cik10, f);
      const mainBuf = await downloadAsBuffer(mainUrl);
      const mainName = safeName(
        `${f.filingDate}__${f.form}__${f.accessionNumber}__${f.primaryDocument}`
      );
      archive.append(mainBuf, { name: `filings/${mainName}` });

      // 2) Always include the filing index page
      const idxUrl = filingIndexUrl(cik10, f);
      let idxBuf: Buffer | null = null;
      try {
        idxBuf = await downloadAsBuffer(idxUrl);
        const idxName = safeName(
          `${f.filingDate}__${f.form}__${f.accessionNumber}__INDEX.html`
        );
        archive.append(idxBuf, { name: `indexes/${idxName}` });
      } catch {
        indexNotFound.push(`${f.filingDate} ${f.form} ${f.accessionNumber}`);
        // inventory row for missing index
        inventoryLines.push(
          toCsvLine([
            f.filingDate,
            f.form,
            f.accessionNumber,
            "",
            "",
            "",
            "",
            "SKIPPED",
            "index not found (cannot enumerate docs)",
            idxUrl,
          ])
        );
        continue;
      }

      // Enumerate docs from index and log inventory
      const idxHtml = idxBuf.toString("utf8");
      const docs = await getDocsFromIndexHtml(idxHtml);

      const base = filingBasePath(cik10, f);

      // Inventory: if table parse fails, still record that
      if (docs.length === 0) {
        inventoryLines.push(
          toCsvLine([
            f.filingDate,
            f.form,
            f.accessionNumber,
            "",
            "",
            "",
            "",
            "SKIPPED",
            "index parsed but no docs rows found (parser/table variance)",
            idxUrl,
          ])
        );
      }

      if (!includeExhibits) {
        // still inventory everything as SKIPPED (exhibits disabled)
        for (const d of docs) {
          const url = `${base}/${d.filename}`;
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "exhibits disabled",
              url,
            ])
          );
        }
        continue;
      }

      // Sort docs:
      // 1) High signal first
      // 2) Smaller size first
      const scored = docs
        .map((d) => ({
          d,
          score: isHighSignalExhibitType(d.type)
            ? 3
            : isJunkType(d.type)
            ? 0
            : 1,
          sizeBytes: parseSize(d.sizeText || ""),
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.sizeBytes - b.sizeBytes;
        });

      let downloadedCount = 0;

      for (const { d } of scored) {
        if (!d.filename || !d.type) continue;

        const exUrl = `${base}/${d.filename}`;

        // Always skip junk (even deep)
        if (isJunkType(d.type)) {
          skippedByFilter.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (XBRL noise)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "junk (XBRL noise)",
              exUrl,
            ])
          );
          continue;
        }

        // Default behavior: only high-signal unless deep
        if (!deep && !isHighSignalExhibitType(d.type)) {
          skippedByFilter.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (not high-signal)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "not high-signal (non-deep mode)",
              exUrl,
            ])
          );
          continue;
        }

        // Caps (non-deep)
        if (!deep && downloadedCount >= maxPerFiling) {
          skippedByCap.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (maxExPerFiling cap)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "cap: maxExPerFiling",
              exUrl,
            ])
          );
          continue;
        }

        if (!deep && exhibitsBytesUsed >= maxTotalBytes) {
          skippedByCap.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (maxTotalMB cap)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "cap: maxTotalMB",
              exUrl,
            ])
          );
          continue;
        }

        // Download
        let exBuf: Buffer;
        try {
          exBuf = await downloadAsBuffer(exUrl);
        } catch {
          skippedByFilter.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (download failed)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "download failed",
              exUrl,
            ])
          );
          continue;
        }

        if (!deep && exhibitsBytesUsed + exBuf.byteLength > maxTotalBytes) {
          skippedByCap.push(
            `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${
              d.filename
            } | ${d.sizeText || "N/A"} | ${
              d.description || "No Desc"
            } | skipped (would exceed maxTotalMB cap)`
          );
          inventoryLines.push(
            toCsvLine([
              f.filingDate,
              f.form,
              f.accessionNumber,
              d.type,
              d.filename,
              d.sizeText || "",
              d.description || "",
              "SKIPPED",
              "cap: would exceed maxTotalMB",
              exUrl,
            ])
          );
          continue;
        }

        exhibitsBytesUsed += exBuf.byteLength;
        downloadedCount += 1;
        downloadedExhibits.push(
          `${f.filingDate} ${f.form} ${f.accessionNumber} | ${d.type} | ${d.filename}`
        );

        const exName = safeName(
          `${f.filingDate}__${f.form}__${f.accessionNumber}__${d.type}__${d.filename}`
        );
        const folder = safeName(d.type.replace(/\./g, "_"));
        archive.append(exBuf, { name: `exhibits/${folder}/${exName}` });

        inventoryLines.push(
          toCsvLine([
            f.filingDate,
            f.form,
            f.accessionNumber,
            d.type,
            d.filename,
            d.sizeText || "",
            d.description || "",
            "DOWNLOADED",
            "",
            exUrl,
          ])
        );
      }
    }

    // Add inventory file
    archive.append(inventoryLines.join("\n"), { name: "DOCS_INVENTORY.csv" });

    // Add transparent reports so nothing is “silently missing”
    const reports: string[] = [];

    reports.push(`Downloaded exhibits total bytes: ${exhibitsBytesUsed}`);
    reports.push("");

    if (indexNotFound.length) {
      reports.push("INDEX NOT FOUND (could not enumerate exhibits):");
      reports.push(...indexNotFound.map((x) => `- ${x}`));
      reports.push("");
    }

    if (skippedByCap.length) {
      reports.push("EXHIBITS SKIPPED (CAPS):");
      reports.push(...skippedByCap.map((x) => `- ${x}`));
      reports.push("");
    }

    if (skippedByFilter.length) {
      reports.push("EXHIBITS SKIPPED (FILTER / OTHER):");
      reports.push(...skippedByFilter.map((x) => `- ${x}`));
      reports.push("");
    }

    if (!reports.length) reports.push("No exhibit reports.");

    archive.append(reports.join("\n"), { name: "EXHIBITS_REPORT.txt" });

    // Start finalization (do not await, to allow streaming)
    archive.finalize().catch((err) => {
      console.error("Archive finalize error:", err);
      pass.destroy(err);
    });

    return new Response(pass as unknown as Blob, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ticker}_sec_pack.zip"`,
      },
    });
  } catch (err: unknown) {
    const error = err as Error;
    const msg = error?.message || "Unknown error";
    return new Response(`Error: ${msg}`, { status: 500 });
  }
}
