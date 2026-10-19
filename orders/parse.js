(function (root) {
  "use strict";

  var SHEET_NAME = "DOC";
  var HEADER_ROW = 1;
  var COLUMNS = [
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

  function normalizeHeader(value) {
    return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function formatCell(XLSX, cell) {
    if (!cell || cell.v == null || cell.v === "") return "";
    if (cell.t === "e") return "";
    var shown = XLSX.utils.format_cell(cell);
    if (shown == null) return "";
    return String(shown).replace(/[\r\n]+/g, " ").trim();
  }

  function sheetRange(XLSX, sheet) {
    var range = null;
    Object.keys(sheet).forEach(function (address) {
      if (address.charAt(0) === "!") return;
      var cell = XLSX.utils.decode_cell(address);
      if (!range) {
        range = { s: { r: cell.r, c: cell.c }, e: { r: cell.r, c: cell.c } };
        return;
      }
      if (cell.r < range.s.r) range.s.r = cell.r;
      if (cell.c < range.s.c) range.s.c = cell.c;
      if (cell.r > range.e.r) range.e.r = cell.r;
      if (cell.c > range.e.c) range.e.c = cell.c;
    });
    return range;
  }

  function cellAt(XLSX, sheet, row, column) {
    return sheet[XLSX.utils.encode_cell({ r: row, c: column })];
  }

  function parseDocWorkbook(XLSX, workbook) {
    var sheetName = workbook.SheetNames.find(function (name) {
      return String(name).trim().toLowerCase() === SHEET_NAME.toLowerCase();
    });
    if (!sheetName) {
      var found = workbook.SheetNames.length ? workbook.SheetNames.join(", ") : "no sheets";
      throw new Error("No sheet named DOC. This file has: " + found + ".");
    }

    var sheet = workbook.Sheets[sheetName];
    var range = sheetRange(XLSX, sheet);
    if (!range) throw new Error("The DOC sheet is empty.");
    var headerText = [];
    var columnIndex = new Map();

    for (var c = range.s.c; c <= range.e.c; c += 1) {
      var text = formatCell(XLSX, cellAt(XLSX, sheet, HEADER_ROW, c));
      if (!text) continue;
      headerText.push(text);
      var key = normalizeHeader(text);
      if (!columnIndex.has(key)) columnIndex.set(key, c);
    }

    var missing = COLUMNS.filter(function (column) {
      return !columnIndex.has(normalizeHeader(column));
    });
    if (missing.length) {
      var detail = headerText.length
        ? " Row 2 has: " + headerText.join(", ") + "."
        : " Row 2 has no headings.";
      throw new Error("Row 2 of DOC is missing " + missing.join(", ") + "." + detail);
    }

    var kept = new Set(COLUMNS.map(normalizeHeader));
    var omitted = headerText.filter(function (text) {
      return !kept.has(normalizeHeader(text));
    });

    var rows = [];
    var skippedNoOrder = 0;
    var skippedNoModel = 0;
    for (var r = HEADER_ROW + 1; r <= range.e.r; r += 1) {
      var row = {};
      for (var i = 0; i < COLUMNS.length; i += 1) {
        var column = COLUMNS[i];
        row[column] = formatCell(XLSX, cellAt(XLSX, sheet, r, columnIndex.get(normalizeHeader(column))));
      }
      if (!row["AG Order Number"]) {
        skippedNoOrder += 1;
        continue;
      }
      if (!row["Mdl Code"] && !row["Mdl Description"]) {
        skippedNoModel += 1;
        continue;
      }
      rows.push(row);
    }

    return {
      columns: COLUMNS.slice(),
      rows: rows,
      omitted: omitted,
      examined: range.e.r - HEADER_ROW,
      lastRow: range.e.r + 1,
      skippedNoOrder: skippedNoOrder,
      skippedNoModel: skippedNoModel,
    };
  }

  function parseDocArrayBuffer(buffer) {
    var XLSX = root.XLSX;
    if (!XLSX) throw new Error("The spreadsheet reader did not load.");
    var workbook = XLSX.read(buffer, { type: "array", nodim: true });
    return parseDocWorkbook(XLSX, workbook);
  }

  function buildFeed(rows) {
    return {
      sheet: SHEET_NAME,
      updated: new Date().toISOString(),
      columns: COLUMNS.slice(),
      rows: rows,
    };
  }

  root.OrderFeed = {
    COLUMNS: COLUMNS,
    parseDocWorkbook: parseDocWorkbook,
    parseDocArrayBuffer: parseDocArrayBuffer,
    buildFeed: buildFeed,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
