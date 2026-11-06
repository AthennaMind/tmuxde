// Apply cached theme before first paint. Keep in sync with ThemeProvider.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("theme");
    if (theme === "system") {
      theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch (e) {}
  if (theme !== "light") theme = "dark";
  var root = document.documentElement;
  root.classList.add(theme);
  root.style.colorScheme = theme;
})();
