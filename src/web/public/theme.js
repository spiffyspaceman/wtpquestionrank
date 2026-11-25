// Day or night, chosen by the reader and kept in this browser only. Runs before the page paints, so the page never
// flashes the other scheme. With no choice stored, the page follows the device's own setting (see styles.css).
(function () {
  try {
    var t = localStorage.getItem("wtpqr-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage unavailable: follow the device */
  }
})();
