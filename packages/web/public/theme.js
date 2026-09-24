// Before the first paint, so a dark page never flashes light. A classic script because a module runs too late,
// and a file because the CSP refuses an inline one. theme.ts owns every later change; webcheck holds the two to one key.
(function () {
  var chosen = null;
  try {
    chosen = window.localStorage.getItem("reemoat.theme");
  } catch (e) {
    // Storage refused: light, as before any choice.
  }
  var theme = chosen === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute("content", theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#11100e" : "#f9f8f6");
})();
