import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {
  console,
  module: { exports: {} },
  exports: {},
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(readFileSync(join(root, file), "utf8"), sandbox, { filename: file });
}

load("orders/vendor/xlsx.full.min.js");
sandbox.XLSX = sandbox.exports;
load("orders/parse.js");
if (!sandbox.OrderFeed) {
  throw new Error("OrderFeed was not attached to the spreadsheet parser sandbox.");
}

const XLSX = sandbox.XLSX;
const { parseDocArrayBuffer, parseDocWorkbook } = sandbox.OrderFeed;
const COLUMNS = [
  "Delivery Date",
  "SE",
  "Customer",
  "AG Order Number",
  "Status",
  "Mdl Code",
  "Mdl Description",
  "Fuel",
  "Sale Type",
  "Latest IVSR Status",
];
const serial = Math.round((Date.UTC(2026, 9, 19) - Date.UTC(1899, 11, 30)) / 86400000);

function sampleBuffer() {
  const headers = ["Internal notes", ...COLUMNS, "Margin"];
  const dated = [
    "ignore me",
    serial,
    "A. Seller",
    "Jane Customer",
    "AG100",
    "In stock",
    "21EH",
    "118 Sport",
    "Petrol",
    "Retail",
    "Cleared",
    1500,
  ];
  const numbered = [
    "also ignore",
    "01/11/2026",
    "B. Seller",
    "North Ltd",
    44001234,
    "Sold",
    "11AB",
    "320d M Sport",
    "Diesel",
    "Fleet",
    "Pending",
    0,
  ];
  const blank = headers.map(() => "");
  blank[blank.length - 1] = "secret only";
  const sheet = XLSX.utils.aoa_to_sheet([["Weekly DOC"], headers, dated, blank, numbered]);
  const dateCell = XLSX.utils.encode_cell({ r: 2, c: 1 });
  sheet[dateCell] = { t: "n", v: serial, z: "dd/mm/yyyy" };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["not this"]]), "Summary");
  XLSX.utils.book_append_sheet(workbook, sheet, "DOC");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

const parsed = JSON.parse(JSON.stringify(parseDocArrayBuffer(sampleBuffer())));
assert.deepEqual(parsed.columns, COLUMNS);
assert.deepEqual(parsed.omitted, ["Internal notes", "Margin"]);
assert.equal(parsed.rows.length, 2);
assert.deepEqual(Object.keys(parsed.rows[0]), COLUMNS);
assert.equal(parsed.rows[0]["Delivery Date"], "19/10/2026");
assert.equal(parsed.rows[0].Customer, "Jane Customer");
assert.equal(parsed.rows[0]["AG Order Number"], "AG100");
assert.equal(parsed.rows[1]["AG Order Number"], "44001234");
assert.equal(parsed.rows[1]["Delivery Date"], "01/11/2026");
assert.equal(Object.hasOwn(parsed.rows[0], "Margin"), false);
assert.equal(Object.hasOwn(parsed.rows[0], "Internal notes"), false);

const missing = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(missing, XLSX.utils.aoa_to_sheet([["Title"], ["Customer", "Status"]]), "DOC");
assert.throws(() => parseDocWorkbook(XLSX, missing), /missing Delivery Date/);

const wrong = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wrong, XLSX.utils.aoa_to_sheet([["x"]]), "Summary");
assert.throws(() => parseDocWorkbook(XLSX, wrong), /No sheet named DOC/);

console.log("orders feed checks passed");
