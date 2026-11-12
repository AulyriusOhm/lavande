(function () {
  "use strict";

  var STORE_KEY = "lavande.site.theme";
  var root = document.documentElement;
  var toggle = document.getElementById("theme-toggle");
  var meta = document.querySelector('meta[name="theme-color"]');

  function stored() {
    try {
      var value = localStorage.getItem(STORE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    if (meta) meta.setAttribute("content", theme === "light" ? "#fbfaff" : "#0e0c13");
    if (toggle) {
      var target = theme === "dark" ? "clair" : "sombre";
      toggle.setAttribute("aria-label", "Passer en thème " + target);
      toggle.setAttribute("title", "Thème " + target);
      toggle.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  }

  apply(stored() || root.getAttribute("data-theme") || "dark");

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(STORE_KEY, next);
      } catch (error) {
        /* stockage indisponible : le thème reste valable pour la session */
      }
    });
  }

  var system = window.matchMedia("(prefers-color-scheme: light)");
  if (typeof system.addEventListener === "function") {
    system.addEventListener("change", function (event) {
      if (stored()) return;
      apply(event.matches ? "light" : "dark");
    });
  }

  var header = document.querySelector(".site-header");
  function syncHeader() {
    if (header) header.classList.toggle("is-stuck", window.scrollY > 8);
  }
  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });

  root.classList.add("reveal-ready");
  var revealed = document.querySelectorAll(".reveal");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(revealed, function (element) {
      element.classList.add("is-visible");
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
    );
    Array.prototype.forEach.call(revealed, function (element) {
      observer.observe(element);
    });
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
