// landing.js - landing page interactions (vanilla JS only)
(function () {
  const nav = document.querySelector(".nav");
  const burger = document.getElementById("nav-burger");

  // Mobile menu toggle
  if (burger) {
    burger.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      burger.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll(".nav-link").forEach((link) =>
      link.addEventListener("click", () => nav.classList.remove("open"))
    );
  }

  // Stronger shadow once the page is scrolled
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Fade-up on scroll
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
})();
