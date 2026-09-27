import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";

export interface UniverseConstituent {
  companyName: string;
  symbol: string;
  isin: string;
}

export async function loadNifty50(path: string): Promise<UniverseConstituent[]> {
  const csv = await readFile(path, "utf8");
  const rows = parse(csv, {
    bom: true,
    columns: true,
    comment: "#",
    skip_empty_lines: true
  }) as Array<Record<string, string>>;
  return rows.map((row) => ({
    companyName: row["Company Name"],
    symbol: row.Symbol,
    isin: row["ISIN Code"]
  }));
}
