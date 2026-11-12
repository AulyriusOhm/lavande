(function () {
  "use strict";

  var STORE_KEY = "lavande.site.theme";
  var root = document.documentElement;

  var theme = null;
  try {
    theme = localStorage.getItem(STORE_KEY);
  } catch (error) {
    theme = null;
  }

  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  root.setAttribute("data-theme", theme);

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#fbfaff" : "#0e0c13");
})();
