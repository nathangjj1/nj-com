(function () {
  "use strict";

  var REPO = "nathangjj1/nj-com";
  var FILE_PATH = "orders/feed.json";
  var PREVIEW_LIMIT = 20;

  var fileInput = document.getElementById("file");
  var drop = document.getElementById("drop");
  var statusNode = document.getElementById("status");
  var ready = document.getElementById("ready");
  var summary = document.getElementById("summary");
  var omittedNode = document.getElementById("omitted");
  var tokenInput = document.getElementById("token");
  var publishButton = document.getElementById("publish");
  var previewWrap = document.getElementById("preview-wrap");
  var preview = document.getElementById("preview");

  var parsed = null;
  var publishing = false;

  function setStatus(message, kind) {
    statusNode.textContent = message || "";
    statusNode.className = kind || "";
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("That file could not be read.")); };
      reader.readAsArrayBuffer(file);
    });
  }

  function renderPreview(result) {
    preview.replaceChildren();
    var caption = document.createElement("caption");
    var shown = Math.min(result.rows.length, PREVIEW_LIMIT);
    caption.textContent = result.rows.length > PREVIEW_LIMIT
      ? "First " + shown + " of " + result.rows.length + " orders"
      : result.rows.length + (result.rows.length === 1 ? " order" : " orders");
    preview.appendChild(caption);

    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    result.columns.forEach(function (column) {
      var cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    preview.appendChild(head);

    var body = document.createElement("tbody");
    result.rows.slice(0, PREVIEW_LIMIT).forEach(function (row) {
      var tr = document.createElement("tr");
      result.columns.forEach(function (column) {
        var cell = document.createElement("td");
        cell.textContent = row[column] || "";
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    preview.appendChild(body);
    previewWrap.hidden = false;
  }

  function refreshPublishButton() {
    var count = parsed ? parsed.rows.length : 0;
    var label = count === 1 ? "Publish 1 order" : "Publish " + count + " orders";
    if (count === 0) label = "Publish an empty feed";
    publishButton.textContent = publishing ? "Publishing…" : label;
    publishButton.disabled = publishing || !parsed || tokenInput.value.trim() === "";
  }

  function showResult(result, fileName) {
    parsed = result;
    var count = result.rows.length;
    summary.textContent = fileName + " · " + (count === 1 ? "1 order" : count + " orders") + " ready to publish.";
    if (count === 0) {
      omittedNode.textContent = "Nothing below the headings matched. Publishing will replace the live feed with an empty list.";
    } else if (result.omitted.length) {
      omittedNode.textContent = "Left out: " + result.omitted.join(", ") + ".";
    } else {
      omittedNode.textContent = "Every column on row 2 is in the feed.";
    }
    ready.hidden = false;
    renderPreview(result);
    refreshPublishButton();
    setStatus("");
  }

  async function onFile(file) {
    if (!file) return;
    parsed = null;
    ready.hidden = true;
    previewWrap.hidden = true;
    setStatus("Reading " + file.name + "…");
    try {
      var buffer = await readFile(file);
      var result = OrderFeed.parseDocArrayBuffer(buffer);
      showResult(result, file.name);
    } catch (error) {
      setStatus(error.message || "That spreadsheet could not be read.", "error");
    }
  }

  function bytesToBase64(bytes) {
    var binary = "";
    var size = 0x4000;
    for (var i = 0; i < bytes.length; i += size) {
      var chunk = bytes.subarray(i, i + size);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function decodeBase64(content) {
    var binary = atob(content.replace(/\s/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function githubError(response) {
    var detail = "";
    try {
      var body = await response.json();
      detail = body.message || "";
    } catch (error) {
      detail = "";
    }
    if (response.status === 401) return "GitHub rejected that token.";
    if (response.status === 404) return "That token cannot see " + REPO + ". Contents access has to include this repository.";
    if (response.status === 409) return "The feed changed while this page was open. Publish again.";
    if (response.status === 403) return detail || "GitHub refused the update. The token needs Contents read and write on " + REPO + ".";
    return detail || "GitHub returned " + response.status + ".";
  }

  async function publish() {
    if (!parsed || publishing) return;
    var token = tokenInput.value.trim();
    if (!token) return;

    publishing = true;
    refreshPublishButton();
    setStatus("Publishing…");

    var headers = {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    var url = "https://api.github.com/repos/" + REPO + "/contents/" + FILE_PATH;

    try {
      var feed = OrderFeed.buildFeed(parsed.rows);
      var existingSha = "";
      var current = await fetch(url, { headers: headers });
      if (current.ok) {
        var payload = await current.json();
        existingSha = payload.sha || "";
        if (payload.content) {
          try {
            var live = JSON.parse(decodeBase64(payload.content));
            var sameColumns = JSON.stringify(live.columns || []) === JSON.stringify(feed.columns);
            var sameRows = JSON.stringify(live.rows || []) === JSON.stringify(feed.rows);
            if (sameColumns && sameRows) {
              setStatus("The live feed already matches this spreadsheet.", "ok");
              return;
            }
          } catch (error) {
            existingSha = payload.sha || "";
          }
        }
      } else if (current.status !== 404) {
        throw new Error(await githubError(current));
      }

      var body = {
        message: "Update DOC orders.",
        content: bytesToBase64(new TextEncoder().encode(JSON.stringify(feed, null, 2) + "\n")),
        branch: "main",
      };
      if (existingSha) body.sha = existingSha;

      var saved = await fetch(url, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify(body),
      });
      if (!saved.ok) throw new Error(await githubError(saved));

      setStatus("Published. The orders page may take a minute to show the new feed.", "ok");
    } catch (error) {
      setStatus(error.message || "The feed was not published.", "error");
    } finally {
      publishing = false;
      refreshPublishButton();
    }
  }

  fileInput.addEventListener("change", function () {
    onFile(fileInput.files && fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach(function (eventName) {
    drop.addEventListener(eventName, function (event) {
      event.preventDefault();
      drop.classList.add("is-over");
    });
  });

  ["dragleave", "drop"].forEach(function (eventName) {
    drop.addEventListener(eventName, function (event) {
      event.preventDefault();
      drop.classList.remove("is-over");
    });
  });

  drop.addEventListener("drop", function (event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    onFile(files && files[0]);
  });

  tokenInput.addEventListener("input", refreshPublishButton);
  publishButton.addEventListener("click", publish);
})();
