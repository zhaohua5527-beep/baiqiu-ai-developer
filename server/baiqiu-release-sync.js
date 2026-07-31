(function () {
  "use strict";

  var CONFIG_URLS = ["/manifest.json", "/update.json"];
  var APPLY_WINDOW_MS = 15000;
  var APPLY_INTERVAL_MS = 350;

  function sameOriginUrl(value) {
    try {
      var url = new URL(value, window.location.origin);
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function findVersion(payload) {
    return String(
      payload.version ||
      payload.latestVersion ||
      payload.appVersion ||
      ""
    ).trim();
  }

  function findDownloadUrl(payload, version) {
    var installer = String(payload.installerUrl || payload.installerFile || "").trim();
    if (installer) return sameOriginUrl(installer);
    var value = String(payload.downloadUrl || payload.packageUrl || "").trim();
    if (value) return sameOriginUrl(value);
    return version ? sameOriginUrl("/baiqiu-" + encodeURIComponent(version) + ".zip") : "";
  }

  function replaceTextVersion(version) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return /3\.0\.2|3\.02|3\.0\.3/.test(node.nodeValue || "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      node.nodeValue = String(node.nodeValue || "")
        .replace(/3\.0\.2/g, version)
        .replace(/3\.02/g, version)
        .replace(/3\.0\.3/g, version);
    });
  }

  function updateCurrentVersionRow(version) {
    Array.prototype.forEach.call(document.querySelectorAll("dt"), function (dt) {
      if ((dt.textContent || "").trim() !== "\u5f53\u524d\u7248\u672c") return;
      var dd = dt.nextElementSibling;
      if (dd) dd.textContent = version;
    });
  }

  function updateDownloadLinks(downloadUrl) {
    if (!downloadUrl) return;
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function (link) {
      var href = link.getAttribute("href") || "";
      var text = link.textContent || "";
      var pointsToPackage = /baiqiu-[^/?#]+\.zip(?:[?#].*)?$/i.test(href) ||
        /\/download\/[^/?#]*setup\.exe(?:[?#].*)?$/i.test(href);
      var isDownloadCta = /download|\u4e0b\u8f7d/i.test(text);
      if (pointsToPackage || isDownloadCta) link.setAttribute("href", downloadUrl);
    });
  }

  function updateStructuredData(version) {
    Array.prototype.forEach.call(document.querySelectorAll('script[type="application/ld+json"]'), function (script) {
      try {
        var data = JSON.parse(script.textContent || "{}");
        if (data && data["@type"] === "SoftwareApplication") {
          data.softwareVersion = version;
          script.textContent = JSON.stringify(data);
        }
      } catch (_) {}
    });
  }

  function applyReleaseInfo(info) {
    var version = info.version;
    if (!version) return;
    document.documentElement.setAttribute("data-baiqiu-release-version", version);
    replaceTextVersion(version);
    updateCurrentVersionRow(version);
    updateDownloadLinks(info.downloadUrl);
    updateStructuredData(version);
  }

  function loadReleaseInfo() {
    var query = "?_bq_release_sync=" + Date.now();
    return CONFIG_URLS.reduce(function (promise, url) {
      return promise.catch(function () {
        return fetch(url + query, { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) throw new Error("release config unavailable");
            return response.json();
          })
          .then(function (payload) {
            var version = findVersion(payload);
            if (!version) throw new Error("release version missing");
            return {
              version: version,
              downloadUrl: findDownloadUrl(payload, version)
            };
          });
      });
    }, Promise.reject(new Error("start")));
  }

  loadReleaseInfo().then(function (info) {
    var startedAt = Date.now();
    applyReleaseInfo(info);
    var timer = window.setInterval(function () {
      applyReleaseInfo(info);
      if (Date.now() - startedAt > APPLY_WINDOW_MS) window.clearInterval(timer);
    }, APPLY_INTERVAL_MS);
  }).catch(function () {
    // Keep the statically rendered page usable if the release config is unavailable.
  });
})();
