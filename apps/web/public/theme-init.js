(function () {
  var theme = "light";
  try {
    if (localStorage.getItem("ov.theme.v1") === "dark") theme = "dark";
  } catch (_) {
    // Storage may be unavailable in restricted browser contexts.
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#080c14" : "#ffffff");
})();
