// Zephric public website. No dependencies; served under the site's strict CSP (script-src 'self').
"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const currency = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

/* ── Header: shadow once scrolled, and the mobile menu ─────────────── */
const header = $(".site-header");
const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
onScroll();
addEventListener("scroll", onScroll, { passive: true });

const menuToggle = $(".menu-toggle");
const nav = $("#navigation");
function setMenu(open) {
  nav.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  menuToggle.querySelector("use").setAttribute("href", open ? "#i-close" : "#i-menu");
}
menuToggle.addEventListener("click", () => setMenu(menuToggle.getAttribute("aria-expanded") !== "true"));
nav.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav.classList.contains("is-open")) {
    setMenu(false);
    menuToggle.focus();
  }
});

/* ── Hero: one pay application through four stages ──────────────── */
const sheet = $("#sheet");
const steps = $$(".step", sheet);
const toggle = $("#sheet-toggle");
const statusText = $("#sheet-status");
const STEP_MS = 3600;
const STATUS = [
  "Pay application, contract and change order received.",
  "Each figure read and linked to the line it came from.",
  "Checked against the contract, change orders and the last payment.",
  "One exception, sent to your team with its evidence.",
];
let stage = 3;
let timer = null;
let paused = false;
let visible = true;

function show(next) {
  stage = next;
  sheet.dataset.stage = String(next);
  steps.forEach((step, i) => step.setAttribute("aria-pressed", String(i === next)));
  statusText.textContent = STATUS[next];
  // Restart the progress bar animation on the active step.
  const bar = $(".step-bar i", steps[next]);
  bar.style.animation = "none";
  void bar.offsetWidth;
  bar.style.animation = "";
}
function schedule() {
  clearTimeout(timer);
  const playing = !paused && visible && !document.hidden && !reduceMotion.matches;
  sheet.classList.toggle("is-playing", playing);
  if (playing) timer = setTimeout(() => {
    show((stage + 1) % 4);
    schedule();
  }, STEP_MS);
}
function setPaused(value) {
  paused = value;
  sheet.classList.toggle("is-paused", paused);
  toggle.setAttribute("aria-label", paused ? "Play the animation" : "Pause the animation");
  schedule();
}

sheet.style.setProperty("--step-ms", `${STEP_MS}ms`);
if (reduceMotion.matches) {
  show(3);
} else {
  toggle.hidden = false;
  show(0);
}
steps.forEach((step, i) =>
  step.addEventListener("click", () => {
    show(i);
    if (!reduceMotion.matches) setPaused(true);
  }),
);
toggle.addEventListener("click", () => {
  if (paused) show((stage + 1) % 4);
  setPaused(!paused);
});
reduceMotion.addEventListener("change", () => {
  toggle.hidden = reduceMotion.matches;
  if (reduceMotion.matches) show(3);
  schedule();
});
document.addEventListener("visibilitychange", schedule);
new IntersectionObserver(
  ([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  },
  { threshold: 0.25 },
).observe(sheet);

/* ── Try the review: correct the retainage, keep the original ────── */
const COMPLETED = 350000;
const PREVIOUS = 250000;
const EXPECTED_RETAINAGE = 35000;
const input = $("#retainage-input");
const feedback = $("#review-feedback");
let corrected = EXPECTED_RETAINAGE;

$("#confirm-review").addEventListener("click", () => {
  if (!input.value || !input.checkValidity()) {
    input.reportValidity();
    return;
  }
  const amount = Number(input.value);
  if (Math.abs(amount - EXPECTED_RETAINAGE) > 0.005) {
    feedback.textContent =
      amount === 30000
        ? "That is the figure that was submitted. The contract asks for 10% of $350,000 completed and stored."
        : `This example expects ${currency(EXPECTED_RETAINAGE)} (10% of ${currency(COMPLETED)}). Check the contract evidence before confirming.`;
    feedback.classList.add("is-error");
    input.focus();
    return;
  }
  corrected = amount;
  $("#record-retainage").textContent = currency(corrected);
  $("#record-due").textContent = currency(COMPLETED - corrected - PREVIOUS);
  $("#decision-form").hidden = true;
  $("#decision-done").hidden = false;
  $("#decision-done h3").setAttribute("tabindex", "-1");
  $("#decision-done h3").focus({ preventScroll: true });
});
input.addEventListener("input", () => {
  feedback.classList.remove("is-error");
  feedback.textContent = "Illustrative action. No real financial record is changed.";
});
$("#reset-review").addEventListener("click", () => {
  input.value = "30000";
  feedback.classList.remove("is-error");
  feedback.textContent = "Illustrative action. No real financial record is changed.";
  $("#decision-done").hidden = true;
  $("#decision-form").hidden = false;
  input.focus();
});
$("#download-record").addEventListener("click", () => {
  const csv =
    "project,contractor,application,completed_work,retainage_submitted,retainage_reviewed,previous_certified,payment_due,status,reviewer,data_type\r\n" +
    `Riverside Residences,Apex Concrete Inc.,007,${COMPLETED},30000,${corrected},${PREVIOUS},${COMPLETED - corrected - PREVIOUS},Reviewed,Jamie L. (example),Illustrative demo\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "zephric-example-reviewed-record.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ── Dialogs ──────────────────────────────────────────────────────── */
document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-dialog]");
  if (opener) document.getElementById(opener.dataset.dialog).showModal();
  const close = event.target.closest(".dialog-close");
  if (close) close.closest("dialog").close();
});
for (const dialog of $$("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    if (outside) dialog.close();
  });
}

/* ── Scroll reveal: never hides what is already on screen ────────── */
if (!reduceMotion.matches && "IntersectionObserver" in window) {
  const revealer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("is-waiting");
        entry.target.classList.add("is-shown");
        revealer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of $$(".reveal")) {
    if (el.getBoundingClientRect().top > innerHeight) {
      el.classList.add("is-waiting");
      revealer.observe(el);
    }
  }
}

/* ── The design partner form ─────────────────────────────────────── */
$("#year").textContent = String(new Date().getFullYear());

const form = $("#partner-form");
const formStatus = $("#form-status");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const submit = $("[type=submit]", form);
  const label = submit.innerHTML;
  submit.disabled = true;
  submit.textContent = "Sending your inquiry…";
  formStatus.textContent = "";
  formStatus.className = "form-status";
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.consent = form.elements.consent.checked;
    const response = await fetch("/api/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Your inquiry could not be saved. Please try again.");
    formStatus.textContent = `Your inquiry has been received. Thank you for helping shape Zephric. Reference: ${result.reference}.`;
    form.reset();
  } catch (error) {
    formStatus.textContent =
      error.name === "TimeoutError"
        ? "The connection timed out. Your inquiry may have arrived. Please retry if you did not receive a reference."
        : error.message === "Failed to fetch"
          ? "We could not connect. Check your connection and try again."
          : error.message;
    formStatus.classList.add("error");
  } finally {
    submit.disabled = false;
    submit.innerHTML = label;
  }
});
