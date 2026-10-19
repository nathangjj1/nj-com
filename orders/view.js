(function () {
  "use strict";

  var meta = document.getElementById("meta");
  var search = document.getElementById("search");
  var toolbar = document.getElementById("toolbar");
  var empty = document.getElementById("empty");
  var tableWrap = document.getElementById("table-wrap");
  var table = document.getElementById("orders");
  var feed = null;

  function formatUpdated(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function rowText(row, columns) {
    return columns.map(function (column) { return row[column] || ""; }).join(" ").toLowerCase();
  }

  function render(nextFeed) {
    feed = nextFeed;
    var columns = Array.isArray(feed.columns) ? feed.columns : [];
    var rows = Array.isArray(feed.rows) ? feed.rows : [];
    var query = search.value.trim().toLowerCase();
    var visible = query
      ? rows.filter(function (row) { return rowText(row, columns).indexOf(query) !== -1; })
      : rows;

    var updated = formatUpdated(feed.updated);
    if (!rows.length) {
      meta.textContent = updated ? "Updated " + updated + "." : "The feed is empty.";
    } else if (query) {
      meta.textContent = visible.length + " of " + rows.length + (rows.length === 1 ? " order" : " orders")
        + (updated ? " · Updated " + updated : "");
    } else {
      meta.textContent = rows.length + (rows.length === 1 ? " order" : " orders")
        + (updated ? " · Updated " + updated : "");
    }

    toolbar.hidden = rows.length === 0;
    empty.hidden = visible.length !== 0;
    empty.textContent = rows.length === 0
      ? "No orders in the feed yet."
      : "Nothing matches that search.";
    tableWrap.hidden = visible.length === 0;
    if (!visible.length) return;

    table.replaceChildren();
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    columns.forEach(function (column) {
      var cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    visible.forEach(function (row) {
      var tr = document.createElement("tr");
      columns.forEach(function (column) {
        var cell = document.createElement("td");
        cell.textContent = row[column] || "";
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  search.addEventListener("input", function () {
    if (feed) render(feed);
  });

  fetch("feed.json", { cache: "no-cache" })
    .then(function (response) {
      if (!response.ok) throw new Error("The orders feed did not load.");
      return response.json();
    })
    .then(render)
    .catch(function (error) {
      meta.textContent = error.message || "The orders feed did not load.";
      toolbar.hidden = true;
      empty.hidden = false;
      empty.textContent = "The orders feed did not load.";
    });
})();
