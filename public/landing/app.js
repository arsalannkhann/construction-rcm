const $ = (selector) => document.querySelector(selector);
const tabs = [...document.querySelectorAll("[data-stage]")];
const initialChecks = $("#checks").innerHTML;
let stage = 1;
let reviewed = false;
let correctedRetainage = 35000;
let view = "billing";
const currency = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount,
  );
function setView(next) {
  view = next;
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.view === next),
    );
  $("#demo-panel").hidden = next !== "billing";
  $(".demo-tabs").hidden = next !== "billing";
  $("#overview-panel").hidden = next !== "overview";
  $("#documents-panel").hidden = next !== "documents";
  $("#workspace-title").textContent =
    next === "overview"
      ? "Your project, at a glance."
      : next === "documents"
        ? "The details behind every decision."
        : "A clear path to payment-ready.";
}
function renderStage(next, focusTab = false) {
  stage = next;
  setView("billing");
  tabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === stage));
    tab.tabIndex = i === stage ? 0 : -1;
  });
  $("#demo-panel").setAttribute("aria-labelledby", tabs[stage].id);
  if (focusTab) tabs[stage].focus({ preventScroll: true });
  $("#findings-title").textContent = [
    "Document capture",
    "Reconciliation",
    "Human review",
    "Move forward",
  ][stage];
  $(".extracted-line").hidden = stage === 0 || stage === 3;
  $("#review-status").textContent = [
    "Source documents, connected.",
    "Your team makes the final call.",
    "Review the evidence. Make the call.",
    "A clear handoff to your next step.",
  ][stage];
  $("#checks").className = stage === 1 ? "checks" : "stage-content";
  if (stage === 0) {
    $("#checks").innerHTML =
      `<div class="capture-state"><span class="spark">✧</span><h3>Three documents. One connected record.</h3><p>AI-assisted extraction brings the financial details into focus while preserving the original files.</p></div><div class="capture-files"><span>Pay_App_007.pdf</span><span>✓ Captured</span></div><div class="capture-files"><span>Contract_Apex.pdf</span><span>✓ Linked</span></div><div class="capture-files"><span>Change_Order_003.pdf</span><span>✓ Linked</span></div><button class="stage-button" data-next="1">Compare the financial details <span>→</span></button>`;
  } else if (stage === 1) {
    $("#checks").innerHTML = initialChecks;
    if (reviewed) {
      $(".finding").innerHTML =
        `<div class="finding-title"><span>✓</span> Retainage reviewed by your team</div><p>The reviewer entered ${currency(correctedRetainage)}. This demo preserves the source document and records the correction separately.</p><button data-next="3">Continue to handoff <span>↗</span></button>`;
      $(".extracted-line strong").innerHTML =
        `${currency(100000 - correctedRetainage)}`;
      $(".extracted-line > span").textContent = "Reviewed payment due";
    } else {
      $(".extracted-line strong").innerHTML = "$70,000<span>.00</span>";
      $(".extracted-line > span").textContent = "Current payment requested";
    }
  } else if (stage === 2) {
    $(".extracted-line > span").textContent = "Current payment requested";
    $(".extracted-line strong").innerHTML = "$70,000<span>.00</span>";
    $("#checks").innerHTML =
      `<h3>Retainage: inspect the evidence.</h3><p>Contract §5.2 specifies 10% retainage. Work completed is $350,000. The expected amount is $35,000.</p><label class="review-field">Reviewer’s corrected retainage (USD)<input id="retainage-input" type="number" value="${correctedRetainage}" min="0" max="100000" step="0.01" inputmode="decimal" aria-describedby="correction-note"></label><p id="correction-note">The source submitted $30,000. Your correction is kept separately from the original.</p><button class="stage-button" id="approve-demo">Confirm correction in demo <span>✓</span></button><p class="review-notice" id="review-feedback" role="status">Illustrative action. No real financial record is changed.</p>`;
  } else {
    $("#checks").innerHTML = reviewed
      ? `<div class="ready-state"><div class="ready-icon">✓</div><h3>Reviewed. Ready for the next step.</h3><p>Your correction is captured with the source evidence.</p><div class="export-summary"><div>RETAINAGE<strong>${currency(correctedRetainage)}</strong></div><div>PAYMENT DUE<strong>${currency(100000 - correctedRetainage)}</strong></div><div>REVIEWER<strong>Jamie Lee · Demo</strong></div><div>RECORD STATUS<strong>Reviewed</strong></div></div><button class="stage-button" id="export-demo">Download example record <span>↓</span></button><button class="text-link" id="reset-demo" style="margin-top:15px;font-size:9px">Reset the demo ↺</button><p class="review-notice">CSV export of illustrative data. No accounting system is connected.</p></div>`
      : `<div class="ready-state"><div class="ready-icon">↗</div><h3>Human review comes first.</h3><p>One finding still needs attention. Review the retainage discrepancy before preparing the record for handoff.</p><button class="stage-button" data-next="2">Review the open finding <span>→</span></button><p class="review-notice">Your team stays in control of approval.</p></div>`;
  }
}
document.addEventListener("click", (event) => {
  const stageButton = event.target.closest("[data-stage]");
  if (stageButton) renderStage(Number(stageButton.dataset.stage));
  const nextButton = event.target.closest("[data-next]");
  if (nextButton) renderStage(Number(nextButton.dataset.next), true);
  const tourButton = event.target.closest("[data-tour]");
  if (tourButton) {
    renderStage(Number(tourButton.dataset.tour), true);
    $("#platform").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
  if (event.target.closest("#review-finding")) renderStage(2, true);
  if (event.target.closest("#approve-demo")) {
    const input = $("#retainage-input");
    if (!input.value || !input.checkValidity()) {
      input.reportValidity();
      return;
    }
    const amount = Number(input.value);
    if (Math.abs(amount - 35000) > 0.005) {
      $("#review-feedback").textContent =
        "This example expects $35,000 (10% of $350,000). Check the contract evidence before confirming.";
      $("#review-feedback").classList.add("demo-error");
      input.focus();
      return;
    }
    correctedRetainage = amount;
    reviewed = true;
    renderStage(3, true);
  }
  if (event.target.closest("#reset-demo")) {
    reviewed = false;
    correctedRetainage = 35000;
    renderStage(1, true);
  }
  if (event.target.closest("#export-demo")) {
    const csv = `project,contractor,application,completed_work,retainage,payment_due,status,reviewer,data_type\r\n${$("#project-name").textContent},Apex Concrete Inc.,007,350000,${correctedRetainage},${100000 - correctedRetainage},Reviewed,Jamie Lee,Illustrative demo\r\n`;
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "zephric-example-reviewed-record.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) setView(viewButton.dataset.view);
  const project = event.target.closest("[data-project]");
  if (project) {
    $("#project-name").textContent = project.dataset.project;
    $(".paper-project").textContent = project.dataset.project;
    document
      .querySelectorAll("[data-project]")
      .forEach((button) =>
        button.classList.toggle("selected", button === project),
      );
  }
  const dialogButton = event.target.closest("[data-dialog]");
  if (dialogButton)
    document.getElementById(dialogButton.dataset.dialog).showModal();
  const closeButton = event.target.closest(".dialog-close");
  if (closeButton) closeButton.closest("dialog").close();
});
tabs.forEach((tab, index) =>
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      renderStage(next, true);
    }
  }),
);
$(".menu-toggle").addEventListener("click", () => {
  const expanded = $(".menu-toggle").getAttribute("aria-expanded") !== "true";
  $(".menu-toggle").setAttribute("aria-expanded", String(expanded));
  $(".menu-toggle").setAttribute(
    "aria-label",
    expanded ? "Close navigation" : "Open navigation",
  );
  $("#navigation").classList.toggle("is-open", expanded);
});
$("#navigation").addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    $("#navigation").classList.remove("is-open");
    $(".menu-toggle").setAttribute("aria-expanded", "false");
    $(".menu-toggle").setAttribute("aria-label", "Open navigation");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#navigation").classList.remove("is-open");
    $(".menu-toggle").setAttribute("aria-expanded", "false");
    $(".menu-toggle").setAttribute("aria-label", "Open navigation");
  }
});
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  });
$("#year").textContent = new Date().getFullYear();
$("#partner-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = form.querySelector("[type=submit]");
  const status = $("#form-status");
  submit.disabled = true;
  submit.textContent = "Sending your inquiry…";
  status.textContent = "";
  status.className = "";
  try {
    const payload = Object.fromEntries(new FormData(form));
    payload.consent = form.elements.consent.checked;
    const response = await fetch("/api/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error || "Your inquiry could not be saved. Please try again.",
      );
    status.textContent = `Your inquiry has been received. Thank you for helping shape Zephric. Reference: ${result.reference}.`;
    form.reset();
  } catch (error) {
    status.textContent =
      error.name === "TimeoutError"
        ? "The connection timed out. Your inquiry may have arrived. Please retry if you did not receive a reference."
        : error.message === "Failed to fetch"
          ? "We could not connect. Check your connection and try again."
          : error.message;
    status.className = "error";
  } finally {
    submit.disabled = false;
    submit.innerHTML = "Start a conversation <span>↗</span>";
  }
});
