(() => {
  const themeColors = {
    sunset: "#fff1e6",
    ocean: "#071b2c",
    aurora: "#eaf5f2",
    forest: "#edf4e9",
    lavender: "#1d1830",
    midnight: "#111827",
  };

  function syncLegalTheme() {
    let theme = "sunset";
    try {
      const saved = JSON.parse(localStorage.getItem("questify_state") || "{}");
      const savedTheme = saved.preferences && saved.preferences.theme;
      const normalizedTheme = savedTheme === "dark" ? "midnight" : savedTheme === "light" ? "aurora" : savedTheme;
      if (Object.prototype.hasOwnProperty.call(themeColors, normalizedTheme)) theme = normalizedTheme;
    } catch (error) {
      console.error("Could not load the saved Questify theme for this document:", error);
    }

    document.documentElement.dataset.theme = theme;
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.content = themeColors[theme];
  }

  syncLegalTheme();
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "questify_state") syncLegalTheme();
  });
})();
