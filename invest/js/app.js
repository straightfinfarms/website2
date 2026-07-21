/* =============================================================================
 * app.js — bootstrap: tab navigation, toast + modal UI helpers
 * window.BRRRR.app / window.BRRRR.ui
 * ========================================================================== */
(function () {
  "use strict";

  function switchView(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === name);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    if (name === "finder") {
      // Map needs a visible container before it sizes correctly.
      BRRRR.finder.ensureMap();
      setTimeout(function () { BRRRR.finder.refresh(); }, 30);
    }
    if (name === "portfolio") BRRRR.portfolio.refresh();
    location.hash = name;
  }

  /* ---- Toast ---- */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ---- Modal ---- */
  function modal(html, onReady) {
    var bg = document.getElementById("modal-bg");
    var m = document.getElementById("modal");
    m.innerHTML = html;
    bg.classList.add("show");
    if (onReady) onReady(m);
  }
  function closeModal() { document.getElementById("modal-bg").classList.remove("show"); }

  function init() {
    document.getElementById("tabs").addEventListener("click", function (e) {
      var b = e.target.closest(".tab");
      if (b) switchView(b.getAttribute("data-view"));
    });
    document.getElementById("modal-bg").addEventListener("click", function (e) {
      if (e.target.id === "modal-bg") closeModal();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

    BRRRR.analyze.init();
    BRRRR.finder.init();
    BRRRR.portfolio.init();

    var start = (location.hash || "").replace("#", "");
    if (["analyze", "finder", "portfolio"].indexOf(start) >= 0) switchView(start);
  }

  window.BRRRR = window.BRRRR || {};
  window.BRRRR.app = { switchView: switchView };
  window.BRRRR.ui = { toast: toast, modal: modal, closeModal: closeModal };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
