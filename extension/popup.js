const packageInput = document.querySelector("#package");
const status = document.querySelector("#status");
const fillButton = document.querySelector("#fill");
const submitButton = document.querySelector("#submit");
let activePayload = null;
let activeTabId = null;

fillButton.addEventListener("click", async () => {
  status.textContent = "";
  activePayload = null;
  activeTabId = null;
  submitButton.hidden = true;
  let payload;
  try {
    payload = JSON.parse(packageInput.value);
  } catch {
    status.textContent = "The package is not valid JSON.";
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active form page found.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["adapters.js", "content.js"],
    });
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "BERLIN_LOST_FOUND_FILL",
      payload,
    });
    status.textContent = result?.ok
      ? `Filled ${result.filled} field(s). ${result.missing} need manual attention. Nothing was submitted.`
      : result?.error || "The form could not be filled.";
    activePayload = result?.ok ? payload : null;
    activeTabId = result?.ok ? tab.id : null;
    submitButton.hidden = !result?.canSubmit;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

submitButton.addEventListener("click", async () => {
  if (!activePayload || !activeTabId) return;
  submitButton.disabled = true;
  status.textContent = "Waiting for the official website…";
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: "BERLIN_LOST_FOUND_SUBMIT",
      payload: activePayload,
    });
    status.textContent = result?.ok
      ? result.receipt
        ? `Submitted. Receipt: ${result.receipt}`
        : "The website showed its success state. Save its case number in the app."
      : result?.attempted
        ? `Submission result is uncertain. Do not retry until you check the website. ${
            result?.error || ""
          }`
        : result?.error || "The reviewed submission checks did not pass.";
  } catch (error) {
    status.textContent =
      "Submission result is uncertain. Check the website before trying again. " +
      (error instanceof Error ? error.message : String(error));
  } finally {
    submitButton.disabled = false;
    submitButton.hidden = true;
    activePayload = null;
    activeTabId = null;
  }
});
